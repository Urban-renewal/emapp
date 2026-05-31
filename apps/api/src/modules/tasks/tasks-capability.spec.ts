/**
 * D.46 — manage_tasks agent capability enforcement. Deterministic real-DB.
 *
 * manage_tasks grants FULL task management (create/update/archive + add/remove
 * assignee), PROJECT-scoped via the task's projectId (assertTaskVisibleForAgent).
 * This REPLACES the prior assignment-based, status/description-only agent update.
 * READ (list/get) stays assignee-based (out of scope here).
 */
import { randomUUID } from 'node:crypto';

import { db, memberships, projectAssignments, users } from '@emapp/db';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

beforeAll(async () => {
  await setupTestDatabase();
  svc = new TasksService(calendarStub);
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

  it('TASK-5) update: agent w/o cap → 403; with cap → FULL field update (title) allowed', async () => {
    const id = await seedTask(assignedProjectId);
    await setCap(false);
    await expect(svc.update(agent(), id, { title: 'x' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await setCap(true);
    // title is NOT in the old status/description allow-list — full management.
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
    await expect(svc.addAssignee(agent(), id, { userId: managerId })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await setCap(true);
    const a = await svc.addAssignee(agent(), id, { userId: managerId });
    expect(a.id).toBeTruthy();
  }, 30_000);

  it('TASK-9) removeAssignee: agent with cap (assigned task) → allowed', async () => {
    await setCap(true);
    const id = await seedTask(assignedProjectId);
    await svc.addAssignee(agent(), id, { userId: managerId });
    await expect(svc.removeAssignee(agent(), id, managerId)).resolves.toBeUndefined();
  }, 30_000);

  it('TASK-10) manager creates/updates any task (capability no-op)', async () => {
    const id = await seedTask(unassignedProjectId);
    const upd = await svc.update(manager(), id, { title: 'mgr' });
    expect(upd.title).toBe('mgr');
  });
});
