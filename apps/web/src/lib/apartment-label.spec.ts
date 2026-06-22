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

describe('formatApartmentLabel (FL-9 — building/floor disambiguation qualifier)', () => {
  it('base label is byte-for-byte unchanged when no context is passed', () => {
    // The whole-codebase compatibility guarantee: every existing call site that
    // passes only (number) or (number, prefix) keeps its pinned label exactly.
    expect(formatApartmentLabel('1')).toBe('דירה 1');
    expect(formatApartmentLabel('4', 'Apt')).toBe('Apt 4');
    expect(formatApartmentLabel('דירה 7')).toBe('דירה 7');
  });

  it('appends the Hebrew floor qualifier when a floor is supplied', () => {
    expect(formatApartmentLabel('1', 'דירה', { floor: 2 })).toBe('דירה 1 · קומה 2');
  });

  it('appends an English floor qualifier via floorWord', () => {
    expect(formatApartmentLabel('1', 'Apt', { floor: 2, floorWord: 'Floor' })).toBe(
      'Apt 1 · Floor 2',
    );
  });

  it('renders floor 0 (קומת קרקע is a real floor, not "absent")', () => {
    expect(formatApartmentLabel('1', 'דירה', { floor: 0 })).toBe('דירה 1 · קומה 0');
  });

  it('drops the floor segment gracefully when floor is null or undefined', () => {
    expect(formatApartmentLabel('1', 'דירה', { floor: null })).toBe('דירה 1');
    expect(formatApartmentLabel('1', 'דירה', {})).toBe('דירה 1');
  });

  it('appends a building qualifier when the project spans multiple buildings', () => {
    expect(formatApartmentLabel('1', 'דירה', { building: 'בניין א' })).toBe('דירה 1 · בניין א');
  });

  it('appends floor THEN building, in that order, when both are present', () => {
    expect(formatApartmentLabel('1', 'דירה', { floor: 2, building: 'בניין א' })).toBe(
      'דירה 1 · קומה 2 · בניין א',
    );
  });

  it('drops a blank / whitespace-only building segment', () => {
    expect(formatApartmentLabel('1', 'דירה', { building: '   ' })).toBe('דירה 1');
    expect(formatApartmentLabel('1', 'דירה', { building: null })).toBe('דירה 1');
  });

  it('bidi-strips the building segment (§v9-H-3 RTL-spoof defense, safe-by-default)', () => {
    const RLO = String.fromCharCode(0x202e); // right-to-left override
    const out = formatApartmentLabel('1', 'דירה', { building: `בניין${RLO}א` });
    expect(out).not.toContain(RLO);
    expect(out).toBe('דירה 1 · בנייןא');
  });

  it('keeps the no-double-prefix guard intact even with a floor qualifier', () => {
    // The number already carries "דירה" → it is NOT re-prefixed, and the floor
    // qualifier is still appended to the deduped base ("דירה דירה 7 · קומה 2"
    // must NEVER appear).
    expect(formatApartmentLabel('דירה 7', 'דירה', { floor: 2 })).toBe('דירה 7 · קומה 2');
    expect(formatApartmentLabel('  דירה 7  ', 'דירה', { floor: 2 })).toBe('דירה 7 · קומה 2');
  });
});
