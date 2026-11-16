import { Router } from 'express';
import crypto from 'crypto';
import { config } from '../config';
import { db } from '../db';
import * as ghl from '../ghl/client';
import { cleanupPaddle } from '../paddle/accounts';
import { removeDomain } from '../domains';

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
    // The provider shows in Payments > Integrations once a Paddle key is connected, so the key
    // comes first.
    const next = `<h2 style="font-size:18px;margin-top:28px">Next, in each account</h2>
      <ol>
        <li>Open <b>Paddle Settings</b> in the account’s left menu and connect your Paddle API key (sandbox and/or live).</li>
        <li>Then go to <b>Payments &gt; Integrations</b>, find <b>${name}</b> and click <b>Set as default</b>.</li>
      </ol>
      <p>${name} appears in Payments &gt; Integrations after the API key is connected. Full instructions: <a href="/docs">setup guide</a>.</p>`;

    if (token.userType === 'Company' || (!token.locationId && token.companyId)) {
      // Agency install: the company token is stored, and every account the app is (or later gets)
      // installed in is set up automatically.
      const { installed, failed, deferred } = await ghl.installForCompany(token);
      const registered = await registerAll(installed, 2500);
      return res.send(page('Installed', `<p>${name} is installed for your company${installed.length ? ` and set up in ${installed.length} account${installed.length === 1 ? '' : 's'}` : ''}.</p>
        ${installed.length === 0 ? '<p>Accounts you install it in from now on are set up automatically.</p>' : ''}
        ${failed.length || registered.failed || deferred || registered.deferred ? `<p>${failed.length + registered.failed + deferred + registered.deferred} more account(s) finish setting up automatically the first time Paddle Pay is opened in them.</p>` : ''}
        ${next}`));
    }

    if (!token.locationId) throw new Error('The CRM did not say which account the app was installed in. Start the install again.');
    await ghl.saveInstallation(token, token.locationId);
    const registered = await registerAll([token.locationId]);
    res.send(page('Installed', `<p>${name} is installed for this account.</p>
      ${registered.failed ? `<p style="color:#b45309">It couldn’t be added to Payments &gt; Integrations yet: ${escapeHtml(registered.error)}. Open Paddle Settings from the account menu to retry.</p>` : ''}
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

/** App lifecycle webhooks from the marketplace (INSTALL / UNINSTALL). */
// GHL rejects URLs containing "ghl"/"highlevel", so routes avoid those words.
oauthRouter.post('/webhooks/app', async (req, res) => {
  const raw = (req as any).rawBody as Buffer | undefined;
  if (config.ghl.webhookPublicKey) {
    const signature = req.header('x-wh-signature');
    const ok =
      !!signature &&
      !!raw &&
      crypto.verify('sha256', raw, config.ghl.webhookPublicKey, Buffer.from(signature, 'base64'));
    if (!ok) return res.status(401).json({ error: 'Invalid signature' });
  }

  const { type, locationId, companyId } = req.body ?? {};
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
