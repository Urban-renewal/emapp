import type { ISMSProvider, SMSDeliveryResult } from './sms.interface';

/**
 * Config for the Israeli SMS gateway. Supplied at construction by the app-side
 * factory from Infisical-injected env — NEVER hard-coded (Gate-4 SECRETS LAW).
 */
export interface InforuSmsConfig {
  /** Gateway base URL, e.g. `https://capi.inforu.co.il`. */
  apiUrl: string;
  /** Account username / api-user. */
  user: string;
  /** API token (NOT the account password). */
  token: string;
  /** Approved sender id/name shown to the recipient. */
  sender: string;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Inforu (Israeli) SMS gateway implementation of `ISMSProvider` (D.20 — Tenant
 * OTP + signature-link SMS).
 *
 * ⚠️ VERIFY-BEFORE-GO-LIVE: the request/response shape targets Inforu's
 * documented v2 JSON API (POST `/api/v2/SMS/SendSms`, HTTP Basic `user:token`,
 * `StatusId === 1` ⇒ accepted). Confirm it against your account's CURRENT API
 * docs before flipping the provider on in prod. The provider-specific shape is
 * isolated in {@link buildRequest} / {@link parseResponse} so swapping to 019
 * (or an Inforu API revision) is a one-method change, not a rewrite.
 *
 * Privacy: the recipient phone is never logged in full and the message body
 * (which may carry an OTP / signing link) is NEVER logged.
 */
export class InforuSmsProvider implements ISMSProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: InforuSmsConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async send(to: string, body: string): Promise<SMSDeliveryResult> {
    const { url, init } = this.buildRequest(to, body);
    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (err) {
      return {
        id: 'error',
        status: 'rejected',
        error: err instanceof Error ? err.message : 'network_error',
      };
    }
    if (!res.ok) {
      return { id: 'error', status: 'rejected', error: `http_${res.status}` };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { id: 'error', status: 'rejected', error: 'bad_json' };
    }
    return parseResponse(json);
  }

  async healthCheck(): Promise<void> {
    // Inforu has no dedicated health endpoint; auth/connectivity errors surface
    // on the first send and are mapped to a `rejected` result.
  }

  /** Isolated, provider-specific request builder (swap point for 019/API rev). */
  private buildRequest(to: string, body: string): { url: string; init: RequestInit } {
    const url = `${this.config.apiUrl.replace(/\/+$/, '')}/api/v2/SMS/SendSms`;
    const auth = Buffer.from(`${this.config.user}:${this.config.token}`).toString('base64');
    return {
      url,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${auth}`,
        },
        body: JSON.stringify({
          Data: {
            Message: body,
            Recipients: [{ Phone: toInternational(to) }],
            Settings: { Sender: this.config.sender },
          },
        }),
      },
    };
  }
}

/**
 * `05XXXXXXXX` → `9725XXXXXXXX` (E.164 without `+`). Inforu accepts the
 * international form for IL numbers. Already-international input passes through.
 */
export function toInternational(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('972')) return digits;
  if (digits.startsWith('0')) return `972${digits.slice(1)}`;
  return digits;
}

/** Isolated, provider-specific response parser (swap point for 019/API rev). */
function parseResponse(json: unknown): SMSDeliveryResult {
  const obj = (json ?? {}) as Record<string, unknown>;
  const rawStatus = obj['StatusId'];
  // Strict: accept ONLY the number 1 or the string "1". Do NOT Number()-coerce
  // arbitrary values — `Number(true) === 1` would otherwise misclassify a
  // malformed `{StatusId:true}` gateway response as a successful send.
  const statusId =
    typeof rawStatus === 'number'
      ? rawStatus
      : typeof rawStatus === 'string' && rawStatus.trim() !== ''
        ? Number(rawStatus)
        : NaN;
  const desc = typeof obj['StatusDescription'] === 'string' ? obj['StatusDescription'] : undefined;
  if (statusId === 1) {
    return { id: 'inforu', status: 'sent' };
  }
  return {
    id: 'rejected',
    status: 'rejected',
    error: desc ?? `status_${Number.isNaN(statusId) ? 'unknown' : statusId}`,
  };
}
