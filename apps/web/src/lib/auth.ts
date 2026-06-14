'use server';

import { UserProfileSchema, type UserProfile } from '@emapp/shared-types';
import { cookies, headers } from 'next/headers';
import { cache } from 'react';

export type { UserProfile };

/**
 * Server-side `/me` fetch. Routes through the same Pages Function
 * reverse-proxy that the browser uses (D.35) — single env var
 * (`API_BACKEND_URL`), one place where the backend hostname lives.
 *
 * Closes §v9-H-1 — Host-header SSRF / token-exfiltration vector.
 * `selfOrigin()` no longer trusts the client-supplied Host verbatim;
 * an allowlist (`SELF_ORIGIN_ALLOWLIST`) drops anything not on the
 * known-good list. If a non-allowlisted Host arrives, the helper
 * returns null and the call is refused (getMe returns null, logout
 * performs only the local cookie-clear). This is defense-in-depth
 * on top of Cloudflare Pages' Host normalization — a future CF
 * misconfiguration cannot weaponize the Server Action.
 */
/**
 * PERF (2026-06-14): request-memoized with React `cache()`. A single dashboard
 * render calls getMe() from MULTIPLE server components (the (dashboard) layout
 * AND the page, plus provider layout) — without memoization each call was a
 * full `/me` round-trip to the API → DB, serially. A live login walk measured
 * the post-login server render at ~4.3s, dominated by these duplicate `/me`s.
 * `cache()` dedupes to ONE fetch per request (its scope is request-local in
 * RSC, so there is no cross-request/cross-user leakage). The exported `getMe`
 * stays a valid Server Action (async export from a 'use server' module);
 * `getMeCached` is the module-private memoized implementation it delegates to.
 */
const getMeCached = cache(async (): Promise<UserProfile | null> => {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get('access_token')?.value;
  if (!accessToken) return null;

  const origin = await selfOrigin();
  if (!origin) return null;

  try {
    const res = await fetch(`${origin}/api/v1/me`, {
      headers: { Cookie: `access_token=${accessToken}` },
      cache: 'no-store',
      // Defense against a hung backend (closes a server-side variant
      // of §v9-H-6 — fetch timeout).
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data: unknown };
    const parsed = UserProfileSchema.safeParse(body.data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
});

export async function getMe(): Promise<UserProfile | null> {
  return getMeCached();
}

/**
 * Server Action — revoke the org session in the API and clear cookies.
 * If `selfOrigin` rejects the Host (allowlist), we still clear the
 * cookies locally so the user is at least signed-out client-side.
 */
export async function logout(): Promise<{ ok: boolean }> {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get('access_token')?.value;
  const origin = await selfOrigin();
  if (!origin) {
    cookieStore.delete('access_token');
    cookieStore.delete('refresh_token');
    return { ok: false };
  }

  let upstreamOk = false;
  try {
    const upstream = await fetch(`${origin}/api/v1/auth/logout`, {
      method: 'POST',
      headers: accessToken ? { Cookie: `access_token=${accessToken}` } : {},
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    upstreamOk = upstream.ok;
  } catch {
    upstreamOk = false;
  }
  cookieStore.delete('access_token');
  cookieStore.delete('refresh_token');
  return { ok: upstreamOk };
}

/**
 * Allowed hosts for the Server-Action self-fetch (closes §v9-H-1 +
 * v9-post-audit-HIGH-3 — dev port regression).
 *
 * Production: `app.emapp.io` (the canonical FE hostname per D.35).
 * Dev: any `localhost:<port>` / `127.0.0.1:<port>` — supports a
 * developer using port 3002, 8080, or a Pages-emulator port without
 * editing this file.
 * Extension: `EMAPP_ALLOWED_ORIGINS` (Infisical-only, comma-
 * separated) lets ops add staging hostnames without code changes
 * (e.g. `app-staging.emapp.io,emapp-pr-42.pages.dev`).
 *
 * Any other Host value is REFUSED — the Server Action returns null
 * and the caller treats it as unauthenticated.
 *
 * Cloudflare Pages normalizes Host to the deployed hostname; this
 * allowlist is defense-in-depth, not the primary protection.
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
