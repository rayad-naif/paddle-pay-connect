import { config } from './config';

export class VercelError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export interface DnsRecord {
  type: string;
  name: string;
  value: string;
}

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  if (!config.vercel.token) {
    console.error('Checkout domains need VERCEL_API_TOKEN (and VERCEL_TEAM_ID) to be set.');
    throw new VercelError(500, 'not_configured', 'Custom checkout domains are not available yet. Contact support.');
  }
  const url = new URL(`https://api.vercel.com${path}`);
  if (config.vercel.teamId) url.searchParams.set('teamId', config.vercel.teamId);
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${config.vercel.token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = json.error ?? {};
    throw new VercelError(res.status, err.code ?? 'unknown', err.message ?? `Vercel API error ${res.status}`);
  }
  return json as T;
}

const project = () => encodeURIComponent(config.vercel.projectId);

/** Adds the domain to the project. Adding a domain the project already has is not an error. */
export async function addDomain(name: string) {
  try {
    return await api('POST', `/v10/projects/${project()}/domains`, { name });
  } catch (e) {
    if (e instanceof VercelError && e.code === 'domain_already_in_use') {
      throw new VercelError(409, e.code, 'That domain is already connected to another website or hosting account. Remove it there first, then try again.');
    }
    if (e instanceof VercelError && e.code === 'domain_already_exists') return getDomain(name);
    throw e;
  }
}

export function getDomain(name: string) {
  return api<{ name: string; verified: boolean; verification?: { type: string; domain: string; value: string }[] }>(
    'GET',
    `/v9/projects/${project()}/domains/${encodeURIComponent(name)}`,
  );
}

export function verifyDomain(name: string) {
  return api('POST', `/v9/projects/${project()}/domains/${encodeURIComponent(name)}/verify`).catch(() => null);
}

export function domainConfig(name: string) {
  return api<{ misconfigured: boolean; recommendedCNAME?: { rank: number; value: string }[] }>(
    'GET',
    `/v6/domains/${encodeURIComponent(name)}/config`,
  );
}

export async function removeDomain(name: string) {
  await api('DELETE', `/v9/projects/${project()}/domains/${encodeURIComponent(name)}`).catch((e) => {
    if (!(e instanceof VercelError && e.status === 404)) throw e;
  });
}

/** The DNS records the merchant must create: a CNAME, plus a TXT if Vercel needs ownership proof. */
export async function requiredRecords(name: string): Promise<{ records: DnsRecord[]; verified: boolean; configured: boolean }> {
  const [domain, cfg] = await Promise.all([getDomain(name), domainConfig(name)]);
  const cname = [...(cfg.recommendedCNAME ?? [])].sort((a, b) => a.rank - b.rank)[0]?.value ?? 'cname.vercel-dns.com.';
  const records: DnsRecord[] = [{ type: 'CNAME', name, value: cname.replace(/\.$/, '') }];
  for (const v of domain.verification ?? []) records.push({ type: v.type, name: v.domain, value: v.value });
  return { records, verified: domain.verified, configured: !cfg.misconfigured };
}
