/**
 * TABU EXTRACTIONS — Slice 7a acceptance tests (TEST-AUTHOR, independent, RED-first).
 *
 * SPEC (V12 Phase-5, slice 7a — the extraction ENVELOPE + lifecycle ONLY; NO
 * parse, NO owner/share PII rows, NO commit — those are 7b/7c):
 *
 *   A new table `tabu_extractions` (migration 0068):
 *     id (uuid pk), org_id (uuid, RLS), apartment_id (uuid → apartments),
 *     source_document_id (uuid → documents), status text DEFAULT 'draft'
 *     CHECK in ('draft','confirmed','discarded'), created_by (uuid),
 *     created_at timestamptz DEFAULT now(), confirmed_at timestamptz NULL.
 *     FORCE ROW LEVEL SECURITY + an org_id policy.
 *
 *   API:
 *     POST /api/v1/apartments/:id/tabu-extractions  body { documentId }
 *       → validates the document is FINALIZED (uploaded_at NOT NULL AND
 *         scan_status = 'clean') AND apartment-scoped to THIS apartment
 *         (documents.apartment_id === :id) → creates a 'draft' extraction →
 *         { data: extraction }. Rejects: non-finalized doc, a doc not on this
 *         apartment, a foreign-org apartment/doc (no-oracle 404). withTenant
 *         org-scoped. Agent-reachable WRITE → the named service method MUST
 *         call requireAgentCapability(tx, user, 'edit_project_data') (D.54).
 *     GET  /api/v1/apartments/:id/tabu-extractions  (list for the apartment)
 *     GET  /api/v1/tabu-extractions/:id             (one)  → { data }.
 *     Cross-org → 404.
 *
 * LAYER + RED MODEL (honest):
 *   This file mirrors the real-DB, in-process service harness of
 *   `documents-capability.spec.ts` (createTestOrg + a manager AccessTokenPayload
 *   + the service exercised directly) and the raw-SQL seeding/RLS style of
 *   `packages/db/test/discovery-records.spec.ts`.
 *
 *   The builder has not yet created the `TabuExtractionsService`, so it is
 *   imported DYNAMICALLY (a guarded `loadService()` helper) — this file COMPILES
 *   today and each test fails at RUNTIME with a clear, per-test message:
 *     - the schema/RLS tests fail with 42P01 undefined_table (`tabu_extractions`
 *       missing), exactly like discovery-records.spec did pre-build;
 *     - the behavior tests fail because `loadService()` can't resolve the module
 *       / method yet.
 *   They go GREEN once the builder lands migration 0068 + the table + RLS + the
 *   `TabuExtractionsService` (create/list/getOne) + the controller routes.
 *
 *   The EXPECTED service shape the builder must provide (so these go green):
 *     class TabuExtractionsService {
 *       create(user, apartmentId, { documentId }): Promise<TabuExtraction>  // named method MUST call requireAgentCapability(tx,user,'edit_project_data')
 *       list(user, apartmentId, query?): Promise<{ data: TabuExtraction[]; ... }>
 *       getOne(user, id): Promise<TabuExtraction>
 *     }
 *   exported from apps/api/src/modules/tabu/tabu-extractions.service.ts.
 *   (If the builder names create/list/getOne differently, adjust the
 *   `METHOD_*` constants below — the behavior asserted is what matters.)
 *
 * DO NOT modify any implementation/schema/migration file to make these pass —
 * that is the builder's job. This file only asserts the target behavior.
 *
 * Run:
 *   infisical run --env=dev -- pnpm --filter @emapp/api exec \
 *     vitest run src/modules/tabu/tabu-extractions.spec.ts
 */
import { randomUUID } from 'node:crypto';

import { db, memberships, projectAssignments, users } from '@emapp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

// ── Expected service location + method names (adjust if the builder differs) ──
const SERVICE_MODULE = './tabu-extractions.service';
const SERVICE_CLASS = 'TabuExtractionsService';
const METHOD_CREATE = 'create';
const METHOD_LIST = 'list';
const METHOD_GET_ONE = 'getOne';

// A minimal service surface — enough to TYPE the dynamic import without naming a
// type that doesn't exist yet. The runtime guard (loadService) does the real
// shape-checking and produces the clean RED.
interface TabuExtractionLike {
  id: string;
  status: string;
  apartmentId?: string;
  apartment_id?: string;
  sourceDocumentId?: string;
  source_document_id?: string;
  confirmedAt?: string | Date | null;
}
interface TabuServiceLike {
  [METHOD_CREATE]: (
    user: AccessTokenPayload,
    apartmentId: string,
    input: { documentId: string },
  ) => Promise<TabuExtractionLike>;
  [METHOD_LIST]: (
    user: AccessTokenPayload,
    apartmentId: string,
    query?: unknown,
  ) => Promise<{ data: TabuExtractionLike[] } & Record<string, unknown>>;
  [METHOD_GET_ONE]: (user: AccessTokenPayload, id: string) => Promise<TabuExtractionLike>;
}

let org: TestOrg;
let otherOrg: TestOrg;
let managerId: string;
let agentId: string;
let projectId: string;

const MGR_SID = '00000000-0000-4000-8000-0000000000e1';
const AGENT_SID = '00000000-0000-4000-8000-0000000000e2';

function manager(o: TestOrg = org): AccessTokenPayload {
  return {
    sub: o === org ? managerId : o.users[0]!.id,
    orgId: o.id,
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

/**
 * Dynamically resolve the (not-yet-built) TabuExtractionsService. Today this
 * THROWS (module/class missing) — the test that calls it fails with a clear,
 * actionable message instead of a whole-file compile error. After the builder
 * lands the service, it returns a live instance.
 */
async function loadService(): Promise<TabuServiceLike> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(SERVICE_MODULE)) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `[RED] ${SERVICE_MODULE} not found yet — builder must create ` +
        `${SERVICE_CLASS} (create/list/getOne). Cause: ${e instanceof Error ? e.message : e}`,
    );
  }
  const Ctor = mod[SERVICE_CLASS] as (new (...args: unknown[]) => TabuServiceLike) | undefined;
  if (typeof Ctor !== 'function') {
    throw new Error(`[RED] ${SERVICE_CLASS} not exported from ${SERVICE_MODULE} yet.`);
  }
  // The builder's service takes no constructor deps in 7a (envelope only — no
  // storage/scan/notification needed). If it grows deps, this instantiation is
  // the single place to wire fakes.
  const instance = new Ctor();
  const probe = instance as unknown as Record<string, unknown>;
  for (const m of [METHOD_CREATE, METHOD_LIST, METHOD_GET_ONE]) {
    if (typeof probe[m] !== 'function') {
      throw new Error(`[RED] ${SERVICE_CLASS}.${m}() missing — builder must add it.`);
    }
  }
  return instance;
}

// ── raw-SQL seeders (providerPool = BYPASSRLS), discovery-records.spec style ──

async function seedAgentMembership(orgId: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `tabu-agent-${randomUUID()}@test.local`,
      name: 'Tabu Agent',
      passwordHash: '$2b$12$placeholder',
    })
    .returning({ id: users.id });
  await db
    .insert(memberships)
    .values({ userId: u!.id, orgId, role: 'agent', acceptedAt: new Date() });
  return u!.id;
}

/** A fresh building + apartment under `pid`. Returns the apartment id. */
async function seedApartment(pid: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const b = await c.query<{ id: string }>(
      `INSERT INTO buildings (project_id, address, city)
       VALUES ($1, $2, 'Tel Aviv') RETURNING id`,
      [pid, `Tabu ${Date.now()}-${Math.random()}`],
    );
    const a = await c.query<{ id: string }>(
      `INSERT INTO apartments (building_id, number)
       VALUES ($1, $2) RETURNING id`,
      [b.rows[0]!.id, `T-${Date.now()}-${Math.random()}`],
    );
    return a.rows[0]!.id;
  } finally {
    c.release();
  }
}

/**
 * Seed a document on `apartmentId`.
 *   finalized=true  → uploaded_at = now() AND scan_status = 'clean'  (servable
 *                     "finalized" — what create-extraction REQUIRES).
 *   finalized=false → uploaded_at NULL AND scan_status = 'pending'   (a ghost /
 *                     not-yet-finalized doc — create-extraction must REJECT).
 */
async function seedDocument(
  ownerOrgId: string,
  uploaderId: string,
  apartmentId: string | null,
  finalized: boolean,
): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO documents
         (org_id, apartment_id, name, type, mime_type, size_bytes, r2_key,
          content_hash, uploaded_by, uploaded_at, scan_status)
       VALUES ($1, $2, 'nesach.pdf', 'other', 'application/pdf', 100, $3, 'h',
               $4, $5, $6)
       RETURNING id`,
      [
        ownerOrgId,
        apartmentId,
        `org/${ownerOrgId}/doc/${randomUUID()}`,
        uploaderId,
        finalized ? new Date().toISOString() : null,
        finalized ? 'clean' : 'pending',
      ],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

async function setAgentCap(on: boolean): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE memberships SET capabilities = jsonb_set(capabilities, '{edit_project_data}', $1::jsonb)
       WHERE user_id = $2 AND org_id = $3 AND revoked_at IS NULL`,
      [on ? 'true' : 'false', agentId, org.id],
    );
  } finally {
    c.release();
  }
}

/** Did the create actually persist a tabu_extractions row for the apartment? */
async function extractionCountForApartment(apartmentId: string): Promise<number> {
  const c = await providerPool.connect();
  try {
    const r = await c
      .query<{ n: string }>(
        `SELECT count(*)::text AS n FROM tabu_extractions WHERE apartment_id = $1`,
        [apartmentId],
      )
      // Table missing pre-build → treat as "table not there" (a -1 sentinel the
      // assertions never expect, so the test fails loudly with the real cause).
      .catch((e: unknown) => {
        throw e;
      });
    return Number(r.rows[0]!.n);
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  const tag = `s7a-tabu-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  otherOrg = await createTestOrg(`${tag}-b`, `${tag}-b`);
  managerId = org.users[0]!.id;
  projectId = org.projects[0]!.id;
  agentId = await seedAgentMembership(org.id);
  await db.insert(projectAssignments).values({ projectId, userId: agentId, assignedBy: managerId });
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

// ───────────────────────────────────────────────────────────────────────────
// 1) create-extraction happy path
// ───────────────────────────────────────────────────────────────────────────
describe('tabu-extractions · create (envelope + draft lifecycle)', () => {
  it('1) create with a finalized apartment-scoped doc → draft extraction (status=draft, apartment+source set)', async () => {
    const svc = await loadService();
    const aptId = await seedApartment(projectId);
    const docId = await seedDocument(org.id, managerId, aptId, true);

    const created = await svc.create(manager(), aptId, { documentId: docId });

    expect(created.status).toBe('draft');
    expect(created.apartmentId ?? created.apartment_id).toBe(aptId);
    expect(created.sourceDocumentId ?? created.source_document_id).toBe(docId);
    // confirmed_at is NULL on a fresh draft.
    expect(created.confirmedAt ?? null).toBeNull();

    // It actually persisted a row on the apartment.
    expect(await extractionCountForApartment(aptId)).toBe(1);
  }, 30_000);

  // ─────────────────────────────────────────────────────────────────────────
  // 2) reject a NON-finalized doc
  // ─────────────────────────────────────────────────────────────────────────
  it('2) reject a non-finalized doc (uploaded_at NULL / scan not clean) → 4xx, NO extraction created', async () => {
    const svc = await loadService();
    const aptId = await seedApartment(projectId);
    const ghostDocId = await seedDocument(org.id, managerId, aptId, false);

    await expect(svc.create(manager(), aptId, { documentId: ghostDocId })).rejects.toBeTruthy();
    // Nothing was persisted for this apartment.
    expect(await extractionCountForApartment(aptId)).toBe(0);
  }, 30_000);

  // ─────────────────────────────────────────────────────────────────────────
  // 3) reject a doc that belongs to a DIFFERENT apartment
  // ─────────────────────────────────────────────────────────────────────────
  it('3) reject a finalized doc that belongs to a different apartment → 4xx/404, NO extraction created', async () => {
    const svc = await loadService();
    const aptA = await seedApartment(projectId);
    const aptB = await seedApartment(projectId);
    // A finalized doc scoped to aptB, but we try to extract under aptA.
    const docOnB = await seedDocument(org.id, managerId, aptB, true);

    await expect(svc.create(manager(), aptA, { documentId: docOnB })).rejects.toBeTruthy();
    expect(await extractionCountForApartment(aptA)).toBe(0);
  }, 30_000);

  // ─────────────────────────────────────────────────────────────────────────
  // 4) GET list + GET one return the created draft
  // ─────────────────────────────────────────────────────────────────────────
  it('4) GET list (for the apartment) + GET one return the created draft', async () => {
    const svc = await loadService();
    const aptId = await seedApartment(projectId);
    const docId = await seedDocument(org.id, managerId, aptId, true);
    const created = await svc.create(manager(), aptId, { documentId: docId });

    const listed = await svc.list(manager(), aptId);
    expect(Array.isArray(listed.data)).toBe(true);
    expect(listed.data.some((x) => x.id === created.id)).toBe(true);

    const one = await svc.getOne(manager(), created.id);
    expect(one.id).toBe(created.id);
    expect(one.status).toBe('draft');
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// 5) cross-org scope + capability gate
// ───────────────────────────────────────────────────────────────────────────
describe('tabu-extractions · isolation + capability', () => {
  it('5a) cross-org: another org cannot create an extraction on this org’s apartment → 404 (no oracle)', async () => {
    const svc = await loadService();
    const aptId = await seedApartment(projectId); // org A apartment
    const docId = await seedDocument(org.id, managerId, aptId, true);

    // Org B (foreign) tries to extract on org A's apartment+doc → 404, nothing created.
    await expect(svc.create(manager(otherOrg), aptId, { documentId: docId })).rejects.toBeTruthy();
    expect(await extractionCountForApartment(aptId)).toBe(0);
  }, 30_000);

  it('5b) cross-org GET one: a foreign org cannot read this org’s extraction → 404', async () => {
    const svc = await loadService();
    const aptId = await seedApartment(projectId);
    const docId = await seedDocument(org.id, managerId, aptId, true);
    const created = await svc.create(manager(), aptId, { documentId: docId });

    await expect(svc.getOne(manager(otherOrg), created.id)).rejects.toBeTruthy();
  }, 30_000);

  it('5c) capability gate: an assigned agent WITHOUT edit_project_data → 403 (D.54)', async () => {
    const svc = await loadService();
    const aptId = await seedApartment(projectId);
    const docId = await seedDocument(org.id, managerId, aptId, true);

    await setAgentCap(false);
    await expect(svc.create(agent(), aptId, { documentId: docId })).rejects.toBeTruthy();
    expect(await extractionCountForApartment(aptId)).toBe(0);

    // Sanity: with the capability ON, the SAME assigned agent succeeds.
    await setAgentCap(true);
    const ok = await svc.create(agent(), aptId, { documentId: docId });
    expect(ok.status).toBe('draft');
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// 6) SCHEMA + RLS (raw SQL, discovery-records.spec style — table-level RED)
// ───────────────────────────────────────────────────────────────────────────
describe('tabu_extractions · schema + RLS (migration 0068)', () => {
  it('6a) status CHECK is the closed set (draft|confirmed|discarded); DEFAULT draft', async () => {
    const aptId = await seedApartment(projectId);
    const docId = await seedDocument(org.id, managerId, aptId, true);
    const c = await providerPool.connect();
    try {
      // DEFAULT 'draft' when status omitted.
      const ins = await c.query<{ status: string; confirmed_at: string | null }>(
        `INSERT INTO tabu_extractions (org_id, apartment_id, source_document_id, created_by)
         VALUES ($1, $2, $3, $4) RETURNING status, confirmed_at`,
        [org.id, aptId, docId, managerId],
      );
      expect(ins.rows[0]!.status).toBe('draft');
      expect(ins.rows[0]!.confirmed_at).toBeNull();

      // An out-of-enum status is rejected by the CHECK (23514).
      const err = await c
        .query(
          `INSERT INTO tabu_extractions (org_id, apartment_id, source_document_id, status, created_by)
           VALUES ($1, $2, $3, 'definitely_not_a_status', $4)`,
          [org.id, aptId, docId, managerId],
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeTruthy();
      const code =
        (err as { cause?: { code?: string }; code?: string }).cause?.code ??
        (err as { code?: string }).code;
      expect(code).toBe('23514');
    } finally {
      c.release();
    }
  }, 30_000);

  it('6b) RLS isolates by org_id: a foreign org GUC sees ZERO; the owning org sees the row', async () => {
    const aptId = await seedApartment(projectId);
    const docId = await seedDocument(org.id, managerId, aptId, true);
    // Seed a row via BYPASSRLS so the RLS read below is the only gate under test.
    {
      const c0 = await providerPool.connect();
      try {
        await c0.query(
          `INSERT INTO tabu_extractions (org_id, apartment_id, source_document_id, created_by)
           VALUES ($1, $2, $3, $4)`,
          [org.id, aptId, docId, managerId],
        );
      } finally {
        c0.release();
      }
    }

    const c = await providerPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      // Foreign org GUC → zero rows.
      await c.query({
        text: 'SELECT set_config($1, $2, true)',
        values: ['app.organization_id', otherOrg.id],
      });
      const foreign = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM tabu_extractions WHERE apartment_id = $1`,
        [aptId],
      );
      expect(Number(foreign.rows[0]!.n)).toBe(0);

      // Owning org GUC → sees the row.
      await c.query({
        text: 'SELECT set_config($1, $2, true)',
        values: ['app.organization_id', org.id],
      });
      const own = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM tabu_extractions WHERE apartment_id = $1`,
        [aptId],
      );
      expect(Number(own.rows[0]!.n)).toBe(1);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 30_000);
});
