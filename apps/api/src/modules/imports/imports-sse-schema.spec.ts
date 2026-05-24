/**
 * Unit tests for the ImportSseEvent discriminated union — v7 HIGH-1.
 *
 * The FE will `ImportSseEventSchema.parse(JSON.parse(line))` defensively
 * so the API can't accidentally widen the contract without the FE
 * crashing loud. These tests pin the wire shape so future drift is
 * surfaced at CI time, not at runtime.
 */
import {
  ImportSseEndSchema,
  ImportSseEventSchema,
  ImportSseGoneSchema,
  ImportSseProgressSchema,
} from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

const UUID = '00000000-0000-4000-8000-000000000000';

describe('ImportSseEvent — progress variant', () => {
  it('1) accepts a complete progress frame', () => {
    const ok = ImportSseProgressSchema.safeParse({
      event: 'progress',
      data: {
        id: UUID,
        status: 'parsing',
        totalRows: 100,
        processedRows: 42,
        okRows: 40,
        failedRows: 2,
        updatedAt: '2026-05-23T10:00:00.000Z',
      },
    });
    expect(ok.success).toBe(true);
  });

  it('1b) rejects progress missing any required counter', () => {
    const r = ImportSseProgressSchema.safeParse({
      event: 'progress',
      data: { id: UUID, status: 'parsing', totalRows: null, processedRows: 0, okRows: 0 },
    });
    expect(r.success).toBe(false);
  });

  it('1c) allows totalRows=null (worker has not yet parsed)', () => {
    const r = ImportSseProgressSchema.safeParse({
      event: 'progress',
      data: {
        id: UUID,
        status: 'queued',
        totalRows: null,
        processedRows: 0,
        okRows: 0,
        failedRows: 0,
        updatedAt: '2026-05-23T10:00:00.000Z',
      },
    });
    expect(r.success).toBe(true);
  });

  it('1d) rejects unknown status values (FE must not see drift)', () => {
    const r = ImportSseProgressSchema.safeParse({
      event: 'progress',
      data: {
        id: UUID,
        status: 'PARSING', // wrong case
        totalRows: 0,
        processedRows: 0,
        okRows: 0,
        failedRows: 0,
        updatedAt: '2026-05-23T10:00:00.000Z',
      },
    });
    expect(r.success).toBe(false);
  });
});

describe('ImportSseEvent — end variant', () => {
  it('2) accepts an end frame on done/failed/cancelled', () => {
    for (const status of ['done', 'failed', 'cancelled'] as const) {
      const ok = ImportSseEndSchema.safeParse({
        event: 'end',
        data: { id: UUID, status },
      });
      expect(ok.success, `expected end+${status} to parse`).toBe(true);
    }
  });
});

describe('ImportSseEvent — gone variant', () => {
  it('3) accepts gone with id', () => {
    const ok = ImportSseGoneSchema.safeParse({ event: 'gone', data: { id: UUID } });
    expect(ok.success).toBe(true);
  });
});

describe('ImportSseEvent — discriminated union', () => {
  it('4) routes by event discriminator', () => {
    const samples = [
      {
        event: 'progress' as const,
        data: {
          id: UUID,
          status: 'parsing' as const,
          totalRows: 100,
          processedRows: 1,
          okRows: 1,
          failedRows: 0,
          updatedAt: '2026-05-23T10:00:00.000Z',
        },
      },
      { event: 'end' as const, data: { id: UUID, status: 'done' as const } },
      { event: 'gone' as const, data: { id: UUID } },
    ];
    for (const s of samples) {
      expect(ImportSseEventSchema.safeParse(s).success, `event=${s.event}`).toBe(true);
    }
  });

  it('5) rejects an unknown event variant (no silent extension of wire contract)', () => {
    const r = ImportSseEventSchema.safeParse({
      event: 'started', // not in the union
      data: { id: UUID },
    });
    expect(r.success).toBe(false);
  });
});
