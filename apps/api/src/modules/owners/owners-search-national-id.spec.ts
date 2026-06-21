/**
 * NS2 (MASTER-PLAN-V13 Wave B) — national_id lookup on the owners HMAC search
 * (`OwnersService.search`).
 *
 * Asserts against the REAL local DB — the lookup is a keyed HMAC equality on the
 * stored `national_id_hash` column (pgcrypto + the same hashField(value,
 * PII_HASH_KEY) the writers use), so mocking would defeat the test.
 *
 * THE MODEL (PII + security-sensitive): SCOPE is the boundary, not a separate
 * view_owner_pii gate. The national_id HMAC match runs for ALL roles INSIDE the
 * existing scope-filtered query (RLS org-scope + agent assigned-project scope).
 * `view_owner_pii` gates only the SEPARATE reveal-cleartext path (revealPii),
 * NOT this masked, scope-bounded match — so a plain agent finds an ASSIGNED
 * owner by national_id, which is safe (RLS already limits them to owners they
 * can see; no oracle beyond their existing access). national_id stays MASKED.
 *
 * THE CONTRACT under test:
 *  - SCOPED MATCH (all roles): a manager finds an owner by national_id across the
 *    org's projects; a PLAIN agent (view_owners, NOT view_owner_pii) finds an
 *    owner by national_id in an ASSIGNED project — masked (D.54 DV-8).
 *  - THE REAL BOUNDARY: an agent CANNOT find an owner that exists ONLY in an
 *    UNASSIGNED project by national_id (RLS + agentOwnerScope exclude it). That
 *    boundary holds regardless of the view_owner_pii flag.
 *  - CROSS-ORG no-leak: org-A never finds org-B's owner who shares the same
 *    national_id (RLS).
 *  - MASKING: the matched owner comes back with national_id MASKED — finding by
 *    ID does NOT dump the cleartext 9-digit ID back.
 *  - AUDIT: every national_id lookup (any in-scope caller, including a plain
 *    agent) writes an `owner.pii_lookup` row — written even on a no-match — and
 *    the row carries NO national_id value (only field name + result count) and
 *    NO targetId (a lookup spans 0..N owners; pinning one would be a soft oracle).
 *
 * Run (real DB, like the other owners DB specs):
 *   DB_TARGET=local LOCAL_DATABASE_URL=postgresql://postgres:1234@localhost:5432/emapp?sslmode=disable \
 *     infisical run --env dev -- pnpm --filter @emapp/api exec \
 *     vitest run src/modules/owners/owners-search-national-id.spec.ts
 */
import { randomUUID } from 'node:crypto';

import {
  apartments,
  auditLog,
  buildings,
  db,
  encryptOwnerPii,
  memberships,
  owners,
  ownerships,
  projectAssignments,
  users,
  withTenant,
} from '@emapp/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { OwnersService } from './owners.service';

let svc: OwnersService;
let orgA: TestOrg;
let orgB: TestOrg;
let mgrAId: string;
let agentAId: string;

const TAG = randomUUID().slice(0, 8);
const MGR_SID = '00000000-0000-4000-8000-0000000000c1';
const AGENT_SID = '00000000-0000-4000-8000-0000000000c2';

function managerA(): AccessTokenPayload {
  return {
    sub: mgrAId,
    orgId: orgA.id,
    role: 'manager',
    sid: MGR_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}
function agentA(): AccessTokenPayload {
  return {
    sub: agentAId,
    orgId: orgA.id,
    role: 'agent',
    sid: AGENT_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

// Israeli-ID MOD-10 (Luhn-like) valid generator — the structural DTO accepts any
// 9 digits, but using real-shaped IDs keeps the fixtures honest.
function validNationalId(seed: number): string {
  const base = String(100_000_000 + (seed % 800_000_000)).slice(0, 8);
  let sum = 0;
  for (let i = 0; i < 8; i += 1) {
    let d = Number(base[i]) * ((i % 2) + 1);
    if (d > 9) d -= 9;
    sum += d;
  }
  const check = (10 - (sum % 10)) % 10;
  return base + String(check);
}

async function seedOwner(orgId: string, nationalId: string): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, {
      nationalId,
      name: `בעלים ${randomUUID().slice(0, 6)}`,
      phone: '0541112222',
    });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId,
        nameEncrypted: pii.nameEncrypted,
        nameHash: pii.nameHash,
        nationalIdEncrypted: pii.nationalIdEncrypted,
        nationalIdHash: pii.nationalIdHash,
        phoneEncrypted: pii.phoneEncrypted,
        phoneHash: pii.phoneHash,
      })
      .returning({ id: owners.id });
    return row!.id;
  });
}

async function seedAgent(orgId: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `ns2-ag-${randomUUID()}@test.local`, name: 'Ag', passwordHash: '$2b$12$x' })
    .returning({ id: users.id });
  await db
    .insert(memberships)
    .values({ userId: u!.id, orgId, role: 'agent', acceptedAt: new Date() });
  return u!.id;
}

/** Toggle a single capability flag on the agent's active membership. */
async function setAgentCapability(cap: 'view_owners' | 'view_owner_pii', on: boolean): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE memberships SET capabilities = jsonb_set(capabilities, $1::text[], $2::jsonb)
       WHERE user_id = $3 AND org_id = $4 AND revoked_at IS NULL`,
      [`{${cap}}`, on ? 'true' : 'false', agentAId, orgA.id],
    );
  } finally {
    c.release();
  }
}

/** Link an owner to a project via a NEW building+apartment+active ownership. */
async function linkOwnerToProject(orgId: string, projectId: string, ownerId: string): Promise<void> {
  await withTenant(orgId, async (tx) => {
    const [b] = await tx
      .insert(buildings)
      .values({ projectId, address: `addr ${randomUUID()}`, city: 'TLV' })
      .returning({ id: buildings.id });
    const [a] = await tx
      .insert(apartments)
      .values({ buildingId: b!.id, number: `N-${randomUUID().slice(0, 8)}` })
      .returning({ id: apartments.id });
    await tx.insert(ownerships).values({
      apartmentId: a!.id,
      ownerId,
      relationship: 'owner',
      ownershipPct: '100',
      shareNumerator: 10_000,
      shareDenominator: 10_000,
    });
  });
}

/** Count `owner.pii_lookup` audit rows for org-A by this actor. */
async function piiLookupAuditRows(
  actorId: string,
): Promise<{ afterState: unknown; targetId: string | null }[]> {
  return withTenant(orgA.id, (tx) =>
    tx
      .select({ afterState: auditLog.afterState, targetId: auditLog.targetId })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.orgId, orgA.id),
          eq(auditLog.action, 'owner.pii_lookup'),
          eq(auditLog.actorId, actorId),
        ),
      ),
  );
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new OwnersService();
  orgA = await createTestOrg(`NS2A-${TAG}`);
  orgB = await createTestOrg(`NS2B-${TAG}`);
  mgrAId = orgA.users[0]!.id;
  agentAId = await seedAgent(orgA.id);
}, 60_000);

afterAll(async () => {
  /* harmless leftover rows; suites filter by their own tags */
});

describe('NS2 — national_id lookup on owners search (scope-bounded, masked, audited)', () => {
  it('manager finds an owner by national_id across the org; result MASKED', async () => {
    const nid = validNationalId(11);
    const id = await seedOwner(orgA.id, nid);

    const res = await svc.search(managerA(), { national_id: nid });
    const hit = res.find((o) => o.id === id);
    expect(hit, 'national_id lookup must find the owner').toBeDefined();
    // Masked — finding by ID does NOT dump the cleartext ID back.
    expect(hit!.nationalIdMasked).toMatch(/^•+\d{2}$/);
    // No cleartext 9-digit national_id anywhere in the NS2 response.
    expect(JSON.stringify(res)).not.toContain(nid);
    expect(JSON.stringify(res)).not.toMatch(/(?<!\d)\d{9}(?!\d)/);
  });

  it('DV-8 parity: a PLAIN agent (view_owners, NOT view_owner_pii) finds an ASSIGNED owner by national_id; masked', async () => {
    // The flag that gates the SEPARATE reveal-cleartext path is OFF; the masked,
    // scope-bounded national_id match is still available (it is safe — RLS +
    // agentOwnerScope already limit the agent to owners they can see).
    await setAgentCapability('view_owners', true);
    await setAgentCapability('view_owner_pii', false);
    const nid = validNationalId(22);
    const id = await seedOwner(orgA.id, nid);
    const assignedProj = orgA.projects[0]!.id;
    await linkOwnerToProject(orgA.id, assignedProj, id);
    await db
      .insert(projectAssignments)
      .values({ projectId: assignedProj, userId: agentAId, assignedBy: mgrAId })
      .onConflictDoNothing();

    const res = await svc.search(agentA(), { national_id: nid });
    const hit = res.find((o) => o.id === id);
    expect(hit, 'a plain agent must find an assigned owner by national_id').toBeDefined();
    expect(hit!.nationalIdMasked).toMatch(/^•+\d{2}$/);
    expect(JSON.stringify(res)).not.toContain(nid);
  });

  it('THE BOUNDARY: an agent CANNOT find an owner that exists only in an UNASSIGNED project by national_id', async () => {
    // The real security boundary: an out-of-scope owner is invisible to the
    // national_id match. Holds whether or not the agent has view_owner_pii.
    for (const piiFlag of [false, true]) {
      await setAgentCapability('view_owners', true);
      await setAgentCapability('view_owner_pii', piiFlag);
      // Seeds must differ in the FIRST 8 digits — validNationalId slices(0,8),
      // so adjacent seeds (330/331) collapse to the same id and trip the
      // owners_org_natid_unique_active constraint. Use a ≥10 gap.
      const nid = validNationalId(piiFlag ? 360 : 350);
      const id = await seedOwner(orgA.id, nid);
      const unassignedProj = orgA.projects[1]!.id;
      await linkOwnerToProject(orgA.id, unassignedProj, id);

      const res = await svc.search(agentA(), { national_id: nid });
      expect(res.map((o) => o.id), `pii=${piiFlag}`).not.toContain(id);
    }
  });

  it('BOUNDARY no-oracle: out-of-scope hit-shape === genuine-miss-shape (both empty)', async () => {
    await setAgentCapability('view_owners', true);
    await setAgentCapability('view_owner_pii', false);
    const realButUnscopedNid = validNationalId(44);
    const id = await seedOwner(orgA.id, realButUnscopedNid);
    await linkOwnerToProject(orgA.id, orgA.projects[1]!.id, id); // UNASSIGNED project

    const outOfScope = await svc.search(agentA(), { national_id: realButUnscopedNid });
    const genuineMiss = await svc.search(agentA(), { national_id: validNationalId(999) });
    // An attacker cannot distinguish "ID exists outside my scope" from "no such ID".
    expect(outOfScope).toEqual([]);
    expect(genuineMiss).toEqual([]);
    expect(JSON.stringify(outOfScope)).toBe(JSON.stringify(genuineMiss));
  });

  it('CROSS-ORG no-leak: org-A never finds org-B owner sharing the same national_id', async () => {
    const sharedNid = validNationalId(55);
    const bId = await seedOwner(orgB.id, sharedNid);
    // org-A manager looks up the shared ID — org-B's owner must NEVER surface.
    const fromA = await svc.search(managerA(), { national_id: sharedNid });
    expect(fromA.map((o) => o.id)).not.toContain(bId);
  });

  it('AUDIT: a national_id lookup writes owner.pii_lookup (NO national_id value, NO targetId)', async () => {
    const nid = validNationalId(77);
    await seedOwner(orgA.id, nid);
    const before = (await piiLookupAuditRows(mgrAId)).length;

    await svc.search(managerA(), { national_id: nid });

    const rows = await piiLookupAuditRows(mgrAId);
    expect(rows.length).toBe(before + 1);
    const newest = rows[rows.length - 1]!;
    const blob = JSON.stringify(newest.afterState);
    // No national_id value in the audit payload (CLAUDE.md / Doc07).
    expect(blob).not.toContain(nid);
    expect(blob).not.toMatch(/(?<!\d)\d{9}(?!\d)/);
    // It DOES record what was searched + a non-PII count.
    expect(newest.afterState).toMatchObject({ searched_by: 'national_id' });
    expect((newest.afterState as { result_count?: unknown }).result_count).toBeTypeOf('number');
    // No targetId — a lookup spans 0..N owners; pinning one would be a soft oracle.
    expect(newest.targetId).toBeNull();
  });

  it('AUDIT: a PLAIN agent in-scope lookup is also audited (any national_id search is audit-worthy)', async () => {
    await setAgentCapability('view_owners', true);
    await setAgentCapability('view_owner_pii', false);
    const nid = validNationalId(88);
    const id = await seedOwner(orgA.id, nid);
    const assignedProj = orgA.projects[0]!.id;
    await linkOwnerToProject(orgA.id, assignedProj, id);
    await db
      .insert(projectAssignments)
      .values({ projectId: assignedProj, userId: agentAId, assignedBy: mgrAId })
      .onConflictDoNothing();

    const before = (await piiLookupAuditRows(agentAId)).length;
    await svc.search(agentA(), { national_id: nid });
    const after = (await piiLookupAuditRows(agentAId)).length;
    expect(after).toBe(before + 1);
  });

  it('AUDIT on miss: a no-match national_id lookup is STILL audited (result_count 0, no value)', async () => {
    const before = (await piiLookupAuditRows(mgrAId)).length;
    await svc.search(managerA(), { national_id: validNationalId(910) }); // no such owner
    const rows = await piiLookupAuditRows(mgrAId);
    expect(rows.length).toBe(before + 1);
    const newest = rows[rows.length - 1]!;
    expect((newest.afterState as { result_count?: unknown }).result_count).toBe(0);
  });
});
