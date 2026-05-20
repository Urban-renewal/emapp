/**
 * Imports service — Phase 6 S2 read surface.
 *
 * S2 ships TWO endpoints (S8 adds POST /imports, GET /imports list,
 * DELETE :id/cancel, errors export):
 *   - GET /imports/:id           → current status snapshot
 *   - GET /imports/:id/stream    → SSE progress stream
 *
 * Both read through `withTenant` → RLS org-isolation FORCE. The SSE
 * stream re-issues withTenant on each poll so a forensic provider-admin
 * deletion or a status change is observed immediately and the stream
 * shuts down cleanly.
 *
 * NO PII anywhere on the wire: import_jobs has no PII columns (the file
 * is in R2, owner data is in domain tables touched only during S6's
 * persistence stage, which happens entirely server-side under withTenant).
 */
import { importJobs, withTenant, type TenantTx } from '@emapp/db';
import { Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import type { AccessTokenPayload } from '../auth/auth.service';

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });

/** Wire-shape of an import job. Subset of the row — internal columns
 *  (pg_boss_job_id, file_r2_key, file_content_hash) deliberately
 *  omitted: file_r2_key is the storage pointer (confidentiality, same
 *  pattern as Phase 4 documents); pg_boss_job_id is queue plumbing the
 *  client has no business with. */
export interface ImportJobView {
  id: string;
  status: 'queued' | 'parsing' | 'validating' | 'persisting' | 'done' | 'failed' | 'cancelled';
  fileName: string;
  fileSizeBytes: number;
  totalRows: number | null;
  processedRows: number;
  okRows: number;
  failedRows: number;
  dryRun: boolean;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

const TERMINAL: ReadonlySet<ImportJobView['status']> = new Set(['done', 'failed', 'cancelled']);

function toView(row: typeof importJobs.$inferSelect): ImportJobView {
  return {
    id: row.id,
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

@Injectable()
export class ImportsService {
  async get(user: AccessTokenPayload, id: string): Promise<ImportJobView> {
    const row = await withTenant(user.orgId, async (tx: TenantTx) => this.load(tx, id), {
      userId: user.sub,
    });
    return toView(row);
  }

  /** Stream progress over an SSE writer until the job reaches a
   *  terminal state OR the client disconnects (signal aborted).
   *
   *  Cadence: poll every `pollMs` (default 500ms, per docs/03 §10
   *  "SSE events מקובצים: כל 500ms או כל 1000 שורות"). Emit on the
   *  first poll (so the client gets the initial state right away)
   *  and on every subsequent change (status, processed_rows,
   *  ok_rows, failed_rows, or updated_at). updated_at is the cheap
   *  change-detection key the worker bumps on every stage tick.
   *
   *  The writer abstraction keeps this method unit-testable without
   *  Fastify in the loop: a test can pass an array-collecting writer
   *  and assert the sequence of events emitted. */
  async streamProgress(opts: {
    user: AccessTokenPayload;
    id: string;
    write: (event: SseEvent) => void;
    signal: AbortSignal;
    pollMs?: number;
    maxIterations?: number;
  }): Promise<void> {
    const { user, id, write, signal } = opts;
    const pollMs = opts.pollMs ?? 500;
    // Bound the total time the connection lives even if the job hangs.
    // 30 minutes covers the timeoutMs of ImportJobHandler with margin.
    // Tests pass a small maxIterations to keep the stream finite.
    const maxIterations = opts.maxIterations ?? Math.ceil((30 * 60 * 1000) / pollMs);

    let prev: ImportJobView | null = null;

    for (let i = 0; i < maxIterations; i += 1) {
      if (signal.aborted) return;

      let view: ImportJobView;
      try {
        view = await this.get(user, id);
      } catch (e: unknown) {
        // 404 (deleted/forbidden) → emit a terminal `gone` event and
        // close. Any other error → propagate so the controller can
        // surface it; the SSE connection will close with the error
        // status that the global filter renders.
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
      }

      if (TERMINAL.has(view.status)) {
        // One final `done` framing event so the client knows the
        // stream ended on a real terminal — not just a network drop.
        write({ event: 'end', data: { id: view.id, status: view.status } });
        return;
      }

      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, pollMs);
        // Hook the abort signal so a client disconnect ends the wait
        // immediately rather than wasting up to pollMs.
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
  // JSON-encode the payload on a single line; SSE `data:` lines cannot
  // contain raw newlines — JSON.stringify handles all encodings.
  return `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`;
}
