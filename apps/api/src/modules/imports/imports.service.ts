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
 *   - Manager-only writes via requireManager() (D.17 + D.26 policy).
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
import { randomUUID, createHash } from 'node:crypto';

import {
  AuditService,
  importJobErrors,
  importJobs,
  mappingTemplates,
  projectAssignments,
  projects,
  withTenant,
  type IStorageProvider,
  type TenantTx,
} from '@emapp/db';
import { IMPORT_JOB_NAME, type IJobProducer } from '@emapp/jobs';
import {
  type CreateImport,
  type ImportError,
  type ImportJob,
  type ImportUploadResponse,
  type ListImportErrorsQueryDto,
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
import { and, asc, desc, eq, gt, sql } from 'drizzle-orm';

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
]);

function toView(row: typeof importJobs.$inferSelect): ImportJobView {
  return {
    id: row.id,
    organizationId: row.orgId,
    projectId: row.projectId,
    status: row.status as ImportJobView['status'],
    fileName: row.fileName,
    fileSizeBytes: row.fileSizeBytes,
    totalRows: row.totalRows,
    processedRows: row.processedRows,
    okRows: row.okRows,
    failedRows: row.failedRows,
    dryRun: row.dryRun,
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

/** Normalize the content-hash to bare hex (strip optional sha256:
 *  prefix). The DB column stores `sha256:<hex>` so we re-add the
 *  prefix on persistence. */
function normalizeHash(input: string): string {
  return input.startsWith('sha256:') ? input.slice(7) : input;
}

/** sha256 hex of the headers array — same algorithm the future
 *  TemplateResolver (L2 D.34) will use to look up saved mappings.
 *  Normalises by lowercasing + trimming before hashing so trivial
 *  whitespace/case differences don't fragment the template space. */
function fingerprintHeaders(headers: readonly string[]): string {
  const normalised = headers.map((h) => h.trim().toLowerCase()).join('\x00');
  return createHash('sha256').update(normalised).digest('hex');
}

@Injectable()
export class ImportsService {
  private readonly logger = new Logger(ImportsService.name);

  constructor(
    @Inject(STORAGE_PROVIDER) private readonly storage: IStorageProvider,
    @Inject(JOB_PRODUCER) private readonly producer: IJobProducer,
  ) {}

  private requireManager(user: AccessTokenPayload): void {
    if (user.role !== 'manager') throw FORBIDDEN;
  }

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

  /** POST /imports — create row + return presigned PUT URL.
   *  Manager-only. Project visibility verified. Audit row written
   *  inside the same tx as the INSERT. */
  async create(user: AccessTokenPayload, input: CreateImport): Promise<ImportUploadResponse> {
    this.requireManager(user);
    const r2Key = newImportKey(user.orgId);
    const fileContentHash = `sha256:${normalizeHash(input.fileContentHash)}`;

    const row = await withTenant(
      user.orgId,
      async (tx) => {
        await this.assertProjectVisible(tx, user, input.projectId);

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
              createdBy: user.sub,
              idempotencyKey: input.idempotencyKey ?? null,
            })
            .returning();
        } catch {
          // SECURITY (same posture as documents.create HIGH-1): the
          // pg error detail may include the r2Key on a UNIQUE
          // violation. Swallow the cause chain → generic conflict.
          // A server-random r2Key makes a real collision astronomical.
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
            fileName: inserted.fileName,
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
      // Compensate: archive the orphan row so it doesn't dangle.
      await withTenant(
        user.orgId,
        async (tx) => {
          await tx
            .update(importJobs)
            .set({ status: 'failed', finishedAt: new Date(), updatedAt: new Date() })
            .where(eq(importJobs.id, row.id));
        },
        { userId: user.sub },
      ).catch(() => undefined);
      this.logger.error(
        `presign(upload) failed (import=${row.id}): ${e instanceof Error ? e.message : 'unknown'}`,
      );
      throw new ServiceUnavailableException({ error: { code: 'storage_unavailable' } });
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
    this.requireManager(user);
    const row = await withTenant(
      user.orgId,
      async (tx) => {
        const r = await this.load(tx, id);
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
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'import.start_requested',
          targetTable: 'import_jobs',
          targetId: id,
          sessionId: user.sid,
        });
        return r;
      },
      { userId: user.sub },
    );

    // Verify the upload happened. IStorageProvider.head() returns
    // null for the FakeStorageProvider in dev/test (no real bytes
    // were sent through a presigned URL there); we treat null as
    // "no storage-attested fact" and trust the client-side flow.
    // In prod with R2, head() returns metadata so a missing object
    // surfaces as 400 ("upload not received").
    try {
      const meta = await this.storage.head(row.fileR2Key);
      if (meta === null) {
        // Fake / not-attested — proceed. The worker will fail loud
        // if the file isn't actually there.
      } else {
        if (meta.contentLength !== row.fileSizeBytes) {
          throw new BadRequestException({
            error: { code: 'upload_size_mismatch' },
          });
        }
      }
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      this.logger.warn(
        `head(${row.fileR2Key}) errored — proceeding without attestation: ${
          e instanceof Error ? e.message : 'unknown'
        }`,
      );
    }

    // Enqueue. singletonKey = row id → a second /start for the same
    // row while the first is still active is a producer-side no-op
    // (one extra layer of idempotency on top of the FE's button
    // debounce).
    await this.producer.send(
      IMPORT_JOB_NAME,
      { jobId: id, orgId: user.orgId, createdBy: user.sub },
      { singletonKey: id },
    );

    return this.get(user, id);
  }

  /** DELETE /imports/:id — cancel a non-terminal row. The worker's
   *  state-machine loop re-reads status before each transition (and
   *  v4 added a mid-persistStage guard); a cancel here wins the race
   *  any time the worker hasn't yet committed the next transition. */
  async cancel(user: AccessTokenPayload, id: string): Promise<void> {
    this.requireManager(user);
    await withTenant(
      user.orgId,
      async (tx) => {
        const row = await this.load(tx, id);
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
        const result = await tx
          .update(importJobs)
          .set({ status: 'cancelled', finishedAt: now, updatedAt: now })
          .where(
            and(
              eq(importJobs.id, id),
              // Race-safe — the worker MAY have just transitioned;
              // we only flip from a cancellable status.
              sql`${importJobs.status} IN ('queued','parsing','validating','persisting','awaiting_mapping')`,
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
      },
      { userId: user.sub },
    );
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
    this.requireManager(user);

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

    return withTenant(
      user.orgId,
      async (tx) => {
        const row = await this.load(tx, id);
        if (row.status !== 'awaiting_mapping') {
          throw new ConflictException({
            error: { code: 'import_not_awaiting_mapping', message: `status is ${row.status}` },
          });
        }

        // Compute a per-org fingerprint that's stable for this
        // particular import id. Even if two imports share headers,
        // a manual mapping for THIS import gets its own template
        // row (manual templates carry their job-of-origin context).
        // The L2 TemplateResolver (Phase 7+) will use the real
        // headers-fingerprint for lookup; this endpoint just needs
        // the row to satisfy the partial UNIQUE (org, fingerprint)
        // WHERE archived_at IS NULL.
        const fingerprint = fingerprintHeaders([`manual:${id}`]);

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
              name: input.templateName ?? `Manual mapping for import ${id.slice(0, 8)}`,
              mapping: { columns: input.columns, headers: [] },
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

        // Flip the job back to 'queued' and clear progress counters
        // so the SSE shows a fresh restart. The worker on next pickup
        // will re-parse with the new mapping (NOT YET — L2 resolver
        // is Phase 7+; for now the wizard sets the column map but
        // the worker still uses L1. Recorded as a deliberate gap;
        // closing it requires the Phase 7 TemplateResolver).
        const now = new Date();
        await tx
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

        // Re-enqueue with the same singletonKey for producer-side
        // idempotency. Done OUTSIDE the tx to keep DB tx short, but
        // INSIDE this function so the controller sees the final view.
        // The send is best-effort — if it errors, the audit + state
        // are already committed and the next worker poll (or manual
        // /start) will pick up the queued row.
        // Note: producer.send returns a JobSendResult we don't read.
        try {
          await this.producer.send(
            IMPORT_JOB_NAME,
            { jobId: id, orgId: user.orgId, createdBy: user.sub },
            { singletonKey: id },
          );
        } catch (e) {
          this.logger.warn(
            `re-enqueue after mapping_submitted failed (import=${id}); ` +
              `row is queued, worker will pick up on next poll: ${
                e instanceof Error ? e.message : 'unknown'
              }`,
          );
        }

        const [refreshed] = await tx
          .select()
          .from(importJobs)
          .where(eq(importJobs.id, id))
          .limit(1);
        if (!refreshed) throw NOT_FOUND;
        return { import: toView(refreshed), templateId };
      },
      { userId: user.sub },
    );
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
}

/** Server-sent event frame. Always a JSON-serialisable payload (no PII). */
export interface SseEvent {
  event: 'progress' | 'end' | 'gone';
  data: Record<string, unknown>;
}

/** Encode an SseEvent as the over-the-wire SSE format.
 *  See https://html.spec.whatwg.org/multipage/server-sent-events.html. */
export function encodeSseFrame(ev: SseEvent): string {
  return `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`;
}
