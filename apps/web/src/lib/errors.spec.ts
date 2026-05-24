/**
 * Phase 4a S1 — pins the mapping from D.16 validation_error envelope
 * onto react-hook-form-shaped field errors. The API's Zod pipe emits
 * `{ code: 'validation_error', details: { <field>: [<message>, ...] } }`;
 * the FE must surface ONLY the first message per field (the user gets
 * one actionable hint, not a list).
 */
import { describe, expect, it } from 'vitest';

import { applyValidationErrors, isValidationError } from './errors';

describe('isValidationError', () => {
  it('1) accepts a well-formed validation_error envelope', () => {
    expect(
      isValidationError({
        code: 'validation_error',
        details: { email: ['Invalid email'], password: ['Too short', 'Missing digit'] },
      }),
    ).toBe(true);
  });

  it('2) rejects when code is wrong', () => {
    expect(
      isValidationError({
        code: 'invalid_credentials',
        details: { email: ['x'] },
      }),
    ).toBe(false);
  });

  it('3) rejects when details is missing', () => {
    expect(isValidationError({ code: 'validation_error' })).toBe(false);
  });

  it('4) rejects when details is an array (not a record)', () => {
    expect(isValidationError({ code: 'validation_error', details: ['email is required'] })).toBe(
      false,
    );
  });

  it('5) rejects when a field has a non-string entry (defense in depth)', () => {
    expect(
      isValidationError({
        code: 'validation_error',
        details: { email: [123] as unknown as string[] },
      }),
    ).toBe(false);
  });
});

describe('applyValidationErrors', () => {
  it('6) calls setError once per field with the FIRST message', () => {
    const calls: Array<[string, string]> = [];
    const applied = applyValidationErrors(
      {
        code: 'validation_error',
        details: { email: ['Invalid email', 'too long'], password: ['Too short'] },
      },
      (field, message) => calls.push([field, message]),
    );
    expect(calls).toEqual([
      ['email', 'Invalid email'],
      ['password', 'Too short'],
    ]);
    expect(applied).toEqual(['email', 'password']);
  });

  it('7) returns empty + does NOT call setError on non-validation_error envelopes', () => {
    const calls: Array<[string, string]> = [];
    const applied = applyValidationErrors(
      { code: 'invalid_credentials', message: 'no' },
      (field, message) => calls.push([field, message]),
    );
    expect(calls).toEqual([]);
    expect(applied).toEqual([]);
  });

  it('8) silently skips a field whose array is empty (defensive)', () => {
    const calls: Array<[string, string]> = [];
    applyValidationErrors(
      {
        code: 'validation_error',
        details: { email: ['x'], password: [] },
      },
      (field, message) => calls.push([field, message]),
    );
    expect(calls).toEqual([['email', 'x']]);
  });
});
