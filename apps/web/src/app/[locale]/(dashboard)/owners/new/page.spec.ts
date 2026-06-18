/**
 * FINDING-3 / FINDING-3b (E1-FLOW-TEST) — New-Owner create form.
 *
 * Node vitest env (no DOM): we mock react-hook-form so `handleSubmit(fn)`
 * returns `fn` directly (same technique as apartments/new/page.spec.ts),
 * letting us invoke the REAL component's `onSubmit` with crafted values and
 * assert what it does BEFORE the network — specifically the client-side
 * Israeli-ID Luhn guard (FINDING-3b) — and that the form wires the shared
 * error handler with NO PII-revealing override (FINDING-3 anti-enum).
 *
 * `isValidIsraeliId` from @emapp/validators is NOT mocked — the real Luhn
 * check runs, so `123456789` (9-digit shape-valid, checksum-INVALID) is the
 * genuine block case and a real valid ID passes through to the mutation.
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClientError } from '@/lib/api/errors';

// --- next-intl: surface the REAL he.json owner strings we assert on. ------
const OWNER_STR: Record<string, string> = {
  create: 'הוספת בעל דירה',
  creating: 'מוסיף...',
  addGenericError: 'לא ניתן להוסיף את בעל הדירה — בדקו את הפרטים ונסו שוב.',
  'field.invalidId': 'מספר ת.ז. אינו תקין — בדקו את הספרות ונסו שוב.',
  'field.idExists': 'ת.ז. זו כבר רשומה בארגון',
  'field.name': 'שם מלא',
  'field.nationalId': 'ת.ז. (9 ספרות)',
  'field.phone': 'טלפון',
  'field.email': 'אימייל',
  'field.notes': 'הערות',
  piiNote: 'PII',
};
vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => (key: string) => {
    if (ns === 'owners') return OWNER_STR[key] ?? `MISSING:owners.${key}`;
    // projects namespace (cancel / field.required) — inert markers.
    if (key === 'cancel') return 'ביטול';
    if (key === 'field.required') return 'שדה חובה';
    return `proj:${key}`;
  },
}));

const pushSpy = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushSpy, back: vi.fn() }),
}));

// --- the create mutation — controllable per-test. -------------------------
const mutateAsync = vi.fn();
vi.mock('@/hooks/use-owners', () => ({
  useCreateOwner: () => ({ mutateAsync }),
}));

// --- react-hook-form: capture the component's onSubmit so a test can fire
//     it with crafted values; record setError calls. -----------------------
let capturedOnSubmit: ((v: Record<string, unknown>) => unknown) | null = null;
const setErrorSpy = vi.fn();
vi.mock('react-hook-form', () => ({
  useForm: () => ({
    register: (name: string) => ({ name }),
    handleSubmit: (fn: (v: Record<string, unknown>) => unknown) => {
      capturedOnSubmit = fn;
      return fn;
    },
    setError: setErrorSpy,
    formState: { errors: {}, isSubmitting: false },
  }),
}));

// zodResolver is irrelevant to invoking the captured onSubmit directly.
vi.mock('@hookform/resolvers/zod', () => ({ zodResolver: () => undefined }));

// Capture the options the page passes to the shared error handler so we can
// assert the anti-enum config (no owner_exists override; generic fallback).
let handlerOpts: { codeOverrides?: Record<string, unknown>; fallback: () => string } | null = null;
const handleSpy = vi.fn();
vi.mock('@/hooks/use-api-error-handler', () => ({
  useApiErrorHandler: (opts: {
    codeOverrides?: Record<string, unknown>;
    fallback: () => string;
  }) => {
    handlerOpts = opts;
    return { serverError: null, handle: handleSpy, reset: vi.fn() };
  },
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...rest }: { children: ReactNode }) =>
    createElement('button', { ...rest }, children),
}));

import NewOwnerPage from './page';

beforeEach(() => {
  capturedOnSubmit = null;
  handlerOpts = null;
  mutateAsync.mockReset();
  setErrorSpy.mockClear();
  handleSpy.mockClear();
  pushSpy.mockClear();
  // Render once to wire up the captured onSubmit + handler options.
  renderToStaticMarkup(createElement(NewOwnerPage));
});
afterEach(() => vi.clearAllMocks());

describe('NewOwnerPage — FINDING-3b client-side national_id Luhn guard', () => {
  it('blocks an invalid-checksum national_id (123456789) BEFORE the POST', async () => {
    expect(capturedOnSubmit).toBeTypeOf('function');
    await capturedOnSubmit!({ name: 'דנה', national_id: '123456789' });
    // Field error set with the localized invalid-ID message…
    expect(setErrorSpy).toHaveBeenCalledWith('national_id', {
      type: 'validate',
      message: OWNER_STR['field.invalidId'],
    });
    // …and crucially the create was NOT attempted (no bad ID on the wire).
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('lets a valid Israeli ID through to the create mutation', async () => {
    mutateAsync.mockResolvedValue({ id: 'own-1' });
    // 203458179 — a genuine MOD-10-valid Israeli ID.
    await capturedOnSubmit!({ name: 'דנה', national_id: '203458179' });
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(setErrorSpy).not.toHaveBeenCalledWith(
      'national_id',
      expect.objectContaining({ type: 'validate' }),
    );
    expect(pushSpy).toHaveBeenCalledWith('/owners/own-1');
  });

  it('allows an owner SHELL (no national_id) — the Luhn guard only fires when an ID is present', async () => {
    mutateAsync.mockResolvedValue({ id: 'own-2' });
    await capturedOnSubmit!({ name: 'שלד' });
    expect(setErrorSpy).not.toHaveBeenCalled();
    expect(mutateAsync).toHaveBeenCalledTimes(1);
  });
});

describe('NewOwnerPage — FINDING-3 anti-enum (no PII oracle on duplicate)', () => {
  it('does NOT register an owner_exists override (so a duplicate 409 falls through to generic)', () => {
    expect(handlerOpts).not.toBeNull();
    expect(handlerOpts!.codeOverrides?.['owner_exists']).toBeUndefined();
  });

  it('the fallback is the GENERIC message, never the PII "this ID already exists" oracle', () => {
    const msg = handlerOpts!.fallback();
    expect(msg).toBe(OWNER_STR['addGenericError']);
    expect(msg).not.toBe(OWNER_STR['field.idExists']);
  });

  it('a server rejection (e.g. owner_exists 409) is routed through the shared handler, not swallowed', async () => {
    mutateAsync.mockRejectedValue(new ApiClientError({ code: 'owner_exists' }));
    await capturedOnSubmit!({ name: 'דנה', national_id: '203458179' });
    // The catch path delegates to the shared handler (which sets the generic
    // serverError) — the failure is surfaced, not silently dropped.
    expect(handleSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy).not.toHaveBeenCalled();
  });
});
