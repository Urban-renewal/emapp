/**
 * D.46 — run_imports agent capability enforcement. Deterministic real-DB.
 *
 * Guardrail: imports create/start/cancel/submitMapping are opened to agents;
 * each gates requireAgentCapability('run_imports') AFTER assertProjectVisible on
 * the job's project. Proven without triggering producer side-effects — the
 * 403/404 cases throw before the status machine / producer.
 */
import { randomUUID } from 'node:crypto';

import { db, memberships, projectAssignments, users } from '@emapp/db';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { ImportsService } from './imports.service';

let svc: ImportsService;
let org: TestOrg;
let managerId: string;
let agentId: string;
let assignedProjectId: string;
let unassignedProjectId: string;

const MGR_SID = '00000000-0000-4000-8000-0000000000e1';
const AGENT_SID = '00000000-0000-4000-8000-0000000000e2';

const storage = { getUploadUrl: async () => 'https://x/upload' } as never;
const producer = { send: async () => ({ id: null }) } as never;

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
const imp = (projectId: string) => ({
  projectId,
  fileName: 'f.xlsx',
  fileSizeBytes: 100,
  fileContentHash: 'a'.repeat(64),
  dryRun: false,
});

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
      `UPDATE memberships SET capabilities = jsonb_set(capabilities, '{run_imports}', $1::jsonb)
       WHERE user_id = $2 AND org_id = $3 AND revoked_at IS NULL`,
      [on ? 'true' : 'false', agentId, org.id],
    );
  } finally {
    c.release();
  }
}

/** Seed a queued import job created by the agent in a given project. */
async function seedJob(projectId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO import_jobs (org_id, project_id, file_r2_key, file_name, file_size_bytes, file_content_hash, created_by, status)
       VALUES ($1, $2, $3, 'f.xlsx', 100, 'h', $4, 'queued') RETURNING id`,
      [org.id, projectId, `org/${org.id}/import/${randomUUID()}`, agentId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new ImportsService(storage, producer);
  const tag = `d46-imp-${Date.now()}`;
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

describe('D.46 — run_imports agent enforcement', () => {
  it('IMP-1) assigned agent WITHOUT run_imports → 403 on create', async () => {
    await setCap(false);
    await expect(svc.create(agent(), imp(assignedProjectId))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('IMP-2) manager toggle ON → agent create (assigned project) allowed', async () => {
    await setCap(true);
    const res = await svc.create(agent(), imp(assignedProjectId));
    expect(res.uploadUrl).toBeTruthy();
  }, 30_000);

  it('IMP-3) agent with cap → create in UNASSIGNED project → 404', async () => {
    await setCap(true);
    await expect(svc.create(agent(), imp(unassignedProjectId))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('IMP-4) start: agent WITHOUT cap (own queued job, assigned) → 403', async () => {
    await setCap(false);
    const jobId = await seedJob(assignedProjectId);
    await expect(svc.start(agent(), jobId)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('IMP-5) start: agent WITH cap on a job in UNASSIGNED project → 404 (project gate)', async () => {
    await setCap(true);
    const jobId = await seedJob(unassignedProjectId);
    await expect(svc.start(agent(), jobId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('IMP-6) cancel: agent WITHOUT cap → 403', async () => {
    await setCap(false);
    const jobId = await seedJob(assignedProjectId);
    await expect(svc.cancel(agent(), jobId)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('IMP-7) submitMapping: agent WITHOUT cap → 403', async () => {
    await setCap(false);
    const jobId = await seedJob(assignedProjectId);
    await expect(
      svc.submitMapping(agent(), jobId, { columns: {} } as never),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('IMP-8) manager create (capability no-op)', async () => {
    const res = await svc.create(manager(), imp(assignedProjectId));
    expect(res.uploadUrl).toBeTruthy();
  }, 30_000);
});
