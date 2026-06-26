/**
 * Slice 2.1 — the bulk-generate contract: the DTO bounds + the PURE numbering
 * generator that is the ONE source of truth shared by the BE (loops it to
 * insert) and the FE (previews first/last/count). A drift here would mean the
 * manager's preview no longer matches what gets created.
 */
import { describe, expect, it } from 'vitest';

import { GenerateApartmentsInput, buildApartmentNumbers } from './apartment';

describe('GenerateApartmentsInput — DTO bounds (fail-closed)', () => {
  it('accepts a valid shape and defaults the scheme to sequential', () => {
    const r = GenerateApartmentsInput.safeParse({ floors: 4, apartmentsPerFloor: 3 });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.scheme).toBe('sequential');
  });

  it('rejects floors/perFloor below 1 and above the caps', () => {
    expect(GenerateApartmentsInput.safeParse({ floors: 0, apartmentsPerFloor: 3 }).success).toBe(
      false,
    );
    expect(GenerateApartmentsInput.safeParse({ floors: 81, apartmentsPerFloor: 3 }).success).toBe(
      false,
    );
    expect(GenerateApartmentsInput.safeParse({ floors: 3, apartmentsPerFloor: 41 }).success).toBe(
      false,
    );
  });

  it('rejects a total over 500 apartments', () => {
    // 80 × 40 = 3200 > 500.
    const r = GenerateApartmentsInput.safeParse({ floors: 80, apartmentsPerFloor: 40 });
    expect(r.success).toBe(false);
    // ...but 50 × 10 = 500 is exactly allowed.
    expect(GenerateApartmentsInput.safeParse({ floors: 50, apartmentsPerFloor: 10 }).success).toBe(
      true,
    );
  });

  it('rejects unknown fields (strict) and an out-of-enum scheme', () => {
    expect(
      GenerateApartmentsInput.safeParse({ floors: 1, apartmentsPerFloor: 1, bogus: true }).success,
    ).toBe(false);
    expect(
      GenerateApartmentsInput.safeParse({ floors: 1, apartmentsPerFloor: 1, scheme: 'spiral' })
        .success,
    ).toBe(false);
  });
});

describe('buildApartmentNumbers — deterministic numbering', () => {
  it('sequential: 1..N across floors, tracking the floor', () => {
    const out = buildApartmentNumbers({ floors: 3, apartmentsPerFloor: 2, scheme: 'sequential' });
    expect(out.map((a) => a.number)).toEqual(['1', '2', '3', '4', '5', '6']);
    // floor-major: first two on floor 1, next two on floor 2, last two on floor 3.
    expect(out.map((a) => a.floor)).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it('floorBased: floor*100+unit (101,102 / 201,202 …)', () => {
    const out = buildApartmentNumbers({ floors: 2, apartmentsPerFloor: 3, scheme: 'floorBased' });
    expect(out.map((a) => a.number)).toEqual(['101', '102', '103', '201', '202', '203']);
  });

  it('floorBased honours startFloor 0 (ground/קרקע)', () => {
    const out = buildApartmentNumbers({
      floors: 2,
      apartmentsPerFloor: 2,
      scheme: 'floorBased',
      startFloor: 0,
    });
    // floor 0 → 0*100+u = 1,2; floor 1 → 101,102.
    expect(out.map((a) => a.number)).toEqual(['1', '2', '101', '102']);
    expect(out.map((a) => a.floor)).toEqual([0, 0, 1, 1]);
  });

  it('produces exactly floors×apartmentsPerFloor entries', () => {
    expect(
      buildApartmentNumbers({ floors: 7, apartmentsPerFloor: 4, scheme: 'sequential' }),
    ).toHaveLength(28);
  });
});
