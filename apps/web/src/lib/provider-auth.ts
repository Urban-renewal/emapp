'use server';

import { ProviderProfileSchema, type ProviderProfile } from '@emapp/shared-types';
import { cookies, headers } from 'next/headers';

export type { ProviderProfile };

/**
 * Server-side `/provider/me` fetch — V10-S1 closure (H1 Provider FE
 * topology fix).
 *
 * Mirror of `getMe()` (apps/web/src/lib/auth.ts) but for the
 * privileged Provider tier:
 *  - Reads `provider_access_token` cookie (separate from org-tier
 *    `access_token`; D.29 audience isolation lives one layer below).
 *  - Routes through the same Pages Function reverse-proxy via
 *    `selfOrigin()` allowlist (§v9-H-1 defense in depth).
 *  - Defensively `.parse()`s the BE response with `ProviderProfileSchema`
 *    — any drift (e.g. BE accidentally widens the response to include
 *    `mfaSecretEncrypted`) is rejected client-side, returning null
 *    instead of polluting the React tree with unexpected fields.
 *  - 15s `AbortSignal.timeout` — same posture as `getMe()` against a
 *    hung backend.
 *  - Returns null on any failure path (anti-enum: the caller cannot
 *    distinguish "no cookie" from "expired JWT" from "user disabled"
 *    from "network error"). All map to a single redirect-to-login.
 *
 * **Security invariants (pinned by spec)**:
 *  - Never logs the cookie value (only `Cookie:` header forwarded; pino
 *    is configured to redact upstream).
 *  - Returns null if `selfOrigin()` rejects the Host (closes the
 *    self-fetch SSRF vector — already enforced by the shared allowlist).
 *  - `cache: 'no-store'` — identity must always reflect current DB
 *    state; staleness from a Next.js Route Handler cache would let a
 *    disabled Provider continue to see their identity surface.
 */
export async function getProviderMe(): Promise<ProviderProfile | null> {
  const cookieStore = await cookies();
  const providerAccessToken = cookieStore.get('provider_access_token')?.value;
  if (!providerAccessToken) return null;

  const origin = await selfOrigin();
  if (!origin) return null;

  try {
    const res = await fetch(`${origin}/api/v1/provider/me`, {
      headers: { Cookie: `provider_access_token=${providerAccessToken}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data: unknown };
    const parsed = ProviderProfileSchema.safeParse(body.data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Server Action — revoke the Provider tier session in the API and
 * clear cookies. Symmetrical with `logout()` for the org tier.
 *
 * Two failure modes:
 *  1. `selfOrigin()` rejects the Host → still clear cookies locally
 *     (the user is at least signed-out client-side; the BE session
 *     stays open but it expires within 30 min — Doc 07 §6.7 — and
 *     refresh would fail without the refresh cookie anyway).
 *  2. BE returns non-200 → still clear cookies locally; report
 *     `ok: false` so the caller can surface a warning.
 *
 * Cookie paths MUST match what the BE set:
 *  - `provider_access_token` at path `/`
 *  - `provider_refresh_token` at path `/api/v1/provider/auth/refresh`
 *
 * The wrong path on `cookies.delete()` is a silent no-op — pinned by
 * spec to prevent regression.
 */
export async function logoutProvider(): Promise<{ ok: boolean }> {
  const cookieStore = await cookies();
  const providerAccessToken = cookieStore.get('provider_access_token')?.value;
  const origin = await selfOrigin();

  if (!origin) {
    cookieStore.delete('provider_access_token');
    cookieStore.delete({
      name: 'provider_refresh_token',
      path: '/api/v1/provider/auth/refresh',
    });
    return { ok: false };
  }

  let upstreamOk = false;
  try {
    const upstream = await fetch(`${origin}/api/v1/provider/auth/logout`, {
      method: 'POST',
      headers: providerAccessToken
        ? { Cookie: `provider_access_token=${providerAccessToken}` }
        : {},
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    upstreamOk = upstream.ok;
  } catch {
    upstreamOk = false;
  }

  cookieStore.delete('provider_access_token');
  cookieStore.delete({
    name: 'provider_refresh_token',
    path: '/api/v1/provider/auth/refresh',
  });
  return { ok: upstreamOk };
}

/**
 * Same Host allowlist + protocol logic as `lib/auth.ts:selfOrigin()`.
 * Duplicated rather than imported to avoid creating a circular
 * `'use server'` boundary issue + to keep the two server-action
 * modules independently auditable.
 */
const LOCALHOST_REGEX = /^(localhost|127\.0\.0\.1):\d{1,5}$/;
const STATIC_ALLOWLIST = new Set<string>(['app.emapp.io']);

function isAllowedHost(host: string): boolean {
  if (STATIC_ALLOWLIST.has(host)) return true;
  if (LOCALHOST_REGEX.test(host)) return true;
  const extra = process.env['EMAPP_ALLOWED_ORIGINS'];
  if (extra) {
    const list = extra
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.includes(host)) return true;
  }
  return false;
}

async function selfOrigin(): Promise<string | null> {
  const h = await headers();
  const host = h.get('host');
  if (!host) return null;
  if (!isAllowedHost(host)) return null;
  const protocol =
    h.get('x-forwarded-proto') ??
    (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
  return `${protocol}://${host}`;
}
