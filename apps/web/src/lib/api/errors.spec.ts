/**
 * V10-S6 closure — pins the `isEmptyResponseSuccess` helper contract.
 *
 * The helper centralises the 14-site magic-string check that treated
 * the api-client's `invalid_response` sentinel as success on 204
 * archive/delete responses. A regression in either direction (helper
 * returns true for OTHER codes, OR the sentinel renames without
 * propagating) silently breaks archive flows across every entity.
 */
import { describe, expect, it } from 'vitest';

import { ApiClientError, EMPTY_RESPONSE_CODE, isAuthError, isEmptyResponseSuccess } from './errors';

describe('isEmptyResponseSuccess (V10-S6)', () => {
  it('returns true for the empty-response sentinel code', () => {
    expect(isEmptyResponseSuccess({ code: 'invalid_response' })).toBe(true);
  });

  it('returns false for any other error code', () => {
    // A real error (e.g. validation_error) MUST NOT be silenced. The
    // archive flow would otherwise treat a 400 as success.
    expect(isEmptyResponseSuccess({ code: 'validation_error' })).toBe(false);
    expect(isEmptyResponseSuccess({ code: 'forbidden' })).toBe(false);
    expect(isEmptyResponseSuccess({ code: 'not_found' })).toBe(false);
    expect(isEmptyResponseSuccess({ code: 'token_expired' })).toBe(false);
    expect(isEmptyResponseSuccess({ code: '' })).toBe(false);
  });

  it('exposes the sentinel as a constant for the api-client side', () => {
    // api-client mints this code; lib/api wrappers compare against it.
    // The constant is the single source of truth for the string —
    // renaming requires touching exactly one line.
    expect(EMPTY_RESPONSE_CODE).toBe('invalid_response');
  });

  it('ApiClientError wraps an envelope with the captured code', () => {
    // Sanity pin for the partner class — ensures the helper's caller
    // pattern `throw new ApiClientError(res.error)` keeps the code
    // accessible to upstream catch blocks (used by useApiErrorHandler).
    const err = new ApiClientError({ code: 'forbidden', message: 'no' });
    expect(err.code).toBe('forbidden');
    expect(err.message).toBe('no');
    expect(err.name).toBe('ApiClientError');
  });
});

describe('isAuthError (0.S6 #36 — auth vs transient/permission split)', () => {
  it('returns true for EXACTLY the tenant-guard 401 codes (BE contract)', () => {
    // Pinned to apps/api/src/modules/auth/tenant/tenant-auth.guard.ts — the
    // guard throws exactly these three on a 401. The portal page-level bounce
    // (#36) must cover ALL THREE; a drift here silently no-ops the fallback.
    for (const code of ['missing_token', 'invalid_token', 'session_revoked']) {
      expect(isAuthError(new ApiClientError({ code })), `${code} is auth`).toBe(true);
    }
  });

  it('returns false for codes the BE tenant guard never emits (no guessed entries)', () => {
    // These were a previous GUESS that diverged from the guard; assert they
    // are NOT silently treated as auth (drift-guard).
    expect(isAuthError(new ApiClientError({ code: 'unauthorized' }))).toBe(false);
    expect(isAuthError(new ApiClientError({ code: 'expired_token' }))).toBe(false);
  });

  it('returns false for a TRANSIENT infra failure (5xx → invalid_response)', () => {
    // The portal must NOT bounce a resident to /tenant/login on a server
    // outage; a 5xx folds to invalid_response, which is NOT an auth failure.
    expect(isAuthError(new ApiClientError({ code: 'invalid_response' }))).toBe(false);
    expect(isAuthError(new ApiClientError({ code: 'internal' }))).toBe(false);
  });

  it('returns false for a PERMISSION denial (403 → forbidden) and for token_expired', () => {
    // 403 is access-denied, not an auth bounce. token_expired is handled by
    // the api-client silent refresh upstream, never a terminal bounce here.
    expect(isAuthError(new ApiClientError({ code: 'forbidden' }))).toBe(false);
    expect(isAuthError(new ApiClientError({ code: 'token_expired' }))).toBe(false);
  });

  it('returns false for non-ApiClientError values (undefined / raw Error)', () => {
    expect(isAuthError(undefined)).toBe(false);
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError(new Error('boom'))).toBe(false);
  });
});
