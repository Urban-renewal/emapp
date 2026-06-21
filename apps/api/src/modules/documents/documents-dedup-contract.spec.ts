/**
 * DH4 — document dedup probe: PURE contract + shaping/ranking unit tests (NO DB).
 *
 * Complements the DB-backed `documents-dedup.spec.ts` (RLS / agent-scoping):
 * this file pins the WIRE CONTRACT and the pure response-shaping the service
 * delegates to, with zero I/O.
 *
 *  - DedupCheckInput (Zod): accepts a valid hash; rejects empty / oversize /
 *    non-string / extra-field (`.strict()`).
 *  - toDedupCandidate: projects ONLY the wire fields; r2Key/PII can never leak
 *    (not present on the projected row), and the parsed candidate is
 *    DedupCandidateSchema-valid.
 *  - buildDedupResponse: hasDuplicate is derived strictly from the count;
 *    preserves input order (the SQL ORDER BY newest-first is honoured — the
 *    builder does NOT re-order), and the whole response is
 *    DedupCheckResponseSchema-valid.
 */
import {
  DedupCandidateSchema,
  DedupCheckInput,
  DedupCheckResponseSchema,
} from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import { buildDedupResponse, toDedupCandidate, type DedupCandidateRow } from './documents.service';

const VALID_HASH = 'a'.repeat(64); // sha256-shaped hex

function row(overrides: Partial<DedupCandidateRow> = {}): DedupCandidateRow {
  return {
    documentId: '11111111-1111-1111-1111-111111111111',
    type: 'agreement',
    scope: 'project',
    scopeId: '22222222-2222-2222-2222-222222222222',
    filename: 'הסכם.pdf',
    createdAt: new Date('2026-06-20T10:00:00.000Z'),
    ...overrides,
  };
}

describe('DH4 DedupCheckInput (Zod)', () => {
  it('accepts a valid sha256-shaped contentHash', () => {
    const parsed = DedupCheckInput.parse({ contentHash: VALID_HASH });
    expect(parsed.contentHash).toBe(VALID_HASH);
  });

  it('rejects an empty contentHash', () => {
    expect(DedupCheckInput.safeParse({ contentHash: '' }).success).toBe(false);
  });

  it('rejects an over-128-char contentHash', () => {
    expect(DedupCheckInput.safeParse({ contentHash: 'a'.repeat(129) }).success).toBe(false);
  });

  it('rejects a non-string contentHash', () => {
    expect(DedupCheckInput.safeParse({ contentHash: 123 }).success).toBe(false);
  });

  it('rejects a missing contentHash', () => {
    expect(DedupCheckInput.safeParse({}).success).toBe(false);
  });

  it('rejects an extra field (.strict — no smuggled scope/org override)', () => {
    const r = DedupCheckInput.safeParse({ contentHash: VALID_HASH, orgId: 'x' });
    expect(r.success).toBe(false);
  });
});

describe('DH4 toDedupCandidate (pure shaping)', () => {
  it('projects exactly the wire fields and is DedupCandidateSchema-valid', () => {
    const cand = toDedupCandidate(row());
    expect(cand).toEqual({
      documentId: '11111111-1111-1111-1111-111111111111',
      type: 'agreement',
      scope: 'project',
      scopeId: '22222222-2222-2222-2222-222222222222',
      filename: 'הסכם.pdf',
      createdAt: new Date('2026-06-20T10:00:00.000Z'),
    });
    expect(DedupCandidateSchema.parse(cand)).toBeTruthy();
  });

  it('never exposes r2Key / storage pointer (not on the projected shape)', () => {
    const cand = toDedupCandidate(row());
    expect(cand).not.toHaveProperty('r2Key');
    expect(cand).not.toHaveProperty('r2_key');
  });

  it('carries an org-scope candidate with a null scopeId', () => {
    const cand = toDedupCandidate(row({ scope: 'org', scopeId: null }));
    expect(cand.scope).toBe('org');
    expect(cand.scopeId).toBeNull();
    expect(DedupCandidateSchema.parse(cand)).toBeTruthy();
  });
});

describe('DH4 buildDedupResponse (pure)', () => {
  it('empty input → hasDuplicate=false, empty duplicates', () => {
    const res = buildDedupResponse([]);
    expect(res.hasDuplicate).toBe(false);
    expect(res.duplicates).toHaveLength(0);
    expect(DedupCheckResponseSchema.parse(res)).toBeTruthy();
  });

  it('non-empty input → hasDuplicate=true', () => {
    const res = buildDedupResponse([row()]);
    expect(res.hasDuplicate).toBe(true);
    expect(res.duplicates).toHaveLength(1);
  });

  it('preserves input order (newest-first ranking from SQL is NOT re-sorted)', () => {
    const newer = row({
      documentId: '33333333-3333-3333-3333-333333333333',
      createdAt: new Date('2026-06-20T12:00:00.000Z'),
    });
    const older = row({
      documentId: '44444444-4444-4444-4444-444444444444',
      createdAt: new Date('2026-06-20T08:00:00.000Z'),
    });
    // The service hands rows already ordered newest-first; the builder must
    // keep that order verbatim.
    const res = buildDedupResponse([newer, older]);
    expect(res.duplicates.map((d) => d.documentId)).toEqual([newer.documentId, older.documentId]);
  });

  it('the whole response is DedupCheckResponseSchema-valid', () => {
    const res = buildDedupResponse([row(), row({ scope: 'org', scopeId: null })]);
    expect(DedupCheckResponseSchema.parse(res)).toBeTruthy();
  });
});
