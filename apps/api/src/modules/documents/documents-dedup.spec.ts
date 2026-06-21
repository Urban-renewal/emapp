/**
 * DH4 (MASTER-PLAN-V13 Wave B) — document DEDUP probe ("link to existing").
 *
 * Asserts `DocumentsService.dedupCheck` against the REAL local DB (the agent
 * record-scoping EXISTS + the org RLS run in SQL — mocking would defeat the
 * whole point). A minimal storage/scan/notifications stub is injected; the
 * dedup path is a metadata-only SELECT and touches none of them.
 *
 * THE CONTRACT under test:
 *  - same-org match: a non-archived doc with the same contentHash is returned
 *    as a candidate (metadata only — documentId/type/scope/scopeId/filename).
 *  - {data} envelope shape: duplicates[] + hasDuplicate boolean.
 *  - CROSS-ORG NO-LEAK (the security crux): org-A probing a hash that exists
 *    ONLY in org-B gets ZERO duplicates — never a cross-tenant existence oracle.
 *  - archived excluded: an archived doc with the hash is NOT a candidate.
 *  - no-duplicate empty case: an unknown hash → [] + hasDuplicate=false.
 *  - newest-first ranking: two docs sharing a hash come back newest-first.
 *  - agent record-scoping: an agent sees a candidate only for a doc in an
 *    ASSIGNED project; an org-level (unparented) doc is invisible.
 *  - no r2Key ever on the wire.
 *
 * Run:
 *   DB_TARGET=local LOCAL_DATABASE_URL=postgresql://postgres:1234@localhost:5432/emapp?sslmode=disable \
 *     infisical run --env dev -- pnpm --filter @emapp/api exec \
 *     vitest run src/modules/documents/documents-dedup.spec.ts
 */
import { randomUUID } from 'node:crypto';

import { db, documents, memberships, projectAssignments, users, withTenant } from '@emapp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { DocumentsService } from './documents.service';

let svc: DocumentsService;
let orgA: TestOrg;
let orgB: TestOrg;
let mgrAId: string;
let mgrBId: string;
let agentAId: string;

const TAG = randomUUID().slice(0, 8);

// Inert stubs — the dedup path is a metadata-only DB read, so none are called.
const storageStub = {} as never;
const scanStub = {} as never;
const notificationsStub = {} as never;

function managerA(): AccessTokenPayload {
  return {
    sub: mgrAId,
    orgId: orgA.id,
    role: 'manager',
    sid: randomUUID(),
    type: 'access',
  } as unknown as AccessTokenPayload;
}
function managerB(): AccessTokenPayload {
  return {
    sub: mgrBId,
    orgId: orgB.id,
    role: 'manager',
    sid: randomUUID(),
    type: 'access',
  } as unknown as AccessTokenPayload;
}
function agentA(): AccessTokenPayload {
  return {
    sub: agentAId,
    orgId: orgA.id,
    role: 'agent',
    sid: randomUUID(),
    type: 'access',
  } as unknown as AccessTokenPayload;
}

/** A fresh sha256-shaped hex hash (64 chars) per call. */
function freshHash(): string {
  return (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 64);
}

interface SeedDocOpts {
  projectId?: string | null;
  apartmentId?: string | null;
  type?: string;
  archived?: boolean;
  createdAt?: Date;
}

async function seedDoc(
  orgId: string,
  name: string,
  contentHash: string,
  opts: SeedDocOpts = {},
): Promise<string> {
  // DH1 canonical scope — a real document carries doc_scope/doc_scope_id, not
  // just the legacy project_id. Derive it so the seeded row matches production
  // shape (and satisfies the documents_doc_scope_id_consistent CHECK: scope_id
  // is NULL iff doc_scope='org'). This is what the dedup probe reports back.
  const docScope = opts.apartmentId ? 'apartment' : opts.projectId ? 'project' : 'org';
  const docScopeId = opts.apartmentId ?? opts.projectId ?? null;
  return withTenant(orgId, async (tx) => {
    const [row] = await tx
      .insert(documents)
      .values({
        orgId,
        projectId: opts.projectId ?? null,
        apartmentId: opts.apartmentId ?? null,
        docScope,
        docScopeId,
        name,
        type: opts.type ?? 'agreement',
        mimeType: 'application/pdf',
        sizeBytes: 1234,
        r2Key: `org/${orgId}/doc/${randomUUID()}`,
        contentHash,
        uploadedBy: orgId === orgA.id ? mgrAId : mgrBId,
        uploadedAt: new Date(),
        scanStatus: 'clean',
        archivedAt: opts.archived ? new Date() : null,
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      })
      .returning({ id: documents.id });
    return row!.id;
  });
}

async function seedAgent(orgId: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `ag-${randomUUID()}@test.local`, name: 'Ag', passwordHash: '$2b$12$x' })
    .returning({ id: users.id });
  await db
    .insert(memberships)
    .values({ userId: u!.id, orgId, role: 'agent', acceptedAt: new Date() });
  return u!.id;
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new DocumentsService(storageStub, scanStub, notificationsStub);
  orgA = await createTestOrg(`DedupA-${TAG}`);
  orgB = await createTestOrg(`DedupB-${TAG}`);
  mgrAId = orgA.users[0]!.id;
  mgrBId = orgB.users[0]!.id;
  agentAId = await seedAgent(orgA.id);
}, 60_000);

afterAll(async () => {
  /* harmless leftover rows */
});

describe('DH4 documents dedup-check', () => {
  it('same-org match: returns the existing doc as a link candidate (metadata only)', async () => {
    const projId = orgA.projects[0]!.id;
    const hash = freshHash();
    const docId = await seedDoc(orgA.id, `Dedup Hit ${TAG}`, hash, { projectId: projId });

    const res = await svc.dedupCheck(managerA(), { contentHash: hash });
    expect(res.hasDuplicate).toBe(true);
    expect(res.duplicates.map((d) => d.documentId)).toContain(docId);
    const cand = res.duplicates.find((d) => d.documentId === docId)!;
    expect(cand.type).toBe('agreement');
    expect(cand.filename).toBe(`Dedup Hit ${TAG}`);
    expect(cand.scope).toBe('project');
    expect(cand.scopeId).toBe(projId);
    expect(cand.createdAt).toBeInstanceOf(Date);
  });

  it('no r2Key ever appears on a candidate', async () => {
    const projId = orgA.projects[0]!.id;
    const hash = freshHash();
    await seedDoc(orgA.id, `NoKey ${TAG}`, hash, { projectId: projId });
    const res = await svc.dedupCheck(managerA(), { contentHash: hash });
    expect(res.duplicates.length).toBeGreaterThan(0);
    for (const d of res.duplicates) {
      expect(d).not.toHaveProperty('r2Key');
      expect(d).not.toHaveProperty('r2_key');
    }
  });

  it('CROSS-ORG NO-LEAK: org-A probing org-B-only hash gets ZERO duplicates', async () => {
    const hash = freshHash();
    // The hash exists ONLY in org-B.
    const bId = await seedDoc(orgB.id, `OrgB Secret ${TAG}`, hash, {
      projectId: orgB.projects[0]!.id,
    });

    // org-A must see NOTHING (no existence oracle).
    const fromA = await svc.dedupCheck(managerA(), { contentHash: hash });
    expect(fromA.hasDuplicate).toBe(false);
    expect(fromA.duplicates).toHaveLength(0);

    // org-B legitimately sees its own doc — proves the hash WAS real (the
    // empty org-A result is RLS isolation, not a non-existent hash).
    const fromB = await svc.dedupCheck(managerB(), { contentHash: hash });
    expect(fromB.duplicates.map((d) => d.documentId)).toContain(bId);
  });

  it('archived docs are excluded from candidates', async () => {
    const projId = orgA.projects[0]!.id;
    const hash = freshHash();
    const archId = await seedDoc(orgA.id, `Archived ${TAG}`, hash, {
      projectId: projId,
      archived: true,
    });
    const res = await svc.dedupCheck(managerA(), { contentHash: hash });
    expect(res.duplicates.map((d) => d.documentId)).not.toContain(archId);
    expect(res.hasDuplicate).toBe(false);
  });

  it('no-duplicate empty case: an unknown hash → [] + hasDuplicate=false', async () => {
    const res = await svc.dedupCheck(managerA(), { contentHash: freshHash() });
    expect(res.duplicates).toHaveLength(0);
    expect(res.hasDuplicate).toBe(false);
  });

  it('newest-first ranking: the most recent identical doc is the primary candidate', async () => {
    const projId = orgA.projects[0]!.id;
    const hash = freshHash();
    const older = await seedDoc(orgA.id, `Rank Old ${TAG}`, hash, {
      projectId: projId,
      createdAt: new Date(Date.now() - 60_000),
    });
    const newer = await seedDoc(orgA.id, `Rank New ${TAG}`, hash, {
      projectId: projId,
      createdAt: new Date(),
    });
    const res = await svc.dedupCheck(managerA(), { contentHash: hash });
    const ids = res.duplicates.map((d) => d.documentId);
    expect(ids).toContain(older);
    expect(ids).toContain(newer);
    // newer comes before older.
    expect(ids.indexOf(newer)).toBeLessThan(ids.indexOf(older));
  });

  it('agent record-scoping: sees a candidate only for assigned projects; org-level invisible', async () => {
    const assignedProj = orgA.projects[0]!.id;
    const unassignedProj = orgA.projects[1]!.id;
    const hash = freshHash();
    const assignedDoc = await seedDoc(orgA.id, `Ag Assigned ${TAG}`, hash, {
      projectId: assignedProj,
    });
    const unassignedDoc = await seedDoc(orgA.id, `Ag Unassigned ${TAG}`, hash, {
      projectId: unassignedProj,
    });
    const orgDoc = await seedDoc(orgA.id, `Ag OrgLevel ${TAG}`, hash); // no parent
    await db
      .insert(projectAssignments)
      .values({ projectId: assignedProj, userId: agentAId, assignedBy: mgrAId });

    const res = await svc.dedupCheck(agentA(), { contentHash: hash });
    const ids = res.duplicates.map((d) => d.documentId);
    expect(ids).toContain(assignedDoc);
    expect(ids).not.toContain(unassignedDoc);
    expect(ids).not.toContain(orgDoc);

    // A manager (RLS-org-bound, no record-scoping) sees ALL three.
    const mgr = await svc.dedupCheck(managerA(), { contentHash: hash });
    const mids = mgr.duplicates.map((d) => d.documentId);
    expect(mids).toContain(assignedDoc);
    expect(mids).toContain(unassignedDoc);
    expect(mids).toContain(orgDoc);
  });
});
