/**
 * §SOLID-L9 closure pin — computeImportProgressPct edge cases.
 *
 * The imports detail page recomputed this inline before the helper
 * was extracted. This spec pins the contract so the adapter and the
 * live-SSE merge can never diverge.
 */
import { describe, expect, it } from 'vitest';

import { computeImportProgressPct } from './import';

describe('computeImportProgressPct — §SOLID-L9', () => {
  it('1) returns null when totalRows is null (early state, worker not yet counted)', () => {
    expect(computeImportProgressPct({ totalRows: null, processedRows: 0 })).toBeNull();
    expect(computeImportProgressPct({ totalRows: null, processedRows: 999 })).toBeNull();
  });

  it('2) returns null when totalRows is 0 (no division by zero)', () => {
    expect(computeImportProgressPct({ totalRows: 0, processedRows: 0 })).toBeNull();
  });

  it('3) returns 0 when processedRows is 0 and totalRows > 0', () => {
    expect(computeImportProgressPct({ totalRows: 100, processedRows: 0 })).toBe(0);
  });

  it('4) returns rounded percentage for typical values', () => {
    expect(computeImportProgressPct({ totalRows: 100, processedRows: 25 })).toBe(25);
    expect(computeImportProgressPct({ totalRows: 100, processedRows: 51 })).toBe(51);
  });

  it('5) rounds to nearest (not floor) — 51.5% → 52%', () => {
    expect(computeImportProgressPct({ totalRows: 200, processedRows: 103 })).toBe(52);
  });

  it('6) caps at 100 when processedRows > totalRows (stale-SSE-frame defense)', () => {
    expect(computeImportProgressPct({ totalRows: 100, processedRows: 200 })).toBe(100);
    expect(computeImportProgressPct({ totalRows: 1, processedRows: 999 })).toBe(100);
  });

  it('7) returns 100 when fully processed', () => {
    expect(computeImportProgressPct({ totalRows: 50, processedRows: 50 })).toBe(100);
  });
});
