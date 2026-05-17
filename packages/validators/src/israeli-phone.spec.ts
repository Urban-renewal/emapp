import { describe, it, expect } from 'vitest';

import { normalizeIsraeliPhone, isValidIsraeliPhone } from './israeli-phone';

describe('normalizeIsraeliPhone', () => {
  it('normalizes mobile with hyphens to E.164', () => {
    expect(normalizeIsraeliPhone('050-123-4567')).toBe('+972501234567');
  });

  it('normalizes mobile without hyphens to E.164', () => {
    expect(normalizeIsraeliPhone('0501234567')).toBe('+972501234567');
  });

  it('passes through already-normalized E.164', () => {
    expect(normalizeIsraeliPhone('+972501234567')).toBe('+972501234567');
  });

  it('handles E.164 with hyphens', () => {
    expect(normalizeIsraeliPhone('+972-50-123-4567')).toBe('+972501234567');
  });

  it('accepts 972 without + prefix', () => {
    expect(normalizeIsraeliPhone('972501234567')).toBe('+972501234567');
  });

  it('normalizes Tel Aviv landline (03)', () => {
    expect(normalizeIsraeliPhone('03-1234567')).toBe('+97231234567');
  });

  it('rejects unknown mobile prefix (e.g., 051)', () => {
    expect(normalizeIsraeliPhone('051-1234567')).toBeNull();
  });

  it('rejects too short numbers', () => {
    expect(normalizeIsraeliPhone('050-123')).toBeNull();
  });

  it('rejects too long numbers', () => {
    expect(normalizeIsraeliPhone('05012345678')).toBeNull();
  });

  it('rejects non-numeric characters in core digits', () => {
    expect(normalizeIsraeliPhone('050-12X-4567')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(normalizeIsraeliPhone('')).toBeNull();
  });

  it('rejects non-string input', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(normalizeIsraeliPhone(972501234567 as any)).toBeNull();
  });
});

describe('isValidIsraeliPhone', () => {
  it('returns true for valid input', () => {
    expect(isValidIsraeliPhone('050-1234567')).toBe(true);
  });

  it('returns false for invalid input', () => {
    expect(isValidIsraeliPhone('garbage')).toBe(false);
  });
});
