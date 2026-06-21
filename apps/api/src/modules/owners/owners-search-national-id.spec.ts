/**
 * NS2 (MASTER-PLAN-V13 Wave B) — PII-gated cross-project national_id lookup on
 * the owners HMAC search (`OwnersService.search`).
 *
 * Asserts against the REAL local DB — the lookup is a keyed HMAC equality on the
 * stored `national_id_hash` column (pgcrypto + the same hashField(value,
 * PII_HASH_KEY) the writers use), so mocking would defeat the test.
 *
 * THE CONTRACT under test (PII + security-sensitive):
 *  - AUTHORIZED cross-project lookup: a manager (always view_owner_pii) — and an
 *    agent WITH view_owner_pii — finds an owner by national_id across the org's
 *    projects (an owner the agent reaches via an assigned project).
 *  - NO-ORACLE gating: a caller WITHOUT view_owner_pii (an agent with the flag
 *    off) gets a national_id lookup that is completely INERT — empty result,
 *    byte-identical to a miss, NO 403, NO leak that the ID exists.
 *  - CROSS-ORG no-leak: org-A never finds org-B's owner who shares the same
 *    national_id (RLS).
 *  - MASKING: the matched owner comes back with national_id MASKED — finding by
 *    ID does NOT dump the cleartext 9-digit ID back.
 *  - AUDIT: an authorized national_id lookup writes an `owner.pii_lookup` row;
 *    the row carries NO national_id value (only field name + result count). An
 *    UNAUTHORIZED lookup writes NO such row.
 *  - AGENT SCOPE: an agent with view_owner_pii still only matches owners in their
 *    assigned projects (an owner with the same ID only in an unassigned project
 *    is invisible).
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
async function piiLookupAuditRows(actorId: string): Promise<{ afterState: unknown }[]> {
  return withTenant(orgA.id, (tx) =>
    tx
      .select({ afterState: auditLog.afterState })
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

describe('NS2 — PII-gated national_id lookup on owners search', () => {
  it('manager (view_owner_pii) finds an owner by national_id across the org; result MASKED', async () => {
    const nid = validNationalId(11);
    const id = await seedOwner(orgA.id, nid);

    const res = await svc.search(managerA(), { national_id: nid });
    const hit = res.find((o) => o.id === id);
    expect(hit, 'authorized national_id lookup must find the owner').toBeDefined();
    // Masked — finding by ID does NOT dump the cleartext ID back.
    expect(hit!.nationalIdMasked).toMatch(/^•+\d{2}$/);
    // No cleartext 9-digit national_id anywhere in the NS2 response.
    expect(JSON.stringify(res)).not.toContain(nid);
    expect(JSON.stringify(res)).not.toMatch(/(?<!\d)\d{9}(?!\d)/);
  });

  it('agent WITH view_owner_pii finds an owner by national_id in an ASSIGNED project; masked', async () => {
    await setAgentCapability('view_owners', true);
    await setAgentCapability('view_owner_pii', true);
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
    expect(hit).toBeDefined();
    expect(hit!.nationalIdMasked).toMatch(/^•+\d{2}$/);
    expect(JSON.stringify(res)).not.toContain(nid);
  });

  it('NO-ORACLE: agent WITHOUT view_owner_pii → national_id lookup is INERT (empty, no leak)', async () => {
    await setAgentCapability('view_owners', true); // can see owners…
    await setAgentCapability('view_owner_pii', false); // …but NOT by PII.
    const nid = validNationalId(33);
    const id = await seedOwner(orgA.id, nid);
    const assignedProj = orgA.projects[0]!.id;
    await linkOwnerToProject(orgA.id, assignedProj, id);
    await db
      .insert(projectAssignments)
      .values({ projectId: assignedProj, userId: agentAId, assignedBy: mgrAId })
      .onConflictDoNothing();

    // The owner EXISTS, is in an assigned project, and the ID is correct — yet
    // the national_id branch is inert, so the result is empty (identical to a
    // genuine miss). No 403 either — the branch silently does not match.
    const res = await svc.search(agentA(), { national_id: nid });
    expect(res.map((o) => o.id)).not.toContain(id);
    expect(res).toEqual([]);
  });

  it('NO-ORACLE: unauthorized hit-shape === miss-shape (a real ID and a bogus ID both empty)', async () => {
    await setAgentCapability('view_owners', true);
    await setAgentCapability('view_owner_pii', false);
    const realNid = validNationalId(44);
    await seedOwner(orgA.id, realNid);

    const real = await svc.search(agentA(), { national_id: realNid });
    const bogus = await svc.search(agentA(), { national_id: validNationalId(999) });
    // An attacker cannot distinguish "ID exists" from "ID does not exist".
    expect(real).toEqual([]);
    expect(bogus).toEqual([]);
    expect(JSON.stringify(real)).toBe(JSON.stringify(bogus));
  });

  it('CROSS-ORG no-leak: org-A never finds org-B owner sharing the same national_id', async () => {
    const sharedNid = validNationalId(55);
    const bId = await seedOwner(orgB.id, sharedNid);
    // org-A manager looks up the shared ID — org-B's owner must NEVER surface.
    const fromA = await svc.search(managerA(), { national_id: sharedNid });
    expect(fromA.map((o) => o.id)).not.toContain(bId);
  });

  it('AGENT SCOPE: agent with view_owner_pii does NOT match an owner only in an UNASSIGNED project', async () => {
    await setAgentCapability('view_owners', true);
    await setAgentCapability('view_owner_pii', true);
    const nid = validNationalId(66);
    const id = await seedOwner(orgA.id, nid);
    const unassignedProj = orgA.projects[1]!.id;
    await linkOwnerToProject(orgA.id, unassignedProj, id);

    const res = await svc.search(agentA(), { national_id: nid });
    expect(res.map((o) => o.id)).not.toContain(id);
  });

  it('AUDIT: an authorized national_id lookup writes owner.pii_lookup with NO national_id value', async () => {
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
  });

  it('AUDIT no-oracle: an UNAUTHORIZED national_id lookup writes NO pii_lookup row', async () => {
    await setAgentCapability('view_owners', true);
    await setAgentCapability('view_owner_pii', false);
    const before = (await piiLookupAuditRows(agentAId)).length;
    await svc.search(agentA(), { national_id: validNationalId(88) });
    const after = (await piiLookupAuditRows(agentAId)).length;
    expect(after).toBe(before);
  });
});
