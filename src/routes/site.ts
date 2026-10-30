import { Router } from 'express';
import { config } from '../config';
import { db } from '../db';
import { isAppHost } from '../domains';
import { escapeHtml } from './oauth';

/**
 * Public website: home/pricing plus the legal pages Paddle reviews before it approves a
 * domain for live checkout (terms naming the business and Paddle as Merchant of Record,
 * privacy policy, refund policy, visible pricing and contact details).
 */
export const siteRouter = Router();

// On a merchant's checkout domain only /checkout belongs to us; everything else goes to the
// merchant's own website, so Paddle reviewers never see this app's site under their domain.
siteRouter.use(async (req, res, next) => {
  if (req.method !== 'GET' || isAppHost(req.hostname) || req.path === '/checkout' || req.path.startsWith('/api/') || req.path === '/health') {
    return next();
  }
  try {
    const domain = await db.checkoutDomain.findUnique({ where: { hostname: req.hostname } });
    if (domain?.websiteUrl) return res.redirect(302, domain.websiteUrl);
    res.status(404).send('Not found');
  } catch (e) {
    next(e);
  }
});

const PRODUCT = 'Paddle Pay';
const UPDATED = '30 October 2026';
const PLANS = [
  { name: 'Single account', price: '$29', period: 'per account / month', yearly: 'or $290 / year', features: ['One CRM account', 'Sandbox and live Paddle connections', 'One-time payments and subscriptions', 'Refunds from your CRM', 'Email support'] },
  { name: 'Unlimited accounts', price: '$149', period: 'per month', yearly: 'or $1,490 / year', features: ['Unlimited CRM accounts', 'Everything in Single account', 'Install across all your accounts at once', 'Priority support'] },
];

export function contactLine() {
  const b = config.business;
  const email = b.email ? `<a href="mailto:${escapeHtml(b.email)}">${escapeHtml(b.email)}</a>` : '';
  return [escapeHtml(b.name), escapeHtml(b.address), email].filter(Boolean).join(' · ');
}

export function layout(title: string, body: string, { home = false } = {}) {
  const b = config.business;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${PRODUCT}: accept payments in your CRM's funnels, websites, stores, invoices and payment links through Paddle Billing.">
<link rel="icon" href="/logo.svg">
${home ? `<script>if (window.self !== window.top) location.replace('/dashboard' + location.search);</script>` : ''}
<style>
  :root { --bg:#ffffff; --soft:#f6f7fb; --text:#0f172a; --muted:#5b6475; --line:#e5e7eb; --accent:#4338ca; --accent-soft:#eef2ff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b1020; --soft:#121933; --text:#e6e9f2; --muted:#9aa3b8; --line:#232b45; --accent:#8b93ff; --accent-soft:#1b2150; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.6 system-ui,-apple-system,Segoe UI,sans-serif; }
  a { color:var(--accent); }
  .wrap { max-width:1040px; margin:0 auto; padding:0 16px; }
  header { border-bottom:1px solid var(--line); }
  header .wrap { display:flex; align-items:center; justify-content:space-between; gap:12px; height:64px; }
  .brand { display:flex; align-items:center; gap:10px; font-weight:650; color:var(--text); text-decoration:none; }
  .brand img { width:30px; height:30px; }
  nav { display:flex; gap:18px; flex-wrap:wrap; font-size:14px; }
  nav a { color:var(--muted); text-decoration:none; }
  .hero { padding:72px 0 48px; text-align:center; }
  .hero h1 { font-size:clamp(30px,5vw,46px); line-height:1.15; margin:0 auto 16px; max-width:760px; }
  .hero p { color:var(--muted); font-size:18px; max-width:640px; margin:0 auto 28px; }
  .btn { display:inline-block; padding:12px 20px; border-radius:10px; background:var(--accent); color:#fff; text-decoration:none; font-weight:600; margin:4px; }
  .btn.secondary { background:transparent; color:var(--accent); border:1px solid var(--accent); }
  section { padding:48px 0; }
  section.soft { background:var(--soft); }
  h2 { font-size:26px; margin:0 0 24px; text-align:center; }
  .grid { display:grid; gap:16px; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); }
  .card { background:var(--bg); border:1px solid var(--line); border-radius:14px; padding:20px; }
  .card h3 { margin:0 0 6px; font-size:17px; }
  .card p { margin:0; color:var(--muted); font-size:15px; }
  .price { font-size:36px; font-weight:700; margin:8px 0 0; }
  .muted { color:var(--muted); font-size:14px; }
  .card ul { padding-left:18px; margin:14px 0 0; }
  .doc { max-width:760px; padding:48px 16px; }
  .doc h1 { font-size:32px; margin:0 0 4px; }
  .doc h2 { text-align:left; font-size:20px; margin:32px 0 8px; }
  footer { border-top:1px solid var(--line); padding:28px 0; font-size:14px; color:var(--muted); }
  footer .wrap { display:flex; justify-content:space-between; gap:16px; flex-wrap:wrap; }
  footer a { color:var(--muted); margin-right:14px; }
</style></head><body>
<header><div class="wrap">
  <a class="brand" href="/"><img src="/logo.svg" alt="">Paddle Pay</a>
  <nav><a href="/#features">Features</a><a href="/pricing">Pricing</a><a href="/docs">Docs</a><a href="/contact">Contact</a></nav>
</div></header>
${body}
<footer><div class="wrap">
  <div>© 2026 ${escapeHtml(b.name)}. ${PRODUCT} is an independent app and is not affiliated with Paddle.com.</div>
  <div><a href="/docs">Docs</a><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/refunds">Refunds</a><a href="/contact">Contact</a></div>
</div></footer>
</body></html>`;
}

function pricingCards() {
  return `<div class="grid">${PLANS.map((p) => `<div class="card">
    <h3>${p.name}</h3><div class="price">${p.price}</div><div class="muted">${p.period} · ${p.yearly}</div>
    <ul>${p.features.map((f) => `<li>${f}</li>`).join('')}</ul></div>`).join('')}</div>
  <p class="muted" style="text-align:center;margin-top:20px">14-day free trial. Prices in USD; sales tax or VAT is added at checkout where applicable.
  Payments are processed by Paddle.com, our Merchant of Record. Paddle's own transaction fees are charged to your Paddle account separately.</p>`;
}

siteRouter.get('/', (_req, res) => {
  res.send(layout(PRODUCT, `
<div class="hero wrap">
  <h1>Take payments in your CRM with Paddle</h1>
  <p>${PRODUCT} connects your own Paddle Billing account to your CRM's funnels, websites, stores, invoices and payment links. Paddle handles checkout, sales tax and VAT as Merchant of Record.</p>
  <a class="btn" href="/oauth/install">Install the app</a> <a class="btn secondary" href="/docs">Read the setup guide</a>
</div>
<section class="soft" id="features"><div class="wrap">
  <h2>What it does</h2>
  <div class="grid">
    <div class="card"><h3>Paddle checkout in your CRM</h3><p>Customers pay in Paddle's secure checkout, embedded in your order forms, store, invoices and payment links.</p></div>
    <div class="card"><h3>Subscriptions</h3><p>Recurring products become Paddle subscriptions, and renewals are reported back to your CRM.</p></div>
    <div class="card"><h3>Refunds from your CRM</h3><p>Full and partial refunds issued in your CRM are sent to Paddle automatically.</p></div>
    <div class="card"><h3>One-key setup</h3><p>Paste one Paddle API key. Webhooks, signing secrets and checkout tokens are created for you.</p></div>
  </div>
</div></section>
<section id="pricing"><div class="wrap"><h2>Pricing</h2>${pricingCards()}</div></section>
<section class="soft"><div class="wrap">
  <h2>Good to know</h2>
  <div class="grid">
    <div class="card"><h3>Your own Paddle account</h3><p>Each business connects its own Paddle account and must be approved by Paddle for what it sells.</p></div>
    <div class="card"><h3>What Paddle supports</h3><p>Paddle sells digital products, software and SaaS. Physical goods and many in-person services are not supported by Paddle.</p></div>
    <div class="card"><h3>Not supported</h3><p>One-click upsells and charging a saved card outside a subscription, because Paddle does not allow off-session card charges.</p></div>
  </div>
</div></section>`, { home: true }));
});

siteRouter.get('/pricing', (_req, res) => {
  res.send(layout(`Pricing · ${PRODUCT}`, `<section><div class="wrap"><h2>Pricing</h2>${pricingCards()}</div></section>`));
});

siteRouter.get('/contact', (_req, res) => {
  const b = config.business;
  res.send(layout(`Contact · ${PRODUCT}`, `<div class="wrap doc">
  <h1>Contact</h1>
  <p>${PRODUCT} is provided by <b>${escapeHtml(b.name)}</b>, ${escapeHtml(b.address)}.</p>
  ${b.email ? `<p>Email: <a href="mailto:${escapeHtml(b.email)}">${escapeHtml(b.email)}</a>. We reply within 2 business days.</p>` : ''}
  <p>For questions about a charge on your card, you can also contact Paddle, our Merchant of Record, at <a href="https://paddle.net">paddle.net</a>.</p>
</div>`));
});

siteRouter.get('/terms', (_req, res) => {
  const b = escapeHtml(config.business.name);
  res.send(layout(`Terms of Service · ${PRODUCT}`, `<div class="wrap doc">
  <h1>Terms of Service</h1><p class="muted">Last updated ${UPDATED}</p>
  <p>These terms govern your use of ${PRODUCT} (the "Service"), provided by ${b} ("we", "us"). By installing or using the Service you agree to them.</p>
  <h2>1. Merchant of Record</h2>
  <p>Our order process is conducted by our online reseller Paddle.com. Paddle.com is the Merchant of Record for all our orders. Paddle provides all customer service inquiries and handles returns for payments made for the Service.</p>
  <h2>2. The Service</h2>
  <p>The Service connects a CRM account to the customer's own Paddle Billing account so that payments taken in the CRM are processed by Paddle. You are responsible for your Paddle account, for being approved by Paddle, and for complying with Paddle's terms and your CRM provider's terms.
  We do not hold or move your customers' funds; payments go directly to your Paddle account.</p>
  <h2>3. Subscriptions and billing</h2>
  <p>The Service is billed monthly or yearly in advance at the prices shown on our <a href="/pricing">pricing page</a>, after any free trial. Subscriptions renew automatically until cancelled. You can cancel at any time; cancellation takes effect at the end of the current billing period.
  We may change prices with at least 30 days' notice before your next renewal.</p>
  <h2>4. Acceptable use</h2>
  <p>You must not use the Service to sell anything prohibited by Paddle's Acceptable Use Policy or by law, to process fraudulent payments, or to interfere with the Service or other users.</p>
  <h2>5. Availability and support</h2>
  <p>We aim to keep the Service available at all times but do not guarantee uninterrupted operation. The Service depends on your CRM provider and on Paddle, which we do not control.</p>
  <h2>6. Liability</h2>
  <p>To the extent permitted by law, the Service is provided "as is", and our total liability for any claim is limited to the fees you paid us in the 12 months before the claim. We are not liable for indirect or consequential losses, or for lost revenue caused by outages of your CRM provider or Paddle.</p>
  <h2>7. Termination</h2>
  <p>You can stop using the Service at any time by uninstalling it. We may suspend accounts that breach these terms. On uninstall we delete your stored Paddle credentials.</p>
  <h2>8. Changes and contact</h2>
  <p>We may update these terms and will post the new version on this page. Questions: ${contactLine()}.</p>
  <p>See also our <a href="/privacy">Privacy Policy</a> and <a href="/refunds">Refund Policy</a>.</p>
</div>`));
});

siteRouter.get('/privacy', (_req, res) => {
  const b = escapeHtml(config.business.name);
  res.send(layout(`Privacy Policy · ${PRODUCT}`, `<div class="wrap doc">
  <h1>Privacy Policy</h1><p class="muted">Last updated ${UPDATED}</p>
  <p>This policy explains how ${b} handles personal data when you use ${PRODUCT}.</p>
  <h2>Data we process</h2>
  <ul>
    <li><b>Account data:</b> your CRM account ID, user name and the access tokens your CRM issues when you install the app.</li>
    <li><b>Paddle credentials:</b> the Paddle API key you connect, stored encrypted (AES-256) and used only to operate the Service.</li>
    <li><b>Payment records:</b> transaction IDs, amounts, currencies, statuses and the contact ID and email needed to create a Paddle customer. We never see or store card numbers; card details are entered directly into Paddle's checkout.</li>
  </ul>
  <h2>How we use it</h2>
  <p>Only to provide the Service: creating Paddle transactions, keeping your CRM and Paddle in sync, processing refunds, showing your dashboard and providing support. We do not sell personal data or use it for advertising.</p>
  <h2>Who we share it with</h2>
  <p>Your CRM provider and Paddle (to process payments), and our hosting and database providers, who process data on our behalf. Paddle is the Merchant of Record for purchases of the Service and processes buyer data under its own privacy policy at <a href="https://www.paddle.com/legal/privacy">paddle.com/legal/privacy</a>.</p>
  <h2>Retention and deletion</h2>
  <p>When you uninstall the app we revoke the Paddle tokens we created and delete your stored credentials. Payment records are kept for as long as needed for accounting and dispute handling, and then deleted. You can ask us to delete your data at any time.</p>
  <h2>Your rights</h2>
  <p>You can request access to, correction of, or deletion of your personal data, or object to its processing, by contacting us.</p>
  <h2>Security</h2>
  <p>Data is transmitted over HTTPS, credentials are encrypted at rest, and webhooks are verified with signatures.</p>
  <h2>Contact</h2>
  <p>${contactLine()}</p>
</div>`));
});

siteRouter.get('/refunds', (_req, res) => {
  res.send(layout(`Refund Policy · ${PRODUCT}`, `<div class="wrap doc">
  <h1>Refund Policy</h1><p class="muted">Last updated ${UPDATED}</p>
  <p>Purchases of ${PRODUCT} are processed by Paddle.com, our Merchant of Record.</p>
  <h2>14-day money-back guarantee</h2>
  <p>If you are not satisfied, you can request a full refund within 14 days of your first payment, and within 14 days of a yearly renewal. No questions asked.</p>
  <h2>Monthly renewals</h2>
  <p>You can cancel at any time to stop future charges. Monthly renewals after the first 14 days are not refunded, but you keep access until the end of the period you paid for.</p>
  <h2>How to request a refund</h2>
  <p>Contact us (${contactLine()}) with your order number, or contact Paddle directly at <a href="https://paddle.net">paddle.net</a>. Approved refunds go back to the original payment method, usually within 5 to 10 business days.</p>
  <h2>Payments you take from your own customers</h2>
  <p>Refunds for products you sell through your own Paddle account are governed by your own refund policy and Paddle's terms, not this policy.</p>
</div>`));
});
