/**
 * TABU EXTRACTION — Slice 7b-extract acceptance tests (TEST-AUTHOR, independent,
 * RED-first). DO NOT modify implementation/schema/migration to make these pass —
 * that is the builder's job. This file only asserts the target behavior.
 *
 * SPEC (V12 Phase-5, slice 7b-extract — RUN a pluggable extraction engine on a
 * draft `tabu_extraction` and store the parsed owner/share rows ENCRYPTED):
 *
 *   Migration 0069 (`when` = 1782658800000 > 1782572400000 of 0068):
 *     - NEW table `tabu_extraction_rows`:
 *         id uuid pk, extraction_id uuid → tabu_extractions ON DELETE CASCADE,
 *         org_id uuid, name_encrypted bytea NULL, national_id_encrypted bytea NULL,
 *         share_numerator bigint NULL, share_denominator bigint NULL,
 *         confidence real NULL, edited boolean NOT NULL DEFAULT false,
 *         position int NOT NULL, created_at timestamptz DEFAULT now().
 *       FORCE ROW LEVEL SECURITY + the documents-style org_id tenant_isolation
 *       policy + GRANTs (mirror tabu_extractions 0068 exactly).
 *     - ALTER `tabu_extractions` ADD raw_text_encrypted bytea NULL,
 *       extraction_engine text NULL, extracted_at timestamptz NULL.
 *
 *   Pluggable engine (mirror the ISMSProvider DI-token seam):
 *     - `IExtractionProvider` interface + `EXTRACTION_PROVIDER` DI token +
 *       `extractionProviderFactory()` → returns the real engine when its env
 *       creds are present, ELSE a deterministic `StubExtractionProvider` that
 *       makes NO network call (default). engineId='stub'.
 *     - extract(input: { bytes: Buffer; mimeType: string; text?: string }):
 *         Promise<{ rows: Array<{ name?; nationalId?; shareNumerator?;
 *           shareDenominator?; confidence }>; rawText?: string; engineId: string }>
 *
 *   Service `TabuExtractionsService.runExtraction(user, extractionId)`:
 *     - its OWN named method MUST call requireAgentCapability(tx, user,
 *       'edit_project_data') (D.54 static guard).
 *     - loads the 'draft' extraction (404 if foreign / not-draft);
 *     - reads the source document bytes via the storage provider (the doc's
 *       r2_key);
 *     - calls EXTRACTION_PROVIDER.extract({ bytes, mimeType });
 *     - ENCRYPTS name + national_id (encryptField, PII_ENCRYPTION_KEY) per row;
 *     - INSERTs tabu_extraction_rows (encrypted PII + share + confidence +
 *       position);
 *     - encrypts + stores raw_text on the extraction + stamps extraction_engine
 *       + extracted_at;
 *     - re-run on a draft REPLACES prior rows; NEVER logs PII.
 *
 *   Controller: POST /api/v1/tabu-extractions/:id/extract →
 *     { data: { rowCount, engineId } }.
 *
 * LAYER + RED MODEL (honest):
 *   Real-DB, in-process service harness (mirrors documents-scan-gate.spec's stub
 *   IStorageProvider injection + the 7a tabu-extractions.spec seeders). The
 *   builder has NOT yet:
 *     - landed migration 0069 (no tabu_extraction_rows, no raw_text_encrypted)
 *     - added IExtractionProvider / EXTRACTION_PROVIDER / StubExtractionProvider
 *     - added TabuExtractionsService.runExtraction()
 *   so:
 *     - the schema/RLS tests fail with 42P01 undefined_table
 *       (`tabu_extraction_rows` missing);
 *     - the behavior tests fail because the service / provider seam can't be
 *       resolved yet (a guarded loadRunHarness() throws a clear [RED] message).
 *   They go GREEN once the builder lands all of the above.
 *
 *   EXPECTED names the builder must provide (adjust constants if it differs —
 *   the asserted BEHAVIOR is what matters):
 *     - apps/api/src/modules/tabu/extraction-provider.factory.ts
 *         export const EXTRACTION_PROVIDER = 'EXTRACTION_PROVIDER';
 *         export function extractionProviderFactory(): IExtractionProvider;
 *     - @emapp/db exports: IExtractionProvider, StubExtractionProvider.
 *     - TabuExtractionsService gains a constructor that accepts (in order) an
 *       IStorageProvider and an IExtractionProvider so the test can inject
 *       stubs, plus `runExtraction(user, extractionId)`.
 *       (If the constructor arity/order differs, fix `makeRunSvc` below.)
 *
 * Run:
 *   infisical run --env=dev -- pnpm --filter @emapp/api exec \
 *     vitest run src/modules/tabu/tabu-extraction-run.spec.ts
 */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  db,
  env as dbEnv,
  memberships,
  projectAssignments,
  users,
  type IStorageProvider,
} from '@emapp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';

// ── Expected service / provider seam (adjust if the builder differs) ──────────
const SERVICE_MODULE = './tabu-extractions.service';
const SERVICE_CLASS = 'TabuExtractionsService';
const METHOD_RUN = 'runExtraction';
const PROVIDER_FACTORY_MODULE = './extraction-provider.factory';
const PROVIDER_TOKEN_EXPORT = 'EXTRACTION_PROVIDER';
const PROVIDER_FACTORY_EXPORT = 'extractionProviderFactory';

// A known owner set the stub provider returns. Two owners, shares 1/2 + 1/2.
const OWNER_A = { name: 'דנה כהן', nationalId: '111111118', num: 1, den: 2, confidence: 0.97 };
const OWNER_B = { name: 'יוסי לוי', nationalId: '222222226', num: 1, den: 2, confidence: 0.91 };

// The deterministic on-the-wire format the REAL StubExtractionProvider parses
// (one owner per line: `name|nationalId|num/den`). The stub-storage returns
// THESE bytes for the source doc; the real Stub must decode them to OWNER_A/B.
function stubDocBytes(): Buffer {
  return Buffer.from(
    [
      `${OWNER_A.name}|${OWNER_A.nationalId}|${OWNER_A.num}/${OWNER_A.den}`,
      `${OWNER_B.name}|${OWNER_B.nationalId}|${OWNER_B.num}/${OWNER_B.den}`,
    ].join('\n'),
    'utf8',
  );
}

// ── stub providers ───────────────────────────────────────────────────────────

/** Stub storage that serves a fixed byte buffer for getObjectStream (the
 *  scanner-gate spec's RecordingStorage shape). The bytes ARE the parseable
 *  Tabu text so the real StubExtractionProvider can decode known rows. */
class FixedBytesStorage implements IStorageProvider {
  constructor(private readonly bytes: Buffer) {}
  async getUploadUrl(): Promise<string> {
    return 'https://r2.example.test/put';
  }
  async getDownloadUrl(): Promise<string> {
    return 'https://r2.example.test/get';
  }
  async delete(): Promise<void> {}
  async head(): Promise<null> {
    return null;
  }
  // 7d interface parity — never reached by this suite.
  async putObject(): Promise<void> {}
  async getObjectStream(): Promise<Readable> {
    return Readable.from([this.bytes]);
  }
  async healthCheck(): Promise<void> {}
}

/** A deterministic extraction provider the test controls directly — returns a
 *  FIXED row set regardless of input, so the encrypt/store/replace assertions
 *  don't depend on how the builder's real Stub decodes bytes vs text. Used by
 *  tests 1/2/5. Test 6 separately asserts the DEFAULT factory resolves to the
 *  real Stub (engineId='stub', no creds). */
function makeFixedExtractionProvider(): unknown {
  return {
    async extract(): Promise<{
      rows: Array<{
        name?: string;
        nationalId?: string;
        shareNumerator?: number;
        shareDenominator?: number;
        confidence: number;
      }>;
      rawText?: string;
      engineId: string;
    }> {
      return {
        rows: [
          {
            name: OWNER_A.name,
            nationalId: OWNER_A.nationalId,
            shareNumerator: OWNER_A.num,
            shareDenominator: OWNER_A.den,
            confidence: OWNER_A.confidence,
          },
          {
            name: OWNER_B.name,
            nationalId: OWNER_B.nationalId,
            shareNumerator: OWNER_B.num,
            shareDenominator: OWNER_B.den,
            confidence: OWNER_B.confidence,
          },
        ],
        rawText: stubDocBytes().toString('utf8'),
        engineId: 'stub',
      };
    },
  };
}

// ── identities ───────────────────────────────────────────────────────────────
let org: TestOrg;
let otherOrg: TestOrg;
let managerId: string;
let agentId: string;
let projectId: string;

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

// ── service + provider resolution (the RED guards) ───────────────────────────

interface RunResultLike {
  rowCount?: number;
  engineId?: string;
  data?: { rowCount?: number; engineId?: string };
}
interface RunSvcLike {
  [METHOD_RUN]: (user: AccessTokenPayload, extractionId: string) => Promise<RunResultLike>;
}

/**
 * Build a TabuExtractionsService wired with stub storage + a (provided)
 * extraction provider, then assert it has runExtraction(). Today this THROWS
 * (no constructor accepting deps / no runExtraction) → clean per-test RED.
 *
 * The builder's 7b service is expected to accept (storage, extractionProvider)
 * as its first two constructor args (mirrors DocumentsService(storage, scanner,
 * …)). If the real arity differs, this is the single place to fix.
 */
async function makeRunSvc(
  storage: IStorageProvider,
  extractionProvider: unknown,
): Promise<RunSvcLike> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(SERVICE_MODULE)) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `[RED] ${SERVICE_MODULE} import failed — builder must land 7b. ` +
        `Cause: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const Ctor = mod[SERVICE_CLASS] as (new (...args: unknown[]) => unknown) | undefined;
  if (typeof Ctor !== 'function') {
    throw new Error(`[RED] ${SERVICE_CLASS} not exported from ${SERVICE_MODULE}.`);
  }
  let instance: unknown;
  try {
    instance = new Ctor(storage, extractionProvider);
  } catch (e) {
    throw new Error(
      `[RED] new ${SERVICE_CLASS}(storage, extractionProvider) failed — 7b builder must ` +
        `add a constructor accepting (IStorageProvider, IExtractionProvider). ` +
        `Cause: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const probe = instance as Record<string, unknown>;
  if (typeof probe[METHOD_RUN] !== 'function') {
    throw new Error(`[RED] ${SERVICE_CLASS}.${METHOD_RUN}() missing — builder must add it.`);
  }
  return instance as RunSvcLike;
}

/** Resolve the default extraction provider via the factory (no creds → Stub). */
async function loadDefaultExtractionProvider(): Promise<{ engineId: string; instance: unknown }> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(PROVIDER_FACTORY_MODULE)) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `[RED] ${PROVIDER_FACTORY_MODULE} not found — builder must add the ` +
        `${PROVIDER_TOKEN_EXPORT} token + ${PROVIDER_FACTORY_EXPORT}(). ` +
        `Cause: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (typeof mod[PROVIDER_TOKEN_EXPORT] !== 'string') {
    throw new Error(`[RED] ${PROVIDER_TOKEN_EXPORT} DI token not exported.`);
  }
  const factory = mod[PROVIDER_FACTORY_EXPORT] as (() => unknown) | undefined;
  if (typeof factory !== 'function') {
    throw new Error(`[RED] ${PROVIDER_FACTORY_EXPORT}() not exported.`);
  }
  const instance = factory() as { extract?: unknown; engineId?: unknown };
  if (typeof instance?.extract !== 'function') {
    throw new Error(`[RED] ${PROVIDER_FACTORY_EXPORT}() did not return an IExtractionProvider.`);
  }
  // engineId may be exposed as a property OR derived from a no-op extract; we
  // read it from a deterministic extract of the known bytes (no network).
  const out = (await (instance.extract as (i: unknown) => Promise<{ engineId: string }>)({
    bytes: stubDocBytes(),
    mimeType: 'text/plain',
    text: stubDocBytes().toString('utf8'),
  })) as { engineId: string };
  return { engineId: out.engineId, instance };
}

// ── raw-SQL seeders (providerPool = BYPASSRLS; 7a-spec style) ─────────────────

async function seedAgentMembership(orgId: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `tabu-run-agent-${randomUUID()}@test.local`,
      name: 'Tabu Run Agent',
      passwordHash: '$2b$12$placeholder',
    })
    .returning({ id: users.id });
  await db
    .insert(memberships)
    .values({ userId: u!.id, orgId, role: 'agent', acceptedAt: new Date() });
  return u!.id;
}

async function seedApartment(pid: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const b = await c.query<{ id: string }>(
      `INSERT INTO buildings (project_id, address, city)
       VALUES ($1, $2, 'Tel Aviv') RETURNING id`,
      [pid, `TabuRun ${Date.now()}-${Math.random()}`],
    );
    const a = await c.query<{ id: string }>(
      `INSERT INTO apartments (building_id, number)
       VALUES ($1, $2) RETURNING id`,
      [b.rows[0]!.id, `TR-${Date.now()}-${Math.random()}`],
    );
    return a.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** A FINALIZED document on `apartmentId` with a known r2_key. */
async function seedFinalizedDoc(
  orgId: string,
  uploaderId: string,
  apartmentId: string,
): Promise<{
  id: string;
  r2Key: string;
}> {
  const r2Key = `org/${orgId}/doc/${randomUUID()}`;
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO documents
         (org_id, apartment_id, name, type, mime_type, size_bytes, r2_key,
          content_hash, uploaded_by, uploaded_at, scan_status)
       VALUES ($1, $2, 'nesach.pdf', 'other', 'application/pdf', 100, $3, 'h',
               $4, now(), 'clean')
       RETURNING id`,
      [orgId, apartmentId, r2Key, uploaderId],
    );
    return { id: r.rows[0]!.id, r2Key };
  } finally {
    c.release();
  }
}

/** Insert a DRAFT tabu_extractions envelope directly (independent of the 7a
 *  create() path) and return its id. */
async function seedDraftExtraction(
  orgId: string,
  apartmentId: string,
  sourceDocumentId: string,
  createdBy: string,
): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO tabu_extractions
         (org_id, apartment_id, source_document_id, status, created_by)
       VALUES ($1, $2, $3, 'draft', $4) RETURNING id`,
      [orgId, apartmentId, sourceDocumentId, createdBy],
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

/** Rows persisted for an extraction, with PII DECRYPTED via pgp_sym_decrypt
 *  (the same key the owners path uses). Also returns the RAW ciphertext bytea
 *  so a test can assert it is NOT plaintext. */
interface DecryptedRow {
  position: number;
  name: string | null;
  nationalId: string | null;
  shareNum: string | null;
  shareDen: string | null;
  confidence: number | null;
  edited: boolean;
  nameCipher: Buffer | null;
  nidCipher: Buffer | null;
}
async function readRowsDecrypted(extractionId: string): Promise<DecryptedRow[]> {
  const key = dbEnv.PII_ENCRYPTION_KEY as string;
  const c = await providerPool.connect();
  try {
    const r = await c.query<{
      position: number;
      name: string | null;
      national_id: string | null;
      share_numerator: string | null;
      share_denominator: string | null;
      confidence: number | null;
      edited: boolean;
      name_cipher: Buffer | null;
      nid_cipher: Buffer | null;
    }>(
      `SELECT
         position,
         CASE WHEN name_encrypted IS NULL THEN NULL
              ELSE pgp_sym_decrypt(name_encrypted, $2) END AS name,
         CASE WHEN national_id_encrypted IS NULL THEN NULL
              ELSE pgp_sym_decrypt(national_id_encrypted, $2) END AS national_id,
         share_numerator::text   AS share_numerator,
         share_denominator::text AS share_denominator,
         confidence,
         edited,
         name_encrypted        AS name_cipher,
         national_id_encrypted AS nid_cipher
       FROM tabu_extraction_rows
       WHERE extraction_id = $1
       ORDER BY position ASC`,
      [extractionId, key],
    );
    return r.rows.map((row) => ({
      position: Number(row.position),
      name: row.name,
      nationalId: row.national_id,
      shareNum: row.share_numerator,
      shareDen: row.share_denominator,
      confidence: row.confidence === null ? null : Number(row.confidence),
      edited: row.edited,
      nameCipher: row.name_cipher,
      nidCipher: row.nid_cipher,
    }));
  } finally {
    c.release();
  }
}

/** The extraction envelope's 7b columns, with raw_text DECRYPTED. */
async function readExtractionMeta(extractionId: string): Promise<{
  engine: string | null;
  extractedAt: Date | null;
  rawText: string | null;
  rawCipher: Buffer | null;
}> {
  const key = dbEnv.PII_ENCRYPTION_KEY as string;
  const c = await providerPool.connect();
  try {
    const r = await c.query<{
      extraction_engine: string | null;
      extracted_at: Date | null;
      raw_text: string | null;
      raw_cipher: Buffer | null;
    }>(
      `SELECT
         extraction_engine,
         extracted_at,
         CASE WHEN raw_text_encrypted IS NULL THEN NULL
              ELSE pgp_sym_decrypt(raw_text_encrypted, $2) END AS raw_text,
         raw_text_encrypted AS raw_cipher
       FROM tabu_extractions WHERE id = $1`,
      [extractionId, key],
    );
    const row = r.rows[0]!;
    return {
      engine: row.extraction_engine,
      extractedAt: row.extracted_at,
      rawText: row.raw_text,
      rawCipher: row.raw_cipher,
    };
  } finally {
    c.release();
  }
}

function rowCountOf(res: RunResultLike): number | undefined {
  return res.rowCount ?? res.data?.rowCount;
}

beforeAll(async () => {
  await setupTestDatabase();
  const tag = `s7b-tabu-run-${Date.now()}`;
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
// 1) runExtraction on a draft → rows stored, decrypt-to-assert
// ───────────────────────────────────────────────────────────────────────────
describe('tabu-extraction · runExtraction (parse → encrypt → store)', () => {
  it('1) draft → rows stored; decrypt name+national_id match; shares + confidence + engine stamped', async () => {
    const aptId = await seedApartment(projectId);
    const doc = await seedFinalizedDoc(org.id, managerId, aptId);
    const exId = await seedDraftExtraction(org.id, aptId, doc.id, managerId);

    const svc = await makeRunSvc(
      new FixedBytesStorage(stubDocBytes()),
      makeFixedExtractionProvider(),
    );
    const res = await svc.runExtraction(manager(), exId);

    expect(rowCountOf(res)).toBe(2);

    const rows = await readRowsDecrypted(exId);
    expect(rows.length).toBe(2);

    // Decrypted PII matches the known owner set (ordered by position).
    expect(rows[0]!.name).toBe(OWNER_A.name);
    expect(rows[0]!.nationalId).toBe(OWNER_A.nationalId);
    expect(rows[1]!.name).toBe(OWNER_B.name);
    expect(rows[1]!.nationalId).toBe(OWNER_B.nationalId);

    // Shares + confidence stored.
    expect(rows[0]!.shareNum).toBe(String(OWNER_A.num));
    expect(rows[0]!.shareDen).toBe(String(OWNER_A.den));
    expect(rows[1]!.shareNum).toBe(String(OWNER_B.num));
    expect(rows[1]!.shareDen).toBe(String(OWNER_B.den));
    expect(rows[0]!.confidence).toBeCloseTo(OWNER_A.confidence, 2);

    // edited defaults false; position is 0/1-based but distinct + ordered.
    expect(rows[0]!.edited).toBe(false);
    expect(rows[0]!.position).toBeLessThan(rows[1]!.position);

    // The extraction was stamped: engine + extracted_at + raw_text.
    const meta = await readExtractionMeta(exId);
    expect(meta.engine).toBe('stub');
    expect(meta.extractedAt).not.toBeNull();
    expect(meta.rawText && meta.rawText.length).toBeGreaterThan(0);
  }, 30_000);

  // ─────────────────────────────────────────────────────────────────────────
  // 2) PII encrypted at rest (ciphertext, never plaintext)
  // ─────────────────────────────────────────────────────────────────────────
  it('2) PII + raw_text are CIPHERTEXT at rest (columns are not the plaintext bytes)', async () => {
    const aptId = await seedApartment(projectId);
    const doc = await seedFinalizedDoc(org.id, managerId, aptId);
    const exId = await seedDraftExtraction(org.id, aptId, doc.id, managerId);

    const svc = await makeRunSvc(
      new FixedBytesStorage(stubDocBytes()),
      makeFixedExtractionProvider(),
    );
    await svc.runExtraction(manager(), exId);

    const rows = await readRowsDecrypted(exId);
    expect(rows.length).toBe(2);
    for (const row of rows) {
      // The stored ciphertext must NOT contain the plaintext name / national_id.
      expect(row.nameCipher).not.toBeNull();
      expect(row.nidCipher).not.toBeNull();
      const nameCt = row.nameCipher!.toString('utf8');
      const nidCt = row.nidCipher!.toString('utf8');
      expect(nameCt).not.toContain(OWNER_A.name);
      expect(nameCt).not.toContain(OWNER_B.name);
      expect(nidCt).not.toContain(OWNER_A.nationalId);
      expect(nidCt).not.toContain(OWNER_B.nationalId);
      // pgcrypto pgp_sym_encrypt output begins with the 0xC3 armor/packet byte,
      // never ASCII text — a cheap "this is really ciphertext" pin.
      expect(row.nameCipher!.length).toBeGreaterThan(0);
    }

    // raw_text_encrypted is set AND is not the plaintext.
    const meta = await readExtractionMeta(exId);
    expect(meta.rawCipher).not.toBeNull();
    expect(meta.rawCipher!.toString('utf8')).not.toContain(OWNER_A.nationalId);
    expect(meta.rawText).toContain(OWNER_A.nationalId); // decryptable round-trip
  }, 30_000);

  // ─────────────────────────────────────────────────────────────────────────
  // 5) re-run on a draft REPLACES prior rows
  // ─────────────────────────────────────────────────────────────────────────
  it('5) re-run on the same draft REPLACES prior rows (no duplication)', async () => {
    const aptId = await seedApartment(projectId);
    const doc = await seedFinalizedDoc(org.id, managerId, aptId);
    const exId = await seedDraftExtraction(org.id, aptId, doc.id, managerId);

    const svc = await makeRunSvc(
      new FixedBytesStorage(stubDocBytes()),
      makeFixedExtractionProvider(),
    );
    await svc.runExtraction(manager(), exId);
    const first = await readRowsDecrypted(exId);
    expect(first.length).toBe(2);

    // Second run on the SAME draft → still exactly 2 rows (the first run's are
    // gone; only the second run's remain).
    const res2 = await svc.runExtraction(manager(), exId);
    expect(rowCountOf(res2)).toBe(2);
    const second = await readRowsDecrypted(exId);
    expect(second.length).toBe(2);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// 3) D.54 capability gate
// ───────────────────────────────────────────────────────────────────────────
describe('tabu-extraction · runExtraction isolation + capability', () => {
  it('3) assigned agent WITHOUT edit_project_data → rejects, NO rows (D.54)', async () => {
    const aptId = await seedApartment(projectId);
    const doc = await seedFinalizedDoc(org.id, managerId, aptId);
    const exId = await seedDraftExtraction(org.id, aptId, doc.id, managerId);

    const svc = await makeRunSvc(
      new FixedBytesStorage(stubDocBytes()),
      makeFixedExtractionProvider(),
    );

    await setAgentCap(false);
    await expect(svc.runExtraction(agent(), exId)).rejects.toBeTruthy();
    expect((await readRowsDecrypted(exId)).length).toBe(0);

    // Sanity: with the capability ON the SAME assigned agent succeeds.
    await setAgentCap(true);
    const ok = await svc.runExtraction(agent(), exId);
    expect(rowCountOf(ok)).toBe(2);
  }, 30_000);

  it('3b) cross-org: a foreign org cannot run extraction on this org’s draft → 404, NO rows', async () => {
    const aptId = await seedApartment(projectId);
    const doc = await seedFinalizedDoc(org.id, managerId, aptId);
    const exId = await seedDraftExtraction(org.id, aptId, doc.id, managerId);

    const svc = await makeRunSvc(
      new FixedBytesStorage(stubDocBytes()),
      makeFixedExtractionProvider(),
    );
    await expect(svc.runExtraction(manager(otherOrg), exId)).rejects.toBeTruthy();
    expect((await readRowsDecrypted(exId)).length).toBe(0);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// 4) RLS — tabu_extraction_rows isolates by org_id
// ───────────────────────────────────────────────────────────────────────────
describe('tabu_extraction_rows · schema + RLS (migration 0069)', () => {
  it('4) RLS isolates by org_id: a foreign org GUC sees ZERO; the owning org sees the rows', async () => {
    const aptId = await seedApartment(projectId);
    const doc = await seedFinalizedDoc(org.id, managerId, aptId);
    const exId = await seedDraftExtraction(org.id, aptId, doc.id, managerId);

    // Seed a row via BYPASSRLS so the RLS read below is the only gate under test.
    {
      const c0 = await providerPool.connect();
      try {
        await c0.query(
          `INSERT INTO tabu_extraction_rows
             (extraction_id, org_id, share_numerator, share_denominator, confidence, position)
           VALUES ($1, $2, 1, 2, 0.9, 0)`,
          [exId, org.id],
        );
      } finally {
        c0.release();
      }
    }

    const c = await providerPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query({
        text: 'SELECT set_config($1, $2, true)',
        values: ['app.organization_id', otherOrg.id],
      });
      const foreign = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM tabu_extraction_rows WHERE extraction_id = $1`,
        [exId],
      );
      expect(Number(foreign.rows[0]!.n)).toBe(0);

      await c.query({
        text: 'SELECT set_config($1, $2, true)',
        values: ['app.organization_id', org.id],
      });
      const own = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM tabu_extraction_rows WHERE extraction_id = $1`,
        [exId],
      );
      expect(Number(own.rows[0]!.n)).toBe(1);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      c.release();
    }
  }, 30_000);

  it('4b) ON DELETE CASCADE: deleting the parent extraction removes its rows', async () => {
    const aptId = await seedApartment(projectId);
    const doc = await seedFinalizedDoc(org.id, managerId, aptId);
    const exId = await seedDraftExtraction(org.id, aptId, doc.id, managerId);

    const c = await providerPool.connect();
    try {
      await c.query(
        `INSERT INTO tabu_extraction_rows
           (extraction_id, org_id, share_numerator, share_denominator, confidence, position)
         VALUES ($1, $2, 1, 2, 0.9, 0)`,
        [exId, org.id],
      );
      await c.query(`DELETE FROM tabu_extractions WHERE id = $1`, [exId]);
      const left = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM tabu_extraction_rows WHERE extraction_id = $1`,
        [exId],
      );
      expect(Number(left.rows[0]!.n)).toBe(0);
    } finally {
      c.release();
    }
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// 6) pluggability — the DEFAULT provider is the Stub, makes NO external call
// ───────────────────────────────────────────────────────────────────────────
describe('tabu-extraction · pluggable engine (DI-token, ISMSProvider-style)', () => {
  it('6) extractionProviderFactory() with no creds → StubExtractionProvider (engineId=stub)', async () => {
    const { engineId } = await loadDefaultExtractionProvider();
    expect(engineId).toBe('stub');
  }, 30_000);

  it('6b) the real Stub DETERMINISTICALLY parses the known `name|nationalId|num/den` bytes', async () => {
    const { instance } = await loadDefaultExtractionProvider();
    const out = await (
      instance as {
        extract: (i: unknown) => Promise<{
          rows: Array<{
            name?: string;
            nationalId?: string;
            shareNumerator?: number;
            shareDenominator?: number;
            confidence: number;
          }>;
          engineId: string;
        }>;
      }
    ).extract({
      bytes: stubDocBytes(),
      mimeType: 'text/plain',
      text: stubDocBytes().toString('utf8'),
    });
    expect(out.rows.length).toBe(2);
    const a = out.rows[0]!;
    expect(a.name).toBe(OWNER_A.name);
    expect(a.nationalId).toBe(OWNER_A.nationalId);
    expect(a.shareNumerator).toBe(OWNER_A.num);
    expect(a.shareDenominator).toBe(OWNER_A.den);
    expect(typeof a.confidence).toBe('number');
  }, 30_000);
});
