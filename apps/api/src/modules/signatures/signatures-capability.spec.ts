/**
 * D.46 — manage_signatures agent capability enforcement. Deterministic real-DB.
 *
 * Guardrail: signature create + cancel are opened to agents; each gates
 * requireAgentCapability('manage_signatures') AFTER the underlying document's
 * agent visibility (assertDocVisibleForAgent). Proven via cancel for the
 * toggle (no email/JWT side-effects) + create/cancel 403/404 for the gates.
 */
import { randomUUID } from 'node:crypto';

import {
  db,
  encryptOwnerPii,
  memberships,
  owners,
  projectAssignments,
  users,
  withTenant,
} from '@emapp/db';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { SignatureRequestsService } from './signature-requests.service';

let svc: SignatureRequestsService;
let org: TestOrg;
let managerId: string;
let agentId: string;
let assignedProjectId: string;
let unassignedProjectId: string;
let docAssigned: string;
let docUnassigned: string;
let ownerId: string;

const MGR_SID = '00000000-0000-4000-8000-0000000000f1';
const AGENT_SID = '00000000-0000-4000-8000-0000000000f2';

const tokenStub = {
  sign: () => ({
    token: 'tok',
    jti: 'jti-' + randomUUID(),
    expiresAt: new Date(Date.now() + 3_600_000),
  }),
} as never;
const emailStub = { sendSignatureLink: async () => undefined } as never;

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
      `UPDATE memberships SET capabilities = jsonb_set(capabilities, '{manage_signatures}', $1::jsonb)
       WHERE user_id = $2 AND org_id = $3 AND revoked_at IS NULL`,
      [on ? 'true' : 'false', agentId, org.id],
    );
  } finally {
    c.release();
  }
}

async function seedDoc(projectId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO documents (org_id, project_id, name, type, mime_type, size_bytes, r2_key, content_hash, uploaded_by, uploaded_at)
       VALUES ($1, $2, 'd.pdf', 'contract', 'application/pdf', 100, $3, 'h', $4, now()) RETURNING id`,
      [org.id, projectId, `org/${org.id}/doc/${randomUUID()}`, managerId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

async function seedOwner(orgId: string): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, {
      nationalId: '000000018',
      name: 'בעלים',
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

async function seedSigReq(documentId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO signature_requests (org_id, document_id, owner_id, jti, status, expires_at, created_by)
       VALUES ($1, $2, $3, $4, 'pending', now() + interval '1 day', $5) RETURNING id`,
      [org.id, documentId, ownerId, 'jti-' + randomUUID(), managerId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new SignatureRequestsService(tokenStub, emailStub);
  const tag = `d46-sig-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  assignedProjectId = org.projects[0]!.id;
  unassignedProjectId = org.projects[1]!.id;
  agentId = await seedAgent(org.id);
  await db
    .insert(projectAssignments)
    .values({ projectId: assignedProjectId, userId: agentId, assignedBy: managerId });
  docAssigned = await seedDoc(assignedProjectId);
  docUnassigned = await seedDoc(unassignedProjectId);
  ownerId = await seedOwner(org.id);
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('D.46 — manage_signatures agent enforcement', () => {
  it('SIG-1) create: assigned agent WITHOUT manage_signatures → 403', async () => {
    await setCap(false);
    await expect(svc.create(agent(), { documentId: docAssigned, ownerId })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('SIG-2) create: agent WITH cap but document in UNASSIGNED project → 404', async () => {
    await setCap(true);
    await expect(
      svc.create(agent(), { documentId: docUnassigned, ownerId }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('SIG-3) cancel: agent WITHOUT cap → 403', async () => {
    await setCap(false);
    const id = await seedSigReq(docAssigned);
    await expect(svc.cancel(agent(), id)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('SIG-4) cancel: manager toggle ON → agent cancels (assigned doc) → status cancelled', async () => {
    await setCap(true);
    const id = await seedSigReq(docAssigned);
    const res = await svc.cancel(agent(), id);
    expect(res.status).toBe('cancelled');
  }, 30_000);

  it('SIG-5) cancel: agent WITH cap but document in UNASSIGNED project → 404', async () => {
    await setCap(true);
    const id = await seedSigReq(docUnassigned);
    await expect(svc.cancel(agent(), id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('SIG-6) manager cancels any signature (capability no-op)', async () => {
    const id = await seedSigReq(docUnassigned);
    const res = await svc.cancel(manager(), id);
    expect(res.status).toBe('cancelled');
  });
});
