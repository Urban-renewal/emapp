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
