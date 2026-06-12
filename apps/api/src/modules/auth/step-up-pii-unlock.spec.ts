/**
 * 7b-OTP — PII step-up unlock + sensitive-document gate (TEST-AUTHOR,
 * independent, RED-first). DO NOT modify implementation/schema/migration to
 * make these pass — that is the builder's job. This file only asserts the
 * target behavior per docs/DESIGN-phase5-tabu-extraction.md D-P5.5 / D-P5.7 /
 * D-P5.8 (owner decisions 2026-06-12).
 *
 * SPEC PINNED BY THESE TESTS:
 *
 *   Migration 0070 (`when` MUST be > 1782658800000 of 0069; suggested
 *   1782745200000), hand-authored .sql + meta/_journal.json entry:
 *     - ALTER documents ADD sensitive boolean NOT NULL DEFAULT false;
 *       backfill: UPDATE documents SET sensitive = true
 *                 WHERE type IN ('id_document','financial');
 *     - ALTER auth_sessions ADD pii_unlocked_at timestamptz NULL.
 *
 *   Org settings (packages/shared-types/src/org-settings.ts):
 *     - NEW namespace `security` with leaf `piiUnlockTtlMinutes`
 *       (int, default 60, min 5, max 480) — same .default({})/.catch pattern
 *       as the sibling namespaces; PATCHable via OrgSettingsPatchSchema
 *       (strict, bounds carried over → out-of-bounds = 400).
 *
 *   Step-up service (EXPECTED apps/api/src/modules/auth/step-up.service.ts):
 *     - export class StepUpService {
 *         constructor(email: IEmailProvider)   // the EMAIL_PROVIDER token
 *         request(user: AccessTokenPayload): Promise<void>
 *           → generates an OTP (CSPRNG, 6 digits), stores ONLY a hash at rest
 *             (reuse the otp.service.ts core: hashField/attempts/expiry),
 *             delivers it via EMAIL to the org user's email. Rate-limited
 *             (mirrors tenant OTP: 3 requests / 15 min — the 4th sends no
 *             email). The CODE itself is never logged / returned.
 *         verify(user: AccessTokenPayload, code: string): Promise<void>
 *           → right code: stamps auth_sessions.pii_unlocked_at = now() on the
 *             CALLER'S CURRENT session (user.sid) ONLY + audits
 *             'session.pii_unlocked'. Wrong code: attempts decrement →
 *             lockout after 5 (mirrors tenant MAX_ATTEMPTS); after lockout
 *             even the correct code rejects. A sid with no live
 *             auth_sessions row → reject, nothing stamped.
 *       }
 *       (If the builder's constructor arity differs, fix makeStepUpSvc —
 *       the ONE adjust point.)
 *
 *   Endpoints (the builder must register + add gen-api-docs ENDPOINTS
 *   entries — the api-docs-coverage guard fails CI otherwise):
 *     - POST /api/v1/auth/step-up/request   (AuthGuard, org user)
 *     - POST /api/v1/auth/step-up/verify    { code }
 *
 *   THE GATE (DocumentsService.getDownloadUrl — where the presigned GET is
 *   minted; same path serves preview via disposition):
 *     - documents.sensitive = true AND the caller's session (user.sid) has NO
 *       valid unlock (pii_unlocked_at IS NULL, OR pii_unlocked_at + ttl <=
 *       now() where ttl = org settings security.piiUnlockTtlMinutes,
 *       default 60) → 403 { error: { code: 'pii_step_up_required' } }.
 *       DISTINCT + actionable; NOT 404 (the caller is already authorized to
 *       know the doc exists — the visibility check ran first).
 *     - sensitive + VALID unlock → presigned URL returned + the download is
 *       audited (existing 'document.download' row).
 *     - NON-sensitive doc → NO OTP needed; behavior byte-for-byte unchanged
 *       (D-P5.7 — the gate applies ONLY to sensitive docs).
 *
 *   Sensitive derivation (create path):
 *     - server derives sensitive=true for type id_document / financial;
 *     - CreateDocumentInput gains OPTIONAL `sensitive` (boolean) — the client
 *       may explicitly turn it ON for any type; it can NEVER force OFF a
 *       sensitive-by-type doc (id_document + sensitive:false → still true);
 *     - creating a tabu extraction on a non-sensitive source doc MARKS the
 *       doc sensitive (the נסח holds PII; marking is the 7a-friendly choice).
 *
 * LAYER + RED MODEL (honest):
 *   Real-DB, in-process service harness (mirrors documents-scan-gate.spec +
 *   tabu-extraction-run.spec + otp-security.spec). RED today because:
 *     - migration 0070 has not landed → `sensitive` / `pii_unlocked_at`
 *       columns missing (42703 undefined_column) → M/C/E tests fail;
 *     - ./step-up.service does not exist → a guarded makeStepUpSvc throws a
 *       clear [RED] message → A/B tests fail;
 *     - org-settings has no `security` namespace → F tests fail (the PATCH
 *       schema strict-rejects the namespace; the default tree lacks it);
 *     - gen-api-docs.ts has no step-up ENDPOINTS entries → G fails.
 *   D1 (non-sensitive unchanged) is GREEN today BY DESIGN — it pins the
 *   D-P5.7 "only sensitive docs" scope as a regression guard.
 *
 * Run:
 *   infisical run --env=dev -- pnpm --filter @emapp/api exec \
 *     vitest run src/modules/auth/step-up-pii-unlock.spec.ts
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  FakeEmailProvider,
  NoopFileScanProvider,
  organizations,
  withTenant,
  type IExtractionProvider,
  type IStorageProvider,
} from '@emapp/db';
import {
  CreateDocumentInput,
  DEFAULT_ORG_SETTINGS,
  OrgSettingsPatchSchema,
  resolveOrgSettings,
  type CreateDocument,
} from '@emapp/shared-types';
import { HttpException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import { DocumentsService } from '../documents/documents.service';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';
import { TabuExtractionsService } from '../tabu/tabu-extractions.service';

import type { AccessTokenPayload } from './auth.service';

// ── Pinned contract names (the builder must provide; single adjust points) ──
const STEP_UP_SERVICE_MODULE = './step-up.service';
const STEP_UP_SERVICE_CLASS = 'StepUpService';
const PII_STEP_UP_REQUIRED = 'pii_step_up_required';
const AUDIT_UNLOCK_ACTION = 'session.pii_unlocked';
/** 0069's journal `when` — the new migration MUST be strictly greater. */
const PREV_MIGRATION_WHEN = 1782658800000;
/** Mirrors tenant OTP (otp.service.ts): RL_MAX=3 / 15 min, MAX_ATTEMPTS=5. */
const RL_MAX = 3;
const MAX_ATTEMPTS = 5;

const GET_URL = 'https://r2.example.test/presigned-get';
const PUT_URL = 'https://r2.example.test/presigned-put';

const MIGRATIONS_DIR = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../../packages/db/migrations',
);
const GEN_API_DOCS = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../../apps/api/scripts/gen-api-docs.ts',
);

// ── stub providers (scan-gate-spec shapes) ──────────────────────────────────
class StubStorage implements IStorageProvider {
  public readonly deleted: string[] = [];
  async getUploadUrl(): Promise<string> {
    return PUT_URL;
  }
  async getDownloadUrl(): Promise<string> {
    return GET_URL;
  }
  async head(): Promise<null> {
    return null;
  }
  async delete(key: string): Promise<void> {
    this.deleted.push(key);
  }
  async getObjectStream(): Promise<Readable> {
    return Readable.from([Buffer.from('%PDF-1.4 fake bytes')]);
  }
  async healthCheck(): Promise<void> {}
}

/** Inert extraction provider — TabuExtractionsService.create() never calls it. */
const inertExtractionProvider = {
  async extract(): Promise<never> {
    throw new Error('extract() must not be called by create()');
  },
} as unknown as IExtractionProvider;

// ── identities / fixtures ───────────────────────────────────────────────────
let org: TestOrg;
let orgB: TestOrg; // separate org for the ttl=120 case (settings isolation)
let managerId: string;
let projectId: string;
let testStart: Date;

function payload(userId: string, orgId: string, sid: string): AccessTokenPayload {
  return {
    sub: userId,
    orgId,
    role: 'manager',
    sid,
    type: 'access',
  } as unknown as AccessTokenPayload;
}

function errCode(e: unknown): string | undefined {
  if (e instanceof Error && 'getResponse' in e) {
    const body = (e as { getResponse: () => unknown }).getResponse();
    const code = (body as { error?: { code?: unknown } })?.error?.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function errStatus(e: unknown): number | undefined {
  return e instanceof HttpException ? e.getStatus() : undefined;
}

// ── raw-SQL helpers (providerPool = BYPASSRLS; auth tables have no RLS) ─────

/** Fresh org USER (manager membership) with a unique email — step-up delivers
 *  to the user's email, so each test isolates its own inbox expectations. */
async function seedOrgUser(orgId: string): Promise<{ id: string; email: string }> {
  const email = `stepup-${randomUUID()}@test.local`;
  const c = await providerPool.connect();
  try {
    const u = await c.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash)
       VALUES ($1, 'StepUp User', '$2b$12$placeholder') RETURNING id`,
      [email],
    );
    await c.query(
      `INSERT INTO memberships (user_id, org_id, role, accepted_at)
       VALUES ($1, $2, 'manager', now())`,
      [u.rows[0]!.id, orgId],
    );
    return { id: u.rows[0]!.id, email };
  } finally {
    c.release();
  }
}

/** A live auth_sessions row (the domain session the verify stamps). */
async function seedSession(userId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO auth_sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '30 days') RETURNING id`,
      [userId, `stepup-test-${randomUUID()}`],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Set pii_unlocked_at via a SQL interval expression (or NULL).
 *  RED today: 42703 undefined_column until migration 0070 lands. */
async function setUnlock(sessionId: string, agoMinutes: number | null): Promise<void> {
  const c = await providerPool.connect();
  try {
    if (agoMinutes === null) {
      await c.query(`UPDATE auth_sessions SET pii_unlocked_at = NULL WHERE id = $1`, [sessionId]);
    } else {
      await c.query(
        `UPDATE auth_sessions
         SET pii_unlocked_at = now() - make_interval(mins => $2::int)
         WHERE id = $1`,
        [sessionId, agoMinutes],
      );
    }
  } finally {
    c.release();
  }
}

async function readUnlock(sessionId: string): Promise<Date | null> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ pii_unlocked_at: Date | null }>(
      `SELECT pii_unlocked_at FROM auth_sessions WHERE id = $1`,
      [sessionId],
    );
    return r.rows[0]?.pii_unlocked_at ?? null;
  } finally {
    c.release();
  }
}

/** Seed a FINALIZED (uploaded + scan-clean) document via raw SQL.
 *  `sensitive: true` includes the new column explicitly (RED until 0070);
 *  `sensitive: 'omit'` leaves the column out entirely (works pre-migration —
 *  used by the D-P5.7 unchanged-behavior test). */
async function seedFinalizedDoc(opts: {
  orgId: string;
  uploaderId: string;
  apartmentId?: string;
  projectId?: string;
  type?: string;
  sensitive: true | 'omit';
}): Promise<string> {
  const r2Key = `org/${opts.orgId}/doc/${randomUUID()}`;
  const cols = [
    'org_id',
    'name',
    'type',
    'mime_type',
    'size_bytes',
    'r2_key',
    'content_hash',
    'uploaded_by',
    'uploaded_at',
    'scan_status',
  ];
  const vals: unknown[] = [
    opts.orgId,
    'nesach.pdf',
    opts.type ?? 'other',
    'application/pdf',
    100,
    r2Key,
    `h-${randomUUID()}`,
    opts.uploaderId,
  ];
  let placeholders = vals.map((_v, i) => `$${i + 1}`).join(', ') + `, now(), 'clean'`;
  if (opts.apartmentId) {
    cols.push('apartment_id');
    vals.push(opts.apartmentId);
    placeholders += `, $${vals.length}`;
  }
  if (opts.projectId) {
    cols.push('project_id');
    vals.push(opts.projectId);
    placeholders += `, $${vals.length}`;
  }
  if (opts.sensitive === true) {
    cols.push('sensitive');
    placeholders += `, true`;
  }
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO documents (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
      vals,
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Read documents.sensitive (RED today: 42703 undefined_column). */
async function docSensitive(docId: string): Promise<boolean> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ sensitive: boolean }>(
      `SELECT sensitive FROM documents WHERE id = $1`,
      [docId],
    );
    return r.rows[0]!.sensitive;
  } finally {
    c.release();
  }
}

async function seedApartment(pid: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const b = await c.query<{ id: string }>(
      `INSERT INTO buildings (project_id, address, city)
       VALUES ($1, $2, 'Tel Aviv') RETURNING id`,
      [pid, `StepUp ${Date.now()}-${Math.random()}`],
    );
    const a = await c.query<{ id: string }>(
      `INSERT INTO apartments (building_id, number) VALUES ($1, $2) RETURNING id`,
      [b.rows[0]!.id, `SU-${Date.now()}-${Math.random()}`],
    );
    return a.rows[0]!.id;
  } finally {
    c.release();
  }
}

async function auditCount(orgId: string, action: string, targetId?: string): Promise<number> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
       WHERE org_id = $1 AND action = $2 AND created_at >= $3
         AND ($4::uuid IS NULL OR target_id = $4::uuid)`,
      [orgId, action, testStart, targetId ?? null],
    );
    return Number(r.rows[0]!.n);
  } finally {
    c.release();
  }
}

/** Plant a STORED org-settings jsonb (the seam's raw write path). */
async function setStoredSettings(orgId: string, value: unknown): Promise<void> {
  await withTenant(orgId, async (tx) => {
    await tx
      .update(organizations)
      .set({ settings: value as Record<string, unknown> })
      .where(eq(organizations.id, orgId));
  });
}

/**
 * Hashed-at-rest proof, implementation-agnostic on the builder's storage
 * choice: scan EVERY text-ish column in any table whose name mentions
 * otp/step (plus any column named like %code%) for the PLAINTEXT code. The
 * 6-digit CSPRNG code makes an accidental equality collision negligible.
 */
async function plaintextCodeFoundAtRest(code: string): Promise<string | null> {
  const c = await providerPool.connect();
  try {
    const cols = await c.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND data_type IN ('text', 'character varying')
         AND (table_name ~* '(otp|step)' OR column_name ~* 'code')`,
    );
    for (const { table_name, column_name } of cols.rows) {
      // identifiers come from information_schema; defensive re-validation.
      if (!/^[a-z0-9_]+$/.test(table_name) || !/^[a-z0-9_]+$/.test(column_name)) continue;
      const hit = await c.query(
        `SELECT 1 FROM "${table_name}" WHERE "${column_name}" = $1 LIMIT 1`,
        [code],
      );
      if ((hit.rowCount ?? 0) > 0) return `${table_name}.${column_name}`;
    }
    return null;
  } finally {
    c.release();
  }
}

// ── step-up service resolution (the RED guard) ──────────────────────────────
interface StepUpSvcLike {
  request: (user: AccessTokenPayload) => Promise<unknown>;
  verify: (user: AccessTokenPayload, code: string) => Promise<unknown>;
}

async function makeStepUpSvc(email: FakeEmailProvider): Promise<StepUpSvcLike> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(STEP_UP_SERVICE_MODULE)) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `[RED] ${STEP_UP_SERVICE_MODULE} import failed — builder must land the ` +
        `7b-OTP step-up service. Cause: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const Ctor = mod[STEP_UP_SERVICE_CLASS] as (new (...args: unknown[]) => unknown) | undefined;
  if (typeof Ctor !== 'function') {
    throw new Error(`[RED] ${STEP_UP_SERVICE_CLASS} not exported from ${STEP_UP_SERVICE_MODULE}.`);
  }
  let instance: unknown;
  try {
    instance = new Ctor(email);
  } catch (e) {
    throw new Error(
      `[RED] new ${STEP_UP_SERVICE_CLASS}(emailProvider) failed — expected a constructor ` +
        `accepting the EMAIL_PROVIDER (IEmailProvider). ` +
        `Cause: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const probe = instance as Record<string, unknown>;
  if (typeof probe['request'] !== 'function' || typeof probe['verify'] !== 'function') {
    throw new Error(
      `[RED] ${STEP_UP_SERVICE_CLASS}.request()/.verify() missing — builder must add them.`,
    );
  }
  return instance as StepUpSvcLike;
}

/** Extract the 6-digit OTP from the captured email (text first, then html). */
function codeFromEmail(email: FakeEmailProvider, to: string): string {
  const msg = [...email.sent].reverse().find((m) => m.to === to);
  expect(msg, `no step-up email captured for ${to}`).toBeTruthy();
  const haystack = `${(msg as { text?: string }).text ?? ''}\n${(msg as { html?: string }).html ?? ''}`;
  const m = haystack.match(/\b(\d{6})\b/);
  expect(m, 'step-up email does not contain a 6-digit code').toBeTruthy();
  return m![1]!;
}

function makeDocsSvc(): DocumentsService {
  return new DocumentsService(
    new StubStorage(),
    new NoopFileScanProvider(),
    new NotificationsProducerService(),
  );
}

function docInput(over: Record<string, unknown> = {}): CreateDocument {
  return {
    name: 'doc.pdf',
    type: 'agreement',
    mimeType: 'application/pdf',
    sizeBytes: 100,
    contentHash: `h-${randomUUID()}`,
    projectId,
    ...over,
  } as unknown as CreateDocument;
}

beforeAll(async () => {
  await setupTestDatabase();
  testStart = new Date(Date.now() - 5_000);
  const tag = `s7b-stepup-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  orgB = await createTestOrg(`${tag}-b`, `${tag}-b`);
  managerId = org.users[0]!.id;
  projectId = org.projects[0]!.id;
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

// ───────────────────────────────────────────────────────────────────────────
// M) migration 0070 — schema + journal + backfill
// ───────────────────────────────────────────────────────────────────────────
describe('7b-OTP · M) migration 0070 (sensitive + pii_unlocked_at)', () => {
  it('M1) documents.sensitive — boolean NOT NULL DEFAULT false', async () => {
    const c = await providerPool.connect();
    try {
      const r = await c.query<{ data_type: string; is_nullable: string; column_default: string }>(
        `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema='public' AND table_name='documents' AND column_name='sensitive'`,
      );
      expect(r.rows.length, '[RED] documents.sensitive column missing (migration 0070)').toBe(1);
      expect(r.rows[0]!.data_type).toBe('boolean');
      expect(r.rows[0]!.is_nullable).toBe('NO');
      expect(r.rows[0]!.column_default).toContain('false');
    } finally {
      c.release();
    }
  }, 30_000);

  it('M2) auth_sessions.pii_unlocked_at — timestamptz NULL', async () => {
    const c = await providerPool.connect();
    try {
      const r = await c.query<{ data_type: string; is_nullable: string }>(
        `SELECT data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema='public' AND table_name='auth_sessions'
           AND column_name='pii_unlocked_at'`,
      );
      expect(
        r.rows.length,
        '[RED] auth_sessions.pii_unlocked_at column missing (migration 0070)',
      ).toBe(1);
      expect(r.rows[0]!.data_type).toBe('timestamp with time zone');
      expect(r.rows[0]!.is_nullable).toBe('YES');
    } finally {
      c.release();
    }
  }, 30_000);

  it('M3) journal entry `when` > 0069 + the .sql backfills id_document/financial', () => {
    const sqlFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    const migFile = sqlFiles.find((f) =>
      readFileSync(join(MIGRATIONS_DIR, f), 'utf8').includes('pii_unlocked_at'),
    );
    expect(
      migFile,
      '[RED] no migration .sql mentions pii_unlocked_at — builder must hand-author 0070',
    ).toBeTruthy();
    const sqlText = readFileSync(join(MIGRATIONS_DIR, migFile!), 'utf8');
    // Backfill — existing id-document/financial rows become sensitive.
    expect(sqlText).toMatch(/UPDATE\s+documents/i);
    expect(sqlText).toContain('id_document');
    expect(sqlText).toContain('financial');
    // Journal entry exists with `when` strictly greater than 0069's — the
    // migrator SILENTLY SKIPS a migration whose `when` <= max-applied (M-1).
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string; when: number }> };
    const tag = migFile!.replace(/\.sql$/, '');
    const entry = journal.entries.find((j) => j.tag === tag);
    expect(entry, `[RED] meta/_journal.json has no entry for ${tag}`).toBeTruthy();
    expect(entry!.when).toBeGreaterThan(PREV_MIGRATION_WHEN);
  }, 30_000);
});

// ───────────────────────────────────────────────────────────────────────────
// A) step-up REQUEST — email delivery, hashed at rest, rate limit
// ───────────────────────────────────────────────────────────────────────────
describe('7b-OTP · A) POST /auth/step-up/request', () => {
  it('A1) request → OTP delivered via the EMAIL provider to the user’s email; hashed at rest (plaintext code NOT stored)', async () => {
    const user = await seedOrgUser(org.id);
    const sid = await seedSession(user.id);
    const email = new FakeEmailProvider();
    const svc = await makeStepUpSvc(email);

    await svc.request(payload(user.id, org.id, sid));

    // Delivered to the USER's verified email (org users have email, not phone).
    expect(email.sent.length).toBeGreaterThan(0);
    const code = codeFromEmail(email, user.email);
    expect(code).toMatch(/^\d{6}$/);

    // Hashed at rest: the PLAINTEXT code must not exist in ANY otp/step/code
    // text column (the otp.service.ts core stores hashField(code) only).
    const found = await plaintextCodeFoundAtRest(code);
    expect(
      found,
      `step-up OTP code stored in PLAINTEXT at ${found ?? ''} — must be hashed at rest`,
    ).toBeNull();
  }, 40_000);

  it(`A2) rate-limit mirrors tenant OTP — the ${RL_MAX + 1}th in-window request sends NO email`, async () => {
    const user = await seedOrgUser(org.id);
    const sid = await seedSession(user.id);
    const email = new FakeEmailProvider();
    const svc = await makeStepUpSvc(email);

    for (let i = 0; i < RL_MAX; i += 1) {
      await svc.request(payload(user.id, org.id, sid));
    }
    const toUser = (): number => email.sent.filter((m) => m.to === user.email).length;
    expect(toUser(), `expected exactly ${RL_MAX} step-up emails after ${RL_MAX} requests`).toBe(
      RL_MAX,
    );

    // One more inside the window — throttled, no new email (generic outcome;
    // whether it throws or no-ops, NO delivery is the invariant).
    await svc.request(payload(user.id, org.id, sid)).catch(() => undefined);
    expect(toUser(), `a ${RL_MAX + 1}th step-up email was sent past the rate limit`).toBe(RL_MAX);
  }, 40_000);
});

// ───────────────────────────────────────────────────────────────────────────
// B) step-up VERIFY — stamp + audit; lockout; session required
// ───────────────────────────────────────────────────────────────────────────
describe('7b-OTP · B) POST /auth/step-up/verify', () => {
  it('B1) right code → THE CALLER’S session pii_unlocked_at stamped (other sessions untouched) + audited session.pii_unlocked', async () => {
    const user = await seedOrgUser(org.id);
    const sid = await seedSession(user.id);
    const otherSid = await seedSession(user.id); // a second live session — must NOT unlock
    const email = new FakeEmailProvider();
    const svc = await makeStepUpSvc(email);

    await svc.request(payload(user.id, org.id, sid));
    const code = codeFromEmail(email, user.email);

    await svc.verify(payload(user.id, org.id, sid), code);

    const stamped = await readUnlock(sid);
    expect(stamped, 'pii_unlocked_at was not stamped on the verifying session').not.toBeNull();
    expect(Date.now() - stamped!.getTime()).toBeLessThan(60_000); // fresh stamp

    // Once-per-SESSION (D-P5.5): the user's OTHER session stays locked.
    expect(await readUnlock(otherSid)).toBeNull();

    // Audited — 'session.pii_unlocked'.
    expect(await auditCount(org.id, AUDIT_UNLOCK_ACTION)).toBeGreaterThan(0);
  }, 40_000);

  it(`B2) lockout mirrors tenant OTP — after ${MAX_ATTEMPTS} wrong codes even the CORRECT code rejects; nothing stamped`, async () => {
    const user = await seedOrgUser(org.id);
    const sid = await seedSession(user.id);
    const email = new FakeEmailProvider();
    const svc = await makeStepUpSvc(email);

    await svc.request(payload(user.id, org.id, sid));
    const correct = codeFromEmail(email, user.email);
    // A wrong code that can never equal the real one (7 digits).
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      let rejected = false;
      try {
        await svc.verify(payload(user.id, org.id, sid), '0000000');
      } catch {
        rejected = true;
      }
      expect(rejected, `wrong code attempt ${i + 1} was ACCEPTED`).toBe(true);
    }

    // Attempts exhausted → the correct code must now be rejected too.
    let correctRejected = false;
    try {
      await svc.verify(payload(user.id, org.id, sid), correct);
    } catch {
      correctRejected = true;
    }
    expect(
      correctRejected,
      'attempt-limit not enforced — correct code accepted after lockout',
    ).toBe(true);
    expect(await readUnlock(sid)).toBeNull();
  }, 40_000);

  it('B3) a sid with NO live auth_sessions row → verify rejects, nothing stamped (session-level feature requires an authenticated session)', async () => {
    const user = await seedOrgUser(org.id);
    const realSid = await seedSession(user.id);
    const ghostSid = randomUUID(); // never inserted
    const email = new FakeEmailProvider();
    const svc = await makeStepUpSvc(email);

    await svc.request(payload(user.id, org.id, realSid));
    const code = codeFromEmail(email, user.email);

    let rejected = false;
    try {
      await svc.verify(payload(user.id, org.id, ghostSid), code);
    } catch {
      rejected = true;
    }
    expect(rejected, 'verify succeeded against a non-existent session').toBe(true);
    expect(await readUnlock(realSid)).toBeNull();
  }, 40_000);
});

// ───────────────────────────────────────────────────────────────────────────
// C) THE GATE — sensitive doc download requires a VALID unlock
// ───────────────────────────────────────────────────────────────────────────
describe('7b-OTP · C) sensitive-document download gate (D-P5.5/7/8)', () => {
  it('C1) sensitive doc + NO unlock → 403 pii_step_up_required (distinct + actionable, NOT 404)', async () => {
    const sid = await seedSession(managerId);
    const docId = await seedFinalizedDoc({
      orgId: org.id,
      uploaderId: managerId,
      projectId,
      sensitive: true,
    });
    const svc = makeDocsSvc();

    let thrown: unknown;
    try {
      await svc.getDownloadUrl(payload(managerId, org.id, sid), docId);
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'sensitive doc served WITHOUT a PII unlock').toBeTruthy();
    expect(errStatus(thrown), 'gate must be 403 (caller IS authorized to know it exists)').toBe(
      403,
    );
    expect(errCode(thrown)).toBe(PII_STEP_UP_REQUIRED);
  }, 40_000);

  it('C2) same doc + VALID unlock (just stamped) → presigned URL minted + download audited', async () => {
    const sid = await seedSession(managerId);
    await setUnlock(sid, 0); // pii_unlocked_at = now()
    const docId = await seedFinalizedDoc({
      orgId: org.id,
      uploaderId: managerId,
      projectId,
      sensitive: true,
    });
    const svc = makeDocsSvc();

    const dl = await svc.getDownloadUrl(payload(managerId, org.id, sid), docId);
    expect(dl.url).toBe(GET_URL);
    // The sensitive view is audited (the download audit row exists for THIS doc).
    expect(await auditCount(org.id, 'document.download', docId)).toBeGreaterThan(0);
  }, 40_000);

  it('C3) EXPIRED unlock (61 min old, default TTL 60) → 403 pii_step_up_required again', async () => {
    const sid = await seedSession(managerId);
    await setUnlock(sid, 61); // older than the 60-min default TTL (D-P5.8)
    const docId = await seedFinalizedDoc({
      orgId: org.id,
      uploaderId: managerId,
      projectId,
      sensitive: true,
    });
    const svc = makeDocsSvc();

    let thrown: unknown;
    try {
      await svc.getDownloadUrl(payload(managerId, org.id, sid), docId);
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'an EXPIRED unlock still opened a sensitive doc').toBeTruthy();
    expect(errStatus(thrown)).toBe(403);
    expect(errCode(thrown)).toBe(PII_STEP_UP_REQUIRED);
  }, 40_000);

  it('D1) NON-sensitive doc → downloads with NO unlock — behavior unchanged (D-P5.7; green today BY DESIGN)', async () => {
    const sid = await seedSession(managerId);
    const docId = await seedFinalizedDoc({
      orgId: org.id,
      uploaderId: managerId,
      projectId,
      sensitive: 'omit', // column untouched → default false post-migration
    });
    const svc = makeDocsSvc();

    const dl = await svc.getDownloadUrl(payload(managerId, org.id, sid), docId);
    expect(dl.url, 'a NON-sensitive doc must never require the OTP step-up').toBe(GET_URL);
  }, 40_000);
});

// ───────────────────────────────────────────────────────────────────────────
// E) sensitive derivation on the create path + tabu marking
// ───────────────────────────────────────────────────────────────────────────
describe('7b-OTP · E) sensitive derivation (create path + tabu extraction)', () => {
  const SID = '00000000-0000-4000-8000-0000000000e1';

  it('E1) type=id_document / financial → server derives sensitive=true', async () => {
    const svc = makeDocsSvc();
    const idDoc = await svc.create(
      payload(managerId, org.id, SID),
      docInput({ type: 'id_document' }),
    );
    expect(await docSensitive(idDoc.document.id)).toBe(true);

    const finDoc = await svc.create(
      payload(managerId, org.id, SID),
      docInput({ type: 'financial' }),
    );
    expect(await docSensitive(finDoc.document.id)).toBe(true);
  }, 40_000);

  it('E2) type=agreement (not sensitive-by-type) → sensitive=false', async () => {
    const svc = makeDocsSvc();
    const doc = await svc.create(payload(managerId, org.id, SID), docInput({ type: 'agreement' }));
    expect(await docSensitive(doc.document.id)).toBe(false);
  }, 40_000);

  it('E3) CreateDocumentInput accepts optional sensitive:true and the create persists it', async () => {
    // The Zod contract gains the optional flag (strict schema → RED today).
    const parsed = CreateDocumentInput.safeParse({
      name: 'doc.pdf',
      type: 'agreement',
      mimeType: 'application/pdf',
      sizeBytes: 100,
      contentHash: 'h-e3',
      sensitive: true,
    });
    expect(
      parsed.success,
      '[RED] CreateDocumentInput must accept the optional `sensitive` flag',
    ).toBe(true);

    const svc = makeDocsSvc();
    const doc = await svc.create(
      payload(managerId, org.id, SID),
      docInput({ type: 'agreement', sensitive: true }),
    );
    expect(await docSensitive(doc.document.id)).toBe(true);
  }, 40_000);

  it('E4) the client flag can only turn ON — sensitive:false on a sensitive-by-type doc is IGNORED', async () => {
    const svc = makeDocsSvc();
    const doc = await svc.create(
      payload(managerId, org.id, SID),
      docInput({ type: 'id_document', sensitive: false }),
    );
    expect(
      await docSensitive(doc.document.id),
      'a client forced sensitive=false on an id_document — the by-type derivation must win',
    ).toBe(true);
  }, 40_000);

  it('E5) creating a tabu extraction on a NON-sensitive source doc MARKS it sensitive (the נסח holds PII)', async () => {
    const aptId = await seedApartment(projectId);
    const docId = await seedFinalizedDoc({
      orgId: org.id,
      uploaderId: managerId,
      apartmentId: aptId,
      type: 'other',
      sensitive: 'omit', // default false
    });
    expect(await docSensitive(docId)).toBe(false);

    const tabuSvc = new TabuExtractionsService(new StubStorage(), inertExtractionProvider);
    await tabuSvc.create(payload(managerId, org.id, SID), aptId, { documentId: docId });

    expect(
      await docSensitive(docId),
      'tabu-extraction create must mark its source נסח sensitive',
    ).toBe(true);
  }, 40_000);
});

// ───────────────────────────────────────────────────────────────────────────
// F) org setting — security.piiUnlockTtlMinutes (D-P5.8)
// ───────────────────────────────────────────────────────────────────────────
describe('7b-OTP · F) org settings security.piiUnlockTtlMinutes', () => {
  interface SecurityNs {
    security?: { piiUnlockTtlMinutes?: number };
  }

  it('F1) default 60 in DEFAULT_ORG_SETTINGS + resolver; stored override 120 resolves to 120', () => {
    const def = DEFAULT_ORG_SETTINGS as unknown as SecurityNs;
    expect(
      def.security?.piiUnlockTtlMinutes,
      '[RED] org-settings `security` namespace with piiUnlockTtlMinutes default 60 missing',
    ).toBe(60);

    const resolved = resolveOrgSettings({
      security: { piiUnlockTtlMinutes: 120 },
    }) as unknown as SecurityNs;
    expect(resolved.security?.piiUnlockTtlMinutes).toBe(120);

    // Fail-soft READ (per-namespace .catch): a malformed value degrades to 60.
    const malformed = resolveOrgSettings({
      security: { piiUnlockTtlMinutes: 'abc' },
    }) as unknown as SecurityNs;
    expect(malformed.security?.piiUnlockTtlMinutes).toBe(60);
  });

  it('F2) PATCH schema: 120 accepted; 2 (< min 5) rejected; 9999 (> max 480) rejected', () => {
    // ACCEPT in-bounds (RED today — the strict patch schema has no `security`).
    const ok = OrgSettingsPatchSchema.safeParse({ security: { piiUnlockTtlMinutes: 120 } });
    expect(
      ok.success,
      '[RED] OrgSettingsPatchSchema must accept security.piiUnlockTtlMinutes (in-bounds)',
    ).toBe(true);
    // Boundary values stay accepted.
    expect(OrgSettingsPatchSchema.safeParse({ security: { piiUnlockTtlMinutes: 5 } }).success).toBe(
      true,
    );
    expect(
      OrgSettingsPatchSchema.safeParse({ security: { piiUnlockTtlMinutes: 480 } }).success,
    ).toBe(true);

    // REJECT out-of-bounds — the floor/ceiling validation (400 at the pipe).
    expect(OrgSettingsPatchSchema.safeParse({ security: { piiUnlockTtlMinutes: 2 } }).success).toBe(
      false,
    );
    expect(
      OrgSettingsPatchSchema.safeParse({ security: { piiUnlockTtlMinutes: 9999 } }).success,
    ).toBe(false);
    // Non-int rejected too.
    expect(
      OrgSettingsPatchSchema.safeParse({ security: { piiUnlockTtlMinutes: 60.5 } }).success,
    ).toBe(false);
  });

  it('F3) the TTL is USED by the gate: ttl=120 → a 90-min-old unlock still opens; default org (60) rejects the same age', async () => {
    // orgB carries the longer TTL — settings are per-org (manager-editable).
    await setStoredSettings(orgB.id, { security: { piiUnlockTtlMinutes: 120 } });
    const mgrB = orgB.users[0]!.id;
    const projB = orgB.projects[0]!.id;

    const sidB = await seedSession(mgrB);
    await setUnlock(sidB, 90); // 90 min old: VALID under ttl=120
    const docB = await seedFinalizedDoc({
      orgId: orgB.id,
      uploaderId: mgrB,
      projectId: projB,
      sensitive: true,
    });
    const svc = makeDocsSvc();
    const dl = await svc.getDownloadUrl(payload(mgrB, orgB.id, sidB), docB);
    expect(dl.url, 'org-configured ttl=120 must honor a 90-min-old unlock').toBe(GET_URL);

    // Control: the DEFAULT org (ttl 60) rejects a 90-min-old unlock.
    const sidA = await seedSession(managerId);
    await setUnlock(sidA, 90);
    const docA = await seedFinalizedDoc({
      orgId: org.id,
      uploaderId: managerId,
      projectId,
      sensitive: true,
    });
    let thrown: unknown;
    try {
      await svc.getDownloadUrl(payload(managerId, org.id, sidA), docA);
    } catch (e) {
      thrown = e;
    }
    expect(errCode(thrown), 'default 60-min TTL must reject a 90-min-old unlock').toBe(
      PII_STEP_UP_REQUIRED,
    );
  }, 40_000);
});

// ───────────────────────────────────────────────────────────────────────────
// G) gen-api-docs coverage — the 2 new routes (builder must add entries)
// ───────────────────────────────────────────────────────────────────────────
describe('7b-OTP · G) gen-api-docs ENDPOINTS entries', () => {
  it('G1) /api/v1/auth/step-up/request + /api/v1/auth/step-up/verify are documented', () => {
    const src = readFileSync(GEN_API_DOCS, 'utf8');
    expect(
      src.includes('/api/v1/auth/step-up/request'),
      '[RED] gen-api-docs.ts lacks the step-up/request ENDPOINTS entry (api-docs-coverage will fail CI)',
    ).toBe(true);
    expect(
      src.includes('/api/v1/auth/step-up/verify'),
      '[RED] gen-api-docs.ts lacks the step-up/verify ENDPOINTS entry',
    ).toBe(true);
  });
});
