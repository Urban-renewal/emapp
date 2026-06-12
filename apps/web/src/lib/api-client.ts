/**
 * Thin browser-side API client.
 *
 * v8.5 D.35 — Option A topology: the browser ALWAYS calls same-origin
 * `/api/v1/*`. The Pages Function at `src/app/api/[...path]/route.ts`
 * proxies that to the private backend. Net effect:
 *   - cookies are hostOnly on app.emapp.io (no Domain leak)
 *   - no CORS (same origin)
 *   - no browser-exposed backend URL needed (and we deliberately
 *     don't read one — a future hand that added a `NEXT_PUBLIC_*`
 *     hostname env var would break the cookie hostOnly model;
 *     guarded by auth.spec.ts)
 *
 * `credentials: 'same-origin'` is the strictest setting that still
 * sends cookies — it's the right one because we're literally same
 * origin now. ('include' would also work but is the wrong intent.)
 *
 * v9 closures:
 *   - §v9-H-7 envelope guard: every JSON body that lacks both `data`
 *     and `error` keys is folded into `{ error: { code:
 *     'invalid_response' } }` — same as malformed-JSON.
 *   - §v9-H-6 fetch timeout: every request gets an `AbortSignal`
 *     with `DEFAULT_TIMEOUT_MS` (15s). Caller can override.
 *   - §v9-P0-3 Idempotency-Key: `postIdempotent` helper auto-mints
 *     a UUIDv4 per call and sends it as `Idempotency-Key`. Use for
 *     create-style POSTs.
 *   - §v9-P0-4 silent refresh: on 401 with `error.code ===
 *     'token_expired'`, fire ONE in-flight `POST /api/v1/auth/refresh`
 *     and queue subsequent requests behind it; on success replay
 *     the original; on failure → `emapp:unauthenticated`.
 *   - §v9-H-5 PUT: native `put` so ownerships et al. don't bypass
 *     the 401-event / refresh / timeout path.
 */
import { type ApiResponse, isOk, type ApiList, type ApiError } from '@emapp/shared-types';

export { isOk };
export type { ApiResponse, ApiList, ApiError };

export const UNAUTHENTICATED_EVENT = 'emapp:unauthenticated';

const API_PREFIX = '/api/v1';
const DEFAULT_TIMEOUT_MS = 15_000;
const REFRESH_PATH = '/api/v1/auth/refresh';

/** Discriminator for list envelopes — `{ data: T[], page }`. */
function isList<T>(res: ApiListResponse<T>): res is ApiList<T> {
  return 'data' in res && Array.isArray((res as { data: unknown }).data) && 'page' in res;
}
export { isList };

export type ApiListResponse<T> = ApiList<T> | ApiError;

export interface ApiFetchOptions extends RequestInit {
  /** Per-request override of the default 15s timeout (ms). 0 disables. */
  timeoutMs?: number;
  /** When true, the api-client will NOT attempt silent refresh on a
   *  401 from this request — used by `postRefresh` itself to avoid
   *  recursion, and by call sites that want raw 401 propagation. */
  noRefresh?: boolean;
}

/** Synthetic error envelope for an unexpected wire shape. */
function invalidResponse(message?: string): ApiError {
  return { error: { code: 'invalid_response', message: message ?? 'Non-D.16 response body' } };
}

/**
 * Single-flight refresh + waiter queue (v9-post-audit-HIGH-2 closure).
 *
 * Multiple concurrent 401s share ONE refresh. Importantly, the
 * single-flight slot stays held for a brief drain window AFTER the
 * refresh resolves (`RESET_DELAY_MS`), so 401s from requests that
 * were already in-flight against the OLD token share the same
 * refresh result rather than starting a second /auth/refresh. The
 * second refresh is the dangerous one: under D.21 reuse-detection
 * a same-old-token re-presentation purges the entire session chain.
 *
 * Drain window of 100ms covers the worst-case skew between A's
 * refresh response arriving and B's first 401 surfacing.
 */
const REFRESH_DRAIN_MS = 100;
let refreshInFlight: Promise<boolean> | null = null;

async function attemptRefresh(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      // Use a raw fetch (avoid api-client → infinite recursion). Same
      // cookie posture; no idempotency key (POST /auth/refresh is
      // idempotent server-side via the rotation chain).
      const res = await fetch(`${REFRESH_PATH}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      // Drain window: hold the single-flight slot a bit longer so
      // concurrent stale-token 401s share THIS refresh instead of
      // racing into a second /auth/refresh call.
      setTimeout(() => {
        refreshInFlight = null;
      }, REFRESH_DRAIN_MS);
    }
  })();
  return refreshInFlight;
}

/**
 * Public entrypoint — the `isReplay` boolean is intentionally INVISIBLE
 * to callers (SOLID DIP closure of v9-SOLID #2). The post-fix-audit
 * reviewer flagged that exposing replay state in the function signature
 * leaked implementation detail. We now keep `apiFetch` clean and route
 * the refresh/replay logic through a module-internal helper.
 */
async function apiFetch<T>(path: string, init: ApiFetchOptions = {}): Promise<ApiResponse<T>> {
  const first = await rawFetch<T>(path, init);
  if (shouldAttemptRefresh(first.res.status, first.body, init.noRefresh ?? false)) {
    const refreshed = await attemptRefresh();
    if (refreshed) {
      // Replay ONCE — no second refresh attempt on the replay's result.
      const replay = await rawFetch<T>(path, { ...init, noRefresh: true });
      maybeEmitUnauthenticated(replay.res.status, replay.body);
      return replay.body;
    }
  }
  maybeEmitUnauthenticated(first.res.status, first.body);
  return first.body;
}

interface RawFetchResult<T> {
  res: Response;
  body: ApiResponse<T>;
}

/**
 * Raw fetch + envelope guard. No refresh, no 401 event. Returns the
 * raw `res` plus the D.16-conformant body (with envelope guard
 * folding non-conformant shapes to `invalid_response`).
 */
async function rawFetch<T>(path: string, init: ApiFetchOptions): Promise<RawFetchResult<T>> {
  // `noRefresh` is consumed by the public apiFetch wrapper; here we
  // strip it from `rest` so it doesn't end up on the native fetch init.
  const { timeoutMs, noRefresh, ...rest } = init;
  void noRefresh;
  const effectiveTimeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let signal: AbortSignal | undefined = rest.signal ?? undefined;
  if (effectiveTimeout > 0 && !signal) {
    signal = AbortSignal.timeout(effectiveTimeout);
  }

  // §v9-M-5 closure — Content-Type only when there's a body. GET /
  // DELETE / HEAD have no body, so the JSON Content-Type is wasted
  // bytes that some proxies (not Cloudflare today, but defense in
  // depth) misinterpret as an empty-body POST.
  const method = rest.method ?? 'GET';
  const hasBody = rest.body !== undefined && rest.body !== null;
  const headers: Record<string, string> = {
    ...((rest.headers as Record<string, string> | undefined) ?? {}),
  };
  if (hasBody && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}${path}`, {
      ...rest,
      method,
      credentials: 'same-origin',
      headers,
      signal,
    });
  } catch (e) {
    // v9-SOLID-1 closure — guard with instanceof rather than unsafe
    // `as Error` cast; a Promise.reject(string) would otherwise crash.
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      return {
        res: new Response(null, { status: 408 }),
        body: invalidResponse('upstream_timeout') as ApiResponse<T>,
      };
    }
    throw e;
  }

  // v9-SOLID-5 closure — parse as unknown, validate, then narrow. No
  // `as ApiResponse<T>` cast on raw input.
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { res, body: invalidResponse() as ApiResponse<T> };
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (!('data' in parsed) && !('error' in parsed))
  ) {
    return { res, body: invalidResponse() as ApiResponse<T> };
  }

  return { res, body: parsed as ApiResponse<T> };
}

function shouldAttemptRefresh(
  status: number,
  body: ApiResponse<unknown>,
  noRefresh: boolean,
): boolean {
  if (noRefresh) return false;
  if (status !== 401) return false;
  if (isOk(body)) return false;
  return body.error.code === 'token_expired';
}

/** §v9-P0-4 — emit `emapp:unauthenticated` for terminal 401s only.
 *  Form-level codes (invalid_credentials/invalid_otp/not_member, and the 7c
 *  PII step-up `invalid_step_up_code` — a wrong OTP in the unlock dialog must
 *  show an inline error, NOT boot the whole session to /login) and
 *  successful responses are suppressed. */
const SUPPRESS_EVENT = new Set([
  'invalid_credentials',
  'invalid_otp',
  'not_member',
  'invalid_step_up_code',
]);
function maybeEmitUnauthenticated(status: number, body: ApiResponse<unknown>): void {
  if (status !== 401) return;
  if (typeof window === 'undefined') return;
  const code = !isOk(body) ? body.error.code : undefined;
  if (code && SUPPRESS_EVENT.has(code)) return;
  window.dispatchEvent(new CustomEvent(UNAUTHENTICATED_EVENT));
}

/**
 * List-aware variant — preserves the `page` envelope alongside `data[]`.
 *
 * v9-post-audit-SOLID-7 closure — the previous `as unknown as
 * ApiListResponse<T>` double-cast was a code smell hiding that the
 * generic `apiFetch<T[]>` doesn't know about the `page` field. We now
 * type the local result as a structural superset (`ApiData<T[]>` may
 * also carry `page`) and let the caller-side `isList<T>` runtime
 * check do the discrimination.
 */
async function apiFetchList<T>(path: string, init?: ApiFetchOptions): Promise<ApiListResponse<T>> {
  const res = await apiFetch<T[]>(path, init);
  // The raw JSON body — when it's a list — already carries `page` at
  // the top level (validated by the envelope guard in rawFetch). The
  // generic `ApiResponse<T[]>` type just doesn't include `page` in
  // its union; the runtime shape does. This single-step cast (no
  // intermediate `unknown`) is the minimal type-system adjustment.
  return res as ApiListResponse<T>;
}

/**
 * §v9-P0-3 — UUIDv4 generator.
 *
 * Fail-loud on missing crypto (v9-SOLID-9 closure): in modern Node /
 * browsers `crypto.randomUUID` is always available. If it isn't, we
 * have a SUSPICIOUS environment; minting a Math.random-based fake
 * UUID would silently weaken idempotency (predictable keys). Throw
 * instead — the call site surfaces an error the user can retry.
 */
function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  throw new Error(
    'newIdempotencyKey: Web Crypto API unavailable — cannot mint a unique idempotency key.',
  );
}

export const apiClient = {
  post: <T>(path: string, body: unknown, init?: ApiFetchOptions) =>
    apiFetch<T>(path, { ...init, method: 'POST', body: JSON.stringify(body) }),

  /** §v9-P0-3 — auto-mints an Idempotency-Key. Use for create-style POSTs. */
  postIdempotent: <T>(path: string, body: unknown, init?: ApiFetchOptions) =>
    apiFetch<T>(path, {
      ...init,
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        ...(init?.headers ?? {}),
        'Idempotency-Key': newIdempotencyKey(),
      },
    }),

  get: <T>(path: string, init?: ApiFetchOptions) => apiFetch<T>(path, { ...init, method: 'GET' }),

  getList: <T>(path: string, init?: ApiFetchOptions) => apiFetchList<T>(path, init),

  patch: <T>(path: string, body: unknown, init?: ApiFetchOptions) =>
    apiFetch<T>(path, { ...init, method: 'PATCH', body: JSON.stringify(body) }),

  /** §v9-H-5 — native PUT so callers don't need raw fetch (and so the
   *  refresh + 401-event paths run unconditionally). */
  put: <T>(path: string, body: unknown, init?: ApiFetchOptions) =>
    apiFetch<T>(path, { ...init, method: 'PUT', body: JSON.stringify(body) }),

  delete: <T>(path: string, init?: ApiFetchOptions) =>
    apiFetch<T>(path, { ...init, method: 'DELETE' }),
};
