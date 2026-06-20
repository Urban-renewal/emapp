/**
 * NS1 (server-side search, MASTER-PLAN-V13 Wave B) — document NAME search.
 *
 * Asserts `DocumentsService.searchDocuments` against the REAL local DB (the
 * agent record-scoping EXISTS + RLS run in SQL — mocking would defeat it). A
 * minimal storage/scan/notifications stub is injected; the search path touches
 * none of them (metadata-only query), so the stubs are inert.
 *
 * THE CONTRACT under test:
 *  - q match: returns docs whose NAME contains the substring (case-insensitive);
 *    a non-matching doc is absent.
 *  - empty-q semantics: search REQUIRES q (Zod), so we assert the q-scoping
 *    instead — a q that matches nothing returns an empty page.
 *  - type filter: `type` restricts to that exact document type.
 *  - scope filter: `scope` narrows by parent linkage (project|apartment|org).
 *  - archived: archived docs are excluded by default, included with archived.
 *  - RLS isolation: org-A never finds org-B's doc by name.
 *  - keyset cursor: limit=1 over ≥2 matches → has_more + cursor; page2 no dup.
 *  - agent scope: an agent sees only docs whose parent project is assigned;
 *    an org-level (unparented) doc is invisible to agents.
 *  - no r2Key ever on the wire.
 *
 * Run:
 *   DB_TARGET=local LOCAL_DATABASE_URL=postgresql://postgres:1234@localhost:5432/emapp?sslmode=disable \
 *     infisical run --env dev -- pnpm --filter @emapp/api exec \
 *     vitest run src/modules/documents/documents-search.spec.ts
 */
import { randomUUID } from 'node:crypto';

import {
  apartments,
  buildings,
  db,
  documents,
  memberships,
  projectAssignments,
  users,
  withTenant,
} from '@emapp/db';
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

// Inert stubs — the search path is a metadata-only DB read, so none of these
// are ever called. Constructed only to satisfy the DI signature.
const storageStub = {} as never;
const scanStub = {} as never;
const notificationsStub = {} as never;

function managerA(): AccessTokenPayload {
  return { sub: mgrAId, orgId: orgA.id, role: 'manager', sid: randomUUID(), type: 'access' } as unknown as AccessTokenPayload;
}
function managerB(): AccessTokenPayload {
  return { sub: mgrBId, orgId: orgB.id, role: 'manager', sid: randomUUID(), type: 'access' } as unknown as AccessTokenPayload;
}
function agentA(): AccessTokenPayload {
  return { sub: agentAId, orgId: orgA.id, role: 'agent', sid: randomUUID(), type: 'access' } as unknown as AccessTokenPayload;
}

interface SeedDocOpts {
  projectId?: string | null;
  apartmentId?: string | null;
  type?: string;
  archived?: boolean;
}

async function seedDoc(orgId: string, name: string, opts: SeedDocOpts = {}): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx
      .insert(documents)
      .values({
        orgId,
        projectId: opts.projectId ?? null,
        apartmentId: opts.apartmentId ?? null,
        name,
        type: opts.type ?? 'agreement',
        mimeType: 'application/pdf',
        sizeBytes: 1234,
        r2Key: `org/${orgId}/doc/${randomUUID()}`,
        contentHash: randomUUID().replace(/-/g, ''),
        uploadedBy: orgId === orgA.id ? mgrAId : mgrBId,
        uploadedAt: new Date(),
        scanStatus: 'clean',
        archivedAt: opts.archived ? new Date() : null,
      })
      .returning({ id: documents.id });
    return row!.id;
  });
}

async function seedApartment(orgId: string, projectId: string): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const [b] = await tx
      .insert(buildings)
      .values({ projectId, address: `addr ${randomUUID()}`, city: 'TLV' })
      .returning({ id: buildings.id });
    const [a] = await tx
      .insert(apartments)
      .values({ buildingId: b!.id, number: `N-${randomUUID().slice(0, 8)}` })
      .returning({ id: apartments.id });
    return a!.id;
  });
}

async function seedAgent(orgId: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `ag-${randomUUID()}@test.local`, name: 'Ag', passwordHash: '$2b$12$x' })
    .returning({ id: users.id });
  await db.insert(memberships).values({ userId: u!.id, orgId, role: 'agent', acceptedAt: new Date() });
  return u!.id;
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new DocumentsService(storageStub, scanStub, notificationsStub);
  orgA = await createTestOrg(`DocSrchA-${TAG}`);
  orgB = await createTestOrg(`DocSrchB-${TAG}`);
  mgrAId = orgA.users[0]!.id;
  mgrBId = orgB.users[0]!.id;
  agentAId = await seedAgent(orgA.id);
}, 60_000);

afterAll(async () => {
  /* harmless leftover rows */
});

describe('NS1 documents search', () => {
  it('q matches docs by name substring (case-insensitive); non-match absent', async () => {
    const projId = orgA.projects[0]!.id;
    const hit = `Agreement Marom ${TAG}`;
    const miss = `Blueprint Hidden ${TAG}`;
    const hitId = await seedDoc(orgA.id, hit, { projectId: projId });
    await seedDoc(orgA.id, miss, { projectId: projId });

    const res = await svc.searchDocuments(managerA(), { q: 'marom', limit: 100 });
    const ids = res.data.map((d) => d.id);
    expect(ids).toContain(hitId);
    expect(res.data.map((d) => d.name)).not.toContain(miss);
  });

  it('no r2Key ever appears on the wire', async () => {
    const projId = orgA.projects[0]!.id;
    const name = `NoKey ${TAG}-${randomUUID().slice(0, 6)}`;
    await seedDoc(orgA.id, name, { projectId: projId });
    const res = await svc.searchDocuments(managerA(), { q: name, limit: 10 });
    expect(res.data.length).toBeGreaterThan(0);
    for (const d of res.data) expect(d).not.toHaveProperty('r2Key');
  });

  it('type filter restricts to the exact document type', async () => {
    const projId = orgA.projects[0]!.id;
    const t = `Typed ${TAG}-${randomUUID().slice(0, 6)}`;
    const agreementId = await seedDoc(orgA.id, `${t} A`, { projectId: projId, type: 'agreement' });
    const blueprintId = await seedDoc(orgA.id, `${t} B`, { projectId: projId, type: 'blueprint' });
    const res = await svc.searchDocuments(managerA(), { q: t, limit: 100, type: 'agreement' });
    const ids = res.data.map((d) => d.id);
    expect(ids).toContain(agreementId);
    expect(ids).not.toContain(blueprintId);
    expect(res.data.every((d) => d.type === 'agreement')).toBe(true);
  });

  it('scope filter narrows by parent linkage (project vs apartment vs org)', async () => {
    const projId = orgA.projects[0]!.id;
    const aptId = await seedApartment(orgA.id, projId);
    const s = `Scoped ${TAG}-${randomUUID().slice(0, 6)}`;
    const projDoc = await seedDoc(orgA.id, `${s} P`, { projectId: projId });
    const aptDoc = await seedDoc(orgA.id, `${s} A`, { apartmentId: aptId });
    const orgDoc = await seedDoc(orgA.id, `${s} O`); // org-level (no parent)

    const proj = await svc.searchDocuments(managerA(), { q: s, limit: 100, scope: 'project' });
    expect(proj.data.map((d) => d.id)).toContain(projDoc);
    expect(proj.data.map((d) => d.id)).not.toContain(aptDoc);
    expect(proj.data.map((d) => d.id)).not.toContain(orgDoc);

    const apt = await svc.searchDocuments(managerA(), { q: s, limit: 100, scope: 'apartment' });
    expect(apt.data.map((d) => d.id)).toContain(aptDoc);
    expect(apt.data.map((d) => d.id)).not.toContain(projDoc);

    const org = await svc.searchDocuments(managerA(), { q: s, limit: 100, scope: 'org' });
    expect(org.data.map((d) => d.id)).toContain(orgDoc);
    expect(org.data.map((d) => d.id)).not.toContain(projDoc);
  });

  it('archived docs excluded by default, included with archived=true', async () => {
    const projId = orgA.projects[0]!.id;
    const name = `Arch ${TAG}-${randomUUID().slice(0, 6)}`;
    const archId = await seedDoc(orgA.id, name, { projectId: projId, archived: true });

    const def = await svc.searchDocuments(managerA(), { q: name, limit: 100 });
    expect(def.data.map((d) => d.id)).not.toContain(archId);

    const inc = await svc.searchDocuments(managerA(), { q: name, limit: 100, archived: true });
    expect(inc.data.map((d) => d.id)).toContain(archId);
  });

  it('RLS isolation: org-A manager never finds org-B doc by name', async () => {
    const bName = `OrgBDoc ${TAG}`;
    const bId = await seedDoc(orgB.id, bName, { projectId: orgB.projects[0]!.id });
    const fromA = await svc.searchDocuments(managerA(), { q: 'orgbdoc', limit: 100 });
    expect(fromA.data.map((d) => d.id)).not.toContain(bId);
    const fromB = await svc.searchDocuments(managerB(), { q: 'orgbdoc', limit: 100 });
    expect(fromB.data.map((d) => d.id)).toContain(bId);
  });

  it('keyset cursor over ≥2 matches: page1(limit=1) has_more+cursor, page2 no dup', async () => {
    const projId = orgA.projects[0]!.id;
    const ks = `DKeyset ${TAG}-${randomUUID().slice(0, 6)}`;
    await seedDoc(orgA.id, `${ks} One`, { projectId: projId });
    await seedDoc(orgA.id, `${ks} Two`, { projectId: projId });
    const page1 = await svc.searchDocuments(managerA(), { q: ks, limit: 1 });
    expect(page1.data).toHaveLength(1);
    expect(page1.page.has_more).toBe(true);
    expect(page1.page.cursor).toBeTruthy();
    const page2 = await svc.searchDocuments(managerA(), { q: ks, limit: 1, cursor: page1.page.cursor! });
    expect(page2.data).toHaveLength(1);
    expect(page2.data[0]!.id).not.toBe(page1.data[0]!.id);
  });

  it('agent scope: sees only docs in assigned projects; org-level docs invisible', async () => {
    const assignedProj = orgA.projects[0]!.id;
    const unassignedProj = orgA.projects[1]!.id;
    const s = `AgentDoc ${TAG}-${randomUUID().slice(0, 6)}`;
    const assignedDoc = await seedDoc(orgA.id, `${s} assigned`, { projectId: assignedProj });
    const unassignedDoc = await seedDoc(orgA.id, `${s} unassigned`, { projectId: unassignedProj });
    const orgDoc = await seedDoc(orgA.id, `${s} orglevel`); // no parent
    await db
      .insert(projectAssignments)
      .values({ projectId: assignedProj, userId: agentAId, assignedBy: mgrAId });

    const res = await svc.searchDocuments(agentA(), { q: s, limit: 100 });
    const ids = res.data.map((d) => d.id);
    expect(ids).toContain(assignedDoc);
    expect(ids).not.toContain(unassignedDoc);
    expect(ids).not.toContain(orgDoc);
  });

  it('a q that matches nothing returns an empty page (not an error)', async () => {
    const res = await svc.searchDocuments(managerA(), {
      q: `definitely-no-such-doc-${randomUUID()}`,
      limit: 100,
    });
    expect(res.data).toHaveLength(0);
    expect(res.page.has_more).toBe(false);
    expect(res.page.cursor).toBeNull();
  });
});
