import { Router } from 'express';
import { config } from '../config';
import { escapeHtml } from './oauth';
import { contactLine, layout } from './site';

/** The full setup and help guide: Paddle account, CRM install, domains, testing, going live. */
export const docsRouter = Router();

const SECTIONS: [string, string][] = [
  ['quick', 'In short'],
  ['overview', 'How it works'],
  ['requirements', 'Before you start'],
  ['paddle-account', '1. Create your Paddle accounts'],
  ['install', '2. Install the app in your CRM'],
  ['api-keys', '3. Create Paddle API keys'],
  ['connect', '4. Connect Paddle'],
  ['domain', '5. Connect your checkout domain'],
  ['payment-link', '6. Set the default payment link'],
  ['website-approval', '7. Get your website approved'],
  ['default-provider', '8. Make Paddle Pay your payment provider'],
  ['test', '9. Test a payment'],
  ['go-live', '10. Go live'],
  ['selling', 'Selling: forms, funnels, store, invoices'],
  ['manage', 'Managing payments in the app'],
  ['where', 'Where payments work'],
  ['subscriptions', 'Subscriptions'],
  ['refunds', 'Refunds'],
  ['tax', 'Tax, receipts and payouts'],
  ['branding', 'Checkout branding'],
  ['dashboard', 'The dashboard'],
  ['troubleshooting', 'Troubleshooting'],
  ['disconnect', 'Disconnect or uninstall'],
  ['security', 'Security and data'],
  ['faq', 'FAQ'],
  ['support', 'Support'],
];

const PERMISSIONS: [string, string][] = [
  ['customer.read, customer.write', 'Finds or creates the Paddle customer for the buyer’s email.'],
  ['transaction.read, transaction.write', 'Creates the transaction for each order and checks whether it was paid.'],
  ['adjustment.read, adjustment.write', 'Sends full and partial refunds you issue in your CRM.'],
  ['subscription.read', 'Reads subscriptions created from recurring products.'],
  ['subscription.write (optional)', 'Cancel, pause and resume subscriptions from the dashboard.'],
  ['payment_method.read', 'Lists a customer’s saved cards for your CRM.'],
  ['notification_setting.read, notification_setting.write', 'Creates the webhook that tells the app when a payment completes.'],
  ['client_token.write', 'Creates the client-side token that opens Paddle checkout.'],
  ['checkout_domain.read (optional)', 'Shows your domain’s Paddle approval status in the dashboard.'],
  ['discount.read, discount.write (optional)', 'Create and archive discount codes from the dashboard.'],
  ['report.read, report.write (optional)', 'Export transactions to CSV from the dashboard.'],
  ['notification.read, notification.write (optional)', 'Show webhook deliveries and resend failed ones.'],
  ['customer_portal_session.write (optional)', 'Create customer portal links (customers update their card or cancel).'],
];

const ERRORS: [string, string][] = [
  ['Cannot create a transaction or open a checkout as no default payment link has been set for this account',
    'Paddle needs a default payment link before it opens any checkout. Set it in Paddle under Checkout → Checkout settings (step 6). Do this separately in sandbox and live.'],
  ['Transaction checkout creation is blocked for this vendor',
    'Your live Paddle account isn’t cleared to sell yet. Finish Paddle’s onboarding (business details, identity verification, payout details, website approval). If everything shows complete, contact Paddle support with this exact message. Only Paddle can lift it.'],
  ['Paddle checkout did not load',
    'Usually the domain checkout runs on isn’t approved in your Paddle account, or there’s no default payment link. Check steps 5 to 7.'],
  ['Payment failed / an error code in brackets',
    'The text before the brackets is Paddle’s own reason, and the code identifies it. Card declines come from the bank: ask the buyer to try another card. For anything else, send us the message and code.'],
  ['This Paddle API key is missing a permission (…)',
    'Edit the key in Paddle → Developer tools → Authentication, tick the permission named in the message (see step 3), save, and connect again.'],
  ['Paddle rejected this API key',
    'The key was copied incompletely, has expired, or was revoked. Create a new key and connect again.'],
  ['This field needs a sandbox/live key',
    'Sandbox keys start with pdl_sdbx_ and go in the Sandbox card; live keys start with pdl_live_ and go in the Live card.'],
  ['Open this page from inside your CRM',
    'The dashboard only works inside your CRM, because that’s how it knows which account you’re in. Open Payments → Integrations → Paddle Pay, or the Paddle Pay item in the account menu. If it still appears inside the CRM, reload the page.'],
  ['Paddle Pay is not installed for this account',
    'Install the app again from your CRM’s app marketplace and pick this account.'],
  ['Waiting for payment details from the checkout page',
    'The CRM didn’t send the order to the checkout. Reload the page and check that Paddle Pay is set as the default provider (step 8) in the same mode (test or live) you’re paying in.'],
  ['Paddle is not connected for this account',
    'No Paddle key is connected for the mode the CRM is in. Connect a sandbox key for test mode and a live key for live mode.'],
  ['Checkout domain stuck on “Waiting for DNS”',
    'Check that the CNAME record has exactly the name and value shown, with no extra dots. On Cloudflare, set it to DNS only (grey cloud). DNS can take up to an hour; the page re-checks every 20 seconds.'],
  ['Checkout domain stuck on “Securing with HTTPS”',
    'DNS is correct and the security certificate is being issued. This normally takes a few minutes. If it takes more than an hour, remove the domain and add it again.'],
  ['That domain is already connected to another website or hosting account',
    'Remove the subdomain from the other service first, or use a different subdomain such as checkout.yourbusiness.com.'],
  ['Payment went through but the order isn’t marked paid',
    'The app confirms payments through a webhook it created in Paddle (Developer tools → Notifications, named “Paddle Pay …”). Don’t delete or pause it. If it was removed, click Replace key in Connections and paste your key again, which recreates it.'],
  ['Refund shows “pending approval”',
    'Paddle reviews some refunds before approving them. In sandbox, refunds are approved automatically about every 10 minutes.'],
];

function toc() {
  return SECTIONS.map(([id, title]) => `<a href="#${id}">${escapeHtml(title)}</a>`).join('');
}

docsRouter.get('/docs', (_req, res) => {
  const app = escapeHtml(config.appUrl);
  const checkout = `${app}/checkout`;
  const body = `
<style>
  .docs { display:grid; gap:32px; padding:32px 16px 64px; }
  @media (min-width: 900px) { .docs { grid-template-columns: 230px minmax(0, 1fr); } .toc { position:sticky; top:16px; align-self:start; max-height:calc(100vh - 32px); overflow:auto; } }
  .toc { font-size:14px; display:flex; flex-direction:column; gap:2px; border-left:2px solid var(--line); padding-left:12px; }
  .toc a { color:var(--muted); text-decoration:none; padding:3px 0; }
  .toc a:hover { color:var(--accent); }
  .content { min-width:0; max-width:760px; }
  .content h1 { font-size:34px; margin:0 0 8px; }
  .content h2 { text-align:left; font-size:22px; margin:44px 0 10px; padding-top:8px; border-top:1px solid var(--line); scroll-margin-top:16px; }
  .content h3 { font-size:16px; margin:22px 0 6px; }
  .content li { margin:6px 0; }
  .content code { background:var(--soft); border:1px solid var(--line); padding:1px 6px; border-radius:5px; font-size:13px; word-break:break-word; }
  .note { background:var(--accent-soft); border-radius:10px; padding:12px 14px; margin:14px 0; font-size:15px; }
  .warn { background:#fef3c7; color:#78350f; border-radius:10px; padding:12px 14px; margin:14px 0; font-size:15px; }
  .table-wrap { overflow-x:auto; }
  table { width:100%; border-collapse:collapse; font-size:14px; margin:10px 0; }
  th, td { text-align:left; padding:9px 8px; border-top:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:600; border-top:0; }
  dt { font-weight:600; margin-top:16px; }
  dd { margin:4px 0 0; color:var(--text); }
</style>
<div class="wrap docs">
  <nav class="toc" aria-label="Contents">${toc()}</nav>
  <article class="content">
  <h1>Paddle Pay setup guide</h1>
  <p class="muted">Everything from creating your Paddle account to taking your first live payment. Follow the numbered steps in order.</p>

  <h2 id="quick">In short</h2>
  <ol>
    <li>Connect your Paddle sandbox and live API keys in the Paddle Pay dashboard (<b>Connections</b>).</li>
    <li>Connect your checkout subdomain (<b>Checkout domain</b>) and set the default payment link and website approval in Paddle.</li>
    <li>In your CRM, set <b>Paddle Pay</b> as the default payment provider (<b>Payments → Integrations</b>).</li>
    <li>Sell as usual: create products in your CRM and add them to an order form, a form’s product/payment element, your store, an invoice or a payment link. Paddle’s checkout opens automatically.</li>
    <li>Manage everything (payments, refunds, invoices, subscriptions, customers, discount codes, exports) from the Paddle Pay dashboard.</li>
  </ol>

  <h2 id="overview">How it works</h2>
  <p>Paddle Pay connects your CRM to your own Paddle Billing account. When a customer pays in a funnel, website, store, invoice or payment link:</p>
  <ol>
    <li>Your CRM opens the Paddle Pay checkout, which loads Paddle’s secure card form and an order summary.</li>
    <li>Paddle charges the customer as <b>Merchant of Record</b>: it calculates and collects sales tax or VAT, sends the receipt and handles the payment.</li>
    <li>Paddle Pay confirms the payment and your CRM marks the order paid. Money is paid out to you by Paddle.</li>
  </ol>
  <p>Each CRM account connects its own Paddle account. Paddle Pay never holds your money.</p>

  <h2 id="requirements">Before you start</h2>
  <ul>
    <li><b>A CRM account</b> where you can install apps and manage payments.</li>
    <li><b>A Paddle account.</b> Sandbox, for testing, is instant. Live needs Paddle’s approval, which can take a few days.</li>
    <li><b>Your own website and domain</b> (for example <code>yourbusiness.com</code>) where you can add DNS records. Paddle only opens live checkout on a website it has approved for you.</li>
    <li><b>Something Paddle allows you to sell.</b> Paddle supports digital products, software, SaaS, online courses and similar. It does not support physical goods or most in-person services. Check Paddle’s Acceptable Use Policy before you start.</li>
  </ul>

  <h2 id="paddle-account">1. Create your Paddle accounts</h2>
  <p>Paddle has two separate environments, each with its own login, settings and API keys:</p>
  <ul>
    <li><b>Sandbox</b> at <code>sandbox-vendors.paddle.com</code>: test payments with test cards. No approval needed.</li>
    <li><b>Live</b> at <code>vendors.paddle.com</code>: real payments.</li>
  </ul>
  <h3>Live account onboarding</h3>
  <p>In your live Paddle account, finish every onboarding step Paddle shows you:</p>
  <ol>
    <li><b>Business details:</b> legal business name, address and what you sell. The legal name must match the name on your website’s terms.</li>
    <li><b>Identity verification</b> for the business owner.</li>
    <li><b>Payout details:</b> the bank account Paddle pays you into.</li>
    <li><b>Website approval:</b> covered in step 7.</li>
  </ol>
  <div class="warn">Until Paddle finishes reviewing your live account, live checkouts fail with “Transaction checkout creation is blocked for this vendor”. That’s normal. Use sandbox in the meantime.</div>

  <h2 id="install">2. Install the app in your CRM</h2>
  <ol>
    <li>Open your CRM’s <b>app marketplace</b>, find <b>Paddle Pay</b> and click <b>Install</b>, or use <a href="/oauth/install">this install link</a>.</li>
    <li>Choose the account (or accounts) to install it in and approve the permissions. The app needs to read your products and prices, and to manage payment integrations, orders and transactions.</li>
    <li>You’ll see an “Installed” confirmation. Paddle Pay now appears under <b>Payments → Integrations</b>, and as a <b>Paddle Pay</b> item in the account menu that opens the dashboard.</li>
  </ol>

  <h2 id="api-keys">3. Create Paddle API keys</h2>
  <p>Create one key in <b>sandbox</b> and another in <b>live</b>. Do the same steps in each:</p>
  <ol>
    <li>In Paddle, go to <b>Developer tools → Authentication</b>, open <b>API keys</b> and click <b>New API key</b>.</li>
    <li>Name it <code>Paddle Pay</code> and give it these permissions:</li>
  </ol>
  <div class="table-wrap"><table><thead><tr><th>Permission</th><th>Why it’s needed</th></tr></thead><tbody>
    ${PERMISSIONS.map(([perm, why]) => `<tr><td><code>${escapeHtml(perm)}</code></td><td>${escapeHtml(why)}</td></tr>`).join('')}
  </tbody></table></div>
  <ol start="3">
    <li>Save and copy the key straight away. Paddle only shows it once. Sandbox keys start with <code>pdl_sdbx_</code>, live keys with <code>pdl_live_</code>.</li>
    <li>If you set an expiry date, note it: when the key expires, payments stop until you connect a new one.</li>
  </ol>
  <div class="note">Treat API keys like passwords. Paddle Pay stores them encrypted and never shows them again.</div>

  <h2 id="connect">4. Connect Paddle</h2>
  <ol>
    <li>Open the Paddle Pay dashboard from your CRM (the Paddle Pay menu item, or <b>Payments → Integrations → Paddle Pay</b>).</li>
    <li>Go to <b>Connections</b>. Paste the sandbox key into <b>Sandbox</b> and click <b>Connect</b>. Then do the same with the live key in <b>Live</b>.</li>
  </ol>
  <p>When you connect, Paddle Pay checks the key’s permissions and creates three things in your Paddle account automatically:</p>
  <ul>
    <li>a <b>client-side token</b> that opens checkout;</li>
    <li>a <b>notification destination</b> (webhook) named <code>Paddle Pay …</code> that reports completed payments, subscriptions and refunds;</li>
    <li>the webhook’s <b>signing secret</b>, so the app can verify messages really come from Paddle.</li>
  </ul>
  <div class="warn">Don’t delete or pause the “Paddle Pay” token or notification destination in Paddle. If you do, orders won’t be marked paid. Clicking <b>Replace key</b> recreates them.</div>

  <h2 id="domain">5. Connect your checkout domain</h2>
  <p>Paddle only opens live checkout on a domain approved in <b>your</b> Paddle account, so checkout needs to run on a subdomain of your own website. Pick one that isn’t used for anything else, for example <code>pay.yourbusiness.com</code>.</p>
  <ol>
    <li>In the dashboard, open <b>Checkout domain</b>.</li>
    <li>Enter the subdomain, plus your main website address (any other page on the subdomain redirects there). Click <b>Connect domain</b>.</li>
    <li>The dashboard shows a <b>CNAME</b> record, and sometimes a <b>TXT</b> record. Add them where your domain’s DNS is managed:
      <ul>
        <li><b>Name / Host:</b> some providers want the full name (<code>pay.yourbusiness.com</code>), others only the first part (<code>pay</code>). GoDaddy and Namecheap use the short form.</li>
        <li><b>Value / Points to:</b> copy it exactly with the Copy button.</li>
        <li><b>Cloudflare:</b> set the record to <b>DNS only</b> (grey cloud), not Proxied.</li>
        <li><b>TTL:</b> leave the default.</li>
      </ul>
    </li>
    <li>Wait. The status changes from <b>Waiting for DNS</b> to <b>Securing with HTTPS</b> to <b>Active</b>, usually within minutes and occasionally up to an hour. You can click <b>Check now</b> at any time.</li>
  </ol>
  <p>Once it’s <b>Active</b>, your CRM’s checkout loads from your subdomain automatically.</p>
  <div class="note">Only this subdomain needs Paddle approval. Your CRM’s own invoice, payment-link and form domains, and your funnel and website domains, don’t need approval: Paddle checkout runs inside the frame served from your checkout subdomain, and that’s the domain Paddle checks.</div>

  <h2 id="payment-link">6. Set the default payment link</h2>
  <p>Paddle refuses to create checkouts until a default payment link is set. In <b>both</b> sandbox and live Paddle:</p>
  <ol>
    <li>Go to <b>Checkout → Checkout settings</b>.</li>
    <li>Set <b>Default payment link</b> to your checkout domain’s link, shown in the dashboard with a Copy button: <code>https://pay.yourbusiness.com/checkout</code>.</li>
    <li>Save.</li>
  </ol>
  <p>Paddle uses this link in emails it sends (for example to retry a failed payment), and Paddle Pay opens those links correctly. In sandbox you can use <code>${checkout}</code> until your own domain is ready, because sandbox accepts any domain.</p>

  <h2 id="website-approval">7. Get your website approved</h2>
  <p>In <b>live</b> Paddle, open <b>Website approval</b> (under Checkout, or Settings in newer dashboards). Submit your checkout subdomain, for example <code>pay.yourbusiness.com</code>. Paddle approves each exact host, so submit the subdomain itself even if your main domain is already approved. Sandbox approves domains automatically.</p>
  <h3>What Paddle reviews</h3>
  <p>Paddle looks at your main website. Before you submit, make sure it has:</p>
  <ul>
    <li>A clear description of <b>what you sell</b>, with <b>prices</b> visible.</li>
    <li><b>Terms and conditions</b> that name your legal business name, matching your Paddle account, and say that Paddle is the Merchant of Record. Paddle’s suggested wording: “Our order process is conducted by our online reseller Paddle.com. Paddle.com is the Merchant of Record for all our orders. Paddle provides all customer service inquiries and handles returns.”</li>
    <li>A <b>privacy policy</b>.</li>
    <li>A <b>refund policy</b> that’s easy to find. Many Paddle sellers offer at least 14 days.</li>
    <li><b>Contact details</b>: at least a support email.</li>
    <li>A working site: no “coming soon” pages or placeholder text, and links to the terms, privacy and refund pages, usually in the footer.</li>
  </ul>
  <p>Review usually takes a few days. The dashboard’s Checkout domain tab shows the status (Pending review, Approved, Rejected or Action required) if your API key has <code>checkout_domain.read</code>. If Paddle rejects it, its email says what to change. Fix that and resubmit.</p>

  <h2 id="default-provider">8. Make Paddle Pay your payment provider</h2>
  <ol>
    <li>In your CRM, open <b>Payments → Integrations</b>.</li>
    <li>Find <b>Paddle Pay</b> and click <b>Set as default</b>.</li>
    <li>Your CRM has a test mode and a live mode for payments. Test mode uses your sandbox key; live mode uses your live key. Make sure the matching key is connected.</li>
  </ol>

  <h2 id="test">9. Test a payment</h2>
  <ol>
    <li>Switch your CRM’s payments to <b>test mode</b>.</li>
    <li>Open one of your order forms, invoices or payment links and pay with a Paddle test card:
      <ul>
        <li>Successful payment: <code>4242 4242 4242 4242</code></li>
        <li>3D Secure challenge: <code>4000 0038 0000 0446</code></li>
        <li>Declined: <code>4000 0000 0000 0002</code></li>
      </ul>
      Use any future expiry date, CVC <code>100</code> and any name. Paddle’s developer docs list more test cards.</li>
    <li>Check that the order shows as paid in your CRM and as <b>Paid</b> under Recent payments in the dashboard.</li>
    <li>Test a refund from your CRM, and a recurring product if you sell subscriptions.</li>
  </ol>

  <h2 id="go-live">10. Go live</h2>
  <ul>
    <li>☐ Live Paddle onboarding complete (no “blocked for this vendor” error).</li>
    <li>☐ Live API key connected in <b>Connections</b>.</li>
    <li>☐ Checkout domain <b>Active</b>, and approved in live Paddle.</li>
    <li>☐ Live default payment link set to your checkout domain.</li>
    <li>☐ Paddle Pay set as default in <b>Payments → Integrations</b>.</li>
    <li>☐ Your CRM’s payments switched to <b>live mode</b>.</li>
    <li>☐ One small real purchase made, then refunded.</li>
  </ul>

  <h2 id="selling">Selling: forms, funnels, store, invoices</h2>
  <p>Paddle Pay doesn’t add its own buttons. It powers the payment step of whatever you already sell with in your CRM. Every sale starts from a <b>product</b>:</p>
  <ol>
    <li><b>Create the product</b> in your CRM (<b>Payments → Products</b>): name, price and currency. For a subscription choose a recurring price (daily, weekly, monthly or yearly) and, optionally, trial days.</li>
    <li><b>Add it where customers buy</b>:
      <ul>
        <li><b>Funnels and websites:</b> on an order form step, add the product to the step’s products, and keep the order form element (with its payment section) on the page.</li>
        <li><b>Forms:</b> add the <b>product / payment element</b> (the “sell product” element) to the form and pick the products it sells. When the form is submitted, the payment step opens Paddle checkout.</li>
        <li><b>Store:</b> products added to your store use the store’s checkout, which uses Paddle Pay.</li>
        <li><b>Invoices and text-to-pay:</b> create the invoice as usual. The customer’s “Pay” button opens Paddle checkout.</li>
        <li><b>Payment links:</b> create a payment link for the product and share it.</li>
      </ul>
    </li>
    <li><b>Publish</b> and make a test purchase in test mode (step 9).</li>
  </ol>
  <div class="note">The amount and currency always come from your CRM product. Paddle adds sales tax or VAT for the buyer’s location, and the order summary next to the card form shows it.</div>

  <h2 id="manage">Managing payments in the app</h2>
  <p>You don’t need to open Paddle for day-to-day work. Every tab has a <b>Live / Sandbox</b> switch.</p>
  <dl>
    <dt>Transactions</dt><dd>Every payment, searchable by customer email, name or ID and filterable by status. Open one to see items, tax, Paddle’s fee and your earnings, <b>download the invoice PDF</b>, see past refunds, and <b>issue a full or partial refund</b>. <b>Export CSV</b> creates a spreadsheet of transactions for any date range.</dd>
    <dt>Subscriptions</dt><dd>All subscriptions with their status and next payment date. Open one to <b>cancel at period end</b>, <b>cancel now</b>, undo a pending cancellation, <b>pause</b> or <b>resume</b>, or see its payments.</dd>
    <dt>Customers</dt><dd>Search customers and see each one’s total paid, subscriptions and payments. <b>Customer portal link</b> copies a secure link you can send so the customer can update their card or manage their subscription.</dd>
    <dt>Discounts</dt><dd>Create discount codes (percentage or fixed amount, usage limit, expiry, optionally applied to renewals), archive or restore them, and switch the <b>discount code field</b> in checkout on or off.</dd>
    <dt>Connections → Webhook deliveries</dt><dd>See the messages Paddle sent to the app and <b>send failed ones again</b>. Useful if an order wasn’t marked paid.</dd>
  </dl>
  <p>Some things can only be done in Paddle’s dashboard, because Paddle has no API for them: the default payment link and checkout branding, website approval, business and identity verification, payout bank details, and turning on payment methods such as PayPal or Apple Pay.</p>
  <p class="muted">The management features use the optional API key permissions marked in step 3. If one is missing, the dashboard tells you which permission to add.</p>

  <h2 id="where">Where payments work</h2>
  <div class="table-wrap"><table><thead><tr><th>Works</th><th>Doesn’t work</th></tr></thead><tbody><tr><td>
    <ul><li>Funnel and website order forms, including order bumps</li><li>Store checkout</li><li>Invoices, including text-to-pay links</li><li>Payment links</li><li>One-time and recurring products</li><li>Full and partial refunds from the CRM</li></ul>
  </td><td>
    <ul><li>One-click upsells after checkout</li><li>Charging a saved card from a contact’s record</li><li>Saving a card without a payment</li><li>Physical products, and services Paddle doesn’t allow</li></ul>
    <p class="muted">The unsupported payment types all charge a card without the customer present. Paddle only allows that inside subscriptions.</p>
  </td></tr></tbody></table></div>

  <h2 id="subscriptions">Subscriptions</h2>
  <ul>
    <li>When a customer buys a recurring product, Paddle Pay creates a Paddle subscription with the same interval (daily, weekly, monthly or yearly) and any free trial days.</li>
    <li>Paddle charges each renewal automatically, and each renewal is reported back to your CRM.</li>
    <li>Paddle emails customers a link to manage their subscription: update their card or cancel. You can cancel, pause or resume subscriptions, or send a customer portal link, from <b>Subscriptions</b> in the Paddle Pay dashboard.</li>
  </ul>

  <h2 id="refunds">Refunds</h2>
  <ul>
    <li>Issue refunds from the order or transaction in your CRM, or from <b>Transactions</b> in the Paddle Pay dashboard, either full or partial. Paddle Pay sends them to Paddle.</li>
    <li>Paddle may hold a refund for approval first. It then shows as pending until Paddle approves it. Sandbox refunds are approved automatically about every 10 minutes.</li>
    <li>The money goes back to the customer’s original payment method, usually within 5 to 10 business days.</li>
  </ul>

  <h2 id="tax">Tax, receipts and payouts</h2>
  <ul>
    <li>Paddle is the Merchant of Record. It calculates, collects and pays sales tax and VAT for each buyer’s country, so you don’t have to register for tax in each country.</li>
    <li>The checkout shows tax in the order summary once Paddle knows the buyer’s location. Whether your prices include or exclude tax is set in Paddle.</li>
    <li>Paddle emails buyers their receipt or invoice, and statements show Paddle as the seller.</li>
    <li>Paddle pays your earnings, minus its fees, to the payout account you set up. See your balance and payouts in Paddle.</li>
  </ul>

  <h2 id="branding">Checkout branding</h2>
  <p>The card form’s colours, logo and style come from your Paddle account. Set them under <b>Checkout → Checkout settings</b>, in both sandbox and live. The business name shown (“Provided by …”) is your Paddle business name. The order summary next to the form comes from your CRM product names and prices.</p>

  <h2 id="dashboard">The dashboard</h2>
  <dl>
    <dt>Overview</dt><dd>Live revenue and sandbox volume for the last 30 days, subscriptions started, connection status, a setup checklist and your latest payments.</dd>
    <dt>Payment statuses</dt><dd><b>Paid</b>: completed. <b>Awaiting payment</b>: checkout was opened but not paid. These are abandoned or still-open checkouts, and nobody was charged. <b>Past due</b>: a subscription renewal failed. <b>Canceled</b>: the transaction was cancelled.</dd>
    <dt>Transactions, Subscriptions, Customers, Discounts</dt><dd>See <a href="#manage">Managing payments in the app</a>.</dd>
    <dt>Connections</dt><dd>Connect, replace or disconnect your sandbox and live Paddle keys, and see webhook deliveries.</dd>
    <dt>Checkout domain</dt><dd>Connect your own checkout subdomain, see its DNS records and its Paddle approval status.</dd>
    <dt>Setup guide</dt><dd>A short version of this guide.</dd>
  </dl>

  <h2 id="troubleshooting">Troubleshooting</h2>
  <p>Find the message you see:</p>
  <dl>
    ${ERRORS.map(([msg, fix]) => `<dt>${escapeHtml(msg)}</dt><dd>${escapeHtml(fix)}</dd>`).join('')}
  </dl>

  <h2 id="disconnect">Disconnect or uninstall</h2>
  <ul>
    <li><b>Disconnect</b> (in Connections) stops payments in that mode. It revokes the token and deletes the webhook that Paddle Pay created in your Paddle account.</li>
    <li><b>Remove domain</b> sends checkout back to the app’s own domain. You can then delete the DNS record.</li>
    <li><b>Uninstalling</b> the app from your CRM does all of the above for that account and deletes your stored keys. Your Paddle account, customers, transactions and subscriptions stay in Paddle.</li>
  </ul>

  <h2 id="security">Security and data</h2>
  <ul>
    <li>Card details are entered directly into Paddle’s secure form. Paddle Pay never sees or stores card numbers.</li>
    <li>API keys and webhook secrets are encrypted at rest (AES-256). Every webhook from Paddle is checked against its signature.</li>
    <li>See the <a href="/privacy">Privacy Policy</a> for exactly what is stored and for how long.</li>
  </ul>

  <h2 id="faq">FAQ</h2>
  <dl>
    <dt>Can I use one Paddle account for several CRM accounts?</dt><dd>Yes. Connect the same Paddle keys in each account. Each account gets its own token and webhook in Paddle. Each account’s checkout domain must also be approved in that Paddle account.</dd>
    <dt>Do I need a checkout domain for sandbox?</dt><dd>No. Sandbox works on the app’s own domain. You need your own domain for live.</dd>
    <dt>Which currencies are supported?</dt><dd>Any currency Paddle supports for your account. The checkout charges the currency set on the CRM product.</dd>
    <dt>Can customers use PayPal, Apple Pay or Google Pay?</dt><dd>Yes, if they’re turned on in your Paddle account. Apple Pay also requires Paddle to verify your checkout domain for Apple Pay.</dd>
    <dt>What does it cost?</dt><dd>A one-time payment of $997 for lifetime access, with a 14-day money-back guarantee. See <a href="/pricing">pricing</a>. Paddle charges its own fees per transaction, separately.</dd>
  </dl>

  <h2 id="support">Support</h2>
  <p>Still stuck? Contact us with the exact error message and, if you can, a screenshot: ${contactLine()}.</p>
  </article>
</div>`;
  res.send(layout('Setup guide · Paddle Pay', body));
});
