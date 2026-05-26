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

import { ApiClientError, EMPTY_RESPONSE_CODE, isEmptyResponseSuccess } from './errors';

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
