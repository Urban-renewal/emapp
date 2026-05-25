/**
 * §provider-reason store — contract pin (D.37).
 *
 * Critical assertions:
 *  - SSR safety: every function tolerates `window === undefined`.
 *  - Whitespace-only reason → throws on set; returns null on read.
 *  - sessionStorage (not localStorage) — closing the tab clears the
 *    reason; new investigations require fresh intent (audit-trail
 *    truthfulness invariant).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PROVIDER_REASON_STORAGE_KEY,
  clearProviderReason,
  readProviderReason,
  setProviderReason,
} from './provider-reason';

const originalWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  // Use Node's real Map under the hood — same semantics as
  // sessionStorage for our purposes (set / get / removeItem).
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    sessionStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    },
  };
});
afterEach(() => {
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else (globalThis as { window?: unknown }).window = originalWindow;
});

describe('§provider-reason — set / read / clear', () => {
  it('1) empty store → readProviderReason returns null', () => {
    expect(readProviderReason()).toBeNull();
  });

  it('2) set valid reason → read returns the trimmed value', () => {
    setProviderReason('  incident #42  ');
    expect(readProviderReason()).toBe('incident #42');
  });

  it('3) set blank reason throws (operator MUST provide substantive text)', () => {
    expect(() => setProviderReason('')).toThrow();
    expect(() => setProviderReason('   ')).toThrow();
    expect(() => setProviderReason('\t\n')).toThrow();
    expect(readProviderReason()).toBeNull();
  });

  it('4) clear removes the stored reason', () => {
    setProviderReason('something');
    expect(readProviderReason()).toBe('something');
    clearProviderReason();
    expect(readProviderReason()).toBeNull();
  });

  it('5) value persists across multiple reads (sessionStorage semantics)', () => {
    setProviderReason('persistent');
    expect(readProviderReason()).toBe('persistent');
    expect(readProviderReason()).toBe('persistent');
    expect(readProviderReason()).toBe('persistent');
  });

  it('6) writes use the documented sessionStorage key (interop with manual ops debugging)', () => {
    expect(PROVIDER_REASON_STORAGE_KEY).toBe('emapp.provider.access_reason');
  });
});

describe('§provider-reason — SSR safety (window === undefined)', () => {
  it('7) read returns null on the server', () => {
    delete (globalThis as { window?: unknown }).window;
    expect(readProviderReason()).toBeNull();
  });

  it('8) set is a no-op on the server (does not throw beyond the empty guard)', () => {
    delete (globalThis as { window?: unknown }).window;
    expect(() => setProviderReason('valid reason')).not.toThrow();
  });

  it('9) clear is a no-op on the server', () => {
    delete (globalThis as { window?: unknown }).window;
    expect(() => clearProviderReason()).not.toThrow();
  });
});

describe('§provider-reason — storage failure isolation', () => {
  it('10) storage throwing on getItem → returns null (not a crash)', () => {
    (globalThis as { window?: unknown }).window = {
      sessionStorage: {
        getItem: () => {
          throw new Error('quota exceeded');
        },
        setItem: () => {},
        removeItem: () => {},
      },
    };
    expect(readProviderReason()).toBeNull();
  });

  it('11) storage throwing on setItem → silently no-op (no exception leaks)', () => {
    (globalThis as { window?: unknown }).window = {
      sessionStorage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('quota exceeded');
        },
        removeItem: () => {},
      },
    };
    expect(() => setProviderReason('valid reason text')).not.toThrow();
  });
});
