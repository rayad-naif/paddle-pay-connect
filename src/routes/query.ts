import { Router } from 'express';
import { db } from '../db';
import { safeEqual, sha256 } from '../lib/crypto';
import { toMinor } from '../lib/money';
import { findAccountByGhlApiKey, paddleFor } from '../paddle/accounts';

export const queryRouter = Router();

/** GHL's queryUrl: verify, refund, list_payment_methods, charge_payment, create_subscription. */
queryRouter.post('/api/query', async (req, res) => {
  const body = req.body ?? {};
  try {
    switch (body.type) {
      case 'verify':
        return res.json(await verify(body));
      case 'refund':
        return res.json(await refund(body));
      case 'list_payment_methods':
        return res.json(await listPaymentMethods(body));
      case 'charge_payment':
        return res.json({
          success: false,
          failed: true,
          message: 'Paddle does not support charging a saved card outside of a subscription.',
        });
      case 'create_subscription':
        return res.json({
          success: false,
          failed: true,
          message: 'Subscriptions are created through Paddle checkout; off-session subscription creation is not supported.',
        });
      default:
        return res.status(400).json({ success: false, message: `Unsupported type: ${body.type}` });
    }
  } catch (e: any) {
    console.error(`queryUrl ${body.type} failed`, e);
    if (e instanceof AuthError) return res.status(401).json({ success: false, message: e.message });
    res.status(500).json({ success: false, failed: true, message: e.message });
  }
});

class AuthError extends Error {}

async function verify(body: any) {
  const account = await findAccountByGhlApiKey(body.apiKey);
  if (!account) throw new AuthError('Invalid apiKey');

  const payment = await db.payment.findUnique({ where: { paddleTransactionId: String(body.chargeId ?? '') } });
  if (!payment || payment.locationId !== account.locationId || payment.ghlTransactionId !== body.transactionId) {
    return { failed: true };
  }

  const txn = await paddleFor(account).getTransaction(payment.paddleTransactionId);
  await db.payment.update({
    where: { id: payment.id },
    data: { status: txn.status, paddleSubscriptionId: txn.subscription_id ?? payment.paddleSubscriptionId },
  });
  if (txn.status === 'completed' || txn.status === 'paid') return { success: true };
  if (txn.status === 'canceled') return { failed: true };
  return { success: false }; // still pending
}

async function refund(body: any) {
  const payment = await db.payment.findFirst({
    where: { ghlTransactionId: String(body.transactionId ?? ''), status: { in: ['completed', 'paid'] } },
    orderBy: { createdAt: 'desc' },
  });
  if (!payment) return { success: false, failed: true, message: 'No completed Paddle payment found for this transaction.' };

  const account = await db.paddleAccount.findUnique({
    where: { locationId_mode: { locationId: payment.locationId, mode: payment.mode } },
  });
  if (!account) return { success: false, failed: true, message: 'Paddle is no longer connected for this account.' };
  if (body.apiKey && !safeEqual(sha256(body.apiKey), account.ghlApiKeyHash)) throw new AuthError('Invalid apiKey');

  const paddle = paddleFor(account);
  const txn = await paddle.getTransaction(payment.paddleTransactionId);
  const total = Number(txn.details?.totals?.grand_total ?? payment.amountMinor);
  const requested = body.amount != null ? toMinor(Number(body.amount), payment.currency) : total;
  if (requested <= 0) return { success: false, failed: true, message: 'Refund amount must be greater than zero.' };

  const adjustment = await paddle.createAdjustment(
    requested >= total
      ? { action: 'refund', type: 'full', transaction_id: txn.id, reason: 'Refund requested from HighLevel' }
      : {
          action: 'refund',
          type: 'partial',
          transaction_id: txn.id,
          reason: 'Partial refund requested from HighLevel',
          items: [{ item_id: txn.details.line_items[0].id, type: 'partial', amount: String(requested) }],
        },
  );
  return {
    success: true,
    refundId: adjustment.id,
    status: adjustment.status,
    message:
      adjustment.status === 'pending_approval'
        ? 'Refund submitted to Paddle and is pending approval.'
        : `Refund ${adjustment.status}.`,
  };
}

async function listPaymentMethods(body: any) {
  const account = await findAccountByGhlApiKey(body.apiKey);
  if (!account) throw new AuthError('Invalid apiKey');
  const map = await db.customerMap.findUnique({
    where: { locationId_mode_ghlContactId: { locationId: account.locationId, mode: account.mode, ghlContactId: String(body.contactId ?? '') } },
  });
  if (!map) return [];
  const methods = await paddleFor(account).listPaymentMethods(map.paddleCustomerId);
  return methods
    .filter((m) => m.type === 'card' && m.card)
    .map((m) => ({
      id: m.id,
      type: 'card',
      title: m.card.type,
      subTitle: `**** ${m.card.last4}`,
      expiry: `${String(m.card.expiry_month).padStart(2, '0')}/${String(m.card.expiry_year).slice(-2)}`,
      customerId: map.paddleCustomerId,
      imageUrl: null,
    }));
}
