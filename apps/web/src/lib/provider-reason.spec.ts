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
  validateProviderReasonClient,
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

describe('§provider-reason — D2-DEF-2 validateProviderReasonClient (mirror of BE)', () => {
  it('VR1) a <20-char reason WITHOUT a ticket reference is REJECTED (the DEF-2 gap)', () => {
    // 8–19 chars used to pass the old gate (min 8) but `withProvider`
    // rejects them — the gate now rejects up-front.
    expect(validateProviderReasonClient('check tenant').ok).toBe(false); // 12 chars
    expect(validateProviderReasonClient('investigate').ok).toBe(false); // 11 chars
    expect(validateProviderReasonClient('a'.repeat(19)).ok).toBe(false);
  });

  it('VR2) a recognised ticket reference is accepted even when short', () => {
    expect(validateProviderReasonClient('INC-1234').ok).toBe(true);
    expect(validateProviderReasonClient('tkt-42').ok).toBe(true); // case-insensitive
    expect(validateProviderReasonClient('JIRA-OPS-77').ok).toBe(true);
  });

  it('VR3) substantive free text (≥20 chars, ≥3 tokens, ≥4 distinct) is accepted', () => {
    expect(validateProviderReasonClient('investigating tenant signup failure').ok).toBe(true);
    expect(validateProviderReasonClient('billing reconciliation for Q2 2026').ok).toBe(true);
  });

  it('VR4) ≥20 chars but low-quality (few tokens / few distinct chars) is rejected', () => {
    expect(validateProviderReasonClient('aaaaaaaaaaaaaaaaaaaaaa').ok).toBe(false); // 1 token, 1 distinct
    expect(validateProviderReasonClient('abcabcabcabcabcabcabc').ok).toBe(false); // 1 token
  });

  it('VR5) the accepted value is control-char-stripped + trimmed', () => {
    const r = validateProviderReasonClient('  investigating tenant signup failure  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('investigating tenant signup failure');
  });

  it('VR6) a >512-char reason is REJECTED (mirror of BE reason_too_long)', () => {
    const longReason = 'investigating tenant signup failure '.repeat(20); // ~720 chars
    const r = validateProviderReasonClient(longReason);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('too_long');
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
