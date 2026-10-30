import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Mode } from '../config';
import { db } from '../db';
import { decryptGhlSso, signSession, verifySession } from '../lib/crypto';
import { fromMinor } from '../lib/money';
import { UserError, connectPaddle, disconnectPaddle } from '../paddle/accounts';

export const settingsRouter = Router();

/** Exchanges GHL's encrypted user data (from the custom page) for a session token. */
settingsRouter.post('/api/settings/session', async (req, res) => {
  try {
    const user = decryptGhlSso(String(req.body?.encrypted ?? ''));
    const locationId = user.activeLocation;
    if (!locationId) return res.status(400).json({ error: 'Open this page from inside a sub-account.' });
    const installed = await db.installation.findUnique({ where: { locationId } });
    if (!installed) return res.status(404).json({ error: 'The app is not installed for this sub-account. Reinstall it from the Marketplace.' });
    res.json({ token: signSession(locationId), locationId, userName: user.userName ?? '' });
  } catch {
    res.status(401).json({ error: 'Could not verify your HighLevel session.' });
  }
});

function auth(req: Request, res: Response, next: NextFunction) {
  const token = req.header('authorization')?.replace(/^Bearer /, '') ?? '';
  const session = verifySession(token);
  if (!session) return res.status(401).json({ error: 'Session expired. Reload the page.' });
  res.locals.locationId = session.locationId;
  next();
}

settingsRouter.get('/api/settings', auth, async (_req, res) => {
  const accounts = await db.paddleAccount.findMany({ where: { locationId: res.locals.locationId } });
  const status = (mode: Mode) => {
    const a = accounts.find((x) => x.mode === mode);
    return a ? { connected: true, connectedAt: a.updatedAt } : { connected: false };
  };
  res.json({ test: status('test'), live: status('live') });
});

/** Dashboard data: 30-day totals per mode and currency, plus the latest payments. */
settingsRouter.get('/api/settings/overview', auth, async (_req, res) => {
  const locationId = res.locals.locationId;
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [totals, recent, subscriptions] = await Promise.all([
    db.payment.groupBy({
      by: ['mode', 'currency'],
      where: { locationId, status: { in: ['completed', 'paid'] }, createdAt: { gte: since } },
      _sum: { amountMinor: true },
      _count: true,
    }),
    db.payment.findMany({ where: { locationId }, orderBy: { createdAt: 'desc' }, take: 25 }),
    db.payment.groupBy({
      by: ['mode'],
      where: { locationId, paddleSubscriptionId: { not: null }, status: { in: ['completed', 'paid'] } },
      _count: true,
    }),
  ]);
  res.json({
    totals: totals.map((t) => ({
      mode: t.mode,
      currency: t.currency,
      count: t._count,
      amount: fromMinor(t._sum.amountMinor ?? 0, t.currency),
    })),
    subscriptions: Object.fromEntries(subscriptions.map((s) => [s.mode, s._count])),
    recent: recent.map((p) => ({
      id: p.paddleTransactionId,
      mode: p.mode,
      amount: fromMinor(p.amountMinor, p.currency),
      currency: p.currency,
      status: p.status,
      subscription: !!(p.paddleSubscriptionId || p.ghlSubscriptionId),
      ghlOrderId: p.ghlOrderId,
      createdAt: p.createdAt,
    })),
  });
});

settingsRouter.post('/api/settings/connect', auth, async (req, res) => {
  try {
    const account = await connectPaddle(res.locals.locationId, String(req.body?.apiKey ?? ''));
    res.json({ connected: true, mode: account.mode });
  } catch (e: any) {
    if (e instanceof UserError) return res.status(400).json({ error: e.message });
    console.error('Connect failed', e);
    res.status(500).json({ error: `Connection failed: ${e.message}` });
  }
});

settingsRouter.post('/api/settings/disconnect', auth, async (req, res) => {
  const mode = req.body?.mode === 'live' ? 'live' : 'test';
  await disconnectPaddle(res.locals.locationId, mode);
  res.json({ connected: false, mode });
});
