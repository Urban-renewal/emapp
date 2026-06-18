/**
 * §SOLID-M7 + FINDING-3 (E1-FLOW-TEST) — the shared create-form error
 * handler. This is the single mechanism every create form routes a server
 * rejection through; FINDING-3 was that a 409 produced ZERO user feedback.
 *
 * The repo vitest env is `node` (no DOM / RTL), and `useApiErrorHandler`
 * uses only React's `useState` + `useCallback`. We stub those two primitives
 * with synchronous equivalents so the REAL hook body runs as plain logic and
 * we can drive `handle(...)` then read the resulting `serverError` — proving
 * the actual handler behavior, not a re-implementation.
 *
 * What is proven:
 *  1. A NON-ApiClientError → fallback (generic) serverError. (network/unknown
 *     failure is never silently swallowed.)
 *  2. An ApiClientError whose code has NO override → fallback (generic). This
 *     is the anti-enumeration contract for `owner_exists` / `member_exists` /
 *     `contractor_email_exists`: with the PII-revealing overrides removed, a
 *     duplicate 409 falls through to the generic message — NOT a per-field
 *     "this exact ID/email already exists" oracle (D.14 / D.19).
 *  3. A `validation_error` with a matching field → per-field setError, no
 *     generic serverError (safe, non-PII field errors stay specific).
 *  4. A code override that RETURNS A STRING → that string becomes serverError.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Synchronous React primitive stubs (node env, no renderer). ----------
// A single mutable slot models the one `useState` the hook declares.
let stateSlot: string | null = null;
const setStateSpy = vi.fn((v: string | null) => {
  stateSlot = v;
});

vi.mock('react', () => ({
  useState: <T>(init: T) => {
    // First (and only) useState call seeds the slot; subsequent reads see
    // whatever setState last wrote.
    if (stateSlot === null && typeof init !== 'function')
      stateSlot = init as unknown as string | null;
    return [stateSlot, setStateSpy];
  },
  // useCallback just returns the fn — no memoization needed for a logic test.
  useCallback: <F>(fn: F) => fn,
}));

import { ApiClientError } from '@/lib/api/errors';

import { useApiErrorHandler } from './use-api-error-handler';

const GENERIC = 'GENERIC_FALLBACK';

beforeEach(() => {
  stateSlot = null;
  setStateSpy.mockClear();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('useApiErrorHandler — FINDING-3 (no silent swallow) + anti-enum', () => {
  it('a NON-ApiClientError (network/unknown) sets the generic fallback — never silent', () => {
    const { handle } = useApiErrorHandler({ fallback: () => GENERIC });
    handle(new Error('socket hang up'));
    expect(setStateSpy).toHaveBeenCalledWith(GENERIC);
  });

  // The anti-enum duplicate codes — each handled in its own assertion so the
  // hook is never called in a loop (react-hooks/rules-of-hooks). A duplicate
  // code with no override must fall through to the generic, never surface the
  // code (or a PII-revealing message) verbatim.
  it.each(['owner_exists', 'member_exists', 'contractor_email_exists'])(
    'an ApiClientError "%s" with NO override → generic fallback (anti-enum)',
    (code) => {
      const { handle } = useApiErrorHandler({ fallback: () => GENERIC });
      handle(new ApiClientError({ code }));
      expect(setStateSpy).toHaveBeenCalledWith(GENERIC);
      expect(setStateSpy).not.toHaveBeenCalledWith(code);
    },
  );

  it('a code override that returns a STRING surfaces that string (e.g. non-PII RBAC `forbidden`)', () => {
    const { handle } = useApiErrorHandler({
      fallback: () => GENERIC,
      codeOverrides: { forbidden: () => 'NO_PERMISSION' },
    });
    handle(new ApiClientError({ code: 'forbidden' }));
    expect(setStateSpy).toHaveBeenCalledWith('NO_PERMISSION');
  });

  it('a validation_error with a matching field → per-field setError, NOT a generic serverError', () => {
    const setError = vi.fn();
    const { handle } = useApiErrorHandler<{ name: string }>({
      setError,
      fallback: () => GENERIC,
    });
    handle(
      new ApiClientError({
        code: 'validation_error',
        details: { name: ['too short'] },
      }),
    );
    expect(setError).toHaveBeenCalledWith('name', { type: 'server', message: 'too short' });
    // No generic when a field error was applied.
    expect(setStateSpy).not.toHaveBeenCalledWith(GENERIC);
  });
});
