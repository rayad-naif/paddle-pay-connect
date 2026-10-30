# HighLevel × Paddle Payment Provider

A HighLevel (GHL) Marketplace **custom payment provider** that takes payments through **Paddle Billing**.
Each sub-account connects its **own** Paddle account by pasting one API key; the app creates the
client-side token, webhook destination and signing secret automatically.

## How it works

| Piece | Route | What it does |
|---|---|---|
| OAuth install | `GET /oauth/install`, `GET /oauth/callback` | Exchanges the code, stores tokens per location (handles agency bulk installs), registers the provider with `POST /payments/custom-provider/provider` |
| App webhooks | `POST /webhooks/app` | On `UNINSTALL`, revokes the Paddle token, deletes the Paddle webhook destination and wipes stored keys |
| Settings page | `GET /settings` + `/api/settings/*` | GHL custom page. Decrypts GHL SSO data, takes a Paddle API key, auto-detects sandbox/live, creates a client token + notification destination, then calls `POST /payments/custom-provider/connect` |
| Checkout iframe | `GET /checkout` + `POST /api/checkout/session` | Receives `payment_initiate_props`, creates a Paddle transaction with a non-catalog price for the exact amount, opens Paddle.js inline checkout, replies with `custom_element_success_response { chargeId }` |
| queryUrl | `POST /api/query` | `verify` (checks Paddle transaction status), `refund` (full or partial Paddle adjustment), `list_payment_methods`; `charge_payment` / `create_subscription` return "not supported" |
| Paddle webhooks | `POST /webhooks/paddle/:accountId` | Verifies `Paddle-Signature`, de-duplicates, forwards `payment.captured`, `subscription.active/trialing/updated/charged` to GHL |

Recurring GHL prices (when GHL sends a `subscriptionId`) are mirrored as a Paddle `billing_cycle`,
so Paddle creates and renews the subscription and renewals reach GHL as `subscription.charged`.

## Setup

### 1. Run the server
Requires Node.js 20+.

```bash
npm install
cp .env.example .env      # fill it in (see below)
npm run db:push
npm run dev
```

Expose it over HTTPS for development, e.g. `ngrok http 3000`, and set `APP_URL` to that URL.

Generate secrets:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Use one output for `ENCRYPTION_KEY` and another for `SESSION_SECRET`. **Never change
`ENCRYPTION_KEY` after go-live** — stored tokens and keys would become unreadable.

### 2. Create the HighLevel Marketplace app
In marketplace.gohighlevel.com → My Apps → Create App:
- **Category / type:** Payment Provider (Third-party provider). **Distribution:** Sub-account.
- **Scopes:** `payments/orders.readonly payments/orders.write payments/subscriptions.readonly payments/transactions.readonly payments/custom-provider.readonly payments/custom-provider.write products.readonly products/prices.readonly`
- **Redirect URL:** `{APP_URL}/oauth/callback`
- **Webhook URL:** `{APP_URL}/webhooks/app` (install/uninstall events are sent here automatically).
  GHL rejects any URL containing "ghl" or "highlevel", including the domain.
- **Custom page / settings URL:** `{APP_URL}/settings`
- Copy **Client ID**, **Client Secret** and **Shared Secret (SSO key)** into `.env`. Set `GHL_APP_ID`.
- Optional: put GHL's webhook public key in `GHL_WEBHOOK_PUBLIC_KEY` to verify `x-wh-signature`.

### 3. Install and connect
1. Open `{APP_URL}/oauth/install` (or the app's install link) and choose a sub-account.
2. In that sub-account: **Payments → Integrations → Paddle**, paste the Paddle API key (sandbox and/or live).
3. Click **Set as default**.

### What each merchant must do in Paddle
- Create an API key with: `customer.read/write`, `transaction.read/write`, `adjustment.read/write`,
  `subscription.read`, `payment_method.read`, `notification_setting.read/write`, `client_token.write`.
- Set a **default payment link** on an approved domain (Checkout → Checkout settings). Paddle
  requires this before it will create checkout transactions.
- Have their business and products approved by Paddle (Paddle is Merchant of Record and reviews
  what each seller sells).

## Testing (sandbox)
1. Connect a `pdl_sdbx_…` key, set GHL to test mode.
2. Buy something through a GHL funnel/invoice using Paddle's test card `4242 4242 4242 4242`, any future expiry, CVC `100`.
3. Check: the order is marked paid in GHL (via `verify`), then `payment.captured` arrives.
4. Refund from GHL (full and partial). Sandbox refunds are auto-approved roughly every 10 minutes.
5. Try a recurring product and confirm the subscription appears in both Paddle and GHL.

## Deploying to Vercel
1. Import the GitHub repo in Vercel (framework is detected as Express from `src/index.ts`).
2. In the project, **Storage → Prisma Postgres**, then connect it with the env var prefix `DATABASE`; it sets `DATABASE_URL` and `DATABASE_URL_POOLED`.
3. Add the remaining env vars from `.env.example` (Settings → Environment Variables), with `APP_URL` set to the production URL.
4. Deploy. The build runs `prisma db push`, which creates or updates the tables (it refuses changes that would lose data).
5. `/checkout` and `/settings` are served as static pages via `vercel.json`, which also allows framing (`frame-ancestors *`).

## Known limits / things to confirm against live GHL behaviour
- **Saved cards / off-session charges:** Paddle only charges saved methods inside subscriptions, so
  `addCardOnFileSupported` is `false` and `charge_payment` / `create_subscription` are declined.
- **GHL `Version` header:** set via `GHL_API_VERSION` (default `2021-07-28`). GHL's newer reference
  pages show `v3` for payments endpoints — change it if GHL rejects calls.
- **Subscription webhook fields:** GHL documents the event names but not the full subscription
  payload; this app sends `ghlSubscriptionId` and `subscriptionSnapshot`. Verify in GHL sandbox.
- **Connect config with only one mode:** GHL's docs mark both `live` and `test` as required; the app
  sends whichever modes are connected. If GHL rejects a single mode, connect both.
- **Paddle.js inside GHL's iframe:** the checkout page itself is nested in GHL's iframe. If a
  merchant's checkout fails to render, confirm the app domain is approved in their Paddle account.
