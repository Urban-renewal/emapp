/**
 * D.46 — manage_tasks agent capability enforcement. Deterministic real-DB.
 *
 * manage_tasks grants FULL task management (create/update/archive + add/remove
 * assignee), PROJECT-scoped via the task's projectId (assertTaskVisibleForAgent).
 * D.54 close-out restores a NARROW path alongside it: a plain ASSIGNEE (no
 * manage_tasks) may still update status/notes/done on their own task — see the
 * second describe block. READ (list/get) stays assignee-based (out of scope).
 */
import { randomUUID } from 'node:crypto';

import { db, memberships, projectAssignments, users } from '@emapp/db';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { TasksService } from './tasks.service';

let svc: TasksService;
let org: TestOrg;
let managerId: string;
let agentId: string;
let assignedProjectId: string;
let unassignedProjectId: string;

const MGR_SID = '00000000-0000-4000-8000-0000000000c1';
const AGENT_SID = '00000000-0000-4000-8000-0000000000c2';
const calendarStub = {} as never;
// addAssignee fires a best-effort in-app notification; stub it so the
// capability tests (which assert authz, not notifications) don't crash.
const notificationsStub = { emit: async (): Promise<boolean> => true } as never;

function manager(): AccessTokenPayload {
  return {
    sub: managerId,
    orgId: org.id,
    role: 'manager',
    sid: MGR_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}
function agent(): AccessTokenPayload {
  return {
    sub: agentId,
    orgId: org.id,
    role: 'agent',
    sid: AGENT_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

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

async function setCap(on: boolean): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE memberships SET capabilities = jsonb_set(capabilities, '{manage_tasks}', $1::jsonb)
       WHERE user_id = $2 AND org_id = $3 AND revoked_at IS NULL`,
      [on ? 'true' : 'false', agentId, org.id],
    );
  } finally {
    c.release();
  }
}

/** Seed a task via the manager path (the real SUT, no capability needed). */
async function seedTask(projectId: string): Promise<string> {
  const t = await svc.create(manager(), { title: 'T', projectId });
  return t.id;
}

/** Make the test agent an assignee of the task (manager-driven, the real path). */
async function assignAgent(taskId: string): Promise<void> {
  await svc.addAssignee(manager(), taskId, { userId: agentId });
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new TasksService(calendarStub, notificationsStub);
  const tag = `d46-task-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  assignedProjectId = org.projects[0]!.id;
  unassignedProjectId = org.projects[1]!.id;
  agentId = await seedAgent(org.id);
  await db
    .insert(projectAssignments)
    .values({ projectId: assignedProjectId, userId: agentId, assignedBy: managerId });
}, 90_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('D.46 — manage_tasks agent enforcement', () => {
  it('TASK-1) create: assigned agent WITHOUT manage_tasks → 403', async () => {
    await setCap(false);
    await expect(
      svc.create(agent(), { title: 'T', projectId: assignedProjectId }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('TASK-2) manager toggle ON → agent create (assigned project) allowed', async () => {
    await setCap(true);
    const t = await svc.create(agent(), { title: 'T', projectId: assignedProjectId });
    expect(t.id).toBeTruthy();
  });

  it('TASK-3) create: agent with cap, ORG-LEVEL task (no project) → 404', async () => {
    await setCap(true);
    await expect(svc.create(agent(), { title: 'T' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('TASK-4) create: agent with cap, UNASSIGNED project → 404', async () => {
    await setCap(true);
    await expect(
      svc.create(agent(), { title: 'T', projectId: unassignedProjectId }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('TASK-5) update: agent w/o cap & NOT assignee → 404; with cap → FULL field update (title)', async () => {
    const id = await seedTask(assignedProjectId);
    await setCap(false);
    // D.54 close-out — w/o manage_tasks the agent falls to the narrow assignee
    // path; not being a task-assignee, the task is invisible to them → 404 (the
    // same no-oracle result as GET, which is assignee-based). (The capability-403
    // case for an assignee touching a non-narrow field is TASK-A4.)
    await expect(svc.update(agent(), id, { title: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    await setCap(true);
    // title is NOT in the narrow allow-list — full management via manage_tasks.
    const upd = await svc.update(agent(), id, { title: 'agent-edited' });
    expect(upd.title).toBe('agent-edited');
  }, 30_000);

  it('TASK-6) update: agent with cap, task in UNASSIGNED project → 404', async () => {
    await setCap(true);
    const id = await seedTask(unassignedProjectId);
    await expect(svc.update(agent(), id, { title: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('TASK-7) archive: agent with cap (assigned task) → allowed', async () => {
    await setCap(true);
    const id = await seedTask(assignedProjectId);
    await expect(svc.archive(agent(), id)).resolves.toBeUndefined();
  }, 30_000);

  it('TASK-8) addAssignee: agent w/o cap → 403; with cap → allowed', async () => {
    const id = await seedTask(assignedProjectId);
    await setCap(false);
    // D-O6: the manager who seeded the task is now its creator-assignee, so we
    // exercise the add-success path with a DIFFERENT user (agentId, not yet an
    // assignee of this task) — assigning managerId would now (correctly) 409
    // assignee_exists, which is a different code path than the 403/allow we test
    // here. The capability gate is what's under test; the chosen user is incidental.
    await expect(svc.addAssignee(agent(), id, { userId: agentId })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await setCap(true);
    const a = await svc.addAssignee(agent(), id, { userId: agentId });
    expect(a.id).toBeTruthy();
  }, 30_000);

  it('TASK-9) removeAssignee: agent with cap (assigned task) → allowed', async () => {
    await setCap(true);
    const id = await seedTask(assignedProjectId);
    // D-O6: managerId is already the creator-assignee of this seeded task, so add
    // a non-creator (agentId) for a clean add→remove round-trip (adding managerId
    // would 409). The capability-scoped removeAssignee is what's under test.
    await svc.addAssignee(agent(), id, { userId: agentId });
    await expect(svc.removeAssignee(agent(), id, agentId)).resolves.toBeUndefined();
  }, 30_000);

  it('TASK-10) manager creates/updates any task (capability no-op)', async () => {
    const id = await seedTask(unassignedProjectId);
    const upd = await svc.update(manager(), id, { title: 'mgr' });
    expect(upd.title).toBe('mgr');
  });

  it('TASK-11) update: agent CANNOT move a task into an UNASSIGNED project (destination scope) → 404', async () => {
    // Escalation guard: an agent controls a task in their assigned project but
    // must NOT be able to re-target it to a project they do not control.
    await setCap(true);
    const id = await seedTask(assignedProjectId);
    await expect(
      svc.update(agent(), id, { projectId: unassignedProjectId }),
    ).rejects.toBeInstanceOf(NotFoundException);
  }, 30_000);

  it('TASK-12) update: agent CANNOT demote a task to org-level (projectId=null) → 404', async () => {
    await setCap(true);
    const id = await seedTask(assignedProjectId);
    await expect(svc.update(agent(), id, { projectId: null })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  }, 30_000);

  it('TASK-13) manager CAN re-target a task to any project (no agent scope)', async () => {
    const id = await seedTask(assignedProjectId);
    const upd = await svc.update(manager(), id, { projectId: unassignedProjectId });
    expect(upd.projectId).toBe(unassignedProjectId);
  });
});

// D.54 close-out 2/3 — the NARROW assignee update path: an agent who is an
// ASSIGNEE of a task (but lacks manage_tasks) may update ONLY status/notes/done,
// without re-opening full management or letting #191's destination scope lapse.
describe('D.54 — narrow assignee task update (status/notes/done only)', () => {
  it('TASK-A1) assignee WITHOUT manage_tasks → may set status', async () => {
    await setCap(false);
    const id = await seedTask(assignedProjectId);
    await assignAgent(id);
    const upd = await svc.update(agent(), id, { status: 'in_progress' });
    expect(upd.status).toBe('in_progress');
  }, 30_000);

  it('TASK-A2) assignee WITHOUT manage_tasks → may edit notes (description)', async () => {
    await setCap(false);
    const id = await seedTask(assignedProjectId);
    await assignAgent(id);
    const upd = await svc.update(agent(), id, { description: 'called the owner, no answer' });
    expect(upd.description).toBe('called the owner, no answer');
  }, 30_000);

  it('TASK-A3) assignee WITHOUT manage_tasks → "done" (status=completed) sets completedAt', async () => {
    await setCap(false);
    const id = await seedTask(assignedProjectId);
    await assignAgent(id);
    const upd = await svc.update(agent(), id, { status: 'completed' });
    expect(upd.status).toBe('completed');
    expect(upd.completedAt).not.toBeNull();
    expect(upd.completedBy).toBe(agentId);
  }, 30_000);

  it('TASK-A4) assignee WITHOUT manage_tasks → editing title → 403 (narrow scope)', async () => {
    await setCap(false);
    const id = await seedTask(assignedProjectId);
    await assignAgent(id);
    await expect(svc.update(agent(), id, { title: 'hijack' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  }, 30_000);

  it('TASK-A5) assignee WITHOUT manage_tasks → re-targeting project → 403 (cannot move task)', async () => {
    await setCap(false);
    const id = await seedTask(assignedProjectId);
    await assignAgent(id);
    await expect(
      svc.update(agent(), id, { status: 'in_progress', projectId: unassignedProjectId }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  }, 30_000);

  it('TASK-A6) NON-assignee WITHOUT manage_tasks → status update → 404 (no task oracle)', async () => {
    await setCap(false);
    const id = await seedTask(assignedProjectId); // agent assigned to project but NOT to task
    await expect(svc.update(agent(), id, { status: 'in_progress' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  }, 30_000);

  it('TASK-A7) assignee WITH manage_tasks → full path still works (title editable)', async () => {
    await setCap(true);
    const id = await seedTask(assignedProjectId);
    await assignAgent(id);
    const upd = await svc.update(agent(), id, { title: 'full-mgmt' });
    expect(upd.title).toBe('full-mgmt');
  }, 30_000);
});

// QA-TASK-NOTIF-1 fix — "task sent" = in-app notification to the assignee.
describe('task_assigned in-app notification on assign', () => {
  it('TASK-N1) addAssignee emits task_assigned to the newly-assigned user (non-PII title only)', async () => {
    const emit = vi.fn(
      async (_input: {
        orgId: string;
        recipientId: string;
        type: string;
        body?: string | null;
      }): Promise<boolean> => true,
    );
    const spySvc = new TasksService(calendarStub, { emit } as never);
    const id = await seedTask(assignedProjectId);
    await spySvc.addAssignee(manager(), id, { userId: agentId });
    expect(emit).toHaveBeenCalledTimes(1);
    const arg = emit.mock.calls[0]![0];
    expect(arg.type).toBe('task_assigned');
    expect(arg.recipientId).toBe(agentId); // delivered to the ASSIGNEE, not the actor
    expect(arg.orgId).toBe(org.id);
    // PII guard: the body carries only the org-visible task title, no national_id/phone.
    expect(arg.body ?? '').not.toMatch(/\b\d{9}\b/);
    expect(arg.body ?? '').not.toMatch(/05\d{8}/);
  }, 30_000);

  it('TASK-N3) create WITH assigneeIds emits task_assigned to EACH assignee (incl. the auto-added creator, D-O6)', async () => {
    const emit = vi.fn(
      async (_input: { type: string; recipientId: string; orgId: string }): Promise<boolean> =>
        true,
    );
    const spySvc = new TasksService(calendarStub, { emit } as never);
    await spySvc.create(manager(), {
      title: 'bulk-assign',
      projectId: assignedProjectId,
      assigneeIds: [agentId],
    });
    // D-O6: the assignee set is now {creator (manager), agentId} — deduped — so a
    // task_assigned notification fires for EACH, the creator included. (Pre-D-O6
    // only agentId was an assignee → a single emit.) Assert both recipients,
    // order-independent, each exactly once; all task_assigned to this org.
    expect(emit).toHaveBeenCalledTimes(2);
    const calls = emit.mock.calls.map((c) => c[0]);
    expect(calls.every((a) => a.type === 'task_assigned')).toBe(true);
    expect(calls.every((a) => a.orgId === org.id)).toBe(true);
    expect(calls.map((a) => a.recipientId).sort()).toEqual([managerId, agentId].sort());
  }, 30_000);

  it('TASK-N2) a notify failure NEVER fails the assignment (best-effort isolation)', async () => {
    const emit = vi.fn(async () => {
      throw new Error('notify boom');
    });
    const spySvc = new TasksService(calendarStub, { emit } as never);
    const id = await seedTask(assignedProjectId);
    // The stub throws directly. addAssignee's own try/catch around the emit
    // (defense-in-depth, in addition to the producer self-guarding) is what
    // keeps the already-committed assignment from failing. Assert it resolves.
    await expect(spySvc.addAssignee(manager(), id, { userId: agentId })).resolves.toMatchObject({
      userId: agentId,
    });
  }, 30_000);
});

// H2 — the ICS UPDATE re-send must be gated on a real calendar-field change,
// not fired on every edit of a scheduled task (which previously re-mailed every
// external attendee on a status flip / assignee change / etc.).
describe('H2 — calendar ICS UPDATE fires only on a real calendar-field change', () => {
  function makeSpySvc(): {
    spySvc: TasksService;
    sendInvite: ReturnType<typeof vi.fn>;
  } {
    const sendInvite = vi.fn(
      async (): Promise<{ sent: number; skipped: number; failed: number }> => ({
        sent: 0,
        skipped: 0,
        failed: 0,
      }),
    );
    const spySvc = new TasksService({ sendInviteForTask: sendInvite } as never, notificationsStub);
    return { spySvc, sendInvite };
  }

  const SCHED = new Date('2026-07-01T09:00:00.000Z');

  it('TASK-CAL1) a non-calendar edit (status) on a scheduled task does NOT re-send the ICS', async () => {
    const { spySvc, sendInvite } = makeSpySvc();
    const t = await spySvc.create(manager(), {
      title: 'sched',
      projectId: assignedProjectId,
      scheduledAt: SCHED,
    });
    sendInvite.mockClear(); // drop the CREATE invite; assert only the UPDATE path
    await spySvc.update(manager(), t.id, { status: 'in_progress' });
    expect(sendInvite).not.toHaveBeenCalled();
  }, 30_000);

  it('TASK-CAL2) a calendar edit (title) on a scheduled task re-sends an ICS UPDATE', async () => {
    const { spySvc, sendInvite } = makeSpySvc();
    const t = await spySvc.create(manager(), {
      title: 'sched',
      projectId: assignedProjectId,
      scheduledAt: SCHED,
    });
    sendInvite.mockClear();
    await spySvc.update(manager(), t.id, { title: 'renamed' });
    expect(sendInvite).toHaveBeenCalledTimes(1);
    expect(sendInvite.mock.calls[0]![2]).toBe('update');
  }, 30_000);

  it('TASK-CAL3) clearing scheduledAt still fires CANCEL (a calendar state transition)', async () => {
    const { spySvc, sendInvite } = makeSpySvc();
    const t = await spySvc.create(manager(), {
      title: 'sched',
      projectId: assignedProjectId,
      scheduledAt: SCHED,
    });
    sendInvite.mockClear();
    await spySvc.update(manager(), t.id, { scheduledAt: null });
    expect(sendInvite).toHaveBeenCalledTimes(1);
    expect(sendInvite.mock.calls[0]![2]).toBe('cancel');
  }, 30_000);
});
