/**
 * §SOLID-M6 closure pin — narrowLocale.
 */
import { describe, expect, it } from 'vitest';

import { narrowLocale } from './locale';

describe('narrowLocale', () => {
  it("returns 'en' for 'en'", () => {
    expect(narrowLocale('en')).toBe('en');
  });
  it("returns 'he' for 'he'", () => {
    expect(narrowLocale('he')).toBe('he');
  });
  it("returns 'he' for unknown locale", () => {
    expect(narrowLocale('ar')).toBe('he');
    expect(narrowLocale('')).toBe('he');
    expect(narrowLocale('en-US')).toBe('he');
  });
});
