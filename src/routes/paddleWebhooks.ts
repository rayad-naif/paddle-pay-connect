import { Router } from 'express';
import crypto from 'crypto';
import type { PaddleAccount, Payment } from '@prisma/client';
import { db } from '../db';
import { decrypt, safeEqual } from '../lib/crypto';
import { fromMinor } from '../lib/money';
import { sendProviderEvent } from '../ghl/client';

export const paddleWebhookRouter = Router();

const TOLERANCE_SECONDS = 300;

/** Verifies a Paddle-Signature header: ts=...;h1=... over `${ts}:${rawBody}`. */
export function verifyPaddleSignature(header: string | undefined, raw: Buffer, secret: string): boolean {
  if (!header) return false;
  let ts = '';
  const h1s: string[] = [];
  for (const part of header.split(';')) {
    const [k, v] = part.split('=');
    if (k === 'ts') ts = v;
    if (k === 'h1') h1s.push(v);
  }
  if (!ts || h1s.length === 0) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > TOLERANCE_SECONDS) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${ts}:`).update(raw).digest('hex');
  return h1s.some((h) => safeEqual(h, expected));
}

paddleWebhookRouter.post('/webhooks/paddle/:accountId', async (req, res) => {
  const account = await db.paddleAccount.findUnique({ where: { id: req.params.accountId } });
  if (!account) return res.status(404).json({ error: 'Unknown destination' });

  const raw: Buffer = (req as any).rawBody ?? Buffer.alloc(0);
  if (!verifyPaddleSignature(req.header('paddle-signature'), raw, decrypt(account.webhookSecretEnc))) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(raw.toString('utf8'));
  if (await db.webhookEvent.findUnique({ where: { id: event.event_id } })) return res.json({ duplicate: true });

  try {
    await handleEvent(account, event);
    await db.webhookEvent.create({ data: { id: event.event_id } });
    res.json({ received: true });
  } catch (e: any) {
    console.error(`Paddle webhook ${event.event_type} failed`, e);
    res.status(500).json({ error: e.message }); // Paddle will retry
  }
});

async function handleEvent(account: PaddleAccount, event: any) {
  const data = event.data;
  const apiKey = decrypt(account.ghlApiKeyEnc);
  const base = { locationId: account.locationId, apiKey };

  switch (event.event_type) {
    case 'transaction.completed': {
      if (data.origin === 'subscription_recurring' && data.subscription_id) {
        const first = await db.payment.findFirst({ where: { paddleSubscriptionId: data.subscription_id } });
        if (!first) return;
        await sendProviderEvent({
          ...base,
          event: 'subscription.charged',
          chargeId: data.id,
          ghlSubscriptionId: first.ghlSubscriptionId,
          chargeSnapshot: chargeSnapshot(data),
          subscriptionSnapshot: { id: data.subscription_id, status: 'active' },
        });
        return;
      }
      const payment = await findPayment(data.id, data.custom_data);
      if (!payment) return;
      await db.payment.update({
        where: { id: payment.id },
        data: { status: 'completed', paddleSubscriptionId: data.subscription_id ?? payment.paddleSubscriptionId },
      });
      await sendProviderEvent({
        ...base,
        event: 'payment.captured',
        chargeId: data.id,
        ghlTransactionId: payment.ghlTransactionId,
        chargeSnapshot: chargeSnapshot(data),
      });
      return;
    }

    case 'transaction.paid':
    case 'transaction.payment_failed': {
      const payment = await findPayment(data.id, data.custom_data);
      if (payment) await db.payment.update({ where: { id: payment.id }, data: { status: data.status } });
      return;
    }

    case 'subscription.created':
    case 'subscription.activated':
    case 'subscription.trialing':
    case 'subscription.updated':
    case 'subscription.past_due':
    case 'subscription.canceled': {
      const payment =
        (data.transaction_id && (await findPayment(data.transaction_id, data.custom_data))) ||
        (await db.payment.findFirst({ where: { paddleSubscriptionId: data.id } })) ||
        (await findPayment('', data.custom_data));
      if (!payment) return;

      const previous = payment.subscriptionStatus;
      await db.payment.update({
        where: { id: payment.id },
        data: { paddleSubscriptionId: data.id, subscriptionStatus: data.status },
      });

      let ghlEvent: string;
      if (data.status === 'trialing' && previous !== 'trialing') ghlEvent = 'subscription.trialing';
      else if (data.status === 'active' && previous !== 'active') ghlEvent = 'subscription.active';
      else if (event.event_type === 'subscription.created') return;
      else ghlEvent = 'subscription.updated';

      await sendProviderEvent({
        ...base,
        event: ghlEvent,
        chargeId: payment.paddleTransactionId,
        ghlTransactionId: payment.ghlTransactionId,
        ghlSubscriptionId: payment.ghlSubscriptionId,
        subscriptionSnapshot: {
          id: data.id,
          status: data.status,
          trialEnd: data.status === 'trialing' ? toUnix(data.current_billing_period?.ends_at) : undefined,
          createdAt: toUnix(data.created_at),
          nextCharge: toUnix(data.next_billed_at),
          canceledAt: toUnix(data.canceled_at),
        },
      });
      return;
    }

    default:
      console.log(`Ignoring Paddle event ${event.event_type}`);
  }
}

async function findPayment(paddleTransactionId: string, customData: any): Promise<Payment | null> {
  if (paddleTransactionId) {
    const p = await db.payment.findUnique({ where: { paddleTransactionId } });
    if (p) return p;
  }
  if (customData?.ghl_transaction_id) {
    return db.payment.findFirst({ where: { ghlTransactionId: customData.ghl_transaction_id }, orderBy: { createdAt: 'desc' } });
  }
  return null;
}

function chargeSnapshot(txn: any) {
  const currency = txn.currency_code ?? 'USD';
  return {
    id: txn.id,
    chargeId: txn.id,
    status: 'succeeded',
    amount: fromMinor(txn.details?.totals?.grand_total ?? 0, currency),
    chargedAt: toUnix(txn.billed_at ?? txn.updated_at),
  };
}

function toUnix(iso?: string | null) {
  return iso ? Math.floor(new Date(iso).getTime() / 1000) : undefined;
}
