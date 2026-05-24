/**
 * Pure-unit tests for the v8 API-side closures. No DB, no Nest
 * bootstrap — just the schemas + helper functions we touched. The
 * DB-bound behaviour (idempotency replay, start guarded state-flip,
 * cancel/mapping createdBy parity) is already covered by the existing
 * imports.s8.spec.ts; here we pin the WIRE-CONTRACT closures.
 *
 * Covers:
 *  1. SOLID-2 — Sha256HexLowerSchema rejects prefixed input
 *  2. Sec-15  — idempotencyKey schema enforces 16-64 chars
 *  3. SOLID-4 — `toView()` (verified indirectly via sanitiseFilenameForAudit)
 *  4. ImportSseEvent — strict variants reject silent extensions
 *  5. CreateImportInput — `.strict()` rejects unknown fields
 */
import {
  CreateImportInput,
  IMPORT_MAX_SIZE_BYTES,
  ImportSseEventSchema,
  Sha256HexLowerSchema,
  SubmitMappingInput,
} from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import { sanitiseFilenameForAudit } from './imports.service';

const UUID = '00000000-0000-4000-8000-000000000000';
const VALID_HASH = 'a'.repeat(64);

describe('v8 SOLID-2 — Sha256HexLowerSchema is bare-hex canonical', () => {
  it('accepts 64 lowercase hex chars', () => {
    expect(Sha256HexLowerSchema.safeParse(VALID_HASH).success).toBe(true);
  });

  it('REJECTS the historic `sha256:` prefix (contract is bare hex)', () => {
    const prefixed = `sha256:${VALID_HASH}`;
    expect(Sha256HexLowerSchema.safeParse(prefixed).success).toBe(false);
  });

  it('rejects uppercase hex', () => {
    const upper = VALID_HASH.toUpperCase();
    expect(Sha256HexLowerSchema.safeParse(upper).success).toBe(false);
  });

  it('rejects wrong-length input', () => {
    expect(Sha256HexLowerSchema.safeParse('a'.repeat(63)).success).toBe(false);
    expect(Sha256HexLowerSchema.safeParse('a'.repeat(65)).success).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(Sha256HexLowerSchema.safeParse('g'.repeat(64)).success).toBe(false);
  });
});

describe('v8 Sec-15 — idempotencyKey format constraint', () => {
  const base = {
    projectId: UUID,
    fileName: 'file.xlsx',
    fileSizeBytes: 1024,
    fileContentHash: VALID_HASH,
  };

  it('accepts a 36-char UUID', () => {
    const r = CreateImportInput.safeParse({
      ...base,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    });
    expect(r.success).toBe(true);
  });

  it('accepts the optional/absent case', () => {
    const r = CreateImportInput.safeParse(base);
    expect(r.success).toBe(true);
  });

  it('REJECTS 1-15 char enumerable keys', () => {
    for (const s of ['1', 'a', 'abcdefghijklmno']) {
      const r = CreateImportInput.safeParse({ ...base, idempotencyKey: s });
      expect(r.success, `expected reject for "${s}"`).toBe(false);
    }
  });

  it('REJECTS >64 char keys', () => {
    const r = CreateImportInput.safeParse({ ...base, idempotencyKey: 'a'.repeat(65) });
    expect(r.success).toBe(false);
  });

  it('REJECTS keys with disallowed chars (spaces, slashes, quotes)', () => {
    for (const s of [
      'has spaces in it!',
      'with/slashes/here-ok',
      'has"quote"chars',
      'has<html>tags!',
    ]) {
      const r = CreateImportInput.safeParse({ ...base, idempotencyKey: s });
      expect(r.success, `expected reject for "${s}"`).toBe(false);
    }
  });
});

describe('v8 SOLID-4 — sanitiseFilenameForAudit strips Israeli-ID-shaped digit runs', () => {
  it('replaces a 9-digit national-id-shaped run with [N]', () => {
    expect(sanitiseFilenameForAudit('Owner_038123456_signed.xlsx')).toBe('Owner_[N]_signed.xlsx');
  });

  it('replaces a 10-digit Israeli-mobile-shaped run with [N]', () => {
    expect(sanitiseFilenameForAudit('phone_0521234567_list.xlsx')).toBe('phone_[N]_list.xlsx');
  });

  it('does NOT mangle a 4-digit year', () => {
    expect(sanitiseFilenameForAudit('export_2026_q1.xlsx')).toBe('export_2026_q1.xlsx');
  });

  it('handles multiple runs in one string', () => {
    expect(sanitiseFilenameForAudit('a_123456789_b_0521234567.xlsx')).toBe('a_[N]_b_[N].xlsx');
  });
});

describe('v8 SOLID-1 / wire contract — CreateImportInput is strict', () => {
  it('rejects unknown fields (strict)', () => {
    const r = CreateImportInput.safeParse({
      projectId: UUID,
      fileName: 'x.xlsx',
      fileSizeBytes: 1,
      fileContentHash: VALID_HASH,
      unknownField: 'attack-vector',
    });
    expect(r.success).toBe(false);
  });

  it('rejects fileSizeBytes above the 50MB cap', () => {
    const r = CreateImportInput.safeParse({
      projectId: UUID,
      fileName: 'x.xlsx',
      fileSizeBytes: IMPORT_MAX_SIZE_BYTES + 1,
      fileContentHash: VALID_HASH,
    });
    expect(r.success).toBe(false);
  });
});

describe('v8 HIGH-1 — ImportSseEvent rejects silent contract extensions', () => {
  it('rejects an unknown event variant (no shape narrowing)', () => {
    const r = ImportSseEventSchema.safeParse({
      event: 'new-variant-that-fe-must-handle',
      data: { id: UUID },
    });
    expect(r.success).toBe(false);
  });

  it('progress requires every counter', () => {
    const r = ImportSseEventSchema.safeParse({
      event: 'progress',
      data: {
        id: UUID,
        status: 'parsing',
        totalRows: 100,
        processedRows: 1,
        okRows: 1,
        // missing failedRows
        updatedAt: '2026-05-23T10:00:00.000Z',
      },
    });
    expect(r.success).toBe(false);
  });
});

describe('v8 — SubmitMappingInput requires all 5 mandatory canonical fields', () => {
  it('rejects when national_id is missing from columns', () => {
    const r = SubmitMappingInput.safeParse({
      columns: {
        phone: 0,
        name: 1,
        apartment_number: 2,
        building_address: 3,
        // missing national_id
      },
    });
    expect(r.success).toBe(false);
  });

  it('accepts the canonical set with optional ownership_pct', () => {
    const r = SubmitMappingInput.safeParse({
      columns: {
        national_id: 0,
        phone: 1,
        name: 2,
        apartment_number: 3,
        building_address: 4,
        ownership_pct: 5,
      },
    });
    expect(r.success).toBe(true);
  });
});
