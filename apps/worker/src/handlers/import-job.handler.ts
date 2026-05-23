/**
 * `import.excel` handler — Phase 6.
 *
 * S2 scope (this commit): owns the STATE MACHINE + AUDIT TRAIL +
 * IDEMPOTENT TRANSITIONS. The actual parser (S3), validation engine
 * (S5), and persistence batcher (S6) are deliberately stubbed — they
 * land in their own slices behind this seam. The state machine + audit
 * are S2 because they're the contract the SSE endpoint (T6.9) and
 * T6.8 ("queue job runs to completion") gate on; building them once
 * here and not re-shaping them every slice is the audit-pass lesson.
 *
 * State machine (docs/03 §10 + migration 0022 CHECK constraint):
 *   queued → parsing → validating → persisting → done
 *                                              ↘ failed
 *
 * Audit (ISO A.12.4 / docs/07 §12.4): EVERY transition writes an
 * `audit_log` row inside the same withTenant tx that updates
 * `import_jobs.status`. So either both happen or neither happens —
 * audit can never desync from the domain row.
 *
 * Idempotency on retry:
 *   - If the worker dies mid-handler and pg-boss retries, the row
 *     might already be in (say) 'validating'. The handler runs the
 *     state machine from `current` forward — each transition is a
 *     guarded UPDATE (... WHERE status = <expected>) so a second worker
 *     that already advanced past a stage is a no-op.
 *   - The audit_log writes ARE per-attempt by design (forensic record:
 *     we want to see "validating reached twice" if it happens). The
 *     STATE updates are idempotent; the AUDIT is append-only.
 *
 * No PII anywhere:
 *   - The payload carries jobId+orgId+createdBy only (see
 *     @emapp/jobs/import-job.ts).
 *   - This handler never reads file content (S3) or owner rows (S5+).
 *   - Logs scope by jobId; nothing else.
 */
import {
  AuditService,
  apartments,
  buildings,
  encryptOwnerPiiBatch,
  hashField,
  env,
  importJobErrors,
  importJobs,
  owners,
  ownerships,
  withTenant,
  type IStorageProvider,
  type TenantTx,
} from '@emapp/db';
import {
  IMPORT_JOB_NAME,
  ImportJobPayloadSchema,
  NonRetryableJobError,
  type IJobHandler,
  type ImportJobPayload,
  type JobContext,
} from '@emapp/jobs';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { type ColumnMapping } from '../mapping/mapping';
import { LegacyAliasResolver, type IMappingResolver } from '../mapping/mapping-resolver';
import { ExcelParserError, parseExcelFull, type ParsedRows } from '../parser/excel.parser';
import { summariseFailureForAudit } from '../security/audit-sanitiser';
import { validateRow } from '../validation/row-validator';

/** A validated row that passed S5 row-validator. The canonical fields
 *  are extracted + trimmed; persistStage (S6) consumes this shape. */
interface ValidatedRow {
  /** 1-indexed source row in the Excel (for forensic mapping). */
  rowNumber: number;
  nationalId: string;
  phone: string;
  name: string;
  apartmentNumber: string;
  buildingAddress: string;
  /** Already parsed to a number (0..100). null when the column was
   *  unmapped or empty — persistStage applies the default (100 for
   *  a single owner, error if multi-owner without explicit pct). */
  ownershipPct: number | null;
}

/** Per-`handle()` cache so parseStage's parsed rows are reused by
 *  validateStage instead of being re-downloaded + re-parsed.
 *
 *  Audit-pass v2 finding L6: a clean run wasted ~1-2s on the double
 *  R2 GET + ExcelJS load. The cache cuts that to one read per job.
 *
 *  Scope: ONE per `handler.handle(...)` invocation — created at the
 *  top of handle() and dropped on return. Survives across stages
 *  WITHIN one attempt; does NOT persist across pg-boss retries (a
 *  retry is a fresh handle() call → empty cache → validateStage
 *  re-downloads, which is the correct restart-from-scratch posture). */
interface JobCache {
  parsed?: ParsedRows;
  mapping?: ColumnMapping;
  /** Rows that passed validation (S5). persistStage (S6) consumes
   *  these to build the owners + apartments + buildings + ownerships
   *  trees. Populated by validateStage. */
  okRows?: ValidatedRow[];
  /** Marker — true after persistStage commits successfully in THIS
   *  handle() invocation. Used by runStage's A4 recovery hook to
   *  avoid duplicate work in the normal forward path. Audit-pass v3
   *  finding A4 (HIGH/P0). */
  persisted?: boolean;
}

/** Domain state machine. MUST match the CHECK constraint in migration
 *  0022 (`import_jobs_status_valid`). Compile-time alignment with
 *  packages/db/src/schema/imports.ts is enforced by the typed UPDATEs
 *  below (Drizzle infers the column type as `text`, runtime CHECK
 *  guards the value). */
/** Status enum — MUST match migration 0027's CHECK constraint. */
type Status =
  | 'queued'
  | 'parsing'
  | 'validating'
  | 'persisting'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'awaiting_mapping';

/** Extract a row's canonical-field values from the parsed cell vector,
 *  given the resolved mapping. Returns a ValidatedRow ready for S6's
 *  persistence pipeline. The mapping has already been confirmed
 *  complete by resolveMapping, so the required canonicals all have
 *  column indexes. */
function extractValidatedRow(
  row: string[],
  rowNumber: number,
  mapping: ColumnMapping,
): ValidatedRow {
  const get = (col: number | undefined): string =>
    col !== undefined ? (row[col] ?? '').trim() : '';
  const pctCol = mapping.columns.ownership_pct;
  let ownershipPct: number | null = null;
  if (pctCol !== undefined) {
    const raw = get(pctCol);
    if (raw !== '') {
      const parsed = Number(raw.replace('%', ''));
      if (Number.isFinite(parsed)) ownershipPct = parsed;
    }
  }
  return {
    rowNumber,
    nationalId: get(mapping.columns.national_id).padStart(9, '0'),
    phone: get(mapping.columns.phone),
    name: get(mapping.columns.name),
    apartmentNumber: get(mapping.columns.apartment_number),
    buildingAddress: get(mapping.columns.building_address),
    ownershipPct,
  };
}

/** Find-or-create a building row keyed by (project, address). Caches
 *  results in `cache` so a multi-row import that all targets one
 *  building does one SELECT + one INSERT (max) across all rows. */
async function findOrCreateBuilding(
  tx: TenantTx,
  projectId: string,
  address: string,
  cache: Map<string, string>,
): Promise<string> {
  const hit = cache.get(address);
  if (hit) return hit;

  const [existing] = await tx
    .select({ id: buildings.id })
    .from(buildings)
    .where(
      and(
        eq(buildings.projectId, projectId),
        eq(buildings.address, address),
        sql`${buildings.archivedAt} IS NULL`,
      ),
    )
    .limit(1);
  if (existing) {
    cache.set(address, existing.id);
    return existing.id;
  }

  // City is required (NOT NULL). The import file has no city column
  // in the MVP mapping; default to a sentinel that the Manager can
  // edit via the buildings UI. S8's wizard could pre-fill from
  // project metadata; that's a UX improvement, not an S6 blocker.
  const [created] = await tx
    .insert(buildings)
    .values({ projectId, address, city: '-' })
    .returning({ id: buildings.id });
  if (!created) throw new Error('failed to insert building');
  cache.set(address, created.id);
  return created.id;
}

/** Find-or-create an apartment keyed by (building, number). Kept as
 *  the single-record fallback for callers outside the batched path;
 *  resolveApartmentsBatch is the production hot-path. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function findOrCreateApartment(
  tx: TenantTx,
  buildingId: string,
  number: string,
  cache: Map<string, string>,
): Promise<string> {
  const key = `${buildingId}${number}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const [existing] = await tx
    .select({ id: apartments.id })
    .from(apartments)
    .where(
      and(
        eq(apartments.buildingId, buildingId),
        eq(apartments.number, number),
        sql`${apartments.archivedAt} IS NULL`,
      ),
    )
    .limit(1);
  if (existing) {
    cache.set(key, existing.id);
    return existing.id;
  }

  const [created] = await tx
    .insert(apartments)
    .values({ buildingId, number })
    .returning({ id: apartments.id });
  if (!created) throw new Error('failed to insert apartment');
  cache.set(key, created.id);
  return created.id;
}

/** Batch resolve apartments — find-or-create one per (building, number)
 *  group. Same pattern as resolveOwnersBatch — ~3 round-trips total
 *  regardless of N. Audit-pass v3 E1/E2 perf fix.
 *
 *  Map key = `${buildingId}\x00${number}` (NUL is a safe separator
 *  since neither buildingId UUIDs nor apartment numbers contain it). */
async function resolveApartmentsBatch(
  tx: TenantTx,
  specs: Array<{ buildingId: string; number: string }>,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (specs.length === 0) return result;

  // Dedupe input — same building+number from multiple rows is one
  // apartment.
  const unique = new Map<string, { buildingId: string; number: string }>();
  for (const s of specs) {
    const key = `${s.buildingId}\x00${s.number}`;
    if (!unique.has(key)) unique.set(key, s);
  }

  const buildingIds = [...new Set([...unique.values()].map((s) => s.buildingId))];

  const existing = await tx
    .select({ id: apartments.id, buildingId: apartments.buildingId, number: apartments.number })
    .from(apartments)
    .where(and(inArray(apartments.buildingId, buildingIds), sql`${apartments.archivedAt} IS NULL`));
  for (const r of existing) {
    const key = `${r.buildingId}\x00${r.number}`;
    if (unique.has(key)) result.set(key, r.id);
  }

  const toCreate: Array<{ buildingId: string; number: string }> = [];
  for (const [key, spec] of unique) {
    if (!result.has(key)) toCreate.push(spec);
  }
  if (toCreate.length === 0) return result;

  const inserted = await tx
    .insert(apartments)
    .values(toCreate)
    .onConflictDoNothing({
      target: [apartments.buildingId, apartments.number],
      where: sql`archived_at IS NULL`,
    })
    .returning({
      id: apartments.id,
      buildingId: apartments.buildingId,
      number: apartments.number,
    });
  for (const r of inserted) {
    result.set(`${r.buildingId}\x00${r.number}`, r.id);
  }

  // Race recovery (concurrent imports beat us to the insert).
  const stillMissing = toCreate.filter((t) => !result.has(`${t.buildingId}\x00${t.number}`));
  if (stillMissing.length > 0) {
    const recoveryBuildings = [...new Set(stillMissing.map((s) => s.buildingId))];
    const recovered = await tx
      .select({ id: apartments.id, buildingId: apartments.buildingId, number: apartments.number })
      .from(apartments)
      .where(
        and(
          inArray(apartments.buildingId, recoveryBuildings),
          sql`${apartments.archivedAt} IS NULL`,
        ),
      );
    for (const r of recovered) {
      const key = `${r.buildingId}\x00${r.number}`;
      if (unique.has(key)) result.set(key, r.id);
    }
  }

  return result;
}

/** Batch resolve N owners — find-or-create keyed by
 *  (org_id, national_id_hash). Returns Map<nationalIdHash, ownerId>.
 *
 *  Audit-pass v3 finding E1/E2 (perf): the prior per-row
 *  findOrCreateOwner did 3-4 DB round-trips per owner (2 encrypt + 1
 *  select + maybe 1 insert). For 100 owners that's ~400 round-trips,
 *  ~20s on Neon. T6.10 measured 60s post-S6 — over the 45s spec.
 *
 *  Batched: 4 round-trips total regardless of owner count:
 *    1. SELECT existing by hash[] (one round-trip via ANY).
 *    2. encryptOwnerPiiBatch for NEW owners (2 round-trips for
 *       national_id + phone columns).
 *    3. INSERT new owners as a batch (one round-trip via VALUES
 *       (...)+ON CONFLICT DO NOTHING — A1 safety against the
 *       concurrent-import race).
 *
 *  Cross-import dedup is RESOLVED here: a row whose hash matches an
 *  existing active owner row reuses that owner. */
async function resolveOwnersBatch(
  tx: TenantTx,
  orgId: string,
  rowsByHash: Map<string, ValidatedRow>,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (rowsByHash.size === 0) return result;

  // Step 1: find existing owners by national_id_hash[]. ONE round-trip.
  const hashes = [...rowsByHash.keys()];
  const existing = await tx
    .select({ id: owners.id, hash: owners.nationalIdHash })
    .from(owners)
    .where(
      and(
        eq(owners.orgId, orgId),
        inArray(owners.nationalIdHash, hashes),
        sql`${owners.archivedAt} IS NULL`,
      ),
    );
  for (const r of existing) result.set(r.hash, r.id);

  // Step 2: gather rows whose owners need to be created.
  const toCreate: Array<{ hash: string; row: ValidatedRow }> = [];
  for (const [hash, row] of rowsByHash) {
    if (!result.has(hash)) toCreate.push({ hash, row });
  }
  if (toCreate.length === 0) return result;

  // Step 3: batch-encrypt PII for all new rows. 2 round-trips.
  const enc = await encryptOwnerPiiBatch(
    tx,
    toCreate.map((t) => ({ nationalId: t.row.nationalId, phone: t.row.phone })),
  );

  // Step 4: batch INSERT new owners. ONE round-trip.
  // ON CONFLICT DO NOTHING guards against the TOCTOU race (audit-pass
  // v3 A1): two concurrent imports for the same org with the same
  // hash would both pass the SELECT — under ON CONFLICT the second
  // insert is a no-op, and we re-SELECT to recover the existing id.
  const values = toCreate.map((t, i) => ({
    orgId,
    name: t.row.name,
    nationalIdEncrypted: enc[i]!.nationalIdEncrypted,
    nationalIdHash: enc[i]!.nationalIdHash,
    phoneEncrypted: enc[i]!.phoneEncrypted,
    phoneHash: enc[i]!.phoneHash,
  }));
  // The unique index is PARTIAL (WHERE archived_at IS NULL — see
  // owners schema). ON CONFLICT must therefore include the partial
  // predicate to match the index — drizzle exposes this via
  // `targetWhere`. Without it, pg fails with 42P10 (no constraint
  // matching ON CONFLICT specification).
  const inserted = await tx
    .insert(owners)
    .values(values)
    .onConflictDoNothing({
      target: [owners.orgId, owners.nationalIdHash],
      where: sql`archived_at IS NULL`,
    })
    .returning({ id: owners.id, hash: owners.nationalIdHash });
  for (const r of inserted) result.set(r.hash, r.id);

  // Step 5 (race-recovery): if any to-create rows didn't land in
  // `inserted` (ON CONFLICT skipped because a concurrent tx beat us
  // to the insert), re-SELECT by hash to fetch the winning id. ONE
  // round-trip (only fires under contention; in tests usually empty).
  const stillMissing = toCreate.filter((t) => !result.has(t.hash));
  if (stillMissing.length > 0) {
    const recoveryHashes = stillMissing.map((t) => t.hash);
    const recovered = await tx
      .select({ id: owners.id, hash: owners.nationalIdHash })
      .from(owners)
      .where(
        and(
          eq(owners.orgId, orgId),
          inArray(owners.nationalIdHash, recoveryHashes),
          sql`${owners.archivedAt} IS NULL`,
        ),
      );
    for (const r of recovered) result.set(r.hash, r.id);
  }

  return result;
}

/** Linear transition order. The handler walks forward only — never
 *  backward. Cancellation comes from a separate API endpoint (S8), not
 *  from inside the handler. */
const FORWARD: Record<Status, Status | null> = {
  queued: 'parsing',
  parsing: 'validating',
  validating: 'persisting',
  persisting: 'done',
  done: null,
  failed: null,
  cancelled: null,
  // D.34 Layer-mapping seam: 'awaiting_mapping' is terminal-for-this-
  // pg-boss-attempt. The wizard (S8) or agent (Phase 7+) resolves the
  // mapping out-of-band, transitions the row back to 'validating'
  // (with mapping_template_id set), and re-enqueues a new pg-boss job.
  // This handler does NOT forward-progress past awaiting_mapping.
  awaiting_mapping: null,
};

export class ImportJobHandler implements IJobHandler<ImportJobPayload> {
  readonly name = IMPORT_JOB_NAME;
  /** 10 minutes — large enough for 1000-row imports per T6.11; the S7
   *  perf gate will tighten if needed. */
  readonly timeoutMs = 10 * 60 * 1000;
  /** pg-boss retries on retryable errors. 2 retries = 3 total attempts
   *  before the boss marks it failed. Transient DB blips warrant a
   *  retry; persistent issues (bad file) throw NonRetryableJobError
   *  and stop immediately. */
  readonly maxRetries = 2;

  /** Exposed so the adapter's payload validation uses the same schema
   *  the rest of the codebase imports (single source of truth). */
  readonly payloadSchema = ImportJobPayloadSchema;

  /** Dependencies (DI seam):
   *
   *  - `storage` (S3): R2 / FakeStorageProvider. Optional; the
   *    no-storage path is exercised by legacy T6.8 tests + the
   *    storageProviderFactory fail-fast guards prod.
   *
   *  - `mappingResolver` (S7 / D.34): the mapping-strategy chain.
   *    Defaults to a single-element chain of `LegacyAliasResolver`
   *    (the deterministic Layer-1 alias registry). Production
   *    main.ts MAY compose additional layers (Layer-2 saved
   *    templates, Layer-3 agent) — but ONLY once the wizard /
   *    agent endpoints land. */
  constructor(
    private readonly storage?: IStorageProvider,
    private readonly mappingResolver: IMappingResolver = new LegacyAliasResolver(),
  ) {}

  async handle(payload: ImportJobPayload, ctx: JobContext): Promise<void> {
    ctx.log.info('import job picked up', { orgId: payload.orgId });

    // v4 audit fix (HIGH security): fetch the trusted actor id from
    // the DB row, not from the payload. pg-boss carries the payload
    // over the BYPASSRLS queue plumbing; a tampered enqueue could
    // otherwise mis-attribute audit_log entries to someone else's
    // user_id. We read `import_jobs.created_by` once at entry and
    // thread it down the state-machine loop so EVERY audit row in
    // this handle() invocation carries the DB-trusted actor id.
    // If the row isn't visible (cross-org tamper / forensic delete),
    // we fall back to payload.createdBy for the single audit-row
    // attempt below and let readStatus throw NonRetryable.
    let verifiedActorId: string = payload.createdBy;
    try {
      await withTenant(
        payload.orgId,
        async (tx) => {
          const [row] = await tx
            .select({ createdBy: importJobs.createdBy })
            .from(importJobs)
            .where(eq(importJobs.id, payload.jobId))
            .limit(1);
          if (!row) return;
          verifiedActorId = row.createdBy;
          // Audit-pass v2 finding C5 (HIGH): the first audit row used
          // to be `import.parsing` — a regulator scanning audit_log saw
          // jobs springing into existence at parsing with no
          // worker-side provenance. Now we write `import.received` at
          // handler entry, BEFORE any state transition.
          //
          // Per-attempt (NOT deduped on retry): pg-boss retries ARE
          // forensically meaningful events — each retry indicates a
          // prior failure that warrants its own audit trail.
          // metadata carries ctx.attempt so the retry sequence is
          // reconstructable.
          await new AuditService(tx).log({
            orgId: payload.orgId,
            actorId: verifiedActorId,
            actorType: 'system',
            action: 'import.received',
            targetTable: 'import_jobs',
            targetId: payload.jobId,
            metadata: { pg_boss_job_id: ctx.jobId, attempt: String(ctx.attempt) },
          });
        },
        { userId: payload.createdBy },
      );
    } catch (e: unknown) {
      // Audit write failure is non-fatal — log + continue. Better to
      // run the job than to refuse it because of an audit blip.
      ctx.log.warn('failed to write import.received audit row', {
        reason: e instanceof Error ? e.name : 'unknown',
      });
    }

    // Per-attempt cache — see JobCache JSDoc.
    const cache: JobCache = {};

    try {
      // Drive the state machine forward until we hit `done` (or an
      // error transitions to `failed`). Each iteration is one withTenant
      // tx — small, fast, idempotent.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (ctx.signal.aborted) {
          ctx.log.warn('shutdown signal received — pausing; pg-boss will retry');
          // Throwing a generic Error → pg-boss retries (default retryable).
          throw new Error('worker_shutting_down');
        }

        const current = await this.readStatus(payload);
        const next = FORWARD[current];
        if (next === null) {
          // Terminal state reached — done, failed, or cancelled. Nothing
          // more to do. Idempotent across retries.
          ctx.log.info('terminal state reached', { status: current });
          return;
        }

        await this.runStage({ payload, ctx, from: current, to: next, cache, verifiedActorId });
      }
    } catch (err) {
      // On any error: transition to 'failed' (idempotent guarded UPDATE)
      // and audit the failure. The thrown error then propagates to
      // pg-boss so the queue records the right retry/dead-letter state.
      await this.markFailed(payload, err, verifiedActorId);
      throw err;
    }
  }

  /** Read the current status under withTenant. Returns 'failed' if the
   *  row has vanished (e.g. provider-admin forensic deletion) — that's
   *  a terminal state so the handler exits cleanly. */
  private async readStatus(payload: ImportJobPayload): Promise<Status> {
    return withTenant(
      payload.orgId,
      async (tx: TenantTx): Promise<Status> => {
        const [row] = await tx
          .select({ status: importJobs.status })
          .from(importJobs)
          .where(eq(importJobs.id, payload.jobId))
          .limit(1);
        if (!row) {
          // No row visible under withTenant — the job was deleted out
          // from under us, OR (more likely) orgId in the payload was
          // tampered with. Both are non-retryable.
          throw new NonRetryableJobError('import_job not visible', 'job_not_visible');
        }
        return row.status as Status;
      },
      { userId: payload.createdBy },
    );
  }

  /** Execute one stage and commit the transition. The pre-stage UPDATE
   *  uses an idempotency guard (WHERE status = expected) so a retried
   *  worker that already moved past this stage observes 0 rows affected
   *  and skips. */
  private async runStage(opts: {
    payload: ImportJobPayload;
    ctx: JobContext;
    from: Status;
    to: Status;
    cache: JobCache;
    /** v4 audit fix — DB-trusted actor id (NOT payload.createdBy). */
    verifiedActorId: string;
  }): Promise<void> {
    const { payload, ctx, from, to, cache, verifiedActorId } = opts;
    ctx.log.info('stage transition', { from, to });

    // Audit-pass v3 finding A4 (HIGH/P0) — data-loss recovery hook.
    // When the prior handler attempt committed the validating→
    // persisting transition (so state in DB is already 'persisting')
    // but crashed/failed inside persistStage's own tx (so no domain
    // rows were written), pg-boss retries with a fresh handle()
    // having an empty cache. The retry's state-machine loop sees
    // state='persisting', next='done', and reaches THIS runStage call
    // with from='persisting', to='done'. The normal stage-dispatch
    // below only runs work for `to` — and `to='done'` has no work.
    //
    // Without this hook, the transition persisting→done commits
    // SILENTLY with zero domain writes — the Manager UI shows
    // "import succeeded" while the database has nothing. P0
    // trust-destroying failure for a tool handling regulated PII.
    //
    // Fix: when closing out 'persisting' and persistStage did NOT
    // run in this handle() (cache.persisted is false), run it NOW,
    // BEFORE the transition commits. persistStage is idempotent on
    // re-entry via find-or-create (Phase 6 contract). On success it
    // sets cache.persisted=true so the normal forward path doesn't
    // double-run it.
    if (from === 'persisting' && to === 'done' && !cache.persisted) {
      ctx.log.warn('A4 recovery — persistStage did not complete this attempt; running now', {
        jobId: payload.jobId,
      });
      await this.persistStage(payload, ctx, cache);
    }

    await withTenant(
      payload.orgId,
      async (tx) => {
        // Guarded transition: only advance if the row is still in `from`.
        // If another worker advanced it (or the user cancelled), 0 rows
        // affected → handler loops, re-reads, and follows the new state.
        const now = new Date();
        const updates: Partial<typeof importJobs.$inferInsert> = {
          status: to,
          updatedAt: now,
        };
        if (from === 'queued') updates.startedAt = now;
        if (to === 'done') updates.finishedAt = now;

        const result = await tx
          .update(importJobs)
          .set(updates)
          .where(and(eq(importJobs.id, payload.jobId), eq(importJobs.status, from)));

        // Drizzle's node-postgres update returns a result with rowCount.
        // If 0, the transition lost a race — that's fine, the outer
        // loop will re-read the current status next iteration.
        const rowCount = (result as unknown as { rowCount?: number }).rowCount ?? 0;
        if (rowCount === 0) {
          ctx.log.warn('transition skipped — row not in expected state', { from, to });
          return;
        }

        // Audit the transition. Same tx as the UPDATE → atomic.
        // actor_type='system' (worker has no user-session context; the
        // DB-trusted created_by is recorded as actorId via verifiedActorId).
        // See public-sign.service.ts:328 for the canonical pattern.
        await new AuditService(tx).log({
          orgId: payload.orgId,
          actorId: verifiedActorId,
          actorType: 'system',
          action: `import.${to}`,
          targetTable: 'import_jobs',
          targetId: payload.jobId,
          metadata: { from, to, pg_boss_job_id: ctx.jobId },
        });
      },
      { userId: payload.createdBy },
    );

    // Stage stub work (S3/S5/S6 replace these). Each progresses
    // processedRows so the SSE stream has something to emit — without
    // it T6.9 would observe a state-only stream which is technically
    // correct but practically useless. We keep this minimal: real
    // parsing/validation/persistence is large + slice-owned.
    if (to === 'parsing') await this.parseStage(payload, ctx, cache, verifiedActorId);
    if (to === 'validating') await this.validateStage(payload, ctx, cache);
    if (to === 'persisting') await this.persistStage(payload, ctx, cache);
  }

  /** S3 — real ExcelJS streaming parse. Reads `file_r2_key` from the
   *  domain row, streams bytes via IStorageProvider, detects the
   *  header row + counts data rows (T6.1), and writes totalRows back
   *  to the same import_jobs row. Without an IStorageProvider (the
   *  pre-S3 unit-test path, T6.8 baseline) this falls back to the S2
   *  stub semantics so existing tests keep passing.
   *
   *  Errors:
   *   - ExcelParserError (corrupt/sparse/formula-in-header) → wrapped
   *     as NonRetryableJobError so pg-boss skips retries and
   *     markFailed transitions the domain row to 'failed'.
   *   - Storage I/O error (R2 blip) → propagate as RETRYABLE; the
   *     boss's retry policy handles it. */
  private async parseStage(
    payload: ImportJobPayload,
    ctx: JobContext,
    cache: JobCache,
    verifiedActorId: string,
  ): Promise<void> {
    if (!this.storage) {
      // Pre-S3 fallback — keeps T6.8's bare `new ImportJobHandler()`
      // path running. Production main.ts always injects a provider.
      await withTenant(
        payload.orgId,
        async (tx) => {
          await tx
            .update(importJobs)
            .set({ totalRows: 0, updatedAt: new Date() })
            .where(eq(importJobs.id, payload.jobId));
        },
        { userId: payload.createdBy },
      );
      return;
    }

    const row = await withTenant(
      payload.orgId,
      async (tx) => {
        const [r] = await tx
          .select({ fileR2Key: importJobs.fileR2Key })
          .from(importJobs)
          .where(eq(importJobs.id, payload.jobId))
          .limit(1);
        return r;
      },
      { userId: payload.createdBy },
    );
    if (!row) {
      throw new NonRetryableJobError('import_job vanished mid-parse', 'job_not_visible');
    }

    // Audit-pass v2 finding L6: parseStage USED to call
    // parseExcelHeader (header + rowCount only) and validateStage
    // re-downloaded + re-parsed via parseExcelFull. That cost ~1-2s
    // wasted from the T6.10 45s budget per 100-row job.
    //
    // Now parseStage runs parseExcelFull and caches the result in the
    // per-attempt JobCache so validateStage reuses it. Memory delta is
    // tiny vs the cost saved (typical 1000-row import = ~300KB of
    // string[][], 100x cheaper than the R2 round-trip + decompression).
    let parsed: ParsedRows;
    try {
      const stream = await this.storage.getObjectStream(row.fileR2Key);
      parsed = await parseExcelFull(stream);
    } catch (e: unknown) {
      if (e instanceof ExcelParserError) {
        throw new NonRetryableJobError(`parse failed: ${e.code}`, `parse_${e.code}`);
      }
      throw e;
    }

    // S7 / D.34 — layered mapping resolution. The injected resolver
    // is a chain (LegacyAliasResolver today; future: + TemplateResolver
    // + AgentResolver). Three possible outcomes:
    //   resolved: continue to validateStage with the column mapping.
    //   reject:   malformed input (duplicate alias). NonRetryable.
    //   unknown:  no strategy could resolve. Transition the row to
    //             'awaiting_mapping' and stop — the wizard (S8) or
    //             agent (Phase 7+) resolves out-of-band.
    const resolution = await this.mappingResolver.resolve(parsed.headers);
    if (resolution.kind === 'reject') {
      throw new NonRetryableJobError(`mapping rejected: ${resolution.reason}`, 'mapping_rejected');
    }
    if (resolution.kind === 'unknown') {
      // D.34: graceful await — the manager (or agent) will provide
      // a mapping via the wizard endpoint (S8). We commit the
      // 'parsing' → 'awaiting_mapping' transition + an audit row,
      // log + return. pg-boss sees no error (no retry storm).
      ctx.log.warn('mapping unresolved — transitioning to awaiting_mapping', {
        header_count: parsed.headers.length,
      });
      await withTenant(
        payload.orgId,
        async (tx) => {
          const now = new Date();
          await tx
            .update(importJobs)
            .set({
              status: 'awaiting_mapping',
              totalRows: parsed.rowCount,
              updatedAt: now,
              // v5 audit fix (P0 — D.34 wizard fingerprint):
              // persist the parsed headers so the API service
              // `submitMapping` can compute the real headers-
              // fingerprint when storing the manual template.
              // Without this the saved template carries a
              // placeholder fingerprint and is invisible to the
              // future L2 TemplateResolver (Phase 7+).
              parsedHeaders: parsed.headers,
            })
            // v4 audit fix (HIGH security): guard against a
            // cancel-race. parseStage acquires status='parsing' via
            // runStage; if a Manager hits cancel between that
            // transition and this UPDATE, the cancelled row would
            // otherwise be silently revived to 'awaiting_mapping'.
            // Same posture as the main runStage guarded UPDATE.
            .where(and(eq(importJobs.id, payload.jobId), eq(importJobs.status, 'parsing')));
          await new AuditService(tx).log({
            orgId: payload.orgId,
            actorId: verifiedActorId,
            actorType: 'system',
            action: 'import.awaiting_mapping',
            targetTable: 'import_jobs',
            targetId: payload.jobId,
            metadata: {
              header_count: String(parsed.headers.length),
              resolver: this.mappingResolver.name,
            },
          });
        },
        { userId: payload.createdBy },
      );
      // Signal the state-machine loop to halt at this state (the
      // outer loop reads the new status, finds null next, returns).
      cache.parsed = parsed;
      return;
    }
    const mapping: ColumnMapping = resolution.mapping;
    ctx.log.info('mapping resolved', {
      bound: Object.keys(mapping.columns).length,
      unmapped: mapping.unmapped.length,
      ambiguous: mapping.ambiguous.length,
      source: resolution.source,
    });

    cache.parsed = parsed;
    cache.mapping = mapping;

    ctx.log.info('excel header detected', {
      header_cols: parsed.headers.length,
      data_rows: parsed.rowCount,
    });

    await withTenant(
      payload.orgId,
      async (tx) => {
        await tx
          .update(importJobs)
          .set({ totalRows: parsed.rowCount, updatedAt: new Date() })
          .where(eq(importJobs.id, payload.jobId));
      },
      { userId: payload.createdBy },
    );
  }

  /** S5 — validate every data row.
   *  Closes T6.3 (Luhn), T6.4 (in-file dedup). Iterates the file's
   *  data rows, applies the mapping (S4), runs validateRow per row,
   *  and inserts structured per-row errors into import_job_errors.
   *  Updates aggregate counters (processed_rows, ok_rows, failed_rows)
   *  on the parent import_jobs row.
   *
   *  No-provider path keeps the S2 stub behaviour (zero counters, no
   *  errors) so the legacy T6.8 baseline still passes.
   *
   *  T6.5 dry-run is NOT handled here — persistStage early-exits when
   *  dry_run=true. Validation always runs (dry-run shows the manager
   *  what WOULD happen — same errors, just no persistence). */
  private async validateStage(
    payload: ImportJobPayload,
    ctx: JobContext,
    cache: JobCache,
  ): Promise<void> {
    if (!this.storage) {
      await withTenant(
        payload.orgId,
        async (tx) => {
          await tx
            .update(importJobs)
            .set({ updatedAt: new Date() })
            .where(eq(importJobs.id, payload.jobId));
        },
        { userId: payload.createdBy },
      );
      // S2-baseline stub-fallback path: no storage means no rows
      // could be validated, so the cache is legitimately empty.
      // Audit-pass v3 A4: persistStage's recovery hook checks
      // `cache.okRows === undefined` to distinguish "rebuild
      // failed" from "rebuild produced no rows". Populate as []
      // here so the recovery hook treats this as "nothing to
      // persist" (correct for a no-storage handler) rather than
      // "rebuild failed" (NonRetryable).
      cache.okRows = [];
      return;
    }

    // L6: prefer the per-attempt cache (parseStage in this same
    // handle() invocation already paid for the R2 GET + ExcelJS load).
    // Falls back to re-download for the retry path: pg-boss restart
    // mid-flight reads `current='validating'` and the cache is empty
    // because handle() is fresh. The fallback preserves correctness
    // (a retry MUST be self-contained) at the cost of duplicating the
    // download — same posture as before L6, just now ONLY on retry.
    let parsed: ParsedRows;
    let mapping: ColumnMapping;

    if (cache.parsed && cache.mapping) {
      parsed = cache.parsed;
      mapping = cache.mapping;
      ctx.log.info('validateStage using cached parse result');
    } else {
      const row = await withTenant(
        payload.orgId,
        async (tx) => {
          const [r] = await tx
            .select({ fileR2Key: importJobs.fileR2Key })
            .from(importJobs)
            .where(eq(importJobs.id, payload.jobId))
            .limit(1);
          return r;
        },
        { userId: payload.createdBy },
      );
      if (!row) {
        throw new NonRetryableJobError('import_job vanished mid-validate', 'job_not_visible');
      }
      try {
        const stream = await this.storage.getObjectStream(row.fileR2Key);
        parsed = await parseExcelFull(stream);
      } catch (e: unknown) {
        if (e instanceof ExcelParserError) {
          throw new NonRetryableJobError(`parse failed: ${e.code}`, `parse_${e.code}`);
        }
        throw e;
      }
      // S7 / D.34: same resolver chain as parseStage (consistent
      // semantics on retry). If the resolver can't decide, the file
      // SHOULD have been parked in 'awaiting_mapping' at parseStage —
      // reaching validateStage's cache-miss path means the manager
      // already approved a mapping (set mapping_template_id). For
      // now we re-run the resolver; Phase 7+ adds a TemplateResolver
      // that uses mapping_template_id as a forced override.
      const res = await this.mappingResolver.resolve(parsed.headers);
      if (res.kind === 'resolved') {
        mapping = res.mapping;
      } else {
        // Can't resolve in the rebuild path — surface NonRetryable.
        // The original parseStage transition should have caught this;
        // if we're here on a retry, the manager/agent hasn't completed
        // their mapping yet.
        throw new NonRetryableJobError(
          `validate cache rebuild — mapping not resolvable (kind=${res.kind})`,
          'mapping_unresolved_at_validate',
        );
      }
    }

    // Run validation across all rows. seenIds is per-import — T6.4
    // dedup is in-file only; cross-import duplicate detection would
    // need a different mechanism (likely a DB query under withTenant)
    // and is NOT part of T6.4's scope per docs/03 §10.
    const seenIds = new Set<string>();
    let okCount = 0;
    let failedCount = 0;
    const errorBatch: Array<{
      jobId: string;
      orgId: string;
      rowNumber: number;
      field: string | null;
      code: string;
      message: string;
    }> = [];
    const okRows: ValidatedRow[] = [];

    for (let i = 0; i < parsed.rows.length; i += 1) {
      const result = validateRow(parsed.rows[i]!, parsed.rowNumbers[i]!, mapping, seenIds);
      if (result.ok) {
        okCount += 1;
        // S6 — cache the validated row's canonical-extracted shape so
        // persistStage doesn't have to re-extract from the raw row.
        okRows.push(extractValidatedRow(parsed.rows[i]!, parsed.rowNumbers[i]!, mapping));
      } else {
        failedCount += 1;
        for (const err of result.errors) {
          errorBatch.push({
            jobId: payload.jobId,
            orgId: payload.orgId,
            rowNumber: err.rowNumber,
            field: err.field,
            code: err.code,
            message: err.message,
          });
        }
      }
    }

    // Cache the validated rows for persistStage (S6).
    cache.okRows = okRows;

    // Persist counters + errors atomically. Batch errors into one
    // INSERT — for typical 100-row imports with handful of errors this
    // is a single round-trip; for pathological all-fail cases the
    // batch fits well within Postgres parameter limits (each row has
    // 6 columns; 1000 rows = 6000 params, under the 65k limit).
    await withTenant(
      payload.orgId,
      async (tx) => {
        await tx
          .update(importJobs)
          .set({
            // overwrite (not add) — on pg-boss retry these reflect the
            // CURRENT validation pass, not an accumulation.
            processedRows: parsed.rows.length,
            okRows: okCount,
            failedRows: failedCount,
            updatedAt: new Date(),
          })
          .where(eq(importJobs.id, payload.jobId));
        if (errorBatch.length > 0) {
          // Audit-pass v2 finding C9 (MEDIUM): on pg-boss retry the
          // same row+code is recomputed; without ON CONFLICT DO
          // NOTHING the table would double up every error row on
          // every retry. Migration 0025 added the UNIQUE
          // (job_id, row_number, code) index; this clause uses it.
          await tx
            .insert(importJobErrors)
            .values(errorBatch)
            .onConflictDoNothing({
              target: [importJobErrors.jobId, importJobErrors.rowNumber, importJobErrors.code],
            });
        }
      },
      { userId: payload.createdBy },
    );

    ctx.log.info('validation complete', {
      processed: parsed.rows.length,
      ok: okCount,
      failed: failedCount,
    });
  }

  /** S6 — real persistence (closes T6.6 + T6.7).
   *
   *  Materialises validated rows into the domain model:
   *    1. Resolve / find-or-create one building per unique
   *       (project_id, address) — buildings.city defaults to a
   *       sentinel '-' until the wizard adds a city column.
   *    2. Resolve / find-or-create one apartment per unique
   *       (building_id, number).
   *    3. For each ok row: encrypt PII (pgcrypto via encryptOwnerPii)
   *       and find-or-create the owner by national_id_hash.
   *    4. Per apartment, atomically set-replace ownerships (D.25):
   *       end any active ownership rows, insert the new set. The
   *       DEFERRABLE INITIALLY DEFERRED sum-check trigger fires at
   *       COMMIT; per-apartment sums must total exactly 100 (or 0
   *       if zero rows). The handler refuses to advance an apartment
   *       whose imported rows don't sum to 100.
   *
   *  Everything inside ONE withTenant transaction so the constraint
   *  trigger sees a consistent state. Idempotent on pg-boss retry:
   *    - find-or-create is naturally idempotent.
   *    - ownership set-replace is idempotent (end + insert with the
   *      same percentages = same final state).
   *
   *  Dry-run path (T6.5): persistStage early-exits when
   *  import_jobs.dry_run = true. Validation already produced the
   *  errors the manager needs; the persist stage just transitions
   *  cleanly to done.
   *
   *  T6.5 ("Dry-run no DB change"): when import_jobs.dry_run = true,
   *  we explicitly DON'T touch the owner-domain tables. Validation
   *  already produced errors so the manager sees exactly what WOULD
   *  happen; the persist stage just transitions cleanly to done. */
  private async persistStage(
    payload: ImportJobPayload,
    ctx: JobContext,
    cache: JobCache,
  ): Promise<void> {
    const job = await withTenant(
      payload.orgId,
      async (tx) => {
        const [r] = await tx
          .select({
            dryRun: importJobs.dryRun,
            okRows: importJobs.okRows,
            projectId: importJobs.projectId,
            // v4 audit fix (HIGH security): fetch created_by from
            // the DB row, NOT trust payload.createdBy. The payload
            // travels through pg-boss (BYPASSRLS); only the DB row
            // is the trusted source for audit attribution.
            createdBy: importJobs.createdBy,
          })
          .from(importJobs)
          .where(eq(importJobs.id, payload.jobId))
          .limit(1);
        return r;
      },
      { userId: payload.createdBy },
    );

    if (!job) {
      throw new NonRetryableJobError('import_job vanished mid-persist', 'job_not_visible');
    }
    const jobCreatedBy = job.createdBy;

    if (job.dryRun) {
      ctx.log.info('dry-run — persistence skipped (T6.5)', { ok: job.okRows });
      await withTenant(
        payload.orgId,
        async (tx) => {
          await tx
            .update(importJobs)
            .set({ updatedAt: new Date() })
            .where(eq(importJobs.id, payload.jobId));
        },
        { userId: payload.createdBy },
      );
      return;
    }

    // Audit-pass v3 finding D5 (HIGH): a NULL project_id used to
    // graceful-skip persistence and advance the job to 'done' with
    // zero domain writes. The Manager UI showed "import succeeded"
    // even though nothing was persisted. That was a silent-success
    // class bug. The fix is fail-loud: every import MUST have a
    // project — the wizard (S8) enforces this at API ingress; the
    // worker enforces it as defense-in-depth.
    if (!job.projectId) {
      throw new NonRetryableJobError(
        'import_jobs.project_id is required for persistence',
        'persist_no_project',
      );
    }

    // Audit-pass v3 finding A4 (HIGH, P0): cache.okRows might be
    // empty here in two scenarios:
    //   (a) the file had ZERO ok rows (every row failed validation).
    //       Legitimate — there's nothing to persist; advance cleanly.
    //   (b) pg-boss retried this job at state='persisting'. handle()
    //       starts with an empty cache, the state machine resumes at
    //       persisting→done, persistStage runs with no cached rows.
    //       If we silently no-op here, the user's data is LOST: the
    //       UI reports success but the domain tables stay empty.
    //
    // The fix: on cache miss, REBUILD the cache by re-running
    // validateStage. That re-downloads, re-parses, re-validates, and
    // re-populates cache.okRows + cache.parsed + cache.mapping. The
    // validation's UPDATEs / INSERTs are idempotent (C9 UNIQUE +
    // ON CONFLICT; counter UPDATE overwrites). After rebuild we re-
    // check whether there are any ok rows to persist.
    //
    // The earlier "graceful skip" behavior (and persistence.s6.spec.ts
    // test #4 which asserted that behavior) was wrong — that test
    // codified the bug. Now rewritten in test
    // persistence.retry-data-loss.spec.ts to assert real recovery.
    if (cache.okRows === undefined) {
      ctx.log.warn('persistStage cache miss — rebuilding via validateStage (retry recovery)');
      await this.validateStage(payload, ctx, cache);
      if (cache.okRows === undefined) {
        // validateStage couldn't populate the cache (e.g. no storage
        // provider in dev/test). Surface as NonRetryable so the row
        // moves to 'failed' with a clear cause rather than silently
        // succeeding with zero writes.
        throw new NonRetryableJobError(
          'persistStage unable to rebuild validation cache',
          'persist_cache_miss',
        );
      }
    }
    const okRows: ValidatedRow[] = cache.okRows;
    if (okRows.length === 0) {
      ctx.log.info('persistStage no rows to persist (every row failed validation)');
      await withTenant(
        payload.orgId,
        async (tx) => {
          await tx
            .update(importJobs)
            .set({ updatedAt: new Date() })
            .where(eq(importJobs.id, payload.jobId));
        },
        { userId: payload.createdBy },
      );
      return;
    }

    const { projectId } = job;
    // Group rows by apartment-key (address + number). Each group
    // becomes one apartment in the DB; the group's rows become its
    // ownership set.
    const apartmentGroups = new Map<string, ValidatedRow[]>();
    for (const r of okRows) {
      const key = `${r.buildingAddress}${r.apartmentNumber}`;
      const list = apartmentGroups.get(key);
      if (list) list.push(r);
      else apartmentGroups.set(key, [r]);
    }

    // Validate per-apartment ownership percentages before any write:
    //  - single owner: pct defaults to 100 if null.
    //  - multi owner: every row must have explicit pct; sum must == 100.
    const apartmentPctErrors: string[] = [];
    for (const [key, rows] of apartmentGroups) {
      if (rows.length === 1) continue; // single-owner path handles itself
      const pcts = rows.map((r) => r.ownershipPct);
      if (pcts.some((p) => p === null)) {
        apartmentPctErrors.push(
          `apartment '${key.replace('', ' #')}' has multiple owners but a row is missing ownership_pct`,
        );
        continue;
      }
      const sum = pcts.reduce<number>((s, p) => s + (p ?? 0), 0);
      if (Math.abs(sum - 100) > 0.01) {
        apartmentPctErrors.push(
          `apartment '${key.replace('', ' #')}' ownership percentages sum to ${sum}, expected 100`,
        );
      }
    }
    if (apartmentPctErrors.length > 0) {
      throw new NonRetryableJobError(
        `persistence rejected: ${apartmentPctErrors[0]}`,
        'persist_ownership_sum_invalid',
      );
    }

    // Pre-compute national_id hashes for ALL rows (pure local HMAC,
    // no DB call). The owners batch resolve consumes this map.
    // Audit-pass v3 E1/E2: batched owner resolution drops perf for a
    // 100-row import from ~60s to <25s by collapsing 200+ encrypt
    // round-trips into 2 batched ones.
    const rowsByHash = new Map<string, ValidatedRow>();
    for (const r of okRows) {
      const hash = hashField(r.nationalId, env.PII_HASH_KEY);
      // Same-hash rows in one import = T6.4 dedup already rejected
      // them at validation; here we just dedup the BATCH input.
      if (!rowsByHash.has(hash)) rowsByHash.set(hash, r);
    }

    // Resolve unique buildings + apartments + owners. All writes
    // happen in a single withTenant tx so the deferred sum trigger
    // (D.25) sees a consistent state at COMMIT.
    await withTenant(
      payload.orgId,
      async (tx) => {
        // STEP A: batched owner resolution (audit-pass v3 E1/E2 perf
        // fix). ~4 round-trips for ANY number of owners.
        const ownerByHash = await resolveOwnersBatch(tx, payload.orgId, rowsByHash);

        // STEP B: buildings (find-or-create per unique address —
        // typically 1-3 buildings per import, so per-record is cheap).
        const buildingByAddress = new Map<string, string>();
        for (const [, rows] of apartmentGroups) {
          const first = rows[0]!;
          await findOrCreateBuilding(tx, projectId, first.buildingAddress, buildingByAddress);
        }

        // STEP C: batched apartments (E1/E2 perf fix). ~3 round-trips
        // for ANY number of apartments.
        const apartmentSpecs: Array<{ buildingId: string; number: string }> = [];
        for (const [, rows] of apartmentGroups) {
          const first = rows[0]!;
          const buildingId = buildingByAddress.get(first.buildingAddress)!;
          apartmentSpecs.push({ buildingId, number: first.apartmentNumber });
        }
        const apartmentByKey = await resolveApartmentsBatch(tx, apartmentSpecs);

        // STEP D: ownership set-replace ACROSS ALL APARTMENTS in two
        // bulk SQL statements. T6.11 v4 follow-up: the prior
        // per-apartment loop (collapsed only WITHIN an apartment via
        // bulk INSERT) still cost 500 round-trips × 2 (one UPDATE +
        // one INSERT each) at 1000-row scale = ~100s on Neon network
        // latency alone. Restructure into:
        //   1. Collect every (apartmentId, ownerId, pct) tuple plus
        //      the SET of affected apartment ids.
        //   2. ONE big UPDATE that ends every currently-active
        //      ownership for any of those apartments (set-replace
        //      semantics preserved — D.25).
        //   3. ONE big INSERT of all new ownership rows.
        // Trigger semantics: the FOR EACH ROW deferred trigger still
        // fires per row, but the per-tx memo (migration 0030) means
        // each unique apartment_id runs exactly ONE SUM check at
        // COMMIT regardless of how many rows it has.
        const newOwnerships: Array<{
          apartmentId: string;
          ownerId: string;
          ownershipPct: string;
        }> = [];
        const affectedApartmentIds: string[] = [];
        for (const [, rows] of apartmentGroups) {
          const first = rows[0]!;
          const buildingId = buildingByAddress.get(first.buildingAddress)!;
          const apartmentId = apartmentByKey.get(`${buildingId}\x00${first.apartmentNumber}`)!;
          affectedApartmentIds.push(apartmentId);

          for (const r of rows) {
            const hash = hashField(r.nationalId, env.PII_HASH_KEY);
            const ownerId = ownerByHash.get(hash);
            if (!ownerId) {
              throw new Error(`internal: owner not resolved for hash ${hash.slice(0, 8)}…`);
            }
            const pct = rows.length === 1 ? (r.ownershipPct ?? 100) : (r.ownershipPct ?? 0);
            newOwnerships.push({
              apartmentId,
              ownerId,
              ownershipPct: String(pct),
            });
          }
        }

        // Set-replace (D.25): end every active ownership for any
        // affected apartment, atomically inside this tx. Even though
        // we expect zero active rows on a fresh import, this UPDATE
        // is what makes re-runs idempotent and re-mappings safe.
        //
        // v5 audit fix (P0 cross-confirmed by SOLID + perf agents):
        // chunk `affectedApartmentIds` at 5000 ids per UPDATE. The
        // PostgreSQL wire protocol caps bind parameters at int2
        // (65535). `inArray($uuid[])` is ONE parameter (the array)
        // so this is conservative; chunking here is defense-in-depth
        // against drizzle's future serialisation changes + keeps
        // statement size predictable.
        const UPDATE_CHUNK = 5000;
        for (let i = 0; i < affectedApartmentIds.length; i += UPDATE_CHUNK) {
          const chunk = affectedApartmentIds.slice(i, i + UPDATE_CHUNK);
          await tx
            .update(ownerships)
            .set({ endedAt: new Date() })
            .where(and(inArray(ownerships.apartmentId, chunk), sql`${ownerships.endedAt} IS NULL`));
        }

        // v5 audit fix (P0 cross-confirmed): chunk the bulk INSERT
        // at 5000 rows per statement. Each ownership row contributes
        // 3 parameters (apartmentId, ownerId, ownershipPct);
        // drizzle's pg-protocol param cap is int2 = 65535 → ceiling
        // of ~21,845 rows per insert. A 50MB Excel can easily hold
        // 30k+ rows; without chunking we'd hit "bind message has X
        // parameters" at scale. 5000 × 3 = 15k params per chunk,
        // ~7x margin from the cap.
        //
        // Inside a single tx, the deferred constraint trigger memo
        // (migration 0030) spans across chunks — N apartments still
        // get exactly M unique SUM checks at COMMIT regardless of
        // how many chunks we INSERTed across.
        const INSERT_CHUNK = 5000;
        for (let i = 0; i < newOwnerships.length; i += INSERT_CHUNK) {
          const chunk = newOwnerships.slice(i, i + INSERT_CHUNK);
          if (chunk.length > 0) {
            await tx.insert(ownerships).values(chunk);
          }
        }

        // v4 audit fix (P0 security): cancellation race-guard on the
        // final UPDATE. If a Manager hits cancel between the
        // validating→persisting transition (committed by runStage)
        // and this point, persistStage's domain writes have ALREADY
        // happened — but we MUST NOT allow runStage to transition
        // persisting→done on a row the Manager believes is cancelled.
        // The guarded UPDATE here returns 0 rows affected if status
        // flipped to 'cancelled', and we throw NonRetryable so
        // markFailed records the failure and the row stays cancelled.
        // Note: the domain rows we just wrote remain (we don't try to
        // hard-delete them — D.05 forbids hard delete and the
        // soft-delete + audit trail is the right posture). The
        // Manager sees status=cancelled in the UI; an aggregate
        // audit row records that the cancel won the race. S8's
        // cancel endpoint will additionally support an "archive
        // already-materialised rows" follow-up action if the
        // Manager wants that.
        const touched = await tx
          .update(importJobs)
          .set({ updatedAt: new Date() })
          .where(and(eq(importJobs.id, payload.jobId), eq(importJobs.status, 'persisting')))
          .returning({ id: importJobs.id });
        if (touched.length === 0) {
          throw new NonRetryableJobError(
            'persistStage observed status != persisting (likely cancelled mid-flight)',
            'cancelled_mid_persist',
          );
        }

        // v4 audit fix (P0 ISO A.18.1.4): aggregate-creation audit
        // row. ISO 27001 A.18.1.4 mandates that PII data CREATION
        // events are auditable at a granularity that answers "how
        // many PII records were created on date X for org Y?".
        // Per-state-transition rows (parsing/validating/persisting/
        // done) record STATE changes, not creation counts. This row
        // records the counts at the materialisation boundary —
        // PII-free (only aggregate ints).
        await new AuditService(tx).log({
          orgId: payload.orgId,
          // v4 audit fix (HIGH security): audit actorId derived from
          // the DB-resident created_by, NOT from the payload. The
          // payload is Zod-validated but not HMAC-signed; once S8
          // ships a POST endpoint, a tampered payload with someone
          // else's user_id could otherwise mis-attribute the audit.
          actorId: jobCreatedBy,
          actorType: 'system',
          action: 'import.materialised',
          targetTable: 'import_jobs',
          targetId: payload.jobId,
          metadata: {
            ok_rows: String(okRows.length),
            apartment_count: String(apartmentGroups.size),
            owner_count: String(rowsByHash.size),
          },
        });
      },
      { userId: payload.createdBy },
    );

    // Marker for the A4 recovery hook in runStage: persistStage has
    // successfully committed in this handle() invocation. The normal
    // forward path's persisting→done transition checks this flag to
    // avoid running persistStage twice in one handle().
    cache.persisted = true;

    ctx.log.info('persistence complete', {
      apartments: apartmentGroups.size,
      ok_rows: okRows.length,
    });
  }

  /** Best-effort transition to 'failed' + audit. Guarded with
   *  `WHERE status NOT IN ('done','failed','cancelled')` so an
   *  already-terminal job is never demoted. */
  private async markFailed(
    payload: ImportJobPayload,
    err: unknown,
    verifiedActorId: string,
  ): Promise<void> {
    await withTenant(
      payload.orgId,
      async (tx) => {
        const now = new Date();
        const result = await tx
          .update(importJobs)
          .set({ status: 'failed', updatedAt: now, finishedAt: now })
          .where(
            and(
              eq(importJobs.id, payload.jobId),
              sql`${importJobs.status} NOT IN ('done','failed','cancelled')`,
            ),
          );
        const rowCount = (result as unknown as { rowCount?: number }).rowCount ?? 0;
        if (rowCount === 0) return;
        await new AuditService(tx).log({
          orgId: payload.orgId,
          actorId: verifiedActorId,
          actorType: 'system',
          action: 'import.failed',
          targetTable: 'import_jobs',
          targetId: payload.jobId,
          // SECURITY (audit-pass v2 finding C2 — HIGH): err.message
          // for a pg-error (unique-violation / FK-violation / CHECK) can
          // include row VALUES — e.g. `Key (national_id)=(123456789)
          // already exists`. That row value would land in audit_log
          // (jsonb), queryable by any Manager with audit:read. PII via
          // audit is a docs/07 §5 violation. Strip to structured,
          // value-free fields: the error CLASS (always safe — class
          // names are program identifiers) + the NonRetryable code
          // (already a discriminator, never a value). The full pg-error
          // chain belongs only in the worker's pino logs (redacted).
          metadata: summariseFailureForAudit(err),
        });
      },
      { userId: payload.createdBy },
    ).catch(() => {
      // If we can't even write the failed-state, swallow — the original
      // error will propagate to pg-boss which records its own failed
      // state. We must not mask the root cause.
    });
  }
}
