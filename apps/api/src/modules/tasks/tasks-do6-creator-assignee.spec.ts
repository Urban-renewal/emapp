/**
 * P4 #12 / D-O6 PROOF — auto-assign the task creator. Deterministic real-DB.
 * Decision: docs/decision-records/P4-do6-task-creator-assignee.md.
 *
 * Task READ visibility for agents is ASSIGNEE-based (TasksService.list/loadVisible
 * JOIN task_assignees on user.sub). Before D-O6 a creator was NOT auto-added as an
 * assignee, so a task an agent had just created VANISHED from their own assignee-
 * scoped list. D-O6 fixes this by adding `user.sub` to the assignee Set on create
 * (`[...new Set([user.sub, ...(input.assigneeIds ?? [])])]`). These tests prove,
 * end to end against the real DB:
 *
 *   1. THE VANISH IS FIXED — creator with NO explicit assigneeIds → creator's own
 *      assignee-scoped list now INCLUDES the new task (was empty = the bug).
 *   2. DEDUP — creator ALSO listed in assigneeIds → exactly ONE task_assignees row
 *      for the creator (queried directly), no duplicate.
 *   3. EXPLICIT ASSIGNEES STILL WORK — create with assigneeIds:[Y] → BOTH the
 *      creator (X) AND Y are assignees; Y's list behaviour unchanged.
 *   4. OTHER USERS UNAFFECTED — a member Z (neither creator nor assignee) does NOT
 *      see the task in their assignee-scoped list.
 *
 * Read path under test is the agent branch of TasksService.list (role === 'agent'
 * → INNER JOIN task_assignees on user.sub); that is the exact list an agent's
 * client renders. Creating agents need manage_tasks + an active project assignment
 * (D.46); Z is a plain agent member (a read-only consumer of its own list).
 */
import { randomUUID } from 'node:crypto';

import { db, memberships, projectAssignments, users } from '@emapp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { TasksService } from './tasks.service';

let svc: TasksService;
let org: TestOrg;
let managerId: string;
let projectId: string;
// X, Y = creating agents (manage_tasks + assigned project). Z = plain agent
// member who is neither creator nor assignee of the tasks under test.
let xId: string;
let yId: string;
let zId: string;

const calendarStub = {} as never;
// create() fires a best-effort in-app task_assigned notification per assignee;
// stub emit so the proof (which asserts assignee STATE, not notifications) runs.
const notificationsStub = { emit: async (): Promise<boolean> => true } as never;

function agentPayload(sub: string): AccessTokenPayload {
  return {
    sub,
    orgId: org.id,
    role: 'agent',
    sid: '00000000-0000-4000-8000-0000000000d6',
    type: 'access',
  } as unknown as AccessTokenPayload;
}

/** Seed an org member with role 'agent'. */
async function seedAgent(orgId: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `do6-agent-${randomUUID()}@test.local`,
      name: 'Agent',
      passwordHash: '$2b$12$x',
    })
    .returning({ id: users.id });
  await db
    .insert(memberships)
    .values({ userId: u!.id, orgId, role: 'agent', acceptedAt: new Date() });
  return u!.id;
}

/** Grant manage_tasks to an agent membership (so they may CREATE tasks, D.46). */
async function grantManageTasks(userId: string): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE memberships SET capabilities = jsonb_set(capabilities, '{manage_tasks}', 'true'::jsonb)
       WHERE user_id = $1 AND org_id = $2 AND revoked_at IS NULL`,
      [userId, org.id],
    );
  } finally {
    c.release();
  }
}

/** Direct count of task_assignees rows for (taskId, userId) — BYPASSRLS pool. */
async function assigneeRowCount(taskId: string, userId: string): Promise<number> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM task_assignees WHERE task_id = $1 AND user_id = $2`,
      [taskId, userId],
    );
    return Number(r.rows[0]!.n);
  } finally {
    c.release();
  }
}

/** The exact read path an agent's client renders: their assignee-scoped task list. */
async function listTaskIdsFor(userId: string): Promise<string[]> {
  const page = await svc.list(agentPayload(userId), { limit: 100 });
  return page.data.map((t) => t.id);
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new TasksService(calendarStub, notificationsStub);
  const tag = `do6-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  projectId = org.projects[0]!.id;
  xId = await seedAgent(org.id);
  yId = await seedAgent(org.id);
  zId = await seedAgent(org.id);
  // X and Y create tasks → need manage_tasks + an active assignment on the project.
  await grantManageTasks(xId);
  await grantManageTasks(yId);
  await db.insert(projectAssignments).values([
    { projectId, userId: xId, assignedBy: managerId },
    { projectId, userId: yId, assignedBy: managerId },
  ]);
  // Z is intentionally NOT assigned to the project — a plain agent member who
  // only ever reads its own assignee-scoped list (proof item 4).
}, 90_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('D-O6 — task creator is auto-assigned (the vanish fix)', () => {
  it('1) create with NO assigneeIds → creator now SEES the task in their own assignee-scoped list', async () => {
    const before = await listTaskIdsFor(xId);
    const t = await svc.create(agentPayload(xId), { title: 'made-it-mine', projectId });
    // Without D-O6 this list would NOT contain t.id (the vanish bug): the agent
    // read path is assignee-based and the creator was never added as an assignee.
    expect(before).not.toContain(t.id); // sanity: it didn't pre-exist
    const after = await listTaskIdsFor(xId);
    expect(after, 'creator must see the task they just created (D-O6 fix)').toContain(t.id);
    // And there is a real assignee row backing that visibility.
    expect(await assigneeRowCount(t.id, xId)).toBe(1);
  }, 30_000);

  it('2) DEDUP: creator ALSO listed in assigneeIds → exactly ONE task_assignees row for the creator', async () => {
    const t = await svc.create(agentPayload(xId), {
      title: 'creator-listed-twice',
      projectId,
      assigneeIds: [xId], // creator explicitly listed too — the Set must de-dup
    });
    // Direct row count is the unambiguous proof: not 2, exactly 1.
    expect(await assigneeRowCount(t.id, xId)).toBe(1);
    // listAssignees (the assignee-list endpoint) likewise shows X once.
    const assignees = await svc.listAssignees(agentPayload(xId), t.id);
    expect(assignees.filter((a) => a.userId === xId)).toHaveLength(1);
  }, 30_000);

  it('3) EXPLICIT assignees still work: create as X with assigneeIds:[Y] → BOTH X (creator) and Y are assignees', async () => {
    const yBefore = await listTaskIdsFor(yId);
    const t = await svc.create(agentPayload(xId), {
      title: 'assigned-to-Y',
      projectId,
      assigneeIds: [yId],
    });
    // Creator X is auto-assigned …
    expect(await assigneeRowCount(t.id, xId)).toBe(1);
    expect(await listTaskIdsFor(xId)).toContain(t.id);
    // … AND the explicitly-named Y is assigned, exactly once — Y's behaviour
    // (sees a task explicitly assigned to them) is unchanged by D-O6.
    expect(await assigneeRowCount(t.id, yId)).toBe(1);
    expect(yBefore).not.toContain(t.id);
    expect(await listTaskIdsFor(yId)).toContain(t.id);
    // listAssignees carries both, each once.
    const assignees = await svc.listAssignees(agentPayload(xId), t.id);
    const userIds = assignees.map((a) => a.userId).sort();
    expect(userIds).toEqual([xId, yId].sort());
  }, 30_000);

  it('4) OTHER USERS unaffected: a member Z who is neither creator nor assignee does NOT see the task', async () => {
    const t = await svc.create(agentPayload(xId), { title: 'not-for-Z', projectId });
    // No assignee row for Z, and the task is absent from Z's assignee-scoped list.
    expect(await assigneeRowCount(t.id, zId)).toBe(0);
    expect(
      await listTaskIdsFor(zId),
      'Z must NOT see a task they neither made nor were assigned',
    ).not.toContain(t.id);
  }, 30_000);
});
