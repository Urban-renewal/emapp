/**
 * S3b — ownership share AS FRACTION, PRODUCT-PATH coverage (the gap the two
 * BLOCKED reviews flagged). The DB acceptance spec
 * (packages/db/test/ownership-share-fraction.spec.ts) drives raw SQL INSERTs,
 * which BYPASS the Zod + service layer where the feature was actually broken
 * (the array refine enforced a pct-epsilon Σ≈100 that REJECTED a faithful
 * thirds split). These tests drive the REAL write path:
 *
 *     SetOwnershipsInput (Zod)  →  OwnershipsService.replaceSet  →  COMMIT
 *
 * Positive: a thirds split (1/3 + 1/3 + 1/3 as EXPLICIT fractions) COMMITS
 *   (was RED before FIX 1 — the pct-epsilon refine rejected derived pct 99.99).
 * Negatives: an owner set that does NOT sum to 1 (1/3 + 1/3) is REJECTED with
 *   the ownership-sum 400; a 0-numerator owner is REJECTED.
 *
 * Real DB (Neon) — the trigger + the service are both exercised end-to-end.
 *
 * Run:
 *   infisical run --env=dev -- pnpm --filter @emapp/api exec \
 *     vitest run src/modules/ownerships/share-fraction-product-path.spec.ts
 */
import { randomUUID } from 'node:crypto';

import { apartments, buildings, encryptOwnerPii, owners, withTenant } from '@emapp/db';
import { BadRequestException } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { OwnershipsService } from './ownerships.service';

let ownSvc: OwnershipsService;
let org: TestOrg;
let managerId: string;

const MGR_SID = '00000000-0000-4000-8000-00000000b001';

function manager(orgId = org.id): AccessTokenPayload {
  return {
    sub: managerId,
    orgId,
    role: 'manager',
    sid: MGR_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

function natId(): string {
  return String(Math.floor(100_000_000 + Math.random() * 899_999_999));
}

async function seedOwner(orgId: string): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, {
      nationalId: natId(),
      name: 'בעלים',
      phone: '0541112222',
    });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId,
        nameEncrypted: pii.nameEncrypted,
        nameHash: pii.nameHash,
        email: `owner-${randomUUID()}@test.local`,
        nationalIdEncrypted: pii.nationalIdEncrypted,
        nationalIdHash: pii.nationalIdHash,
        phoneEncrypted: pii.phoneEncrypted,
        phoneHash: pii.phoneHash,
      })
      .returning({ id: owners.id });
    return row!.id;
  });
}

/** Fresh apartment (new building) per call → the per-apartment trigger is
 *  isolated and the unique-active (apartment,owner) index never collides. */
async function seedApartment(orgId: string): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const [bld] = await tx
      .insert(buildings)
      .values({
        projectId: org.projects[0]!.id,
        address: `ShareFraction ${Date.now()}-${Math.random()}`,
        city: 'Tel Aviv',
      })
      .returning({ id: buildings.id });
    const [apt] = await tx
      .insert(apartments)
      .values({ buildingId: bld!.id, number: `A-${Date.now()}-${Math.random()}` })
      .returning({ id: apartments.id });
    return apt!.id;
  });
}

/** EXACT persisted fraction sum over active OWNER rows, read via BYPASSRLS,
 *  computed by INTEGER cross-multiplication (mirrors the trigger — NOT
 *  `SUM(num/den)`, whose numeric division truncates 1/3 to 0.999…). Returns
 *  `1`, `0`, or a `frac/L` string so the caller can assert EXACT equality.
 *  Independent of any org GUC. */
async function ownerFractionSum(apartmentId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const rows = await c.query<{ num: string; den: string }>(
      `SELECT share_numerator AS num, share_denominator AS den FROM ownerships
       WHERE apartment_id = $1 AND ended_at IS NULL AND relationship = 'owner'`,
      [apartmentId],
    );
    if (rows.rows.length === 0) return '0';
    const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));
    let lcm = 1n;
    for (const r of rows.rows) {
      const den = BigInt(r.den);
      lcm = (lcm / gcd(lcm, den)) * den;
    }
    let sum = 0n;
    for (const r of rows.rows) {
      sum += BigInt(r.num) * (lcm / BigInt(r.den));
    }
    if (sum === 0n) return '0';
    if (sum === lcm) return '1';
    return `${sum}/${lcm}`;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  ownSvc = new OwnershipsService();
  const tag = `share-frac-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
}, 120_000);

describe('S3b product path — SetOwnershipsInput → replaceSet (fraction sum = 1)', () => {
  it('P1) ACCEPTS a faithful thirds split (1/3 + 1/3 + 1/3 as explicit fractions) → COMMIT, fraction sum exactly 1', async () => {
    // The headline case the feature exists for, and the one FIX 1 unblocked:
    // the three derived display pcts are 33.33 (Σ 99.99 ≠ 100), which the old
    // pct-epsilon refine REJECTED. The exact fraction (3 × 1/3 = 1) governs now.
    const apt = await seedApartment(org.id);
    const o1 = await seedOwner(org.id);
    const o2 = await seedOwner(org.id);
    const o3 = await seedOwner(org.id);

    const created = await ownSvc.replaceSet(manager(), apt, {
      owners: [
        {
          ownerId: o1,
          ownershipPct: 33.33,
          relationship: 'owner',
          shareNumerator: 1,
          shareDenominator: 3,
        },
        {
          ownerId: o2,
          ownershipPct: 33.33,
          relationship: 'owner',
          shareNumerator: 1,
          shareDenominator: 3,
        },
        {
          ownerId: o3,
          ownershipPct: 33.33,
          relationship: 'owner',
          shareNumerator: 1,
          shareDenominator: 3,
        },
      ],
    });
    expect(created).toHaveLength(3);
    // Each row persisted the EXACT fraction (1/3), not a lossy pct round-trip.
    for (const row of created) {
      expect(row.shareNumerator).toBe(1);
      expect(row.shareDenominator).toBe(3);
    }
    // The persisted owner fractions sum to EXACTLY 1 (numeric, no 0.9999 drift).
    expect(await ownerFractionSum(apt)).toBe('1');
  }, 30_000);

  it('P2) REJECTS an incomplete split (1/3 + 1/3, sum 2/3 ≠ 1) at the API with ownership_sum_invalid → nothing committed', async () => {
    const apt = await seedApartment(org.id);
    const o1 = await seedOwner(org.id);
    const o2 = await seedOwner(org.id);

    await expect(
      ownSvc.replaceSet(manager(), apt, {
        owners: [
          {
            ownerId: o1,
            ownershipPct: 33.33,
            relationship: 'owner',
            shareNumerator: 1,
            shareDenominator: 3,
          },
          {
            ownerId: o2,
            ownershipPct: 33.33,
            relationship: 'owner',
            shareNumerator: 1,
            shareDenominator: 3,
          },
        ],
      }),
    ).rejects.toMatchObject({ response: { error: { code: 'ownership_sum_invalid' } } });
    // Atomic: nothing was committed for the apartment.
    expect(await ownerFractionSum(apt)).toBe('0');
  }, 30_000);

  // ── P4 / P5 — LARGE-DENOMINATOR BOUNDARY: the BigInt refine MIRRORS the
  // trigger past 2^53 (the CRITICAL the re-review BLOCKED on). The set
  //   1/2 + 1/3 + 1/6, each fraction SCALED by a distinct large coprime prime
  // so the STORED denominators are distinct and near DEN_MAX (999958, 999993,
  // 999942) yet the VALUE is unchanged. Their LCM ≈ 1.666e17 is ABOVE
  // Number.MAX_SAFE_INTEGER (2^53 ≈ 9.007e15) — the regime where the OLD JS
  // `number` cross-multiply was no longer provably exact. The BigInt refine is
  // exact here, and it AGREES with the trigger's exact integer path.
  //
  // 1/2 = 499979/999958, 1/3 = 333331/999993, 1/6 = 166657/999942.
  const LARGE = {
    half: { ownerId: '', ownershipPct: 50, shareNumerator: 499979, shareDenominator: 999958 },
    third: { ownerId: '', ownershipPct: 33.33, shareNumerator: 333331, shareDenominator: 999993 },
    sixth: { ownerId: '', ownershipPct: 16.67, shareNumerator: 166657, shareDenominator: 999942 },
  } as const;

  it('P4) ACCEPTS a large-denominator exact-1 set (1/2+1/3+1/6 over DISTINCT ~1e6 denominators, LCM > 2^53) → COMMIT, fraction sum exactly 1', async () => {
    const apt = await seedApartment(org.id);
    const o1 = await seedOwner(org.id);
    const o2 = await seedOwner(org.id);
    const o3 = await seedOwner(org.id);

    const created = await ownSvc.replaceSet(manager(), apt, {
      owners: [
        { ...LARGE.half, ownerId: o1, relationship: 'owner' },
        { ...LARGE.third, ownerId: o2, relationship: 'owner' },
        { ...LARGE.sixth, ownerId: o3, relationship: 'owner' },
      ],
    });
    expect(created).toHaveLength(3);
    // The persisted owner fractions sum to EXACTLY 1 — the trigger ACCEPTED the
    // COMMIT (it would have RAISED otherwise), and ownerFractionSum (BigInt,
    // independent of the refine) confirms it. The two enforcement layers AGREE
    // above 2^53.
    expect(await ownerFractionSum(apt)).toBe('1');
  }, 30_000);

  it('P5) REJECTS a large-denominator off-by-one set (n3 bumped +1, still derived-pct 16.67) at the REFINE with ownership_sum_invalid → nothing committed (NOT a COMMIT-time trigger raise)', async () => {
    // Same distinct ~1e6 denominators (LCM > 2^53), but the sixth owner's
    // numerator is bumped 166657 → 166658, so the exact fraction sum is
    // lcm + (lcm/999942) ≠ 1. CRUCIALLY the derived display pct still rounds to
    // 16.67 (Σ pct = 100), so a pct-epsilon check would FALSELY ACCEPT this
    // non-summing set — exactly the hole the float path risked. The BigInt
    // fraction refine catches it: a 400 ownership_sum_invalid raised at the
    // refine in replaceSet, BEFORE any INSERT — proving the refine (not the
    // trigger backstop) holds the line, in agreement with the trigger.
    const apt = await seedApartment(org.id);
    const o1 = await seedOwner(org.id);
    const o2 = await seedOwner(org.id);
    const o3 = await seedOwner(org.id);

    await expect(
      ownSvc.replaceSet(manager(), apt, {
        owners: [
          { ...LARGE.half, ownerId: o1, relationship: 'owner' },
          { ...LARGE.third, ownerId: o2, relationship: 'owner' },
          {
            ownerId: o3,
            ownershipPct: 16.67,
            relationship: 'owner',
            shareNumerator: 166658, // +1 → exact sum ≠ 1, but derived pct still 16.67
            shareDenominator: 999942,
          },
        ],
      }),
    ).rejects.toMatchObject({ response: { error: { code: 'ownership_sum_invalid' } } });
    // Atomic + caught at the refine: nothing was committed for the apartment.
    expect(await ownerFractionSum(apt)).toBe('0');
  }, 30_000);

  it('P3) REJECTS a 0-numerator OWNER (0/1 share) at the API → BadRequest, nothing committed', async () => {
    // A 0-share owner is an invalid legal record (mirrors the pct>0 rule). The
    // shareEntry refine rejects it before the set-sum is even considered.
    const apt = await seedApartment(org.id);
    const o1 = await seedOwner(org.id);
    const o2 = await seedOwner(org.id);

    await expect(
      ownSvc.replaceSet(manager(), apt, {
        owners: [
          {
            ownerId: o1,
            ownershipPct: 100,
            relationship: 'owner',
            shareNumerator: 1,
            shareDenominator: 1,
          },
          // pct must be > 0 for an owner too, but supply 0.01 to isolate the
          // 0-NUMERATOR rejection specifically (fraction is canonical).
          {
            ownerId: o2,
            ownershipPct: 0.01,
            relationship: 'owner',
            shareNumerator: 0,
            shareDenominator: 1,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await ownerFractionSum(apt)).toBe('0');
  }, 30_000);
});
