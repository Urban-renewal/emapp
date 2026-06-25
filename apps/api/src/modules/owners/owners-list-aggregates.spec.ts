/**
 * Owners-list ENRICHED aggregates — INDEPENDENT acceptance tests written from
 * the SPEC before the builder. These assert the TARGET behavior; they are RED
 * against current code (the fields are `undefined` today) and GREEN after the
 * builder lands them.
 *
 * The feature under test: `OwnersService.list(user, query)` must return, for
 * EACH owner item, two NEW aggregate fields ALONGSIDE the existing masked owner
 * projection:
 *
 *   - `apartmentCount: number` — count of that owner's ACTIVE ownerships
 *     (ownerships.ended_at IS NULL): how many apartments they currently own.
 *   - `pendingSignatureCount: number` — count of signature_requests for that
 *     owner with status='pending'.
 *
 * Both are LEFT-side aggregates: an owner with zero ownerships / zero pending
 * requests must yield 0 (NOT null / undefined).
 *
 * SECURITY (the load-bearing assertion) — for an AGENT both counts MUST be
 * scoped to the agent's actively-assigned projects only (mirroring the existing
 * `agentOwnerScope` EXISTS):
 *   - apartmentCount: ownerships → apartments → buildings → project ∈
 *     project_assignments(user_id = agent, unassigned_at IS NULL).
 *   - pendingSignatureCount: signature_requests → documents → apartments →
 *     buildings → project ∈ the same assigned set.
 * An agent must NEVER see a count that includes apartments/signatures from a
 * project they are not assigned to — an unscoped count is a cross-project info
 * leak. Managers/viewers see whole-org counts (RLS-bound).
 *
 * Real DB (Neon) — the aggregate joins + RLS org-scope + agent project-scope are
 * the whole point; mocking would defeat it. Seeding + auth style mirror
 * owner-project-surfacing.spec.ts.
 *
 * Run (RED check):
 *   infisical run --env=dev -- pnpm --filter @emapp/api exec \
 *     vitest run src/modules/owners/owners-list-aggregates.spec.ts
 */
import { randomUUID } from 'node:crypto';

import {
  apartments,
  buildings,
  db,
  documents,
  encryptOwnerPii,
  memberships,
  owners,
  projectAssignments,
  signatureRequests,
  users,
  withTenant,
} from '@emapp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { OwnersService } from './owners.service';

let ownersSvc: OwnersService;
let org: TestOrg;
let managerId: string;
let agentId: string;

const MGR_SID = '00000000-0000-4000-8000-00000000e001';
const AGENT_SID = '00000000-0000-4000-8000-00000000e0a1';

function manager(orgId = org.id): AccessTokenPayload {
  return {
    sub: managerId,
    orgId,
    role: 'manager',
    sid: MGR_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

function agent(orgId = org.id): AccessTokenPayload {
  return {
    sub: agentId,
    orgId,
    role: 'agent',
    sid: AGENT_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

// ---- agent / capability seeding (mirror owner-project-surfacing.spec.ts) -----

/** Seed an AGENT user + an active org membership. The default membership
 *  capabilities already carry `view_owners: true` (tenancy.ts default), so the
 *  agent can read owners. */
async function seedAgent(orgId: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `agent-${randomUUID()}@test.local`, name: 'Agent', passwordHash: '$2b$12$x' })
    .returning({ id: users.id });
  await db
    .insert(memberships)
    .values({ userId: u!.id, orgId, role: 'agent', acceptedAt: new Date() });
  return u!.id;
}

/** Assign the agent to a project (active = unassigned_at NULL). */
async function assignAgentToProject(projectId: string): Promise<void> {
  await db.insert(projectAssignments).values({ projectId, userId: agentId, assignedBy: managerId });
}

/** Soft-unassign the agent from a project (sets unassigned_at). */
async function unassignAgentFromProject(projectId: string): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE project_assignments SET unassigned_at = now()
       WHERE project_id = $1 AND user_id = $2 AND unassigned_at IS NULL`,
      [projectId, agentId],
    );
  } finally {
    c.release();
  }
}

// ---- owner / apartment seeding (mirror owner-project-surfacing.spec.ts) ------

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

/** Fresh apartment under a NEW building in the given project (so each apartment
 *  is isolated for the per-apartment ownership-sum trigger + the unique-active
 *  (apartment,owner) index). Returns the apartment id. */
async function seedApartment(orgId: string, projectId: string): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const [bld] = await tx
      .insert(buildings)
      .values({
        projectId,
        address: `agg ${Date.now()}-${Math.random()}`,
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

/** Insert ONE ownership row DIRECTLY via the provider pool (BYPASSRLS) — full
 *  set in ONE tx (the DEFERRED sum trigger validates the committed set). `ended`
 *  drives ended_at: an ENDED ownership (ended_at set) is HISTORICAL and must NOT
 *  count toward apartmentCount. pct 100, fraction num=round(pct*100)/den=10000 —
 *  the same derivation insertOwnerSet uses in the sibling spec. */
async function insertOwnership(
  apartmentId: string,
  ownerId: string,
  opts: { ended?: boolean } = {},
): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `INSERT INTO ownerships
         (apartment_id, owner_id, ownership_pct, relationship, share_numerator, share_denominator, ended_at)
       VALUES ($1, $2, '100', 'owner', 10000, 10000, ${opts.ended ? 'now()' : 'NULL'})`,
      [apartmentId, ownerId],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Seed ONE document on a given apartment (org-scoped) + ONE signature_request
 * against it for the given owner with the given status. Both go in inside
 * `withTenant` (org-scoped tables, RLS) so they land for the seeded org.
 *
 * NOT-NULL columns satisfied here (the implementer must know — read
 * packages/db/src/schema/artifacts.ts):
 *   documents:           org_id, name, type, mime_type, size_bytes, r2_key,
 *                        content_hash, uploaded_by (all NOT NULL).
 *   signature_requests:  org_id, document_id, owner_id, jti (UNIQUE),
 *                        status (CHECK pending|signed|cancelled|expired,
 *                        default pending), expires_at, created_by (all NOT NULL
 *                        except status which defaults).
 * The pendingSignatureCount→document→apartment join is what scopes an agent's
 * count by project, so each signature_request's document MUST hang off an
 * apartment in a known project.
 */
async function seedSignatureRequest(
  orgId: string,
  apartmentId: string,
  ownerId: string,
  status: 'pending' | 'signed' | 'cancelled',
): Promise<void> {
  await withTenant(orgId, async (tx) => {
    const [doc] = await tx
      .insert(documents)
      .values({
        orgId,
        apartmentId,
        name: `sig-doc-${randomUUID()}`,
        type: 'consent_form',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
        r2Key: `test/${randomUUID()}.pdf`,
        contentHash: randomUUID().replace(/-/g, ''),
        uploadedBy: managerId,
      })
      .returning({ id: documents.id });
    await tx.insert(signatureRequests).values({
      orgId,
      documentId: doc!.id,
      ownerId,
      jti: randomUUID(),
      status,
      // NOT NULL, no default — any future timestamp is fine for these tests.
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      createdBy: managerId,
    });
  });
}

/**
 * Call OwnersService.list and return the item for `ownerId` typed with the two
 * NEW (not-yet-on-type) aggregate fields as OPTIONAL — the `as` cast lets the
 * spec compile while the builder hasn't added them to `Owner`. Until the builder
 * lands the feature these read `undefined` → the value assertions go RED, which
 * is the whole point. Pages through the list (limit 100) until the owner is
 * found, so an unrelated seed earlier in the suite can't push it off page 1.
 */
type AggItem = { id: string } & { apartmentCount?: number; pendingSignatureCount?: number };

async function listItemFor(user: AccessTokenPayload, ownerId: string): Promise<AggItem> {
  let cursor: string | undefined;
  for (let i = 0; i < 50; i += 1) {
    const page = await ownersSvc.list(user, { limit: 100, cursor });
    const hit = page.data.find((o) => o.id === ownerId) as AggItem | undefined;
    if (hit) return hit;
    if (!page.page.has_more || !page.page.cursor) break;
    cursor = page.page.cursor;
  }
  throw new Error(`owner ${ownerId} not found in list for ${user.role}`);
}

beforeAll(async () => {
  await setupTestDatabase();
  ownersSvc = new OwnersService();
  const tag = `agg-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  agentId = await seedAgent(org.id);
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

// ===========================================================================
// (a) MANAGER — whole-org counts, exact values vs seeded fixtures.
// ===========================================================================
describe('(a) manager owners-list enriched aggregates', () => {
  it('1) apartmentCount = number of ACTIVE ownerships; an ENDED ownership does NOT count', async () => {
    const projectP = org.projects[0]!.id;
    const owner = await seedOwner(org.id);
    // 2 active apartments…
    const aptActive1 = await seedApartment(org.id, projectP);
    const aptActive2 = await seedApartment(org.id, projectP);
    await insertOwnership(aptActive1, owner);
    await insertOwnership(aptActive2, owner);
    // …+ 1 ENDED ownership (ended_at set) — must be excluded.
    const aptEnded = await seedApartment(org.id, projectP);
    await insertOwnership(aptEnded, owner, { ended: true });

    const item = await listItemFor(manager(), owner);
    // RED now: apartmentCount is undefined → this exact-value assert fails.
    expect(item.apartmentCount).toBe(2);
  }, 30_000);

  it('2) pendingSignatureCount counts ONLY status=pending (signed / cancelled excluded)', async () => {
    const projectP = org.projects[0]!.id;
    const owner = await seedOwner(org.id);
    const apt = await seedApartment(org.id, projectP);
    await insertOwnership(apt, owner);
    // 2 pending + 1 signed + 1 cancelled → only the 2 pending count.
    await seedSignatureRequest(org.id, apt, owner, 'pending');
    await seedSignatureRequest(org.id, apt, owner, 'pending');
    await seedSignatureRequest(org.id, apt, owner, 'signed');
    await seedSignatureRequest(org.id, apt, owner, 'cancelled');

    const item = await listItemFor(manager(), owner);
    // RED now: pendingSignatureCount is undefined → fails.
    expect(item.pendingSignatureCount).toBe(2);
    // And this owner's single active apartment is reflected too.
    expect(item.apartmentCount).toBe(1);
  }, 30_000);

  it('3) an owner with ZERO ownerships and ZERO signature_requests → BOTH counts = 0 (not null/undefined)', async () => {
    const bareOwner = await seedOwner(org.id);
    const item = await listItemFor(manager(), bareOwner);
    // The LEFT-side aggregate must coalesce to 0. RED now (undefined); after the
    // builder it must be the NUMBER 0, never null — assert strict equality.
    expect(item.apartmentCount).toBe(0);
    expect(item.pendingSignatureCount).toBe(0);
  }, 30_000);
});

// ===========================================================================
// (b) AGENT project-scope — the SECURITY assertion. Both counts must include
// ONLY the agent's actively-assigned project. An unscoped count that summed
// apartments / signatures across BOTH projects would be a cross-project info
// leak (the agent learns the owner owns property / has pending signatures in a
// project they were never assigned to). This pins that the agentOwnerScope-style
// EXISTS is applied to BOTH aggregates, not just the row-visibility filter.
// ===========================================================================
describe('(b) agent project-scope on owners-list aggregates', () => {
  it('4) agent assigned to P1 (not P2): counts include ONLY the P1 apartment + its pending signatures', async () => {
    const projectP1 = org.projects[0]!.id; // agent WILL be assigned
    const projectP2 = org.projects[1]!.id; // agent NOT assigned
    const owner = await seedOwner(org.id);

    // A1 in the ASSIGNED project P1: 1 active ownership + 1 pending signature.
    const apt1 = await seedApartment(org.id, projectP1);
    await insertOwnership(apt1, owner);
    await seedSignatureRequest(org.id, apt1, owner, 'pending');

    // A2 in the UNASSIGNED project P2: 1 active ownership + 1 pending signature.
    // For the agent these MUST be invisible to BOTH counts (cross-project leak).
    const apt2 = await seedApartment(org.id, projectP2);
    await insertOwnership(apt2, owner);
    await seedSignatureRequest(org.id, apt2, owner, 'pending');

    await assignAgentToProject(projectP1); // assigned to P1 only
    try {
      // Manager baseline FIRST — proves the seed really spans both projects, so
      // the agent's narrower numbers below are the SCOPE, not a seeding artifact.
      const mgrItem = await listItemFor(manager(), owner);
      expect(mgrItem.apartmentCount).toBe(2); // both A1 + A2
      expect(mgrItem.pendingSignatureCount).toBe(2); // both pending requests

      const agentItem = await listItemFor(agent(), owner);
      // SECURITY: only the P1 (assigned) apartment + its pending signature count.
      // A count of 2 here would mean the agent sees the P2 apartment/signature →
      // a cross-project info leak. RED now (undefined); GREEN once the builder
      // scopes BOTH aggregates by project_assignments for agents.
      expect(agentItem.apartmentCount).toBe(1);
      expect(agentItem.pendingSignatureCount).toBe(1);
    } finally {
      await unassignAgentFromProject(projectP1);
    }
  }, 30_000);
});

// ---- (c) archived view filter (show-archived) ------------------------------
// Seed an owner that is ALREADY soft-archived (archived_at set on insert), so
// no extra drizzle `eq`/update plumbing is needed.
async function seedArchivedOwner(orgId: string): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, {
      nationalId: natId(),
      name: 'ארכיון',
      phone: '0541113333',
    });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId,
        nameEncrypted: pii.nameEncrypted,
        nameHash: pii.nameHash,
        email: `arch-${randomUUID()}@test.local`,
        nationalIdEncrypted: pii.nationalIdEncrypted,
        nationalIdHash: pii.nationalIdHash,
        phoneEncrypted: pii.phoneEncrypted,
        phoneHash: pii.phoneHash,
        archivedAt: new Date(),
      })
      .returning({ id: owners.id });
    return row!.id;
  });
}

async function listAllIds(user: AccessTokenPayload, archived: boolean): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await ownersSvc.list(user, { limit: 100, cursor, archived });
    for (const o of page.data) ids.add(o.id);
    cursor = page.page.cursor ?? undefined;
  } while (cursor);
  return ids;
}

describe('(c) owners-list archived filter (show-archived view)', () => {
  it('default/active view returns active owners and EXCLUDES archived', async () => {
    const active = await seedOwner(org.id);
    const archived = await seedArchivedOwner(org.id);
    const ids = await listAllIds(manager(), false);
    expect(ids.has(active), 'active owner present in active view').toBe(true);
    expect(ids.has(archived), 'archived owner NOT in active view').toBe(false);
  }, 30_000);

  it('archived view returns archived owners and EXCLUDES active', async () => {
    const active = await seedOwner(org.id);
    const archived = await seedArchivedOwner(org.id);
    const ids = await listAllIds(manager(), true);
    expect(ids.has(archived), 'archived owner present in archived view').toBe(true);
    expect(ids.has(active), 'active owner NOT in archived view').toBe(false);
  }, 30_000);
});

// ---- (d) B2 needs-attention filter (≥1 pending signature) ------------------
// Additive WHERE predicate, keyset-safe: an owner with a PENDING signature is
// kept; one with none is filtered out. For an AGENT the predicate is project-
// scoped (mirrors the agent-scoped pendingSignatureCount), so a pending
// signature in an UNASSIGNED project must NOT make the owner "need attention".
async function listAllIdsAttention(
  user: AccessTokenPayload,
  needsAttention: boolean,
): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await ownersSvc.list(user, { limit: 100, cursor, needsAttention });
    for (const o of page.data) ids.add(o.id);
    cursor = page.page.cursor ?? undefined;
  } while (cursor);
  return ids;
}

describe('(d) owners-list needs-attention filter', () => {
  it('needsAttention keeps owners with a PENDING signature, drops those without', async () => {
    const projectP = org.projects[0]!.id;
    const withPending = await seedOwner(org.id);
    const apt = await seedApartment(org.id, projectP);
    await insertOwnership(apt, withPending);
    await seedSignatureRequest(org.id, apt, withPending, 'pending');

    // An owner whose only signature is SIGNED (not pending) must be dropped.
    const noPending = await seedOwner(org.id);
    const apt2 = await seedApartment(org.id, projectP);
    await insertOwnership(apt2, noPending);
    await seedSignatureRequest(org.id, apt2, noPending, 'signed');

    const filtered = await listAllIdsAttention(manager(), true);
    expect(filtered.has(withPending), 'pending owner present in attention view').toBe(true);
    expect(filtered.has(noPending), 'signed-only owner ABSENT in attention view').toBe(false);

    // And without the flag BOTH are visible (the filter is purely additive).
    const all = await listAllIdsAttention(manager(), false);
    expect(all.has(withPending)).toBe(true);
    expect(all.has(noPending)).toBe(true);
  }, 30_000);

  it('agent: a PENDING signature in an UNASSIGNED project does NOT mark the owner as needing attention', async () => {
    const assignedProj = org.projects[0]!.id; // agent assigned
    const unassignedProj = org.projects[1]!.id; // agent NOT assigned
    const owner = await seedOwner(org.id);

    // ONLY pending signature is in the UNASSIGNED project → invisible to agent.
    const aptUnassigned = await seedApartment(org.id, unassignedProj);
    await insertOwnership(aptUnassigned, owner);
    await seedSignatureRequest(org.id, aptUnassigned, owner, 'pending');
    // Give the owner an apartment in the assigned project so the agent CAN see
    // the row (scope), but with NO pending signature there.
    const aptAssigned = await seedApartment(org.id, assignedProj);
    await insertOwnership(aptAssigned, owner);

    await assignAgentToProject(assignedProj);
    try {
      // Manager baseline: the owner DOES have a pending signature org-wide.
      const mgr = await listAllIdsAttention(manager(), true);
      expect(mgr.has(owner), 'manager sees the owner needs attention (org-wide pending)').toBe(
        true,
      );

      // SECURITY: the agent's pending signature is in an unassigned project, so
      // the attention filter must EXCLUDE this owner for the agent (no leak of a
      // pending signature in a project the agent can't see).
      const ag = await listAllIdsAttention(agent(), true);
      expect(ag.has(owner), 'agent does NOT see the owner as needing attention').toBe(false);
    } finally {
      await unassignAgentFromProject(assignedProj);
    }
  }, 30_000);
});
