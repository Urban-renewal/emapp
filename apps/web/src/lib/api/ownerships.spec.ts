/**
 * Phase 4a S6 — pins the FE-side D.25 enforcement.
 *
 * The shared-types `SetOwnershipsInput` refine is the FIRST line of
 * defense: a malformed body should never reach `putOwnerships()`.
 * Server-side Zod + the locked Phase-1 sum-100 trigger are layers
 * 2 and 3. This spec exercises the layer-1 refine via the same
 * `parse`/`safeParse` calls the FE call sites use.
 */
import { SetOwnershipsInput } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

describe('SetOwnershipsInput — D.25 sum-100 refine', () => {
  it('1) empty owners array is legal (means "clear all")', () => {
    expect(SetOwnershipsInput.safeParse({ owners: [] }).success).toBe(true);
  });

  it('2) sum == 100 is legal', () => {
    expect(
      SetOwnershipsInput.safeParse({
        owners: [
          { ownerId: '11111111-1111-1111-1111-111111111111', ownershipPct: 50 },
          { ownerId: '22222222-2222-2222-2222-222222222222', ownershipPct: 50 },
        ],
      }).success,
    ).toBe(true);
  });

  it('3) sum != 100 is rejected', () => {
    const r = SetOwnershipsInput.safeParse({
      owners: [
        { ownerId: '11111111-1111-1111-1111-111111111111', ownershipPct: 50 },
        { ownerId: '22222222-2222-2222-2222-222222222222', ownershipPct: 49 },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('4) duplicate ownerId is rejected even when sum == 100', () => {
    const r = SetOwnershipsInput.safeParse({
      owners: [
        { ownerId: '11111111-1111-1111-1111-111111111111', ownershipPct: 50 },
        { ownerId: '11111111-1111-1111-1111-111111111111', ownershipPct: 50 },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('5) tiny float-add drift (sum 99.999...) is accepted within EPSILON', () => {
    const r = SetOwnershipsInput.safeParse({
      owners: [
        { ownerId: '11111111-1111-1111-1111-111111111111', ownershipPct: 33.34 },
        { ownerId: '22222222-2222-2222-2222-222222222222', ownershipPct: 33.33 },
        { ownerId: '33333333-3333-3333-3333-333333333333', ownershipPct: 33.33 },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('6) 0% share is rejected (use empty array to clear, not a 0% row)', () => {
    const r = SetOwnershipsInput.safeParse({
      owners: [{ ownerId: '11111111-1111-1111-1111-111111111111', ownershipPct: 0 }],
    });
    expect(r.success).toBe(false);
  });

  it('7) > 50 owners is rejected at the array.max boundary', () => {
    const owners = Array.from({ length: 51 }, (_, i) => ({
      ownerId: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
      ownershipPct: 100 / 51,
    }));
    expect(SetOwnershipsInput.safeParse({ owners }).success).toBe(false);
  });
});
