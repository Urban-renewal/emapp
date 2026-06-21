/**
 * DH2 (V13) — INTEGRATION spec for the ADVISORY project document-CHECKLIST
 * endpoint (`GET /api/v1/projects/:id/document-checklist`). Real DB + RLS.
 *
 * Contract under test:
 *  - Per the project's renewal TRACK (derived from `projects.type`): the
 *    REQUIRED doc types, each auto-ticked present/missing by probing
 *    project-scoped `documents` rows of that `type` (DH1 doc_scope='project' +
 *    doc_scope_id OR legacy project_id), plus a completeness %.
 *  - ADVISORY ONLY: NEVER reads/writes project status; no writes at all.
 *  - RLS-scoped: cross-org id → no-oracle 404; unassigned agent → 404.
 *  - {data} envelope at the controller layer.
 *  - NO PII / NO document ids/names in the payload.
 *
 * Harness mirrors projects-signature-progress.spec.ts: createTestOrg(tag) seeds
 * org + manager + projects[0]=tama38_1, projects[1]=pinui_binui. Documents are
 * seeded via providerPool (BYPASSRLS) so ground-truth is org-context-independent.
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db, providerPool } from '../../../../../packages/db/src/client';
import { memberships, users } from '../../../../../packages/db/src/schema/tenancy';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

let svc: ProjectsService;
let controller: ProjectsController;
let org: TestOrg;
let otherOrg: TestOrg;
let managerId: string;

function manager(o: TestOrg = org): AccessTokenPayload {
  return {
    sub: o.users[0]!.id,
    orgId: o.id,
    role: 'manager',
    sid: '00000000-0000-4000-8000-0000000000e1',
    type: 'access',
  } as unknown as AccessTokenPayload;
}

function agentFor(agentId: string): AccessTokenPayload {
  return {
    sub: agentId,
    orgId: org.id,
    role: 'agent',
    sid: '00000000-0000-4000-8000-0000000000e2',
    type: 'access',
  } as unknown as AccessTokenPayload;
}

/** Seed a NON-archived document of `type` scoped to a project. `scope` chooses
 *  the DH1 canonical scope columns (doc_scope='project' + doc_scope_id) vs the
 *  legacy `project_id` column — the checklist must auto-tick on EITHER. */
async function seedDoc(
  orgId: string,
  projectId: string,
  type: string,
  scope: 'dh1' | 'legacy',
): Promise<void> {
  const c = await providerPool.connect();
  try {
    if (scope === 'dh1') {
      await c.query(
        `INSERT INTO documents
           (org_id, name, type, mime_type, size_bytes, r2_key, content_hash, uploaded_by,
            uploaded_at, doc_scope, doc_scope_id)
         VALUES ($1, $2, $3, 'application/pdf', 100, $4, 'h', $5, now(), 'project', $6)`,
        [orgId, `${type}.pdf`, type, `org/${orgId}/doc/${randomUUID()}`, managerId, projectId],
      );
    } else {
      await c.query(
        `INSERT INTO documents
           (org_id, project_id, name, type, mime_type, size_bytes, r2_key, content_hash,
            uploaded_by, uploaded_at)
         VALUES ($1, $2, $3, $4, 'application/pdf', 100, $5, 'h', $6, now())`,
        [orgId, projectId, `${type}.pdf`, type, `org/${orgId}/doc/${randomUUID()}`, managerId],
      );
    }
  } finally {
    c.release();
  }
}

/** Seed an ARCHIVED doc (must NOT count) of `type` scoped to the project. */
async function seedArchivedDoc(orgId: string, projectId: string, type: string): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `INSERT INTO documents
         (org_id, project_id, name, type, mime_type, size_bytes, r2_key, content_hash,
          uploaded_by, uploaded_at, archived_at)
       VALUES ($1, $2, $3, $4, 'application/pdf', 100, $5, 'h', $6, now(), now())`,
      [orgId, projectId, `${type}.pdf`, type, `org/${orgId}/doc/${randomUUID()}`, managerId],
    );
  } finally {
    c.release();
  }
}

async function readProjectStatus(projectId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ status: string }>(`SELECT status FROM projects WHERE id = $1`, [
      projectId,
    ]);
    return r.rows[0]!.status;
  } finally {
    c.release();
  }
}

async function seedAgentUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `agent-${randomUUID()}@test.local`,
      name: 'Agent',
      passwordHash: '$2b$12$placeholder',
    })
    .returning({ id: users.id });
  await db
    .insert(memberships)
    .values({ userId: u!.id, orgId: org.id, role: 'agent', acceptedAt: new Date() });
  return u!.id;
}

async function assignAgent(projectId: string, agentId: string): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `INSERT INTO project_assignments (project_id, user_id, assigned_by) VALUES ($1, $2, $3)`,
      [projectId, agentId, managerId],
    );
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new ProjectsService();
  controller = new ProjectsController(svc);
  const tag = `doc-checklist-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  otherOrg = await createTestOrg(`${tag}-other`, `${tag}-other`);
  managerId = org.users[0]!.id;
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('document-checklist — track-derived required set', () => {
  it('tama38 project (projects[0]) lists the 3 tama38 required types, all missing initially', async () => {
    const projectId = org.projects[0]!.id; // tama38_1
    const result = await svc.documentChecklist(manager(), projectId);

    expect(result.projectId).toBe(projectId);
    expect(result.track).toBe('tama38');
    expect(result.advisory).toBe(true);
    expect(result.totalCount).toBe(3);
    expect(result.items.map((i) => i.type).sort()).toEqual(
      ['agreement', 'blueprint', 'land_registry'].sort(),
    );
    // No docs seeded yet → all missing, 0%.
    expect(result.items.every((i) => i.present === false)).toBe(true);
    expect(result.presentCount).toBe(0);
    expect(result.completionPct).toBe(0);
  }, 30_000);

  it('pinui_binui project (projects[1]) additionally requires regulation (4 types)', async () => {
    const projectId = org.projects[1]!.id; // pinui_binui
    const result = await svc.documentChecklist(manager(), projectId);

    expect(result.track).toBe('pinui_binui');
    expect(result.totalCount).toBe(4);
    expect(result.items.map((i) => i.type)).toContain('regulation');
  }, 30_000);
});

describe('document-checklist — auto-tick present/missing + completeness', () => {
  it('auto-ticks present for both DH1-scoped and legacy-project_id docs; archived + wrong-type ignored', async () => {
    // Use the pinui project so we can independently exercise all 4 types.
    const projectId = org.projects[1]!.id;

    // agreement via DH1 doc_scope; blueprint via legacy project_id → both present.
    await seedDoc(org.id, projectId, 'agreement', 'dh1');
    await seedDoc(org.id, projectId, 'blueprint', 'legacy');
    // land_registry exists but is ARCHIVED → must NOT count as present.
    await seedArchivedDoc(org.id, projectId, 'land_registry');
    // a non-required type present → must not change counts.
    await seedDoc(org.id, projectId, 'permit', 'dh1');

    const result = await svc.documentChecklist(manager(), projectId);

    const byType = Object.fromEntries(result.items.map((i) => [i.type, i.present]));
    expect(byType.agreement).toBe(true);
    expect(byType.blueprint).toBe(true);
    expect(byType.land_registry).toBe(false); // archived → missing
    expect(byType.regulation).toBe(false); // never seeded
    expect(result.presentCount).toBe(2);
    expect(result.totalCount).toBe(4);
    expect(result.completionPct).toBe(50); // 2/4
  }, 30_000);

  it('reaches 100% when every required type has a project-scoped non-archived doc', async () => {
    const projectId = org.projects[0]!.id; // tama38 → 3 types
    await seedDoc(org.id, projectId, 'agreement', 'dh1');
    await seedDoc(org.id, projectId, 'land_registry', 'legacy');
    await seedDoc(org.id, projectId, 'blueprint', 'dh1');

    const result = await svc.documentChecklist(manager(), projectId);
    expect(result.presentCount).toBe(3);
    expect(result.completionPct).toBe(100);
    expect(result.items.every((i) => i.present)).toBe(true);
  }, 30_000);
});

describe('document-checklist — ADVISORY (no writes, no status change)', () => {
  it('does NOT mutate project status even at 0% completeness', async () => {
    const projectId = org.projects[1]!.id;
    const before = await readProjectStatus(projectId);
    await svc.documentChecklist(manager(), projectId);
    await svc.documentChecklist(manager(), projectId); // idempotent reads
    const after = await readProjectStatus(projectId);
    expect(after).toBe(before);
  }, 30_000);
});

describe('document-checklist — RLS scoping (no-oracle 404)', () => {
  it('a project in another org → 404 (cross-org docs never leak)', async () => {
    const foreignProjectId = otherOrg.projects[0]!.id;
    await expect(svc.documentChecklist(manager(), foreignProjectId)).rejects.toMatchObject({
      response: { error: { code: 'not_found' } },
    });
  }, 30_000);

  it('an unassigned agent → 404; an assigned agent gets the checklist', async () => {
    const projectId = org.projects[0]!.id;
    const agentId = await seedAgentUser();

    await expect(svc.documentChecklist(agentFor(agentId), projectId)).rejects.toMatchObject({
      response: { error: { code: 'not_found' } },
    });

    await assignAgent(projectId, agentId);
    const result = await svc.documentChecklist(agentFor(agentId), projectId);
    expect(result.projectId).toBe(projectId);
    expect(result.track).toBe('tama38');
  }, 30_000);

  it('a foreign-org doc with the SAME type does not tick a project in my org', async () => {
    // Seed a doc in otherOrg scoped to otherOrg's project; my-org checklist for a
    // DIFFERENT project must be unaffected (RLS + per-project filter).
    const foreignProject = otherOrg.projects[1]!.id;
    await seedDoc(otherOrg.id, foreignProject, 'regulation', 'dh1');

    // A fresh pinui project in MY org (projects[1] already has docs from earlier
    // tests for 'regulation'? no — regulation was never seeded for org). Assert
    // regulation is still missing for my pinui project.
    const myPinui = org.projects[1]!.id;
    const result = await svc.documentChecklist(manager(), myPinui);
    const regulation = result.items.find((i) => i.type === 'regulation');
    expect(regulation?.present).toBe(false);
  }, 30_000);
});

describe('document-checklist — controller {data} envelope', () => {
  it('wraps the checklist under { data } and exposes NO PII / doc ids', async () => {
    const projectId = org.projects[0]!.id;
    const res = await controller.documentChecklist(manager(), projectId);

    expect(res).toHaveProperty('data');
    expect(res.data.projectId).toBe(projectId);
    expect(res.data.advisory).toBe(true);

    // The serialized payload must contain only type keys + booleans + counts —
    // never an owner field, national_id, phone, or a document id/name/r2_key.
    const json = JSON.stringify(res.data);
    expect(json).not.toMatch(/national_id|nationalId|phone|r2_?key|uploadedBy|documentId/i);
    for (const item of res.data.items) {
      expect(Object.keys(item).sort()).toEqual(['present', 'type']);
    }
  }, 30_000);
});
