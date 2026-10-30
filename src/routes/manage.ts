import { Router, type Request, type Response } from 'express';
import type { Mode } from '../config';
import { db } from '../db';
import { fromMinor, toMinor } from '../lib/money';
import { paddleFor } from '../paddle/accounts';
import { Paddle, PaddleError } from '../paddle/client';
import { auth } from './settings';

/**
 * Dashboard management API: lets merchants work with their Paddle data (transactions, invoices,
 * refunds, subscriptions, customers, discounts, exports, webhook deliveries) without opening Paddle.
 * Every call uses the merchant's own API key for the mode they picked.
 */
export const manageRouter = Router();
manageRouter.use('/api/manage', auth);

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function paddle(req: Request, res: Response): Promise<{ paddle: Paddle; mode: Mode; notificationSettingId: string }> {
  const mode: Mode = (req.query.mode ?? req.body?.mode) === 'test' ? 'test' : 'live';
  const account = await db.paddleAccount.findUnique({
    where: { locationId_mode: { locationId: res.locals.locationId, mode } },
  });
  if (!account) throw new HttpError(400, `Connect your ${mode === 'live' ? 'live' : 'sandbox'} Paddle key first (Connections tab).`);
  return { paddle: paddleFor(account), mode, notificationSettingId: account.notificationSettingId };
}

/** Wraps a handler: maps Paddle permission errors to a message naming the permission to add. */
function handle(permission: string, fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      res.json(await fn(req, res));
    } catch (e: any) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
      if (e instanceof PaddleError && e.status === 403) {
        return res.status(403).json({
          error: `Your Paddle API key doesn't allow this. In Paddle → Developer tools → Authentication, edit the key and enable ${permission}.`,
        });
      }
      if (e instanceof PaddleError) return res.status(e.status >= 500 ? 502 : 400).json({ error: `Paddle: ${e.message}` });
      console.error('Manage API failed', e);
      res.status(500).json({ error: 'Something went wrong. Try again.' });
    }
  };
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const money = (minor: unknown, currency: string) => fromMinor(Number(minor ?? 0), currency);

function customerSummary(c: any) {
  return c ? { id: c.id, email: c.email, name: c.name ?? null } : null;
}

async function customersById(p: Paddle, ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map<string, any>();
  const { data } = await p.list<any>('/customers', { id: unique.join(','), per_page: 200 });
  return new Map(data.map((c) => [c.id, c]));
}

function transactionSummary(t: any) {
  const totals = t.details?.totals ?? {};
  return {
    id: t.id,
    status: t.status,
    origin: t.origin,
    createdAt: t.created_at,
    billedAt: t.billed_at,
    invoiceNumber: t.invoice_number ?? null,
    subscriptionId: t.subscription_id ?? null,
    customer: customerSummary(t.customer) ?? (t.customer_id ? { id: t.customer_id, email: null, name: null } : null),
    currency: t.currency_code,
    total: money(totals.grand_total ?? totals.total, t.currency_code),
    items: (t.items ?? []).map((i: any) => i.price?.name ?? i.price?.description ?? 'Item'),
  };
}

// ---- transactions ----

manageRouter.get('/api/manage/transactions', handle('transaction.read', async (req, res) => {
  const { paddle: p } = await paddle(req, res);
  const q = str(req.query.q);
  const params: Record<string, string | number | undefined> = {
    include: 'customer',
    order_by: 'created_at[DESC]',
    per_page: 25,
    after: str(req.query.after) || undefined,
    status: str(req.query.status) || undefined,
  };
  if (q.startsWith('txn_')) params.id = q;
  else if (q.startsWith('sub_')) params.subscription_id = q;
  else if (q.startsWith('ctm_')) params.customer_id = q;
  else if (q) {
    const { data: customers } = await p.list<any>('/customers', { search: q, per_page: 50 });
    if (customers.length === 0) return { items: [], next: null };
    params.customer_id = customers.map((c) => c.id).join(',');
  }
  const { data, next } = await p.list<any>('/transactions', params);
  return { items: data.map(transactionSummary), next };
}));

manageRouter.get('/api/manage/transactions/:id', handle('transaction.read', async (req, res) => {
  const { paddle: p } = await paddle(req, res);
  const t = await p.get<any>(`/transactions/${encodeURIComponent(req.params.id)}?include=customer,adjustments`);
  const totals = t.details?.totals ?? {};
  const c = t.currency_code;
  return {
    ...transactionSummary(t),
    lines: (t.details?.line_items ?? []).map((l: any) => ({
      id: l.id,
      name: l.product?.name ?? l.price_id ?? 'Item',
      quantity: l.quantity,
      total: money(l.totals?.total, c),
    })),
    subtotal: money(totals.subtotal, c),
    discount: money(totals.discount, c),
    tax: money(totals.tax, c),
    fee: totals.fee != null ? money(totals.fee, c) : null,
    earnings: totals.earnings != null ? money(totals.earnings, c) : null,
    refundable: ['completed', 'billed', 'paid'].includes(t.status),
    adjustments: (t.adjustments ?? []).map((a: any) => ({
      id: a.id,
      action: a.action,
      status: a.status,
      reason: a.reason,
      total: money(a.totals?.total, a.currency_code ?? c),
      createdAt: a.created_at,
    })),
  };
}));

manageRouter.get('/api/manage/transactions/:id/invoice', handle('transaction.read', async (req, res) => {
  const { paddle: p } = await paddle(req, res);
  const inv = await p.get<{ url: string }>(`/transactions/${encodeURIComponent(req.params.id)}/invoice`);
  return { url: inv.url };
}));

manageRouter.post('/api/manage/transactions/:id/refund', handle('adjustment.write', async (req, res) => {
  const { paddle: p } = await paddle(req, res);
  const t = await p.get<any>(`/transactions/${encodeURIComponent(req.params.id)}`);
  const total = Number(t.details?.totals?.grand_total ?? 0);
  const reason = str(req.body?.reason) || 'Refund requested by the seller';
  const amount = req.body?.amount === undefined || req.body?.amount === '' ? null : Number(req.body.amount);
  if (amount !== null && !(amount > 0)) throw new HttpError(400, 'Enter a refund amount greater than zero, or leave it empty for a full refund.');
  const minor = amount === null ? total : toMinor(amount, t.currency_code);
  if (minor > total) throw new HttpError(400, 'The refund is larger than the payment.');
  const line = t.details?.line_items?.[0];
  const adjustment = await p.post<any>('/adjustments',
    minor >= total
      ? { action: 'refund', type: 'full', transaction_id: t.id, reason }
      : { action: 'refund', type: 'partial', transaction_id: t.id, reason, items: [{ item_id: line.id, type: 'partial', amount: String(minor) }] },
  );
  return { id: adjustment.id, status: adjustment.status };
}));

// ---- subscriptions ----

function subscriptionSummary(s: any, customers: Map<string, any>) {
  const c = s.currency_code;
  const recurring = (s.items ?? []).reduce((sum: number, i: any) => sum + Number(i.price?.unit_price?.amount ?? 0) * Number(i.quantity ?? 1), 0);
  return {
    id: s.id,
    status: s.status,
    customer: customerSummary(customers.get(s.customer_id)) ?? { id: s.customer_id, email: null, name: null },
    items: (s.items ?? []).map((i: any) => i.price?.name ?? i.product?.name ?? 'Item'),
    currency: c,
    amount: money(recurring, c),
    cycle: s.billing_cycle ?? null,
    nextBilledAt: s.next_billed_at ?? null,
    startedAt: s.started_at ?? s.created_at,
    scheduledChange: s.scheduled_change ? { action: s.scheduled_change.action, effectiveAt: s.scheduled_change.effective_at } : null,
  };
}

manageRouter.get('/api/manage/subscriptions', handle('subscription.read', async (req, res) => {
  const { paddle: p } = await paddle(req, res);
  const { data, next } = await p.list<any>('/subscriptions', {
    per_page: 25,
    order_by: 'id[DESC]',
    after: str(req.query.after) || undefined,
    status: str(req.query.status) || undefined,
    customer_id: str(req.query.customer_id) || undefined,
  });
  const customers = await customersById(p, data.map((s) => s.customer_id)).catch(() => new Map());
  return { items: data.map((s) => subscriptionSummary(s, customers)), next };
}));

const SUB_ACTIONS: Record<string, (when: string) => unknown> = {
  cancel: (when) => ({ effective_from: when === 'immediately' ? 'immediately' : 'next_billing_period' }),
  pause: (when) => ({ effective_from: when === 'immediately' ? 'immediately' : 'next_billing_period' }),
  resume: () => ({ effective_from: 'immediately' }),
};

manageRouter.post('/api/manage/subscriptions/:id/:action', handle('subscription.write', async (req, res) => {
  const build = SUB_ACTIONS[req.params.action];
  if (!build) throw new HttpError(404, 'Unknown action.');
  const { paddle: p } = await paddle(req, res);
  const id = encodeURIComponent(req.params.id);
  if (req.params.action === 'cancel' && req.body?.undo) {
    // Removes a pending "cancel at period end".
    const s = await p.patch<any>(`/subscriptions/${id}`, { scheduled_change: null });
    return { status: s.status };
  }
  const s = await p.post<any>(`/subscriptions/${id}/${req.params.action}`, build(str(req.body?.when)));
  return { status: s.status, scheduledChange: s.scheduled_change ?? null };
}));

// ---- customers ----

manageRouter.get('/api/manage/customers', handle('customer.read', async (req, res) => {
  const { paddle: p } = await paddle(req, res);
  const { data, next } = await p.list<any>('/customers', {
    per_page: 25,
    order_by: 'id[DESC]',
    after: str(req.query.after) || undefined,
    search: str(req.query.q) || undefined,
  });
  return { items: data.map((c) => ({ ...customerSummary(c), status: c.status, createdAt: c.created_at })), next };
}));

manageRouter.get('/api/manage/customers/:id', handle('customer.read', async (req, res) => {
  const { paddle: p } = await paddle(req, res);
  const id = encodeURIComponent(req.params.id);
  const [customer, txns, subs] = await Promise.all([
    p.get<any>(`/customers/${id}`),
    p.list<any>('/transactions', { customer_id: req.params.id, order_by: 'created_at[DESC]', per_page: 20 }),
    p.list<any>('/subscriptions', { customer_id: req.params.id, per_page: 20 }).catch(() => ({ data: [] as any[] })),
  ]);
  const map = new Map([[customer.id, customer]]);
  return {
    ...customerSummary(customer),
    status: customer.status,
    createdAt: customer.created_at,
    transactions: txns.data.map((t) => transactionSummary({ ...t, customer })),
    subscriptions: subs.data.map((s) => subscriptionSummary(s, map)),
  };
}));

/** A link to Paddle's customer portal, where the buyer can update their card or cancel. */
manageRouter.post('/api/manage/customers/:id/portal', handle('customer portal sessions (customer_portal_session.write)', async (req, res) => {
  const { paddle: p } = await paddle(req, res);
  const session = await p.post<any>(`/customers/${encodeURIComponent(req.params.id)}/portal-sessions`, {});
  return { url: session.urls?.general?.overview ?? null };
}));

// ---- discounts ----

function discountSummary(d: any) {
  return {
    id: d.id,
    status: d.status,
    code: d.code ?? null,
    description: d.description,
    type: d.type,
    amount: d.type === 'percentage' ? Number(d.amount) : money(d.amount, d.currency_code ?? 'USD'),
    currency: d.currency_code ?? null,
    recur: !!d.recur,
    usageLimit: d.usage_limit ?? null,
    timesUsed: d.times_used ?? 0,
    expiresAt: d.expires_at ?? null,
  };
}

manageRouter.get('/api/manage/discounts', handle('discount.read', async (req, res) => {
  const { paddle: p } = await paddle(req, res);
  const { data, next } = await p.list<any>('/discounts', {
    per_page: 50,
    after: str(req.query.after) || undefined,
    status: str(req.query.status) || 'active',
  });
  return { items: data.map(discountSummary), next };
}));

manageRouter.post('/api/manage/discounts', handle('discount.write', async (req, res) => {
  const { paddle: p } = await paddle(req, res);
  const b = req.body ?? {};
  const code = str(b.code).toUpperCase();
  if (!/^[A-Z0-9_-]{2,32}$/.test(code)) throw new HttpError(400, 'Use a code of 2 to 32 letters, numbers, dashes or underscores.');
  const type = b.type === 'flat' ? 'flat' : 'percentage';
  const amount = Number(b.amount);
  if (!(amount > 0) || (type === 'percentage' && amount > 100)) throw new HttpError(400, type === 'percentage' ? 'Enter a percentage between 1 and 100.' : 'Enter an amount greater than zero.');
  const currency = str(b.currency).toUpperCase() || 'USD';
  const usageLimit = b.usageLimit ? Number(b.usageLimit) : undefined;
  const expires = str(b.expiresAt);
  const d = await p.post<any>('/discounts', {
    description: str(b.description) || code,
    code,
    enabled_for_checkout: true,
    type,
    amount: type === 'percentage' ? String(amount) : String(toMinor(amount, currency)),
    currency_code: type === 'flat' ? currency : undefined,
    recur: !!b.recur,
    usage_limit: usageLimit && usageLimit > 0 ? usageLimit : undefined,
    expires_at: expires ? new Date(`${expires}T23:59:59Z`).toISOString() : undefined,
  });
  return discountSummary(d);
}));

manageRouter.patch('/api/manage/discounts/:id', handle('discount.write', async (req, res) => {
  const { paddle: p } = await paddle(req, res);
  const status = req.body?.status === 'archived' ? 'archived' : 'active';
  const d = await p.patch<any>(`/discounts/${encodeURIComponent(req.params.id)}`, { status });
  return discountSummary(d);
}));

// ---- checkout preferences (stored here, applied by the checkout page) ----

manageRouter.get('/api/manage/preferences', handle('', async (_req, res) => {
  const prefs = await db.locationSettings.findUnique({ where: { locationId: res.locals.locationId } });
  return { allowDiscountCodes: prefs?.allowDiscountCodes ?? false };
}));

manageRouter.post('/api/manage/preferences', handle('', async (req, res) => {
  const allowDiscountCodes = !!req.body?.allowDiscountCodes;
  await db.locationSettings.upsert({
    where: { locationId: res.locals.locationId },
    create: { locationId: res.locals.locationId, allowDiscountCodes },
    update: { allowDiscountCodes },
  });
  return { allowDiscountCodes };
}));

// ---- CSV export (Paddle reports) ----

manageRouter.post('/api/manage/export', handle('report.read and report.write', async (req, res) => {
  const { paddle: p } = await paddle(req, res);
  const from = str(req.body?.from);
  const to = str(req.body?.to);
  const filters: { name: string; operator: string; value: string }[] = [];
  if (from) filters.push({ name: 'updated_at', operator: 'gte', value: new Date(`${from}T00:00:00Z`).toISOString() });
  if (to) filters.push({ name: 'updated_at', operator: 'lt', value: new Date(new Date(`${to}T00:00:00Z`).getTime() + 86_400_000).toISOString() });
  const report = await p.post<any>('/reports', { type: 'transactions', filters });
  return { id: report.id, status: report.status };
}));

manageRouter.get('/api/manage/export/:id', handle('report.read', async (req, res) => {
  const { paddle: p } = await paddle(req, res);
  const id = encodeURIComponent(req.params.id);
  const report = await p.get<any>(`/reports/${id}`);
  if (report.status !== 'ready') return { status: report.status, url: null };
  const link = await p.get<{ url: string }>(`/reports/${id}/download-url`);
  return { status: 'ready', url: link.url };
}));

// ---- webhook health (deliveries to this app) ----

manageRouter.get('/api/manage/webhooks', handle('notification.read', async (req, res) => {
  const { paddle: p, notificationSettingId } = await paddle(req, res);
  const { data } = await p.list<any>('/notifications', {
    notification_setting_id: notificationSettingId,
    per_page: 25,
    order_by: 'id[DESC]',
    status: str(req.query.status) || undefined,
  });
  return {
    items: data.map((n) => ({
      id: n.id,
      type: n.type,
      status: n.status,
      occurredAt: n.occurred_at,
      attempts: n.times_attempted ?? null,
      lastAttemptAt: n.last_attempt_at ?? null,
    })),
  };
}));

manageRouter.post('/api/manage/webhooks/:id/replay', handle('notification.write', async (req, res) => {
  const { paddle: p } = await paddle(req, res);
  const r = await p.post<any>(`/notifications/${encodeURIComponent(req.params.id)}/replay`);
  return { id: r?.notification_id ?? null };
}));
