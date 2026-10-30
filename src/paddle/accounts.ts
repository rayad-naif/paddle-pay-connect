import type { PaddleAccount } from '@prisma/client';
import { config, type Mode } from '../config';
import { db } from '../db';
import { decrypt, encrypt, randomKey, sha256 } from '../lib/crypto';
import { Paddle, PaddleError, modeFromApiKey } from './client';
import * as ghl from '../ghl/client';
import crypto from 'crypto';

export const PADDLE_EVENTS = [
  'transaction.completed',
  'transaction.paid',
  'transaction.payment_failed',
  'subscription.created',
  'subscription.activated',
  'subscription.trialing',
  'subscription.updated',
  'subscription.past_due',
  'subscription.canceled',
  'adjustment.updated',
];

export function paddleFor(account: PaddleAccount): Paddle {
  return new Paddle(decrypt(account.apiKeyEnc), account.mode as Mode);
}

export function findAccountByGhlApiKey(apiKey: string | undefined) {
  if (!apiKey) return null;
  return db.paddleAccount.findUnique({ where: { ghlApiKeyHash: sha256(apiKey) } });
}

/**
 * Connects a Paddle account from a single API key: detects the environment,
 * creates a client-side token and a webhook destination (with its secret),
 * then registers the keys with GHL. The merchant never handles anything else.
 */
export async function connectPaddle(locationId: string, apiKey: string): Promise<PaddleAccount> {
  const mode = modeFromApiKey(apiKey.trim());
  if (!mode) throw new UserError('That does not look like a Paddle API key (expected pdl_sdbx_… or pdl_live_…).');
  const paddle = new Paddle(apiKey.trim(), mode);
  const id = crypto.randomUUID();

  let clientToken: { id: string; token: string };
  let notification: { id: string; endpoint_secret_key: string };
  try {
    await paddle.checkAccess();
  } catch (e) {
    throw permissionError(e, 'customer.read / transaction.read');
  }
  try {
    clientToken = await paddle.createClientToken(`HighLevel ${locationId}`);
  } catch (e) {
    throw permissionError(e, 'client_token.write');
  }
  try {
    notification = await paddle.createNotificationSetting(
      `${config.appUrl}/webhooks/paddle/${id}`,
      PADDLE_EVENTS,
      `HighLevel ${locationId}`,
    );
  } catch (e) {
    await paddle.revokeClientToken(clientToken.id).catch(() => {});
    throw permissionError(e, 'notification_setting.write');
  }

  // Reconnecting replaces the old key, token and webhook destination.
  const previous = await db.paddleAccount.findUnique({ where: { locationId_mode: { locationId, mode } } });
  if (previous) {
    await cleanupPaddle(previous);
    await db.paddleAccount.delete({ where: { id: previous.id } });
  }

  const ghlApiKey = randomKey(`ghl_${mode}`);
  const account = await db.paddleAccount.create({
    data: {
      id,
      locationId,
      mode,
      apiKeyEnc: encrypt(apiKey.trim()),
      clientToken: clientToken.token,
      clientTokenId: clientToken.id,
      notificationSettingId: notification.id,
      webhookSecretEnc: encrypt(notification.endpoint_secret_key),
      ghlApiKeyHash: sha256(ghlApiKey),
      ghlApiKeyEnc: encrypt(ghlApiKey),
    },
  });

  await syncGhlConfig(locationId);
  return account;
}

export async function disconnectPaddle(locationId: string, mode: Mode) {
  const account = await db.paddleAccount.findUnique({ where: { locationId_mode: { locationId, mode } } });
  if (!account) return;
  await cleanupPaddle(account);
  await db.paddleAccount.delete({ where: { id: account.id } });
  await ghl.disconnectConfig(locationId, mode === 'live').catch((e) => console.warn('GHL disconnect failed', e.message));
}

/** Best-effort removal of everything we created in the seller's Paddle account. */
export async function cleanupPaddle(account: PaddleAccount) {
  const paddle = paddleFor(account);
  await paddle.revokeClientToken(account.clientTokenId).catch((e) => console.warn('Revoke client token failed', e.message));
  await paddle.deleteNotificationSetting(account.notificationSettingId).catch((e) => console.warn('Delete notification setting failed', e.message));
}

/** Pushes the current test/live keys to GHL's connect config API. */
async function syncGhlConfig(locationId: string) {
  await ghl.ensureProvider(locationId);
  const accounts = await db.paddleAccount.findMany({ where: { locationId } });
  const body: Record<string, { apiKey: string; publishableKey: string }> = {};
  for (const a of accounts) body[a.mode] = { apiKey: decrypt(a.ghlApiKeyEnc), publishableKey: a.clientToken };
  await ghl.connectConfig(locationId, body);
}

export class UserError extends Error {}

function permissionError(e: unknown, permission: string): Error {
  if (e instanceof PaddleError) {
    if (e.status === 401) return new UserError('Paddle rejected this API key. Check it was copied correctly and has not expired or been revoked.');
    if (e.status === 403) return new UserError(`This Paddle API key is missing a permission (${permission}). Edit the key in Paddle > Developer tools > Authentication and enable it.`);
    return new UserError(`Paddle error: ${e.message}`);
  }
  return e as Error;
}
