import { Router } from 'express';
import crypto from 'crypto';
import { config } from '../config';
import { db } from '../db';
import * as ghl from '../ghl/client';
import { cleanupPaddle } from '../paddle/accounts';
import { removeDomain } from '../domains';
import { safeEqual, signSession, verifySession } from '../lib/crypto';

export const oauthRouter = Router();

oauthRouter.get('/oauth/install', (_req, res) => res.redirect(ghl.authorizeUrl()));

oauthRouter.get('/oauth/callback', async (req, res) => {
  const code = req.query.code;
  if (typeof code !== 'string') return res.status(400).send(page('Install failed', '<p>The install link is missing its code. Start the install again from the app marketplace.</p>'));
  try {
    // Exchange with the redirect URL the CRM used, which can differ from APP_URL (custom domain).
    const host = req.get('x-forwarded-host') ?? req.get('host');
    const token = await ghl.exchangeCode(code, host ? `https://${host}/oauth/callback` : undefined)
      .catch((e) => (host && `https://${host}` !== config.appUrl ? ghl.exchangeCode(code) : Promise.reject(e)));
    const name = escapeHtml(config.provider.name);
    const next = `<h2 style="font-size:18px;margin-top:28px">Next, in each account</h2>
      <ol>
        <li>Open <b>${name}</b> from the account’s left menu and connect your Paddle API key (sandbox and/or live).</li>
        <li>Go to <b>Payments &gt; Integrations</b>, find <b>${name}</b> and click <b>Set as default</b>.</li>
      </ol>
      <p>Full instructions: <a href="/docs">setup guide</a>.</p>`;

    if (token.userType === 'Company' || (!token.locationId && token.companyId)) {
      // Agency install: the company token is stored, and every account the app is (or later gets)
      // installed in is set up automatically.
      const { installed } = await ghl.installForCompany(token);
      await registerAll(installed, 2500);
      // The CRM attaches accounts to an agency install right after this redirect, so the page keeps
      // syncing for a minute and registers each account in Payments > Integrations as it appears.
      const syncToken = signSession(`company:${token.companyId}`, 15 * 60);
      return res.send(page('Installed', `<p>${name} is installed for your company.</p>
        <p id="sync" style="padding:12px 14px;border-radius:10px;background:#eef2ff">Setting up your accounts…</p>
        ${next}
        <script>
          (async () => {
            const el = document.getElementById('sync');
            let last = null;
            for (let i = 0; i < 12; i++) {
              try {
                const r = await fetch('/oauth/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: ${JSON.stringify(syncToken)} }) });
                last = await r.json();
                if (r.ok && last.total > 0) {
                  el.textContent = last.pending
                    ? 'Set up in ' + last.ready + ' of ' + last.total + ' accounts… (still working)'
                    : 'Ready in ' + last.ready + ' account' + (last.ready === 1 ? '' : 's') + '. ${name} now shows in Payments > Integrations there.';
                  if (!last.pending && i >= 2) return;
                }
              } catch (e) {}
              await new Promise((r) => setTimeout(r, 5000));
            }
            if (!last || !last.total) el.textContent = 'No accounts yet. Accounts you install it in are set up automatically, or the first time ${name} is opened in them.';
          })();
        </script>`));
    }

    if (!token.locationId) throw new Error('The CRM did not say which account the app was installed in. Start the install again.');
    await ghl.saveInstallation(token, token.locationId);
    const registered = await registerAll([token.locationId]);
    res.send(page('Installed', `<p>${name} is installed for this account.</p>
      ${registered.failed ? `<p style="color:#b45309">It couldn’t be added to Payments &gt; Integrations yet: ${escapeHtml(registered.error)}. Open Paddle Pay from the account menu to retry.</p>` : ''}
      ${next}`));
  } catch (e: any) {
    console.error('OAuth callback failed', e);
    res.status(500).send(page('Install failed', `<p>${escapeHtml(e.message)}</p><p>Start the install again from the app marketplace. If it keeps failing, contact support.</p>`));
  }
});

/** (Re)registers the payment provider so the app shows in Payments > Integrations. */
async function registerAll(locationIds: string[], budgetMs = Infinity) {
  let failed = 0;
  let deferred = 0;
  let error = '';
  const started = Date.now();
  for (const locationId of locationIds) {
    if (Date.now() - started > budgetMs) {
      deferred++; // registered when the dashboard is first opened there
      continue;
    }
    try {
      await ghl.ensureProvider(locationId, true);
    } catch (e: any) {
      failed++;
      error = e.message;
      console.error(`ensureProvider ${locationId}`, e.message);
    }
  }
  return { failed, deferred, error };
}

/** Called by the install page: sets up the company's accounts as the CRM attaches them. */
oauthRouter.post('/oauth/sync', async (req, res) => {
  const session = verifySession(String(req.body?.token ?? ''));
  if (!session?.locationId.startsWith('company:')) return res.status(401).json({ error: 'Session expired.' });
  try {
    res.json(await ghl.syncCompany(session.locationId.slice('company:'.length)));
  } catch (e: any) {
    console.error('Company sync failed', e.message);
    res.status(502).json({ error: e.message });
  }
});

/** Daily safety net (Vercel cron): set up any account an install notification missed. */
oauthRouter.get('/api/cron/sync', async (req, res) => {
  const auth = req.header('authorization') ?? '';
  if (!config.cronSecret || !safeEqual(auth, `Bearer ${config.cronSecret}`)) return res.status(401).json({ error: 'Unauthorized' });
  const started = Date.now();
  const results: Record<string, unknown> = {};
  for (const { companyId } of await db.company.findMany({ select: { companyId: true } })) {
    if (Date.now() - started > 8000) break;
    results[companyId] = await ghl.syncCompany(companyId, 3000).catch((e) => ({ error: e.message }));
  }
  res.json(results);
});

/** True if the request carries a valid marketplace signature (RSA x-wh-signature or Ed25519 x-ghl-signature). */
function signatureValid(req: any): boolean | null {
  const raw = req.rawBody as Buffer | undefined;
  const ed = req.header('x-ghl-signature');
  const rsa = req.header('x-wh-signature');
  if (!config.ghl.webhookPublicKey && !config.ghl.webhookEd25519Key) return null; // not configured
  try {
    if (raw && ed && config.ghl.webhookEd25519Key) return crypto.verify(null, raw, config.ghl.webhookEd25519Key, Buffer.from(ed, 'base64'));
    if (raw && rsa && config.ghl.webhookPublicKey) return crypto.verify('sha256', raw, config.ghl.webhookPublicKey, Buffer.from(rsa, 'base64'));
  } catch (e: any) {
    console.warn('Webhook signature check failed', e.message);
  }
  return false;
}

/** App lifecycle webhooks from the marketplace (INSTALL / UNINSTALL). */
// GHL rejects URLs containing "ghl"/"highlevel", so routes avoid those words.
oauthRouter.post('/webhooks/app', async (req, res) => {
  const { type, locationId, companyId } = req.body ?? {};
  const valid = signatureValid(req);
  console.log(`App webhook ${type} location=${locationId ?? '-'} company=${companyId ?? '-'} signature=${valid === null ? 'not checked' : valid ? 'valid' : 'invalid'}`);
  // UNINSTALL deletes data, so it must be genuine. INSTALL is safe to act on either way: setting a
  // location up needs the CRM to issue a token for it from the company's own token.
  if (valid === false && type !== 'INSTALL') return res.status(401).json({ error: 'Invalid signature' });

  try {
    if (type === 'INSTALL' && locationId && companyId) {
      // An agency installed the app into an account (including bulk and "future accounts"
      // installs): no OAuth redirect happens for it, so set it up from the company token.
      const company = await db.company.findUnique({ where: { companyId } });
      if (company) {
        await ghl.installLocationFromCompany(companyId, locationId);
        await ghl.ensureProvider(locationId, true);
        console.log(`Installed ${locationId} from company ${companyId}`);
      }
    }
    if (type === 'UNINSTALL') {
      const locations = locationId
        ? [locationId]
        : companyId
          ? (await db.installation.findMany({ where: { companyId }, select: { locationId: true } })).map((i) => i.locationId)
          : [];
      for (const id of locations) await uninstallLocation(id);
      if (!locationId && companyId) await db.company.deleteMany({ where: { companyId } });
      console.log(`Uninstalled ${locationId ?? `company ${companyId}`}`);
    }
  } catch (e: any) {
    console.error(`App webhook ${type} failed`, e.message);
  }
  res.json({ received: true });
});

async function uninstallLocation(locationId: string) {
  const accounts = await db.paddleAccount.findMany({ where: { locationId } });
  for (const a of accounts) await cleanupPaddle(a);
  await removeDomain(locationId).catch((e) => console.warn('Remove checkout domain failed', e.message));
  await db.installation.deleteMany({ where: { locationId } });
}

export function page(title: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#1f2937}</style>
  </head><body><h1>${title}</h1>${body}</body></html>`;
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
