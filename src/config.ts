import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

export const config = {
  appUrl: required('APP_URL').replace(/\/$/, ''),
  port: Number(process.env.PORT ?? 3000),
  encryptionKey: required('ENCRYPTION_KEY'),
  sessionSecret: required('SESSION_SECRET'),
  ghl: {
    clientId: required('GHL_CLIENT_ID'),
    clientSecret: required('GHL_CLIENT_SECRET'),
    ssoKey: required('GHL_SSO_KEY'),
    appId: process.env.GHL_APP_ID ?? '',
    apiBase: (process.env.GHL_API_BASE ?? 'https://services.leadconnectorhq.com').replace(/\/$/, ''),
    apiVersion: process.env.GHL_API_VERSION ?? '2021-07-28',
    webhookPublicKey: process.env.GHL_WEBHOOK_PUBLIC_KEY?.replace(/\\n/g, '\n') || undefined,
    providerWebhookUrl: 'https://backend.leadconnectorhq.com/payments/custom-provider/webhook',
    scopes: [
      'payments/orders.readonly',
      'payments/orders.write',
      'payments/subscriptions.readonly',
      'payments/transactions.readonly',
      'payments/custom-provider.readonly',
      'payments/custom-provider.write',
      'products.readonly',
      'products/prices.readonly',
    ],
  },
  // Shown on the public website and legal pages (Paddle reviews these before approving a domain).
  business: {
    name: process.env.BUSINESS_NAME ?? 'IR Solutions',
    address: process.env.BUSINESS_ADDRESS ?? 'Muzaffargarh, Punjab, Pakistan',
    email: process.env.SUPPORT_EMAIL ?? '',
  },
  // Lets merchants serve checkout from their own subdomain (added to this Vercel project).
  vercel: {
    token: process.env.VERCEL_API_TOKEN ?? '',
    projectId: process.env.VERCEL_PROJECT_ID_OR_NAME ?? 'paddle-pay-connect',
    teamId: process.env.VERCEL_TEAM_ID ?? '',
  },
  provider: {
    name: process.env.PROVIDER_NAME ?? 'Paddle',
    description: process.env.PROVIDER_DESCRIPTION ?? 'Accept payments with Paddle',
    imageUrl: process.env.PROVIDER_IMAGE_URL ?? '',
  },
};

export type Mode = 'test' | 'live';
