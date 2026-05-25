/**
 * Phase 4a S8 — pin the Wire → ViewModel adapter for Import (D.34).
 *
 * Adversarial coverage (per Doc 11 + the v9 "try to break it" mandate):
 *  - HE and EN labels EXHAUSTIVELY cover the 8-state ImportStatusEnum
 *    (a future state added to shared-types without an adapter update
 *     → red CI).
 *  - TERMINAL / CANCELLABLE sets match the worker FORWARD table
 *    (ARCHITECTURE-MAP §5) verbatim.
 *  - progressPct is null when totalRows is null OR 0 (early states
 *    before the worker has counted the workbook).
 *  - progressPct is capped at 100 even if processedRows > totalRows
 *    (defensive against a late-arriving SSE frame).
 *  - fileSizeLabel humanizes B / KB / MB.
 *  - dryRun pass-through (Manager pre-onboarding sanity check).
 */
import { ImportJobSchema, ImportStatusEnum } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import {
  IMPORT_CANCELLABLE_STATES,
  IMPORT_STATUS_COLORS,
  IMPORT_STATUS_LABELS_EN,
  IMPORT_STATUS_LABELS_HE,
  IMPORT_TERMINAL_STATES,
  toImportViewModel,
  toImportViewModels,
} from './import';

function baseImport(over: Partial<import('@emapp/shared-types').ImportJob> = {}) {
  return ImportJobSchema.parse({
    id: 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa',
    organizationId: '22222222-2222-2222-2222-222222222222',
    projectId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    status: 'parsing',
    fileName: 'owners.xlsx',
    fileSizeBytes: 12_345,
    totalRows: 100,
    processedRows: 50,
    okRows: 48,
    failedRows: 2,
    dryRun: false,
    createdBy: '11111111-1111-1111-1111-111111111111',
    createdAt: new Date('2026-05-20T10:00:00Z'),
    updatedAt: new Date('2026-05-20T10:00:30Z'),
    startedAt: new Date('2026-05-20T10:00:05Z'),
    finishedAt: null,
    ...over,
  });
}

describe('toImportViewModel — D.34 8-state machine', () => {
  it('1) HE labels cover every ImportStatusEnum option', () => {
    const k = Object.keys(IMPORT_STATUS_LABELS_HE).sort();
    expect(k).toEqual([...ImportStatusEnum.options].sort());
  });

  it('2) EN labels cover every ImportStatusEnum option', () => {
    const k = Object.keys(IMPORT_STATUS_LABELS_EN).sort();
    expect(k).toEqual([...ImportStatusEnum.options].sort());
  });

  it('3) STATUS_COLORS covers every ImportStatusEnum option', () => {
    const k = Object.keys(IMPORT_STATUS_COLORS).sort();
    expect(k).toEqual([...ImportStatusEnum.options].sort());
  });

  it('4) TERMINAL set matches the worker FORWARD table exactly', () => {
    // ARCHITECTURE-MAP §5: terminal = done/failed/cancelled
    expect([...IMPORT_TERMINAL_STATES].sort()).toEqual(['cancelled', 'done', 'failed'].sort());
  });

  it('5) CANCELLABLE set excludes terminal states', () => {
    for (const t of IMPORT_TERMINAL_STATES) {
      expect(IMPORT_CANCELLABLE_STATES.has(t)).toBe(false);
    }
  });

  it('6) CANCELLABLE includes awaiting_mapping (D.34: wizard-pending row may be aborted)', () => {
    expect(IMPORT_CANCELLABLE_STATES.has('awaiting_mapping')).toBe(true);
  });

  it('7) isTerminal / isCancellable / isAwaitingMapping mirror the sets', () => {
    expect(toImportViewModel(baseImport({ status: 'done' })).isTerminal).toBe(true);
    expect(toImportViewModel(baseImport({ status: 'parsing' })).isTerminal).toBe(false);
    expect(toImportViewModel(baseImport({ status: 'awaiting_mapping' })).isAwaitingMapping).toBe(
      true,
    );
    expect(toImportViewModel(baseImport({ status: 'parsing' })).isAwaitingMapping).toBe(false);
    expect(toImportViewModel(baseImport({ status: 'cancelled' })).isCancellable).toBe(false);
  });

  it('8) progressPct: percentage when totalRows known and > 0', () => {
    expect(toImportViewModel(baseImport({ totalRows: 200, processedRows: 50 })).progressPct).toBe(
      25,
    );
  });

  it('9) progressPct: null when totalRows is null (early state)', () => {
    expect(
      toImportViewModel(baseImport({ totalRows: null, processedRows: 0 })).progressPct,
    ).toBeNull();
  });

  it('10) progressPct: null when totalRows is 0 (no division-by-zero)', () => {
    expect(
      toImportViewModel(baseImport({ totalRows: 0, processedRows: 0 })).progressPct,
    ).toBeNull();
  });

  it('11) progressPct: capped at 100 (defensive against stale SSE frames)', () => {
    expect(toImportViewModel(baseImport({ totalRows: 100, processedRows: 200 })).progressPct).toBe(
      100,
    );
  });

  it('12) fileSizeLabel humanizes B / KB / MB', () => {
    expect(toImportViewModel(baseImport({ fileSizeBytes: 500 })).fileSizeLabel).toBe('500 B');
    expect(toImportViewModel(baseImport({ fileSizeBytes: 12_345 })).fileSizeLabel).toBe('12.1 KB');
    expect(toImportViewModel(baseImport({ fileSizeBytes: 5_242_880 })).fileSizeLabel).toBe(
      '5.0 MB',
    );
  });

  it('13) dryRun pass-through', () => {
    expect(toImportViewModel(baseImport({ dryRun: true })).dryRun).toBe(true);
    expect(toImportViewModel(baseImport({ dryRun: false })).dryRun).toBe(false);
  });

  it('14) HE/EN labels are distinct for at least one status (locale switching works)', () => {
    const he = toImportViewModel(baseImport({ status: 'awaiting_mapping' }), 'he').statusLabel;
    const en = toImportViewModel(baseImport({ status: 'awaiting_mapping' }), 'en').statusLabel;
    expect(he).not.toBe(en);
    expect(he).toBe('ממתין למיפוי');
    expect(en).toBe('Awaiting Mapping');
  });

  it('15) startedRelative / finishedRelative null when timestamps null', () => {
    const vm = toImportViewModel(baseImport({ startedAt: null, finishedAt: null }));
    expect(vm.startedRelative).toBeNull();
    expect(vm.finishedRelative).toBeNull();
  });

  it('16) toImportViewModels preserves order', () => {
    const arr = toImportViewModels([
      baseImport({ id: 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa', fileName: 'A.xlsx' }),
      baseImport({ id: 'aaaaaaaa-2222-2222-2222-aaaaaaaaaaaa', fileName: 'B.xlsx' }),
    ]);
    expect(arr.map((i) => i.fileName)).toEqual(['A.xlsx', 'B.xlsx']);
  });
});
