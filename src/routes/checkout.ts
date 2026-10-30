import { Router } from 'express';
import { db } from '../db';
import * as ghl from '../ghl/client';
import { toMinor } from '../lib/money';
import { paddleFor } from '../paddle/accounts';
import { PaddleError } from '../paddle/client';

export const checkoutRouter = Router();

const INTERVALS = new Set(['day', 'week', 'month', 'year']);

/**
 * Called by the checkout iframe with GHL's payment_initiate_props.
 * Creates a Paddle transaction (non-catalog price) for the exact GHL amount
 * and returns what Paddle.js needs to open checkout.
 */
checkoutRouter.post('/api/checkout/session', async (req, res) => {
  const p = req.body ?? {};
  try {
    const account = await db.paddleAccount.findUnique({ where: { clientToken: String(p.publishableKey ?? '') } });
    if (!account || account.locationId !== p.locationId) {
      return res.status(400).json({ error: 'Paddle is not connected for this account.' });
    }
    const amount = Number(p.amount);
    const currency = String(p.currency ?? 'USD').toUpperCase();
    if (!p.transactionId || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: 'Invalid payment details.' });
    }
    const paddle = paddleFor(account);
    const contact = p.contact ?? {};
    const amountMinor = toMinor(amount, currency);
    const environment = account.mode === 'live' ? 'production' : 'sandbox';

    // A retry (reloaded iframe, closed checkout) reuses the open Paddle transaction for the same
    // GHL transaction instead of piling up duplicates.
    const previous = await db.payment.findFirst({
      where: { locationId: account.locationId, mode: account.mode, ghlTransactionId: String(p.transactionId) },
      orderBy: { createdAt: 'desc' },
    });
    if (previous && previous.amountMinor === amountMinor && previous.currency === currency) {
      const txn = await paddle.getTransaction(previous.paddleTransactionId).catch(() => null);
      if (txn && ['draft', 'ready'].includes(txn.status)) {
        return res.json({ transactionId: txn.id, environment, token: account.clientToken, email: null, amount, currency });
      }
    }

    let customerId: string | undefined;
    if (contact.email) {
      customerId = await paddle.findOrCreateCustomer(contact.email, contact.name);
      if (contact.id) {
        await db.customerMap.upsert({
          where: { locationId_mode_ghlContactId: { locationId: account.locationId, mode: account.mode, ghlContactId: contact.id } },
          create: { locationId: account.locationId, mode: account.mode, ghlContactId: contact.id, paddleCustomerId: customerId },
          update: { paddleCustomerId: customerId },
        });
      }
    }

    // Recurring GHL prices become Paddle subscriptions via a billing cycle on the price.
    let productName = 'Payment';
    let billingCycle: { interval: string; frequency: number } | undefined;
    let trialPeriod: { interval: string; frequency: number } | undefined;
    const { productId, priceId } = p.productDetails ?? {};
    if (productId && priceId) {
      try {
        const price = await ghl.getPrice(account.locationId, productId, priceId);
        if (price?.name) productName = price.name;
        if (p.subscriptionId && price?.recurring && INTERVALS.has(price.recurring.interval)) {
          billingCycle = { interval: price.recurring.interval, frequency: Number(price.recurring.intervalCount ?? 1) };
          if (Number(price.trialPeriod) > 0) trialPeriod = { interval: 'day', frequency: Number(price.trialPeriod) };
        }
      } catch (e: any) {
        if (p.subscriptionId) throw new Error(`Could not load the recurring price from the CRM: ${e.message}`);
        console.warn('getPrice failed, continuing as one-time payment', e.message);
      }
    }

    const txn = await paddle.createTransaction({
      customer_id: customerId,
      collection_mode: 'automatic',
      custom_data: {
        ghl_transaction_id: p.transactionId,
        ghl_order_id: p.orderId ?? null,
        ghl_subscription_id: p.subscriptionId ?? null,
        ghl_location_id: account.locationId,
      },
      items: [
        {
          quantity: 1,
          price: {
            name: productName,
            description: `Order ${p.orderId ?? p.transactionId}`,
            unit_price: { amount: String(amountMinor), currency_code: currency },
            billing_cycle: billingCycle,
            trial_period: trialPeriod,
            product: { name: productName, tax_category: 'standard' },
          },
        },
      ],
    });

    await db.payment.create({
      data: {
        locationId: account.locationId,
        mode: account.mode,
        ghlTransactionId: p.transactionId,
        ghlOrderId: p.orderId ?? null,
        ghlSubscriptionId: p.subscriptionId ?? null,
        ghlContactId: contact.id ?? null,
        paddleTransactionId: txn.id,
        paddleCustomerId: customerId ?? null,
        amountMinor,
        currency,
        status: txn.status,
      },
    });

    res.json({
      transactionId: txn.id,
      environment,
      token: account.clientToken,
      // The transaction already carries the customer; only prefill when it doesn't.
      email: customerId ? null : contact.email ?? null,
      // Shown in the order summary until Paddle's own totals (with tax) arrive.
      productName,
      amount,
      currency,
      billingCycle: billingCycle ?? null,
    });
  } catch (e: any) {
    console.error('Checkout session failed', e);
    const message = e instanceof PaddleError ? `Paddle: ${e.message}` : e.message;
    res.status(500).json({ error: message ?? 'Could not start checkout.' });
  }
});

/** Client-side Paddle.js errors, logged so they show up in the server logs. */
checkoutRouter.post('/api/checkout/log', (req, res) => {
  const { transactionId, event } = req.body ?? {};
  console.warn('Paddle checkout error', String(transactionId ?? '').slice(0, 64), JSON.stringify(event ?? null).slice(0, 2000));
  res.status(204).end();
});

/**
 * Paddle sends buyers to the default payment link with ?_ptxn=txn_… (invoice emails, retries).
 * The checkout page asks which Paddle account and environment that transaction belongs to.
 */
checkoutRouter.get('/api/checkout/link', async (req, res) => {
  const payment = await db.payment.findUnique({ where: { paddleTransactionId: String(req.query.txn ?? '') } });
  if (!payment) return res.status(404).json({ error: 'This payment link is not valid.' });
  const account = await db.paddleAccount.findUnique({
    where: { locationId_mode: { locationId: payment.locationId, mode: payment.mode } },
  });
  if (!account) return res.status(404).json({ error: 'This seller is no longer accepting payments here.' });
  res.json({
    transactionId: payment.paddleTransactionId,
    environment: account.mode === 'live' ? 'production' : 'sandbox',
    token: account.clientToken,
  });
});
