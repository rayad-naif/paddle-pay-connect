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
        if (p.subscriptionId) throw new Error(`Could not load the recurring price from HighLevel: ${e.message}`);
        console.warn('getPrice failed, continuing as one-time payment', e.message);
      }
    }

    const amountMinor = toMinor(amount, currency);
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
            description: `HighLevel order ${p.orderId ?? p.transactionId}`,
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
      environment: account.mode === 'live' ? 'production' : 'sandbox',
      token: account.clientToken,
      email: contact.email ?? null,
    });
  } catch (e: any) {
    console.error('Checkout session failed', e);
    const message = e instanceof PaddleError ? `Paddle: ${e.message}` : e.message;
    res.status(500).json({ error: message ?? 'Could not start checkout.' });
  }
});
