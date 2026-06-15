/**
 * PARCEL DATA PROVIDER — P3b acceptance tests (TEST-AUTHOR, independent, RED-first).
 *
 * SPEC (docs/DESIGN-phase3-parcel-autosetup.md §3 flow, §5 invariants, §6 P3b,
 * §7.1 decision-1 — the pluggable IParcelDataProvider seam + the LocalMapi
 * lookup over a bulk-מפ"י-loaded table; the preview/confirm screen is P3c, NOT
 * tested here):
 *
 *   1. SEAM (mirror EXTRACTION_PROVIDER, packages/db/src/providers/extraction/*
 *      + apps/api/src/modules/tabu/extraction-provider.factory.ts):
 *        interface IParcelDataProvider {
 *          lookup(q: { blockNumber: string; parcelNumber: string; subParcel?: string }):
 *            Promise<{ found: boolean; city?: string; centroidLat?: number;
 *                      centroidLng?: number; providerId: string }>;
 *        }
 *        StubParcelDataProvider — zero-egress DEFAULT: always
 *          { found: false, providerId: 'stub' }; NEVER reads the DB / network.
 *        PARCEL_DATA_PROVIDER token + parcelDataProviderFactory() in
 *        apps/api/src/modules/parcel-setups/parcel-data-provider.factory.ts:
 *          env PARCEL_LOOKUP_ENABLED === 'true' → LocalMapi, else → Stub.
 *
 *   2. MIGRATION 0074_parcel_lookup (hand-authored .sql + _journal entry,
 *      `when` MUST be > 1783004400000 — the 0073 max; memory M-1 silent-skip):
 *        parcel_lookup (block_number text NOT NULL, parcel_number text NOT
 *        NULL, sub_parcel text NULL, city text NULL, centroid_lat double
 *        precision NULL, centroid_lng double precision NULL) — a GLOBAL
 *        public-national-record reference table: NO org_id, NO RLS (rationale
 *        documented in the migration comment), app_user gets SELECT ONLY (the
 *        loader runs as the owner role). Uniqueness over (block,parcel[,sub])
 *        — exact-duplicate triple INSERT must 23505; NULL-sub dedupe is pinned
 *        BEHAVIORALLY by the loader-idempotency test (the mechanism — partial
 *        indexes / NULLS NOT DISTINCT / surrogate+unique — is builder's
 *        choice).
 *      PLUS two new columns on parcel_setups (same migration):
 *        provider_city text NULL, provider_status text NULL.
 *
 *   3. LocalMapiProvider (packages/db/src/providers/parcel/local-mapi.provider.ts):
 *      SELECTs parcel_lookup by block+parcel(+sub) → found →
 *      { found: true, city, centroidLat, centroidLng, providerId: 'local-mapi' }.
 *
 *   4. LOADER packages/db/scripts/load-parcel-lookup.ts — exports a function
 *      (csvPath: string) => Promise<unknown> that ingests a
 *      `block,parcel,sub,city,lat,lng`-headed CSV (UPSERT — idempotent
 *      re-load). MUST be import-safe (no top-level side effects). Fixture:
 *      ./parcel-lookup.fixture.csv (10 rows, incl. NULL-sub + multi-sub).
 *
 *   5. CREATE WIRING: after the draft insert, ParcelSetupsService.create calls
 *      provider.lookup(block/parcel/sub):
 *        found      → row: source = the provider's providerId ('local-mapi' —
 *                     NEVER from the DTO; it is the review flag),
 *                     provider_city stamped, provider_status='found'.
 *        not found  → source stays 'manual', provider_status='not_found'
 *                     (PINNED — Stub mode and unknown-parcel both yield it).
 *        provider THROWS → fail-open for UX (§5): the draft is still created,
 *                     source='manual', provider_status anything but 'found'.
 *      Wire shape gains providerStatus / providerCity (camelCase; snake
 *      tolerated). The provider NEVER touches the user's payload (stays NULL
 *      until PATCH; strict no-PII Zod intact; P3a PATCH→confirm unchanged).
 *      §5 zero-PII egress: the lookup query carries ONLY block/parcel/sub.
 *
 * LAYER + RED MODEL (byte-for-byte the P3a parcel-setups.spec harness):
 *   Real-DB, in-process service harness (createTestOrg + manager
 *   AccessTokenPayload + the service exercised directly) + raw-SQL seeding /
 *   schema probes via providerPool (BYPASSRLS/owner). Everything P3b is
 *   imported DYNAMICALLY (guarded) so this file COMPILES today and each test
 *   fails at RUNTIME with a clear [RED] cause:
 *     - factory/provider/loader tests → module/class/export missing;
 *     - parcel_lookup schema/seed probes → 42P01 undefined_table;
 *     - provider_city/provider_status probes → 42703 undefined_column;
 *     - wiring tests → provider fields absent on wire/row (or 42703);
 *     - journal test → no parcel_lookup journal entry.
 *
 *   EXPECTED names (adjust the constants below if the builder differs — the
 *   asserted BEHAVIOR is what matters):
 *     - @emapp/db exports (or deep paths under packages/db/src/providers/parcel/):
 *         IParcelDataProvider (type), StubParcelDataProvider,
 *         LocalMapiParcelDataProvider (fallback name: LocalMapiProvider).
 *       Both providers must construct with NO args (they own their DB handle;
 *       parcel_lookup has no RLS so the app pool reads it freely).
 *     - apps/api/src/modules/parcel-setups/parcel-data-provider.factory.ts:
 *         export const PARCEL_DATA_PROVIDER = 'PARCEL_DATA_PROVIDER';
 *         export function parcelDataProviderFactory(): IParcelDataProvider;
 *     - packages/db/scripts/load-parcel-lookup.ts:
 *         export function loadParcelLookup(csvPath: string): Promise<unknown>;
 *     - ParcelSetupsService gains a constructor accepting the provider as its
 *       FIRST arg (mirrors TabuExtractionsService(storage, extraction…)):
 *         new ParcelSetupsService(parcelDataProvider)
 *       (TODAY the P3a ctor takes none — extra args are ignored by JS, so the
 *       wiring tests go RED on the ASSERTIONS, not on construction.)
 *
 * DO NOT modify any implementation/schema/migration file to make these pass —
 * that is the builder's job. This file only asserts the target behavior.
 *
 * Run:
 *   infisical run --env=dev -- pnpm --filter @emapp/api exec \
 *     vitest run src/modules/parcel-setups/parcel-data-provider.spec.ts
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

// ── Pinned names (single place to adjust if the builder names differ) ────────
const DB_PKG_MODULE = '@emapp/db';
const STUB_DEEP_MODULE = '../../../../../packages/db/src/providers/parcel/stub.provider';
const LOCAL_DEEP_MODULE = '../../../../../packages/db/src/providers/parcel/local-mapi.provider';
const STUB_CLASS_CANDIDATES = ['StubParcelDataProvider'];
const LOCAL_CLASS_CANDIDATES = ['LocalMapiParcelDataProvider', 'LocalMapiProvider'];

const FACTORY_MODULE = './parcel-data-provider.factory';
const FACTORY_TOKEN_EXPORT = 'PARCEL_DATA_PROVIDER';
const FACTORY_FN_EXPORT = 'parcelDataProviderFactory';
const ENV_FLAG = 'PARCEL_LOOKUP_ENABLED';

const LOADER_MODULE = '../../../../../packages/db/scripts/load-parcel-lookup';
const LOADER_FN_CANDIDATES = ['loadParcelLookup', 'loadParcelLookupCsv', 'default'];

const SERVICE_MODULE = './parcel-setups.service';
const SERVICE_CLASS = 'ParcelSetupsService';

const PROVIDER_ID_STUB = 'stub';
const PROVIDER_ID_LOCAL = 'local-mapi';
const STATUS_FOUND = 'found';
const STATUS_NOT_FOUND = 'not_found';

// Migration journal pin: the 0074_parcel_lookup `when` MUST be strictly
// greater than the current max (0073_parcel_setups = 1783004400000) or the
// migrator SILENTLY skips it (memory M-1).
const JOURNAL_MAX_WHEN_BEFORE_P3B = 1_783_004_400_000;
const JOURNAL_TAG_RE = /parcel[-_]?lookup/i;

// The 10-row CSV fixture (header: block,parcel,sub,city,lat,lng) — lives next
// to this spec, as the P3b task pins.
const FIXTURE_CSV = fileURLToPath(new URL('./parcel-lookup.fixture.csv', import.meta.url));
const FIXTURE_BLOCKS = ['6638', '7104', '30043', '10575', '11200', '6158'];
const FIXTURE_ROW_COUNT = 10;

// ── provider seam types (local — the real interface doesn't exist yet) ───────
interface ParcelLookupResult {
  found: boolean;
  city?: string | null;
  centroidLat?: number | null;
  centroidLng?: number | null;
  providerId: string;
}
interface ParcelDataProviderLike {
  lookup(q: {
    blockNumber: string;
    parcelNumber: string;
    subParcel?: string;
  }): Promise<ParcelLookupResult>;
}
type ProviderCtor = new (...args: unknown[]) => ParcelDataProviderLike;

// ── wire/service types (provider fields tolerant: camelCase or snake) ────────
interface ParcelSetupWireLike {
  id: string;
  status: string;
  source?: string;
  payload?: unknown;
  providerStatus?: string | null;
  provider_status?: string | null;
  providerCity?: string | null;
  provider_city?: string | null;
  confirmedAt?: string | Date | null;
}
interface SvcLike {
  create(
    user: AccessTokenPayload,
    projectId: string,
    input: Record<string, unknown>,
  ): Promise<ParcelSetupWireLike>;
  updatePayload(user: AccessTokenPayload, id: string, payload: unknown): Promise<unknown>;
  confirm(user: AccessTokenPayload, id: string): Promise<ParcelSetupWireLike>;
}

function wireProviderStatus(x: ParcelSetupWireLike): string | null {
  return x.providerStatus ?? x.provider_status ?? null;
}
function wireProviderCity(x: ParcelSetupWireLike): string | null {
  return x.providerCity ?? x.provider_city ?? null;
}

// ── identities ───────────────────────────────────────────────────────────────
let org: TestOrg;
let managerId: string;

const MGR_SID = '00000000-0000-4000-8000-0000000000f3';

function manager(): AccessTokenPayload {
  return {
    sub: managerId,
    orgId: org.id,
    role: 'manager',
    sid: MGR_SID,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

// ── dynamic RED-guarded resolution ───────────────────────────────────────────

async function resolveProviderClass(
  candidates: string[],
  deepModule: string,
  what: string,
): Promise<ProviderCtor> {
  const tried: string[] = [];
  for (const moduleId of [DB_PKG_MODULE, deepModule]) {
    let mod: Record<string, unknown> | null = null;
    try {
      mod = (await import(moduleId)) as Record<string, unknown>;
    } catch (e) {
      tried.push(`${moduleId} (import failed: ${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    for (const name of candidates) {
      if (typeof mod[name] === 'function') return mod[name] as ProviderCtor;
    }
    tried.push(`${moduleId} (none of [${candidates.join(', ')}] exported)`);
  }
  throw new Error(
    `[RED] ${what} not found yet — builder must land P3b. Tried: ${tried.join(' | ')}`,
  );
}

async function newStubProvider(): Promise<ParcelDataProviderLike> {
  const Ctor = await resolveProviderClass(
    STUB_CLASS_CANDIDATES,
    STUB_DEEP_MODULE,
    'StubParcelDataProvider',
  );
  const inst = new Ctor();
  if (typeof inst.lookup !== 'function') {
    throw new Error('[RED] StubParcelDataProvider.lookup() missing — builder must add it.');
  }
  return inst;
}

async function newLocalMapiProvider(): Promise<ParcelDataProviderLike> {
  const Ctor = await resolveProviderClass(
    LOCAL_CLASS_CANDIDATES,
    LOCAL_DEEP_MODULE,
    'LocalMapiProvider',
  );
  const inst = new Ctor();
  if (typeof inst.lookup !== 'function') {
    throw new Error('[RED] LocalMapiProvider.lookup() missing — builder must add it.');
  }
  return inst;
}

async function loadFactory(): Promise<{
  token: unknown;
  factory: () => ParcelDataProviderLike;
}> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(FACTORY_MODULE)) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `[RED] ${FACTORY_MODULE} not found yet — builder must add ${FACTORY_TOKEN_EXPORT} + ` +
        `${FACTORY_FN_EXPORT}() (mirror tabu/extraction-provider.factory.ts). ` +
        `Cause: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const factory = mod[FACTORY_FN_EXPORT];
  if (typeof factory !== 'function') {
    throw new Error(`[RED] ${FACTORY_FN_EXPORT} not exported from ${FACTORY_MODULE} yet.`);
  }
  return {
    token: mod[FACTORY_TOKEN_EXPORT],
    factory: factory as () => ParcelDataProviderLike,
  };
}

async function loadLoaderFn(): Promise<(csvPath: string) => Promise<unknown>> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(LOADER_MODULE)) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `[RED] ${LOADER_MODULE}.ts not found yet — builder must add the CSV loader ` +
        `(exported fn, import-safe). Cause: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  for (const name of LOADER_FN_CANDIDATES) {
    if (typeof mod[name] === 'function') {
      return mod[name] as (csvPath: string) => Promise<unknown>;
    }
  }
  throw new Error(
    `[RED] load-parcel-lookup exports none of [${LOADER_FN_CANDIDATES.join(', ')}] — ` +
      `builder must export the loader function (tests call it with a CSV path).`,
  );
}

/** Build a ParcelSetupsService with the GIVEN provider injected as the first
 *  ctor arg. The P3a ctor takes no args (extra args are ignored), so today the
 *  wiring tests fail on the ASSERTIONS — exactly the RED we want. */
async function makeSvc(provider: ParcelDataProviderLike): Promise<SvcLike> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(SERVICE_MODULE)) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `[RED] ${SERVICE_MODULE} import failed. Cause: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const Ctor = mod[SERVICE_CLASS] as (new (...args: unknown[]) => unknown) | undefined;
  if (typeof Ctor !== 'function') {
    throw new Error(`[RED] ${SERVICE_CLASS} not exported from ${SERVICE_MODULE}.`);
  }
  let instance: unknown;
  try {
    instance = new Ctor(provider);
  } catch (e) {
    throw new Error(
      `[RED] new ${SERVICE_CLASS}(parcelDataProvider) failed — P3b builder must accept the ` +
        `provider as the first ctor arg (PARCEL_DATA_PROVIDER DI token, mirror tabu). ` +
        `Cause: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const probe = instance as Record<string, unknown>;
  for (const m of ['create', 'updatePayload', 'confirm']) {
    if (typeof probe[m] !== 'function') {
      throw new Error(`[RED] ${SERVICE_CLASS}.${m}() missing.`);
    }
  }
  return instance as SvcLike;
}

/** providerId of an instance: a readable property if exposed, else the one
 *  stamped on a lookup result (the interface guarantees it there). */
async function providerIdOf(p: ParcelDataProviderLike): Promise<string> {
  const direct = (p as { providerId?: unknown }).providerId;
  if (typeof direct === 'string') return direct;
  const res = await p.lookup({ blockNumber: `none-${randomUUID()}`, parcelNumber: '1' });
  return res.providerId;
}

async function withEnvFlag<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[ENV_FLAG];
  if (value === undefined) delete process.env[ENV_FLAG];
  else process.env[ENV_FLAG] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[ENV_FLAG];
    else process.env[ENV_FLAG] = prev;
  }
}

function httpStatus(e: unknown): number | null {
  if (e && typeof e === 'object') {
    const maybe = e as { getStatus?: () => number; status?: number };
    if (typeof maybe.getStatus === 'function') return maybe.getStatus();
    if (typeof maybe.status === 'number') return maybe.status;
  }
  return null;
}

// ── raw-SQL probes/seeders (providerPool = owner/BYPASSRLS) ──────────────────

function redIfMissing(e: unknown, what: string): never {
  const code =
    (e as { cause?: { code?: string }; code?: string }).cause?.code ??
    (e as { code?: string }).code;
  if (code === '42P01') {
    throw new Error(
      `[RED] ${what}: relation "parcel_lookup" missing (42P01) — builder must land ` +
        `migration 0074_parcel_lookup (+ _journal entry, when > ${JOURNAL_MAX_WHEN_BEFORE_P3B}).`,
    );
  }
  if (code === '42703') {
    throw new Error(
      `[RED] ${what}: column missing (42703) — builder must add provider_city/provider_status ` +
        `to parcel_setups in migration 0074.`,
    );
  }
  throw e instanceof Error ? e : new Error(String(e));
}

async function seedLookupRow(
  block: string,
  parcel: string,
  sub: string | null,
  city: string,
  lat: number,
  lng: number,
): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `INSERT INTO parcel_lookup
         (block_number, parcel_number, sub_parcel, city, centroid_lat, centroid_lng)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [block, parcel, sub, city, lat, lng],
    );
  } catch (e) {
    redIfMissing(e, 'seed parcel_lookup');
  } finally {
    c.release();
  }
}

async function fixtureRowCount(): Promise<number> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM parcel_lookup WHERE block_number = ANY($1::text[])`,
      [FIXTURE_BLOCKS],
    );
    return Number(r.rows[0]!.n);
  } catch (e) {
    redIfMissing(e, 'count parcel_lookup fixture rows');
  } finally {
    c.release();
  }
}

interface LookupRow {
  sub_parcel: string | null;
  city: string | null;
  centroid_lat: number | null;
  centroid_lng: number | null;
}
async function lookupRows(block: string, parcel: string): Promise<LookupRow[]> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<LookupRow>(
      `SELECT sub_parcel, city, centroid_lat, centroid_lng FROM parcel_lookup
       WHERE block_number = $1 AND parcel_number = $2`,
      [block, parcel],
    );
    return r.rows;
  } catch (e) {
    redIfMissing(e, 'read parcel_lookup rows');
  } finally {
    c.release();
  }
}

interface ProviderSetupRow {
  status: string;
  source: string;
  payload: unknown;
  provider_city: string | null;
  provider_status: string | null;
}
async function providerSetupRow(id: string): Promise<ProviderSetupRow> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<ProviderSetupRow>(
      `SELECT status, source, payload, provider_city, provider_status
       FROM parcel_setups WHERE id = $1`,
      [id],
    );
    if (!r.rows[0]) throw new Error(`parcel_setups row ${id} not found`);
    return r.rows[0];
  } catch (e) {
    redIfMissing(e, 'read parcel_setups provider columns');
  } finally {
    c.release();
  }
}

async function seedProject(orgId: string, createdBy: string, name?: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO projects (org_id, name, type, created_by)
       VALUES ($1, $2, 'tama38_1', $3) RETURNING id`,
      [orgId, name ?? `P3b ${Date.now()}-${Math.random()}`, createdBy],
    );
    return r.rows[0]!.id;
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

async function buildingsBySetup(setupId: string): Promise<Array<{ id: string; address: string }>> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string; address: string }>(
      `SELECT id, address FROM buildings WHERE source_parcel_setup_id = $1 ORDER BY address`,
      [setupId],
    );
    return r.rows;
  } finally {
    c.release();
  }
}

async function apartmentsBySetup(setupId: string): Promise<Array<{ number: string }>> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ number: string }>(
      `SELECT a.number FROM apartments a JOIN buildings b ON b.id = a.building_id
       WHERE b.source_parcel_setup_id = $1`,
      [setupId],
    );
    return r.rows;
  } finally {
    c.release();
  }
}

// ── shared fixtures (the P3a happy/poisoned payloads — regression anchor) ────

function happyPayload(): unknown {
  return {
    buildings: [
      {
        address: 'הרצל 10',
        city: 'תל אביב',
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

function poisonedPayload(): unknown {
  return {
    buildings: [
      {
        address: 'הרצל 10',
        city: 'תל אביב',
        apartments: [{ number: '1', ownerName: 'ישראל ישראלי' }],
      },
    ],
  };
}

beforeAll(async () => {
  await setupTestDatabase();
  const tag = `p3b-parcel-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

// ───────────────────────────────────────────────────────────────────────────
// A) factory + Stub — the seam mirrors EXTRACTION_PROVIDER exactly
// ───────────────────────────────────────────────────────────────────────────
describe('parcel-data-provider · factory (PARCEL_DATA_PROVIDER, env-flag selection)', () => {
  it(`A1) no ${ENV_FLAG} → parcelDataProviderFactory() returns the Stub (providerId='${PROVIDER_ID_STUB}', always found:false); token export pinned`, async () => {
    const { token, factory } = await loadFactory();
    expect(token).toBe(FACTORY_TOKEN_EXPORT);

    await withEnvFlag(undefined, async () => {
      const p = factory();
      expect(await providerIdOf(p)).toBe(PROVIDER_ID_STUB);
      const r = await p.lookup({ blockNumber: '6638', parcelNumber: '42', subParcel: '3' });
      expect(r.found).toBe(false);
      expect(r.providerId).toBe(PROVIDER_ID_STUB);
    });
  }, 30_000);

  it(`A2) ${ENV_FLAG}=true → factory returns LocalMapi (providerId='${PROVIDER_ID_LOCAL}')`, async () => {
    const { factory } = await loadFactory();
    await withEnvFlag('true', async () => {
      const p = factory();
      expect(await providerIdOf(p)).toBe(PROVIDER_ID_LOCAL);
    });
  }, 30_000);

  it(`A3) ${ENV_FLAG}=false (set but not 'true') → still the Stub`, async () => {
    const { factory } = await loadFactory();
    await withEnvFlag('false', async () => {
      const p = factory();
      expect(await providerIdOf(p)).toBe(PROVIDER_ID_STUB);
    });
  }, 30_000);

  it('A4) the Stub is ZERO-EGRESS: found:false even for a block/parcel that EXISTS in parcel_lookup (it never reads the table)', async () => {
    const block = `a4-${randomUUID().slice(0, 8)}`;
    await seedLookupRow(block, '42', '3', 'תל אביב', 32.08, 34.78);
    const stub = await newStubProvider();
    const r = await stub.lookup({ blockNumber: block, parcelNumber: '42', subParcel: '3' });
    expect(r.found).toBe(false);
    expect(r.providerId).toBe(PROVIDER_ID_STUB);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// B) the LOADER — CSV fixture ingest + idempotent re-load (upsert)
// ───────────────────────────────────────────────────────────────────────────
describe('parcel-lookup · loader (packages/db/scripts/load-parcel-lookup.ts)', () => {
  it(`B1) loading the 10-row fixture CSV → ${FIXTURE_ROW_COUNT} rows in parcel_lookup (NULL-sub + multi-sub kept; city+centroids parsed)`, async () => {
    expect(existsSync(FIXTURE_CSV), `fixture missing at ${FIXTURE_CSV}`).toBe(true);
    const load = await loadLoaderFn();
    await load(FIXTURE_CSV);

    expect(await fixtureRowCount()).toBe(FIXTURE_ROW_COUNT);

    // 6638/42 has THREE distinct rows: sub 3, sub 4, and a NULL-sub row.
    const rows = await lookupRows('6638', '42');
    expect(rows.length).toBe(3);
    const subs = rows.map((r) => r.sub_parcel);
    expect(subs).toContain('3');
    expect(subs).toContain('4');
    expect(subs).toContain(null);

    // Spot-check the parsed values of the (6638,42,3) row.
    const r3 = rows.find((r) => r.sub_parcel === '3')!;
    expect(r3.city).toBe('תל אביב');
    expect(Number(r3.centroid_lat)).toBeCloseTo(32.0853, 3);
    expect(Number(r3.centroid_lng)).toBeCloseTo(34.7818, 3);
  }, 60_000);

  it('B2) re-loading the SAME fixture is idempotent (UPSERT): row count unchanged, values intact', async () => {
    const load = await loadLoaderFn();
    await load(FIXTURE_CSV);
    await load(FIXTURE_CSV);

    expect(await fixtureRowCount()).toBe(FIXTURE_ROW_COUNT);
    const rows = await lookupRows('6638', '42');
    expect(rows.length).toBe(3); // NULL-sub row deduped too — no NULLS-DISTINCT dup
    expect(rows.find((r) => r.sub_parcel === '3')!.city).toBe('תל אביב');
  }, 60_000);
});

// ───────────────────────────────────────────────────────────────────────────
// C) LocalMapiProvider — SELECT-backed lookup (raw-seeded, loader-independent)
// ───────────────────────────────────────────────────────────────────────────
describe('parcel-data-provider · LocalMapi lookup', () => {
  it(`C1) a seeded block/parcel/sub → found:true + city + centroids + providerId='${PROVIDER_ID_LOCAL}'`, async () => {
    const block = `c1-${randomUUID().slice(0, 8)}`;
    await seedLookupRow(block, '42', '3', 'תל אביב-יפו', 32.11, 34.79);
    const p = await newLocalMapiProvider();

    const r = await p.lookup({ blockNumber: block, parcelNumber: '42', subParcel: '3' });
    expect(r.found).toBe(true);
    expect(r.city).toBe('תל אביב-יפו');
    expect(Number(r.centroidLat)).toBeCloseTo(32.11, 3);
    expect(Number(r.centroidLng)).toBeCloseTo(34.79, 3);
    expect(r.providerId).toBe(PROVIDER_ID_LOCAL);
  }, 30_000);

  it('C2) a NULL-sub row matches a lookup WITHOUT subParcel', async () => {
    const block = `c2-${randomUUID().slice(0, 8)}`;
    await seedLookupRow(block, '7', null, 'חיפה', 32.79, 34.99);
    const p = await newLocalMapiProvider();

    const r = await p.lookup({ blockNumber: block, parcelNumber: '7' });
    expect(r.found).toBe(true);
    expect(r.city).toBe('חיפה');
    expect(r.providerId).toBe(PROVIDER_ID_LOCAL);
  }, 30_000);

  it('C3) subParcel DISAMBIGUATES: two rows same block/parcel, different sub → each returns ITS city', async () => {
    const block = `c3-${randomUUID().slice(0, 8)}`;
    await seedLookupRow(block, '9', '1', 'ירושלים', 31.77, 35.21);
    await seedLookupRow(block, '9', '2', 'רמת גן', 32.07, 34.82);
    const p = await newLocalMapiProvider();

    const r1 = await p.lookup({ blockNumber: block, parcelNumber: '9', subParcel: '1' });
    expect(r1.found).toBe(true);
    expect(r1.city).toBe('ירושלים');
    const r2 = await p.lookup({ blockNumber: block, parcelNumber: '9', subParcel: '2' });
    expect(r2.found).toBe(true);
    expect(r2.city).toBe('רמת גן');
  }, 30_000);

  it(`C4) unknown block/parcel → { found:false, providerId:'${PROVIDER_ID_LOCAL}' }, no city`, async () => {
    const p = await newLocalMapiProvider();
    const r = await p.lookup({ blockNumber: `none-${randomUUID()}`, parcelNumber: '999' });
    expect(r.found).toBe(false);
    expect(r.providerId).toBe(PROVIDER_ID_LOCAL);
    expect(r.city ?? null).toBeNull();
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// D) create-draft wiring — provider stamps source/provider_city/provider_status
// ───────────────────────────────────────────────────────────────────────────
describe('parcel-setups · create wiring (lookup after the draft insert)', () => {
  it(`D1) LocalMapi + a known parcel → draft row: source='${PROVIDER_ID_LOCAL}', provider_city stamped, provider_status='${STATUS_FOUND}'; wire exposes providerStatus/providerCity`, async () => {
    const block = `d1-${randomUUID().slice(0, 8)}`;
    await seedLookupRow(block, '42', '3', 'עיר-הספק', 32.2, 34.9);
    const svc = await makeSvc(await newLocalMapiProvider());
    const pid = await seedProject(org.id, managerId);

    const created = await svc.create(manager(), pid, {
      blockNumber: block,
      parcelNumber: '42',
      subParcel: '3',
    });

    // Wire shape (camelCase per toWire convention; snake tolerated).
    expect(created.status).toBe('draft');
    expect(created.source).toBe(PROVIDER_ID_LOCAL);
    expect(wireProviderStatus(created)).toBe(STATUS_FOUND);
    expect(wireProviderCity(created)).toBe('עיר-הספק');

    // Grounded DB row — 0074's new columns.
    const row = await providerSetupRow(created.id);
    expect(row.status).toBe('draft');
    expect(row.source).toBe(PROVIDER_ID_LOCAL);
    expect(row.provider_status).toBe(STATUS_FOUND);
    expect(row.provider_city).toBe('עיר-הספק');
    // The provider NEVER touches the user's payload — still NULL until PATCH.
    expect(row.payload).toBeNull();
  }, 30_000);

  it(`D2) LocalMapi + an UNKNOWN parcel → source stays 'manual', provider_status='${STATUS_NOT_FOUND}', no provider_city; manual path unchanged`, async () => {
    const svc = await makeSvc(await newLocalMapiProvider());
    const pid = await seedProject(org.id, managerId);

    const created = await svc.create(manager(), pid, {
      blockNumber: `d2-none-${randomUUID().slice(0, 8)}`,
      parcelNumber: '1',
    });

    expect(created.status).toBe('draft');
    expect(created.source).toBe('manual');
    expect(wireProviderStatus(created)).toBe(STATUS_NOT_FOUND);
    expect(wireProviderCity(created)).toBeNull();

    const row = await providerSetupRow(created.id);
    expect(row.source).toBe('manual');
    expect(row.provider_status).toBe(STATUS_NOT_FOUND);
    expect(row.provider_city).toBeNull();
  }, 30_000);

  it(`D3) Stub mode (zero-egress default) → source='manual', provider_status='${STATUS_NOT_FOUND}' — even for a parcel PRESENT in the table`, async () => {
    const block = `d3-${randomUUID().slice(0, 8)}`;
    await seedLookupRow(block, '42', null, 'תל אביב', 32.08, 34.78);
    const svc = await makeSvc(await newStubProvider());
    const pid = await seedProject(org.id, managerId);

    const created = await svc.create(manager(), pid, { blockNumber: block, parcelNumber: '42' });

    expect(created.source).toBe('manual');
    expect(wireProviderStatus(created)).toBe(STATUS_NOT_FOUND);
    const row = await providerSetupRow(created.id);
    expect(row.source).toBe('manual');
    expect(row.provider_status).toBe(STATUS_NOT_FOUND);
    expect(row.provider_city).toBeNull();
  }, 30_000);

  it('D4) source is NOT forgeable from the DTO: create input with a `source` key → 400-class reject (strict input), nothing created — the providerId is the ONLY writer of the review flag', async () => {
    const neverFound: ParcelDataProviderLike = {
      lookup: async () => ({ found: false, providerId: 'recording' }),
    };
    const svc = await makeSvc(neverFound);
    const pid = await seedProject(org.id, managerId);

    const err = await svc
      .create(manager(), pid, {
        blockNumber: '6638',
        parcelNumber: '42',
        source: PROVIDER_ID_LOCAL, // forged review flag
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeTruthy();
    expect(httpStatus(err)).toBe(400);
    expect(await setupCountForProject(pid)).toBe(0);
  }, 30_000);

  it("D5) a THROWING provider is fail-open for UX (§5): the draft is still created, source='manual', provider_status anything but 'found'", async () => {
    const broken: ParcelDataProviderLike = {
      lookup: async () => {
        throw new Error('provider down');
      },
    };
    const svc = await makeSvc(broken);
    const pid = await seedProject(org.id, managerId);

    const created = await svc.create(manager(), pid, { blockNumber: '6638', parcelNumber: '42' });
    expect(created.status).toBe('draft');
    expect(created.source).toBe('manual');

    const row = await providerSetupRow(created.id);
    expect(row.source).toBe('manual');
    expect(row.provider_status).not.toBe(STATUS_FOUND);
    expect(row.provider_city).toBeNull();
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// E) invariants — payload untouched (P3a regression) + zero-PII egress
// ───────────────────────────────────────────────────────────────────────────
describe('parcel-setups · provider invariants', () => {
  it("E1) a provider-FOUND draft PATCHes + confirms EXACTLY like P3a: poisoned payload still rejected, happy payload persisted verbatim (no provider keys injected), confirm → 2 buildings + 5 apartments, source stays 'local-mapi', provider_city intact", async () => {
    const block = `e1-${randomUUID().slice(0, 8)}`;
    await seedLookupRow(block, '42', '3', 'עיר-אישור', 32.3, 34.95);
    const svc = await makeSvc(await newLocalMapiProvider());
    const pid = await seedProject(org.id, managerId);

    const created = await svc.create(manager(), pid, {
      blockNumber: block,
      parcelNumber: '42',
      subParcel: '3',
    });
    expect(created.source).toBe(PROVIDER_ID_LOCAL);

    // Strict no-PII Zod intact on a provider-found draft.
    await expect(svc.updatePayload(manager(), created.id, poisonedPayload())).rejects.toBeTruthy();
    expect((await providerSetupRow(created.id)).payload).toBeNull();

    // Happy payload persisted VERBATIM — the provider injected nothing into it.
    await svc.updatePayload(manager(), created.id, happyPayload());
    expect((await providerSetupRow(created.id)).payload).toEqual(happyPayload());

    // Confirm — the P3a contract unchanged on a provider-found draft.
    const confirmed = await svc.confirm(manager(), created.id);
    expect(confirmed.status).toBe('confirmed');
    expect((await buildingsBySetup(created.id)).length).toBe(2);
    expect((await apartmentsBySetup(created.id)).length).toBe(5);

    // The review flag + stamped city SURVIVE the confirm.
    const row = await providerSetupRow(created.id);
    expect(row.status).toBe('confirmed');
    expect(row.source).toBe(PROVIDER_ID_LOCAL);
    expect(row.provider_city).toBe('עיר-אישור');
  }, 30_000);

  it('E2) zero-PII egress (§5): the lookup query carries ONLY blockNumber/parcelNumber/subParcel — never the project name, org, or user identifiers', async () => {
    const secret = `סודי-${randomUUID().slice(0, 8)}`;
    const pid = await seedProject(org.id, managerId, `פרויקט ${secret}`);

    const calls: Array<Record<string, unknown>> = [];
    const recording: ParcelDataProviderLike = {
      lookup: async (q) => {
        calls.push(q as unknown as Record<string, unknown>);
        return { found: false, providerId: 'recording' };
      },
    };
    const svc = await makeSvc(recording);
    await svc.create(manager(), pid, { blockNumber: '991', parcelNumber: '7', subParcel: '2' });

    // The provider WAS consulted on create (the P3b wiring itself).
    expect(calls.length).toBeGreaterThanOrEqual(1);

    // Only the public land-registration keys — nothing else.
    const q = calls[0]!;
    for (const k of Object.keys(q)) {
      if (q[k] === undefined) continue;
      expect(['blockNumber', 'parcelNumber', 'subParcel']).toContain(k);
    }
    expect(q['blockNumber']).toBe('991');
    expect(q['parcelNumber']).toBe('7');
    expect(q['subParcel']).toBe('2');

    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain(secret); // project name never leaves
    expect(serialized).not.toContain(org.id); // org id never leaves
    expect(serialized).not.toContain(managerId); // user id never leaves
    expect(serialized).not.toContain('@test.local'); // no emails
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// F) migration-journal pin (M-1 silent-skip guard) + no-RLS rationale doc
// ───────────────────────────────────────────────────────────────────────────
describe('parcel_lookup · migration journal + sql pins', () => {
  it(`F1) journal: a parcel_lookup entry exists with \`when\` > ${JOURNAL_MAX_WHEN_BEFORE_P3B} AND strictly greater than EVERY other entry; its .sql exists and documents the no-RLS (public national record) rationale`, () => {
    const journalUrl = new URL(
      '../../../../../packages/db/migrations/meta/_journal.json',
      import.meta.url,
    );
    const journal = z
      .object({
        entries: z.array(z.object({ idx: z.number(), when: z.number(), tag: z.string() })),
      })
      .parse(JSON.parse(readFileSync(journalUrl, 'utf8')));

    const entry = journal.entries.find((e) => JOURNAL_TAG_RE.test(e.tag));
    expect(
      entry,
      '[RED] no parcel_lookup migration journal entry yet — builder must hand-author ' +
        '0074_parcel_lookup.sql AND append a _journal.json entry (when > 1783004400000, e.g. 1783090800000)',
    ).toBeTruthy();
    expect(entry!.when).toBeGreaterThan(JOURNAL_MAX_WHEN_BEFORE_P3B);
    for (const other of journal.entries) {
      if (other === entry) continue;
      // Strictly greater than every PRECEDING entry, or drizzle SILENTLY skips
      // it (memory M-1; dev 0056 was hand-patched for exactly this). Later
      // slices legitimately append NEWER entries with a higher `when` (e.g.
      // 0075_team_messaging — whose own spec carries the live max-`when` M-1
      // guard for itself), so this pin is scoped to entries that PRECEDE 0074 —
      // exactly what "pre-existing" always meant (mirrors parcel-setups.spec G2).
      if (other.idx > entry!.idx) continue;
      expect(entry!.when).toBeGreaterThan(other.when);
    }

    // The .sql itself: exists + the GLOBAL/no-RLS posture is documented in a
    // comment (the spec REQUIRES the rationale to live in the migration).
    const sqlPath = fileURLToPath(
      new URL(`../../../../../packages/db/migrations/${entry!.tag}.sql`, import.meta.url),
    );
    expect(existsSync(sqlPath), `[RED] ${entry!.tag}.sql missing`).toBe(true);
    const sql = readFileSync(sqlPath, 'utf8');
    expect(sql).toMatch(/parcel_lookup/);
    expect(sql).toMatch(/rls/i); // the no-RLS rationale comment
  });
});

// ───────────────────────────────────────────────────────────────────────────
// G) schema posture — GLOBAL reference table (no org_id, no RLS, SELECT-only)
// ───────────────────────────────────────────────────────────────────────────
describe('parcel_lookup · schema posture + parcel_setups provider columns', () => {
  it('G1) parcel_lookup is GLOBAL: expected columns/types, NO org_id, RLS NOT enabled (public national record), app_user = SELECT only (no INSERT/UPDATE/DELETE)', async () => {
    const c = await providerPool.connect();
    try {
      const cols = await c.query<{ column_name: string; data_type: string; is_nullable: string }>(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'parcel_lookup'`,
      );
      expect(
        cols.rows.length,
        '[RED] parcel_lookup table missing — builder must land migration 0074',
      ).toBeGreaterThan(0);
      const byName = new Map(cols.rows.map((r) => [r.column_name, r]));

      // The §6-P3b columns (a surrogate id is tolerated as an EXTRA column).
      expect(byName.get('block_number')?.data_type).toBe('text');
      expect(byName.get('block_number')?.is_nullable).toBe('NO');
      expect(byName.get('parcel_number')?.data_type).toBe('text');
      expect(byName.get('parcel_number')?.is_nullable).toBe('NO');
      expect(byName.get('sub_parcel')?.data_type).toBe('text');
      expect(byName.get('sub_parcel')?.is_nullable).toBe('YES');
      expect(byName.get('city')?.data_type).toBe('text');
      expect(byName.get('city')?.is_nullable).toBe('YES');
      expect(byName.get('centroid_lat')?.data_type).toBe('double precision');
      expect(byName.get('centroid_lng')?.data_type).toBe('double precision');

      // GLOBAL national record — NO tenant key.
      expect(byName.has('org_id')).toBe(false);

      // NO RLS (deliberate — unlike every tenant table; rationale in 0074).
      const cat = await c.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
         WHERE oid = 'public.parcel_lookup'::regclass`,
      );
      expect(cat.rows[0]!.relrowsecurity).toBe(false);
      expect(cat.rows[0]!.relforcerowsecurity).toBe(false);

      // app_user: SELECT only — the loader runs as the owner role.
      const priv = async (p: string): Promise<boolean> => {
        const r = await c.query<{ ok: boolean }>(
          `SELECT has_table_privilege('app_user', 'public.parcel_lookup', $1) AS ok`,
          [p],
        );
        return r.rows[0]!.ok;
      };
      expect(await priv('SELECT')).toBe(true);
      expect(await priv('INSERT')).toBe(false);
      expect(await priv('UPDATE')).toBe(false);
      expect(await priv('DELETE')).toBe(false);
    } catch (e) {
      redIfMissing(e, 'parcel_lookup schema posture');
    } finally {
      c.release();
    }
  }, 30_000);

  it('G2) uniqueness: an exact duplicate (block,parcel,sub) triple INSERT → 23505 (the upsert conflict target exists)', async () => {
    const block = `g2-${randomUUID().slice(0, 8)}`;
    await seedLookupRow(block, '5', '1', 'תל אביב', 32.0, 34.7);
    const c = await providerPool.connect();
    try {
      const err = await c
        .query(
          `INSERT INTO parcel_lookup
             (block_number, parcel_number, sub_parcel, city, centroid_lat, centroid_lng)
           VALUES ($1, '5', '1', 'תל אביב', 32.0, 34.7)`,
          [block],
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(
        err,
        '[RED] duplicate (block,parcel,sub) was accepted — builder must add the unique index/constraint the loader upserts against',
      ).toBeTruthy();
      const code =
        (err as { cause?: { code?: string }; code?: string }).cause?.code ??
        (err as { code?: string }).code;
      expect(code).toBe('23505');
    } finally {
      c.release();
    }
  }, 30_000);

  it('G3) parcel_setups gained provider_city + provider_status (both text NULL, in migration 0074 — NOT a third migration)', async () => {
    const c = await providerPool.connect();
    try {
      const cols = await c.query<{ column_name: string; data_type: string; is_nullable: string }>(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'parcel_setups'
           AND column_name IN ('provider_city', 'provider_status')`,
      );
      const byName = new Map(cols.rows.map((r) => [r.column_name, r]));
      expect(
        byName.has('provider_city'),
        '[RED] parcel_setups.provider_city missing — builder must add it in 0074',
      ).toBe(true);
      expect(
        byName.has('provider_status'),
        '[RED] parcel_setups.provider_status missing — builder must add it in 0074',
      ).toBe(true);
      expect(byName.get('provider_city')?.data_type).toBe('text');
      expect(byName.get('provider_city')?.is_nullable).toBe('YES');
      expect(byName.get('provider_status')?.data_type).toBe('text');
      expect(byName.get('provider_status')?.is_nullable).toBe('YES');
    } finally {
      c.release();
    }
  }, 30_000);
});
