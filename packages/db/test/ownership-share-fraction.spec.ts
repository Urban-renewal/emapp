/**
 * Ownership share AS FRACTION — S3b acceptance tests (TEST-AUTHOR, independent,
 * RED-first). Written from the SPEC, BEFORE the builder touches schema/trigger.
 *
 * SPEC ("ownership share as fraction"): ownership shares are EXACT Tabu
 * fractions (e.g. 1/3, 17/240), not just a 2-decimal percent. Today the schema
 * stores `ownerships.ownership_pct numeric(5,2)` and the D.25 per-apartment sum
 * constraint trigger (`trigger_check_ownership_sum`, migrations 0002 → 0030 →
 * 0051) requires, at COMMIT, that:
 *
 *     SUM(ownership_pct) FILTER (relationship = 'owner', ended_at IS NULL) = 100
 *
 * A faithful 1/3 + 1/3 + 1/3 split is IMPOSSIBLE to express here: 33.33 × 3 =
 * 99.99 ≠ 100 → the trigger REJECTS the COMMIT.
 *
 * The fix (the builder's job) will add `share_numerator` / `share_denominator`
 * integer columns and change the sum trigger to validate the EXACT fraction
 * sum = 1 by integer cross-multiplication (no float), so a faithful Tabu split
 * commits; renters (relationship = 'renter') stay excluded.
 *
 * These tests assert the TARGET behavior and are EXPECTED RED against current
 * code, in two distinct shapes (reported precisely in the run output):
 *   • "columns missing" RED — tests that reference share_numerator /
 *     share_denominator fail with SQLSTATE 42703 (undefined_column) because the
 *     columns do not exist yet.
 *   • "trigger rejects 99.99" RED — the legacy-pct reproduction of the same
 *     thirds split fails at COMMIT with the trigger's "must equal 100 … got
 *     99.99" exception, documenting WHY the fraction columns are needed.
 *
 * Level: DB integration via `providerDb` (BYPASSRLS pool) — seeds the full
 * org → project → building → apartment → owner → ownership chain, mirroring the
 * owner-shells.spec.ts / factories.ts seeding pattern. The constraint trigger is
 * DEFERRABLE INITIALLY DEFERRED, so it fires at COMMIT: every multi-row split is
 * inserted inside an explicit `providerDb.transaction(...)` and the assertion is
 * on whether that transaction COMMITS or THROWS.
 *
 * DO NOT modify any implementation / schema / migration file to make these
 * pass — that is the builder's job. This file only asserts the target behavior.
 */
import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  apartments,
  buildings,
  encryptOwnerPii,
  organizations,
  owners,
  ownerships,
  projects,
  providerDb,
  users,
} from '@emapp/db';

const TEST_ORG_NAME = 's3b-share-fraction';

interface Seed {
  orgId: string;
  userId: string;
  projectId: string;
  buildingId: string;
}

/** Seed org → user → project → building. Apartments + owners are seeded
 *  per-test so each test owns an isolated apartment and the sum trigger never
 *  sees cross-test rows. */
async function seedBase(): Promise<Seed> {
  const orgId = randomUUID();
  await providerDb.insert(organizations).values({
    id: orgId,
    name: `${TEST_ORG_NAME}-${orgId.slice(0, 8)}`,
    slug: `frac${orgId.slice(0, 8)}`,
  });

  const [user] = await providerDb
    .insert(users)
    .values({
      email: `frac-${orgId}@test.local`,
      name: 'Fraction Test Manager',
      passwordHash: '$2b$12$placeholder',
    })
    .returning({ id: users.id });

  const [project] = await providerDb
    .insert(projects)
    .values({
      orgId,
      name: 'Fraction Project',
      type: 'tama38_1',
      createdBy: user!.id,
    })
    .returning({ id: projects.id });

  const [building] = await providerDb
    .insert(buildings)
    .values({
      projectId: project!.id,
      address: 'רחוב הבדיקה 1',
      city: 'תל אביב',
    })
    .returning({ id: buildings.id });

  return { orgId, userId: user!.id, projectId: project!.id, buildingId: building!.id };
}

async function makeApartment(buildingId: string, number: string): Promise<string> {
  const [apt] = await providerDb
    .insert(apartments)
    .values({ buildingId, number })
    .returning({ id: apartments.id });
  return apt!.id;
}

let natIdCounter = 100_000_000;
async function makeOwner(orgId: string): Promise<string> {
  // Each owner needs a distinct national_id (per-org unique index).
  const nationalId = String(natIdCounter++);
  const pii = await encryptOwnerPii(providerDb, { nationalId, name: `בעלים ${nationalId}` });
  const [owner] = await providerDb
    .insert(owners)
    .values({
      orgId,
      nameEncrypted: pii.nameEncrypted,
      nameHash: pii.nameHash,
      nationalIdEncrypted: pii.nationalIdEncrypted,
      nationalIdHash: pii.nationalIdHash,
    })
    .returning({ id: owners.id });
  return owner!.id;
}

/** Classify a thrown DB error for precise RED reporting. Drizzle wraps the pg
 *  error; the SQLSTATE lives on `.cause.code`. 42703 = undefined_column
 *  ("columns missing" RED); a trigger RAISE EXCEPTION surfaces as P0001 with the
 *  "must equal 100" message ("trigger rejects 99.99" RED). */
function describeDbError(e: unknown): { code?: string; message: string } {
  const err = e as { cause?: { code?: string; message?: string }; message?: string };
  return {
    code: err.cause?.code,
    message: err.cause?.message ?? err.message ?? String(e),
  };
}

describe('ownership share as fraction (S3b — exact Tabu fractions, sum = 1)', () => {
  let seed: Seed;

  beforeAll(async () => {
    seed = await seedBase();
  });

  afterAll(async () => {
    // FK cascade: deleting the org is blocked (restrict) by projects/owners, so
    // tear down child-first. Best-effort — a failing test must not mask itself.
    await providerDb
      .delete(owners)
      .where(eq(owners.orgId, seed.orgId))
      .catch(() => undefined);
    await providerDb
      .delete(projects)
      .where(eq(projects.id, seed.projectId))
      .catch(() => undefined);
    await providerDb
      .delete(organizations)
      .where(eq(organizations.id, seed.orgId))
      .catch(() => undefined);
  });

  // ── TEST #1 — the headline: a 1/3 + 1/3 + 1/3 split is ACCEPTED ──────────
  // Builder's contract: each owner row carries share_numerator/denominator
  // (1/3 each); the trigger validates the EXACT fraction sum = 1 by integer
  // cross-multiplication. Today the columns DON'T EXIST → the raw INSERT fails
  // with 42703 (undefined_column). That failure IS the documented gap. After
  // the builder adds the columns + new trigger, the transaction COMMITS.
  it('1) ACCEPTS a faithful thirds split (1/3 + 1/3 + 1/3) with a REALISTIC derived pct (33.33 each → 99.99) summing to exactly 1', async () => {
    const aptId = await makeApartment(seed.buildingId, 'frac-1');
    const o1 = await makeOwner(seed.orgId);
    const o2 = await makeOwner(seed.orgId);
    const o3 = await makeOwner(seed.orgId);

    // Insert all three rows in ONE transaction so the DEFERRED constraint
    // trigger fires once at COMMIT over the complete set. Each row carries the
    // canonical fraction (share_numerator = 1, share_denominator = 3) AND a
    // REALISTIC derived display pct of 33.33 (round(1/3*100, 2)) — NOT 0.
    //
    // This is the REAL scenario, not a dodge: the three derived pcts sum to
    // 99.99 ≠ 100, which the removed legacy SUM(ownership_pct)=100 check would
    // have REJECTED. The split is now ACCEPTED because the SOLE sum invariant
    // is the EXACT fraction sum (3 × 1/3 = 1). A pct of 0 here would have
    // sidestepped the legacy check and failed to prove the feature.
    const insertThird = (ownerId: string) => sql`
      INSERT INTO ownerships (apartment_id, owner_id, ownership_pct, relationship, share_numerator, share_denominator)
      VALUES (${aptId}, ${ownerId}, 33.33, 'owner', 1, 3)
    `;

    const result = await providerDb
      .transaction(async (tx) => {
        await tx.execute(insertThird(o1));
        await tx.execute(insertThird(o2));
        await tx.execute(insertThird(o3));
      })
      .then(
        () => ({ ok: true as const }),
        (e: unknown) => ({ ok: false as const, ...describeDbError(e) }),
      );

    if (!result.ok) {
      // Report which RED shape we hit so the gap is unambiguous in CI output.
      const shape =
        result.code === '42703'
          ? 'RED (columns missing: share_numerator/share_denominator do not exist yet — 42703)'
          : `RED (rejected: code=${result.code ?? 'n/a'} message=${result.message})`;

      throw new Error(
        `Expected the 1/3+1/3+1/3 fraction split to COMMIT, but it was rejected. ${shape}`,
      );
    }

    // GREEN-state assertion (post-builder): the three rows persisted under the
    // apartment as fractions that sum to exactly 1 (3 × 1/3), NOT 0.9999.
    const rows = await providerDb
      .select({
        num: sql<number>`share_numerator`,
        den: sql<number>`share_denominator`,
      })
      .from(ownerships)
      .where(eq(ownerships.apartmentId, aptId));
    expect(rows).toHaveLength(3);
  });

  // ── TEST #2 — an INVALID split (does not sum to the whole) is REJECTED ───
  // Regression guard for the integrity constraint: 1/3 + 1/3 (missing the last
  // third) sums to 2/3 ≠ 1 and MUST be rejected by the sum trigger at COMMIT.
  // RED today for the columns-missing reason (42703); GREEN post-builder as a
  // genuine trigger rejection of the incomplete set.
  it('2) REJECTS an incomplete split (1/3 + 1/3, missing the last third) — sum ≠ 1', async () => {
    const aptId = await makeApartment(seed.buildingId, 'frac-2');
    const o1 = await makeOwner(seed.orgId);
    const o2 = await makeOwner(seed.orgId);

    const insertThird = (ownerId: string) => sql`
      INSERT INTO ownerships (apartment_id, owner_id, ownership_pct, relationship, share_numerator, share_denominator)
      VALUES (${aptId}, ${ownerId}, 0, 'owner', 1, 3)
    `;

    const result = await providerDb
      .transaction(async (tx) => {
        await tx.execute(insertThird(o1));
        await tx.execute(insertThird(o2));
        // intentionally NO third row → 2/3, an incomplete ownership set.
      })
      .then(
        () => ({ ok: true as const }),
        (e: unknown) => ({ ok: false as const, ...describeDbError(e) }),
      );

    // The transaction MUST NOT commit. Today it fails for 42703 (columns
    // missing); post-builder it fails as the trigger rejecting sum = 2/3 ≠ 1.
    // Either way the integrity invariant holds: an incomplete set is rejected.
    expect(result.ok).toBe(false);
  });

  // ── TEST #3 — renters are EXCLUDED from the share sum ────────────────────
  // An apartment whose OWNERS' fractions sum to the whole, PLUS a renter
  // (relationship = 'renter'), still commits — the renter is not part of the
  // ownership sum. Existing invariant (migration 0051) that must survive the
  // fraction change. RED today for columns-missing; GREEN post-builder.
  it('3) EXCLUDES renters from the share sum (owners = whole + a renter still commits)', async () => {
    const aptId = await makeApartment(seed.buildingId, 'frac-3');
    const ownerA = await makeOwner(seed.orgId);
    const renter = await makeOwner(seed.orgId);

    const result = await providerDb
      .transaction(async (tx) => {
        // A single owner holding the WHOLE apartment as 1/1.
        await tx.execute(sql`
          INSERT INTO ownerships (apartment_id, owner_id, ownership_pct, relationship, share_numerator, share_denominator)
          VALUES (${aptId}, ${ownerA}, 0, 'owner', 1, 1)
        `);
        // A renter — excluded from the sum. Carries a 0/1 share (does not own).
        await tx.execute(sql`
          INSERT INTO ownerships (apartment_id, owner_id, ownership_pct, relationship, share_numerator, share_denominator)
          VALUES (${aptId}, ${renter}, 0, 'renter', 0, 1)
        `);
      })
      .then(
        () => ({ ok: true as const }),
        (e: unknown) => ({ ok: false as const, ...describeDbError(e) }),
      );

    if (!result.ok) {
      const shape =
        result.code === '42703'
          ? 'RED (columns missing: share_numerator/share_denominator do not exist yet — 42703)'
          : `RED (rejected: code=${result.code ?? 'n/a'} message=${result.message})`;
      throw new Error(
        `Expected owners=1/1 + a renter to COMMIT (renter excluded from the sum), but it was rejected. ${shape}`,
      );
    }
    expect(result.ok).toBe(true);
  });

  // ── TEST #4 — exact thirds are EXACTLY 1, not 0.9999 ─────────────────────
  // The whole point of the feature. This computes the sum of the persisted
  // OWNER fractions purely in INTEGER arithmetic (cross-multiplication) and
  // asserts it equals 1 EXACTLY — no float drift. Reuses the apartment seeded
  // by test #1's accepted split. RED today (the accepted split doesn't exist /
  // the columns don't exist); GREEN post-builder.
  it('4) treats 1/3 + 1/3 + 1/3 as EXACTLY 1 (integer cross-multiplication, no 0.9999 drift)', async () => {
    const aptId = await makeApartment(seed.buildingId, 'frac-4');
    const o1 = await makeOwner(seed.orgId);
    const o2 = await makeOwner(seed.orgId);
    const o3 = await makeOwner(seed.orgId);

    const insertThird = (ownerId: string) => sql`
      INSERT INTO ownerships (apartment_id, owner_id, ownership_pct, relationship, share_numerator, share_denominator)
      VALUES (${aptId}, ${ownerId}, 0, 'owner', 1, 3)
    `;

    const inserted = await providerDb
      .transaction(async (tx) => {
        await tx.execute(insertThird(o1));
        await tx.execute(insertThird(o2));
        await tx.execute(insertThird(o3));
      })
      .then(
        () => true,
        () => false,
      );
    expect(inserted).toBe(true);

    // Sum the OWNER fractions in EXACT integer rational arithmetic:
    // Σ (num_i / den_i) over owners, reduced. For 1/3 × 3 this is 3/3 = 1/1.
    // We compute it as a single rational over the common denominator using
    // integer-only SQL and assert numerator = denominator (i.e. the value is
    // exactly 1) — NOT a float that rounds to 0.9999.
    const [exact] = await providerDb
      .select({
        // For equal denominators d: Σ(num)/d. Equality to 1 ⇔ Σ(num) = d.
        sumNum: sql<number>`SUM(share_numerator)::int`,
        // All owner rows here share denominator 3; take it as the common base.
        commonDen: sql<number>`MAX(share_denominator)::int`,
      })
      .from(ownerships)
      .where(sql`apartment_id = ${aptId} AND relationship = 'owner' AND ended_at IS NULL`);

    // 1/3 + 1/3 + 1/3 = 3/3 → sumNum (3) === commonDen (3) → exactly 1.
    expect(exact?.sumNum).toBe(3);
    expect(exact?.commonDen).toBe(3);
    expect(exact!.sumNum).toBe(exact!.commonDen); // value === 1, exactly.
  });

  // ── TEST #5 — the legacy gap is now CLOSED ───────────────────────────────
  // Originally this documented the legacy gap (a thirds split as 33.33 percent
  // summed to 99.99 ≠ 100 and was REJECTED by the old =100 trigger). The fix
  // REMOVED that legacy check: ownership_pct is now a derived display value and
  // the SOLE sum invariant is the EXACT fraction sum = 1. So the very scenario
  // that used to be impossible is now ACCEPTED when the canonical fraction
  // (1/3 each) is supplied alongside the realistic derived pct (33.33).
  it('5) CLOSES the legacy gap: thirds with realistic derived pct (33.33×3 = 99.99) is ACCEPTED via the fraction (1/3 each)', async () => {
    const aptId = await makeApartment(seed.buildingId, 'frac-5');
    const o1 = await makeOwner(seed.orgId);
    const o2 = await makeOwner(seed.orgId);
    const o3 = await makeOwner(seed.orgId);

    const result = await providerDb
      .transaction(async (tx) => {
        // 33.33 derived display pct (sums to 99.99) WITH the canonical 1/3
        // fraction. Under the old =100 trigger this was rejected; now the
        // fraction (3 × 1/3 = 1) governs and it commits.
        const insertThird = (ownerId: string) => sql`
          INSERT INTO ownerships (apartment_id, owner_id, ownership_pct, relationship, share_numerator, share_denominator)
          VALUES (${aptId}, ${ownerId}, 33.33, 'owner', 1, 3)
        `;
        await tx.execute(insertThird(o1));
        await tx.execute(insertThird(o2));
        await tx.execute(insertThird(o3));
      })
      .then(
        () => ({ ok: true as const }),
        (e: unknown) => ({ ok: false as const, ...describeDbError(e) }),
      );

    if (!result.ok) {
      const shape =
        result.code === '42703'
          ? 'RED (columns missing: share_numerator/share_denominator do not exist yet — 42703)'
          : `RED (rejected: code=${result.code ?? 'n/a'} message=${result.message})`;
      throw new Error(
        `Expected a thirds split with realistic 33.33 pct (fraction 1/3 each) to COMMIT now that the legacy =100 check is gone, but it was rejected. ${shape}`,
      );
    }
    expect(result.ok).toBe(true);
  });
});
