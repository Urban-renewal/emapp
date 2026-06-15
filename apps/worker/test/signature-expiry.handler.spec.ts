/**
 * SIGNATURE-EXPIRY SWEEP — independent acceptance spec (TEST-AUTHOR, written
 * BEFORE the implementation; RED now, GREEN after the builder).
 *
 * THE SLICE (V12 slice-1 critic note): signature_requests rows with
 * status='pending' AND expires_at <= now() are DERIVED as expired by the FE
 * and by the create()/bulk dedup predicates, but the DB rows themselves stay
 * 'pending' forever after the one-shot 0063 backfill. A periodic worker job
 * must flip them to the (already-CHECK-admitted, migration 0063) 'expired'
 * status so DB rows + counts + lists agree with the derived truth and a
 * future "your link expired" notify has a real state transition to hook.
 *
 * CONTRACT PINNED BY THIS SPEC (the builder implements TO these pins):
 *  - @emapp/jobs exports (mirroring reaper-job.ts / audit-retention-job.ts):
 *      SIGNATURE_EXPIRY_JOB_NAME        === 'sweep:signature-expiry'
 *      SIGNATURE_EXPIRY_CRON_HOURLY     — a 5-field cron expression
 *      SignatureExpiryJobPayloadSchema  — STRICT empty object (no payload;
 *                                         a tampered enqueue can carry nothing)
 *  - apps/worker/src/handlers/signature-expiry.handler.ts exports class
 *    SignatureExpiryHandler implementing IJobHandler (name/timeoutMs/
 *    maxRetries/payloadSchema/handle), mirroring ReaperHandler /
 *    AuditRetentionHandler (thin queue seam; cross-org work runs on the
 *    BYPASSRLS maintenance pool — withTenant is per-org and CANNOT see the
 *    whole table; this is the same bounded exception the reaper +
 *    audit-retention prune already use, see packages/db helpers).
 *  - handle():
 *      * ONE bulk UPDATE: status='pending' AND expires_at <= now()
 *        → status='expired'. Nothing else on the row changes.
 *      * NEVER touches signed / cancelled / already-expired rows, nor a
 *        pending row with expires_at > now().
 *      * Idempotent — an immediate second run flips 0 rows.
 *      * Emits a completion log line `signature expiry sweep complete` with
 *        meta { expired: <integer> } (counts only — NO row content, no jti,
 *        no owner/document ids, no PII; mirrors 'reaper tick complete' /
 *        'audit retention prune complete').
 *      * AUDIT (the convention grounded from the codebase): the existing
 *        maintenance handlers delete EPHEMERAL rows and only LOG — but this
 *        sweep mutates DOMAIN forensic rows, so it writes ONE audit_log row
 *        PER AFFECTED ORG: actor_type='system' (the seeded convention used
 *        across audit specs; actor_id NULL = system per schema comment),
 *        action='signature_request.expired_sweep', metadata {count:<n>}
 *        (integer count for THAT org, no PII). A run that flips 0 rows for
 *        an org writes NO audit row (no daily noise; audit_log is
 *        append-only + 24-month-immutable, so noise is forever).
 *  - main.ts registers the consumer and schedules the producer EXACTLY like
 *    the reaper/audit-retention pair:
 *      await boss.schedule(SIGNATURE_EXPIRY_JOB_NAME, SIGNATURE_EXPIRY_CRON_HOURLY)
 *    (static source pin below — same style as the v6 audit spec's
 *    resolver-source pin).
 *
 * NO MIGRATION IS NEEDED — verified: migration 0063 already widened the
 * status CHECK to ('pending','signed','cancelled','expired') and the column +
 * expires_at exist since 0021. This spec asserts behaviour only.
 *
 * Harness mirrors the existing worker real-DB specs (v6-audit-invariants /
 * import-job.handler): shared global-setup migration, createTestOrg factory,
 * providerPool (BYPASSRLS) raw-SQL seeding + ground-truth reads so assertions
 * are org-context independent, and the handler is driven DIRECTLY via
 * handle(payload, ctx) with a recording JobContext logger.
 *
 * Cleanup: signature_requests rows seeded here are deleted in afterAll via
 * providerPool (no immutability trigger on that table). audit_log rows the
 * handler writes are recent (<24mo) and therefore CANNOT be deleted (the
 * 0060 age-gated immutability trigger) — they are scoped to throwaway orgs,
 * same residue pattern every other worker audit spec leaves.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { encryptOwnerPii, owners, withTenant } from '@emapp/db';
import {
  SIGNATURE_EXPIRY_JOB_NAME,
  SIGNATURE_EXPIRY_CRON_HOURLY,
  SignatureExpiryJobPayloadSchema,
  type JobContext,
} from '@emapp/jobs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../packages/db/test/setup';
import { SignatureExpiryHandler } from '../src/handlers/signature-expiry.handler';

const SWEEP_AUDIT_ACTION = 'signature_request.expired_sweep';

// ── recording JobContext (mirrors makeRecordingLogger in the retention spec
//    + makeCtx in v6-audit-invariants) ────────────────────────────────────
interface LoggedCall {
  level: 'info' | 'warn' | 'error';
  msg: string;
  meta?: Record<string, unknown>;
}
function makeCtx(): { ctx: JobContext; calls: LoggedCall[] } {
  const calls: LoggedCall[] = [];
  const ctx: JobContext = {
    jobId: `sig-expiry-spec-${randomUUID().slice(0, 8)}`,
    attempt: 1,
    log: {
      info: (msg, meta) => calls.push({ level: 'info', msg, meta }),
      warn: (msg, meta) => calls.push({ level: 'warn', msg, meta }),
      error: (msg, meta) => calls.push({ level: 'error', msg, meta }),
    },
    signal: new AbortController().signal,
  };
  return { ctx, calls };
}

// ── providerPool (BYPASSRLS) raw-SQL helpers — ground truth independent of
//    any org RLS context, exactly like the retention/v6 specs ─────────────
async function pq<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await providerPool.connect();
  try {
    const r = await client.query(text, params);
    return r.rows as T[];
  } finally {
    client.release();
  }
}

async function seedOwner(orgId: string): Promise<string> {
  return withTenant(orgId, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, {
      nationalId: String(Math.floor(100000000 + Math.random() * 899999999)),
      name: 'בעלים-סוויפ',
      phone: '0541112222',
    });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId,
        email: `sweep-owner-${randomUUID()}@test.local`,
        nameEncrypted: pii.nameEncrypted,
        nameHash: pii.nameHash,
        nationalIdEncrypted: pii.nationalIdEncrypted,
        nationalIdHash: pii.nationalIdHash,
        phoneEncrypted: pii.phoneEncrypted,
        phoneHash: pii.phoneHash,
      })
      .returning({ id: owners.id });
    return row!.id;
  });
}

async function seedDoc(orgId: string, projectId: string, uploadedBy: string): Promise<string> {
  const rows = await pq<{ id: string }>(
    `INSERT INTO documents
       (org_id, project_id, name, type, mime_type, size_bytes, r2_key, content_hash, uploaded_by, uploaded_at)
     VALUES ($1, $2, 'sweep.pdf', 'contract', 'application/pdf', 100, $3, 'h-sweep', $4, now())
     RETURNING id`,
    [orgId, projectId, `org/${orgId}/doc/${randomUUID()}`, uploadedBy],
  );
  return rows[0]!.id;
}

type SeedStatus = 'pending' | 'signed' | 'cancelled' | 'expired';

/** Seed one signature_request. `lapsed` controls expires_at relative to
 *  now(): true → -1h (deadline passed), false → +1h (still live). */
async function seedRequest(args: {
  orgId: string;
  documentId: string;
  ownerId: string;
  createdBy: string;
  status: SeedStatus;
  lapsed: boolean;
}): Promise<{ id: string; jti: string }> {
  const jti = `jti-sweep-${randomUUID()}`;
  const interval = args.lapsed ? `now() - interval '1 hour'` : `now() + interval '1 hour'`;
  const signedAt = args.status === 'signed' ? 'now()' : 'NULL';
  const cancelledAt = args.status === 'cancelled' ? 'now()' : 'NULL';
  const cancelledBy = args.status === 'cancelled' ? '$5::uuid' : 'NULL';
  const rows = await pq<{ id: string }>(
    `INSERT INTO signature_requests
       (org_id, document_id, owner_id, jti, status, expires_at, created_by, signed_at, cancelled_at, cancelled_by)
     VALUES ($1, $2, $3, $4, '${args.status}', ${interval}, $5, ${signedAt}, ${cancelledAt}, ${cancelledBy})
     RETURNING id`,
    [args.orgId, args.documentId, args.ownerId, jti, args.createdBy],
  );
  return { id: rows[0]!.id, jti };
}

/** Full-row snapshot (every column) as jsonb — the byte-identical compare. */
async function snapshot(id: string): Promise<Record<string, unknown>> {
  const rows = await pq<{ row: Record<string, unknown> }>(
    `SELECT to_jsonb(sr) AS row FROM signature_requests sr WHERE id = $1`,
    [id],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!.row;
}

async function status(id: string): Promise<string> {
  const rows = await pq<{ status: string }>(`SELECT status FROM signature_requests WHERE id = $1`, [
    id,
  ]);
  return rows[0]!.status;
}

/** The sweep's audit rows for one org (the per-org system-audit convention). */
async function sweepAuditRows(
  orgId: string,
): Promise<Array<{ actor_type: string; metadata: Record<string, unknown> }>> {
  return pq(`SELECT actor_type, metadata FROM audit_log WHERE org_id = $1 AND action = $2`, [
    orgId,
    SWEEP_AUDIT_ACTION,
  ]);
}

/** One per-test fixture: a fresh org + owner + finalised project doc. */
async function makeFixture(tag: string): Promise<{
  org: TestOrg;
  ownerId: string;
  documentId: string;
  managerId: string;
}> {
  const org = await createTestOrg(`${tag}-${Date.now()}`, `${tag}-${Date.now()}`);
  const managerId = org.users[0]!.id;
  const ownerId = await seedOwner(org.id);
  const documentId = await seedDoc(org.id, org.projects[0]!.id, managerId);
  return { org, ownerId, documentId, managerId };
}

const seededOrgIds: string[] = [];

beforeAll(async () => {
  await setupTestDatabase();
});

afterAll(async () => {
  // signature_requests has no immutability trigger — providerPool (owner,
  // BYPASSRLS) can delete our seeds and leave the shared DB clean. The
  // handler's audit_log rows are <24mo (undeletable by design, 0060) and
  // stay behind on throwaway orgs like every other worker audit spec.
  if (seededOrgIds.length > 0) {
    await pq(`DELETE FROM signature_requests WHERE org_id = ANY($1::uuid[])`, [seededOrgIds]);
  }
});

// ────────────────────────────────────────────────────────────────────────
// Contract pins — job constants + handler shape (mirrors reaper-job.spec /
// audit-retention-job.spec value pins).
// ────────────────────────────────────────────────────────────────────────
describe('sweep:signature-expiry — job contract pins', () => {
  it('job name is pinned and namespaced like the other periodic jobs', () => {
    expect(SIGNATURE_EXPIRY_JOB_NAME).toBe('sweep:signature-expiry');
  });

  it('cron constant is a 5-field cron expression', () => {
    expect(typeof SIGNATURE_EXPIRY_CRON_HOURLY).toBe('string');
    expect(SIGNATURE_EXPIRY_CRON_HOURLY.trim().split(/\s+/)).toHaveLength(5);
  });

  it('payload schema is a STRICT empty object (payload-confusion defense)', () => {
    expect(SignatureExpiryJobPayloadSchema.safeParse({}).success).toBe(true);
    expect(SignatureExpiryJobPayloadSchema.safeParse({ evil: 1 }).success).toBe(false);
    expect(SignatureExpiryJobPayloadSchema.safeParse({ expiresBefore: '2099-01-01' }).success).toBe(
      false,
    );
  });

  it('handler implements the IJobHandler seam under the pinned name', () => {
    const handler = new SignatureExpiryHandler();
    expect(handler.name).toBe(SIGNATURE_EXPIRY_JOB_NAME);
    expect(handler.payloadSchema).toBe(SignatureExpiryJobPayloadSchema);
    expect(Number.isFinite(handler.timeoutMs)).toBe(true);
    expect(handler.timeoutMs).toBeGreaterThan(0);
    expect(handler.maxRetries).toBeGreaterThanOrEqual(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// A. Boundary matrix — ONLY the lapsed pending row flips; everything else
//    is byte-identical.
// ────────────────────────────────────────────────────────────────────────
describe('sweep:signature-expiry — A. flips ONLY lapsed pending rows', () => {
  it('pending+lapsed → expired; pending+future / signed / cancelled / expired untouched', async () => {
    const fx = await makeFixture('swpA');
    seededOrgIds.push(fx.org.id);
    const base = {
      orgId: fx.org.id,
      documentId: fx.documentId,
      ownerId: fx.ownerId,
      createdBy: fx.managerId,
    };

    const pendingLapsed = await seedRequest({ ...base, status: 'pending', lapsed: true });
    const pendingFuture = await seedRequest({ ...base, status: 'pending', lapsed: false });
    const signedLapsed = await seedRequest({ ...base, status: 'signed', lapsed: true });
    const cancelledLapsed = await seedRequest({ ...base, status: 'cancelled', lapsed: true });
    const alreadyExpired = await seedRequest({ ...base, status: 'expired', lapsed: true });

    const before = {
      pendingLapsed: await snapshot(pendingLapsed.id),
      pendingFuture: await snapshot(pendingFuture.id),
      signedLapsed: await snapshot(signedLapsed.id),
      cancelledLapsed: await snapshot(cancelledLapsed.id),
      alreadyExpired: await snapshot(alreadyExpired.id),
    };

    const { ctx, calls } = makeCtx();
    const handler = new SignatureExpiryHandler();
    await handler.handle(SignatureExpiryJobPayloadSchema.parse({}), ctx);

    // The ONE lapsed pending row flipped — and ONLY its status changed.
    expect(await status(pendingLapsed.id)).toBe('expired');
    const afterFlipped = await snapshot(pendingLapsed.id);
    expect({ ...afterFlipped, status: 'pending' }).toEqual(before.pendingLapsed);

    // Every other row is BYTE-IDENTICAL (full to_jsonb compare).
    expect(await snapshot(pendingFuture.id)).toEqual(before.pendingFuture);
    expect(await snapshot(signedLapsed.id)).toEqual(before.signedLapsed);
    expect(await snapshot(cancelledLapsed.id)).toEqual(before.cancelledLapsed);
    expect(await snapshot(alreadyExpired.id)).toEqual(before.alreadyExpired);

    // Completion evidence line: integer count, ≥ our 1 flip (the sweep is
    // global — a parallel suite's lapsed rows may add to it).
    const done = calls.find(
      (c) => c.level === 'info' && c.msg === 'signature expiry sweep complete',
    );
    expect(done).toBeDefined();
    expect(typeof done?.meta?.['expired']).toBe('number');
    expect(done?.meta?.['expired'] as number).toBeGreaterThanOrEqual(1);

    // NO row content in ANY log line: no jti, no owner/document ids (counts
    // only — the reaper/retention no-PII convention).
    const allLogs = JSON.stringify(calls);
    for (const leak of [
      pendingLapsed.jti,
      pendingFuture.jti,
      fx.ownerId,
      fx.documentId,
      pendingLapsed.id,
    ]) {
      expect(allLogs).not.toContain(leak);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// B. Idempotency — an immediate second run flips 0 rows and adds no audit.
// ────────────────────────────────────────────────────────────────────────
describe('sweep:signature-expiry — B. idempotent (second run is a no-op)', () => {
  it('run #2 leaves the flipped row byte-identical and writes no new audit row', async () => {
    const fx = await makeFixture('swpB');
    seededOrgIds.push(fx.org.id);
    const req = await seedRequest({
      orgId: fx.org.id,
      documentId: fx.documentId,
      ownerId: fx.ownerId,
      createdBy: fx.managerId,
      status: 'pending',
      lapsed: true,
    });

    const handler = new SignatureExpiryHandler();

    await handler.handle(SignatureExpiryJobPayloadSchema.parse({}), makeCtx().ctx);
    expect(await status(req.id)).toBe('expired');
    const afterFirst = await snapshot(req.id);
    const auditAfterFirst = await sweepAuditRows(fx.org.id);
    expect(auditAfterFirst).toHaveLength(1); // exactly one row for the run that flipped

    // Second run — nothing matches the predicate for this org any more.
    await handler.handle(SignatureExpiryJobPayloadSchema.parse({}), makeCtx().ctx);
    expect(await snapshot(req.id)).toEqual(afterFirst); // byte-identical, still 'expired'

    // Zero-flip runs write NO audit row for the org (audit_log is append-only
    // + immutable <24mo — daily empty-sweep noise would be forever).
    expect(await sweepAuditRows(fx.org.id)).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────────
// C. Cross-org — ONE run sweeps globally (BYPASSRLS maintenance pool, the
//    reaper/retention pattern) + the per-org system audit convention.
// ────────────────────────────────────────────────────────────────────────
describe('sweep:signature-expiry — C. cross-org sweep + per-org system audit', () => {
  it('one run flips lapsed pending rows in BOTH orgs and audits each org once', async () => {
    const fx1 = await makeFixture('swpC1');
    const fx2 = await makeFixture('swpC2');
    seededOrgIds.push(fx1.org.id, fx2.org.id);

    const req1 = await seedRequest({
      orgId: fx1.org.id,
      documentId: fx1.documentId,
      ownerId: fx1.ownerId,
      createdBy: fx1.managerId,
      status: 'pending',
      lapsed: true,
    });
    const req2 = await seedRequest({
      orgId: fx2.org.id,
      documentId: fx2.documentId,
      ownerId: fx2.ownerId,
      createdBy: fx2.managerId,
      status: 'pending',
      lapsed: true,
    });

    const { ctx, calls } = makeCtx();
    await new SignatureExpiryHandler().handle(SignatureExpiryJobPayloadSchema.parse({}), ctx);

    // The sweep is GLOBAL — one run, both orgs' lapsed rows flipped.
    expect(await status(req1.id)).toBe('expired');
    expect(await status(req2.id)).toBe('expired');

    // Per-org audit convention: exactly ONE audit_log row per affected org,
    // actor_type='system' (actor_id NULL = system per the schema comment),
    // action='signature_request.expired_sweep', metadata {count} — the
    // integer flip-count for THAT org, nothing else PII-shaped.
    for (const fx of [fx1, fx2]) {
      const rows = await sweepAuditRows(fx.org.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor_type).toBe('system');
      expect(rows[0]!.metadata['count']).toBe(1);
    }

    // Audit metadata + logs never carry jti/owner/document identifiers.
    const allLogs = JSON.stringify(calls);
    expect(allLogs).not.toContain(req1.jti);
    expect(allLogs).not.toContain(req2.jti);
  });
});

// ────────────────────────────────────────────────────────────────────────
// D. Registration pin (STATIC) — main.ts wires consumer + producer exactly
//    like the reaper/audit-retention pair. Same static-source-pin style the
//    v6 audit spec uses on mapping-resolver.ts.
// ────────────────────────────────────────────────────────────────────────
describe('sweep:signature-expiry — D. main.ts schedules the job (static pin)', () => {
  const mainSource = readFileSync(join(__dirname, '..', 'src', 'main.ts'), 'utf8');

  it('imports the job name + cron constants from @emapp/jobs', () => {
    expect(mainSource).toMatch(/SIGNATURE_EXPIRY_JOB_NAME/);
    expect(mainSource).toMatch(/SIGNATURE_EXPIRY_CRON_HOURLY/);
  });

  it('registers the handler and schedules it: boss.schedule(name, cron)', () => {
    expect(mainSource).toMatch(/SignatureExpiryHandler/);
    expect(mainSource).toMatch(
      /boss\.schedule\(\s*SIGNATURE_EXPIRY_JOB_NAME\s*,\s*SIGNATURE_EXPIRY_CRON_HOURLY\s*\)/,
    );
  });
});
