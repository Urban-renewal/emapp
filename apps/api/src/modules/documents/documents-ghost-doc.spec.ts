/**
 * 0050 (ghost-doc UX) — download-path authz/ghost ORDERING, real-DB.
 *
 * The change under test: in `DocumentsService.loadVisible`, the per-record
 * visibility check (`assertDocVisibleForAgent`) now runs BEFORE the
 * `requireUploaded && !uploadedAt` ("ghost") check. The only requireUploaded=
 * true caller is `getDownloadUrl`. Consequences this suite pins:
 *
 *  G1  Own ghost (no uploaded_at) on the DOWNLOAD path → 409 with body code
 *      `document_upload_incomplete` (DOCUMENT_UPLOAD_INCOMPLETE_CODE).
 *      LOAD-BEARING. Mutation-proof: delete the `if (requireUploaded &&
 *      !row.uploadedAt) throw UPLOAD_INCOMPLETE` line → the download would
 *      instead resolve a url (ghost served) → G1 fails.
 *  G2  Foreign/unknown id → STILL the generic 404 `not_found`, body NEVER
 *      contains `document_upload_incomplete`. LOAD-BEARING no-leak.
 *      Mutation-proof: move the ghost check BEFORE assertDocVisibleForAgent
 *      (revert the reorder) → a foreign-org GHOST would throw the new code
 *      before the visibility 404 → G2's "never the new code" assertion fails
 *      (existence oracle).
 *  G3  Agent record-scoping: a ghost in a project the agent is NOT assigned to
 *      → generic `not_found` (authz precedes the ghost check), NOT the new
 *      code. No-leak for the agent role specifically.
 *  G4  Finalized doc (uploaded_at set) → download resolves {url,expiresIn…}.
 *      Regression: the reorder must not break the happy path.
 *
 * Service-level (not HTTP): exercises getDownloadUrl/loadVisible directly,
 * deterministic, and sidesteps the signup throttler. Mirrors the seeding
 * pattern of documents-capability.spec.ts (createTestOrg + raw INSERT;
 * a row WITHOUT uploaded_at is a ghost, a row WITH uploaded_at is uploaded).
 */
import { randomUUID } from 'node:crypto';

import {
  NoopFileScanProvider,
  db,
  memberships,
  projectAssignments,
  users,
  type IStorageProvider,
} from '@emapp/db';
import { DOCUMENT_UPLOAD_INCOMPLETE_CODE } from '@emapp/shared-types';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';

import { DocumentsService } from './documents.service';

// A real https URL so the (string) presigned-GET contract is honoured — the
// happy path (G4) asserts a non-empty url comes back. No secret literals.
const DOWNLOAD_URL = 'https://r2.example.test/presigned-get';

const storage = {
  getUploadUrl: async () => 'https://r2.example.test/presigned-put',
  getDownloadUrl: async () => DOWNLOAD_URL,
  head: async () => null,
  delete: async () => undefined,
  getObjectStream: async () => {
    throw new Error('not used');
  },
  healthCheck: async () => undefined,
} as unknown as IStorageProvider;

let svc: DocumentsService;
let orgA: TestOrg;
let orgB: TestOrg;
let managerA: string;
let agentId: string;
let assignedProjectId: string;
let unassignedProjectId: string;

const MGR_SID = '00000000-0000-4000-8000-0000000000a1';
const AGENT_SID = '00000000-0000-4000-8000-0000000000a2';

function managerUser(): AccessTokenPayload {
  return {
    sub: managerA,
    orgId: orgA.id,
    role: 'manager',
    sid: MGR_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}
function agentUser(): AccessTokenPayload {
  return {
    sub: agentId,
    orgId: orgA.id,
    role: 'agent',
    sid: AGENT_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

/** Insert a documents row. Omitting `uploaded` (default) leaves uploaded_at
 *  NULL = a GHOST. `uploaded:true` stamps uploaded_at = a finalised doc.
 *  Inserted via providerPool (BYPASSRLS) so we can seed into ANY org/project
 *  exactly like documents-capability.spec's seedDoc. */
async function seedDoc(opts: {
  orgId: string;
  projectId: string | null;
  uploadedBy: string;
  uploaded?: boolean;
}): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      // P0.B1: scan_status='clean' so the finalised (G4) row passes the new
      // download malware gate — these tests pin the uploaded_at ordering, not
      // scanning. The ghost rows (G1–G3) hit the uploaded_at/visibility checks
      // first (ordered before the scan check), so their value is immaterial.
      `INSERT INTO documents
         (org_id, project_id, name, type, mime_type, size_bytes, r2_key, content_hash, uploaded_by, uploaded_at, scan_status)
       VALUES ($1, $2, 'ghost.pdf', 'other', 'application/pdf', 100, $3, 'h', $4, $5, 'clean')
       RETURNING id`,
      [
        opts.orgId,
        opts.projectId,
        `org/${opts.orgId}/doc/${randomUUID()}`,
        opts.uploadedBy,
        opts.uploaded ? new Date() : null,
      ],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

async function seedAgent(orgId: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `ghost-agent-${randomUUID()}@test.local`,
      name: 'Ghost Agent',
      passwordHash: '$2b$12$x',
    })
    .returning({ id: users.id });
  await db
    .insert(memberships)
    .values({ userId: u!.id, orgId, role: 'agent', acceptedAt: new Date() });
  return u!.id;
}

/** Pull the D.16 error `code` out of a thrown Nest HttpException whose response
 *  body is `{ error: { code } }`. Returns undefined if the shape differs (so a
 *  caller can assert "NOT the new code" without brittle casts). */
function errCode(e: unknown): string | undefined {
  if (e instanceof Error && 'getResponse' in e) {
    const body = (e as { getResponse: () => unknown }).getResponse();
    const code = (body as { error?: { code?: unknown } })?.error?.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new DocumentsService(
    storage,
    new NoopFileScanProvider(),
    new NotificationsProducerService(),
  );
  const tag = `ghost-${Date.now()}`;
  orgA = await createTestOrg(`${tag}-a`, `${tag}-a`);
  orgB = await createTestOrg(`${tag}-b`, `${tag}-b`);
  managerA = orgA.users[0]!.id;
  assignedProjectId = orgA.projects[0]!.id;
  unassignedProjectId = orgA.projects[1]!.id;
  agentId = await seedAgent(orgA.id);
  await db
    .insert(projectAssignments)
    .values({ projectId: assignedProjectId, userId: agentId, assignedBy: managerA });
}, 90_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('0050 ghost-doc · download authz/ghost ordering (real-DB)', () => {
  it('G1) own GHOST on download → 409 document_upload_incomplete (LOAD-BEARING)', async () => {
    const id = await seedDoc({
      orgId: orgA.id,
      projectId: assignedProjectId,
      uploadedBy: managerA,
      // uploaded omitted → uploaded_at NULL → ghost
    });
    let thrown: unknown;
    try {
      await svc.getDownloadUrl(managerUser(), id);
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'a ghost download must throw, never resolve a url').toBeInstanceOf(
      ConflictException,
    );
    expect((thrown as ConflictException).getStatus()).toBe(409);
    expect(errCode(thrown)).toBe(DOCUMENT_UPLOAD_INCOMPLETE_CODE);
    expect(errCode(thrown)).toBe('document_upload_incomplete');
  }, 30_000);

  it('G2) FOREIGN/unknown id on download → 404 not_found, NEVER the new code (LOAD-BEARING no-leak)', async () => {
    // 2a — a random (non-existent) uuid.
    let rnd: unknown;
    try {
      await svc.getDownloadUrl(managerUser(), randomUUID());
    } catch (e) {
      rnd = e;
    }
    expect(rnd).toBeInstanceOf(NotFoundException);
    expect((rnd as NotFoundException).getStatus()).toBe(404);
    expect(errCode(rnd)).toBe('not_found');
    expect(errCode(rnd)).not.toBe(DOCUMENT_UPLOAD_INCOMPLETE_CODE);

    // 2b — the security-critical case: a GHOST that exists but in ANOTHER org.
    // RLS (withTenant on orgA) makes it invisible; the ordering guarantees the
    // generic 404 fires BEFORE the ghost check, so the new code must NOT leak
    // (else it is an existence oracle for foreign un-finalised docs).
    const foreignGhostId = await seedDoc({
      orgId: orgB.id,
      projectId: orgB.projects[0]!.id,
      uploadedBy: orgB.users[0]!.id,
      // ghost (uploaded_at NULL) — the exact row that would leak the new code
      // if the authz/uploadedAt order were reverted.
    });
    let foreign: unknown;
    try {
      await svc.getDownloadUrl(managerUser(), foreignGhostId);
    } catch (e) {
      foreign = e;
    }
    expect(foreign).toBeInstanceOf(NotFoundException);
    expect((foreign as NotFoundException).getStatus()).toBe(404);
    expect(errCode(foreign)).toBe('not_found');
    expect(
      errCode(foreign),
      'foreign-org ghost must NOT leak document_upload_incomplete (existence oracle)',
    ).not.toBe(DOCUMENT_UPLOAD_INCOMPLETE_CODE);
  }, 30_000);

  it('G3) AGENT — ghost in an UNASSIGNED project → generic not_found, NOT the new code (no-leak)', async () => {
    // Ghost lives in orgA but in a project the agent is NOT assigned to. The
    // agent visibility check (assertDocVisibleForAgent → assertProjectVisible)
    // throws 404 BEFORE the ghost check is reached.
    const id = await seedDoc({
      orgId: orgA.id,
      projectId: unassignedProjectId,
      uploadedBy: managerA,
      // ghost
    });
    let thrown: unknown;
    try {
      await svc.getDownloadUrl(agentUser(), id);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect((thrown as NotFoundException).getStatus()).toBe(404);
    expect(errCode(thrown)).toBe('not_found');
    expect(
      errCode(thrown),
      'agent must not learn an unassigned-project doc exists via the ghost code',
    ).not.toBe(DOCUMENT_UPLOAD_INCOMPLETE_CODE);
  }, 30_000);

  it('G4) FINALIZED doc → download resolves a presigned url (regression: reorder did not break happy path)', async () => {
    const id = await seedDoc({
      orgId: orgA.id,
      projectId: assignedProjectId,
      uploadedBy: managerA,
      uploaded: true, // uploaded_at stamped → finalised, servable
    });
    const res = await svc.getDownloadUrl(managerUser(), id);
    expect(res.url).toBe(DOWNLOAD_URL);
    expect(typeof res.expiresInSeconds).toBe('number');
    expect(res.expiresInSeconds).toBeGreaterThan(0);
  }, 30_000);
});
