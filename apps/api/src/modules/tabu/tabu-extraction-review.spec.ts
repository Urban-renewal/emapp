/**
 * TABU EXTRACTION — Slice 7c acceptance tests: review + confirm loop
 * (TEST-AUTHOR, independent, RED-first). DO NOT modify implementation/schema/
 * migration to make these pass — that is the builder's job. This file only
 * asserts the target behavior per docs/DESIGN-phase5-tabu-extraction.md §5.
 *
 * SPEC PINNED BY THESE TESTS (7c BE):
 *
 *   Migration 0071 (`when` MUST be > 1782745200000 of 0070; suggested
 *   1782831600000), hand-authored .sql + meta/_journal.json entry:
 *     - ALTER ownerships ADD source_extraction_id uuid NULL
 *         REFERENCES tabu_extractions(id);
 *       (provenance: every ownership row written by confirm carries the
 *       extraction it came from; pre-existing rows stay NULL).
 *
 *   Service `TabuExtractionsService` gains THREE methods (single adjust
 *   points below if the builder names differ — the BEHAVIOR is the law):
 *
 *     listRows(user, extractionId) → GET /api/v1/tabu-extractions/:id/rows
 *       - returns the DECRYPTED parsed rows (id, name, nationalId via
 *         decryptField, shareNumerator/shareDenominator, confidence, edited,
 *         position) ONLY when the caller's session holds a VALID pii unlock
 *         (same rule as the 7b-OTP doc gate: auth_sessions.pii_unlocked_at
 *         NOT NULL AND pii_unlocked_at + org security.piiUnlockTtlMinutes
 *         (default 60) > now()). No/expired unlock → 403
 *         { error: { code: 'pii_step_up_required' } } — the extraction is
 *         already visibility-checked first, so never an existence oracle.
 *       - Role masking (D.19/D.47 via resolveOwnerPiiFidelity, D.54): a
 *         VIEWER (fidelity 'masked') gets a •••-masked nationalId (mask
 *         style mirrors the owners NID_MASK: bullets + last 2 chars);
 *         manager (fidelity 'unmasked') gets cleartext. NEVER logged.
 *
 *     updateRow(user, extractionId, rowId, patch) →
 *       PATCH /api/v1/tabu-extractions/:id/rows/:rowId
 *       - patch = { name?, nationalId?, shareNumerator?, shareDenominator? }
 *       - re-ENCRYPTS the edited PII values (pgcrypto, PII_ENCRYPTION_KEY),
 *         sets edited = true. DRAFT-only (non-draft → reject).
 *       - Gated: VALID unlock REQUIRED (403 pii_step_up_required) +
 *         requireAgentCapability(tx, user, 'edit_project_data') called in
 *         THIS named method (D.54 — the static guard does not cover named
 *         service methods).
 *
 *     confirm(user, extractionId) → POST /api/v1/tabu-extractions/:id/confirm
 *       - audit-first ('tabu_extraction.confirm' audit row), IDEMPOTENT:
 *         UPDATE tabu_extractions SET status='confirmed', confirmed_at=now()
 *         WHERE id=:id AND status='draft' — a SECOND confirm (or a non-draft
 *         extraction) → 409 conflict, NOT a double-write.
 *       - ATOMIC in ONE withTenant tx:
 *           * per row: match an EXISTING org owner by national_id HASH
 *             (owners.national_id_hash = hashField(nid, PII_HASH_KEY) —
 *             the import-path dedup mechanism) ELSE create a 3a shell owner
 *             via the owners helper (encryptOwnerPii: name/national_id
 *             encrypted + HMAC hashes set, so the new owner is
 *             hash-matchable);
 *           * REPLACE the apartment's ACTIVE ownerships with the confirmed
 *             rows' fractions (the 3b replaceSet semantics: end-all current
 *             active rows + insert the new set in the SAME tx; the deferred
 *             sum trigger validates fraction-sum = 1 at COMMIT — these tests
 *             seed rows summing to exactly 1);
 *           * stamp ownerships.source_extraction_id = :id on EVERY ownership
 *             written by confirm.
 *       - Gated: VALID unlock REQUIRED (it materializes PII) + the D.54
 *         edit_project_data capability gate in the named method.
 *
 *   The 3 retroactive MINORs (7a/7b code-review):
 *     (a) multi-row keyset pagination on GET /apartments/:id/tabu-extractions
 *         (has_more / cursor walk) — coverage test (behavior exists);
 *     (b) agent getOne on an UNASSIGNED-project apartment → 404 — coverage
 *         test (behavior exists);
 *     (c) the service-level list default limit must equal the DTO default
 *         (ListOwnershipsQuery limit default = 25; the service hardcodes 20
 *         today) — RED until the builder aligns it.
 *
 *   Dev exposure for QA (mirrors EXPOSE_INVITE_TOKEN exactly):
 *     - StepUpService.request returns the generated 6-digit code in its
 *       result (e.g. { code }) IFF process.env.EXPOSE_STEP_UP_CODE === 'true'
 *       AND NODE_ENV is in the STRICT allowlist ('development' | 'test') —
 *       fail-closed for production/unset/typo'd NODE_ENV, exactly like
 *       EXPOSE_INVITE_TOKEN (members/invite-email.ts).
 *     - PINNED: the EXPOSE_STEP_UP_CODE env flag is read AT REQUEST TIME
 *       (not frozen into a module const) so QA can toggle it without
 *       touching module state — and so this test can toggle it. The
 *       NODE_ENV allowlist MAY be a module const.
 *
 * LAYER + RED MODEL (honest):
 *   Real-DB, in-process service harness (mirrors tabu-extraction-run.spec +
 *   step-up-pii-unlock.spec). RED today because:
 *     - migration 0071 has not landed → ownerships.source_extraction_id
 *       missing (M tests; D/E provenance asserts would 42703);
 *     - TabuExtractionsService has no listRows/updateRow/confirm → the
 *       guarded makeReviewSvc() throws a clear [RED] per A/B/C/D/E/F test;
 *     - the service list default is 20, not the DTO's 25 → G3 RED;
 *     - StepUpService.request returns void → H1 RED; no EXPOSE_STEP_UP_CODE
 *       symbol exists in the auth module → H3 RED.
 *   GREEN today BY DESIGN (regression pins, stated honestly):
 *     - G1 (list pagination) + G2 (agent getOne unassigned → 404) — the
 *       retroactive-coverage MINORs (a)+(b): the behavior already exists,
 *       the MISSING TESTS are what the code review flagged;
 *     - H2 (no env flag → code absent) — guards the default-closed posture.
 *
 * Run:
 *   infisical run --env=dev -- pnpm --filter @emapp/api exec \
 *     vitest run src/modules/tabu/tabu-extraction-review.spec.ts
 */
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  FakeEmailProvider,
  db,
  env as dbEnv,
  hashField,
  memberships,
  projectAssignments,
  users,
  type IExtractionProvider,
  type IStorageProvider,
} from '@emapp/db';
import { HttpException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import type { AccessTokenPayload } from '../auth/auth.service';
import { StepUpService } from '../auth/step-up.service';

import { TabuExtractionsService } from './tabu-extractions.service';

// ── Pinned contract names (single adjust points if the builder differs) ─────
const METHOD_ROWS = 'listRows';
const METHOD_PATCH = 'updateRow';
const METHOD_CONFIRM = 'confirm';
const PII_STEP_UP_REQUIRED = 'pii_step_up_required';
const CONFIRM_AUDIT_ACTION = 'tabu_extraction.confirm';
/** 0070's journal `when` — the new provenance migration MUST be strictly
 *  greater (M-1: the migrator SILENTLY SKIPS a `when` <= max-applied). */
const PREV_MIGRATION_WHEN = 1782745200000;
/** The DTO default the service list must align to (MINOR c). */
const DTO_DEFAULT_LIMIT = 25;

const MIGRATIONS_DIR = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../../packages/db/migrations',
);
const AUTH_MODULE_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '../auth');

// Known seeded owners. Valid Israeli-checksum 9-digit ids, all distinct.
const ROW_A = { name: 'דנה כהן', nid: '111111118', num: 1, den: 2, confidence: 0.97 };
const ROW_B = { name: 'יוסי לוי', nid: '222222226', num: 1, den: 2, confidence: 0.91 };
/** An owner that ALREADY exists in the org before confirm (hash-match path). */
const EXISTING_OWNER = { name: 'רחל אברמוב', nid: '333333334' };
/** A brand-new person → confirm must CREATE a 3a shell for them. */
const NEW_OWNER = { name: 'משה פרץ', nid: '444444442' };
/** The pre-confirm ownership holder — must be ENDED by the replace. */
const PRIOR_OWNER = { name: 'שרה גולן', nid: '555555556' };
/** PATCH target values. */
const PATCHED = { name: 'דנה כהן-לוי', nid: '666666664', num: 1, den: 4 };

// ── stub DI deps (the 7c review methods never touch storage/engine) ─────────
class StubStorage implements IStorageProvider {
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
    return Readable.from([Buffer.from('%PDF-1.4 fake bytes')]);
  }
  async healthCheck(): Promise<void> {}
}
const inertExtractionProvider = {
  async extract(): Promise<never> {
    throw new Error('extract() must not be called by the 7c review/confirm path');
  },
} as unknown as IExtractionProvider;

// ── identities ───────────────────────────────────────────────────────────────
let org: TestOrg;
let managerId: string;
let viewerId: string;
let agentId: string;
let projectId: string; // assigned to the agent
let unassignedProjectId: string; // NOT assigned (MINOR b)
let testStart: Date;

function payload(
  userId: string,
  role: 'manager' | 'viewer' | 'agent',
  sid: string,
): AccessTokenPayload {
  return { sub: userId, orgId: org.id, role, sid, type: 'access' } as unknown as AccessTokenPayload;
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

// ── service resolution (the RED guard; single adjust point) ─────────────────
interface WireRow {
  id?: string;
  name?: string | null;
  nationalId?: string | null;
  shareNumerator?: number | null;
  shareDenominator?: number | null;
  confidence?: number | null;
  edited?: boolean;
  position?: number;
}
interface ReviewSvcLike {
  [METHOD_ROWS]: (user: AccessTokenPayload, extractionId: string) => Promise<unknown>;
  [METHOD_PATCH]: (
    user: AccessTokenPayload,
    extractionId: string,
    rowId: string,
    patch: Record<string, unknown>,
  ) => Promise<unknown>;
  [METHOD_CONFIRM]: (user: AccessTokenPayload, extractionId: string) => Promise<unknown>;
}

/** The 7a/7b envelope service — constructible today (G tests). */
function makeEnvelopeSvc(): TabuExtractionsService {
  return new TabuExtractionsService(new StubStorage(), inertExtractionProvider);
}

/** The 7c review service — RED until the builder adds the three methods. */
function makeReviewSvc(): ReviewSvcLike {
  let instance: unknown;
  try {
    instance = makeEnvelopeSvc();
  } catch (e) {
    throw new Error(
      `[RED] new TabuExtractionsService(storage, extractionProvider) failed — if the 7c ` +
        `builder changed the constructor, fix makeEnvelopeSvc (the single adjust point). ` +
        `Cause: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const probe = instance as Record<string, unknown>;
  for (const m of [METHOD_ROWS, METHOD_PATCH, METHOD_CONFIRM]) {
    if (typeof probe[m] !== 'function') {
      throw new Error(`[RED] TabuExtractionsService.${m}() missing — the 7c builder must add it.`);
    }
  }
  return instance as unknown as ReviewSvcLike;
}

/** Unwrap rows from either a bare array or a { data: [...] } envelope. */
function rowsOf(res: unknown): WireRow[] {
  if (Array.isArray(res)) return res as WireRow[];
  const data = (res as { data?: unknown })?.data;
  if (Array.isArray(data)) return data as WireRow[];
  throw new Error(`listRows result is neither an array nor { data: [...] }: ${typeof res}`);
}

// ── raw-SQL seeders (providerPool = BYPASSRLS; 7a/7b-spec style) ─────────────

async function seedUserWithRole(orgId: string, role: 'viewer' | 'agent'): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `tabu-review-${role}-${randomUUID()}@test.local`,
      name: `Tabu Review ${role}`,
      passwordHash: '$2b$12$placeholder',
    })
    .returning({ id: users.id });
  await db.insert(memberships).values({ userId: u!.id, orgId, role, acceptedAt: new Date() });
  return u!.id;
}

async function seedApartment(pid: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const b = await c.query<{ id: string }>(
      `INSERT INTO buildings (project_id, address, city)
       VALUES ($1, $2, 'Tel Aviv') RETURNING id`,
      [pid, `TabuReview ${Date.now()}-${Math.random()}`],
    );
    const a = await c.query<{ id: string }>(
      `INSERT INTO apartments (building_id, number) VALUES ($1, $2) RETURNING id`,
      [b.rows[0]!.id, `TC-${Date.now()}-${Math.random()}`],
    );
    return a.rows[0]!.id;
  } finally {
    c.release();
  }
}

async function seedFinalizedDoc(orgId: string, uploaderId: string, aptId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO documents
         (org_id, apartment_id, name, type, mime_type, size_bytes, r2_key,
          content_hash, uploaded_by, uploaded_at, scan_status, sensitive)
       VALUES ($1, $2, 'nesach.pdf', 'other', 'application/pdf', 100, $3,
               $4, $5, now(), 'clean', true) RETURNING id`,
      [orgId, aptId, `org/${orgId}/doc/${randomUUID()}`, `h-${randomUUID()}`, uploaderId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

async function seedExtraction(
  orgId: string,
  aptId: string,
  docId: string,
  createdBy: string,
  status: 'draft' | 'confirmed' | 'discarded' = 'draft',
): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO tabu_extractions
         (org_id, apartment_id, source_document_id, status, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [orgId, aptId, docId, status, createdBy],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Seed one ENCRYPTED parsed row (pgcrypto in SQL — same key the app uses). */
async function seedEncryptedRow(
  extractionId: string,
  orgId: string,
  row: { name: string; nid: string; num: number; den: number; confidence: number },
  position: number,
): Promise<string> {
  const key = dbEnv.PII_ENCRYPTION_KEY as string;
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO tabu_extraction_rows
         (extraction_id, org_id, name_encrypted, national_id_encrypted,
          share_numerator, share_denominator, confidence, position)
       VALUES ($1, $2, pgp_sym_encrypt($3, $8), pgp_sym_encrypt($4, $8),
               $5, $6, $7, $9) RETURNING id`,
      [extractionId, orgId, row.name, row.nid, row.num, row.den, row.confidence, key, position],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** A full draft fixture: apartment + sensitive finalized doc + draft
 *  extraction + the 2 standard encrypted rows (1/2 + 1/2). */
async function seedDraftWithRows(pid: string = projectId): Promise<{
  aptId: string;
  exId: string;
  rowAId: string;
  rowBId: string;
}> {
  const aptId = await seedApartment(pid);
  const docId = await seedFinalizedDoc(org.id, managerId, aptId);
  const exId = await seedExtraction(org.id, aptId, docId, managerId);
  const rowAId = await seedEncryptedRow(exId, org.id, ROW_A, 0);
  const rowBId = await seedEncryptedRow(exId, org.id, ROW_B, 1);
  return { aptId, exId, rowAId, rowBId };
}

/** A live auth_sessions row + optional unlock age (step-up-spec style). */
async function seedSession(userId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO auth_sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '30 days') RETURNING id`,
      [userId, `tabu-review-${randomUUID()}`],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

async function setUnlock(sessionId: string, agoMinutes: number | null): Promise<void> {
  const c = await providerPool.connect();
  try {
    if (agoMinutes === null) {
      await c.query(`UPDATE auth_sessions SET pii_unlocked_at = NULL WHERE id = $1`, [sessionId]);
    } else {
      await c.query(
        `UPDATE auth_sessions
         SET pii_unlocked_at = now() - make_interval(mins => $2::int) WHERE id = $1`,
        [sessionId, agoMinutes],
      );
    }
  } finally {
    c.release();
  }
}

/** A session WITH a fresh valid unlock — the common happy-path need. */
async function unlockedSession(userId: string): Promise<string> {
  const sid = await seedSession(userId);
  await setUnlock(sid, 0);
  return sid;
}

async function setAgentCap(on: boolean): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE memberships
       SET capabilities = jsonb_set(capabilities, '{edit_project_data}', $1::jsonb)
       WHERE user_id = $2 AND org_id = $3 AND revoked_at IS NULL`,
      [on ? 'true' : 'false', agentId, org.id],
    );
  } finally {
    c.release();
  }
}

/** Toggle the agent's `view_owner_pii` capability — the SINGLE switch that
 *  flips tabu row review between masked (off) and cleartext (on), per
 *  `resolveOwnerPiiFidelity` (D.54). The asymmetry-pin tests (B2/B3) below
 *  assert BOTH sides so a future change that leaks cleartext to a masked role
 *  on tabu — or that breaks legitimate masked review — fails RED here. */
async function setAgentViewOwnerPii(on: boolean): Promise<void> {
  const c = await providerPool.connect();
  try {
    await c.query(
      `UPDATE memberships
       SET capabilities = jsonb_set(capabilities, '{view_owner_pii}', $1::jsonb)
       WHERE user_id = $2 AND org_id = $3 AND revoked_at IS NULL`,
      [on ? 'true' : 'false', agentId, org.id],
    );
  } finally {
    c.release();
  }
}

/** Pre-existing org owner with HMAC hashes — the hash-match target. */
async function seedOwner(orgId: string, name: string, nid: string): Promise<string> {
  const encKey = dbEnv.PII_ENCRYPTION_KEY as string;
  const hashKey = dbEnv.PII_HASH_KEY as string;
  const nameHash = createHmac('sha256', hashKey).update(name).digest();
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO owners
         (org_id, name_encrypted, name_hash, national_id_encrypted, national_id_hash)
       VALUES ($1, pgp_sym_encrypt($2, $6), $3, pgp_sym_encrypt($4, $6), $5)
       RETURNING id`,
      [orgId, name, nameHash, nid, hashField(nid, hashKey), encKey],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** An ACTIVE pre-confirm ownership row (whole apartment, 1/1). */
async function seedActiveOwnership(aptId: string, ownerId: string): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `INSERT INTO ownerships
         (apartment_id, owner_id, ownership_pct, share_numerator, share_denominator, relationship)
       VALUES ($1, $2, 100.00, 1, 1, 'owner') RETURNING id`,
      [aptId, ownerId],
    );
    return r.rows[0]!.id;
  } finally {
    c.release();
  }
}

/** Rows persisted for an extraction with PII DECRYPTED (run-spec style). */
interface DecryptedRow {
  id: string;
  position: number;
  name: string | null;
  nationalId: string | null;
  shareNum: string | null;
  shareDen: string | null;
  edited: boolean;
}
async function readRowsDecrypted(extractionId: string): Promise<DecryptedRow[]> {
  const key = dbEnv.PII_ENCRYPTION_KEY as string;
  const c = await providerPool.connect();
  try {
    const r = await c.query<{
      id: string;
      position: number;
      name: string | null;
      national_id: string | null;
      share_numerator: string | null;
      share_denominator: string | null;
      edited: boolean;
    }>(
      `SELECT id, position,
         CASE WHEN name_encrypted IS NULL THEN NULL
              ELSE pgp_sym_decrypt(name_encrypted, $2) END AS name,
         CASE WHEN national_id_encrypted IS NULL THEN NULL
              ELSE pgp_sym_decrypt(national_id_encrypted, $2) END AS national_id,
         share_numerator::text AS share_numerator,
         share_denominator::text AS share_denominator,
         edited
       FROM tabu_extraction_rows WHERE extraction_id = $1 ORDER BY position ASC`,
      [extractionId, key],
    );
    return r.rows.map((row) => ({
      id: row.id,
      position: Number(row.position),
      name: row.name,
      nationalId: row.national_id,
      shareNum: row.share_numerator,
      shareDen: row.share_denominator,
      edited: row.edited,
    }));
  } finally {
    c.release();
  }
}

async function readExtractionStatus(
  extractionId: string,
): Promise<{ status: string; confirmedAt: Date | null }> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ status: string; confirmed_at: Date | null }>(
      `SELECT status, confirmed_at FROM tabu_extractions WHERE id = $1`,
      [extractionId],
    );
    return { status: r.rows[0]!.status, confirmedAt: r.rows[0]!.confirmed_at };
  } finally {
    c.release();
  }
}

/** ACTIVE ownerships of an apartment — CORE columns only (safe pre-0071,
 *  so a gate test failing must fail on the GATE, not on 42703). */
interface OwnershipCore {
  id: string;
  ownerId: string;
  pct: string;
  num: string;
  den: string;
}
async function readActiveOwnerships(aptId: string): Promise<OwnershipCore[]> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{
      id: string;
      owner_id: string;
      ownership_pct: string;
      share_numerator: string;
      share_denominator: string;
    }>(
      `SELECT id, owner_id, ownership_pct, share_numerator::text AS share_numerator,
              share_denominator::text AS share_denominator
       FROM ownerships WHERE apartment_id = $1 AND ended_at IS NULL
       ORDER BY share_numerator, owner_id`,
      [aptId],
    );
    return r.rows.map((row) => ({
      id: row.id,
      ownerId: row.owner_id,
      pct: row.ownership_pct,
      num: row.share_numerator,
      den: row.share_denominator,
    }));
  } finally {
    c.release();
  }
}

/** Provenance read — 42703 RED until migration 0071 lands. */
async function readProvenance(aptId: string): Promise<Array<{ id: string; src: string | null }>> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string; source_extraction_id: string | null }>(
      `SELECT id, source_extraction_id FROM ownerships
       WHERE apartment_id = $1 AND ended_at IS NULL`,
      [aptId],
    );
    return r.rows.map((row) => ({ id: row.id, src: row.source_extraction_id }));
  } finally {
    c.release();
  }
}

async function ownersByNidHash(orgId: string, nid: string): Promise<string[]> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `SELECT id FROM owners
       WHERE org_id = $1 AND national_id_hash = $2 AND archived_at IS NULL`,
      [orgId, hashField(nid, dbEnv.PII_HASH_KEY as string)],
    );
    return r.rows.map((row) => row.id);
  } finally {
    c.release();
  }
}

async function decryptOwnerRow(
  ownerId: string,
): Promise<{ name: string | null; nationalId: string | null }> {
  const key = dbEnv.PII_ENCRYPTION_KEY as string;
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ name: string | null; national_id: string | null }>(
      `SELECT
         CASE WHEN name_encrypted IS NULL THEN NULL
              ELSE pgp_sym_decrypt(name_encrypted, $2) END AS name,
         CASE WHEN national_id_encrypted IS NULL THEN NULL
              ELSE pgp_sym_decrypt(national_id_encrypted, $2) END AS national_id
       FROM owners WHERE id = $1`,
      [ownerId, key],
    );
    return { name: r.rows[0]!.name, nationalId: r.rows[0]!.national_id };
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

/** Scan a result object/string for a 6-digit code value (H tests). */
function findSixDigitCode(res: unknown): string | null {
  if (typeof res === 'string' && /^\d{6}$/.test(res)) return res;
  if (res && typeof res === 'object') {
    for (const v of Object.values(res as Record<string, unknown>)) {
      if (typeof v === 'string' && /^\d{6}$/.test(v)) return v;
      const nested = findSixDigitCode(v);
      if (nested) return nested;
    }
  }
  return null;
}

beforeAll(async () => {
  await setupTestDatabase();
  testStart = new Date(Date.now() - 5_000);
  const tag = `s7c-tabu-review-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
  projectId = org.projects[0]!.id;
  unassignedProjectId = org.projects[1]!.id;
  viewerId = await seedUserWithRole(org.id, 'viewer');
  agentId = await seedUserWithRole(org.id, 'agent');
  await db.insert(projectAssignments).values({ projectId, userId: agentId, assignedBy: managerId });
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

// ───────────────────────────────────────────────────────────────────────────
// M) migration 0071 — ownerships.source_extraction_id provenance
// ───────────────────────────────────────────────────────────────────────────
describe('7c · M) migration 0071 (ownerships provenance column)', () => {
  it('M1) ownerships.source_extraction_id — uuid NULL + FK → tabu_extractions(id)', async () => {
    const c = await providerPool.connect();
    try {
      const col = await c.query<{ data_type: string; is_nullable: string }>(
        `SELECT data_type, is_nullable FROM information_schema.columns
         WHERE table_schema='public' AND table_name='ownerships'
           AND column_name='source_extraction_id'`,
      );
      expect(
        col.rows.length,
        '[RED] ownerships.source_extraction_id column missing (migration 0071)',
      ).toBe(1);
      expect(col.rows[0]!.data_type).toBe('uuid');
      expect(col.rows[0]!.is_nullable).toBe('YES');

      // FK to tabu_extractions(id).
      const fk = await c.query<{ foreign_table: string }>(
        `SELECT ccu.table_name AS foreign_table
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name
          AND kcu.table_schema = tc.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
         WHERE tc.table_schema='public' AND tc.table_name='ownerships'
           AND tc.constraint_type='FOREIGN KEY'
           AND kcu.column_name='source_extraction_id'`,
      );
      expect(
        fk.rows.some((row) => row.foreign_table === 'tabu_extractions'),
        '[RED] source_extraction_id must REFERENCE tabu_extractions(id)',
      ).toBe(true);
    } finally {
      c.release();
    }
  }, 30_000);

  it(`M2) journal entry \`when\` > ${PREV_MIGRATION_WHEN} (0070) — no silent skip (M-1)`, () => {
    const sqlFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    const migFile = sqlFiles.find((f) =>
      readFileSync(join(MIGRATIONS_DIR, f), 'utf8').includes('source_extraction_id'),
    );
    expect(
      migFile,
      '[RED] no migration .sql mentions source_extraction_id — builder must hand-author 0071',
    ).toBeTruthy();
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
// A) GET rows — unlock gate + decrypted content
// ───────────────────────────────────────────────────────────────────────────
describe('7c · A) GET /tabu-extractions/:id/rows — unlock gate', () => {
  it('A1) NO unlock → 403 pii_step_up_required (the doc-gate posture; never 404 — visibility ran first)', async () => {
    const { exId } = await seedDraftWithRows();
    const sid = await seedSession(managerId); // live session, NO unlock
    const svc = makeReviewSvc();

    let thrown: unknown;
    try {
      await svc[METHOD_ROWS](payload(managerId, 'manager', sid), exId);
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'decrypted rows served WITHOUT a PII unlock').toBeTruthy();
    expect(errStatus(thrown)).toBe(403);
    expect(errCode(thrown)).toBe(PII_STEP_UP_REQUIRED);
  }, 40_000);

  it('A2) VALID unlock (manager) → DECRYPTED rows match the seeded plaintext (name, nationalId, shares, confidence, edited, position)', async () => {
    const { exId } = await seedDraftWithRows();
    const sid = await unlockedSession(managerId);
    const svc = makeReviewSvc();

    const res = await svc[METHOD_ROWS](payload(managerId, 'manager', sid), exId);
    const rows = rowsOf(res);
    expect(rows.length).toBe(2);
    const [a, b] = [...rows].sort((x, y) => (x.position ?? 0) - (y.position ?? 0));

    expect(a!.name).toBe(ROW_A.name);
    expect(a!.nationalId, 'manager (unmasked fidelity) must get the CLEAR national_id').toBe(
      ROW_A.nid,
    );
    expect(Number(a!.shareNumerator)).toBe(ROW_A.num);
    expect(Number(a!.shareDenominator)).toBe(ROW_A.den);
    expect(Number(a!.confidence)).toBeCloseTo(ROW_A.confidence, 2);
    expect(a!.edited).toBe(false);

    expect(b!.name).toBe(ROW_B.name);
    expect(b!.nationalId).toBe(ROW_B.nid);
    expect((a!.position ?? 0) < (b!.position ?? 0)).toBe(true);
  }, 40_000);

  it('A3) EXPIRED unlock (61 min old; default TTL 60) → 403 pii_step_up_required again', async () => {
    const { exId } = await seedDraftWithRows();
    const sid = await seedSession(managerId);
    await setUnlock(sid, 61);
    const svc = makeReviewSvc();

    let thrown: unknown;
    try {
      await svc[METHOD_ROWS](payload(managerId, 'manager', sid), exId);
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'an EXPIRED unlock still served decrypted rows').toBeTruthy();
    expect(errStatus(thrown)).toBe(403);
    expect(errCode(thrown)).toBe(PII_STEP_UP_REQUIRED);
  }, 40_000);
});

// ───────────────────────────────────────────────────────────────────────────
// B) role masking (D.19/D.47 via resolveOwnerPiiFidelity)
// ───────────────────────────────────────────────────────────────────────────
describe('7c · B) rows masking by role fidelity', () => {
  it('B1) VIEWER + valid unlock → nationalId MASKED (•-style, never the clear value); manager → clear', async () => {
    const { exId } = await seedDraftWithRows();
    const svc = makeReviewSvc();

    // Viewer (fidelity 'masked' per resolveOwnerPiiFidelity).
    const viewerSid = await unlockedSession(viewerId);
    const viewerRows = rowsOf(await svc[METHOD_ROWS](payload(viewerId, 'viewer', viewerSid), exId));
    expect(viewerRows.length).toBe(2);
    const va = [...viewerRows].sort((x, y) => (x.position ?? 0) - (y.position ?? 0))[0]!;
    expect(typeof va.nationalId).toBe('string');
    const masked = va.nationalId as string;
    expect(masked, 'viewer must NEVER receive the clear national_id').not.toBe(ROW_A.nid);
    expect(masked.includes(ROW_A.nid), 'the full national_id leaked inside the mask').toBe(false);
    // Owners-surface mask style (NID_MASK): bullets + the last 2 chars.
    expect(masked).toContain('•');
    expect(masked.endsWith(ROW_A.nid.slice(-2))).toBe(true);

    // Manager on the SAME extraction → clear (authorized fidelity).
    const mgrSid = await unlockedSession(managerId);
    const mgrRows = rowsOf(await svc[METHOD_ROWS](payload(managerId, 'manager', mgrSid), exId));
    const ma = [...mgrRows].sort((x, y) => (x.position ?? 0) - (y.position ?? 0))[0]!;
    expect(ma.nationalId).toBe(ROW_A.nid);
  }, 40_000);

  // ── B5-asymmetry PIN (the regression guard the unify-gate fix exists for) ──
  // The tabu step-up gate is an ACCESS gate ONLY; the cleartext-vs-masked
  // decision is SEPARATE and lives in resolveOwnerPiiFidelity (D.54). These two
  // tests pin BOTH directions for the AGENT so a future change can NEVER (a)
  // leak cleartext to an agent who lacks view_owner_pii, nor (b) break the
  // legitimate masked review of an agent who passed step-up. Both run with a
  // VALID unlock — proving the access gate alone does NOT decide fidelity.

  it('B2) assigned agent WITHOUT view_owner_pii + valid unlock → nationalId MASKED (the access gate must NOT grant cleartext on its own)', async () => {
    const { exId } = await seedDraftWithRows();
    const svc = makeReviewSvc();
    await setAgentViewOwnerPii(false); // masked fidelity

    const sid = await unlockedSession(agentId);
    const rows = rowsOf(await svc[METHOD_ROWS](payload(agentId, 'agent', sid), exId));
    const a = [...rows].sort((x, y) => (x.position ?? 0) - (y.position ?? 0))[0]!;
    expect(typeof a.nationalId).toBe('string');
    const masked = a.nationalId as string;
    expect(
      masked,
      'agent without view_owner_pii must NEVER receive the clear national_id',
    ).not.toBe(ROW_A.nid);
    expect(masked.includes(ROW_A.nid), 'the full national_id leaked inside the mask').toBe(false);
    expect(masked).toContain('•');
    expect(masked.endsWith(ROW_A.nid.slice(-2))).toBe(true);
  }, 40_000);

  it('B3) assigned agent WITH view_owner_pii + valid unlock → nationalId CLEARTEXT (legitimate cleartext review is intentionally allowed; NOT gated on owners.reveal_pii)', async () => {
    const { exId } = await seedDraftWithRows();
    const svc = makeReviewSvc();
    await setAgentViewOwnerPii(true); // unmasked fidelity
    try {
      const sid = await unlockedSession(agentId);
      const rows = rowsOf(await svc[METHOD_ROWS](payload(agentId, 'agent', sid), exId));
      const a = [...rows].sort((x, y) => (x.position ?? 0) - (y.position ?? 0))[0]!;
      expect(a.nationalId, 'agent WITH view_owner_pii must get the CLEAR national_id').toBe(
        ROW_A.nid,
      );
    } finally {
      await setAgentViewOwnerPii(false); // restore default-OFF for other tests
    }
  }, 40_000);

  it('B4) [shared access-gate] assigned agent WITH view_owner_pii but NO unlock → 403 pii_step_up_required (the unified step-up gate runs BEFORE fidelity; cleartext entitlement does not bypass it)', async () => {
    const { exId } = await seedDraftWithRows();
    const svc = makeReviewSvc();
    await setAgentViewOwnerPii(true);
    try {
      const sid = await seedSession(agentId); // live session, NO unlock
      let thrown: unknown;
      try {
        await svc[METHOD_ROWS](payload(agentId, 'agent', sid), exId);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, 'cleartext entitlement bypassed the step-up access gate').toBeTruthy();
      expect(errStatus(thrown)).toBe(403);
      expect(errCode(thrown)).toBe(PII_STEP_UP_REQUIRED);
    } finally {
      await setAgentViewOwnerPii(false);
    }
  }, 40_000);
});

// ───────────────────────────────────────────────────────────────────────────
// C) PATCH row — re-encrypt + edited; unlock + capability gates; draft-only
// ───────────────────────────────────────────────────────────────────────────
describe('7c · C) PATCH /tabu-extractions/:id/rows/:rowId', () => {
  it('C1) manager + unlock edits name/nationalId/shares → RE-ENCRYPTED (decrypt-assert), edited=true, sibling row untouched', async () => {
    const { exId, rowAId, rowBId } = await seedDraftWithRows();
    const sid = await unlockedSession(managerId);
    const svc = makeReviewSvc();

    await svc[METHOD_PATCH](payload(managerId, 'manager', sid), exId, rowAId, {
      name: PATCHED.name,
      nationalId: PATCHED.nid,
      shareNumerator: PATCHED.num,
      shareDenominator: PATCHED.den,
    });

    const rows = await readRowsDecrypted(exId);
    const a = rows.find((r) => r.id === rowAId)!;
    expect(a.name, 'edited name must decrypt to the NEW value').toBe(PATCHED.name);
    expect(a.nationalId, 'edited national_id must decrypt to the NEW value').toBe(PATCHED.nid);
    expect(a.shareNum).toBe(String(PATCHED.num));
    expect(a.shareDen).toBe(String(PATCHED.den));
    expect(a.edited, 'edited flag must be set on the patched row').toBe(true);

    // The sibling row is untouched.
    const b = rows.find((r) => r.id === rowBId)!;
    expect(b.name).toBe(ROW_B.name);
    expect(b.nationalId).toBe(ROW_B.nid);
    expect(b.edited).toBe(false);
  }, 40_000);

  it('C2) PATCH WITHOUT unlock → 403 pii_step_up_required, row unchanged', async () => {
    const { exId, rowAId } = await seedDraftWithRows();
    const sid = await seedSession(managerId); // no unlock
    const svc = makeReviewSvc();

    let thrown: unknown;
    try {
      await svc[METHOD_PATCH](payload(managerId, 'manager', sid), exId, rowAId, {
        name: PATCHED.name,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'a PII-affirming edit ran without a PII unlock').toBeTruthy();
    expect(errStatus(thrown)).toBe(403);
    expect(errCode(thrown)).toBe(PII_STEP_UP_REQUIRED);

    const rows = await readRowsDecrypted(exId);
    expect(rows.find((r) => r.id === rowAId)!.name).toBe(ROW_A.name);
    expect(rows.find((r) => r.id === rowAId)!.edited).toBe(false);
  }, 40_000);

  it('C3) assigned agent + unlock WITHOUT edit_project_data → rejected (D.54), row unchanged; with the cap → succeeds', async () => {
    const { exId, rowAId } = await seedDraftWithRows();
    const sid = await unlockedSession(agentId);
    const svc = makeReviewSvc();

    await setAgentCap(false);
    let thrown: unknown;
    try {
      await svc[METHOD_PATCH](payload(agentId, 'agent', sid), exId, rowAId, {
        name: PATCHED.name,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'agent WITHOUT edit_project_data edited a row').toBeTruthy();
    expect(errStatus(thrown)).toBe(403);
    expect((await readRowsDecrypted(exId)).find((r) => r.id === rowAId)!.edited).toBe(false);

    // Sanity: the SAME assigned agent succeeds once the capability is ON.
    await setAgentCap(true);
    await svc[METHOD_PATCH](payload(agentId, 'agent', sid), exId, rowAId, { name: PATCHED.name });
    const after = (await readRowsDecrypted(exId)).find((r) => r.id === rowAId)!;
    expect(after.name).toBe(PATCHED.name);
    expect(after.edited).toBe(true);
  }, 40_000);

  it('C4) PATCH on a NON-draft extraction → rejected (draft-only), row unchanged', async () => {
    const aptId = await seedApartment(projectId);
    const docId = await seedFinalizedDoc(org.id, managerId, aptId);
    const exId = await seedExtraction(org.id, aptId, docId, managerId, 'confirmed');
    const rowId = await seedEncryptedRow(exId, org.id, ROW_A, 0);
    const sid = await unlockedSession(managerId);
    const svc = makeReviewSvc();

    let thrown: unknown;
    try {
      await svc[METHOD_PATCH](payload(managerId, 'manager', sid), exId, rowId, {
        name: PATCHED.name,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'a CONFIRMED extraction’s row was edited').toBeTruthy();
    // 404 (run-spec's non-draft posture) or 409 — both acceptable; never a write.
    expect([404, 409]).toContain(errStatus(thrown));
    expect((await readRowsDecrypted(exId))[0]!.name).toBe(ROW_A.name);
  }, 40_000);
});

// ───────────────────────────────────────────────────────────────────────────
// D) confirm — happy path: hash-match + shell-create + replace + provenance
// ───────────────────────────────────────────────────────────────────────────
describe('7c · D) POST /tabu-extractions/:id/confirm — the commit', () => {
  it('D1) 2 rows (1/2+1/2; one EXISTING owner by nat-id hash, one NEW) → reuse + shell; ownerships REPLACED; provenance stamped; extraction confirmed', async () => {
    // Fixture: an apartment that ALREADY has an active ownership (PRIOR_OWNER
    // 1/1) — confirm must END it. One extraction row matches EXISTING_OWNER
    // by national_id hash; the other names a brand-new person.
    const aptId = await seedApartment(projectId);
    const docId = await seedFinalizedDoc(org.id, managerId, aptId);
    const exId = await seedExtraction(org.id, aptId, docId, managerId);
    await seedEncryptedRow(
      exId,
      org.id,
      { name: EXISTING_OWNER.name, nid: EXISTING_OWNER.nid, num: 1, den: 2, confidence: 0.95 },
      0,
    );
    await seedEncryptedRow(
      exId,
      org.id,
      { name: NEW_OWNER.name, nid: NEW_OWNER.nid, num: 1, den: 2, confidence: 0.9 },
      1,
    );
    const existingOwnerId = await seedOwner(org.id, EXISTING_OWNER.name, EXISTING_OWNER.nid);
    const priorOwnerId = await seedOwner(org.id, PRIOR_OWNER.name, PRIOR_OWNER.nid);
    const priorOwnershipId = await seedActiveOwnership(aptId, priorOwnerId);

    const sid = await unlockedSession(managerId);
    const svc = makeReviewSvc();
    await svc[METHOD_CONFIRM](payload(managerId, 'manager', sid), exId);

    // 1. Extraction → confirmed + confirmed_at stamped.
    const ex = await readExtractionStatus(exId);
    expect(ex.status).toBe('confirmed');
    expect(ex.confirmedAt).not.toBeNull();

    // 2. Owner matching: the EXISTING owner was REUSED (still exactly ONE
    //    owner for that national_id hash — no duplicate), and a NEW shell
    //    was created for the unknown person, hash-matchable + encrypted.
    const existing = await ownersByNidHash(org.id, EXISTING_OWNER.nid);
    expect(existing, 'confirm must REUSE the hash-matched owner, not duplicate it').toEqual([
      existingOwnerId,
    ]);
    const created = await ownersByNidHash(org.id, NEW_OWNER.nid);
    expect(created.length, 'confirm must CREATE a shell owner for the unmatched row').toBe(1);
    const shell = await decryptOwnerRow(created[0]!);
    expect(shell.name, 'shell owner name must be pgcrypto-encrypted (decrypt round-trip)').toBe(
      NEW_OWNER.name,
    );
    expect(shell.nationalId).toBe(NEW_OWNER.nid);

    // 3. Ownerships REPLACED atomically: prior active row ENDED; exactly the
    //    2 confirmed rows active with the EXACT fractions (sum trigger = 1).
    const active = await readActiveOwnerships(aptId);
    expect(active.length).toBe(2);
    expect(active.map((o) => o.id)).not.toContain(priorOwnershipId);
    expect(new Set(active.map((o) => o.ownerId))).toEqual(new Set([existingOwnerId, created[0]!]));
    for (const o of active) {
      expect(o.num).toBe('1');
      expect(o.den).toBe('2');
      expect(Number(o.pct)).toBeCloseTo(50, 2);
    }

    // 4. Provenance (migration 0071): both written rows carry the extraction.
    const prov = await readProvenance(aptId);
    expect(prov.length).toBe(2);
    for (const p of prov) {
      expect(p.src, 'every confirm-written ownership must stamp source_extraction_id').toBe(exId);
    }

    // 5. Audited (audit-first commit — the row must exist for THIS extraction).
    expect(await auditCount(org.id, CONFIRM_AUDIT_ACTION, exId)).toBeGreaterThan(0);
  }, 60_000);
});

// ───────────────────────────────────────────────────────────────────────────
// E) confirm — idempotency
// ───────────────────────────────────────────────────────────────────────────
describe('7c · E) confirm is IDEMPOTENT (WHERE status=draft)', () => {
  it('E1) second confirm → 409 conflict; ownerships UNCHANGED (count + values); confirmed_at unchanged', async () => {
    const { aptId, exId } = await seedDraftWithRows(); // ROW_A + ROW_B, 1/2+1/2
    const sid = await unlockedSession(managerId);
    const svc = makeReviewSvc();

    await svc[METHOD_CONFIRM](payload(managerId, 'manager', sid), exId);
    const firstActive = await readActiveOwnerships(aptId);
    expect(firstActive.length).toBe(2);
    const firstConfirmedAt = (await readExtractionStatus(exId)).confirmedAt;
    expect(firstConfirmedAt).not.toBeNull();

    // Second confirm — MUST NOT double-write.
    let thrown: unknown;
    try {
      await svc[METHOD_CONFIRM](payload(managerId, 'manager', sid), exId);
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'a second confirm was accepted (double-commit)').toBeTruthy();
    expect(errStatus(thrown), 'second confirm must be a 409 conflict').toBe(409);

    // Ownerships byte-identical: same row ids, same fractions, same count.
    const secondActive = await readActiveOwnerships(aptId);
    expect(secondActive).toEqual(firstActive);
    expect((await readExtractionStatus(exId)).confirmedAt?.getTime()).toBe(
      firstConfirmedAt!.getTime(),
    );
  }, 60_000);
});

// ───────────────────────────────────────────────────────────────────────────
// F) confirm — gates (unlock, capability, non-draft)
// ───────────────────────────────────────────────────────────────────────────
describe('7c · F) confirm gates', () => {
  it('F1) confirm WITHOUT unlock → 403 pii_step_up_required; extraction stays draft; NO ownerships written', async () => {
    const { aptId, exId } = await seedDraftWithRows();
    const sid = await seedSession(managerId); // no unlock
    const svc = makeReviewSvc();

    let thrown: unknown;
    try {
      await svc[METHOD_CONFIRM](payload(managerId, 'manager', sid), exId);
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'confirm (PII materialization) ran without a PII unlock').toBeTruthy();
    expect(errStatus(thrown)).toBe(403);
    expect(errCode(thrown)).toBe(PII_STEP_UP_REQUIRED);
    expect((await readExtractionStatus(exId)).status).toBe('draft');
    expect((await readActiveOwnerships(aptId)).length).toBe(0);
  }, 40_000);

  it('F2) assigned agent + unlock WITHOUT edit_project_data → rejected (D.54 own-method gate); with the cap → commits', async () => {
    const { aptId, exId } = await seedDraftWithRows();
    const sid = await unlockedSession(agentId);
    const svc = makeReviewSvc();

    await setAgentCap(false);
    let thrown: unknown;
    try {
      await svc[METHOD_CONFIRM](payload(agentId, 'agent', sid), exId);
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'agent WITHOUT edit_project_data confirmed an extraction').toBeTruthy();
    expect(errStatus(thrown)).toBe(403);
    expect((await readExtractionStatus(exId)).status).toBe('draft');
    expect((await readActiveOwnerships(aptId)).length).toBe(0);

    // Sanity: the SAME assigned agent commits once the capability is ON.
    await setAgentCap(true);
    await svc[METHOD_CONFIRM](payload(agentId, 'agent', sid), exId);
    expect((await readExtractionStatus(exId)).status).toBe('confirmed');
    expect((await readActiveOwnerships(aptId)).length).toBe(2);
  }, 60_000);

  it('F3) confirm on a NON-draft (discarded) extraction → 409 conflict; nothing written', async () => {
    const aptId = await seedApartment(projectId);
    const docId = await seedFinalizedDoc(org.id, managerId, aptId);
    const exId = await seedExtraction(org.id, aptId, docId, managerId, 'discarded');
    await seedEncryptedRow(exId, org.id, ROW_A, 0);
    await seedEncryptedRow(exId, org.id, ROW_B, 1);
    const sid = await unlockedSession(managerId);
    const svc = makeReviewSvc();

    let thrown: unknown;
    try {
      await svc[METHOD_CONFIRM](payload(managerId, 'manager', sid), exId);
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'a DISCARDED extraction was confirmed').toBeTruthy();
    expect(errStatus(thrown)).toBe(409);
    expect((await readExtractionStatus(exId)).status).toBe('discarded');
    expect((await readActiveOwnerships(aptId)).length).toBe(0);
  }, 40_000);
});

// ───────────────────────────────────────────────────────────────────────────
// G) the 3 retroactive MINORs (7a/7b code review)
// ───────────────────────────────────────────────────────────────────────────
describe('7c · G) retroactive MINORs (list pagination / agent getOne / limit default)', () => {
  it('G1) [MINOR a — coverage] multi-row keyset pagination: limit=2 over 3 extractions → has_more + cursor walks the rest, no overlap', async () => {
    const aptId = await seedApartment(projectId);
    const docId = await seedFinalizedDoc(org.id, managerId, aptId);
    const ids = [
      await seedExtraction(org.id, aptId, docId, managerId),
      await seedExtraction(org.id, aptId, docId, managerId),
      await seedExtraction(org.id, aptId, docId, managerId),
    ];
    const svc = makeEnvelopeSvc();
    const user = payload(managerId, 'manager', randomUUID());

    const page1 = await svc.list(user, aptId, { limit: 2 });
    expect(page1.data.length).toBe(2);
    expect(page1.page.has_more).toBe(true);
    expect(page1.page.cursor).toBeTruthy();

    const page2 = await svc.list(user, aptId, { limit: 2, cursor: page1.page.cursor! });
    expect(page2.data.length).toBe(1);
    expect(page2.page.has_more).toBe(false);

    const seen = [...page1.data, ...page2.data].map((e) => e.id);
    expect(new Set(seen).size, 'cursor pages must not overlap').toBe(3);
    expect(new Set(seen)).toEqual(new Set(ids));
  }, 40_000);

  it('G2) [MINOR b — coverage] agent getOne on an UNASSIGNED-project apartment → 404 (no oracle); manager sees it', async () => {
    const aptId = await seedApartment(unassignedProjectId); // agent NOT assigned here
    const docId = await seedFinalizedDoc(org.id, managerId, aptId);
    const exId = await seedExtraction(org.id, aptId, docId, managerId);
    const svc = makeEnvelopeSvc();

    let thrown: unknown;
    try {
      await svc.getOne(payload(agentId, 'agent', randomUUID()), exId);
    } catch (e) {
      thrown = e;
    }
    expect(thrown, 'agent read an extraction outside their assigned projects').toBeTruthy();
    expect(errStatus(thrown)).toBe(404);

    // Control: the manager reads the same extraction fine.
    const got = await svc.getOne(payload(managerId, 'manager', randomUUID()), exId);
    expect((got as { id: string }).id).toBe(exId);
  }, 40_000);

  it('K1) [keyset micros] same-millisecond different-microsecond rows must not be dropped across cursor pages', async () => {
    // The cursor encodes createdAt.toISOString() = MILLISECOND precision, but
    // created_at is timestamptz at MICROSECOND precision (Postgres now()).
    // When several rows share a millisecond but differ in microseconds and the
    // page boundary falls among them, the keyset (compared against the
    // ms-truncated cursor) silently DROPS the straddling row(s). Force the
    // collision deterministically: 3 rows, same ms (.123), distinct micros.
    const aptId = await seedApartment(projectId);
    const docId = await seedFinalizedDoc(org.id, managerId, aptId);
    const e1 = await seedExtraction(org.id, aptId, docId, managerId);
    const e2 = await seedExtraction(org.id, aptId, docId, managerId);
    const e3 = await seedExtraction(org.id, aptId, docId, managerId);

    const c = await providerPool.connect();
    try {
      await c.query(`UPDATE tabu_extractions SET created_at = $1::timestamptz WHERE id = $2`, [
        '2026-01-01 00:00:00.123100+00',
        e1,
      ]);
      await c.query(`UPDATE tabu_extractions SET created_at = $1::timestamptz WHERE id = $2`, [
        '2026-01-01 00:00:00.123400+00',
        e2,
      ]);
      await c.query(`UPDATE tabu_extractions SET created_at = $1::timestamptz WHERE id = $2`, [
        '2026-01-01 00:00:00.123700+00',
        e3,
      ]);
    } finally {
      c.release();
    }

    const svc = makeEnvelopeSvc();
    const user = payload(managerId, 'manager', randomUUID());

    const page1 = await svc.list(user, aptId, { limit: 2 });
    const page2 = await svc.list(user, aptId, { limit: 2, cursor: page1.page.cursor! });

    const seen = [...page1.data, ...page2.data].map((r) => r.id);
    // No loss, no overlap: the union across the two pages must be all 3 ids.
    expect(new Set(seen).size, 'cursor pages must not produce duplicate ids').toBe(seen.length);
    expect(seen.length, 'a same-ms/different-micros row was DROPPED across the page boundary').toBe(
      3,
    );
    expect(new Set(seen)).toEqual(new Set([e1, e2, e3]));
  }, 40_000);

  it(`G3) [MINOR c] service list default limit aligns with the DTO default (${DTO_DEFAULT_LIMIT}, ListOwnershipsQuery)`, async () => {
    const aptId = await seedApartment(projectId);
    const svc = makeEnvelopeSvc();
    // No query at all → the service default must equal the Zod DTO default
    // (25), not a drifted hardcode (20 today → RED).
    const page = await svc.list(payload(managerId, 'manager', randomUUID()), aptId);
    expect(
      page.page.limit,
      `[RED] service no-query default limit must be the DTO default ${DTO_DEFAULT_LIMIT}`,
    ).toBe(DTO_DEFAULT_LIMIT);
  }, 40_000);
});

// ───────────────────────────────────────────────────────────────────────────
// H) EXPOSE_STEP_UP_CODE — dev-only QA exposure (mirrors EXPOSE_INVITE_TOKEN)
// ───────────────────────────────────────────────────────────────────────────
describe('7c · H) StepUpService.request EXPOSE_STEP_UP_CODE dev exposure', () => {
  async function seedStepUpUser(): Promise<{ id: string; email: string; sid: string }> {
    const email = `stepup-expose-${randomUUID()}@test.local`;
    const c = await providerPool.connect();
    try {
      const u = await c.query<{ id: string }>(
        `INSERT INTO users (email, name, password_hash)
         VALUES ($1, 'StepUp Expose', '$2b$12$placeholder') RETURNING id`,
        [email],
      );
      await c.query(
        `INSERT INTO memberships (user_id, org_id, role, accepted_at)
         VALUES ($1, $2, 'manager', now())`,
        [u.rows[0]!.id, org.id],
      );
      return { id: u.rows[0]!.id, email, sid: '' };
    } finally {
      c.release();
    }
  }

  it('H1) EXPOSE_STEP_UP_CODE=true + NODE_ENV=test → request() RETURNS the 6-digit code (equals the emailed code; verify accepts it)', async () => {
    const u = await seedStepUpUser();
    const sid = await seedSession(u.id);
    const email = new FakeEmailProvider();
    const svc = new StepUpService(email);
    const user = payload(u.id, 'manager', sid);

    const prev = process.env['EXPOSE_STEP_UP_CODE'];
    process.env['EXPOSE_STEP_UP_CODE'] = 'true';
    try {
      const res: unknown = await svc.request(user);
      const exposed = findSixDigitCode(res);
      expect(
        exposed,
        '[RED] with EXPOSE_STEP_UP_CODE=true (NODE_ENV=test) request() must return the 6-digit code',
      ).toBeTruthy();

      // It is the REAL code: matches the emailed one AND verify accepts it.
      const sent = [...email.sent].reverse().find((m) => m.to === u.email);
      expect(sent, 'no step-up email captured').toBeTruthy();
      const emailed =
        `${(sent as { text?: string }).text ?? ''}\n${(sent as { html?: string }).html ?? ''}`.match(
          /\b(\d{6})\b/,
        );
      expect(emailed).toBeTruthy();
      expect(exposed).toBe(emailed![1]);

      await svc.verify(user, exposed!);
      const c = await providerPool.connect();
      try {
        const r = await c.query<{ pii_unlocked_at: Date | null }>(
          `SELECT pii_unlocked_at FROM auth_sessions WHERE id = $1`,
          [sid],
        );
        expect(r.rows[0]!.pii_unlocked_at, 'the exposed code must be the live one').not.toBeNull();
      } finally {
        c.release();
      }
    } finally {
      if (prev === undefined) delete process.env['EXPOSE_STEP_UP_CODE'];
      else process.env['EXPOSE_STEP_UP_CODE'] = prev;
    }
  }, 40_000);

  it('H2) WITHOUT the env flag → the code is ABSENT from the response (default-closed; green-by-design regression pin)', async () => {
    const u = await seedStepUpUser();
    const sid = await seedSession(u.id);
    const svc = new StepUpService(new FakeEmailProvider());

    const prev = process.env['EXPOSE_STEP_UP_CODE'];
    delete process.env['EXPOSE_STEP_UP_CODE'];
    try {
      const res: unknown = await svc.request(payload(u.id, 'manager', sid));
      expect(
        findSixDigitCode(res),
        'the OTP code leaked into the response WITHOUT EXPOSE_STEP_UP_CODE',
      ).toBeNull();
    } finally {
      if (prev !== undefined) process.env['EXPOSE_STEP_UP_CODE'] = prev;
    }
  }, 40_000);

  it('H3) fail-closed allowlist: the EXPOSE_STEP_UP_CODE gate exists in the auth module and allowlists ONLY development|test (EXPOSE_INVITE_TOKEN pattern)', () => {
    const files = readdirSync(AUTH_MODULE_DIR).filter((f) => f.endsWith('.ts'));
    const defining = files.filter((f) => {
      if (f.endsWith('.spec.ts')) return false;
      return readFileSync(join(AUTH_MODULE_DIR, f), 'utf8').includes('EXPOSE_STEP_UP_CODE');
    });
    expect(
      defining.length,
      '[RED] no auth-module source mentions EXPOSE_STEP_UP_CODE — builder must add the dev exposure',
    ).toBeGreaterThan(0);
    // The gating source must carry the STRICT NODE_ENV allowlist (mirrors
    // invite-email.ts L-3 hardening: 'development' | 'test' only — unset /
    // 'production' / typos stay closed).
    const src = defining.map((f) => readFileSync(join(AUTH_MODULE_DIR, f), 'utf8')).join('\n');
    expect(
      src.includes("'development'") || src.includes('"development"'),
      '[RED] the exposure gate must allowlist NODE_ENV development explicitly',
    ).toBe(true);
    expect(
      src.includes("'test'") || src.includes('"test"'),
      '[RED] the exposure gate must allowlist NODE_ENV test explicitly',
    ).toBe(true);
  });
});
