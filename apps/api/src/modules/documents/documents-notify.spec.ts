/**
 * #6 — document_uploaded notification fan-out (real-DB, deterministic).
 *
 * DocumentsService.create(user, input) emits, best-effort AFTER commit, a
 * `document_uploaded` notification whose recipients are resolved through the ONE
 * central helper `resolveNotificationRecipients` (D-O7 default). The recipient
 * set is:
 *
 *   recipients = (ALL active org MANAGERS)              ← managers ALWAYS notified
 *              ∪ (active project-assigned AGENTS)        ← only when a project resolves
 *              − the UPLOADER (user.sub, the actor)      ← self-exclusion (managers too)
 *
 * Project is resolved from input.projectId OR (apartment-level doc) via
 * apartment → building.projectId. Agents come from project_assignments WHERE
 * unassigned_at IS NULL. Uses NotificationsProducerService.emitMany(ids, base).
 *
 * RETROFIT (PR #296): previously this notified assigned agents ONLY (managers
 * excluded). Under D-O7 a manager receives EVERY notification, so a manager is
 * now a recipient of document_uploaded UNLESS the manager is the uploader
 * (actor-excluded). The seed has exactly ONE manager (createTestOrg seeds a
 * single manager), so when THAT manager uploads, managers-always − actor leaves
 * no other manager → the manager still gets nothing in manager-upload cases.
 * When an AGENT uploads, the manager is NOT the actor → the manager IS notified.
 *
 * Correctness points under test (adversarial):
 *  - SELF-EXCLUSION: the UPLOADER (agent OR manager) gets NOTHING for their own
 *    upload — managers are NOT exempt from the actor-exclusion.
 *  - MANAGERS-ALWAYS (D-O7): a manager who is NOT the uploader IS notified
 *    (verified in N6-2, where an agent uploads).
 *  - ONLY assigned agents of the RIGHT project are notified (no cross-project
 *    / unassigned leakage; unassigned_at IS NOT NULL is excluded).
 *  - apartment→building→project resolution targets the correct project's team.
 *  - Org-level / empty-project doc uploaded BY THE MANAGER → that manager is the
 *    actor → 0 notifications (the only manager is excluded), upload SUCCEEDS.
 *  - Best-effort isolation: the document row + response exist regardless.
 *  - Body carries the doc NAME only (no PII).
 *
 * Ground truth: the `notifications` table is read via providerPool (BYPASSRLS).
 */
import { randomUUID } from 'node:crypto';

import {
  apartments,
  buildings,
  db,
  memberships,
  projectAssignments,
  projects,
  users,
  withTenant,
  type IStorageProvider,
} from '@emapp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';

import { DocumentsService } from './documents.service';

let svc: DocumentsService;
let org: TestOrg;
let managerId: string;
/** projects[0] — has agentA + agentB assigned (active). */
let projectTeam: string;
/** projects[1] — separate project, has agentC assigned (the "wrong" project). */
let projectOther: string;

let agentA: string;
let agentB: string;
let agentC: string; // assigned to projectOther only — must NEVER be notified for projectTeam
let agentStale: string; // assigned to projectTeam but unassigned_at set — must be excluded

const SID = '00000000-0000-4000-8000-0000000000f0';

const storage = {
  getUploadUrl: async () => 'https://x/upload',
  getDownloadUrl: async () => ({ url: 'https://x/dl', filename: 'f.pdf' }),
  head: async () => null,
  delete: async () => undefined,
} as unknown as IStorageProvider;

function payload(sub: string, role: 'manager' | 'agent'): AccessTokenPayload {
  return { sub, orgId: org.id, role, sid: SID, type: 'access' } as unknown as AccessTokenPayload;
}

const doc = (name = 'doc.pdf') => ({
  name,
  type: 'other' as const,
  mimeType: 'application/pdf' as const,
  sizeBytes: 100,
  contentHash: 'h' + randomUUID().slice(0, 8),
});

async function seedAgent(orgId: string, withCap = true): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `agent-${randomUUID()}@test.local`, name: 'Agent', passwordHash: '$2b$12$x' })
    .returning({ id: users.id });
  await db.insert(memberships).values({
    userId: u!.id,
    orgId,
    role: 'agent',
    acceptedAt: new Date(),
    // manage_documents needed so an agent can create a doc (not for receiving).
    // Full 7-key AgentCapabilities object (the jsonb column is typed, not partial).
    capabilities: {
      edit_project_data: false,
      manage_documents: withCap,
      manage_signatures: false,
      manage_tasks: false,
      run_imports: false,
      view_owners: true,
      view_owner_pii: false,
    },
  });
  return u!.id;
}

async function assign(
  projectId: string,
  userId: string,
  opts: { unassigned?: boolean } = {},
): Promise<void> {
  await db.insert(projectAssignments).values({
    projectId,
    userId,
    assignedBy: managerId,
    ...(opts.unassigned ? { unassignedAt: new Date() } : {}),
  });
}

/** All notification rows for a recipient, newest first. */
async function notifsFor(
  userId: string,
): Promise<
  Array<{ type: string; title: string; body: string | null; metadata: Record<string, unknown> }>
> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{
      type: string;
      title: string;
      body: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT type, title, body, metadata FROM notifications
       WHERE user_id = $1 AND org_id = $2 ORDER BY created_at DESC`,
      [userId, org.id],
    );
    return r.rows;
  } finally {
    c.release();
  }
}

async function docExists(id: string): Promise<boolean> {
  const c = await providerPool.connect();
  try {
    const r = await c.query(`SELECT 1 FROM documents WHERE id = $1`, [id]);
    return r.rowCount === 1;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new DocumentsService(storage, new NotificationsProducerService());
  const tag = `notif6-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  projectTeam = org.projects[0]!.id;
  projectOther = org.projects[1]!.id;

  agentA = await seedAgent(org.id);
  agentB = await seedAgent(org.id);
  agentC = await seedAgent(org.id);
  agentStale = await seedAgent(org.id);

  // projectTeam team: A + B active; agentStale assigned-then-unassigned.
  await assign(projectTeam, agentA);
  await assign(projectTeam, agentB);
  await assign(projectTeam, agentStale, { unassigned: true });
  // projectOther: C only (wrong-project decoy).
  await assign(projectOther, agentC);
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('#6 — document_uploaded notification fan-out', () => {
  it('N6-1) manager uploads project-level doc → BOTH assigned agents notified; the (sole) manager-uploader is excluded as ACTOR + stale + wrong-project agent NOT', async () => {
    const name = `mgr-${randomUUID().slice(0, 8)}.pdf`;
    const res = await svc.create(payload(managerId, 'manager'), {
      ...doc(name),
      projectId: projectTeam,
    });
    const docId = res.document.id;
    expect(docId).toBeTruthy();
    expect(res.uploadUrl).toBeTruthy();

    const a = await notifsFor(agentA);
    const b = await notifsFor(agentB);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);

    // type / title / body / metadata correctness.
    for (const n of [a[0]!, b[0]!]) {
      expect(n.type).toBe('document_uploaded');
      expect(n.title).toBe('מסמך חדש בפרויקט');
      expect(n.body).toContain(name); // body carries the doc NAME
      expect(n.metadata.documentId).toBe(docId);
    }

    // uploader is the ONLY manager → managers-always − actor leaves no other
    // manager, so the uploader gets nothing (excluded as the ACTOR, D-O7).
    expect(await notifsFor(managerId)).toHaveLength(0);
    // stale (unassigned_at set) — excluded.
    expect(await notifsFor(agentStale)).toHaveLength(0);
    // wrong project's agent — excluded.
    expect(await notifsFor(agentC)).toHaveLength(0);
  }, 30_000);

  it('N6-2) SELF-EXCLUSION + MANAGERS-ALWAYS: an assigned agent uploads → OTHER assigned agent AND the manager notified; the UPLOADER does NOT', async () => {
    const name = `agentA-${randomUUID().slice(0, 8)}.pdf`;
    const before = (await notifsFor(agentA)).length; // uploader's existing count

    const res = await svc.create(payload(agentA, 'agent'), {
      ...doc(name),
      projectId: projectTeam,
    });
    expect(res.document.id).toBeTruthy();

    // agentA is the uploader (actor) → must NOT receive a new row. Self-
    // exclusion holds for agents exactly as for managers.
    const afterA = await notifsFor(agentA);
    expect(afterA).toHaveLength(before);
    expect(afterA.some((n) => n.body?.includes(name))).toBe(false);

    // agentB (the OTHER assigned agent) → gets exactly this new one.
    const b = await notifsFor(agentB);
    const hitB = b.filter((n) => n.body?.includes(name));
    expect(hitB).toHaveLength(1);
    expect(hitB[0]!.metadata.documentId).toBe(res.document.id);

    // D-O7 managers-always: the manager is NOT the uploader here, so the
    // RETROFIT (PR #296) now notifies the manager too — exactly ONE new row.
    const mgr = await notifsFor(managerId);
    const hitMgr = mgr.filter((n) => n.body?.includes(name));
    expect(hitMgr).toHaveLength(1);
    expect(hitMgr[0]!.type).toBe('document_uploaded');
    expect(hitMgr[0]!.metadata.documentId).toBe(res.document.id);

    // agentC (wrong project) still untouched by this upload.
    expect((await notifsFor(agentC)).some((n) => n.body?.includes(name))).toBe(false);
  }, 30_000);

  it('N6-3) apartment-level doc (no projectId) → agents of apartment→building→PROJECT are notified', async () => {
    // Build a fresh project with its own assigned team, then an apartment under it.
    const name = `apt-${randomUUID().slice(0, 8)}.pdf`;
    const { apartmentId, aptProjectId, aptAgent } = await withTenant(
      org.id,
      async (tx) => {
        // reuse projectOther (agentC assigned) as the apartment's project so we
        // verify resolution targets THAT project's team, not projectTeam's.
        const [bld] = await tx
          .insert(buildings)
          .values({ projectId: projectOther, address: 'Herzl 1', city: 'TLV' })
          .returning({ id: buildings.id });
        const [apt] = await tx
          .insert(apartments)
          .values({ buildingId: bld!.id, number: `${Math.floor(Math.random() * 100000)}` })
          .returning({ id: apartments.id });
        return { apartmentId: apt!.id, aptProjectId: projectOther, aptAgent: agentC };
      },
      { userId: managerId },
    );
    expect(aptProjectId).toBe(projectOther);

    const res = await svc.create(payload(managerId, 'manager'), { ...doc(name), apartmentId });
    expect(res.document.id).toBeTruthy();

    // agentC (assigned to the apartment's project) → notified.
    const c = await notifsFor(aptAgent);
    const hit = c.filter((n) => n.body?.includes(name));
    expect(hit).toHaveLength(1);
    expect(hit[0]!.type).toBe('document_uploaded');
    expect(hit[0]!.metadata.documentId).toBe(res.document.id);

    // projectTeam's agents (A/B) are on a DIFFERENT project → not notified.
    expect((await notifsFor(agentA)).some((n) => n.body?.includes(name))).toBe(false);
    expect((await notifsFor(agentB)).some((n) => n.body?.includes(name))).toBe(false);
  }, 30_000);

  it('N6-4) project with NO assigned agents, uploaded by the sole manager → zero notifications (managers-always set = {manager} − actor = ∅), upload still succeeds', async () => {
    // Fresh project (no assignments) under the same org. Recipient set under
    // D-O7 = (all managers) ∪ (assigned agents = none) − actor. The actor IS
    // the only manager, so the set is empty → zero notifications.
    const name = `empty-${randomUUID().slice(0, 8)}.pdf`;
    const { emptyProjectId } = await withTenant(
      org.id,
      async (tx) => {
        const [p] = await tx
          .insert(projects)
          .values({
            orgId: org.id,
            name: `empty-${randomUUID()}`,
            type: 'tama38_1',
            createdBy: managerId,
          })
          .returning({ id: projects.id });
        return { emptyProjectId: p!.id };
      },
      { userId: managerId },
    );

    const res = await svc.create(payload(managerId, 'manager'), {
      ...doc(name),
      projectId: emptyProjectId,
    });
    expect(res.document.id).toBeTruthy();
    expect(res.uploadUrl).toBeTruthy();
    expect(await docExists(res.document.id)).toBe(true);

    // No one anywhere got a row mentioning this name.
    for (const u of [managerId, agentA, agentB, agentC, agentStale]) {
      // eslint-disable-next-line no-await-in-loop
      expect((await notifsFor(u)).some((n) => n.body?.includes(name))).toBe(false);
    }
  }, 30_000);

  it('N6-5) org-level doc (no projectId, no apartmentId), uploaded by the sole manager → zero notifications, upload succeeds', async () => {
    // D-O7 managers-always applies even with NO project (Rule 3 is unconditional;
    // only the AGENT fan-out, Rule 1, needs a project). So an org-level doc DOES
    // notify managers — but here the ONLY manager is the UPLOADER (actor), so the
    // resolved set is {manager} − actor = ∅ → zero notifications. (A second,
    // non-uploading manager WOULD be notified; the seed has only one.)
    const name = `orglevel-${randomUUID().slice(0, 8)}.pdf`;
    const res = await svc.create(payload(managerId, 'manager'), { ...doc(name) });
    expect(res.document.id).toBeTruthy();
    expect(await docExists(res.document.id)).toBe(true);

    for (const u of [managerId, agentA, agentB, agentC, agentStale]) {
      // eslint-disable-next-line no-await-in-loop
      expect((await notifsFor(u)).some((n) => n.body?.includes(name))).toBe(false);
    }
  }, 30_000);

  it('N6-6a) best-effort isolation (REAL path): per-recipient emit failures never fail the upload', async () => {
    // The PRODUCTION failure mode: emitMany self-guards each recipient's emit
    // (catches + logs, returns a count) and never throws. Simulate that by
    // injecting a producer whose emitMany resolves (delivered=0) even though
    // "delivery" failed. The upload is the business action → it MUST succeed.
    const swallowingProducer = {
      emit: async () => false,
      emitMany: async () => 0, // every recipient "failed", but no throw (real behavior)
    } as unknown as NotificationsProducerService;
    const svcSwallow = new DocumentsService(storage, swallowingProducer);

    const name = `iso-ok-${randomUUID().slice(0, 8)}.pdf`;
    const res = await svcSwallow.create(payload(managerId, 'manager'), {
      ...doc(name),
      projectId: projectTeam, // has recipients → emitMany IS called
    });
    expect(res.document.id).toBeTruthy();
    expect(res.uploadUrl).toBeTruthy();
    expect(await docExists(res.document.id)).toBe(true);
  }, 30_000);

  it('N6-6b) a THROWING emitMany at the caller is GUARDED → upload still succeeds (no 500)', async () => {
    // The call site now wraps emitMany in try/catch (defense-in-depth BEYOND the
    // producer's own per-recipient self-guard), so the "a notification never
    // fails the upload" contract holds even if a future producer rejects
    // synchronously. A throwing producer must NOT propagate to the caller.
    const throwingProducer = {
      emit: async () => false,
      emitMany: async () => {
        throw new Error('boom: simulated notification outage');
      },
    } as unknown as NotificationsProducerService;
    const svcBad = new DocumentsService(storage, throwingProducer);

    const name = `iso-throw-${randomUUID().slice(0, 8)}.pdf`;
    // create RESOLVES despite the throwing producer — the notify is swallowed.
    const res = await svcBad.create(payload(managerId, 'manager'), {
      ...doc(name),
      projectId: projectTeam,
    });
    expect(res.document.id).toBeTruthy();
    expect(res.document.name).toBe(name);

    // The committed doc exists — correct now, because the upload SUCCEEDED.
    const c = await providerPool.connect();
    try {
      const r = await c.query<{ id: string }>(
        `SELECT id FROM documents WHERE org_id = $1 AND name = $2`,
        [org.id, name],
      );
      expect(r.rowCount).toBe(1);
    } finally {
      c.release();
    }
  }, 30_000);

  it('N6-7) PII: notification body is ONLY the doc name (no national_id/phone leakage)', async () => {
    const name = `pii-${randomUUID().slice(0, 8)}.pdf`;
    const res = await svc.create(payload(managerId, 'manager'), {
      ...doc(name),
      projectId: projectTeam,
    });
    const a = (await notifsFor(agentA)).filter((n) => n.body?.includes(name));
    expect(a).toHaveLength(1);
    const body = a[0]!.body ?? '';
    // body is exactly the templated name sentence — nothing resembling PII.
    expect(body).toContain(name);
    expect(body).not.toMatch(/\d{9}/); // no 9-digit national_id
    expect(body).not.toMatch(/05\d-?\d{7}/); // no IL mobile
    expect(body).not.toContain(managerId); // no raw user ids
    expect(res.document.id).toBeTruthy();
  }, 30_000);
});
