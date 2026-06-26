/**
 * Shared API client error class.
 *
 * §SOLID-M5 closure — was historically defined in `lib/api/projects.ts`
 * (S2 era — projects was the first entity, the class was inlined and
 * re-exported by 8 other entity files). Moved here so the import name
 * matches the concept and renaming `projects.ts` doesn't ripple.
 * `projects.ts` still re-exports for backward compatibility.
 */
export class ApiClientError extends Error {
  readonly code: string;
  readonly details: unknown;
  constructor(env: { code: string; message?: string; details?: unknown }) {
    super(env.message ?? env.code);
    this.code = env.code;
    this.details = env.details;
    this.name = 'ApiClientError';
  }
}

/**
 * V10-S6 closure — empty-response-as-success sentinel.
 *
 * Every BE archive/delete endpoint returns 204 No Content. The
 * api-client's response parser can't .parse() an empty body and
 * surfaces it as an `ApiError` with code `invalid_response`. The
 * convention across entity wrappers is to treat this specific code as
 * success (since 204 IS the expected shape), but the magic-string
 * comparison was duplicated 14 times across `apps/web/src/lib/api/*.ts`.
 *
 * Risks closed:
 *  - String drift: if a future api-client refactor renames the
 *    `invalid_response` sentinel (e.g. to `empty_response` to be more
 *    accurate), every archive site silently starts throwing on 204.
 *    With the helper, the rename is a one-line update.
 *  - Intent obscurity: `if (res.error.code === 'invalid_response')` reads
 *    like an "ignore parse failure" — looks wrong on review. The named
 *    helper makes the success semantics explicit.
 *
 * Contract:
 *  - Returns `true` ONLY for the api-client's 204-induced
 *    `invalid_response` code. Any other parse-failure mode (e.g. a real
 *    malformed response from a buggy BE) keeps the original `code` and
 *    fails fast — defense against false-positive success.
 *  - The constant is exported so api-client (which mints the code) and
 *    the call sites (which check it) share a single source of truth.
 */
export const EMPTY_RESPONSE_CODE = 'invalid_response' as const;

export function isEmptyResponseSuccess(err: { code: string }): boolean {
  return err.code === EMPTY_RESPONSE_CODE;
}

/**
 * Auth-failure error codes the BE emits on a 401 (D.21 / D.31). The
 * api-client folds these into an `ApiClientError` with the same `code`
 * (see `maybeEmitUnauthenticated` / `peekErrorCode` in api-client.ts).
 *
 * SINGLE SOURCE OF TRUTH: this set MUST mirror the 401 codes the tenant-tier
 * guard actually emits — `apps/api/src/modules/auth/tenant/tenant-auth.guard.ts`
 * throws exactly `missing_token` (no cookie), `invalid_token` (malformed /
 * expired / wrong-audience JWT — expiry maps HERE, the BE has no separate
 * `expired_token`), and `session_revoked` (explicit server-side revocation).
 * The portal's belt-and-suspenders page-level bounce (#36) is meant to cover
 * ALL THREE in the missed-event race; a guessed allowlist that omits
 * `missing_token`/`session_revoked` silently no-ops for two of them. Keep this
 * pinned to the guard (the `errors.spec.ts` test asserts the exact set).
 *
 * `token_expired` is intentionally EXCLUDED: it triggers the api-client's
 * single-flight silent refresh, not a terminal bounce. By the time a query
 * surfaces an error, a `token_expired` has already been refreshed-or-failed
 * upstream; a residual one here is rare and best treated as transient.
 */
const AUTH_ERROR_CODES = new Set<string>(['missing_token', 'invalid_token', 'session_revoked']);

/**
 * Is this query error a genuine AUTHENTICATION failure (HTTP 401 — the
 * session/token is missing, invalid, or expired) as opposed to a TRANSIENT
 * infra failure (5xx / timeout / network → `invalid_response`) or a
 * permission denial (403 → `forbidden`)?
 *
 * #36 — the tenant portal must bounce to /tenant/login ONLY on a real auth
 * failure. A 5xx outage is NOT an auth problem: bouncing the resident to
 * login on a transient server hiccup is a misdirected recovery. This is the
 * single predicate that distinguishes the two so the portal (and any future
 * tier guard) never re-derives it inconsistently.
 */
export function isAuthError(error: unknown): boolean {
  return error instanceof ApiClientError && AUTH_ERROR_CODES.has(error.code);
}
