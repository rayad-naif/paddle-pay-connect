import { config } from '../config';
import { db } from '../db';
import { decrypt, encrypt } from '../lib/crypto';

export class GhlError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
  userType: 'Location' | 'Company';
  locationId?: string;
  companyId?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${config.ghl.apiBase}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: config.ghl.clientId, client_secret: config.ghl.clientSecret, ...params }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new GhlError(res.status, json.error_description ?? json.message ?? `OAuth error ${res.status}`);
  return json;
}

export function authorizeUrl(): string {
  const params = new URLSearchParams({
    response_type: 'code',
    redirect_uri: `${config.appUrl}/oauth/callback`,
    client_id: config.ghl.clientId,
    scope: config.ghl.scopes.join(' '),
  });
  return `https://marketplace.gohighlevel.com/oauth/chooselocation?${params}`;
}

export function exchangeCode(code: string) {
  return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: `${config.appUrl}/oauth/callback` });
}

export async function saveInstallation(token: TokenResponse, locationId: string) {
  const data = {
    companyId: token.companyId,
    accessTokenEnc: encrypt(token.access_token),
    refreshTokenEnc: encrypt(token.refresh_token),
    expiresAt: new Date(Date.now() + token.expires_in * 1000),
    scope: token.scope,
  };
  await db.installation.upsert({ where: { locationId }, create: { locationId, ...data }, update: data });
}

/** For agency (bulk) installs: swap the company token for one token per installed location. */
export async function installForCompany(token: TokenResponse): Promise<string[]> {
  const companyId = token.companyId!;
  const headers = { Authorization: `Bearer ${token.access_token}`, Version: config.ghl.apiVersion, Accept: 'application/json' };
  const appId = config.ghl.appId || config.ghl.clientId.split('-')[0];
  const listRes = await fetch(
    `${config.ghl.apiBase}/oauth/installedLocations?companyId=${companyId}&appId=${appId}&isInstalled=true`,
    { headers },
  );
  const list: any = await listRes.json();
  if (!listRes.ok) throw new GhlError(listRes.status, list.message ?? 'Could not list installed locations');

  const installed: string[] = [];
  for (const loc of list.locations ?? []) {
    const locationId = loc._id ?? loc.id;
    const res = await fetch(`${config.ghl.apiBase}/oauth/locationToken`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ companyId, locationId }),
    });
    const locToken: any = await res.json();
    if (!res.ok) {
      console.warn(`locationToken failed for ${locationId}`, locToken);
      continue;
    }
    await saveInstallation({ ...locToken, companyId }, locationId);
    installed.push(locationId);
  }
  return installed;
}

// Refreshes are serialized per location: GHL rotates the refresh token on every use.
const refreshing = new Map<string, Promise<string>>();

export async function getAccessToken(locationId: string): Promise<string> {
  const inst = await db.installation.findUnique({ where: { locationId } });
  if (!inst) throw new GhlError(404, `Location ${locationId} has not installed the app`);
  if (inst.expiresAt.getTime() - Date.now() > 5 * 60 * 1000) return decrypt(inst.accessTokenEnc);

  let pending = refreshing.get(locationId);
  if (!pending) {
    pending = (async () => {
      const token = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: decrypt(inst.refreshTokenEnc),
        user_type: 'Location',
      });
      await saveInstallation({ ...token, companyId: token.companyId ?? inst.companyId ?? undefined }, locationId);
      return token.access_token;
    })().finally(() => refreshing.delete(locationId));
    refreshing.set(locationId, pending);
  }
  return pending;
}

async function api<T = any>(locationId: string, method: string, path: string, body?: unknown): Promise<T> {
  const token = await getAccessToken(locationId);
  const res = await fetch(`${config.ghl.apiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Version: config.ghl.apiVersion,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new GhlError(res.status, json.message ?? `GHL API error ${res.status} on ${path}`);
  return json;
}

/** Registers this app as a custom payment provider for the location (once). */
export async function ensureProvider(locationId: string) {
  const inst = await db.installation.findUnique({ where: { locationId } });
  if (inst?.providerCreated) return;
  await api(locationId, 'POST', `/payments/custom-provider/provider?locationId=${locationId}`, {
    name: config.provider.name,
    description: config.provider.description,
    imageUrl: config.provider.imageUrl,
    paymentsUrl: `${config.appUrl}/checkout`,
    queryUrl: `${config.appUrl}/api/query`,
    supportsSubscriptionSchedule: false,
  });
  await db.installation.update({ where: { locationId }, data: { providerCreated: true } });
}

export function connectConfig(locationId: string, body: Record<string, { apiKey: string; publishableKey: string }>) {
  return api(locationId, 'POST', `/payments/custom-provider/connect?locationId=${locationId}`, body);
}

export function disconnectConfig(locationId: string, liveMode: boolean) {
  return api(locationId, 'POST', `/payments/custom-provider/disconnect?locationId=${locationId}`, { liveMode });
}

/** Reads a GHL price so recurring products can be mirrored as Paddle billing cycles. */
export async function getPrice(locationId: string, productId: string, priceId: string) {
  const json = await api(locationId, 'GET', `/products/${productId}/price/${priceId}?locationId=${locationId}`);
  return json.price ?? json;
}

/** Notifies GHL of payment / subscription events (backend.leadconnectorhq.com). */
export async function sendProviderEvent(payload: Record<string, unknown>) {
  const res = await fetch(config.ghl.providerWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ marketplaceAppId: config.ghl.appId || undefined, ...payload }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new GhlError(res.status, `GHL provider webhook rejected: ${res.status} ${text}`);
  }
}
