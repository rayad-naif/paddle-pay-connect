import { config } from '../config';
import { db } from '../db';
import { decrypt, encrypt } from '../lib/crypto';

export class GhlError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  userType?: 'Location' | 'Company';
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
  // Matches the "Install link" GHL shows for the app; version_id lets draft versions install.
  if (config.ghl.appId) params.set('version_id', config.ghl.appId);
  return `https://marketplace.gohighlevel.com/v2/oauth/chooselocation?${params}`;
}

export function exchangeCode(code: string) {
  return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: `${config.appUrl}/oauth/callback` });
}

function tokenData(token: TokenResponse) {
  return {
    accessTokenEnc: encrypt(token.access_token),
    // Location tokens minted from an agency token may come without a refresh token; those are
    // re-minted from the agency token when they expire.
    refreshTokenEnc: token.refresh_token ? encrypt(token.refresh_token) : '',
    expiresAt: new Date(Date.now() + Number(token.expires_in ?? 86_399) * 1000),
    scope: token.scope,
  };
}

export async function saveInstallation(token: TokenResponse, locationId: string, companyId?: string) {
  const data = { companyId: companyId ?? token.companyId, ...tokenData(token) };
  await db.installation.upsert({ where: { locationId }, create: { locationId, ...data }, update: data });
}

export async function saveCompany(token: TokenResponse, companyId: string) {
  const data = tokenData(token);
  await db.company.upsert({ where: { companyId }, create: { companyId, ...data }, update: data });
}

const appId = () => config.ghl.appId || config.ghl.clientId.split('-')[0];

// Refreshes are serialized per token: GHL rotates the refresh token on every use.
const refreshing = new Map<string, Promise<string>>();
function once(key: string, fn: () => Promise<string>) {
  let pending = refreshing.get(key);
  if (!pending) {
    pending = fn().finally(() => refreshing.delete(key));
    refreshing.set(key, pending);
  }
  return pending;
}
const fresh = (expiresAt: Date) => expiresAt.getTime() - Date.now() > 5 * 60 * 1000;

/** The agency (company) access token, refreshed when needed. */
export async function getCompanyToken(companyId: string): Promise<string> {
  const company = await db.company.findUnique({ where: { companyId } });
  if (!company) throw new GhlError(404, 'Paddle Pay is not installed at the company level for this account.');
  if (fresh(company.expiresAt)) return decrypt(company.accessTokenEnc);
  return once(`company:${companyId}`, async () => {
    const token = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(company.refreshTokenEnc), user_type: 'Company' });
    await saveCompany(token, companyId);
    return token.access_token;
  });
}

async function companyApi(companyId: string, method: string, path: string, form?: Record<string, string>) {
  const token = await getCompanyToken(companyId);
  const res = await fetch(`${config.ghl.apiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Version: config.ghl.apiVersion,
      Accept: 'application/json',
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const json: any = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, json };
}

/** Gets a location token from the agency token and stores it as that location's installation. */
export async function installLocationFromCompany(companyId: string, locationId: string) {
  let r = await companyApi(companyId, 'POST', '/oauth/locationToken', { companyId, locationId });
  // Newer API versions name the endpoint location-token.
  if (r.status === 404) r = await companyApi(companyId, 'POST', '/oauth/location-token', { companyId, locationId });
  if (!r.ok) throw new GhlError(r.status, r.json.message ?? r.json.error ?? `Could not get a token for location ${locationId}`);
  await saveInstallation(r.json, locationId, companyId);
}

/** Locations of the company where the app is installed (all pages). */
async function installedLocations(companyId: string): Promise<string[]> {
  const ids: string[] = [];
  for (let skip = 0; skip < 10_000; skip += 100) {
    const qs = new URLSearchParams({ companyId, appId: appId(), isInstalled: 'true', limit: '100', skip: String(skip) });
    const r = await companyApi(companyId, 'GET', `/oauth/installedLocations?${qs}`);
    if (!r.ok) throw new GhlError(r.status, r.json.message ?? 'Could not list the accounts the app is installed in');
    const page: any[] = r.json.locations ?? [];
    ids.push(...page.map((l) => l._id ?? l.id).filter(Boolean));
    if (page.length < 100) break;
  }
  return ids;
}

/**
 * Agency install: keep the company token (needed for locations added later), then set up every
 * location the app is already installed in. One failing location doesn't stop the others.
 */
export async function installForCompany(token: TokenResponse): Promise<{ installed: string[]; failed: string[] }> {
  const companyId = token.companyId!;
  await saveCompany(token, companyId);
  const installed: string[] = [];
  const failed: string[] = [];
  for (const locationId of await installedLocations(companyId)) {
    try {
      await installLocationFromCompany(companyId, locationId);
      installed.push(locationId);
    } catch (e: any) {
      console.warn(`Location token failed for ${locationId}`, e.message);
      failed.push(locationId);
    }
  }
  return { installed, failed };
}

export async function getAccessToken(locationId: string): Promise<string> {
  const inst = await db.installation.findUnique({ where: { locationId } });
  if (!inst) throw new GhlError(404, `Location ${locationId} has not installed the app`);
  if (fresh(inst.expiresAt)) return decrypt(inst.accessTokenEnc);

  return once(`location:${locationId}`, async () => {
    if (inst.refreshTokenEnc) {
      try {
        const token = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(inst.refreshTokenEnc), user_type: 'Location' });
        await saveInstallation(token, locationId, token.companyId ?? inst.companyId ?? undefined);
        return token.access_token;
      } catch (e) {
        if (!inst.companyId) throw e;
      }
    }
    // Installed through the agency: mint a new location token from the company token.
    if (!inst.companyId) throw new GhlError(401, 'The CRM access for this account expired. Install the app again.');
    await installLocationFromCompany(inst.companyId, locationId);
    const updated = await db.installation.findUniqueOrThrow({ where: { locationId } });
    return decrypt(updated.accessTokenEnc);
  });
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
  if (!res.ok) throw new GhlError(res.status, json.message ?? `CRM API error ${res.status} on ${path}`);
  return json;
}

/**
 * Registers this app as the location's custom payment provider so it appears in
 * Payments > Integrations. Runs on every install (force) because a reinstall needs it again.
 */
export async function ensureProvider(locationId: string, force = false) {
  const inst = await db.installation.findUnique({ where: { locationId } });
  if (inst?.providerCreated && !force) return;
  const domain = await db.checkoutDomain.findUnique({ where: { locationId } });
  await registerProvider(locationId, domain?.status === 'active' ? `https://${domain.hostname}` : config.appUrl);
  await db.installation.update({ where: { locationId }, data: { providerCreated: true } });
}

/**
 * Creates or updates the provider config. The checkout page (paymentsUrl) can live on the
 * merchant's own domain; the queryUrl always stays on the app's domain.
 */
export async function registerProvider(locationId: string, checkoutBase: string) {
  await api(locationId, 'POST', `/payments/custom-provider/provider?locationId=${locationId}`, {
    name: config.provider.name,
    description: config.provider.description,
    imageUrl: config.provider.imageUrl,
    paymentsUrl: `${checkoutBase}/checkout`,
    queryUrl: `${config.appUrl}/api/query`,
    supportsSubscriptionSchedule: false,
  });
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
    throw new GhlError(res.status, `CRM payment webhook rejected: ${res.status} ${text}`);
  }
}
