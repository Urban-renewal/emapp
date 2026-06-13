/**
 * Imports service — Phase 6 S2 read surface + S8 write surface.
 *
 * Endpoints driven by this service:
 *   - GET    /imports/:id            → current status snapshot
 *   - GET    /imports/:id/stream     → SSE progress stream
 *   - POST   /imports                → create row + presigned PUT (S8)
 *   - POST   /imports/:id/start      → enqueue pg-boss job (S8)
 *   - DELETE /imports/:id            → cancel a non-terminal row (S8)
 *   - GET    /imports/:id/errors     → paginated import_job_errors (S8)
 *   - POST   /imports/:id/mapping    → D.34 wizard: supply manual mapping
 *
 * Defense-in-depth (security):
 *   - withTenant → RLS org-isolation FORCE on EVERY DB op.
 *   - D.46: writes are manager OR an agent holding `run_imports`, gated by
 *     requireAgentCapability AFTER the project-visibility check (manager is a
 *     no-op pass). The creator-only check on start/cancel/mapping further
 *     scopes agents to their own jobs.
 *   - Project visibility check (mirrors documents.service) before any
 *     mutation that targets a project.
 *   - r2Key is server-minted + never on the wire.
 *   - Pre-signed PUT URL bounded by content-type + content-length-range
 *     + short TTL (UPLOAD_URL_TTL_SECONDS — same constant the documents
 *     module uses).
 *   - Audit row (import.created / import.start_requested / import.cancelled
 *     / import.mapping_submitted) inside the same withTenant tx as the
 *     state mutation → audit cannot desync from the domain row (A.12.4).
 *   - Mapping wizard payload is structurally validated (Zod) AND
 *     additionally double-checked at the service: column indexes
 *     must be in range, required canonical fields all present.
 *
 * NO PII anywhere on the wire — import_jobs has no PII columns; the
 * mapping_templates row stores canonical-field→column-index (NOT row
 * values).
 */
import { randomUUID } from 'node:crypto';

import {
  AuditService,
  importJobErrors,
  importJobs,
  mappingTemplates,
  projectAssignments,
  projects,
  purgeImportBytes,
  withTenant,
  type IStorageProvider,
  type TenantTx,
} from '@emapp/db';
import { fingerprintHeaders, IMPORT_JOB_NAME, type IJobProducer } from '@emapp/jobs';
import {
  type CreateImport,
  type ImportError,
  type ImportJob,
  type ImportSseEvent,
  type ImportUploadResponse,
  type ListImportErrorsQueryDto,
  type ListImportsQueryDto,
  type SubmitMapping,
  type SubmitMappingResponse,
} from '@emapp/shared-types';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, asc, desc, eq, gt, sql, type SQL } from 'drizzle-orm';

import { requireAgentCapability } from '../../common/authz/agent-capabilities';
import {
  decodeCursor,
  encodeCursor,
  keysetCondition,
  keysetOrderBy,
} from '../../common/keyset-cursor';
import { JOB_PRODUCER } from '../../queue/queue.module';
import type { AccessTokenPayload } from '../auth/auth.service';
import { STORAGE_PROVIDER, UPLOAD_URL_TTL_SECONDS } from '../documents/storage';

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });
const FORBIDDEN = new ForbiddenException({ error: { code: 'forbidden' } });

/** Wire-shape of an import job. Subset of the row — internal columns
 *  (pg_boss_job_id, file_r2_key, file_content_hash) deliberately
 *  omitted: file_r2_key is the storage pointer (confidentiality, same
 *  pattern as Phase 4 documents); pg_boss_job_id is queue plumbing the
 *  client has no business with. */
export interface ImportJobView extends ImportJob {}

const TERMINAL: ReadonlySet<ImportJobView['status']> = new Set(['done', 'failed', 'cancelled']);

/** Non-terminal statuses where a cancel is meaningful. Once the worker
 *  has materialised rows (after persistStage commits), 'done' is
 *  terminal and we refuse the cancel.
 *
 *  'awaiting_mapping' is intentionally cancellable — the manager
 *  decided not to provide a mapping after all. */
const CANCELLABLE: ReadonlySet<ImportJobView['status']> = new Set([
  'queued',
  'parsing',
  'validating',
  'persisting',
  'awaiting_mapping',
  // 0048 — a preview-paused import is cancellable: this IS the "discard a bad
  // Excel" path (DELETE purges the bytes; nothing was persisted).
  'awaiting_confirm',
]);

function toView(row: typeof importJobs.$inferSelect): ImportJobView {
  return {
    id: row.id,
    organizationId: row.orgId,
    projectId: row.projectId,
    status: row.status as ImportJobView['status'],
    // v8 SOLID-4 / Sec: sanitise the Manager-supplied fileName on the
    // WIRE too, not just on audit_log. Without this, a fileName like
    // "Owner_038123456_signed.xlsx" leaks the 9-digit Israeli-ID-shaped
    // substring to every Manager-with-imports:read via GET /imports/:id
    // and the listings. The DB column keeps the cleartext (uploader UX
    // + audit forensics via the BYPASSRLS provider pool), but the wire
    // representation matches the audit posture.
    fileName: sanitiseFilenameForAudit(row.fileName),
    fileSizeBytes: row.fileSizeBytes,
    totalRows: row.totalRows,
    processedRows: row.processedRows,
    okRows: row.okRows,
    failedRows: row.failedRows,
    // #6 — per-entity change-summary computed by the worker's validate
    // stage (COUNT-ONLY dry-run). null until validate has run.
    changeSummary: row.changeSummary ?? null,
    dryRun: row.dryRun,
    requireConfirm: row.requireConfirm,
    confirmedAt: row.confirmedAt,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

/** Server-generated, unguessable R2 key partitioned per org so a
 *  bucket-level mistake stays org-scoped (mirrors newDocumentKey). */
function newImportKey(orgId: string): string {
  return `org/${orgId}/import/${randomUUID()}.xlsx`;
}

/** Prefix the canonical bare hex with the format marker before
 *  persistence. v8 SOLID-2: the wire is now bare-hex-only (Zod
 *  enforces); we just stamp the format marker on the DB column so
 *  the persisted value is self-describing for forensic queries. */
function toStoredHash(bareHex: string): string {
  return `sha256:${bareHex}`;
}

// v6 audit fix §2c — `fingerprintHeaders` lifted to `@emapp/jobs` so
// worker (L2 TemplateResolver lookup) + api (S8 wizard insert) share
// ONE implementation. Drift across the two callsites is now
// structurally impossible. Import is above.

/** Strip potential-PII substrings from any Manager-supplied string
 *  before persistence in a Manager-readable column. Israeli national_id
 *  is exactly 9 digits; phone is 10. Per v5 audit + v6 reinforcement,
 *  EVERY user-string-to-persistence boundary applies this:
 *    - filename → audit_log.afterState.fileName (v5 HIGH-1)
 *    - templateName → mapping_templates.name (v6 HIGH-4)
 *    - headers → mapping_templates.mapping.headers (v6 P0-2 — but the
 *      worker sanitises before persistence, so api-side reads
 *      already-sanitised strings; we re-apply here as defense-in-depth
 *      in case a future code path bypasses the worker write)
 *
 *  Strategy: replace any run of 7+ consecutive digits with `[N]`
 *  placeholder. 7 is a defensive lower bound (Israeli IDs are 9 but
 *  truncated/zero-padded variants exist; Israeli mobiles are 10 but
 *  short forms are 7-8). Lower than 7 would mangle dates like 2026
 *  in real filenames; 7+ catches both PII shapes without false hits
 *  on year/month/sequence numbers.
 *
 *  IMPORTANT: this function MUST stay byte-identical to the worker's
 *  `sanitiseUserString` in `apps/worker/src/mapping/mapping-resolver.ts`.
 *  The fingerprint algorithm depends on consistent sanitisation across
 *  both sides — the worker writes sanitised headers into parsed_headers,
 *  the api reads those same strings to compute the fingerprint.
 *  v6-invariants-spec asserts byte-equality. */
export function sanitiseFilenameForAudit(name: string): string {
  return name.replace(/\d{7,}/g, '[N]');
}

/** Alias for clarity at non-filename call sites. Same algorithm. */
export const sanitiseUserString = sanitiseFilenameForAudit;

/** v6 audit fix (§8 — HIGH availability, cross-confirmed by perf agent):
 *  retry a queue-producer send with exponential backoff. Used by
 *  `submitMapping` to defend against Neon connection blips / transient
 *  pg-boss errors between the withTenant COMMIT (status='queued' + audit
 *  row written) and the producer.send call.
 *
 *  Pre-fix the catch block only logged. Failure mode: row sits in
 *  `status='queued'` forever with no pg-boss job; Manager sees SSE spin
 *  indefinitely; only fix was DELETE + re-submit. Customer-visible.
 *
 *  Backoff schedule: 100ms / 500ms / 2000ms — total worst case ~2.6s of
 *  added latency on the failure path. The endpoint is already on the
 *  Throttle({limit:30,ttl:60_000}) per-route bound so this can't be a
 *  DoS amplifier. Final failure falls through to the caller's catch
 *  (which logs structured warning + leaves status='queued' for the
 *  orphan sweeper Phase 7 will ship). */
async function sendWithRetry<T>(
  fn: () => Promise<T>,
  delaysMs: readonly number[] = [100, 500, 2000],
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= delaysMs.length; i += 1) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < delaysMs.length) {
        await new Promise<void>((r) => setTimeout(r, delaysMs[i]!));
      }
    }
  }
  throw lastErr;
}

@Injectable()
export class ImportsService {
  private readonly logger = new Logger(ImportsService.name);

  constructor(
    @Inject(STORAGE_PROVIDER) private readonly storage: IStorageProvider,
    @Inject(JOB_PRODUCER) private readonly producer: IJobProducer,
  ) {}

  private async assertProjectVisible(
    tx: TenantTx,
    user: AccessTokenPayload,
    projectId: string,
  ): Promise<void> {
    if (user.role === 'agent') {
      const [row] = await tx
        .select({ id: projects.id })
        .from(projects)
        .innerJoin(
          projectAssignments,
          and(
            eq(projectAssignments.projectId, projects.id),
            eq(projectAssignments.userId, user.sub),
            sql`${projectAssignments.unassignedAt} IS NULL`,
          ),
        )
        .where(eq(projects.id, projectId))
        .limit(1);
      if (!row) throw NOT_FOUND;
      return;
    }
    const [row] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!row) throw NOT_FOUND;
  }

  /** GET /imports/:id — status snapshot. Read = ALL (D.17). */
  async get(user: AccessTokenPayload, id: string): Promise<ImportJobView> {
    const row = await withTenant(user.orgId, async (tx: TenantTx) => this.load(tx, id), {
      userId: user.sub,
    });
    return toView(row);
  }

  /**
   * GET /imports — paginated list. §P0-2 closure.
   *
   * Read scope per D.17: Manager + Viewer see ALL org imports; Agent
   * sees only imports whose `projectId` matches one of their active
   * project assignments (mirrors the apartments/documents agent-scoping
   * pattern). Cursor is keyset on (createdAt desc, id desc) — same
   * shape as documents/projects so the FE's TanStack hook can reuse
   * its existing `PageSchema` from lib/api/paging.ts.
   *
   * Filter: optional `projectId` narrows to one project. We assert
   * visibility on it FIRST (so an unauthorized projectId leaks no
   * imports — same posture as documents.list).
   */
  async list(
    user: AccessTokenPayload,
    query: ListImportsQueryDto,
  ): Promise<{
    data: ImportJobView[];
    page: { limit: number; cursor: string | null; has_more: boolean };
  }> {
    const limit = query.limit ?? 25;
    const cur = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cur) {
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }

    const rows = await withTenant(
      user.orgId,
      async (tx) => {
        if (query.projectId) {
          await this.assertProjectVisible(tx, user, query.projectId);
        }

        // Build the WHERE clauses progressively.
        const filters: (SQL | undefined)[] = [];
        if (query.projectId) {
          filters.push(eq(importJobs.projectId, query.projectId));
        }

        // Agent visibility: only imports whose projectId is an active
        // assignment. Mirrors the documents.list agent-scope; `project_id` is
        // NULLABLE in the schema, so a null-project job simply fails the EXISTS
        // (no apartment-chain branch) → invisible to agents, which is the safe
        // default (also enforced on the write paths via the explicit null-guard).
        if (user.role === 'agent') {
          const viaAssignment = sql<boolean>`EXISTS (
            SELECT 1 FROM project_assignments pa
            WHERE pa.user_id = ${user.sub}::uuid
              AND pa.unassigned_at IS NULL
              AND pa.project_id = ${importJobs.projectId}
          )`;
          filters.push(viaAssignment);
        }

        // Keyset: rows older than the cursor (created_at, id) tuple, compared
        // at millisecond precision so the ms cursor round-trips losslessly
        // (D.58, via the shared helper). Pairs with keysetOrderBy below.
        if (cur) {
          filters.push(keysetCondition(importJobs.createdAt, importJobs.id, cur));
        }

        const where = filters.length
          ? and(...filters.filter((f): f is SQL => f !== undefined))
          : undefined;

        // limit + 1 lookahead — if we get `limit + 1` rows, there's a
        // next page; drop the extra before returning. Same trick as
        // documents.list.
        return tx
          .select()
          .from(importJobs)
          .where(where)
          .orderBy(...keysetOrderBy(importJobs.createdAt, importJobs.id))
          .limit(limit + 1);
      },
      { userId: user.sub },
    );

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map(toView),
      page: {
        limit,
        cursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
        has_more: hasMore,
      },
    };
  }

  /** POST /imports — create row + return presigned PUT URL.
   *  Manager-only. Project visibility verified. Audit row written
   *  inside the same tx as the INSERT. */
  async create(user: AccessTokenPayload, input: CreateImport): Promise<ImportUploadResponse> {
    const r2Key = newImportKey(user.orgId);
    const fileContentHash = toStoredHash(input.fileContentHash);

    const row = await withTenant(
      user.orgId,
      async (tx) => {
        await this.assertProjectVisible(tx, user, input.projectId);
        // D.46 — fine gate after project scoping (manager passes).
        await requireAgentCapability(tx, user, 'run_imports');

        // v8 SOLID-1 / D.22-F: Idempotency-Key replay. If the caller
        // supplied a key AND a row with the same (org_id, created_by,
        // idempotency_key) already exists, RETURN that row instead of
        // attempting a fresh INSERT. RFC-style Idempotency-Key
        // semantics: "the second call returns the same answer as the
        // first, not a 409." Without this, browser-resubmit /
        // network-retry surfaces an `import_conflict` to the user even
        // though their previous attempt succeeded.
        //
        // We scope by `created_by` too so a hostile Manager can't
        // probe another Manager's idempotency keys for enumeration
        // (the partial UNIQUE in migration 0022 is (org_id, key) only,
        // so without this scope the prior-row lookup would leak
        // existence cross-Manager). The migration's UNIQUE remains the
        // backstop against true races (two concurrent identical POSTs
        // from the same Manager → the second hits the unique and we
        // re-fetch + return).
        if (input.idempotencyKey !== undefined) {
          const [existing] = await tx
            .select()
            .from(importJobs)
            .where(
              and(
                eq(importJobs.orgId, user.orgId),
                eq(importJobs.createdBy, user.sub),
                eq(importJobs.idempotencyKey, input.idempotencyKey),
              ),
            )
            .limit(1);
          if (existing) {
            // Replay — return the same row. We do NOT write a second
            // `import.created` audit row (the original event is the
            // canonical one); the FE will receive a fresh presigned
            // PUT URL above so a Manager who lost the first URL can
            // still complete the upload.
            return existing;
          }
        }

        let inserted: typeof importJobs.$inferSelect | undefined;
        try {
          [inserted] = await tx
            .insert(importJobs)
            .values({
              orgId: user.orgId,
              projectId: input.projectId,
              fileR2Key: r2Key,
              fileName: input.fileName,
              fileSizeBytes: input.fileSizeBytes,
              fileContentHash,
              dryRun: input.dryRun ?? false,
              requireConfirm: input.requireConfirm ?? false,
              createdBy: user.sub,
              idempotencyKey: input.idempotencyKey ?? null,
            })
            .returning();
        } catch (insertErr) {
          // SECURITY (same posture as documents.create HIGH-1): the
          // pg error detail may include the r2Key on a UNIQUE
          // violation. Swallow the cause chain → generic conflict.
          // A server-random r2Key makes a real collision astronomical.
          //
          // v8 SOLID-1: if the failure was the (org_id, idempotency_key)
          // UNIQUE race (two concurrent identical POSTs from the same
          // Manager), the FIRST POST won — re-fetch and return its row
          // for replay-correctness. We can't tell from the swallowed
          // error WHICH unique fired, so we just try the lookup; if it
          // misses (different unique, or transient), fall through to
          // the generic conflict.
          if (input.idempotencyKey !== undefined) {
            const [existing] = await tx
              .select()
              .from(importJobs)
              .where(
                and(
                  eq(importJobs.orgId, user.orgId),
                  eq(importJobs.createdBy, user.sub),
                  eq(importJobs.idempotencyKey, input.idempotencyKey),
                ),
              )
              .limit(1);
            if (existing) return existing;
          }
          void insertErr;
          throw new ConflictException({ error: { code: 'import_conflict' } });
        }
        if (!inserted) {
          throw new ConflictException({ error: { code: 'import_conflict' } });
        }
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'import.created',
          targetTable: 'import_jobs',
          targetId: inserted.id,
          afterState: {
            projectId: inserted.projectId,
            // v5 audit fix (HIGH-1 PII surface): strip 7+ digit runs
            // from the manager-supplied fileName so a name like
            // "Owner_038123456_2026.xlsx" doesn't land that 9-digit
            // PII-shaped substring in audit_log queryable by every
            // Manager with audit:read.
            fileName: sanitiseFilenameForAudit(inserted.fileName),
            sizeBytes: String(inserted.fileSizeBytes),
            dryRun: String(inserted.dryRun),
          },
          sessionId: user.sid,
        });
        return inserted;
      },
      { userId: user.sub },
    );

    // Presign AFTER commit. Bound the PUT to declared content-type +
    // size ceiling (defense-in-depth — R2 will refuse a mismatched
    // upload server-side). Short TTL minimises exfiltration window.
    let uploadUrl: string;
    try {
      uploadUrl = await this.storage.getUploadUrl(r2Key, {
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        maxSizeBytes: input.fileSizeBytes,
        ttlSeconds: UPLOAD_URL_TTL_SECONDS,
      });
    } catch (e) {
      // Compensate: archive the orphan row so it doesn't dangle. Also
      // write an audit row for the presign failure (v7 HIGH-3: ISO
      // 27001 requires the failed credential mint to be evidence-able,
      // not just a log line).
      await withTenant(
        user.orgId,
        async (tx) => {
          await tx
            .update(importJobs)
            .set({ status: 'failed', finishedAt: new Date(), updatedAt: new Date() })
            .where(eq(importJobs.id, row.id));
          await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent })
            .log({
              orgId: user.orgId,
              actorId: user.sub,
              actorType: 'user',
              action: 'import.upload_url_mint_failed',
              targetTable: 'import_jobs',
              targetId: row.id,
              sessionId: user.sid,
            })
            // Even the audit write can fail (DB outage) — don't shadow
            // the original presign error.
            .catch(() => undefined);
        },
        { userId: user.sub },
      ).catch(() => undefined);
      this.logger.error(
        `presign(upload) failed (import=${row.id}): ${e instanceof Error ? e.message : 'unknown'}`,
      );
      throw new ServiceUnavailableException({ error: { code: 'storage_unavailable' } });
    }

    // Audit C-2 fix (2026-05-27 manager-be-errors, D.31 + ISO 27001
    // A.12.4.1): the presigned URL is a bearer credential. The
    // post-commit audit write used to be best-effort with a
    // `.catch(swallow)` — a DB blip between the presign-mint and the
    // audit write would leave the URL minted-and-returned with NO
    // forensic trail. ISO 27001 A.12.4.1 forbids that posture.
    //
    // Restructured to fail-loud: if the audit write fails, throw 503
    // and DO NOT return the URL to the client. The presigned URL is
    // computed locally (HMAC-SHA4 over the request) — withholding it
    // means no one ever uses it (the HMAC is the credential; without
    // surfacing it, the URL is unreachable). Client retries hit the
    // idempotency interceptor's cache + re-execute, which presigns
    // again with a fresh HMAC and re-attempts the audit write.
    //
    // This is the structural inline-the-audit posture from the audit's
    // recommendation (B). Trade-off: a customer-visible 503 if audit
    // logging is broken. That's correct: compliance over availability
    // for a credential-issuance event.
    try {
      await withTenant(
        user.orgId,
        async (tx) => {
          await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: 'import.upload_url_minted',
            targetTable: 'import_jobs',
            targetId: row.id,
            metadata: {
              ttl_seconds: String(UPLOAD_URL_TTL_SECONDS),
            },
            sessionId: user.sid,
          });
        },
        { userId: user.sub },
      );
    } catch (e) {
      this.logger.error(
        `audit(import.upload_url_minted) failed (import=${row.id}): ${
          e instanceof Error ? e.message : 'unknown'
        } — refusing to return the URL (compliance gate)`,
      );
      throw new ServiceUnavailableException({
        error: { code: 'audit_unavailable' },
      });
    }

    return {
      import: toView(row),
      uploadUrl,
      uploadExpiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    };
  }

  /** POST /imports/:id/start — enqueue the worker job. The row must be
   *  in 'queued' (created but not yet enqueued); we use the
   *  singletonKey idempotency on the producer side so a double-click
   *  is a no-op. */
  async start(user: AccessTokenPayload, id: string): Promise<ImportJobView> {
    const row = await withTenant(
      user.orgId,
      async (tx) => {
        const r = await this.load(tx, id);
        // D.46 — agent: assigned to the job's project (404 if not / null project)
        // + run_imports capability (403), before the status/creator checks.
        if (r.projectId) await this.assertProjectVisible(tx, user, r.projectId);
        else if (user.role === 'agent') throw NOT_FOUND;
        await requireAgentCapability(tx, user, 'run_imports');
        if (r.status !== 'queued') {
          // Already started or terminal — surfacing this as 409 lets
          // the FE distinguish "you already started this" from "this
          // import doesn't exist or isn't yours" (which would be 404
          // via NOT_FOUND from load).
          throw new ConflictException({
            error: { code: 'import_not_startable', message: `status is ${r.status}` },
          });
        }
        // Defense-in-depth: only the creator can start the job.
        // Even though the route is Manager-only, an org with multiple
        // Managers shouldn't let one Manager start another's draft.
        if (r.createdBy !== user.sub) {
          throw FORBIDDEN;
        }
        // v8 Sec-3: GUARDED state-flip. Pre-fix this method only wrote
        // an audit row and relied on pg-boss's singletonKey for
        // dedup. Two concurrent /start calls (browser-resubmit, FE
        // bug) would each pass the status check, each write an
        // `import.start_requested` audit row, and BOTH call
        // producer.send. The singletonKey dedups the queue, but
        // audit_log gets two rows AND the second producer.send burns
        // a connection acquire.
        //
        // Now we move the row to `queued` → `queued` with a
        // started_at stamp via a GUARDED UPDATE (`WHERE status =
        // 'queued' AND started_at IS NULL`). rowCount = 0 means
        // another concurrent call won the race — surface 409 +
        // SKIP the audit row + SKIP the producer.send (we know the
        // first call already enqueued). The audit_log is now exactly
        // one row per actually-distinct /start.
        //
        // We use started_at (existing column) as the latch; the
        // status itself stays `queued` (the worker still expects
        // 'queued' as the entry status — no migration needed).
        const stampNow = new Date();
        const startResult = await tx
          .update(importJobs)
          .set({ startedAt: stampNow, updatedAt: stampNow })
          .where(
            and(
              eq(importJobs.id, id),
              eq(importJobs.status, 'queued'),
              sql`${importJobs.startedAt} IS NULL`,
            ),
          );
        const startRowCount = (startResult as unknown as { rowCount?: number }).rowCount ?? 0;
        if (startRowCount === 0) {
          // Another /start won — idempotent: same answer the winner got.
          throw new ConflictException({
            error: { code: 'import_already_starting', message: 'already started' },
          });
        }
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'import.start_requested',
          targetTable: 'import_jobs',
          targetId: id,
          sessionId: user.sid,
        });
        // Return the row with the started_at we just wrote so the
        // post-tx code uses the latched view (avoids a re-read +
        // saves one round-trip toward Perf-1).
        return { ...r, startedAt: stampNow, updatedAt: stampNow };
      },
      { userId: user.sub },
    );

    // Verify the upload happened. IStorageProvider.head() returns
    // null for the FakeStorageProvider in dev/test (no real bytes
    // were sent through a presigned URL there); we treat null as
    // "no storage-attested fact" and trust the client-side flow.
    // In prod with R2, head() returns metadata so a missing object
    // surfaces as 400 ("upload not received").
    //
    // v7 P0 (perf Agent C): bound the head() round-trip with a 500ms
    // race so a slow R2 region can't hold the Manager's /start
    // request for the SDK's full socket timeout. If head() doesn't
    // come back in time we skip attestation — the worker will fail
    // loud at parseStage if the file truly isn't there (a
    // NonRetryableJobError + audit row), so we lose only the
    // "polite" upfront error, not safety.
    let integritySkipReason: 'deadline' | 'error' | null = null;
    let integrityErrorClass: string | null = null;
    try {
      const meta = await this.headWithDeadline(row.fileR2Key, 500);
      if (meta === undefined) {
        // Deadline hit — fall through (worker fail-loud is the
        // safety net). We log to surface chronic R2 slowness.
        this.logger.warn(
          `head(${row.fileR2Key}) deadline (500ms) — skipping pre-flight attestation`,
        );
        integritySkipReason = 'deadline';
      } else if (meta === null) {
        // Fake / not-attested — proceed. The worker will fail loud
        // if the file isn't actually there. NOT considered a "skip"
        // for audit purposes — this is the documented FakeStorage
        // behaviour, not an outage.
      } else if (meta.contentLength !== row.fileSizeBytes) {
        throw new BadRequestException({
          error: { code: 'upload_size_mismatch' },
        });
      }
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      this.logger.warn(
        `head(${row.fileR2Key}) errored — proceeding without attestation: ${
          e instanceof Error ? e.message : 'unknown'
        }`,
      );
      integritySkipReason = 'error';
      integrityErrorClass = e instanceof Error ? e.name : 'unknown';
    }

    // v8 Sec-5 (ISO A.12.4.1): when we proceed WITHOUT the storage-
    // attested ContentLength match, write a dedicated audit row so a
    // regulator can answer "which imports skipped integrity?". Without
    // this, the only signal of a chronic R2 slowness (or routing
    // change) is grep-pino-warn. Best-effort — a failed audit MUST
    // NOT block the start: the spec posture is "proceed with evidence,
    // never proceed silently."
    if (integritySkipReason !== null) {
      await withTenant(
        user.orgId,
        async (tx) => {
          await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: 'import.upload_integrity_unverified',
            targetTable: 'import_jobs',
            targetId: id,
            metadata: {
              reason: integritySkipReason,
              ...(integrityErrorClass ? { error_class: integrityErrorClass } : {}),
            },
            sessionId: user.sid,
          });
        },
        { userId: user.sub },
      ).catch((e) => {
        this.logger.warn(
          `audit(import.upload_integrity_unverified) failed: ${
            e instanceof Error ? e.message : 'unknown'
          }`,
        );
      });
    }

    // Enqueue. singletonKey = row id → a second /start for the same
    // row while the first is still active is a producer-side no-op
    // (one extra layer of idempotency on top of the FE's button
    // debounce).
    //
    // M6 — wrap in the SAME exponential-backoff retry as submitMapping/confirm.
    // start() previously used a BARE producer.send: a transient pg-boss / Neon
    // blip both threw a 500 to the user AND left the row stuck at
    // status='queued' with no job. Best-effort — a final failure logs and falls
    // through (the row is already 'queued'; a manual /start re-enqueues via the
    // singletonKey, and the orphan sweeper will retry).
    try {
      await sendWithRetry(() =>
        this.producer.send(
          IMPORT_JOB_NAME,
          { jobId: id, orgId: user.orgId, createdBy: user.sub },
          { singletonKey: id },
        ),
      );
    } catch (e) {
      this.logger.warn(
        `enqueue on /start failed (import=${id}) after 4 attempts with backoff; ` +
          `row is queued, orphan-sweeper will retry: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    }

    return this.get(user, id);
  }

  /** DELETE /imports/:id — cancel a non-terminal row. The worker's
   *  state-machine loop re-reads status before each transition (and
   *  v4 added a mid-persistStage guard); a cancel here wins the race
   *  any time the worker hasn't yet committed the next transition.
   *
   *  v8.5 SOLID #4 (cross-confirmed P0): also purges the R2 bytes
   *  after a successful cancel. Pre-fix, this was the most common
   *  terminal path that BYPASSED the purge — bytes leaked forever.
   *  The worker terminal-state check only fires when the WORKER
   *  drives the state machine; cancel-via-API skips the worker
   *  entirely if no pg-boss job has picked up the row.
   *
   *  Purge is best-effort (a failure leaves file_deleted_at NULL
   *  and the future sweeper retries — same semantic as the worker
   *  path).
   */
  async cancel(user: AccessTokenPayload, id: string): Promise<void> {
    let didCancel = false;
    await withTenant(
      user.orgId,
      async (tx) => {
        const row = await this.load(tx, id);
        // D.46 — agent: project assignment (404 / null project) + run_imports (403).
        if (row.projectId) await this.assertProjectVisible(tx, user, row.projectId);
        else if (user.role === 'agent') throw NOT_FOUND;
        await requireAgentCapability(tx, user, 'run_imports');
        // v8 Sec-8: parity with start() — owner-only. A co-Manager
        // shouldn't be able to destroy another Manager's in-flight
        // import (especially after the worker has materialised some
        // rows). Same posture as start(): the route is Manager-only,
        // but within the org we scope the destructive action to the
        // creator. 403 (not 404) here is OK — the row IS visible to
        // every Manager in the org, we just refuse the action.
        if (row.createdBy !== user.sub) {
          throw FORBIDDEN;
        }
        if (TERMINAL.has(row.status as ImportJobView['status'])) {
          // Cancel after terminal is meaningless. 409 (not 400) —
          // the request was well-formed; the state machine rejects.
          throw new ConflictException({
            error: { code: 'import_not_cancellable', message: `status is ${row.status}` },
          });
        }
        if (!CANCELLABLE.has(row.status as ImportJobView['status'])) {
          throw new ConflictException({
            error: { code: 'import_not_cancellable', message: `status is ${row.status}` },
          });
        }
        const now = new Date();
        // v8 SOLID-14: derive the SQL IN clause from CANCELLABLE so
        // adding a new cancellable status doesn't silently desync this
        // guard from the in-memory Set.
        const cancellableSqlList = sql.raw([...CANCELLABLE].map((s) => `'${s}'`).join(','));
        const result = await tx
          .update(importJobs)
          .set({ status: 'cancelled', finishedAt: now, updatedAt: now })
          .where(
            and(
              eq(importJobs.id, id),
              // Race-safe — the worker MAY have just transitioned;
              // we only flip from a cancellable status.
              sql`${importJobs.status} IN (${cancellableSqlList})`,
            ),
          );
        const rowCount = (result as unknown as { rowCount?: number }).rowCount ?? 0;
        if (rowCount === 0) {
          // Lost the race — the worker just terminated. Idempotent:
          // re-read and report.
          return;
        }
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'import.cancelled',
          targetTable: 'import_jobs',
          targetId: id,
          metadata: { from: row.status as string },
          sessionId: user.sid,
        });
        didCancel = true;
      },
      { userId: user.sub },
    );

    // v8.5 SOLID #4 — fire purge AFTER the cancel tx commits. Doing
    // it inside the tx would hold a pg client during an R2 round-
    // trip; doing it before would race with a worker that might
    // still be processing. Post-commit is safe + idempotent
    // (purgeImportBytes checks file_deleted_at IS NULL).
    if (didCancel) {
      await purgeImportBytes({
        orgId: user.orgId,
        jobId: id,
        verifiedActorId: user.sub,
        storage: this.storage,
        log: {
          info: (msg, meta) => this.logger.log(`${msg} ${JSON.stringify(meta ?? {})}`),
          warn: (msg, meta) => this.logger.warn(`${msg} ${JSON.stringify(meta ?? {})}`),
          error: (msg, meta) => this.logger.error(`${msg} ${JSON.stringify(meta ?? {})}`),
        },
      }).catch((e: unknown) => {
        // Don't fail the cancel response on a purge failure — the
        // status flip + audit row are already committed. Sweeper
        // (or worker on next pickup) will retry.
        this.logger.warn(
          `purgeImportBytes after cancel (id=${id}) threw — sweeper will retry: ${
            e instanceof Error ? e.message : 'unknown'
          }`,
        );
      });
    }
  }

  /** GET /imports/:id/errors — keyset pagination on (rowNumber asc,
   *  id desc). Errors carry NO PII (the worker already strips). */
  async listErrors(
    user: AccessTokenPayload,
    id: string,
    query: ListImportErrorsQueryDto,
  ): Promise<{
    data: ImportError[];
    page: { limit: number; cursor: string | null; has_more: boolean };
  }> {
    return withTenant(
      user.orgId,
      async (tx) => {
        // Visibility — ensures cross-tenant returns 404, not an empty list.
        await this.load(tx, id);
        const limit = query.limit ?? 100;
        const cursorRowNumber = query.cursor ? Number(query.cursor) : 0;
        if (query.cursor && !Number.isFinite(cursorRowNumber)) {
          throw new BadRequestException({ error: { code: 'invalid_cursor' } });
        }
        const rows = await tx
          .select()
          .from(importJobErrors)
          .where(
            and(
              eq(importJobErrors.jobId, id),
              query.cursor ? gt(importJobErrors.rowNumber, cursorRowNumber) : sql`true`,
            ),
          )
          .orderBy(asc(importJobErrors.rowNumber), desc(importJobErrors.id))
          .limit(limit + 1);

        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        const data: ImportError[] = page.map((r) => ({
          id: r.id,
          rowNumber: r.rowNumber,
          code: r.code,
          // Worker always supplies a message; the DB column is
          // historically nullable. Fall back to the code as the
          // human-readable message so the wire shape is non-null.
          message: r.message ?? r.code,
          field: r.field ?? null,
          createdAt: r.createdAt,
        }));
        const next = hasMore && page.length > 0 ? String(page[page.length - 1]!.rowNumber) : null;
        return { data, page: { limit, cursor: next, has_more: hasMore } };
      },
      { userId: user.sub },
    );
  }

  /** D.34 — POST /imports/:id/mapping. Manager supplies a column
   *  mapping for a row in `awaiting_mapping`. We:
   *    1. Verify status='awaiting_mapping'
   *    2. Validate column indexes are unique (no two canonicals
   *       point at the same column)
   *    3. Compute the headers fingerprint (sha256) — but we need
   *       the headers themselves to do this; since we don't load
   *       parsed headers from the worker side, we accept that this
   *       endpoint pre-S9 stores the columns map indexed by ZERO
   *       (the fingerprint is computed later by L2/TemplateResolver
   *       OR by the next worker attempt as a side effect; for now
   *       we mint a deterministic placeholder so the partial UNIQUE
   *       doesn't gate progress).
   *    4. INSERT mapping_templates row (source='manual',
   *       approved_by=user, approved_at=now)
   *    5. Flip job back to status='queued', clear cache,
   *       re-enqueue pg-boss with the same singletonKey
   *    6. Audit 'import.mapping_submitted'
   */
  async submitMapping(
    user: AccessTokenPayload,
    id: string,
    input: SubmitMapping,
  ): Promise<SubmitMappingResponse> {
    // Defense in depth (Zod already enforces): unique column indexes.
    const seen = new Set<number>();
    for (const v of Object.values(input.columns)) {
      if (typeof v !== 'number') continue;
      if (seen.has(v)) {
        throw new BadRequestException({
          error: { code: 'mapping_duplicate_column', message: `column ${v} mapped twice` },
        });
      }
      seen.add(v);
    }

    const updated = await withTenant(
      user.orgId,
      async (tx) => {
        const row = await this.load(tx, id);
        // D.46 — agent: project assignment (404 / null project) + run_imports (403).
        if (row.projectId) await this.assertProjectVisible(tx, user, row.projectId);
        else if (user.role === 'agent') throw NOT_FOUND;
        await requireAgentCapability(tx, user, 'run_imports');
        // v8 Sec-8: parity with start() / cancel() — owner-only. The
        // mapping decision substantively reshapes downstream
        // persistence; only the creator should make it. (Future:
        // delegate to a "co-owner Manager" role if a project assigns
        // multiple. Today, scope to creator.)
        if (row.createdBy !== user.sub) {
          throw FORBIDDEN;
        }
        if (row.status !== 'awaiting_mapping') {
          throw new ConflictException({
            error: { code: 'import_not_awaiting_mapping', message: `status is ${row.status}` },
          });
        }

        // v5 audit fix (P0 — Agent A): compute the real
        // headers-fingerprint from the parsed_headers the worker
        // persisted when it transitioned this row to
        // `awaiting_mapping` (migration 0031). Pre-fix the wizard
        // used `sha256("manual:${id}")` as a placeholder which made
        // every manual template invisible to the future L2
        // TemplateResolver (Phase 7+). Now the template fingerprint
        // matches the L2 lookup key.
        //
        // Fallback: if `parsedHeaders` is somehow missing (a row
        // that reached awaiting_mapping via a non-parseStage path,
        // or a pre-migration legacy row) we fall back to the old
        // placeholder. This keeps the wizard functional but the
        // template won't be L2-findable — acceptable since the
        // worker always populates parsedHeaders in production.
        const realHeaders = row.parsedHeaders ?? null;
        const fingerprint =
          realHeaders && realHeaders.length > 0
            ? fingerprintHeaders(realHeaders)
            : fingerprintHeaders([`manual:${id}`]);

        // INSERT template. UNIQUE may collide if the manager
        // submitted twice — let pg surface 23505, swallowed into a
        // generic 409.
        let templateId: string;
        try {
          const [tpl] = await tx
            .insert(mappingTemplates)
            .values({
              orgId: user.orgId,
              fingerprint,
              // v6 audit fix (HIGH-4 — security agent): sanitise the
              // Manager-supplied templateName so a value like
              // "Owner 038123456 mapping" doesn't leak a PII-shaped
              // substring into a Manager-queryable column.
              name: sanitiseUserString(
                input.templateName ?? `Manual mapping for import ${id.slice(0, 8)}`,
              ),
              // v5 audit fix (P0 — Agent A + MED-3): store the real
              // headers in the template's mapping jsonb so the L2
              // resolver can verify the saved mapping against the
              // file's headers + the audit-trail of template
              // provenance is complete.
              //
              // v6 audit fix (P0 — security agent): realHeaders comes
              // from import_jobs.parsed_headers which the worker
              // sanitised at write-time. Re-applying the sanitiser
              // here is belt+suspenders against a future code path
              // that supplies headers from a different source.
              mapping: {
                columns: input.columns,
                headers: (realHeaders ?? []).map(sanitiseUserString),
              },
              source: 'manual',
              createdBy: user.sub,
              approvedBy: user.sub,
              approvedAt: new Date(),
            })
            .returning({ id: mappingTemplates.id });
          if (!tpl) {
            throw new ConflictException({
              error: { code: 'mapping_template_conflict' },
            });
          }
          templateId = tpl.id;
        } catch (e) {
          if (e instanceof ConflictException) throw e;
          throw new ConflictException({ error: { code: 'mapping_template_conflict' } });
        }

        // v5 audit fix (P0 security/availability — Agent B): the
        // status-flip + audit + final read MUST commit before we
        // touch the pg-boss network. Prior shape held the withTenant
        // tx open across `producer.send` — a stuck pg-boss producer
        // would have blocked the import_jobs row lock + pool slot,
        // potentially DOS'ing concurrent /mapping calls.
        // v5 audit fix (MEDIUM correctness — Agent B): capture the
        // UPDATE rowCount so a concurrent DELETE /imports/:id that
        // flipped the row to 'cancelled' between our load and our
        // UPDATE is observed cleanly (409 instead of silent insert
        // of an orphan template + audit row for a cancelled job).
        const now = new Date();
        const updResult = await tx
          .update(importJobs)
          .set({
            status: 'queued',
            startedAt: null,
            finishedAt: null,
            processedRows: 0,
            okRows: 0,
            failedRows: 0,
            mappingTemplateId: templateId,
            updatedAt: now,
          })
          .where(and(eq(importJobs.id, id), eq(importJobs.status, 'awaiting_mapping')));
        const rowCount = (updResult as unknown as { rowCount?: number }).rowCount ?? 0;
        if (rowCount === 0) {
          throw new ConflictException({
            error: {
              code: 'import_status_changed',
              message: 'row is no longer awaiting_mapping (concurrent cancel?)',
            },
          });
        }

        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'import.mapping_submitted',
          targetTable: 'import_jobs',
          targetId: id,
          metadata: {
            template_id: templateId,
            column_count: String(Object.keys(input.columns).length),
          },
          sessionId: user.sid,
        });

        // v5 audit fix (Agent C HIGH-4): construct the return view
        // from the loaded row + known updates instead of a fresh
        // SELECT. Saves one round-trip + avoids any READ COMMITTED
        // staleness anomaly. (Equivalent because we just committed
        // the exact deltas applied here.)
        return {
          ...row,
          status: 'queued' as const,
          startedAt: null as Date | null,
          finishedAt: null as Date | null,
          processedRows: 0,
          okRows: 0,
          failedRows: 0,
          mappingTemplateId: templateId,
          updatedAt: now,
          _templateId: templateId,
        };
      },
      { userId: user.sub },
    );

    // v5 audit fix: producer.send OUTSIDE the withTenant tx. Best-
    // effort — if it errors, the audit + state are already committed
    // and the next worker poll (or manual /start) will pick up the
    // queued row.
    //
    // v6 audit fix (§8 — HIGH availability): retry with exponential
    // backoff (100/500/2000ms = ~2.6s worst-case added latency)
    // before falling through to the log path. Catches transient
    // Neon blips that previously left the row orphaned at
    // status='queued' forever with no pg-boss job and only DELETE +
    // re-submit as recovery.
    try {
      await sendWithRetry(() =>
        this.producer.send(
          IMPORT_JOB_NAME,
          { jobId: id, orgId: user.orgId, createdBy: user.sub },
          { singletonKey: id },
        ),
      );
    } catch (e) {
      this.logger.warn(
        `re-enqueue after mapping_submitted failed (import=${id}) ` +
          `after 4 attempts with backoff; row is queued, ` +
          `orphan-sweeper will retry: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    }

    const { _templateId, ...rowView } = updated;
    return { import: toView(rowView as typeof importJobs.$inferSelect), templateId: _templateId };
  }

  /**
   * 0048 — confirm a preview-paused import (status='awaiting_confirm'). Stamps
   * confirmed_at and re-queues a FULL real run from 'queued' (which persists
   * this time, because the worker's isPreviewPending → false once confirmed_at
   * is set). Mirrors submitMapping: creator-only + run_imports capability, the
   * status-flip + audit commit BEFORE the pg-boss send, best-effort re-enqueue
   * with backoff. The retained R2 file (awaiting_confirm did not purge) is
   * re-parsed by the fresh run. The alternative action is DELETE /imports/:id
   * (cancel), which discards + purges — so a bad Excel never reaches the org.
   */
  async confirm(user: AccessTokenPayload, id: string): Promise<{ import: ImportJob }> {
    const updated = await withTenant(
      user.orgId,
      async (tx) => {
        const [row] = await tx.select().from(importJobs).where(eq(importJobs.id, id)).limit(1);
        if (!row) throw NOT_FOUND;
        if (row.projectId) await this.assertProjectVisible(tx, user, row.projectId);
        else if (user.role === 'agent') throw NOT_FOUND;
        await requireAgentCapability(tx, user, 'run_imports');
        if (row.createdBy !== user.sub) throw FORBIDDEN;
        if (row.status !== 'awaiting_confirm') {
          throw new ConflictException({
            error: { code: 'import_not_awaiting_confirm', message: `status is ${row.status}` },
          });
        }
        const now = new Date();
        const updResult = await tx
          .update(importJobs)
          .set({
            status: 'queued',
            confirmedAt: now,
            startedAt: null,
            finishedAt: null,
            processedRows: 0,
            okRows: 0,
            failedRows: 0,
            updatedAt: now,
          })
          .where(and(eq(importJobs.id, id), eq(importJobs.status, 'awaiting_confirm')));
        const rowCount = (updResult as unknown as { rowCount?: number }).rowCount ?? 0;
        if (rowCount === 0) {
          throw new ConflictException({
            error: {
              code: 'import_status_changed',
              message: 'row is no longer awaiting_confirm (concurrent cancel?)',
            },
          });
        }
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'import.confirmed',
          targetTable: 'import_jobs',
          targetId: id,
          sessionId: user.sid,
        });
        return {
          ...row,
          status: 'queued' as const,
          confirmedAt: now,
          startedAt: null as Date | null,
          finishedAt: null as Date | null,
          processedRows: 0,
          okRows: 0,
          failedRows: 0,
          updatedAt: now,
        };
      },
      { userId: user.sub },
    );

    try {
      await sendWithRetry(() =>
        this.producer.send(
          IMPORT_JOB_NAME,
          { jobId: id, orgId: user.orgId, createdBy: user.sub },
          { singletonKey: id },
        ),
      );
    } catch (e) {
      this.logger.warn(
        `re-enqueue after import.confirmed failed (import=${id}); row is queued, ` +
          `orphan-sweeper will retry: ${e instanceof Error ? e.message : 'unknown'}`,
      );
    }
    return { import: toView(updated as typeof importJobs.$inferSelect) };
  }

  /** Stream progress over an SSE writer until the job reaches a
   *  terminal state OR the client disconnects (signal aborted).
   *
   *  Cadence: poll every `pollMs` (default 500ms, per docs/03 §10
   *  "SSE events מקובצים: כל 500ms או כל 1000 שורות"). Emit on the
   *  first poll (so the client gets the initial state right away)
   *  and on every subsequent change. v4 follow-up: a heartbeat
   *  comment frame every 15s keeps the connection alive past
   *  reverse-proxy idle timeouts (Cloudflare / Railway / nginx). */
  async streamProgress(opts: {
    user: AccessTokenPayload;
    id: string;
    write: (event: SseEvent) => void;
    writeComment?: (line: string) => void;
    signal: AbortSignal;
    pollMs?: number;
    heartbeatMs?: number;
    maxIterations?: number;
  }): Promise<void> {
    const { user, id, write, writeComment, signal } = opts;
    const pollMs = opts.pollMs ?? 500;
    const heartbeatMs = opts.heartbeatMs ?? 15_000;
    const maxIterations = opts.maxIterations ?? Math.ceil((30 * 60 * 1000) / pollMs);

    let prev: ImportJobView | null = null;
    let lastHeartbeat = Date.now();

    for (let i = 0; i < maxIterations; i += 1) {
      if (signal.aborted) return;

      let view: ImportJobView;
      try {
        view = await this.get(user, id);
      } catch (e: unknown) {
        if (e instanceof NotFoundException) {
          write({ event: 'gone', data: { id } });
          return;
        }
        throw e;
      }

      const changed =
        prev === null ||
        prev.status !== view.status ||
        prev.processedRows !== view.processedRows ||
        prev.okRows !== view.okRows ||
        prev.failedRows !== view.failedRows ||
        prev.totalRows !== view.totalRows ||
        prev.updatedAt.getTime() !== view.updatedAt.getTime();

      if (changed) {
        write({
          event: 'progress',
          data: {
            id: view.id,
            status: view.status,
            totalRows: view.totalRows,
            processedRows: view.processedRows,
            okRows: view.okRows,
            failedRows: view.failedRows,
            updatedAt: view.updatedAt.toISOString(),
          },
        });
        prev = view;
        lastHeartbeat = Date.now();
      } else if (writeComment && Date.now() - lastHeartbeat >= heartbeatMs) {
        // v4 audit follow-up (HIGH-UX): heartbeat frame so reverse
        // proxies don't kill the idle connection. SSE comments
        // (`: ...\n\n`) are ignored by EventSource clients but reset
        // the proxy's idle timer.
        writeComment(`: heartbeat ${new Date().toISOString()}`);
        lastHeartbeat = Date.now();
      }

      if (TERMINAL.has(view.status)) {
        write({ event: 'end', data: { id: view.id, status: view.status } });
        return;
      }

      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, pollMs);
        const onAbort = (): void => {
          clearTimeout(t);
          resolve();
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    }
  }

  private async load(tx: TenantTx, id: string) {
    const [row] = await tx.select().from(importJobs).where(eq(importJobs.id, id)).limit(1);
    if (!row) throw NOT_FOUND;
    return row;
  }

  /** Wrap storage.head() in a deadline race. Returns:
   *   - `StorageObjectMeta` when head() resolves with metadata in time
   *   - `null` when head() resolves with "no attestation" (Fake) in time
   *   - `undefined` when the deadline fired first (caller logs + skips)
   *  Rejections from head() are RETHROWN so the caller's catch can
   *  decide (BadRequestException for size mismatch, warn-and-continue
   *  for anything else).
   *
   *  v8 SOLID-6 / Perf-1: pass an AbortController.signal into the
   *  SDK call so the deadline ACTUALLY cancels the network request
   *  (closes the socket back to the pool) instead of leaving it
   *  lingering until the SDK's own socketTimeout fires. The race is
   *  still observational for the API's response — the abort is
   *  observational for the SDK's connection pool.
   *
   *  v7 P0 (perf Agent C). */
  private async headWithDeadline(
    key: string,
    deadlineMs: number,
  ): Promise<Awaited<ReturnType<IStorageProvider['head']>> | undefined> {
    const DEADLINE = Symbol('deadline');
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<typeof DEADLINE>((resolve) => {
      timer = setTimeout(() => {
        // Fire the abort FIRST so the in-flight SDK request tears
        // down its socket; then resolve the race so the caller sees
        // `undefined` and proceeds.
        abort.abort();
        resolve(DEADLINE);
      }, deadlineMs);
      timer.unref?.();
    });
    try {
      const winner = await Promise.race([
        this.storage.head(key, { signal: abort.signal }),
        deadline,
      ]);
      return winner === DEADLINE ? undefined : winner;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/** Server-sent event frame. Always a JSON-serialisable payload (no PII).
 *
 *  v7 audit Agent A HIGH-1: the canonical type is `ImportSseEvent` in
 *  `@emapp/shared-types` — a discriminated union over event ∈
 *  progress|end|gone. We re-export it under the old `SseEvent` name so
 *  in-repo importers (controller + spec) keep working, but the FE will
 *  import the union name directly. Schema is also exported so the FE
 *  can `parse(JSON.parse(line))` defensively.
 *
 *  Encode/decode lives here (uses the wire format, not the shape).
 *  See https://html.spec.whatwg.org/multipage/server-sent-events.html. */
export type SseEvent = ImportSseEvent;
export function encodeSseFrame(ev: SseEvent): string {
  return `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`;
}
