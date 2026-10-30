import crypto from 'crypto';
import { config } from '../config';

const key = Buffer.from(config.encryptionKey, 'hex');
if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes)');

/** AES-256-GCM encryption for secrets at rest. Output: iv.tag.ciphertext (base64url). */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(payload: string): string {
  const [iv, tag, data] = payload.split('.').map((p) => Buffer.from(p, 'base64url'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function randomKey(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * Decrypts the payload GHL sends to custom pages (REQUEST_USER_DATA_RESPONSE).
 * GHL encrypts it with CryptoJS.AES using the app's SSO key, which uses the
 * OpenSSL "Salted__" format with an MD5-based EVP_BytesToKey derivation.
 */
export function decryptGhlSso(encrypted: string): Record<string, any> {
  const raw = Buffer.from(encrypted, 'base64');
  if (raw.subarray(0, 8).toString('utf8') !== 'Salted__') throw new Error('Invalid SSO payload');
  const salt = raw.subarray(8, 16);
  const ciphertext = raw.subarray(16);
  const password = Buffer.from(config.ghl.ssoKey, 'utf8');

  let derived = Buffer.alloc(0);
  let block = Buffer.alloc(0);
  while (derived.length < 48) {
    block = crypto.createHash('md5').update(Buffer.concat([block, password, salt])).digest();
    derived = Buffer.concat([derived, block]);
  }
  const decipher = crypto.createDecipheriv('aes-256-cbc', derived.subarray(0, 32), derived.subarray(32, 48));
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}

/** Short-lived HMAC-signed token for the settings page, bound to one location. */
export function signSession(locationId: string, ttlSeconds = 3600): string {
  const body = Buffer.from(JSON.stringify({ locationId, exp: Math.floor(Date.now() / 1000) + ttlSeconds })).toString('base64url');
  const sig = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifySession(token: string): { locationId: string } | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (data.exp < Math.floor(Date.now() / 1000)) return null;
  return { locationId: data.locationId };
}
