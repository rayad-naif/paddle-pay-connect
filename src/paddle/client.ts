import type { Mode } from '../config';

export class PaddleError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

/** Detects sandbox vs live from the API key prefix. */
export function modeFromApiKey(apiKey: string): Mode | null {
  if (apiKey.startsWith('pdl_sdbx_')) return 'test';
  if (apiKey.startsWith('pdl_live_')) return 'live';
  return null;
}

export function modeFromClientToken(token: string): Mode | null {
  if (token.startsWith('test_')) return 'test';
  if (token.startsWith('live_')) return 'live';
  return null;
}

/** Minimal Paddle Billing API client, scoped to one seller's API key. */
export class Paddle {
  private base: string;

  constructor(private apiKey: string, mode: Mode) {
    this.base = mode === 'live' ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';
  }

  private async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = json.error ?? {};
      throw new PaddleError(res.status, err.code ?? 'unknown', err.detail ?? `Paddle API error ${res.status}`);
    }
    return json.data as T;
  }

  /** Read-only calls that fail with 403 if the key lacks customer/transaction access. */
  async checkAccess() {
    await this.request('GET', '/customers?per_page=1');
    await this.request('GET', '/transactions?per_page=1');
  }

  createClientToken(name: string) {
    return this.request<{ id: string; token: string }>('POST', '/client-tokens', { name });
  }

  revokeClientToken(id: string) {
    return this.request('PATCH', `/client-tokens/${id}`, { status: 'revoked' });
  }

  createNotificationSetting(destination: string, events: string[], description: string) {
    return this.request<{ id: string; endpoint_secret_key: string }>('POST', '/notification-settings', {
      description,
      type: 'url',
      destination,
      subscribed_events: events,
      traffic_source: 'all',
    });
  }

  deleteNotificationSetting(id: string) {
    return this.request('DELETE', `/notification-settings/${id}`);
  }

  async findOrCreateCustomer(email: string, name?: string): Promise<string> {
    const existing = await this.request<any[]>('GET', `/customers?email=${encodeURIComponent(email)}`);
    if (existing.length > 0) return existing[0].id;
    const created = await this.request<{ id: string }>('POST', '/customers', { email, name: name || undefined });
    return created.id;
  }

  createTransaction(body: unknown) {
    return this.request<any>('POST', '/transactions', body);
  }

  getTransaction(id: string) {
    return this.request<any>('GET', `/transactions/${id}`);
  }

  createAdjustment(body: unknown) {
    return this.request<any>('POST', '/adjustments', body);
  }

  listPaymentMethods(customerId: string) {
    return this.request<any[]>('GET', `/customers/${customerId}/payment-methods`);
  }
}
