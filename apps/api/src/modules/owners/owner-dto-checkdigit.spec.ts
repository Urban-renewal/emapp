import { describe, expect, it } from 'vitest';

import { CreateOwnerDto, UpdateOwnerDto } from './owner.dto';

/**
 * S0-SEC / SECURITY-POSTURE P0.3 — REGRESSION LOCK on the Israeli national_id
 * check-digit (MOD-10) refine.
 *
 * The refine already ships (`owner.dto.ts`, validator-backed). This pins it:
 * a structurally-valid-but-checksum-INVALID national_id (`123456789`) MUST be
 * rejected by `CreateOwnerDto` / `UpdateOwnerDto.safeParse`, with the failure
 * pathed at `national_id`. A future refactor that silently drops the refine
 * (a real PII-integrity regression) turns this test RED.
 *
 * Pure schema test — no DB, no DI. `owners-adversarial.spec.ts` already covers
 * the VALID-id round-trip end-to-end; this is the fast, isolated lock.
 */
describe('P0.3 — national_id check-digit refine is locked', () => {
  it('CreateOwnerDto rejects a 9-digit national_id with an invalid checksum', () => {
    const r = CreateOwnerDto.safeParse({ name: 'בדיקה', national_id: '123456789' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.flatten().fieldErrors.national_id).toBeDefined();
    }
  });

  it('UpdateOwnerDto rejects a 9-digit national_id with an invalid checksum', () => {
    const r = UpdateOwnerDto.safeParse({ national_id: '123456789' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.flatten().fieldErrors.national_id).toBeDefined();
    }
  });

  it('CreateOwnerDto accepts a national_id with a VALID checksum (refine is not a blanket reject)', () => {
    const r = CreateOwnerDto.safeParse({ name: 'בדיקה', national_id: '038123451' });
    expect(r.success).toBe(true);
  });
});
