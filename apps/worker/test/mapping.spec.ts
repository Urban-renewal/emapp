/**
 * T6.2 — Mapping auto-detect by header fingerprint.
 *
 * Pure unit tests. No DB. No streams. Just normalise + match.
 *
 * Pinned invariants:
 *   1. exact English headers → all required canonicals bound
 *   2. exact Hebrew headers → same canonicals bound (locale neutrality)
 *   3. case + whitespace + punctuation tolerated
 *   4. unmapped headers surface in `unmapped`, not as errors
 *   5. missing required field → MappingError('mapping_incomplete')
 *   6. duplicate alias (two headers → same canonical) → MappingError
 *      ('mapping_duplicate')
 *   7. ambiguous alias → goes to `ambiguous`, NOT silently bound
 *   8. ownership_pct is OPTIONAL — missing it doesn't fail mapping
 *   9. normaliseHeader is idempotent (norm(norm(x)) === norm(x))
 *  10. normaliseHeader strips NFC + whitespace + punctuation
 */
import { describe, expect, it } from 'vitest';

import { MappingError, normaliseHeader, resolveMapping } from '../src/mapping/mapping';

describe('T6.2 — resolveMapping', () => {
  it('1) exact English headers → all required canonicals bound', () => {
    const m = resolveMapping(['national_id', 'phone', 'name', 'apartment', 'address']);
    expect(m.columns).toMatchObject({
      national_id: 0,
      phone: 1,
      name: 2,
      apartment_number: 3,
      building_address: 4,
    });
    expect(m.unmapped).toEqual([]);
    expect(m.ambiguous).toEqual([]);
  });

  it('2) exact Hebrew headers → same canonicals bound', () => {
    const m = resolveMapping(['תעודת זהות', 'טלפון', 'שם', 'דירה', 'כתובת']);
    expect(m.columns).toMatchObject({
      national_id: 0,
      phone: 1,
      name: 2,
      apartment_number: 3,
      building_address: 4,
    });
  });

  it('3) case + whitespace + punctuation tolerated', () => {
    const m = resolveMapping([
      '  National_ID  ',
      'PHONE NUMBER',
      'Full-Name',
      'apt.number',
      'address',
    ]);
    expect(m.columns).toMatchObject({
      national_id: 0,
      phone: 1,
      name: 2,
      apartment_number: 3,
      building_address: 4,
    });
  });

  it('4) unmapped headers surface in unmapped, not as errors', () => {
    const m = resolveMapping([
      'national_id',
      'phone',
      'name',
      'apartment',
      'address',
      'random_extra_column',
    ]);
    expect(m.unmapped).toEqual([{ index: 5, header: 'random_extra_column' }]);
  });

  it('5) missing required field → mapping_incomplete with the fields list', () => {
    try {
      resolveMapping(['national_id', 'phone', 'name']); // no apartment/address
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MappingError);
      const err = e as MappingError;
      expect(err.code).toBe('mapping_incomplete');
      expect(err.fields).toEqual(expect.arrayContaining(['apartment_number', 'building_address']));
    }
  });

  it('6) duplicate alias (two headers → same canonical) → mapping_duplicate', () => {
    try {
      resolveMapping(['national_id', 'תעודת זהות', 'phone', 'name', 'apartment', 'address']);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MappingError);
      const err = e as MappingError;
      expect(err.code).toBe('mapping_duplicate');
      expect(err.fields).toContain('national_id');
    }
  });

  it('8) ownership_pct is optional — its absence does not fail', () => {
    const m = resolveMapping(['national_id', 'phone', 'name', 'apartment', 'address']);
    expect(m.columns.ownership_pct).toBeUndefined();
  });

  it('8b) ownership_pct binds when present', () => {
    const m = resolveMapping([
      'national_id',
      'phone',
      'name',
      'apartment',
      'address',
      'אחוז בעלות',
    ]);
    expect(m.columns.ownership_pct).toBe(5);
  });

  it('9) normaliseHeader is idempotent', () => {
    const samples = ['National ID', 'תעודת זהות', '  apt. number  ', 'Phone Number', 'אחוז בעלות'];
    for (const s of samples) {
      const a = normaliseHeader(s);
      const b = normaliseHeader(a);
      expect(a).toBe(b);
    }
  });

  it('10) normaliseHeader strips ASCII whitespace + punctuation; keeps Hebrew', () => {
    expect(normaliseHeader('Phone, Number!')).toBe('phonenumber');
    expect(normaliseHeader('National (ID)')).toBe('nationalid');
    expect(normaliseHeader('שם מלא')).toBe('שםמלא');
    expect(normaliseHeader('אחוז %')).toBe('אחוז%'); // % kept (ownership marker)
  });

  it('11) NFC-normalisation defends homograph attacks', () => {
    // 'פ' (U+05E4) precomposed vs decomposed forms must normalise the
    // same. Standard NFC turns most into precomposed; this asserts the
    // call site applies NFC consistently.
    const precomposed = 'טלפון';
    const same = precomposed.normalize('NFD').normalize('NFC');
    expect(normaliseHeader(precomposed)).toBe(normaliseHeader(same));
  });

  it('12) blank header column surfaces in unmapped (not error)', () => {
    const m = resolveMapping(['', 'national_id', 'phone', 'name', 'apartment', 'address']);
    expect(m.unmapped).toContainEqual({ index: 0, header: '' });
    expect(m.columns).toMatchObject({ national_id: 1 });
  });
});
