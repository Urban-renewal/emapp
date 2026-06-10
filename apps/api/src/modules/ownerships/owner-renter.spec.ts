/**
 * P2 Feature A (D.25 sum-trigger change, risk: HIGH) — owner/renter.
 *
 * ADVERSARIAL real-DB spec authored by a SEPARATE test author (does NOT
 * touch the impl). Proves the load-bearing invariants of the owner/renter
 * split and tries to BREAK the renter signature-gate.
 *
 * Sections (mirror docs/decision-records/P2-feature-a-owner-renter.md §A-E):
 *   A — trigger invariants (the relationship='owner' SUM predicate).
 *   B — OwnershipsService.replaceSet persists relationship + PII parity.
 *   C — the renter SIGNATURE GATE (create 404 / createBulk owner_is_renter)
 *       INCLUDING the cross-project owns-X-rents-Y probe.
 *   E — migration safety (data invariant + SET search_path on the fn).
 *
 * Real DB (Neon) — mocking the trigger/gate would defeat the purpose.
 * Seeds far-future / unique data to dodge the known shared-DB pollution.
 *
 * Run:
 *   infisical run --env=dev -- pnpm --filter @emapp/api exec \
 *     vitest run src/modules/ownerships/owner-renter.spec.ts
 */
import { randomUUID } from 'node:crypto';

import { apartments, buildings, encryptOwnerPii, owners, withTenant } from '@emapp/db';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';
import { SignatureRequestsService } from '../signatures/signature-requests.service';

import { OwnershipsService } from './ownerships.service';

let ownSvc: OwnershipsService;
let sigSvc: SignatureRequestsService;
let org: TestOrg;
let managerId: string;
let docId: string;

const MGR_SID = '00000000-0000-4000-8000-00000000a001';

// ---- token / delivery stubs for the signature service ---------------------
const FAKE_JWT_PREFIX = 'eyJhbGciOiJIUzI1NiJ9.RENTERGATETOKEN';
const tokenStub = {
  sign: () => ({
    token: `${FAKE_JWT_PREFIX}.sig-${randomUUID()}`,
    jti: 'jti-' + randomUUID(),
    expiresAt: new Date(Date.now() + 3_600_000),
  }),
} as never;
const emailStub = {
  send: async () => ({ id: 'e-' + randomUUID(), status: 'sent' as const }),
  healthCheck: async () => undefined,
} as never;
const smsStub = {
  send: async () => ({ id: 's', status: 'sent' as const }),
  healthCheck: async () => undefined,
} as never;

function manager(orgId = org.id): AccessTokenPayload {
  return {
    sub: managerId,
    orgId,
    role: 'manager',
    sid: MGR_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

// ---- seeding helpers -------------------------------------------------------

/** Unique 9-digit national_id (the constraint is uniqueness, not check-digit). */
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

/** Fresh apartment (new building) per call so the per-apartment trigger is
 *  isolated and the unique-active index never collides across cases. */
async function seedApartment(orgId: string, projectIdx = 0): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const [bld] = await tx
      .insert(buildings)
      .values({
        projectId: org.projects[projectIdx]!.id,
        address: `OwnerRenter ${Date.now()}-${Math.random()}`,
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

async function seedFinalisedDoc(orgId: string, projectId: string, mgrId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO documents (org_id, project_id, name, type, mime_type, size_bytes, r2_key, content_hash, uploaded_by, uploaded_at)
       VALUES ($1, $2, 'feature-a.pdf', 'contract', 'application/pdf', 100, $3, 'h', $4, now()) RETURNING id`,
      [orgId, projectId, `org/${orgId}/doc/${randomUUID()}`, mgrId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Insert ownership rows DIRECTLY via the provider pool (BYPASSRLS) so we can
 *  probe the trigger / gate with arbitrary relationship+pct combos that the
 *  app-layer Zod refine would reject — i.e. test the DB backstop in isolation.
 *  All rows for one apartment are inserted in ONE tx so the DEFERRED trigger
 *  validates the final committed set (matching the prod replace semantics). */
async function insertOwnershipSet(
  apartmentId: string,
  rows: Array<{ ownerId: string; pct: number; relationship: 'owner' | 'renter' }>,
): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query('BEGIN');
    for (const r of rows) {
      // S3b — the sum trigger now validates the EXACT FRACTION sum = 1, with
      // ownership_pct demoted to a derived display value. Derive num/den from
      // pct exactly as every real write path does (num = round(pct*100),
      // den = 10000) so this raw backstop genuinely exercises the fraction
      // trigger (a pct-only insert would default to 0/10000 and sum to 0,
      // sidestepping the check entirely).
      const num = Math.round(r.pct * 100);
      await c.query(
        `INSERT INTO ownerships (apartment_id, owner_id, ownership_pct, relationship, share_numerator, share_denominator)
         VALUES ($1, $2, $3, $4, $5, 10000)`,
        [apartmentId, r.ownerId, String(r.pct), r.relationship, num],
      );
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Active owner-only SUM for an apartment, read via BYPASSRLS — independent of
 *  the org context, so an assertion can't be fooled by a missing GUC. */
async function ownerSum(apartmentId: string): Promise<number> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ s: string }>(
      `SELECT COALESCE(SUM(ownership_pct),0)::text AS s FROM ownerships
       WHERE apartment_id = $1 AND ended_at IS NULL AND relationship = 'owner'`,
      [apartmentId],
    );
    return Number(r.rows[0]!.s);
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  ownSvc = new OwnershipsService();
  sigSvc = new SignatureRequestsService(tokenStub, emailStub, smsStub);
  const tag = `feat-a-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  docId = await seedFinalisedDoc(org.id, org.projects[0]!.id, managerId);
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

// ===========================================================================
// SECTION A — trigger invariants (relationship='owner' SUM predicate)
// ===========================================================================
describe('A — trigger invariants', () => {
  it('A1) owners summing to 100 → COMMIT', async () => {
    const apt = await seedApartment(org.id);
    const o1 = await seedOwner(org.id);
    const o2 = await seedOwner(org.id);
    await expect(
      insertOwnershipSet(apt, [
        { ownerId: o1, pct: 60, relationship: 'owner' },
        { ownerId: o2, pct: 40, relationship: 'owner' },
      ]),
    ).resolves.toBeUndefined();
    expect(await ownerSum(apt)).toBe(100);
  }, 30_000);

  it('A2) add a renter (pct 0) to a 100% apartment → COMMIT, owner-sum still 100', async () => {
    const apt = await seedApartment(org.id);
    const o1 = await seedOwner(org.id);
    const renter = await seedOwner(org.id);
    await insertOwnershipSet(apt, [
      { ownerId: o1, pct: 100, relationship: 'owner' },
      { ownerId: renter, pct: 0, relationship: 'renter' },
    ]);
    // The renter rides along; the owner-only sum is unaffected.
    expect(await ownerSum(apt)).toBe(100);
  }, 30_000);

  it('A3) owners summing to 90 → the write RAISES (trigger), service maps to 400 ownership_sum_invalid', async () => {
    // 3a — the raw DB trigger fires at COMMIT. S3b: a single owner at pct 90
    // derives the fraction 9000/10000 = 0.9 ≠ 1 → the fraction sum check raises.
    const apt = await seedApartment(org.id);
    const o1 = await seedOwner(org.id);
    await expect(
      insertOwnershipSet(apt, [{ ownerId: o1, pct: 90, relationship: 'owner' }]),
    ).rejects.toThrow(/Sum of ownership shares must equal the whole/);

    // 3b — through the service: a 90-sum set (Zod owners-sum refine rejects it,
    // but even if it slipped through, replaceSet re-guards + maps the trigger
    // raise to 400). Assert the public 400 contract.
    const apt2 = await seedApartment(org.id);
    const so1 = await seedOwner(org.id);
    await expect(
      ownSvc.replaceSet(manager(), apt2, {
        owners: [{ ownerId: so1, ownershipPct: 90, relationship: 'owner' }],
      }),
    ).rejects.toMatchObject({
      response: { error: { code: 'ownership_sum_invalid' } },
    });
    // Nothing committed for apt2.
    expect(await ownerSum(apt2)).toBe(0);
  }, 30_000);

  it('A4) renter with NON-ZERO pct → rejected at the API edge (Zod refine) AND trigger ignores renter pct (owners-only sum)', async () => {
    // 4a — API edge: a renter carrying pct>0 is a 400 (the shareEntry refine:
    // renter ⇒ pct===0). replaceSet re-runs the shared schema → SUM_INVALID.
    const aptEdge = await seedApartment(org.id);
    const o1 = await seedOwner(org.id);
    const badRenter = await seedOwner(org.id);
    await expect(
      ownSvc.replaceSet(manager(), aptEdge, {
        owners: [
          { ownerId: o1, ownershipPct: 100, relationship: 'owner' },
          { ownerId: badRenter, ownershipPct: 25, relationship: 'renter' },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await ownerSum(aptEdge)).toBe(0); // nothing committed

    // 4b — DB backstop: prove the TRIGGER ignores renter pct. We bypass the
    // refine (raw insert) and give the renter pct=25. Owners total exactly 100,
    // so the owners-only SUM is 100 and the COMMIT SUCCEEDS even though the
    // raw grand-total (owner+renter) would be 125. This is the load-bearing
    // proof that the SUM predicate is genuinely `... AND relationship='owner'`.
    const aptDb = await seedApartment(org.id);
    const dbOwner = await seedOwner(org.id);
    const dbRenter = await seedOwner(org.id);
    await expect(
      insertOwnershipSet(aptDb, [
        { ownerId: dbOwner, pct: 100, relationship: 'owner' },
        { ownerId: dbRenter, pct: 25, relationship: 'renter' },
      ]),
    ).resolves.toBeUndefined();
    expect(await ownerSum(aptDb)).toBe(100); // owners-only, renter's 25 excluded
  }, 30_000);

  it('A5) renter-only apartment (no owners) → owner sum 0 → legal (COMMIT)', async () => {
    const apt = await seedApartment(org.id);
    const renter = await seedOwner(org.id);
    await expect(
      insertOwnershipSet(apt, [{ ownerId: renter, pct: 0, relationship: 'renter' }]),
    ).resolves.toBeUndefined();
    // owners-only sum is 0 → passes the `v_total > 0` guard (the "clear"/
    // no-owner legal end state).
    expect(await ownerSum(apt)).toBe(0);
  }, 30_000);

  it('A6) ADVERSARIAL: a renter does NOT rescue a sub-100 owner set (renter pct uncounted)', async () => {
    // If the predicate were mistakenly relationship-agnostic, owner 90 + renter
    // 10 would "sum to 100" and wrongly COMMIT. It must still RAISE: only the
    // owner's 90 counts. This catches a dropped/inverted filter.
    const apt = await seedApartment(org.id);
    const o1 = await seedOwner(org.id);
    const renter = await seedOwner(org.id);
    await expect(
      insertOwnershipSet(apt, [
        { ownerId: o1, pct: 90, relationship: 'owner' },
        { ownerId: renter, pct: 10, relationship: 'renter' },
      ]),
    ).rejects.toThrow(/Sum of ownership shares must equal the whole/);
  }, 30_000);
});

// ===========================================================================
// SECTION B — service REPLACE persists relationship + PII parity
// ===========================================================================
describe('B — replaceSet persists relationship, round-trips, PII parity', () => {
  it('B1) mixed owner+renter set persists renter relationship/pct 0; owners sum 100; round-trips via listApartmentOwners', async () => {
    const apt = await seedApartment(org.id);
    const ownerA = await seedOwner(org.id);
    const ownerB = await seedOwner(org.id);
    const renter = await seedOwner(org.id);

    const created = await ownSvc.replaceSet(manager(), apt, {
      owners: [
        { ownerId: ownerA, ownershipPct: 70, relationship: 'owner', role: 'primary' },
        { ownerId: ownerB, ownershipPct: 30, relationship: 'owner' },
        { ownerId: renter, ownershipPct: 0, relationship: 'renter' },
      ],
    });
    expect(created).toHaveLength(3);

    // Owners-only sum is exactly 100 at the DB level.
    expect(await ownerSum(apt)).toBe(100);

    // Round-trip via the masked owner projection.
    const page = await ownSvc.listApartmentOwners(manager(), apt, { limit: 50 });
    const byId = new Map(page.data.map((r) => [r.id, r]));
    expect(byId.get(ownerA)!.relationship).toBe('owner');
    expect(byId.get(ownerA)!.ownershipPct).toBe(70);
    expect(byId.get(ownerB)!.relationship).toBe('owner');
    expect(byId.get(renter)!.relationship).toBe('renter');
    expect(byId.get(renter)!.ownershipPct).toBe(0);

    // PII PARITY: the renter is a full owner-person — name decrypted, national_id
    // + phone MASKED identically to an owner. No clear-text divergence, no null.
    const ownerRow = byId.get(ownerA)!;
    const renterRow = byId.get(renter)!;
    for (const row of [ownerRow, renterRow]) {
      expect(row.name).toBe('בעלים'); // decrypted in-SQL, same for both
      expect(row.nationalIdMasked).toMatch(/^•+\d{2}$/); // masked, last-2 only
      expect(row.phoneMasked).toMatch(/^•+\d{4}$/); // masked, last-4 only
    }
    // Identical mask SHAPE for owner and renter (parity, not value equality).
    expect(renterRow.nationalIdMasked!.startsWith('•')).toBe(true);
    expect(renterRow.phoneMasked!.startsWith('•')).toBe(true);
  }, 30_000);

  it('B2) replacing the set ENDS the old renter row (no duplicate active rows)', async () => {
    const apt = await seedApartment(org.id);
    const owner = await seedOwner(org.id);
    const renter = await seedOwner(org.id);
    await ownSvc.replaceSet(manager(), apt, {
      owners: [
        { ownerId: owner, ownershipPct: 100, relationship: 'owner' },
        { ownerId: renter, ownershipPct: 0, relationship: 'renter' },
      ],
    });
    // Replace with owner-only (drop the renter).
    await ownSvc.replaceSet(manager(), apt, {
      owners: [{ ownerId: owner, ownershipPct: 100, relationship: 'owner' }],
    });
    const page = await ownSvc.listApartmentOwners(manager(), apt, { limit: 50 });
    expect(page.data.map((r) => r.id)).toEqual([owner]);
    expect(await ownerSum(apt)).toBe(100);
  }, 30_000);
});

// ===========================================================================
// SECTION C — the renter SIGNATURE GATE (BREAK IT)
// ===========================================================================
describe('C — renter signature-gate', () => {
  /** A pure renter: a renter row on an apartment, NO owner row anywhere. */
  async function seedPureRenter(): Promise<string> {
    const apt = await seedApartment(org.id);
    const renter = await seedOwner(org.id);
    await insertOwnershipSet(apt, [{ ownerId: renter, pct: 0, relationship: 'renter' }]);
    return renter;
  }
  /** A normal owner: an owner row summing to 100 on its own apartment. */
  async function seedNormalOwner(): Promise<string> {
    const apt = await seedApartment(org.id);
    const owner = await seedOwner(org.id);
    await insertOwnershipSet(apt, [{ ownerId: owner, pct: 100, relationship: 'owner' }]);
    return owner;
  }

  it('C1a) pure renter → create() returns 404 (no signing link); NO row written', async () => {
    const renter = await seedPureRenter();
    await expect(
      sigSvc.create(manager(), { documentId: docId, ownerId: renter }),
    ).rejects.toBeInstanceOf(NotFoundException);
    // No signature_request row for this renter.
    const c = await providerPool.connect();
    try {
      const r = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM signature_requests WHERE owner_id = $1`,
        [renter],
      );
      expect(Number(r.rows[0]!.n)).toBe(0);
    } finally {
      c.release();
    }
  }, 30_000);

  it('C1b) pure renter in createBulk → failed reason owner_is_renter; batch NOT aborted', async () => {
    const renter = await seedPureRenter();
    const owner = await seedNormalOwner();
    const res = await sigSvc.createBulk(manager(), {
      documentId: docId,
      ownerIds: [renter, owner],
    });
    expect(res.summary).toEqual({ created: 1, skipped: 0, failed: 1 });
    expect(res.results.find((r) => r.ownerId === renter)!.outcome).toBe('failed');
    expect(res.results.find((r) => r.ownerId === renter)!.reason).toBe('owner_is_renter');
    // The legitimate owner still got created — the renter did NOT abort the batch.
    expect(res.results.find((r) => r.ownerId === owner)!.outcome).toBe('created');
  }, 30_000);

  it('C2) a normal owner still gets a link (no regression)', async () => {
    const owner = await seedNormalOwner();
    const res = await sigSvc.create(manager(), { documentId: docId, ownerId: owner });
    expect(res.request).toBeDefined();
    expect(res.signUrl).toContain('/sign/');
  }, 30_000);

  it('C3) CROSS-PROJECT PROBE: owner of X + renter of Y → gate is GLOBAL (owns-anything ⇒ allowed)', async () => {
    // One person, two apartments (in DIFFERENT buildings, so the unique-active
    // (apartment,owner) index is not in play): OWNER of X (100%), RENTER of Y.
    const person = await seedOwner(org.id);

    const aptX = await seedApartment(org.id, 0);
    const coOwnerX = await seedOwner(org.id);
    await insertOwnershipSet(aptX, [{ ownerId: person, pct: 100, relationship: 'owner' }]);
    void coOwnerX; // (kept for clarity; X is solely owned by `person`)

    const aptY = await seedApartment(org.id, 1);
    const ownerOfY = await seedOwner(org.id);
    await insertOwnershipSet(aptY, [
      { ownerId: ownerOfY, pct: 100, relationship: 'owner' },
      { ownerId: person, pct: 0, relationship: 'renter' },
    ]);

    // The gate's rule: ineligible iff (renter somewhere) AND (owner NOWHERE).
    // This person owns X, so they are eligible GLOBALLY — they GET a link even
    // for a document whose context might be project/apartment Y.
    const res = await sigSvc.create(manager(), { documentId: docId, ownerId: person });
    expect(res.request).toBeDefined();
    expect(res.signUrl).toContain('/sign/');

    // Confirm via bulk too — `created`, not `owner_is_renter`.
    const owner2 = await seedNormalOwner();
    const bulk = await sigSvc.createBulk(manager(), {
      documentId: docId,
      ownerIds: [person, owner2],
    });
    // person already has a pending request from the create() above → skipped.
    const personRes = bulk.results.find((r) => r.ownerId === person)!;
    expect(personRes.outcome).not.toBe('failed');
    expect(personRes.reason).not.toBe('owner_is_renter');
  }, 30_000);

  it('C4) FORGED/STALE client-supplied renter ownerId cannot get a link (gate re-resolves from DB)', async () => {
    // The client supplies the ownerId; the gate must re-resolve relationship
    // from the DB and NOT trust the caller. A pure renter id, supplied directly,
    // is still blocked (create 404 / bulk owner_is_renter) — there is no
    // client-controlled field that flips it to 'owner'.
    const renter = await seedPureRenter();

    // create(): forged id → 404, no oracle, no row.
    await expect(
      sigSvc.create(manager(), { documentId: docId, ownerId: renter }),
    ).rejects.toBeInstanceOf(NotFoundException);

    // bulk(): same renter alongside a non-existent UUID — both fail, neither
    // mints a link; the DB is the authority.
    const bogus = randomUUID();
    const res = await sigSvc.createBulk(manager(), {
      documentId: docId,
      ownerIds: [renter, bogus],
    });
    expect(res.summary.created).toBe(0);
    expect(res.results.find((r) => r.ownerId === renter)!.reason).toBe('owner_is_renter');
    expect(res.results.find((r) => r.ownerId === bogus)!.reason).toBe('owner_not_found');
  }, 30_000);
});

// ===========================================================================
// SECTION E — migration safety
// ===========================================================================
describe('E — migration safety', () => {
  it('E1) EVERY apartment satisfies owner-only SUM ∈ {0,100} (post-migration data invariant)', async () => {
    const c = await providerPool.connect();
    try {
      const r = await c.query<{ apartment_id: string; s: string }>(
        `SELECT apartment_id, SUM(ownership_pct)::text AS s
         FROM ownerships
         WHERE ended_at IS NULL AND relationship = 'owner'
         GROUP BY apartment_id
         HAVING SUM(ownership_pct) <> 0 AND SUM(ownership_pct) <> 100`,
      );
      expect(
        r.rows,
        `apartments violating owner-only SUM ∈ {0,100}: ${JSON.stringify(r.rows)}`,
      ).toEqual([]);
    } finally {
      c.release();
    }
  }, 30_000);

  it('E2) NO active ownership row has a NULL/empty relationship (backfill complete)', async () => {
    const c = await providerPool.connect();
    try {
      const r = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ownerships
         WHERE relationship IS NULL OR relationship NOT IN ('owner','renter')`,
      );
      expect(Number(r.rows[0]!.n)).toBe(0);
    } finally {
      c.release();
    }
  }, 30_000);

  it('E3) trigger_check_ownership_sum() carries SET search_path AND the relationship filter', async () => {
    const c = await providerPool.connect();
    try {
      // pg_proc.proconfig holds the function-scoped SET list; pg_get_functiondef
      // gives the body so we can assert the relationship='owner' predicate.
      const r = await c.query<{ proconfig: string[] | null; def: string }>(
        `SELECT p.proconfig, pg_get_functiondef(p.oid) AS def
         FROM pg_proc p
         WHERE p.proname = 'trigger_check_ownership_sum'`,
      );
      expect(r.rows.length).toBeGreaterThanOrEqual(1);
      const fn = r.rows[0]!;
      // SET search_path is present (the §v8-M5 hardening).
      const cfg = (fn.proconfig ?? []).join(',');
      expect(cfg).toContain('search_path');
      expect(cfg).toContain('pg_temp');
      // The owner-only predicate is live in the function body.
      expect(fn.def.replace(/\s+/g, ' ')).toContain("relationship = 'owner'");
    } finally {
      c.release();
    }
  }, 30_000);
});
