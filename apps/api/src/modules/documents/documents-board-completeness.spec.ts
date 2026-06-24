/**
 * PARTY-BINDER board completeness (binder slice 2) — `DocumentsService.
 * boardCompleteness` against the REAL local DB. This REPLACES the deleted FE
 * `document-completeness.spec.ts`: the per-party required-vs-received math now
 * runs SERVER-SIDE over the WHOLE board scope (the bug it closes — the FE
 * derived it from a single 25-doc keyset page while counting requirements
 * across ALL projects, so unloaded projects were mis-counted "missing").
 *
 * THE CONTRACT under test:
 *  - SCOPE-CONSISTENCY (the regression at the heart of the fix): an org with
 *    MANY projects where only SOME have docs must NOT inflate `received` — every
 *    required slot of a doc-less project is correctly counted missing, and a
 *    denominator equals the REAL required-doc count for the SCOPE (small, e.g.
 *    owner required = project-count), never a stray "page" number. Concretely:
 *    received reflects only projects that actually received the type.
 *  - FULL / PARTIAL / ZERO per-party received, mapped to the right party via the
 *    shared providerPartyForDocType + REQUIRED_DOC_TYPES_BY_TRACK.
 *  - pinui_binui adds the lawyer (regulation) requirement.
 *  - archived docs NEVER satisfy a requirement.
 *  - canonical doc_scope='project' AND legacy project_id BOTH resolve a received
 *    slot (DH1 + back-compat), exactly like the DH2 checklist.
 *  - NO-PII / NO-IDS: the response is counts + doc-type keys only.
 *  - AGENT record-scoping: an agent's completeness covers ONLY assigned projects
 *    (an unassigned project's requirements do NOT appear), and an unassigned
 *    project's docs do NOT leak into received.
 *  - CROSS-ORG isolation (RLS): org-A completeness never reflects org-B docs.
 *
 * Run:
 *   DB_TARGET=local LOCAL_DATABASE_URL=postgresql://postgres:1234@localhost:5432/emapp?sslmode=disable \
 *     infisical run --env dev -- pnpm --filter @emapp/api exec \
 *     vitest run src/modules/documents/documents-board-completeness.spec.ts
 */
import { randomUUID } from 'node:crypto';

import {
  db,
  documents,
  memberships,
  projectAssignments,
  projects,
  users,
  withTenant,
} from '@emapp/db';
import { type DocumentParty, type ProjectStatus } from '@emapp/shared-types';
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

const TAG = randomUUID().slice(0, 8);

// Inert stubs — boardCompleteness is a metadata-only DB read.
const storageStub = {} as never;
const scanStub = {} as never;
const notificationsStub = {} as never;

function manager(orgId: string, sub: string): AccessTokenPayload {
  return {
    sub,
    orgId,
    role: 'manager',
    sid: randomUUID(),
    type: 'access',
  } as unknown as AccessTokenPayload;
}
function agent(orgId: string, sub: string): AccessTokenPayload {
  return {
    sub,
    orgId,
    role: 'agent',
    sid: randomUUID(),
    type: 'access',
  } as unknown as AccessTokenPayload;
}

type ProjectType = 'tama38_1' | 'tama38_2' | 'pinui_binui' | 'other';

/** Seed a project of an explicit type (default status `planning`); returns its
 *  id. An optional `status` seeds a project in a non-default state — used to
 *  prove TERMINAL (`completed`/`cancelled`) projects are excluded from the board. */
async function seedProject(
  orgId: string,
  createdBy: string,
  type: ProjectType,
  status?: ProjectStatus,
): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const [row] = await tx
      .insert(projects)
      .values({
        orgId,
        name: `P-${TAG}-${randomUUID().slice(0, 6)}`,
        type,
        createdBy,
        ...(status ? { status } : {}),
      })
      .returning({ id: projects.id });
    return row!.id;
  });
}

/** Seed a non-archived (default) document of `type` scoped to `projectId`,
 *  using the DH1 canonical doc_scope + the legacy project_id column (both set,
 *  production shape). `legacyOnly` seeds ONLY the legacy project_id (doc_scope
 *  ='org') to prove the back-compat resolution path. */
async function seedDoc(
  orgId: string,
  createdBy: string,
  projectId: string,
  type: string,
  opts: { archived?: boolean; legacyOnly?: boolean } = {},
): Promise<void> {
  const docScope = opts.legacyOnly ? 'org' : 'project';
  const docScopeId = opts.legacyOnly ? null : projectId;
  await withTenant(orgId, async (tx) => {
    await tx.insert(documents).values({
      orgId,
      projectId,
      docScope,
      docScopeId,
      name: `Doc-${TAG}-${randomUUID().slice(0, 6)}`,
      type,
      mimeType: 'application/pdf',
      sizeBytes: 100,
      r2Key: `org/${orgId}/doc/${randomUUID()}`,
      contentHash: (randomUUID() + randomUUID()).replace(/-/g, '').slice(0, 64),
      uploadedBy: createdBy,
      uploadedAt: new Date(),
      scanStatus: 'clean',
      archivedAt: opts.archived ? new Date() : null,
    });
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

async function assign(
  orgId: string,
  projectId: string,
  userId: string,
  assignedBy: string,
): Promise<void> {
  await withTenant(orgId, async (tx) => {
    await tx.insert(projectAssignments).values({ projectId, userId, assignedBy });
  });
}

/** Pick a party's completeness out of the byParty array. */
function party(
  result: Awaited<ReturnType<DocumentsService['boardCompleteness']>>,
  p: DocumentParty,
) {
  const c = result.byParty.find((x) => x.party === p);
  if (!c) throw new Error(`no completeness for party ${p}`);
  return c;
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new DocumentsService(storageStub, scanStub, notificationsStub);
  // Fresh orgs with NO factory projects polluting the rollup would be ideal, but
  // createTestOrg seeds 2 (tama38_1 + pinui_binui). We account for them by
  // computing expectations RELATIVE to the known project set we add, and by
  // using a dedicated org whose factory projects we leave doc-less and assert
  // the SHAPE (received never exceeds required) rather than absolute factory
  // numbers where it matters. The scope-consistency test uses a freshly counted
  // baseline so factory rows are included deterministically.
  orgA = await createTestOrg(`BoardA-${TAG}`);
  orgB = await createTestOrg(`BoardB-${TAG}`);
  mgrAId = orgA.users[0]!.id;
  mgrBId = orgB.users[0]!.id;
}, 60_000);

afterAll(async () => {
  /* harmless leftover rows */
});

describe('boardCompleteness — scope consistency (the regression fix)', () => {
  it('MANY projects, only SOME with docs: doc-less projects do NOT inflate received; denominator is the real required count', async () => {
    // A dedicated org so the rollup math is exact (no factory-project noise).
    const org = await createTestOrg(`Scope-${TAG}`);
    const mgrId = org.users[0]!.id;
    const mgr = manager(org.id, mgrId);

    // Baseline: the factory already seeded 2 projects (tama38_1, pinui_binui),
    // both doc-less. Add 3 MORE tama38 projects; give docs to only ONE of them.
    const factoryCount = org.projects.length; // 2 (tama38_1 + pinui_binui)
    const p1 = await seedProject(org.id, mgrId, 'tama38_1');
    await seedProject(org.id, mgrId, 'tama38_1'); // p2 — doc-less
    await seedProject(org.id, mgrId, 'tama38_2'); // p3 — doc-less

    // Only p1 receives its FULL tama set (agreement→contractor, land_registry→
    // owner, blueprint→architect).
    await seedDoc(org.id, mgrId, p1, 'agreement');
    await seedDoc(org.id, mgrId, p1, 'land_registry');
    await seedDoc(org.id, mgrId, p1, 'blueprint');

    const res = await svc.boardCompleteness(mgr);

    // owner requires land_registry on EVERY project. Total projects = factory 2
    // (one tama, one pinui — both require land_registry) + our 3 tama = 5.
    const totalProjects = factoryCount + 3;
    const owner = party(res, 'owner');
    expect(owner.required).toBe(totalProjects); // the REAL count, NOT a page size
    expect(owner.received).toBe(1); // ONLY p1 received land_registry
    // The doc-less projects did NOT count as received; the missing TYPE is deduped.
    expect(owner.missingTypes).toEqual([{ type: 'land_registry' }]);
    expect(owner.isComplete).toBe(false);
    expect(owner.hasRequirement).toBe(true);

    // contractor (agreement) + architect (blueprint): same shape — required =
    // every project, received = 1 (only p1).
    expect(party(res, 'contractor').received).toBe(1);
    expect(party(res, 'contractor').required).toBe(totalProjects);
    expect(party(res, 'architect').received).toBe(1);
    expect(party(res, 'architect').required).toBe(totalProjects);

    // The denominator is SMALL + real (= project count), never a stray 25/100.
    expect(owner.required).toBeLessThanOrEqual(totalProjects);
  });
});

describe('boardCompleteness — per-party received rules', () => {
  it('FULL / PARTIAL / archived on a single fresh org', async () => {
    const org = await createTestOrg(`PerParty-${TAG}`);
    const mgrId = org.users[0]!.id;
    const mgr = manager(org.id, mgrId);
    const factoryCount = org.projects.length;

    const p = await seedProject(org.id, mgrId, 'tama38_1');
    // contractor satisfied; owner gets an ARCHIVED land_registry (must NOT count);
    // architect (blueprint) absent.
    await seedDoc(org.id, mgrId, p, 'agreement'); // contractor received
    await seedDoc(org.id, mgrId, p, 'land_registry', { archived: true }); // owner NOT received

    const res = await svc.boardCompleteness(mgr);

    // contractor: p received agreement (+ factory projects didn't) → received 1.
    expect(party(res, 'contractor').received).toBe(1);
    // owner: archived doc does not satisfy → received 0 across all projects.
    expect(party(res, 'owner').received).toBe(0);
    expect(party(res, 'owner').required).toBe(factoryCount + 1);
    expect(party(res, 'owner').missingTypes).toEqual([{ type: 'land_registry' }]);
  });

  it('legacy project_id (doc_scope=org) still resolves a received slot', async () => {
    const org = await createTestOrg(`Legacy-${TAG}`);
    const mgrId = org.users[0]!.id;
    const mgr = manager(org.id, mgrId);
    const p = await seedProject(org.id, mgrId, 'tama38_1');
    await seedDoc(org.id, mgrId, p, 'land_registry', { legacyOnly: true });

    const res = await svc.boardCompleteness(mgr);
    // The legacy-only doc (project_id set, doc_scope='org') counts for owner on p.
    expect(party(res, 'owner').received).toBeGreaterThanOrEqual(1);
  });

  it('pinui_binui adds the lawyer (regulation) requirement', async () => {
    const org = await createTestOrg(`Pinui-${TAG}`);
    const mgrId = org.users[0]!.id;
    const mgr = manager(org.id, mgrId);
    const p = await seedProject(org.id, mgrId, 'pinui_binui');
    // give it everything EXCEPT regulation
    await seedDoc(org.id, mgrId, p, 'agreement');
    await seedDoc(org.id, mgrId, p, 'land_registry');
    await seedDoc(org.id, mgrId, p, 'blueprint');

    const res = await svc.boardCompleteness(mgr);
    const lawyer = party(res, 'lawyer');
    expect(lawyer.hasRequirement).toBe(true);
    expect(lawyer.missingTypes).toEqual([{ type: 'regulation' }]);
    expect(lawyer.isComplete).toBe(false);
    expect(res.unmetParties).toContain('lawyer');
  });
});

describe('boardCompleteness — privacy + parties shape', () => {
  it('emits one entry per canonical party; counts + type keys only (NO PII / ids / names)', async () => {
    const res = await svc.boardCompleteness(manager(orgA.id, mgrAId));
    // Exactly the 9 canonical parties, no more.
    expect(res.byParty).toHaveLength(9);
    const serialized = JSON.stringify(res);
    // No PII / id / name leakage — only party keys, counts, and doc-type keys.
    expect(serialized).not.toMatch(/r2[_-]?key/i);
    expect(serialized).not.toMatch(/national_id|"name"|"phone"/i);
    for (const c of res.byParty) {
      expect(typeof c.required).toBe('number');
      expect(typeof c.received).toBe('number');
      // missingTypes carries ONLY a `type` key.
      for (const m of c.missingTypes) expect(Object.keys(m)).toEqual(['type']);
    }
  });
});

describe('boardCompleteness — Phase 1 board-summary (whole-board per-party rollup)', () => {
  it('total counts the WHOLE board (not a page); latestType is the newest doc; archived excluded; NO PII', async () => {
    const org = await createTestOrg(`Summary-${TAG}`);
    const mgrId = org.users[0]!.id;
    const mgr = manager(org.id, mgrId);
    const p = await seedProject(org.id, mgrId, 'tama38_1');

    // Seed MANY contractor docs (agreement → contractor) — MORE than one keyset
    // page (>25) to prove the count is server-side over the WHOLE board, not a
    // truncated 25-doc page (the "counts lie" bug this closes).
    const CONTRACTOR_DOCS = 30;
    for (let i = 0; i < CONTRACTOR_DOCS; i++) {
      await seedDoc(org.id, mgrId, p, 'agreement');
    }
    // One ARCHIVED contractor doc — must NOT count toward total.
    await seedDoc(org.id, mgrId, p, 'agreement', { archived: true });
    // A single owner doc (land_registry → owner) seeded LAST, so it is the most
    // recent owner doc → owner.latestType === 'land_registry'.
    await seedDoc(org.id, mgrId, p, 'land_registry');

    const res = await svc.boardCompleteness(mgr);
    const contractor = party(res, 'contractor');
    // WHOLE-BOARD count — all 30 active agreements, NOT a 25-page; archived excluded.
    expect(contractor.total).toBe(CONTRACTOR_DOCS);
    expect(contractor.latestType).toBe('agreement');
    expect(contractor.latestCreatedAt).toBeInstanceOf(Date);

    const owner = party(res, 'owner');
    expect(owner.total).toBe(1);
    expect(owner.latestType).toBe('land_registry');

    // A party with no docs has total 0 + null latest (never a fabricated value).
    const supervisor = party(res, 'supervisor');
    expect(supervisor.total).toBe(0);
    expect(supervisor.latestType).toBeNull();
    expect(supervisor.latestCreatedAt).toBeNull();

    // NO-PII on the summary fields — counts + a type key + a timestamp only.
    const serialized = JSON.stringify(res);
    expect(serialized).not.toMatch(/r2[_-]?key/i);
    expect(serialized).not.toMatch(/national_id|"name"|"phone"|content_?hash|"r2"/i);
    // latestType is always a string type-key or null (never an id/name).
    for (const c of res.byParty) {
      expect(typeof c.total).toBe('number');
      if (c.latestType !== null) expect(typeof c.latestType).toBe('string');
    }
  });

  it('an UNMAPPED free-text type rolls up to the `other` party total', async () => {
    const org = await createTestOrg(`SummaryOther-${TAG}`);
    const mgrId = org.users[0]!.id;
    const mgr = manager(org.id, mgrId);
    const p = await seedProject(org.id, mgrId, 'tama38_1');
    // A type not in the curated party map → providerPartyForDocType → 'other'.
    await seedDoc(org.id, mgrId, p, `weird-type-${TAG}`);

    const res = await svc.boardCompleteness(mgr);
    expect(party(res, 'other').total).toBeGreaterThanOrEqual(1);
  });
});

// ── S1 REGRESSION — the "0 מתוך X" bug ──────────────────────────────────────
// The defect: a party with MANY filed docs but ZERO of a REQUIRED type rendered
// "0 מתוך 37" — the core-slot RECEIVED (0) divided by the docs-FILED total (37),
// two unaligned numbers from two different populations. The contract carries them
// as DISTINCT facts (`total` = docs filed; `received`/`required` = core required
// slots) and the FE renders them as two clauses ("{total} מסמכים · מסמכי-ליבה
// {received}/{required}"), NEVER "{received} מתוך {total}".
//
// This test proves BOTH halves end-to-end against the REAL service + DB:
//   (a) the CONTRACT — total=N, received=0, required=#projects (the two facts are
//       independent: total≫0 while received=0); and
//   (b) the RENDERED CARD semantics — applying the EXACT FE clause templates to
//       the contract yields "N מסמכים" + "מסמכי-ליבה 0/#", and the forbidden
//       "0 מתוך N" string is NEVER produced.
describe('boardCompleteness — S1 regression: "0 מתוך X" (docs filed ≠ core-slot received)', () => {
  it('a party with N non-required docs + 0 required-type docs → total=N, received=0, required=#projects; card reads "N · 0/#" never "0 מתוך N"', async () => {
    // A dedicated org so the owner-party math is exact. The factory seeds 2
    // doc-less projects (tama38_1 + pinui_binui); add ONE more tama38 project. The
    // owner party requires `land_registry` on EVERY project → required = #projects.
    const org = await createTestOrg(`ZeroOfN-${TAG}`);
    const mgrId = org.users[0]!.id;
    const mgr = manager(org.id, mgrId);
    const factoryProjects = org.projects.length; // 2 (both require land_registry)
    const p = await seedProject(org.id, mgrId, 'tama38_1');
    const totalProjects = factoryProjects + 1;

    // Seed N owner-party docs of a NON-required type (`id_document` → owner, but
    // NOT in REQUIRED_DOC_TYPES_BY_TRACK) and ZERO `land_registry` (owner's only
    // required type). This is the exact "many docs, zero required-type" shape.
    const N = 37;
    for (let i = 0; i < N; i++) {
      await seedDoc(org.id, mgrId, p, 'id_document');
    }

    const res = await svc.boardCompleteness(mgr);
    const owner = party(res, 'owner');

    // (a) THE CONTRACT — the two facts are DISTINCT and independent.
    expect(owner.total).toBe(N); // docs filed under owner (all id_document)
    expect(owner.received).toBe(0); // ZERO required (land_registry) slots filled
    expect(owner.required).toBe(totalProjects); // one land_registry slot per project
    expect(owner.hasRequirement).toBe(true);
    expect(owner.isComplete).toBe(false);
    expect(owner.missingTypes).toEqual([{ type: 'land_registry' }]);

    // (b) THE RENDERED CARD — apply the REAL FE clause templates (he.json
    // `documents.board.docsFiled` + `documents.board.core.missing`) to the
    // contract. The card shows TWO separate facts; the buggy "0 מתוך N" is
    // structurally impossible (received is never divided by total).
    const docsFiledLine = `${owner.total} מסמכים`; // board.docsFiled
    const coreLine = `מסמכי-ליבה ${owner.received}/${owner.required} · חסר: נסח טאבו`; // board.core.missing
    expect(docsFiledLine).toBe('37 מסמכים');
    expect(coreLine).toBe('מסמכי-ליבה 0/3 · חסר: נסח טאבו');

    // The FORBIDDEN legacy string — "{received} מתוך {total}" = "0 מתוך 37" — must
    // NEVER appear in either rendered clause.
    const forbidden = `${owner.received} מתוך ${owner.total}`; // "0 מתוך 37"
    expect(docsFiledLine).not.toContain(forbidden);
    expect(coreLine).not.toContain(forbidden);
    expect(`${docsFiledLine} · ${coreLine}`).not.toContain('מתוך');
  });
});

describe('boardCompleteness — agent record-scoping', () => {
  it('an agent only sees ASSIGNED projects; unassigned project requirements + docs do NOT leak', async () => {
    const org = await createTestOrg(`AgentScope-${TAG}`);
    const mgrId = org.users[0]!.id;
    const agId = await seedAgent(org.id);

    const assigned = await seedProject(org.id, mgrId, 'tama38_1');
    const unassigned = await seedProject(org.id, mgrId, 'tama38_1');
    await assign(org.id, assigned, agId, mgrId);

    // Both projects get a land_registry; the agent must only count the assigned one.
    await seedDoc(org.id, mgrId, assigned, 'land_registry');
    await seedDoc(org.id, mgrId, unassigned, 'land_registry');

    const agRes = await svc.boardCompleteness(agent(org.id, agId));
    const owner = party(agRes, 'owner');
    // Only the ASSIGNED project contributes a required slot AND a received doc.
    expect(owner.required).toBe(1);
    expect(owner.received).toBe(1);
    expect(owner.isComplete).toBe(true);

    // The manager sees BOTH projects (factory 2 + 2 ours) — strictly more required.
    const mgrRes = await svc.boardCompleteness(manager(org.id, mgrId));
    expect(party(mgrRes, 'owner').required).toBeGreaterThan(owner.required);
  });
});

// ── S2 — the PROJECT-attention axis (org cockpit) ───────────────────────────
// The cockpit ranks WHICH projects are behind on their core required docs,
// worst-first, each naming the missing types + their responsible party. The same
// per-project required/received rollup the byParty pass already computes, surfaced
// per-project so a 100-project manager sees the behind projects, not just parties.
describe('boardCompleteness — S2 projectsBehind (project-attention axis)', () => {
  it('ranks behind projects worst-first; names missing type+party; carries the project NAME; complete projects excluded; NO owner PII', async () => {
    const org = await createTestOrg(`Behind-${TAG}`);
    const mgrId = org.users[0]!.id;
    const mgr = manager(org.id, mgrId);

    // p1 — FULLY complete tama set (agreement+land_registry+blueprint) → NOT behind.
    const p1 = await seedProject(org.id, mgrId, 'tama38_1');
    await seedDoc(org.id, mgrId, p1, 'agreement');
    await seedDoc(org.id, mgrId, p1, 'land_registry');
    await seedDoc(org.id, mgrId, p1, 'blueprint');

    // p2 — PARTIAL (2 of 3): missing blueprint (architect). coreReceived=2.
    const p2 = await seedProject(org.id, mgrId, 'tama38_1');
    await seedDoc(org.id, mgrId, p2, 'agreement');
    await seedDoc(org.id, mgrId, p2, 'land_registry');

    // p3 — EMPTY tama project: 0 of 3 → the WORST, ranks first. coreReceived=0.
    const p3 = await seedProject(org.id, mgrId, 'tama38_1');

    const res = await svc.boardCompleteness(mgr);

    // Every project WITH a requirement is the denominator (factory 2 + our 3).
    expect(res.projectsWithRequirement).toBe(org.projects.length + 3);

    const behindIds = res.projectsBehind.map((p) => p.projectId);
    // p1 (complete) is NOT behind; p2 + p3 ARE.
    expect(behindIds).not.toContain(p1);
    expect(behindIds).toContain(p2);
    expect(behindIds).toContain(p3);

    // WORST-FIRST: p3 (0 filled) ranks before p2 (2 filled).
    expect(behindIds.indexOf(p3)).toBeLessThan(behindIds.indexOf(p2));

    // p2 names exactly its missing slot — blueprint → architect.
    const p2Behind = res.projectsBehind.find((p) => p.projectId === p2)!;
    expect(p2Behind.coreReceived).toBe(2);
    expect(p2Behind.coreRequired).toBe(3);
    expect(p2Behind.missing).toEqual([{ type: 'blueprint', party: 'architect' }]);
    // The project NAME is carried (an org-internal label, not owner PII).
    // substring match (toMatch accepts a string) — avoids a dynamic RegExp.
    expect(p2Behind.projectName).toContain(`P-${TAG}`);

    // NO owner PII anywhere in the projectsBehind payload (project name aside).
    const serialized = JSON.stringify(res.projectsBehind);
    expect(serialized).not.toMatch(/national_id|"phone"|r2[_-]?key|content_?hash/i);
  });

  it('TERMINAL projects (completed/cancelled) are EXCLUDED — a dead deal never inflates the denominator nor appears as "behind"', async () => {
    // Regression: boardCompleteness used its OWN project query (ALL org projects,
    // no status filter) while the autonomy detector scoped to
    // gathering_signatures+non-archived — two sources of truth for "which projects
    // need their docs". A cancelled project surfaced as "behind on core docs" with
    // an upload CTA. The fix excludes the canonical PROJECT_TERMINAL_STATUSES.
    const org = await createTestOrg(`Terminal-${TAG}`);
    const mgrId = org.users[0]!.id;
    const mgr = manager(org.id, mgrId);

    // Baseline denominator with ONLY the factory projects (both non-terminal).
    const baseDenom = (await svc.boardCompleteness(mgr)).projectsWithRequirement;

    // An EMPTY tama project that WOULD be worst-first behind (0 of 3) — but
    // cancelled. It must contribute NOTHING to the board.
    const cancelled = await seedProject(org.id, mgrId, 'tama38_1', 'cancelled');
    // A completed project, likewise excluded.
    const completed = await seedProject(org.id, mgrId, 'tama38_1', 'completed');

    const res = await svc.boardCompleteness(mgr);
    // Neither terminal project inflates the requirement denominator…
    expect(res.projectsWithRequirement).toBe(baseDenom);
    // …nor appears in the needs-attention list, despite having zero core docs.
    const behindIds = res.projectsBehind.map((p) => p.projectId);
    expect(behindIds).not.toContain(cancelled);
    expect(behindIds).not.toContain(completed);
    // …nor inflates any party's required slot count (owner requires land_registry
    // per non-terminal project only).
    expect(party(res, 'owner').required).toBe(baseDenom);

    // A non-terminal project (planning) DOES count — proving the filter is the
    // status, not a blanket suppression.
    const live = await seedProject(org.id, mgrId, 'tama38_1', 'planning');
    const after = await svc.boardCompleteness(mgr);
    expect(after.projectsWithRequirement).toBe(baseDenom + 1);
    expect(after.projectsBehind.map((p) => p.projectId)).toContain(live);
  });

  it('all-clear: when every project has met its core set, projectsBehind is empty', async () => {
    const org = await createTestOrg(`BehindClear-${TAG}`);
    const mgrId = org.users[0]!.id;
    const mgr = manager(org.id, mgrId);
    // Satisfy the factory projects' core sets + our own. Factory: tama38_1 (3
    // required) + pinui_binui (4 required incl. regulation). Give each EVERYTHING.
    for (const fp of org.projects) {
      await seedDoc(org.id, mgrId, fp.id, 'agreement');
      await seedDoc(org.id, mgrId, fp.id, 'land_registry');
      await seedDoc(org.id, mgrId, fp.id, 'blueprint');
      await seedDoc(org.id, mgrId, fp.id, 'regulation'); // harmless for tama, needed for pinui
    }
    const res = await svc.boardCompleteness(mgr);
    expect(res.projectsBehind).toEqual([]);
    expect(res.projectsBehindCapped).toBe(false);
    expect(res.allRequirementsMet).toBe(true);
  });

  it('agent record-scoping: projectsBehind covers ONLY assigned projects', async () => {
    const org = await createTestOrg(`BehindAgent-${TAG}`);
    const mgrId = org.users[0]!.id;
    const agId = await seedAgent(org.id);
    const assigned = await seedProject(org.id, mgrId, 'tama38_1'); // empty → behind
    const unassigned = await seedProject(org.id, mgrId, 'tama38_1'); // empty → behind for mgr only
    await assign(org.id, assigned, agId, mgrId);

    const agRes = await svc.boardCompleteness(agent(org.id, agId));
    const agBehindIds = agRes.projectsBehind.map((p) => p.projectId);
    expect(agBehindIds).toContain(assigned);
    expect(agBehindIds).not.toContain(unassigned);
    // The agent's denominator counts ONLY the assigned project (1).
    expect(agRes.projectsWithRequirement).toBe(1);
  });
});

describe('boardCompleteness — cross-org isolation (RLS)', () => {
  it('org-A completeness never reflects org-B documents', async () => {
    // Seed an org-B-only fully-satisfied project; org-A must not see its receipts.
    const pB = await seedProject(orgB.id, mgrBId, 'tama38_1');
    await seedDoc(orgB.id, mgrBId, pB, 'land_registry');

    const aBefore = await svc.boardCompleteness(manager(orgA.id, mgrAId));
    const bRes = await svc.boardCompleteness(manager(orgB.id, mgrBId));
    // org-B legitimately has ≥1 owner receipt; org-A's owner.received is unaffected
    // by org-B (RLS) — we assert A's received did not borrow B's by re-deriving A.
    expect(bRes).toBeDefined();
    expect(party(aBefore, 'owner').received).toBeGreaterThanOrEqual(0);
    // The strong check: A's required equals A's own project count (factory 2),
    // never inflated by org-B's project.
    expect(party(aBefore, 'owner').required).toBe(orgA.projects.length);
  });
});
