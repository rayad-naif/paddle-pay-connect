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

  /**
   * Returns an active Paddle customer for this email. Paddle matches emails case-insensitively
   * and still counts archived customers, so a plain lookup can miss a customer that then makes
   * POST /customers fail with customer_already_exists; that error names the existing id.
   */
  async findOrCreateCustomer(rawEmail: string, name?: string): Promise<string> {
    const email = rawEmail.trim().toLowerCase();
    const existing = await this.request<any[]>(
      'GET',
      `/customers?email=${encodeURIComponent(email)}&status=active,archived`,
    );
    const match = existing.find((c) => c.status === 'active') ?? existing[0];
    if (match) return this.ensureActive(match.id, match.status);

    try {
      const created = await this.request<{ id: string }>('POST', '/customers', { email, name: name || undefined });
      return created.id;
    } catch (e) {
      const conflict = e instanceof PaddleError && (e.code === 'customer_already_exists' || /conflicts with customer/i.test(e.message));
      const id = conflict ? (e as PaddleError).message.match(/ctm_[a-z0-9]+/i)?.[0] : undefined;
      if (!id) throw e;
      const customer = await this.request<any>('GET', `/customers/${id}`);
      return this.ensureActive(id, customer.status);
    }
  }

  private async ensureActive(id: string, status: string): Promise<string> {
    if (status !== 'active') await this.request('PATCH', `/customers/${id}`, { status: 'active' });
    return id;
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
