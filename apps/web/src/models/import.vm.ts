import type { ImportStatus } from '@emapp/shared-types';

/**
 * Import ViewModel — the 8-state machine (D.34) folded into the UI
 * surface a Manager interacts with.
 *
 * - `statusLabel` / `statusColor` come from the adapter; locked enum
 *   (matches `ImportStatusEnum` in shared-types).
 * - `isTerminal` collapses done/failed/cancelled into "you can no
 *   longer act here" — drives Cancel-button visibility.
 * - `isAwaitingMapping` flags the row that the mapping wizard must
 *   pick up (D.34 manual wizard slot).
 * - `progressPct` is computed from processedRows/totalRows when
 *   totalRows is known; UNKNOWN otherwise (the SSE stream may not
 *   yet have emitted totalRows during the `queued` → `parsing`
 *   window).
 */
export interface ImportViewModel {
  id: string;
  fileName: string;
  fileSizeBytes: number;
  fileSizeLabel: string;
  status: ImportStatus;
  statusLabel: string;
  statusColor: 'gray' | 'amber' | 'emerald' | 'red';
  isTerminal: boolean;
  isCancellable: boolean;
  isAwaitingMapping: boolean;
  totalRows: number | null;
  processedRows: number;
  okRows: number;
  failedRows: number;
  /** Percent 0-100, or null when totalRows is unknown (early states). */
  progressPct: number | null;
  dryRun: boolean;
  createdRelative: string;
  startedRelative: string | null;
  finishedRelative: string | null;
}
