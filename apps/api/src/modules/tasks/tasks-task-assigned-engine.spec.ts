/**
 * P5 slice 2 PROOF — `task_assigned` retrofitted onto the central notifications
 * engine (D-O7). Deterministic real-DB. Written by the TEST-AUTHOR agent,
 * INDEPENDENT of the builder.
 * Decision: docs/decision-records/P5-task-assigned-recipients.md.
 *
 * BOTH `task_assigned` emit sites in `tasks.service.ts` now route through
 * `resolveNotificationRecipients(tx, orgId, { relevantUserIds, actorUserId })`
 * (NO projectId) + `NotificationsProducerService.emitMany`. The D-O7 default:
 *
 *   recipients = task ASSIGNEES ∪ ALL active org managers − the ACTOR  …deduped.
 *
 *   • create   — actor = the CREATOR; relevant = the task's assignee set (which
 *                D-O6 also auto-adds the creator to). The creator is thus the
 *                actor and is EXCLUDED — closing the D-O6 actor-exclusion: a
 *                creator no longer self-notifies "a task was assigned to you".
 *   • addAssignee — actor = the ASSIGNER; relevant = the newly-assigned user.
 *
 * NO projectId is passed at either site: task_assigned is an entity/action event
 * — it must NOT fan out to ALL project-assigned agents (only assignees ∪ always-
 * on managers − actor).
 *
 * GROUND TRUTH is the produced `notifications` rows of type 'task_assigned',
 * read back via providerPool (BYPASSRLS) — the same end-to-end posture the
 * document_uploaded retrofit proof (notification-recipients.spec.ts §B) uses.
 * A bespoke org is seeded so the active-manager set is known EXACTLY (the shared
 * factory seeds only one manager, which would make "managers-always − actor"
 * collapse to ∅ and every assertion vacuous).
 *
 * Seed (all bespoke, unique per run):
 *   creatorMgr  — manager. The creator/actor in the create tests.
 *   mgr2        — a SECOND active manager (the managers-always set is {creatorMgr,
 *                 mgr2}; with one manager the rule would be untestable).
 *   agent       — agent, assigned to the project AND made a task assignee. The
 *                 relevant "a task was assigned to you" recipient.
 *   projectAgent— agent, assigned to the PROJECT but never a TASK assignee. The
 *                 no-project-fan-out witness: must NEVER receive task_assigned.
 *   nonMember-ish: projectAgent doubles as the "not a task assignee" non-recipient.
 */
import { randomUUID } from 'node:crypto';

import { db, memberships, organizations, projectAssignments, projects, users } from '@emapp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import type { AccessTokenPayload } from '../auth/auth.service';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';

import { TasksService } from './tasks.service';

const RUN = randomUUID().slice(0, 8);
const SID = '00000000-0000-4000-8000-0000000000e7';
const calendarStub = {} as never;

let svc: TasksService;
let orgId: string;
let projectId: string;
let creatorMgr: string;
let mgr2: string;
let agentId: string;
let projectAgent: string;

function mgrPayload(sub: string): AccessTokenPayload {
  return { sub, orgId, role: 'manager', sid: SID, type: 'access' } as unknown as AccessTokenPayload;
}

async function mkUser(label: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `tae-${label}-${RUN}-${randomUUID().slice(0, 8)}@test.local`,
      name: label,
      passwordHash: '$2b$12$placeholder',
    })
    .returning({ id: users.id });
  return u!.id;
}

async function mkMember(userId: string, role: 'manager' | 'agent'): Promise<void> {
  await db.insert(memberships).values({ userId, orgId, role, acceptedAt: new Date() });
}

/**
 * Count the `task_assigned` notification rows a given user holds FOR a given
 * task (metadata.taskId match). BYPASSRLS pool → ground truth, GUC-independent.
 */
async function taskAssignedCount(userId: string, taskId: string): Promise<number> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM notifications
       WHERE user_id = $1 AND org_id = $2 AND type = 'task_assigned'
         AND metadata->>'taskId' = $3`,
      [userId, orgId, taskId],
    );
    return Number(r.rows[0]!.n);
  } finally {
    c.release();
  }
}

/** The single task_assigned row's body for a user+task (or null if none). */
async function taskAssignedBody(userId: string, taskId: string): Promise<string | null> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ body: string | null }>(
      `SELECT body FROM notifications
       WHERE user_id = $1 AND org_id = $2 AND type = 'task_assigned'
         AND metadata->>'taskId' = $3 LIMIT 1`,
      [userId, orgId, taskId],
    );
    return r.rows[0]?.body ?? null;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  // Real producer (not a stub): this proof asserts the COMMITTED notification
  // rows, so the producing emitMany→emit→withTenant(recipient) path must run.
  svc = new TasksService(calendarStub, new NotificationsProducerService());

  const [org] = await db
    .insert(organizations)
    .values({ name: `TaskAssignedEngine-${RUN}`, slug: `tae-${RUN}-${randomUUID().slice(0, 8)}` })
    .returning({ id: organizations.id });
  orgId = org!.id;

  creatorMgr = await mkUser('creatorMgr');
  mgr2 = await mkUser('mgr2');
  agentId = await mkUser('agent');
  projectAgent = await mkUser('projectAgent');

  await mkMember(creatorMgr, 'manager');
  await mkMember(mgr2, 'manager');
  await mkMember(agentId, 'agent');
  await mkMember(projectAgent, 'agent');

  const [p] = await db
    .insert(projects)
    .values({ orgId, name: `TAE-P-${RUN}`, type: 'tama38_1', createdBy: creatorMgr })
    .returning({ id: projects.id });
  projectId = p!.id;

  // Both agents are assigned to the PROJECT. Only `agentId` is ever made a TASK
  // assignee in the tests; `projectAgent` stays project-assigned-only — the
  // no-fan-out witness (task_assigned passes NO projectId, so a project-assigned
  // non-assignee must never receive it).
  await db.insert(projectAssignments).values([
    { projectId, userId: agentId, assignedBy: creatorMgr },
    { projectId, userId: projectAgent, assignedBy: creatorMgr },
  ]);
}, 120_000);

afterAll(async () => {
  // Purge the notifications we produced (org row + audit_log are immutable /
  // FK-anchored, left behind per the codebase norm; the org is unique per run).
  const c = await providerPool.connect();
  try {
    await c.query(`DELETE FROM notifications WHERE org_id = $1`, [orgId]);
  } finally {
    c.release();
  }
});

describe('P5 slice 2 — task_assigned via the central engine (D-O7)', () => {
  it('1) create — CREATOR excluded: agent + OTHER manager notified, creator does NOT self-notify', async () => {
    // creatorMgr creates with assigneeIds:[agent]. D-O6 also auto-assigns the
    // creator, so assignees = {creatorMgr, agent}; managers = {creatorMgr, mgr2};
    // actor = creatorMgr. Recipient SET = {agent, mgr2}.
    const t = await svc.create(mgrPayload(creatorMgr), {
      title: 'create-creator-excluded',
      projectId,
      assigneeIds: [agentId],
    });

    // The two legitimate recipients each get EXACTLY one task_assigned row.
    expect(await taskAssignedCount(agentId, t.id)).toBe(1);
    expect(await taskAssignedCount(mgr2, t.id)).toBe(1);
    // The CREATOR (actor) is EXCLUDED — the D-O6 self-notify closure. Asserted
    // against a non-empty result above, so this is not vacuously true.
    expect(await taskAssignedCount(creatorMgr, t.id)).toBe(0);
    // projectAgent (project-assigned, NOT a task assignee) — NO fan-out.
    expect(await taskAssignedCount(projectAgent, t.id)).toBe(0);
    // PII guard: body is the org-visible title only — no national_id / phone.
    const body = await taskAssignedBody(agentId, t.id);
    expect(body ?? '').toContain('create-creator-excluded');
    expect(body ?? '').not.toMatch(/\b\d{9}\b/);
    expect(body ?? '').not.toMatch(/05\d{8}/);
  }, 30_000);

  it('2) create — SOLO creator: creator does NOT self-notify; the OTHER manager DOES (managers-always)', async () => {
    // No explicit assignees → assignees = {creatorMgr} (D-O6 auto-add only).
    // Recipient SET = {creatorMgr} ∪ {creatorMgr, mgr2} − {creatorMgr} = {mgr2}.
    // This is the EXACT D-O6 actor-exclusion closure: a solo creator's own task
    // produces NO "assigned to you" for themselves.
    const t = await svc.create(mgrPayload(creatorMgr), {
      title: 'create-solo',
      projectId,
    });
    expect(await taskAssignedCount(creatorMgr, t.id)).toBe(0); // creator self-notify CLOSED
    expect(await taskAssignedCount(mgr2, t.id)).toBe(1); // managers-always still fires
    expect(await taskAssignedCount(projectAgent, t.id)).toBe(0); // no project fan-out
    expect(await taskAssignedCount(agentId, t.id)).toBe(0); // not an assignee of THIS task
  }, 30_000);

  it('3) addAssignee — ASSIGNER excluded: assignee + OTHER managers notified; the assigning manager is dropped', async () => {
    // Seed a bare task (creatorMgr creates it solo). Then mgr2 (a manager) is the
    // ASSIGNER who adds agentId. relevant = {agent}; managers = {creatorMgr, mgr2};
    // actor = mgr2. Recipient SET = {agent} ∪ {creatorMgr, mgr2} − {mgr2}
    //                              = {agent, creatorMgr}.
    const t = await svc.create(mgrPayload(creatorMgr), { title: 'addassignee-base', projectId });
    // Drain the create-time notification to mgr2 so the assertions below see ONLY
    // the addAssignee emission (create→solo would have notified mgr2; we re-read
    // counts SCOPED to this task, and assert the addAssignee delta explicitly).
    const mgr2Before = await taskAssignedCount(mgr2, t.id);
    const creatorBefore = await taskAssignedCount(creatorMgr, t.id);

    await svc.addAssignee(mgrPayload(mgr2), t.id, { userId: agentId });

    // The newly-assigned agent receives it.
    expect(await taskAssignedCount(agentId, t.id)).toBe(1);
    // The OTHER manager (creatorMgr) receives it (managers-always) — delta of +1
    // over the create-time baseline.
    expect(await taskAssignedCount(creatorMgr, t.id)).toBe(creatorBefore + 1);
    // The ASSIGNER (mgr2, a manager) is DROPPED as the actor — NO new row beyond
    // whatever the create step left (the create excluded the creator, not mgr2, so
    // mgr2 already had 1; the addAssignee must NOT add another).
    expect(await taskAssignedCount(mgr2, t.id)).toBe(mgr2Before);
    // projectAgent never assigned to the task → still nothing.
    expect(await taskAssignedCount(projectAgent, t.id)).toBe(0);
  }, 30_000);

  it('4) dedup + NO project fan-out: assignee-who-is-also-manager once; project-assigned non-assignee never', async () => {
    // mgr2 is BOTH a manager (managers-always) AND an explicit task assignee
    // (relevantUserIds). The engine dedups → mgr2 must get EXACTLY ONE row.
    // actor = creatorMgr. Recipient SET = {creatorMgr, mgr2} ∪ {creatorMgr, mgr2}
    //                                     − {creatorMgr} = {mgr2}.
    const t = await svc.create(mgrPayload(creatorMgr), {
      title: 'dedup-and-no-fanout',
      projectId,
      assigneeIds: [mgr2],
    });
    // DEDUP: mgr2 appears via BOTH the manager rule and the assignee rule, yet
    // there is exactly ONE task_assigned row (not two).
    expect(await taskAssignedCount(mgr2, t.id)).toBe(1);
    // Creator (actor) excluded.
    expect(await taskAssignedCount(creatorMgr, t.id)).toBe(0);
    // NO PROJECT FAN-OUT: projectAgent is an ACTIVE assignee of `projectId`, but
    // task_assigned passes NO projectId, so the engine never adds project
    // assignees — projectAgent receives NOTHING despite the task being on their
    // project. (If projectId were leaking into the resolve call this would be 1.)
    expect(await taskAssignedCount(projectAgent, t.id)).toBe(0);
    // agentId is neither an assignee of THIS task nor a manager → nothing.
    expect(await taskAssignedCount(agentId, t.id)).toBe(0);
  }, 30_000);
});
