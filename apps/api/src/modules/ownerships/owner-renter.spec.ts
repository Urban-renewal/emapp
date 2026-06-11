/**
 * S3c ("renter → discovery-source") — REWORKED from the P2 Feature A
 * owner/renter spec.
 *
 * WHY THIS WAS REWORKED: migration 0066 RETIRED `ownerships.relationship='renter'`
 * (the column is now pinned by a DB CHECK to ('owner')) and moved occupants to
 * the new apartment-attached `discovery_records` table. A "renter"/occupant is a
 * DISCOVERY SOURCE, not an owner/signer — it carries no owner_id and creates no
 * ownership row, so it can never be a signature recipient. The old renter
 * ownership rows this spec used to insert now VIOLATE the CHECK (23514), so the
 * renter-as-ownership cases are no longer expressible and have been:
 *   - converted to `discovery_records` where the occupant concept still applies
 *     (the occupant-is-not-a-recipient guarantee), OR
 *   - retired where they only tested the obsolete renter-in-ownerships overload.
 * Every STILL-VALID assertion is preserved (owner-only sum behaviour; replaceSet
 * owner persistence + PII parity; the normal-owner signature path; the
 * recipient-association gate that now governs occupant-exclusion structurally).
 *
 * Sections:
 *   A — trigger invariants (the relationship='owner' owner-sum predicate).
 *   B — OwnershipsService.replaceSet persists owners + PII parity.
 *   C — the signature recipient gate: a normal owner gets a link; an occupant
 *       (discovery_records, NO ownership row) can NEVER be a recipient.
 *   D — the retirement invariant: a renter ownership INSERT is rejected (23514).
 *
 * Real DB (Neon) — mocking the trigger/gate would defeat the purpose.
 *
 * Run:
 *   infisical run --env=dev -- pnpm --filter @emapp/api exec \
 *     vitest run src/modules/ownerships/owner-renter.spec.ts
 */
import { randomUUID } from 'node:crypto';

import {
  apartments,
  buildings,
  discoveryRecords,
  encryptOwnerPii,
  owners,
  withTenant,
} from '@emapp/db';
import { ConflictException } from '@nestjs/common';
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
const FAKE_JWT_PREFIX = 'eyJhbGciOiJIUzI1NiJ9.RECIPIENTGATETOKEN';
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
 *  isolated and the unique-active (apartment,owner) index never collides. */
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

/** Insert OWNER ownership rows DIRECTLY via the provider pool (BYPASSRLS) so the
 *  trigger can be probed in isolation. All rows for one apartment in ONE tx so
 *  the DEFERRED trigger validates the final committed set. After 0066 the only
 *  legal relationship is 'owner' (the CHECK rejects 'renter'), so this helper no
 *  longer takes a relationship — every row is an owner row. */
async function insertOwnerSet(
  apartmentId: string,
  rows: Array<{ ownerId: string; pct: number }>,
): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query('BEGIN');
    for (const r of rows) {
      // S3b — derive the fraction the same way every real write path does
      // (num = round(pct*100), den = 10000) so the fraction sum trigger fires.
      const num = Math.round(r.pct * 100);
      await c.query(
        `INSERT INTO ownerships (apartment_id, owner_id, ownership_pct, relationship, share_numerator, share_denominator)
         VALUES ($1, $2, $3, 'owner', $4, 10000)`,
        [apartmentId, r.ownerId, String(r.pct), num],
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

/** Record an OCCUPANT as a discovery source on an apartment (the S3c model that
 *  replaced relationship='renter'). Creates NO ownership row. BYPASSRLS. */
async function recordOccupant(orgId: string, apartmentId: string): Promise<string> {
  const [row] = await withTenant(orgId, (tx) =>
    tx
      .insert(discoveryRecords)
      .values({ orgId, apartmentId, status: 'spoke_to_occupant' })
      .returning({ id: discoveryRecords.id }),
  );
  return row!.id;
}

/** Active owner SUM for an apartment, read via BYPASSRLS — independent of the
 *  org context, so an assertion can't be fooled by a missing GUC. */
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
// SECTION A — trigger invariants (the relationship='owner' owner-sum predicate)
// ===========================================================================
describe('A — trigger invariants', () => {
  it('A1) owners summing to 100 → COMMIT', async () => {
    const apt = await seedApartment(org.id);
    const o1 = await seedOwner(org.id);
    const o2 = await seedOwner(org.id);
    await expect(
      insertOwnerSet(apt, [
        { ownerId: o1, pct: 60 },
        { ownerId: o2, pct: 40 },
      ]),
    ).resolves.toBeUndefined();
    expect(await ownerSum(apt)).toBe(100);
  }, 30_000);

  it('A2) recording an occupant (discovery_records) does NOT touch the owner sum', async () => {
    // The S3c replacement for "add a renter to a 100% apartment": the occupant
    // is a discovery source, NOT an ownership row, so the owner-only sum is
    // untouched and no ownership row is created for the occupant.
    const apt = await seedApartment(org.id);
    const o1 = await seedOwner(org.id);
    await insertOwnerSet(apt, [{ ownerId: o1, pct: 100 }]);
    await recordOccupant(org.id, apt);
    expect(await ownerSum(apt)).toBe(100);
    // The apartment has exactly ONE ownership row (the owner) — the occupant
    // added zero ownership rows.
    const c = await providerPool.connect();
    try {
      const r = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ownerships WHERE apartment_id = $1 AND ended_at IS NULL`,
        [apt],
      );
      expect(Number(r.rows[0]!.n)).toBe(1);
    } finally {
      c.release();
    }
  }, 30_000);

  it('A3) owners summing to 90 → the write RAISES (trigger), service maps to 400 ownership_sum_invalid', async () => {
    // 3a — the raw DB trigger fires at COMMIT. A single owner at pct 90 derives
    // the fraction 9000/10000 = 0.9 ≠ 1 → the fraction sum check raises.
    const apt = await seedApartment(org.id);
    const o1 = await seedOwner(org.id);
    await expect(insertOwnerSet(apt, [{ ownerId: o1, pct: 90 }])).rejects.toThrow(
      /Sum of ownership shares must equal the whole/,
    );

    // 3b — through the service: a 90-sum set maps the trigger raise to 400.
    const apt2 = await seedApartment(org.id);
    const so1 = await seedOwner(org.id);
    await expect(
      ownSvc.replaceSet(manager(), apt2, {
        owners: [{ ownerId: so1, ownershipPct: 90, relationship: 'owner' }],
      }),
    ).rejects.toMatchObject({
      response: { error: { code: 'ownership_sum_invalid' } },
    });
    expect(await ownerSum(apt2)).toBe(0);
  }, 30_000);

  it('A5) an apartment with NO owners (occupant-only discovery) → owner sum 0 → legal', async () => {
    // The S3c replacement for the "renter-only apartment" case: an apartment a
    // field worker only RECORDED an occupant on has zero ownership rows → owner
    // sum 0 (the clear / no-owner legal end state). No ownership row exists.
    const apt = await seedApartment(org.id);
    await recordOccupant(org.id, apt);
    expect(await ownerSum(apt)).toBe(0);
    const c = await providerPool.connect();
    try {
      const r = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ownerships WHERE apartment_id = $1`,
        [apt],
      );
      expect(Number(r.rows[0]!.n)).toBe(0);
    } finally {
      c.release();
    }
  }, 30_000);

  it('A6) ADVERSARIAL: a sub-100 owner set still RAISES (no phantom rescue)', async () => {
    // Previously a renter "10" must not rescue an owner "90". Post-0066 there is
    // no renter row at all; the owner set 90 must still RAISE on its own.
    const apt = await seedApartment(org.id);
    const o1 = await seedOwner(org.id);
    await expect(insertOwnerSet(apt, [{ ownerId: o1, pct: 90 }])).rejects.toThrow(
      /Sum of ownership shares must equal the whole/,
    );
  }, 30_000);
});

// ===========================================================================
// SECTION B — service REPLACE persists owners + PII parity
// ===========================================================================
describe('B — replaceSet persists owners, round-trips, PII parity', () => {
  it('B1) owner set persists; owners sum 100; round-trips via listApartmentOwners with masked PII', async () => {
    const apt = await seedApartment(org.id);
    const ownerA = await seedOwner(org.id);
    const ownerB = await seedOwner(org.id);

    const created = await ownSvc.replaceSet(manager(), apt, {
      owners: [
        { ownerId: ownerA, ownershipPct: 70, relationship: 'owner', role: 'primary' },
        { ownerId: ownerB, ownershipPct: 30, relationship: 'owner' },
      ],
    });
    expect(created).toHaveLength(2);

    // Owners-only sum is exactly 100 at the DB level.
    expect(await ownerSum(apt)).toBe(100);

    // Round-trip via the masked owner projection.
    const page = await ownSvc.listApartmentOwners(manager(), apt, { limit: 50 });
    const byId = new Map(page.data.map((r) => [r.id, r]));
    expect(byId.get(ownerA)!.relationship).toBe('owner');
    expect(byId.get(ownerA)!.ownershipPct).toBe(70);
    expect(byId.get(ownerB)!.relationship).toBe('owner');

    // PII PARITY: every owner-person — name decrypted, national_id + phone MASKED.
    for (const ownerId of [ownerA, ownerB]) {
      const row = byId.get(ownerId)!;
      expect(row.name).toBe('בעלים'); // decrypted in-SQL
      expect(row.nationalIdMasked).toMatch(/^•+\d{2}$/); // masked, last-2 only
      expect(row.phoneMasked).toMatch(/^•+\d{4}$/); // masked, last-4 only
    }
  }, 30_000);

  it('B2) replacing the set ENDS the old rows (no duplicate active rows)', async () => {
    const apt = await seedApartment(org.id);
    const ownerA = await seedOwner(org.id);
    const ownerB = await seedOwner(org.id);
    await ownSvc.replaceSet(manager(), apt, {
      owners: [
        { ownerId: ownerA, ownershipPct: 50, relationship: 'owner' },
        { ownerId: ownerB, ownershipPct: 50, relationship: 'owner' },
      ],
    });
    // Replace with a single owner (drop ownerB).
    await ownSvc.replaceSet(manager(), apt, {
      owners: [{ ownerId: ownerA, ownershipPct: 100, relationship: 'owner' }],
    });
    const page = await ownSvc.listApartmentOwners(manager(), apt, { limit: 50 });
    expect(page.data.map((r) => r.id)).toEqual([ownerA]);
    expect(await ownerSum(apt)).toBe(100);
  }, 30_000);
});

// ===========================================================================
// SECTION C — the signature recipient gate
// ===========================================================================
describe('C — signature recipient gate (occupant can never be a recipient)', () => {
  /** A normal owner: an owner row summing to 100 on its own apartment. */
  async function seedNormalOwner(): Promise<string> {
    const apt = await seedApartment(org.id);
    const owner = await seedOwner(org.id);
    await insertOwnerSet(apt, [{ ownerId: owner, pct: 100 }]);
    return owner;
  }

  it('C2) a normal owner of the document scope gets a link (no regression)', async () => {
    // The document is project-scoped (org.projects[0]); the owner must hold an
    // active ownership in some apartment under that project. seedApartment uses
    // projectIdx 0 by default, so the owner IS associated.
    const owner = await seedNormalOwner();
    const res = await sigSvc.create(manager(), { documentId: docId, ownerId: owner });
    expect(res.request).toBeDefined();
    expect(res.signUrl).toContain('/sign/');
  }, 30_000);

  it('C5) an occupant (discovery_records, NO ownership row) can NEVER be a recipient', async () => {
    // The S3c structural guarantee that replaced the renter signature gate: an
    // occupant lives ONLY in discovery_records — it has no owner_id, no ownership
    // row. A discovery record id therefore has NO active ownership in the
    // document's project, so the recipient-association gate (Slice-1 #2) rejects
    // it with 409 recipient_not_associated BEFORE it could ever be minted a link.
    // (The gate runs ahead of the owner-existence check, so association — not
    // owner-existence — is what blocks the occupant; either way it is excluded.)
    const apt = await seedApartment(org.id);
    const discoveryId = await recordOccupant(org.id, apt);

    await expect(
      sigSvc.create(manager(), { documentId: docId, ownerId: discoveryId }),
    ).rejects.toBeInstanceOf(ConflictException);

    // And there is NO ownership row on the occupant's apartment.
    const c = await providerPool.connect();
    try {
      const r = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ownerships WHERE apartment_id = $1`,
        [apt],
      );
      expect(Number(r.rows[0]!.n)).toBe(0);
    } finally {
      c.release();
    }
  }, 30_000);

  it('C6) a real owner NOT associated with the document scope is rejected (recipient-association gate)', async () => {
    // An owner who owns an apartment in a DIFFERENT project than the document's
    // is not associated → the recipient gate rejects (409 recipient_not_associated
    // for a project-scoped doc). Proves the association gate — the load-bearing
    // recipient governance — is intact after the renter gate became a no-op.
    const apt = await seedApartment(org.id, 1); // project index 1 ≠ doc's project 0
    const owner = await seedOwner(org.id);
    await insertOwnerSet(apt, [{ ownerId: owner, pct: 100 }]);
    await expect(
      sigSvc.create(manager(), { documentId: docId, ownerId: owner }),
    ).rejects.toMatchObject({ response: { error: { code: 'recipient_not_associated' } } });
  }, 30_000);
});

// ===========================================================================
// SECTION D — the renter retirement invariant (migration 0066)
// ===========================================================================
describe('D — renter retirement', () => {
  it("D1) inserting a relationship='renter' ownership row is REJECTED by the CHECK (23514)", async () => {
    const apt = await seedApartment(org.id);
    const owner = await seedOwner(org.id);
    const c = await providerPool.connect();
    try {
      const err = await c
        .query(
          `INSERT INTO ownerships (apartment_id, owner_id, ownership_pct, relationship, share_numerator, share_denominator)
           VALUES ($1, $2, 0, 'renter', 0, 10000)`,
          [apt, owner],
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeTruthy();
      expect((err as { code?: string }).code).toBe('23514');
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 30_000);

  it('D2) NO active renter ownership row remains anywhere (occupants moved to discovery_records)', async () => {
    const c = await providerPool.connect();
    try {
      const r = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ownerships
         WHERE ended_at IS NULL AND relationship = 'renter'`,
      );
      expect(Number(r.rows[0]!.n)).toBe(0);
    } finally {
      c.release();
    }
  }, 30_000);
});
