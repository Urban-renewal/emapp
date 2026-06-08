/**
 * P5 S1 — `resolveNotificationRecipients` recipient-set spec (real DB, adversarial).
 *
 * Written by the TEST-AUTHOR agent — INDEPENDENT of the builder. The resolved
 * recipient set is the load-bearing thing for the whole notifications engine
 * (every emit site routes through this ONE helper), so every clause of the
 * D-O7 default rule is pinned against a real, RLS-scoped tx:
 *
 *   recipients =
 *       (ACTIVE org managers: memberships role='manager' AND revoked_at IS NULL)
 *     ∪ (ACTIVE project assignees: project_assignments unassigned_at IS NULL,
 *        ONLY when ctx.projectId given)
 *     ∪ (ctx.relevantUserIds ?? [])
 *     − ctx.actorUserId
 *   …deduped.
 *
 * Ground truth is the helper's OWN return value resolved inside a real
 * `withTenant(orgId)` tx — no mocking of the tx (a mocked drizzle chain would
 * only re-assert its own canned rows and hide whether the SQL filters
 * revoked_at / unassigned_at / org scope are actually wired). We assert the
 * resolved id Set with set semantics (membership + ABSENCE + exact count for
 * dedup), never tautologies.
 *
 * A — `resolveNotificationRecipients` directly (A1..A7).
 * B — the document_uploaded retrofit end-to-end (managers + assigned agents,
 *     uploader excluded) + the best-effort no-throw wrapper.
 *
 * Seeds are unique per run; the orgs/users created here are bespoke (NOT the
 * shared factory users) so the manager set is known EXACTLY.
 */
import { randomUUID } from 'node:crypto';

import {
  db,
  memberships,
  organizations,
  projectAssignments,
  projects,
  users,
  withTenant,
  type IStorageProvider,
} from '@emapp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import type { AccessTokenPayload } from '../auth/auth.service';
import { DocumentsService } from '../documents/documents.service';

import { resolveNotificationRecipients } from './notification-recipients';
import { NotificationsProducerService } from './notifications-producer.service';

// ── unique-per-run identity for everything we seed ────────────────────────
const RUN = randomUUID().slice(0, 8);

interface Seeded {
  orgId: string;
  manager1: string;
  manager2: string;
  managerRevoked: string; // role=manager but revoked_at set → MUST be excluded
  agentP: string; // assigned to project P (active)
  agentPstale: string; // assigned to P then unassigned → MUST be excluded
  agentUnassigned: string; // member, NOT assigned to any project
  agentQ: string; // assigned to a DIFFERENT project Q (wrong project)
  viewer: string; // role=viewer, no assignment → never a recipient
  projectP: string;
  projectQ: string;
}

const SID = '00000000-0000-4000-8000-0000000000c1';

const storage = {
  getUploadUrl: async () => 'https://x/upload',
  getDownloadUrl: async () => ({ url: 'https://x/dl', filename: 'f.pdf' }),
  head: async () => null,
  delete: async () => undefined,
} as unknown as IStorageProvider;

const ALL_CAPS = {
  edit_project_data: false,
  manage_documents: true,
  manage_signatures: false,
  manage_tasks: false,
  run_imports: false,
  view_owners: true,
  view_owner_pii: false,
};

async function mkUser(label: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `${label}-${RUN}-${randomUUID().slice(0, 8)}@test.local`,
      name: label,
      passwordHash: '$2b$12$placeholder',
    })
    .returning({ id: users.id });
  return u!.id;
}

async function mkMember(
  orgId: string,
  userId: string,
  role: 'manager' | 'agent' | 'viewer',
  opts: { revoked?: boolean } = {},
): Promise<void> {
  await db.insert(memberships).values({
    userId,
    orgId,
    role,
    acceptedAt: new Date(),
    capabilities: ALL_CAPS,
    ...(opts.revoked ? { revokedAt: new Date() } : {}),
  });
}

async function mkProject(orgId: string, createdBy: string, name: string): Promise<string> {
  const [p] = await withTenant(orgId, async (tx) =>
    tx
      .insert(projects)
      .values({ orgId, name: `${name}-${RUN}`, type: 'tama38_1', createdBy })
      .returning({ id: projects.id }),
  );
  return p!.id;
}

async function assign(
  orgId: string,
  projectId: string,
  userId: string,
  assignedBy: string,
  opts: { unassigned?: boolean } = {},
): Promise<void> {
  // project_assignments RLS is FORCE + org-scoped via app.organization_id, so
  // the INSERT MUST run inside withTenant(orgId) (the GUC must be set or the
  // WITH CHECK subquery sees no projects). withTenant pins the org GUC.
  await withTenant(orgId, async (tx) => {
    await tx.insert(projectAssignments).values({
      projectId,
      userId,
      assignedBy,
      ...(opts.unassigned ? { unassignedAt: new Date() } : {}),
    });
  });
}

/** Seed one fully-populated org. Returns all the actor ids. */
async function seedOrg(tag: string): Promise<Seeded> {
  const [org] = await db
    .insert(organizations)
    .values({
      name: `${tag}-${RUN}`,
      slug: `${tag}-${RUN}-${randomUUID().slice(0, 8)}`.toLowerCase(),
    })
    .returning({ id: organizations.id });
  const orgId = org!.id;

  const manager1 = await mkUser('mgr1');
  const manager2 = await mkUser('mgr2');
  const managerRevoked = await mkUser('mgrRevoked');
  const agentP = await mkUser('agentP');
  const agentPstale = await mkUser('agentPstale');
  const agentUnassigned = await mkUser('agentUnassigned');
  const agentQ = await mkUser('agentQ');
  const viewer = await mkUser('viewer');

  await mkMember(orgId, manager1, 'manager');
  await mkMember(orgId, manager2, 'manager');
  await mkMember(orgId, managerRevoked, 'manager', { revoked: true });
  await mkMember(orgId, agentP, 'agent');
  await mkMember(orgId, agentPstale, 'agent');
  await mkMember(orgId, agentUnassigned, 'agent');
  await mkMember(orgId, agentQ, 'agent');
  await mkMember(orgId, viewer, 'viewer');

  const projectP = await mkProject(orgId, manager1, 'P');
  const projectQ = await mkProject(orgId, manager1, 'Q');

  await assign(orgId, projectP, agentP, manager1);
  await assign(orgId, projectP, agentPstale, manager1, { unassigned: true });
  await assign(orgId, projectQ, agentQ, manager1);

  // Seed-integrity guard: confirm the ACTIVE P assignment actually persisted
  // (RLS on project_assignments is FORCE; a silently-rejected insert would make
  // the assignee-scope assertions vacuously wrong). Read via providerPool
  // (BYPASSRLS) so this is ground truth, independent of any GUC.
  {
    const c = await providerPool.connect();
    try {
      const r = await c.query(
        `SELECT user_id, unassigned_at FROM project_assignments WHERE project_id = $1`,
        [projectP],
      );
      const active = r.rows.filter((x) => x.unassigned_at === null).map((x) => x.user_id);
      if (!active.includes(agentP)) {
        throw new Error(
          `SEED FAILED: agentP not an active assignee of projectP. rows=${JSON.stringify(r.rows)}`,
        );
      }
    } finally {
      c.release();
    }
  }

  return {
    orgId,
    manager1,
    manager2,
    managerRevoked,
    agentP,
    agentPstale,
    agentUnassigned,
    agentQ,
    viewer,
    projectP,
    projectQ,
  };
}

/** Resolve recipients inside a real org-scoped tx (the production access path). */
function resolve(
  orgId: string,
  ctx: Parameters<typeof resolveNotificationRecipients>[2],
): Promise<string[]> {
  return withTenant(orgId, (tx) => resolveNotificationRecipients(tx, orgId, ctx));
}

let s: Seeded;
// A8 seeds a membership-less user; tracked here so afterAll can purge it (it
// has NO org row, so it isn't covered by cleanupOrgRows).
let a8NonMember: string | undefined;

beforeAll(async () => {
  s = await seedOrg('NotifRecip');
}, 120_000);

afterAll(async () => {
  if (a8NonMember) {
    const c = await providerPool.connect();
    try {
      await c.query(`DELETE FROM users WHERE id = $1`, [a8NonMember]);
    } finally {
      c.release();
    }
  }
  // Best-effort residue cleanup. The org row is INTENTIONALLY left behind: the
  // document_uploaded path writes append-only `audit_log` rows (immutable — a
  // DELETE raises "audit_log rows are immutable"), and those FK the org, so the
  // org can't be removed. This matches the codebase norm (test orgs are unique
  // per run and simply left). We DO purge the deletable child rows we created.
  // providerPool (BYPASSRLS) so the delete is unconditional.
  await cleanupOrgRows(s.orgId);
});

/** Delete the deletable rows we created for an org (NOT audit_log / org row). */
async function cleanupOrgRows(orgId: string): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(`DELETE FROM notifications WHERE org_id = $1`, [orgId]);
    await c.query(
      `DELETE FROM project_assignments WHERE project_id IN
         (SELECT id FROM projects WHERE org_id = $1)`,
      [orgId],
    );
    await c.query(`DELETE FROM documents WHERE org_id = $1`, [orgId]);
    // projects/memberships kept: audit_log FKs the org (immutable) so a full
    // teardown is impossible anyway; leaving these is harmless (org is unique).
  } finally {
    c.release();
  }
}

// ───────────────────────────────────────────────────────────────────────────
// A — resolveNotificationRecipients directly
// ───────────────────────────────────────────────────────────────────────────
describe('A — resolveNotificationRecipients (D-O7 default rule)', () => {
  it('A1) managers ALWAYS included (actor is a non-manager) → both managers present', async () => {
    // actor = viewer (a member who is never otherwise a recipient) so the
    // managers-always assertion isn't confounded by actor-exclusion.
    const ids = new Set(await resolve(s.orgId, { projectId: s.projectP, actorUserId: s.viewer }));
    expect(ids.has(s.manager1)).toBe(true);
    expect(ids.has(s.manager2)).toBe(true);
  });

  it('A2) project scope: P-assignee IN; non-assigned + Q-assignee + viewer OUT', async () => {
    // actor = viewer so agentP is a pure recipient (NOT the actor) — the
    // assignee-IN assertion would be confounded if the actor WERE agentP.
    const ids = new Set(await resolve(s.orgId, { projectId: s.projectP, actorUserId: s.viewer }));
    // assigned to P (active) → included
    expect(ids.has(s.agentP)).toBe(true);
    // member but NOT assigned to P → excluded
    expect(ids.has(s.agentUnassigned)).toBe(false);
    // assigned to a DIFFERENT project Q → excluded (wrong project)
    expect(ids.has(s.agentQ)).toBe(false);
    // viewer: not a manager, not assigned → excluded. Asserted with a DIFFERENT
    // actor (manager1) so viewer's absence is by ROLE, not by actor-exclusion.
    const ids2 = new Set(
      await resolve(s.orgId, { projectId: s.projectP, actorUserId: s.manager1 }),
    );
    expect(ids2.has(s.viewer)).toBe(false);
  });

  it('A3) actor excluded: actor=manager1 → manager1 OUT, manager2 still IN', async () => {
    const ids = new Set(await resolve(s.orgId, { projectId: s.projectP, actorUserId: s.manager1 }));
    expect(ids.has(s.manager1)).toBe(false); // you are not notified of your own action
    expect(ids.has(s.manager2)).toBe(true); // the OTHER manager still is
    // (agentP still resolves for project P — unrelated to the actor swap)
    expect(ids.has(s.agentP)).toBe(true);
  });

  it('A4) relevantUserIds union + dedup: manager1 appears EXACTLY once; still excluded if actor', async () => {
    // union brings agentUnassigned in; manager1 is already a manager → dedup test.
    const list = await resolve(s.orgId, {
      projectId: s.projectP,
      relevantUserIds: [s.agentUnassigned, s.manager1],
      actorUserId: s.agentP,
    });
    const ids = new Set(list);
    // agentUnassigned now included via relevantUserIds (was OUT in A2)
    expect(ids.has(s.agentUnassigned)).toBe(true);
    // dedup: manager1 (manager AND relevant) appears exactly ONCE in the array
    expect(list.filter((id) => id === s.manager1)).toHaveLength(1);
    expect(ids.has(s.manager1)).toBe(true);
    // the returned array has no duplicates AT ALL (set size == array length)
    expect(list).toHaveLength(ids.size);

    // …and relevant-but-also-actor is STILL excluded (actor wins over union):
    const list2 = await resolve(s.orgId, {
      projectId: s.projectP,
      relevantUserIds: [s.manager1, s.agentUnassigned],
      actorUserId: s.manager1, // actor is also in relevantUserIds
    });
    expect(new Set(list2).has(s.manager1)).toBe(false);
    // the other relevant user survives
    expect(new Set(list2).has(s.agentUnassigned)).toBe(true);
  });

  it('A5) NO projectId: managers (+ relevant − actor) only; NO project assignees leak', async () => {
    const ids = new Set(await resolve(s.orgId, { actorUserId: s.manager1 }));
    // managers (minus actor):
    expect(ids.has(s.manager1)).toBe(false);
    expect(ids.has(s.manager2)).toBe(true);
    // NO project fan-out without a projectId:
    expect(ids.has(s.agentP)).toBe(false);
    expect(ids.has(s.agentQ)).toBe(false);
    // viewer / unassigned still out:
    expect(ids.has(s.viewer)).toBe(false);
    expect(ids.has(s.agentUnassigned)).toBe(false);

    // with relevantUserIds and no projectId: relevant added, still no assignees.
    const ids2 = new Set(
      await resolve(s.orgId, { relevantUserIds: [s.agentP], actorUserId: s.manager1 }),
    );
    expect(ids2.has(s.agentP)).toBe(true); // via relevant, NOT via project
    expect(ids2.has(s.manager2)).toBe(true);
  });

  it('A6) revoked manager + unassigned agent EXCLUDED', async () => {
    // actor = viewer so the live-manager/live-assignee sanity checks below are
    // about membership state, not actor-exclusion.
    const ids = new Set(await resolve(s.orgId, { projectId: s.projectP, actorUserId: s.viewer }));
    // role=manager but revoked_at set → NOT a recipient
    expect(ids.has(s.managerRevoked)).toBe(false);
    // assigned to P then unassigned_at set → NOT a recipient
    expect(ids.has(s.agentPstale)).toBe(false);
    // sanity: the live manager + live assignee ARE present (so the exclusions
    // above aren't trivially passing on an empty set)
    expect(ids.has(s.manager2)).toBe(true);
    expect(ids.has(s.agentP)).toBe(true);
  });

  it('A8) HARDENING — non-member relevantUserId is DROPPED (recipient∈org guard)', async () => {
    // A freshly-created user with NO membership in s.orgId. Passing it as a
    // relevantUserId must NOT make it a recipient: the helper intersects
    // ctx.relevantUserIds with ACTIVE org membership (memberIds.has(id)).
    //
    // REGRESSION GUARD: without that `memberIds.has(id)` filter the id would be
    // added unconditionally (Rule 2 used to do `recipients.add(id)` for every
    // relevant id), so this assertion would FAIL — i.e. it is NOT a tautology,
    // it genuinely pins the hardening.
    const nonMember = await mkUser('a8-nonmember');
    a8NonMember = nonMember; // tracked for afterAll cleanup

    // No projectId, actor is a real member, so the ONLY way `nonMember` could
    // appear is via the relevantUserIds union — which the hardening must block.
    const ids = new Set(
      await resolve(s.orgId, { relevantUserIds: [nonMember], actorUserId: s.manager1 }),
    );
    expect(ids.has(nonMember)).toBe(false); // dropped: not an active member of orgId
    // sanity: resolution actually ran (managers resolved) so the absence above
    // isn't a vacuously-empty result.
    expect(ids.has(s.manager2)).toBe(true);

    // Cross-org variant: another org's manager passed as a relevantUserId here
    // is ALSO dropped (it's a foreign-org id, not a member of s.orgId).
    const other = await seedOrg('NotifRecipA8OTHER');
    try {
      const ids2 = new Set(
        await resolve(s.orgId, {
          relevantUserIds: [other.manager1, s.agentUnassigned],
          actorUserId: s.manager1,
        }),
      );
      expect(ids2.has(other.manager1)).toBe(false); // foreign-org id dropped
      expect(ids2.has(s.agentUnassigned)).toBe(true); // legitimate member kept
    } finally {
      await cleanupOrgRows(other.orgId);
    }
  }, 60_000);

  it('A9) HARDENING — a legitimate ACTIVE member in relevantUserIds is KEPT (no over-drop)', async () => {
    // agentUnassigned + viewer are ACTIVE members of s.orgId who are NOT
    // otherwise recipients (no projectId → no assignee fan-out; viewer/agent
    // aren't managers). Passed via relevantUserIds they MUST be included — the
    // intersection must not over-drop real members.
    const ids = new Set(
      await resolve(s.orgId, {
        relevantUserIds: [s.agentUnassigned, s.viewer],
        actorUserId: s.manager1,
      }),
    );
    expect(ids.has(s.agentUnassigned)).toBe(true);
    expect(ids.has(s.viewer)).toBe(true);
  });

  it('A10) HARDENING — a REVOKED member in relevantUserIds is DROPPED (intersection is ACTIVE)', async () => {
    // managerRevoked has a membership row but revoked_at is set → it is NOT in
    // the ACTIVE-membership set, so passing it via relevantUserIds drops it.
    // (It is already excluded from the manager set by A6; here we prove the
    // relevantUserIds path also respects revoked_at, not just role.)
    const ids = new Set(
      await resolve(s.orgId, {
        relevantUserIds: [s.managerRevoked, s.agentUnassigned],
        actorUserId: s.manager1,
      }),
    );
    expect(ids.has(s.managerRevoked)).toBe(false); // revoked → not active → dropped
    expect(ids.has(s.agentUnassigned)).toBe(true); // active member → kept (contrast)
  });

  it('A7) cross-org isolation: a DIFFERENT org’s manager is never included', async () => {
    const other = await seedOrg('NotifRecipOTHER');
    try {
      // Resolve for s.orgId; the other org's managers must be invisible
      // (the tx is RLS-pinned to s.orgId, so its reads can't reach other.orgId).
      const ids = new Set(await resolve(s.orgId, { projectId: s.projectP, actorUserId: s.agentP }));
      expect(ids.has(other.manager1)).toBe(false);
      expect(ids.has(other.manager2)).toBe(false);
      expect(ids.has(other.agentQ)).toBe(false);
      // and our own managers are still there (resolution actually ran):
      expect(ids.has(s.manager1)).toBe(true);

      // Symmetric: resolving for OTHER org never returns s.orgId managers,
      // even when s.projectP is passed as projectId (cross-org project id).
      const idsOther = new Set(
        await resolve(other.orgId, { projectId: s.projectP, actorUserId: other.agentP }),
      );
      expect(idsOther.has(s.manager1)).toBe(false);
      expect(idsOther.has(s.manager2)).toBe(false);
      // cross-org project id yields NO assignees (project_assignments is RLS-
      // scoped to other.orgId → s.projectP is invisible there):
      expect(idsOther.has(s.agentP)).toBe(false);
      expect(idsOther.has(other.manager1)).toBe(true);
    } finally {
      await cleanupOrgRows(other.orgId);
    }
  }, 60_000);
});

// ───────────────────────────────────────────────────────────────────────────
// B — document_uploaded retrofit end-to-end (managers + assigned agents,
//     uploader excluded), through the real DocumentsService.create path.
// ───────────────────────────────────────────────────────────────────────────
async function notifsFor(
  userId: string,
  orgId: string,
): Promise<Array<{ type: string; body: string | null; metadata: Record<string, unknown> }>> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{
      type: string;
      body: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT type, body, metadata FROM notifications
       WHERE user_id = $1 AND org_id = $2 ORDER BY created_at DESC`,
      [userId, orgId],
    );
    return r.rows;
  } finally {
    c.release();
  }
}

function payload(sub: string, orgId: string, role: 'manager' | 'agent'): AccessTokenPayload {
  return { sub, orgId, role, sid: SID, type: 'access' } as unknown as AccessTokenPayload;
}

describe('B — document_uploaded retrofit (managers + assigned agents − uploader)', () => {
  it('B1) manager uploads doc to project P → OTHER manager + assigned agentP notified; uploader, revoked mgr, stale agent, wrong-project agent, viewer NOT', async () => {
    const svc = new DocumentsService(storage, new NotificationsProducerService());
    const name = `b1-${randomUUID().slice(0, 8)}.pdf`;

    const res = await svc.create(payload(s.manager1, s.orgId, 'manager'), {
      name,
      type: 'other',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      contentHash: 'h' + randomUUID().slice(0, 8),
      projectId: s.projectP,
    });
    const docId = res.document.id;
    expect(docId).toBeTruthy();

    // OTHER manager (manager2) — receives it.
    const m2 = (await notifsFor(s.manager2, s.orgId)).filter((n) => n.body?.includes(name));
    expect(m2).toHaveLength(1);
    expect(m2[0]!.type).toBe('document_uploaded');
    expect(m2[0]!.metadata.documentId).toBe(docId);

    // assigned agentP — receives it.
    const ap = (await notifsFor(s.agentP, s.orgId)).filter((n) => n.body?.includes(name));
    expect(ap).toHaveLength(1);
    expect(ap[0]!.metadata.documentId).toBe(docId);

    // uploader (manager1, the actor) — NONE.
    expect((await notifsFor(s.manager1, s.orgId)).some((n) => n.body?.includes(name))).toBe(false);
    // revoked manager — NONE.
    expect((await notifsFor(s.managerRevoked, s.orgId)).some((n) => n.body?.includes(name))).toBe(
      false,
    );
    // stale (unassigned) agent — NONE.
    expect((await notifsFor(s.agentPstale, s.orgId)).some((n) => n.body?.includes(name))).toBe(
      false,
    );
    // wrong-project agent (Q) — NONE.
    expect((await notifsFor(s.agentQ, s.orgId)).some((n) => n.body?.includes(name))).toBe(false);
    // viewer — NONE.
    expect((await notifsFor(s.viewer, s.orgId)).some((n) => n.body?.includes(name))).toBe(false);
  }, 30_000);

  it('B2) best-effort: a THROWING producer never fails the upload (notify is swallowed)', async () => {
    const throwing = {
      emit: async () => false,
      emitMany: async () => {
        throw new Error('boom: simulated notification outage');
      },
    } as unknown as NotificationsProducerService;
    const svcBad = new DocumentsService(storage, throwing);

    const name = `b2-${randomUUID().slice(0, 8)}.pdf`;
    const res = await svcBad.create(payload(s.manager1, s.orgId, 'manager'), {
      name,
      type: 'other',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      contentHash: 'h' + randomUUID().slice(0, 8),
      projectId: s.projectP, // has recipients → emitMany IS invoked
    });
    // The upload (business action) SUCCEEDED despite the throwing producer.
    expect(res.document.id).toBeTruthy();
    expect(res.document.name).toBe(name);

    // The committed doc row exists.
    const c = await providerPool.connect();
    try {
      const r = await c.query(`SELECT id FROM documents WHERE org_id = $1 AND name = $2`, [
        s.orgId,
        name,
      ]);
      expect(r.rowCount).toBe(1);
    } finally {
      c.release();
    }
  }, 30_000);
});
