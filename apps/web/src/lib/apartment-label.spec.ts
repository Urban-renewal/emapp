/**
 * 7c F2 — formatApartmentLabel pins.
 *
 * The live multi-role smoke (V12 ledger 2026-06-12, finding F2) showed
 * "דירה דירה 7" on the S5d drill-down + tenant portal when
 * `apartments.number` already contains the word "דירה". This spec pins the
 * dedup rule for both adapters (project.ts S5d designation, portal.ts
 * tenant apartment line).
 */
import { describe, expect, it } from 'vitest';

import { formatApartmentLabel } from './apartment-label';

describe('formatApartmentLabel (7c F2 — no "דירה דירה" duplication)', () => {
  it('prepends the default Hebrew prefix to a bare number', () => {
    expect(formatApartmentLabel('7')).toBe('דירה 7');
    expect(formatApartmentLabel('3א')).toBe('דירה 3א');
  });

  it('does NOT prepend when the number already starts with "דירה "', () => {
    expect(formatApartmentLabel('דירה 7')).toBe('דירה 7');
    expect(formatApartmentLabel('  דירה 7  ')).toBe('דירה 7');
  });

  it('does NOT double an English prefix either', () => {
    expect(formatApartmentLabel('Apt 4', 'Apt')).toBe('Apt 4');
    expect(formatApartmentLabel('Apartment 12', 'Apt')).toBe('Apartment 12');
  });

  it('a Hebrew-prefixed number stays as-is under an English prefix (no "Apt דירה 7")', () => {
    expect(formatApartmentLabel('דירה 7', 'Apt')).toBe('דירה 7');
  });

  it('prepends the custom prefix to a bare number', () => {
    expect(formatApartmentLabel('4', 'Apt')).toBe('Apt 4');
  });

  it('does not treat a substring start as a prefix (needs the space boundary)', () => {
    expect(formatApartmentLabel('Aptos', 'Apt')).toBe('Apt Aptos');
  });
});
