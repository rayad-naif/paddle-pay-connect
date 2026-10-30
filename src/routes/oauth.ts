import { Router } from 'express';
import crypto from 'crypto';
import { config } from '../config';
import { db } from '../db';
import * as ghl from '../ghl/client';
import { cleanupPaddle } from '../paddle/accounts';

export const oauthRouter = Router();

oauthRouter.get('/oauth/install', (_req, res) => res.redirect(ghl.authorizeUrl()));

oauthRouter.get('/oauth/callback', async (req, res) => {
  const code = req.query.code;
  if (typeof code !== 'string') return res.status(400).send('Missing code');
  try {
    const token = await ghl.exchangeCode(code);
    const locations =
      token.userType === 'Location' && token.locationId
        ? [token.locationId]
        : await ghl.installForCompany(token);
    if (token.userType === 'Location' && token.locationId) await ghl.saveInstallation(token, token.locationId);

    for (const locationId of locations) {
      await ghl.ensureProvider(locationId).catch((e) => console.error(`ensureProvider ${locationId}`, e.message));
    }
    res.send(page('Installed', `<p>Paddle is installed for ${locations.length} sub-account(s).</p>
      <p>Next: open <b>Payments &gt; Integrations</b> in HighLevel, open <b>${config.provider.name}</b>, paste your Paddle API key, then click <b>Set as default</b>.</p>`));
  } catch (e: any) {
    console.error('OAuth callback failed', e);
    res.status(500).send(page('Install failed', `<p>${escapeHtml(e.message)}</p>`));
  }
});

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

  const { type, locationId } = req.body ?? {};
  if (type === 'UNINSTALL' && locationId) {
    const accounts = await db.paddleAccount.findMany({ where: { locationId } });
    for (const a of accounts) await cleanupPaddle(a);
    await db.installation.deleteMany({ where: { locationId } });
    console.log(`Uninstalled ${locationId}`);
  }
  res.json({ received: true });
});

export function page(title: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title><style>body{font-family:system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#1f2937}</style>
  </head><body><h1>${title}</h1>${body}</body></html>`;
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
