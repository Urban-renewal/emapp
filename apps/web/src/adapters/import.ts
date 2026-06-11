import type { ImportJob, ImportStatus } from '@emapp/shared-types';

import { formatRelative } from '@/lib/format';
import type { ImportViewModel } from '@/models/import.vm';

/**
 * D.34 import status enum — locked 8-state set. Labels mirror the
 * ARCHITECTURE-MAP §5 Hebrew set verbatim so the FE never drifts
 * from the documented state machine.
 */
const STATUS_LABELS_HE: Record<ImportStatus, string> = {
  queued: 'ממתין',
  parsing: 'מנתח',
  validating: 'מאמת',
  persisting: 'כותב',
  awaiting_mapping: 'ממתין למיפוי',
  awaiting_confirm: 'ממתין לאישור',
  done: 'הושלם',
  failed: 'נכשל',
  cancelled: 'בוטל',
};

const STATUS_LABELS_EN: Record<ImportStatus, string> = {
  queued: 'Queued',
  parsing: 'Parsing',
  validating: 'Validating',
  persisting: 'Persisting',
  awaiting_mapping: 'Awaiting Mapping',
  awaiting_confirm: 'Awaiting Confirmation',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STATUS_COLORS: Record<ImportStatus, ImportViewModel['statusColor']> = {
  queued: 'gray',
  parsing: 'amber',
  validating: 'amber',
  persisting: 'amber',
  awaiting_mapping: 'amber',
  awaiting_confirm: 'amber',
  done: 'emerald',
  failed: 'red',
  cancelled: 'gray',
};

const TERMINAL_STATES = new Set<ImportStatus>(['done', 'failed', 'cancelled']);
/** Matches `apps/api/src/modules/imports/imports.service.ts:CANCELLABLE`
 *  (ARCHITECTURE-MAP §5 — derived from the worker FORWARD table). */
const CANCELLABLE_STATES = new Set<ImportStatus>([
  'queued',
  'parsing',
  'validating',
  'persisting',
  'awaiting_mapping',
  'awaiting_confirm',
]);

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * §SOLID-L9 closure — single source of truth for "what percent of rows
 * have been processed". The detail page used to recompute this in the
 * live-SSE merge branch — duplicating the adapter logic. If one path
 * changed (e.g. floor vs round) the live counter and the persisted
 * counter would diverge.
 *
 * Contract:
 *  - totalRows null OR 0 → null (early state; UI shows indeterminate bar)
 *  - processedRows > totalRows → clamped to 100 (stale-SSE-frame defense)
 *  - Math.round (not floor) so 51.5% shows as 52% not 51%
 */
export function computeImportProgressPct(input: {
  totalRows: number | null;
  processedRows: number;
}): number | null {
  if (input.totalRows === null || input.totalRows <= 0) return null;
  return Math.min(100, Math.round((input.processedRows / input.totalRows) * 100));
}

export function toImportViewModel(i: ImportJob, locale: 'he' | 'en' = 'he'): ImportViewModel {
  const labels = locale === 'he' ? STATUS_LABELS_HE : STATUS_LABELS_EN;
  const progressPct = computeImportProgressPct({
    totalRows: i.totalRows,
    processedRows: i.processedRows,
  });
  return {
    id: i.id,
    fileName: i.fileName,
    fileSizeBytes: i.fileSizeBytes,
    fileSizeLabel: formatBytes(i.fileSizeBytes),
    status: i.status,
    statusLabel: labels[i.status],
    statusColor: STATUS_COLORS[i.status],
    isTerminal: TERMINAL_STATES.has(i.status),
    isCancellable: CANCELLABLE_STATES.has(i.status),
    isAwaitingMapping: i.status === 'awaiting_mapping',
    totalRows: i.totalRows,
    processedRows: i.processedRows,
    okRows: i.okRows,
    failedRows: i.failedRows,
    progressPct,
    changeSummary: i.changeSummary ?? null,
    dryRun: i.dryRun,
    createdRelative: formatRelative(i.createdAt, locale),
    startedRelative: i.startedAt ? formatRelative(i.startedAt, locale) : null,
    finishedRelative: i.finishedAt ? formatRelative(i.finishedAt, locale) : null,
  };
}

export function toImportViewModels(
  items: ImportJob[],
  locale: 'he' | 'en' = 'he',
): ImportViewModel[] {
  return items.map((i) => toImportViewModel(i, locale));
}

export const IMPORT_STATUS_LABELS_HE = STATUS_LABELS_HE;
export const IMPORT_STATUS_LABELS_EN = STATUS_LABELS_EN;
export const IMPORT_STATUS_COLORS = STATUS_COLORS;
export const IMPORT_TERMINAL_STATES = TERMINAL_STATES;
export const IMPORT_CANCELLABLE_STATES = CANCELLABLE_STATES;
