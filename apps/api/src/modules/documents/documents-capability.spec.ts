/**
 * D.46 — manage_documents agent capability enforcement. Deterministic real-DB.
 *
 * Mechanism (D.51): an assigned agent WITHOUT manage_documents is blocked (403)
 * on every document write (create/update/archive); a manager toggle flips the
 * SAME agent to allowed; an agent with the flag on a doc in an UNASSIGNED
 * project → 404 (visibility gate holds); an agent cannot create an org-level
 * (unparented) doc → 404; manager always writes.
 */
import { randomUUID } from 'node:crypto';

import { db, memberships, projectAssignments, users, type IStorageProvider } from '@emapp/db';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
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
let agentId: string;
let assignedProjectId: string;
let unassignedProjectId: string;

const MGR_SID = '00000000-0000-4000-8000-0000000000d1';
const AGENT_SID = '00000000-0000-4000-8000-0000000000d2';

const storage = {
  getUploadUrl: async () => 'https://x/upload',
  getDownloadUrl: async () => ({ url: 'https://x/dl', filename: 'f.pdf' }),
  head: async () => null,
  delete: async () => undefined,
} as unknown as IStorageProvider;

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
const doc = () => ({
  name: 'd.pdf',
  type: 'other' as const,
  mimeType: 'application/pdf' as const,
  sizeBytes: 100,
  contentHash: 'h' + randomUUID().slice(0, 8),
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
      `UPDATE memberships SET capabilities = jsonb_set(capabilities, '{manage_documents}', $1::jsonb)
       WHERE user_id = $2 AND org_id = $3 AND revoked_at IS NULL`,
      [on ? 'true' : 'false', agentId, org.id],
    );
  } finally {
    c.release();
  }
}

async function seedDoc(projectId: string | null): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO documents (org_id, project_id, name, type, mime_type, size_bytes, r2_key, content_hash, uploaded_by)
       VALUES ($1, $2, 'd.pdf', 'other', 'application/pdf', 100, $3, 'h', $4) RETURNING id`,
      [org.id, projectId, `org/${org.id}/doc/${randomUUID()}`, managerId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new DocumentsService(storage, new NotificationsProducerService());
  const tag = `d46-doc-${Date.now()}`;
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

describe('D.46 — manage_documents agent enforcement', () => {
  it('D46-DOC-1) assigned agent WITHOUT manage_documents → 403 on create', async () => {
    await setCap(false);
    await expect(
      svc.create(agent(), { ...doc(), projectId: assignedProjectId }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('D46-DOC-2) manager toggle ON → agent create (assigned project) allowed', async () => {
    await setCap(true);
    const res = await svc.create(agent(), { ...doc(), projectId: assignedProjectId });
    expect(res.document.id).toBeTruthy();
    expect(res.uploadUrl).toBeTruthy();
  }, 30_000);

  it('D46-DOC-3) agent with cap → create org-level (no project/apartment) → 404', async () => {
    await setCap(true);
    await expect(svc.create(agent(), { ...doc() })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('D46-DOC-4) agent with cap → update a doc in UNASSIGNED project → 404', async () => {
    await setCap(true);
    const id = await seedDoc(unassignedProjectId);
    await expect(svc.update(agent(), id, { name: 'x.pdf' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('D46-DOC-5) update/archive: agent WITHOUT cap → 403; WITH cap → allowed (assigned doc)', async () => {
    const id = await seedDoc(assignedProjectId);
    await setCap(false);
    await expect(svc.update(agent(), id, { name: 'y.pdf' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await setCap(true);
    const upd = await svc.update(agent(), id, { name: 'z.pdf' });
    expect(upd.name).toBe('z.pdf');
    await expect(svc.archive(agent(), id)).resolves.toBeUndefined();
  }, 30_000);

  it('D46-DOC-6) manager writes any doc (capability no-op)', async () => {
    const id = await seedDoc(unassignedProjectId);
    const upd = await svc.update(manager(), id, { name: 'm.pdf' });
    expect(upd.name).toBe('m.pdf');
  });

  it('D46-DOC-7) finalize (POST→create cell) is gated too: agent WITHOUT cap → 403', async () => {
    // finalize maps to the documents.create cell (POST, no @AuthzAction). The
    // cap gate runs after loadVisible, before the integrity logic — so an
    // assigned-project doc + no cap throws 403 (proves the 4th write path gates).
    const id = await seedDoc(assignedProjectId);
    await setCap(false);
    await expect(
      svc.finalize(agent(), id, { sizeBytes: 100, contentHash: 'h' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
