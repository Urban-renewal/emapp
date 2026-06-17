/**
 * Server-side GET helper for RSC prefetch (perf-research/01-rsc-waterfall.md
 * §4.2). Mirrors `lib/auth.ts:getMe()`'s cookie-forwarding posture EXACTLY:
 *
 *   - resolves an absolute origin via `selfOrigin()` behind the §v9-H-1
 *     Host allowlist (SSRF / token-exfiltration defense — a non-allowlisted
 *     Host is REFUSED, the call returns null);
 *   - forwards the httpOnly `access_token` cookie explicitly as a `Cookie`
 *     header (a server-side `fetch` to a relative path has no origin and
 *     would NOT attach the browser's cookies — same problem getMe solved);
 *   - routes through the SAME Pages-Function reverse-proxy the browser uses
 *     (`${origin}/api/v1/...`), so the §v9-M-9 single-env-var contract and
 *     every FE-side header defense apply uniformly. We deliberately do NOT
 *     read `process.env.API_BACKEND_URL` to fetch Railway directly — that's
 *     the §v9-M-9 reversibility lever and out of scope for this slice;
 *   - bounds a hung backend with `AbortSignal.timeout(15_000)` and
 *     `cache: 'no-store'`.
 *
 * PLAIN server module — NO `'use server'` directive (Turbopack would
 * otherwise register every export as a runtime action; perf-research §4.7).
 * Called from Server Components, never as a form action.
 *
 * Returns the raw D.16 envelope body (`{ data, page? }` on success, or an
 * `{ error }` envelope) as `unknown` so the caller runs the SAME defensive
 * Zod parse the client `lib/api/*` wrapper runs (e.g.
 * `serverListProjects` → `ProjectListItemSchema`). Returns `null` only when
 * the request can't even be made / completed (no cookie, refused Host,
 * network/timeout/parse failure) — the prefetch then yields an empty cache
 * and the client hook transparently falls back to its own fetch path.
 */
import { cookies, headers } from 'next/headers';

const SERVER_FETCH_TIMEOUT_MS = 15_000;

// §v9-H-1 host allowlist — kept byte-for-byte in step with
// `lib/auth.ts` (the same pattern provider-auth.ts already duplicates).
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

/**
 * Server-side authenticated GET of an `/api/v1` path. `path` MUST start
 * with `/` and is appended to `${origin}/api/v1`. Returns the parsed JSON
 * envelope as `unknown`, or `null` on any failure (refused Host, missing
 * cookie, non-2xx, timeout, malformed JSON).
 */
export async function serverApiGet(path: string): Promise<unknown | null> {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get('access_token')?.value;
  if (!accessToken) return null;

  const origin = await selfOrigin();
  if (!origin) return null;

  try {
    const res = await fetch(`${origin}/api/v1${path}`, {
      headers: { Cookie: `access_token=${accessToken}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(SERVER_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}
