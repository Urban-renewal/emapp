/**
 * PARCEL SETUPS — P3a acceptance tests (TEST-AUTHOR, independent, RED-first).
 *
 * SPEC (docs/DESIGN-phase3-parcel-autosetup.md §1 goal, §4 entities, §6 P3a,
 * §7.1 decisions — the parcel-setup ENVELOPE + lifecycle + the MANUAL path →
 * physical skeleton; the IParcelDataProvider seam + Stub are P3b, NOT tested
 * here):
 *
 *   A new table `parcel_setups` (hand-authored migration, journal `when` MUST
 *   be > 1782918000000 — the 0072 max; see memory M-1 silent-skip):
 *     id uuid pk, org_id uuid (FORCE RLS, mirrors tabu_extractions 0068),
 *     project_id uuid → projects (§7.1-4: P3a attaches to an EXISTING project),
 *     block_number text, parcel_number text, sub_parcel text NULL,
 *     status text DEFAULT 'draft' CHECK in ('draft','confirmed','discarded'),
 *     payload jsonb NULL (the user's draft buildings/apartments — NO PII),
 *     source text DEFAULT 'manual', created_by uuid, created_at timestamptz
 *     DEFAULT now(), confirmed_at timestamptz NULL. + GRANTs to app_user.
 *   Provenance: buildings.source_parcel_setup_id uuid NULL REFERENCES
 *   parcel_setups(id) (mirror ownerships.source_extraction_id 0071);
 *   apartments inherit via their building — NO duplicate column.
 *
 *   API (all under /api/v1, D.10; {data} envelope, D.16):
 *     POST  /api/v1/projects/:projectId/parcel-setups
 *           body { blockNumber, parcelNumber, subParcel? } → 'draft' setup.
 *           Project visibility no-oracle 404 (foreign org / unknown). Agent =
 *           a WRITE → the NAMED service method MUST call
 *           requireAgentCapability(tx, user, 'edit_project_data') (D.54).
 *     GET   /api/v1/projects/:projectId/parcel-setups        (list, org-scoped)
 *     GET   /api/v1/parcel-setups/:id                        (one, org-scoped)
 *     PATCH /api/v1/parcel-setups/:id   body { payload } — save the draft
 *           buildings/apartments JSON. DRAFT-only (else 409). The payload is
 *           Zod-validated STRICT — shape:
 *             { buildings: [ { address, city?, number?, floorsCount?,
 *                 apartments: [ { number, floor? } ] } ] }
 *           NO PII keys (ownerName / nationalId / phone… → rejected).
 *     POST  /api/v1/parcel-setups/:id/confirm — idempotent SINGLE-CLAIM
 *           (UPDATE … WHERE status='draft'; no row claimed → 409), ATOMIC:
 *           creates the buildings (stamped source_parcel_setup_id) + their
 *           apartments under the project, audit-FIRST (ids+counts only —
 *           never addresses/PII), stamps status='confirmed' + confirmed_at.
 *           A mid-create unique-collision (apartments_building_number_active,
 *           migration 0002 / buildings_project_address_active, 0029) must
 *           roll the WHOLE confirm back with a clean 409/400 — no partial
 *           skeleton, no orphan audit row, setup stays 'draft'.
 *
 * LAYER + RED MODEL (honest — byte-for-byte the tabu-extractions.spec harness):
 *   Real-DB, in-process service harness (createTestOrg + a manager
 *   AccessTokenPayload + the service exercised directly) + raw-SQL seeding /
 *   RLS probes via providerPool (BYPASSRLS).
 *
 *   The builder has not created `ParcelSetupsService` yet, so it is imported
 *   DYNAMICALLY (guarded `loadService()`) — this file COMPILES today and each
 *   test fails at RUNTIME with a clear per-test message:
 *     - schema/RLS/journal tests fail with 42P01 undefined_table
 *       (`parcel_setups` missing) / "no parcel_setup journal entry";
 *     - behavior tests fail because loadService() can't resolve the module;
 *     - payload-shape tests fail because @emapp/shared-types does not export
 *       the parcel-setup payload schema yet.
 *
 *   The EXPECTED service shape (so these go green):
 *     class ParcelSetupsService {
 *       create(user, projectId, { blockNumber, parcelNumber, subParcel? }): Promise<ParcelSetup>
 *         // named method MUST call requireAgentCapability(tx,user,'edit_project_data')
 *       updatePayload(user, id, payload): Promise<ParcelSetup | void>   // draft-only
 *       confirm(user, id): Promise<ParcelSetup>                          // named method MUST gate D.54 too
 *       list(user, projectId, query?): Promise<{ data: ParcelSetup[]; ... }>
 *       getOne(user, id): Promise<ParcelSetup>
 *     }
 *   exported from apps/api/src/modules/parcel-setups/parcel-setups.service.ts.
 *   The payload Zod schema is expected from @emapp/shared-types as
 *   `ParcelSetupPayload` (fallback names probed — see loadPayloadSchema()).
 *   (If the builder names methods/exports differently, adjust the constants
 *   below — the asserted BEHAVIOR is what matters.)
 *
 * DO NOT modify any implementation/schema/migration file to make these pass —
 * that is the builder's job. This file only asserts the target behavior.
 *
 * Run:
 *   infisical run --env=dev -- pnpm --filter @emapp/api exec \
 *     vitest run src/modules/parcel-setups/parcel-setups.spec.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { db, memberships, projectAssignments, users } from '@emapp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

// ── Expected service location + method names (adjust if the builder differs) ──
const SERVICE_MODULE = './parcel-setups.service';
const SERVICE_CLASS = 'ParcelSetupsService';
const METHOD_CREATE = 'create';
const METHOD_UPDATE_PAYLOAD = 'updatePayload';
const METHOD_CONFIRM = 'confirm';
const METHOD_LIST = 'list';
const METHOD_GET_ONE = 'getOne';

// Expected shared-types export for the STRICT draft-payload Zod schema.
const PAYLOAD_SCHEMA_EXPORT = 'ParcelSetupPayload';
const PAYLOAD_SCHEMA_FALLBACKS = [
  'ParcelSetupPayloadSchema',
  'ParcelSetupPayloadInput',
  'ParcelSetupDraftPayload',
];

// The migration journal pin: the new parcel_setups migration `when` MUST be
// strictly greater than the current max (0072) or the migrator SILENTLY skips
// it (memory M-1).
const JOURNAL_MAX_WHEN_BEFORE_P3A = 1_782_918_000_000; // 0072_documents_bytes_encrypted

// A minimal wire surface — enough to TYPE the dynamic import without naming
// types that don't exist yet (camelCase expected, snake_case tolerated).
interface ParcelSetupLike {
  id: string;
  status: string;
  projectId?: string;
  project_id?: string;
  blockNumber?: string;
  block_number?: string;
  parcelNumber?: string;
  parcel_number?: string;
  subParcel?: string | null;
  sub_parcel?: string | null;
  source?: string;
  payload?: unknown;
  confirmedAt?: string | Date | null;
}
interface ParcelSetupsServiceLike {
  [METHOD_CREATE]: (
    user: AccessTokenPayload,
    projectId: string,
    input: { blockNumber: string; parcelNumber: string; subParcel?: string },
  ) => Promise<ParcelSetupLike>;
  [METHOD_UPDATE_PAYLOAD]: (
    user: AccessTokenPayload,
    id: string,
    payload: unknown,
  ) => Promise<unknown>;
  [METHOD_CONFIRM]: (user: AccessTokenPayload, id: string) => Promise<ParcelSetupLike>;
  [METHOD_LIST]: (
    user: AccessTokenPayload,
    projectId: string,
    query?: unknown,
  ) => Promise<{ data: ParcelSetupLike[] } & Record<string, unknown>>;
  [METHOD_GET_ONE]: (user: AccessTokenPayload, id: string) => Promise<ParcelSetupLike>;
}

let org: TestOrg;
let otherOrg: TestOrg;
let managerId: string;
let agentId: string;
let projectId: string; // org.projects[0] — the agent IS assigned to it
let testStart: Date;

const MGR_SID = '00000000-0000-4000-8000-0000000000f1';
const AGENT_SID = '00000000-0000-4000-8000-0000000000f2';

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
 * Dynamically resolve the (not-yet-built) ParcelSetupsService. Today this
 * THROWS (module/class missing) — each calling test fails with a clear,
 * actionable [RED] message instead of a whole-file compile error.
 */
async function loadService(): Promise<ParcelSetupsServiceLike> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(SERVICE_MODULE)) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `[RED] ${SERVICE_MODULE} not found yet — builder must create ${SERVICE_CLASS} ` +
        `(create/updatePayload/confirm/list/getOne). Cause: ${e instanceof Error ? e.message : e}`,
    );
  }
  const Ctor = mod[SERVICE_CLASS] as
    | (new (...args: unknown[]) => ParcelSetupsServiceLike)
    | undefined;
  if (typeof Ctor !== 'function') {
    throw new Error(`[RED] ${SERVICE_CLASS} not exported from ${SERVICE_MODULE} yet.`);
  }
  // P3a is the MANUAL path only — no provider seam (that is P3b), so the
  // service should construct without deps. If the builder adds constructor
  // deps, THIS is the single place to wire fakes.
  // P3b landed: the service now takes the IParcelDataProvider as its FIRST
  // ctor arg (PARCEL_DATA_PROVIDER). Wire the ZERO-EGRESS Stub — it always
  // answers "no data", so every P3a behavior stays the pure manual path.
  const { StubParcelDataProvider } = (await import('@emapp/db')) as {
    StubParcelDataProvider: new () => unknown;
  };
  const instance = new Ctor(new StubParcelDataProvider());
  const probe = instance as unknown as Record<string, unknown>;
  for (const m of [
    METHOD_CREATE,
    METHOD_UPDATE_PAYLOAD,
    METHOD_CONFIRM,
    METHOD_LIST,
    METHOD_GET_ONE,
  ]) {
    if (typeof probe[m] !== 'function') {
      throw new Error(`[RED] ${SERVICE_CLASS}.${m}() missing — builder must add it.`);
    }
  }
  return instance;
}

/** The STRICT draft-payload Zod schema from @emapp/shared-types. */
async function loadPayloadSchema(): Promise<{
  safeParse: (v: unknown) => { success: boolean };
}> {
  const mod = (await import('@emapp/shared-types')) as Record<string, unknown>;
  for (const name of [PAYLOAD_SCHEMA_EXPORT, ...PAYLOAD_SCHEMA_FALLBACKS]) {
    const cand = mod[name];
    if (cand && typeof (cand as { safeParse?: unknown }).safeParse === 'function') {
      return cand as { safeParse: (v: unknown) => { success: boolean } };
    }
  }
  throw new Error(
    `[RED] @emapp/shared-types exports none of ` +
      `[${[PAYLOAD_SCHEMA_EXPORT, ...PAYLOAD_SCHEMA_FALLBACKS].join(', ')}] — ` +
      `builder must add the STRICT parcel-setup payload schema.`,
  );
}

/** Extract a Nest HttpException status (clean 4xx — NOT a raw PG error). */
function httpStatus(e: unknown): number | null {
  if (e && typeof e === 'object') {
    const maybe = e as { getStatus?: () => number; status?: number };
    if (typeof maybe.getStatus === 'function') return maybe.getStatus();
    if (typeof maybe.status === 'number') return maybe.status;
  }
  return null;
}

// ── raw-SQL seeders + probes (providerPool = BYPASSRLS), tabu-spec style ─────

async function seedAgentMembership(orgId: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `parcel-agent-${randomUUID()}@test.local`,
      name: 'Parcel Agent',
      passwordHash: '$2b$12$placeholder',
    })
    .returning({ id: users.id });
  await db
    .insert(memberships)
    .values({ userId: u!.id, orgId, role: 'agent', acceptedAt: new Date() });
  return u!.id;
}

/** A fresh, isolated project in `orgId` — clean building/apartment counts. */
async function seedProject(orgId: string, createdBy: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO projects (org_id, name, type, created_by)
       VALUES ($1, $2, 'tama38_1', $3) RETURNING id`,
      [orgId, `P3a ${Date.now()}-${Math.random()}`, createdBy],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Pre-existing building+apartment (the collision target for test F). */
async function seedBuildingWithApartment(
  pid: string,
  address: string,
  aptNumber: string,
): Promise<{ buildingId: string; apartmentId: string }> {
  const c = await providerPool.connect();
  try {
    const b = await c.query<{ id: string }>(
      `INSERT INTO buildings (project_id, address, city)
       VALUES ($1, $2, 'תל אביב') RETURNING id`,
      [pid, address],
    );
    const a = await c.query<{ id: string }>(
      `INSERT INTO apartments (building_id, number) VALUES ($1, $2) RETURNING id`,
      [b.rows[0]!.id, aptNumber],
    );
    return { buildingId: b.rows[0]!.id, apartmentId: a.rows[0]!.id };
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

/** Force a setup out of 'draft' (lifecycle probe for draft-only writes). */
async function setSetupStatus(id: string, status: string): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(`UPDATE parcel_setups SET status = $2 WHERE id = $1`, [id, status]);
  } finally {
    c.release();
  }
}

interface RawSetupRow {
  status: string;
  source: string;
  block_number: string;
  parcel_number: string;
  sub_parcel: string | null;
  payload: unknown;
  confirmed_at: string | null;
  project_id: string;
}
async function setupRow(id: string): Promise<RawSetupRow> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<RawSetupRow>(
      `SELECT status, source, block_number, parcel_number, sub_parcel, payload,
              confirmed_at, project_id
       FROM parcel_setups WHERE id = $1`,
      [id],
    );
    if (!r.rows[0]) throw new Error(`parcel_setups row ${id} not found`);
    return r.rows[0];
  } finally {
    c.release();
  }
}

async function setupCountForProject(pid: string): Promise<number> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM parcel_setups WHERE project_id = $1`,
      [pid],
    );
    return Number(r.rows[0]!.n);
  } finally {
    c.release();
  }
}

/** Buildings created BY a setup (provenance column = the join key). */
async function buildingsBySetup(
  setupId: string,
): Promise<Array<{ id: string; address: string; city: string; project_id: string }>> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string; address: string; city: string; project_id: string }>(
      `SELECT id, address, city, project_id FROM buildings
       WHERE source_parcel_setup_id = $1 ORDER BY address`,
      [setupId],
    );
    return r.rows;
  } finally {
    c.release();
  }
}

/** Apartments created BY a setup — inherited provenance via the building. */
async function apartmentsBySetup(
  setupId: string,
): Promise<Array<{ number: string; floor: number | null; address: string }>> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ number: string; floor: number | null; address: string }>(
      `SELECT a.number, a.floor, b.address
       FROM apartments a JOIN buildings b ON b.id = a.building_id
       WHERE b.source_parcel_setup_id = $1
       ORDER BY b.address, a.number`,
      [setupId],
    );
    return r.rows;
  } finally {
    c.release();
  }
}

async function buildingCountInProject(pid: string): Promise<number> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM buildings WHERE project_id = $1`,
      [pid],
    );
    return Number(r.rows[0]!.n);
  } finally {
    c.release();
  }
}

async function apartmentCountInProject(pid: string): Promise<number> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM apartments a
       JOIN buildings b ON b.id = a.building_id WHERE b.project_id = $1`,
      [pid],
    );
    return Number(r.rows[0]!.n);
  } finally {
    c.release();
  }
}

/** Audit rows for this setup (action pinned by PREFIX — naming-robust). */
async function confirmAuditRows(
  orgId: string,
  targetId: string,
): Promise<Array<{ action: string; after_state: unknown; metadata: unknown }>> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ action: string; after_state: unknown; metadata: unknown }>(
      `SELECT action, after_state, metadata FROM audit_log
       WHERE org_id = $1 AND target_id = $2 AND created_at >= $3
         AND action LIKE 'parcel_setup%' AND action LIKE '%confirm%'`,
      [orgId, targetId, testStart],
    );
    return r.rows;
  } finally {
    c.release();
  }
}

// ── shared fixtures ──────────────────────────────────────────────────────────

/** 2 buildings, 3+2 apartments — the §6-P3a manual-path happy payload. */
function happyPayload(): unknown {
  return {
    buildings: [
      {
        address: 'הרצל 10',
        city: 'תל אביב',
        number: '10',
        floorsCount: 3,
        apartments: [
          { number: '1', floor: 0 },
          { number: '2', floor: 1 },
          { number: '3', floor: 2 },
        ],
      },
      {
        address: 'ביאליק 5',
        city: 'תל אביב',
        apartments: [
          { number: '1', floor: 0 },
          { number: '2', floor: 1 },
        ],
      },
    ],
  };
}

const CREATE_INPUT = { blockNumber: '6638', parcelNumber: '42', subParcel: '3' };

beforeAll(async () => {
  await setupTestDatabase();
  testStart = new Date(Date.now() - 5_000);
  const tag = `p3a-parcel-${Date.now()}`;
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
// A) create draft — happy path + wire shape + grounded DB row
// ───────────────────────────────────────────────────────────────────────────
describe('parcel-setups · create draft (envelope, manual source)', () => {
  it('A1) POST projects/:id/parcel-setups → draft envelope (wire camelCase; DB row: status=draft, source=manual, payload NULL, confirmed_at NULL)', async () => {
    const svc = await loadService();
    const pid = await seedProject(org.id, managerId);

    const created = await svc.create(manager(), pid, CREATE_INPUT);

    // Wire shape (camelCase per the repo's toWire convention; snake tolerated).
    expect(created.status).toBe('draft');
    expect(created.projectId ?? created.project_id).toBe(pid);
    expect(created.blockNumber ?? created.block_number).toBe('6638');
    expect(created.parcelNumber ?? created.parcel_number).toBe('42');
    expect(created.subParcel ?? created.sub_parcel).toBe('3');
    expect(created.confirmedAt ?? null).toBeNull();

    // Grounded DB row — the exact §4 columns.
    const row = await setupRow(created.id);
    expect(row.status).toBe('draft');
    expect(row.source).toBe('manual');
    expect(row.block_number).toBe('6638');
    expect(row.parcel_number).toBe('42');
    expect(row.sub_parcel).toBe('3');
    expect(row.payload).toBeNull();
    expect(row.confirmed_at).toBeNull();
    expect(await setupCountForProject(pid)).toBe(1);
  }, 30_000);

  it('A2) GET list (for the project) + GET one return the created draft', async () => {
    const svc = await loadService();
    const pid = await seedProject(org.id, managerId);
    const created = await svc.create(manager(), pid, CREATE_INPUT);

    const listed = await svc.list(manager(), pid);
    expect(Array.isArray(listed.data)).toBe(true);
    expect(listed.data.some((x) => x.id === created.id)).toBe(true);

    const one = await svc.getOne(manager(), created.id);
    expect(one.id).toBe(created.id);
    expect(one.status).toBe('draft');
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// B) visibility (no-oracle 404) + capability gate (D.54) + RLS isolation
// ───────────────────────────────────────────────────────────────────────────
describe('parcel-setups · visibility + capability + RLS', () => {
  it('B1) foreign-org project → no-oracle 404; nothing created; foreign GET one → 404', async () => {
    const svc = await loadService();
    const pid = await seedProject(org.id, managerId); // org A project

    // Org B manager tries to attach a setup to org A's project.
    const err = await svc.create(manager(otherOrg), pid, CREATE_INPUT).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeTruthy();
    expect(httpStatus(err)).toBe(404);
    expect(await setupCountForProject(pid)).toBe(0);

    // And a real org-A setup is invisible to org B (no-oracle GET).
    const created = await svc.create(manager(), pid, CREATE_INPUT);
    const errGet = await svc.getOne(manager(otherOrg), created.id).then(
      () => null,
      (e: unknown) => e,
    );
    expect(errGet).toBeTruthy();
    expect(httpStatus(errGet)).toBe(404);
  }, 30_000);

  it('B2) cap-gate (D.54): an ASSIGNED agent WITHOUT edit_project_data → 403 on create; with it → draft ok', async () => {
    const svc = await loadService();

    await setAgentCap(false);
    const before = await setupCountForProject(projectId);
    const err = await svc.create(agent(), projectId, CREATE_INPUT).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeTruthy();
    expect(httpStatus(err)).toBe(403);
    expect(await setupCountForProject(projectId)).toBe(before);

    // Sanity: with the capability ON, the SAME assigned agent succeeds.
    await setAgentCap(true);
    const ok = await svc.create(agent(), projectId, CREATE_INPUT);
    expect(ok.status).toBe('draft');
  }, 30_000);

  it('B3) cap-gate on CONFIRM too (a write in its own named method): agent w/o cap → 403, NO skeleton, setup stays draft', async () => {
    const svc = await loadService();
    const draft = await svc.create(manager(), projectId, CREATE_INPUT);
    await svc.updatePayload(manager(), draft.id, happyPayload());

    await setAgentCap(false);
    const err = await svc.confirm(agent(), draft.id).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeTruthy();
    expect(httpStatus(err)).toBe(403);
    expect((await buildingsBySetup(draft.id)).length).toBe(0);
    expect((await setupRow(draft.id)).status).toBe('draft');
  }, 30_000);

  it('B4) RLS isolates by org_id (FORCE RLS, mirror 0068): foreign GUC sees ZERO; the owning org sees the row', async () => {
    const pid = await seedProject(org.id, managerId);
    // Seed via BYPASSRLS so the RLS read below is the only gate under test.
    {
      const c0 = await providerPool.connect();
      try {
        await c0.query(
          `INSERT INTO parcel_setups (org_id, project_id, block_number, parcel_number, created_by)
           VALUES ($1, $2, '7000', '1', $3)`,
          [org.id, pid, managerId],
        );
      } finally {
        c0.release();
      }
    }

    const c = await providerPool.connect();
    try {
      // Catalog: RLS is ENABLED + FORCED (covers the table owner too).
      const cat = await c.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
         WHERE oid = 'public.parcel_setups'::regclass`,
      );
      expect(cat.rows[0]!.relrowsecurity).toBe(true);
      expect(cat.rows[0]!.relforcerowsecurity).toBe(true);

      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query({
        text: 'SELECT set_config($1, $2, true)',
        values: ['app.organization_id', otherOrg.id],
      });
      const foreign = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM parcel_setups WHERE project_id = $1`,
        [pid],
      );
      expect(Number(foreign.rows[0]!.n)).toBe(0);

      await c.query({
        text: 'SELECT set_config($1, $2, true)',
        values: ['app.organization_id', org.id],
      });
      const own = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM parcel_setups WHERE project_id = $1`,
        [pid],
      );
      expect(Number(own.rows[0]!.n)).toBe(1);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// C) PATCH payload — draft-only + STRICT Zod (NO PII keys)
// ───────────────────────────────────────────────────────────────────────────
describe('parcel-setups · PATCH payload (draft-only, strict, no PII)', () => {
  it('C1) valid payload on a draft → persisted to payload jsonb', async () => {
    const svc = await loadService();
    const pid = await seedProject(org.id, managerId);
    const draft = await svc.create(manager(), pid, CREATE_INPUT);

    await svc.updatePayload(manager(), draft.id, happyPayload());

    const row = await setupRow(draft.id);
    expect(row.payload).toBeTruthy();
    const parsed = z
      .object({
        buildings: z.array(
          z.object({ address: z.string(), apartments: z.array(z.object({ number: z.string() })) }),
        ),
      })
      .parse(row.payload);
    expect(parsed.buildings.length).toBe(2);
    expect(parsed.buildings[0]!.apartments.length + parsed.buildings[1]!.apartments.length).toBe(5);
    expect((await setupRow(draft.id)).status).toBe('draft');
  }, 30_000);

  it('C2) a PII-looking key (ownerName) is REJECTED (strict schema; the payload column must never hold PII) — nothing saved', async () => {
    const svc = await loadService();
    const pid = await seedProject(org.id, managerId);
    const draft = await svc.create(manager(), pid, CREATE_INPUT);

    const poisoned = {
      buildings: [
        {
          address: 'הרצל 10',
          city: 'תל אביב',
          apartments: [{ number: '1', ownerName: 'ישראל ישראלי' }],
        },
      ],
    };
    await expect(svc.updatePayload(manager(), draft.id, poisoned)).rejects.toBeTruthy();
    expect((await setupRow(draft.id)).payload).toBeNull();

    // Same at the BUILDING level (strict everywhere).
    const poisoned2 = {
      buildings: [{ address: 'הרצל 10', nationalId: '012345678', apartments: [{ number: '1' }] }],
    };
    await expect(svc.updatePayload(manager(), draft.id, poisoned2)).rejects.toBeTruthy();
    expect((await setupRow(draft.id)).payload).toBeNull();
  }, 30_000);

  it('C3) a structurally bad payload (no buildings array / missing address / missing apartment number) → 400-class reject, nothing saved', async () => {
    const svc = await loadService();
    const pid = await seedProject(org.id, managerId);
    const draft = await svc.create(manager(), pid, CREATE_INPUT);

    for (const bad of [
      { buildings: 'not-an-array' },
      { buildings: [{ city: 'תל אביב', apartments: [{ number: '1' }] }] }, // no address
      { buildings: [{ address: 'הרצל 10', apartments: [{ floor: 1 }] }] }, // no apt number
      {},
    ]) {
      await expect(svc.updatePayload(manager(), draft.id, bad)).rejects.toBeTruthy();
    }
    expect((await setupRow(draft.id)).payload).toBeNull();
  }, 30_000);

  it('C4) PATCH on a NON-draft setup → 409 (draft-only lifecycle write)', async () => {
    const svc = await loadService();
    const pid = await seedProject(org.id, managerId);
    const draft = await svc.create(manager(), pid, CREATE_INPUT);
    await setSetupStatus(draft.id, 'confirmed');

    const err = await svc.updatePayload(manager(), draft.id, happyPayload()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeTruthy();
    expect(httpStatus(err)).toBe(409);
    expect((await setupRow(draft.id)).payload).toBeNull();
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// D+E) confirm — atomic skeleton creation + provenance + idempotent 409
// ───────────────────────────────────────────────────────────────────────────
describe('parcel-setups · confirm → physical skeleton', () => {
  it('D) confirm a draft with 2 buildings (3+2 apartments) → 2 buildings + 5 apartments created, provenance stamped, status confirmed + confirmed_at, audit row (ids+counts only)', async () => {
    const svc = await loadService();
    const pid = await seedProject(org.id, managerId);
    const draft = await svc.create(manager(), pid, CREATE_INPUT);
    await svc.updatePayload(manager(), draft.id, happyPayload());

    const confirmed = await svc.confirm(manager(), draft.id);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.confirmedAt ?? null).not.toBeNull();

    // DB lifecycle stamped.
    const row = await setupRow(draft.id);
    expect(row.status).toBe('confirmed');
    expect(row.confirmed_at).not.toBeNull();

    // The skeleton: 2 buildings under THE project, provenance stamped.
    const blds = await buildingsBySetup(draft.id);
    expect(blds.length).toBe(2);
    expect(blds.every((b) => b.project_id === pid)).toBe(true);
    expect(blds.map((b) => b.address).sort()).toEqual(['ביאליק 5', 'הרצל 10'].sort());

    // 5 apartments, inherited provenance via the building, numbers+floors kept.
    const apts = await apartmentsBySetup(draft.id);
    expect(apts.length).toBe(5);
    const herzl = apts.filter((a) => a.address === 'הרצל 10');
    expect(herzl.map((a) => a.number).sort()).toEqual(['1', '2', '3']);
    expect(herzl.map((a) => a.floor).sort()).toEqual([0, 1, 2]);
    const bialik = apts.filter((a) => a.address === 'ביאליק 5');
    expect(bialik.map((a) => a.number).sort()).toEqual(['1', '2']);
    expect(await buildingCountInProject(pid)).toBe(2);
    expect(await apartmentCountInProject(pid)).toBe(5);

    // Audit row exists for the confirm — ids + counts ONLY (no payload echo:
    // the user-entered addresses must not be copied into the audit record).
    const audits = await confirmAuditRows(org.id, draft.id);
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const auditText = JSON.stringify(audits);
    expect(auditText).not.toContain('הרצל');
    expect(auditText).not.toContain('ביאליק');
  }, 30_000);

  it('E) confirm is idempotent single-claim: a second confirm → 409, counts UNCHANGED', async () => {
    const svc = await loadService();
    const pid = await seedProject(org.id, managerId);
    const draft = await svc.create(manager(), pid, CREATE_INPUT);
    await svc.updatePayload(manager(), draft.id, happyPayload());
    await svc.confirm(manager(), draft.id);

    const err = await svc.confirm(manager(), draft.id).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeTruthy();
    expect(httpStatus(err)).toBe(409);

    // Nothing duplicated.
    expect((await buildingsBySetup(draft.id)).length).toBe(2);
    expect((await apartmentsBySetup(draft.id)).length).toBe(5);
    expect(await buildingCountInProject(pid)).toBe(2);
    expect(await apartmentCountInProject(pid)).toBe(5);
  }, 30_000);

  it('F) collision with an EXISTING building/apartment in the project → the WHOLE confirm fails atomically (clean 409/400), nothing partially created, setup stays draft, NO orphan audit', async () => {
    const svc = await loadService();
    const pid = await seedProject(org.id, managerId);
    // Pre-existing skeleton: building 'איחוד 1' already has apartment '1'.
    // Grounded unique constraints the confirm will trip (either is valid):
    //   - apartments_building_number_active  (building_id, number) WHERE archived_at IS NULL  [0002]
    //   - buildings_project_address_active   (project_id, address) WHERE archived_at IS NULL  [0029]
    await seedBuildingWithApartment(pid, 'איחוד 1', '1');

    const draft = await svc.create(manager(), pid, CREATE_INPUT);
    await svc.updatePayload(manager(), draft.id, {
      buildings: [
        { address: 'איחוד 1', city: 'תל אביב', apartments: [{ number: '1' }] }, // collides
        { address: 'חדש 2', city: 'תל אביב', apartments: [{ number: '1' }, { number: '2' }] },
      ],
    });

    const err = await svc.confirm(manager(), draft.id).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeTruthy();
    // A CLEAN HTTP conflict/validation error — never a raw PG 23505 leak.
    expect([400, 409]).toContain(httpStatus(err));

    // ATOMIC rollback: no provenance-stamped building, the fresh 'חדש 2'
    // building was NOT half-created, counts are the pre-confirm baseline.
    expect((await buildingsBySetup(draft.id)).length).toBe(0);
    expect(await buildingCountInProject(pid)).toBe(1);
    expect(await apartmentCountInProject(pid)).toBe(1);

    // Lifecycle rolled back too: still a confirmable draft.
    const row = await setupRow(draft.id);
    expect(row.status).toBe('draft');
    expect(row.confirmed_at).toBeNull();

    // Audit-first INSIDE the tx → the failed confirm leaves NO audit trace.
    expect((await confirmAuditRows(org.id, draft.id)).length).toBe(0);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// G) schema CHECK + migration-journal pins
// ───────────────────────────────────────────────────────────────────────────
describe('parcel_setups · schema + migration pins', () => {
  it('G1) status CHECK is the closed set (draft|confirmed|discarded); DEFAULTs: status=draft, source=manual; confirmed_at NULL', async () => {
    const pid = await seedProject(org.id, managerId);
    const c = await providerPool.connect();
    try {
      const ins = await c.query<{
        status: string;
        source: string;
        confirmed_at: string | null;
        payload: unknown;
      }>(
        `INSERT INTO parcel_setups (org_id, project_id, block_number, parcel_number, created_by)
         VALUES ($1, $2, '6638', '42', $3)
         RETURNING status, source, confirmed_at, payload`,
        [org.id, pid, managerId],
      );
      expect(ins.rows[0]!.status).toBe('draft');
      expect(ins.rows[0]!.source).toBe('manual');
      expect(ins.rows[0]!.confirmed_at).toBeNull();
      expect(ins.rows[0]!.payload).toBeNull();

      // Out-of-enum status → CHECK violation (23514).
      const err = await c
        .query(
          `INSERT INTO parcel_setups (org_id, project_id, block_number, parcel_number, status, created_by)
           VALUES ($1, $2, '6638', '42', 'definitely_not_a_status', $3)`,
          [org.id, pid, managerId],
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

      // Provenance column exists with the right FK target: a building can be
      // stamped with a real setup id, and a GHOST setup id is rejected (23503).
      const setupId = await c
        .query<{ id: string }>(
          `INSERT INTO parcel_setups (org_id, project_id, block_number, parcel_number, created_by)
           VALUES ($1, $2, '6639', '43', $3) RETURNING id`,
          [org.id, pid, managerId],
        )
        .then((r) => r.rows[0]!.id);
      const b = await c.query<{ source_parcel_setup_id: string | null }>(
        `INSERT INTO buildings (project_id, address, city, source_parcel_setup_id)
         VALUES ($1, $2, 'תל אביב', $3) RETURNING source_parcel_setup_id`,
        [pid, `prov ${Date.now()}`, setupId],
      );
      expect(b.rows[0]!.source_parcel_setup_id).toBe(setupId);
      const fkErr = await c
        .query(
          `INSERT INTO buildings (project_id, address, city, source_parcel_setup_id)
           VALUES ($1, $2, 'תל אביב', $3)`,
          [pid, `prov-ghost ${Date.now()}`, randomUUID()],
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(fkErr).toBeTruthy();
      const fkCode =
        (fkErr as { cause?: { code?: string }; code?: string }).cause?.code ??
        (fkErr as { code?: string }).code;
      expect(fkCode).toBe('23503');
    } finally {
      c.release();
    }
  }, 30_000);

  it(`G2) migration journal: a parcel_setups entry exists with \`when\` > ${JOURNAL_MAX_WHEN_BEFORE_P3A} AND strictly greater than EVERY other entry (M-1 silent-skip guard)`, () => {
    const journalUrl = new URL(
      '../../../../../packages/db/migrations/meta/_journal.json',
      import.meta.url,
    );
    const journal = z
      .object({
        entries: z.array(z.object({ idx: z.number(), when: z.number(), tag: z.string() })),
      })
      .parse(JSON.parse(readFileSync(journalUrl, 'utf8')));

    const entry = journal.entries.find((e) => /parcel[-_]?setup/i.test(e.tag));
    expect(
      entry,
      '[RED] no parcel_setups migration journal entry yet — builder must hand-author the .sql AND append a _journal.json entry',
    ).toBeTruthy();
    expect(entry!.when).toBeGreaterThan(JOURNAL_MAX_WHEN_BEFORE_P3A);
    for (const other of journal.entries) {
      if (other === entry) continue;
      // Strictly greater than every PRE-EXISTING entry, or drizzle SILENTLY
      // skips it (memory M-1; dev 0056 was hand-patched for exactly this).
      // P3b adjustment (documented deviation): later slices legitimately
      // append NEWER entries (0074_parcel_lookup — whose own spec F1 carries
      // the live max-`when` M-1 guard), so this pin is scoped to entries that
      // PRECEDE 0073 — exactly what "pre-existing" always meant. The
      // all-entries form can never hold again once any post-P3a migration
      // exists.
      if (other.idx > entry!.idx) continue;
      expect(entry!.when).toBeGreaterThan(other.when);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Z) the STRICT payload Zod schema (shared-types) — the wire contract itself
// ───────────────────────────────────────────────────────────────────────────
describe('parcel-setup payload Zod schema (@emapp/shared-types) · strict, no PII', () => {
  it('Z1) accepts the documented shape: buildings[{address,city?,number?,floorsCount?,apartments[{number,floor?}]}]', async () => {
    const schema = await loadPayloadSchema();
    expect(schema.safeParse(happyPayload()).success).toBe(true);
    // Optional fields really optional.
    expect(
      schema.safeParse({ buildings: [{ address: 'א 1', apartments: [{ number: '1' }] }] }).success,
    ).toBe(true);
  });

  it('Z2) STRICT: PII-looking keys rejected at every level (ownerName / nationalId / phone)', async () => {
    const schema = await loadPayloadSchema();
    expect(
      schema.safeParse({
        buildings: [{ address: 'א 1', apartments: [{ number: '1', ownerName: 'x' }] }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        buildings: [{ address: 'א 1', nationalId: '012345678', apartments: [{ number: '1' }] }],
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        buildings: [{ address: 'א 1', apartments: [{ number: '1' }] }],
        phone: '0501234567',
      }).success,
    ).toBe(false);
  });

  it('Z3) structural: missing address / missing apartment number / non-array buildings rejected', async () => {
    const schema = await loadPayloadSchema();
    expect(schema.safeParse({ buildings: 'x' }).success).toBe(false);
    expect(schema.safeParse({ buildings: [{ apartments: [{ number: '1' }] }] }).success).toBe(
      false,
    );
    expect(schema.safeParse({ buildings: [{ address: 'א 1', apartments: [{}] }] }).success).toBe(
      false,
    );
    expect(schema.safeParse({}).success).toBe(false);
  });
});
