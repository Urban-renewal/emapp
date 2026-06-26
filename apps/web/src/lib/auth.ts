'use server';

import { UserProfileSchema, type UserProfile } from '@emapp/shared-types';
import { cookies, headers } from 'next/headers';
import { cache } from 'react';

/**
 * Server-side `/me` fetch.
 *
 * PERF (§v9-M-9 reversed, 2026-06-26 — latency budget): on the server we
 * fetch the API backend DIRECTLY (`${API_BACKEND_URL}/api/v1/me`), skipping
 * the browser → Pages-Function self-hop. The old path went SERVER → its own
 * `/api/[...path]` proxy route → Railway, a redundant round-trip back through
 * the web server on every authenticated SSR render (~0.39s measured warm).
 * Warm authed pages must be <1s, so the self-hop is removed.
 *
 * Cookie forwarding, 401→unauthenticated handling, the timeout defense, and
 * the return shape are PRESERVED EXACTLY — only the upstream URL changes.
 * `API_BACKEND_URL` is the SAME single env var the proxy reads
 * (`route.ts:getBackendBase()`); we reuse it rather than introduce a new knob,
 * and the upstream path (`/api/v1/me`) is byte-for-byte what the proxy emits
 * (`buildUpstreamUrl` → `${base}/api/v1/me`), so the backend contract is
 * unchanged. If `API_BACKEND_URL` is absent (e.g. a bare unit env), we fall
 * back to the §v9-H-1-allowlisted self-origin proxy path so behaviour is never
 * silently broken.
 *
 * §v9-H-1 (Host-header SSRF / token-exfiltration) is unaffected for the direct
 * path: `API_BACKEND_URL` is a trusted server-side env value, NOT a
 * client-supplied Host, so there is nothing to allowlist. The proxy fallback
 * still goes through `selfOrigin()`'s allowlist.
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

  const target = await meEndpoint();
  if (!target) return null;

  try {
    const res = await fetch(target, {
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

/**
 * Resolve the absolute `/me` URL for the server fetch.
 *
 * Primary: the API backend directly (`${API_BACKEND_URL}/api/v1/me`) — no
 * self-hop. `API_BACKEND_URL` is the trusted backend base (the proxy's
 * `getBackendBase()` reads the same var); we trim a trailing slash so a
 * configured `…/` doesn't yield `//api`.
 *
 * Fallback: the §v9-H-1-allowlisted self-origin proxy path, used only when
 * `API_BACKEND_URL` is unset. Returns null when neither is resolvable (caller
 * treats null as unauthenticated / failed, same as before).
 */
async function meEndpoint(): Promise<string | null> {
  const backend = process.env['API_BACKEND_URL'];
  if (backend) return `${backend.replace(/\/$/, '')}/api/v1/me`;

  const origin = await selfOrigin();
  if (!origin) return null;
  return `${origin}/api/v1/me`;
}

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
