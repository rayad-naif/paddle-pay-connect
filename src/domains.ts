import type { CheckoutDomain } from '@prisma/client';
import { config } from './config';
import { db } from './db';
import * as ghl from './ghl/client';
import { UserError, paddleFor } from './paddle/accounts';
import * as vercel from './vercel';

const appHost = new URL(config.appUrl).hostname;

/** True for hosts that serve the app itself (production, previews, local dev). */
export function isAppHost(host: string) {
  return host === appHost || host.endsWith('.vercel.app') || host === 'localhost' || host === '127.0.0.1';
}

export function normalizeHostname(input: string): string {
  const host = input.trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0].replace(/\.$/, '');
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) {
    throw new UserError('Enter a domain like pay.yourbusiness.com.');
  }
  if (host.split('.').length < 3) {
    throw new UserError('Use a subdomain such as pay.yourbusiness.com, so your main website stays where it is.');
  }
  if (isAppHost(host)) throw new UserError('Use a domain that belongs to your business.');
  return host;
}

function normalizeWebsite(input: unknown, hostname: string): string {
  const raw = String(input ?? '').trim();
  const url = raw ? (/^https?:\/\//.test(raw) ? raw : `https://${raw}`) : `https://${hostname.split('.').slice(1).join('.')}`;
  try {
    return new URL(url).toString();
  } catch {
    throw new UserError('Enter a valid website address, like https://yourbusiness.com.');
  }
}

/** Paddle's review status for the domain, per connected mode. */
type PaddleApproval = 'approved' | 'pending_review' | 'in_review' | 'rejected' | 'action_required' | 'not_submitted' | 'unknown';

export interface DomainState {
  hostname: string;
  websiteUrl: string | null;
  status: string;
  records: vercel.DnsRecord[];
  paymentLink: string;
  paddle: { test?: PaddleApproval; live?: PaddleApproval };
}

/** Reads the domain's approval status from each connected Paddle account (checkout domains API). */
async function paddleApproval(locationId: string, hostname: string): Promise<DomainState['paddle']> {
  const accounts = await db.paddleAccount.findMany({ where: { locationId } });
  const result: DomainState['paddle'] = {};
  await Promise.all(
    accounts.map(async (a) => {
      const domains = await paddleFor(a).listCheckoutDomains().catch(() => null);
      const match = domains?.find((d) => d.domain === hostname || d.domain === `www.${hostname}`);
      result[a.mode as 'test' | 'live'] = domains === null ? 'unknown' : ((match?.status as PaddleApproval) ?? 'not_submitted');
    }),
  );
  return result;
}

async function probe(hostname: string): Promise<boolean> {
  try {
    const res = await fetch(`https://${hostname}/health`, { signal: AbortSignal.timeout(6000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Re-checks DNS and HTTPS; switches HighLevel's checkout to the domain once it works. */
export async function checkDomain(domain: CheckoutDomain): Promise<DomainState> {
  let { records, verified, configured } = await vercel.requiredRecords(domain.hostname);
  if (!verified) {
    await vercel.verifyDomain(domain.hostname);
    ({ records, verified, configured } = await vercel.requiredRecords(domain.hostname));
  }

  let status = 'pending_dns';
  if (verified && configured) status = (await probe(domain.hostname)) ? 'active' : 'issuing_certificate';

  if (status !== domain.status) {
    if (status === 'active') await ghl.registerProvider(domain.locationId, `https://${domain.hostname}`);
    if (domain.status === 'active') await ghl.registerProvider(domain.locationId, config.appUrl);
    domain = await db.checkoutDomain.update({ where: { locationId: domain.locationId }, data: { status } });
  }
  return await toState(domain, records);
}

async function toState(domain: CheckoutDomain, records: vercel.DnsRecord[]): Promise<DomainState> {
  return {
    paddle: domain.status === 'active' ? await paddleApproval(domain.locationId, domain.hostname) : {},
    hostname: domain.hostname,
    websiteUrl: domain.websiteUrl,
    status: domain.status,
    records,
    paymentLink: `https://${domain.hostname}/checkout`,
  };
}

export async function getDomainState(locationId: string): Promise<DomainState | null> {
  const domain = await db.checkoutDomain.findUnique({ where: { locationId } });
  if (!domain) return null;
  if (domain.status === 'active') return await toState(domain, []);
  return checkDomain(domain);
}

export async function setDomain(locationId: string, rawHost: string, rawWebsite: unknown): Promise<DomainState> {
  const hostname = normalizeHostname(rawHost);
  const websiteUrl = normalizeWebsite(rawWebsite, hostname);
  const taken = await db.checkoutDomain.findUnique({ where: { hostname } });
  if (taken && taken.locationId !== locationId) throw new UserError('That domain is already used by another sub-account.');

  const previous = await db.checkoutDomain.findUnique({ where: { locationId } });
  if (previous && previous.hostname !== hostname) await removeDomain(locationId);

  try {
    await vercel.addDomain(hostname);
  } catch (e) {
    if (e instanceof vercel.VercelError) throw new UserError(e.message);
    throw e;
  }
  const domain = await db.checkoutDomain.upsert({
    where: { locationId },
    create: { locationId, hostname, websiteUrl },
    update: { hostname, websiteUrl },
  });
  return checkDomain(domain);
}

export async function removeDomain(locationId: string) {
  const domain = await db.checkoutDomain.findUnique({ where: { locationId } });
  if (!domain) return;
  if (domain.status === 'active') {
    // After an uninstall HighLevel has revoked our token; the domain must still be released.
    await ghl.registerProvider(locationId, config.appUrl).catch((e) => console.warn('Reset paymentsUrl failed', e.message));
  }
  await vercel.removeDomain(domain.hostname);
  await db.checkoutDomain.delete({ where: { locationId } });
}
