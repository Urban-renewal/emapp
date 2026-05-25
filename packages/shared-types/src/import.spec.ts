/**
 * §P0-4 closure pin — ImportJobSchema must coerce ISO-string dates.
 *
 * Manual browser-smoke caught: /he/imports rendered as an error overlay
 * (Next.js dev runtime error) when an org had ANY import row. Root cause:
 * `createdAt`, `updatedAt`, `startedAt`, `finishedAt` were declared with
 * strict `z.date()` (expects a Date INSTANCE) but JSON.stringify of a
 * Date emits an ISO 8601 STRING. The FE `.parse(res.data)` call therefore
 * threw on every list item, escaping React's error boundary and toppling
 * the route.
 *
 * Document and Owner schemas use `z.coerce.date()` for the same fields —
 * the import schema diverged. This spec pins the contract so a future
 * "tighten types" sweep can't regress.
 *
 * The bug class is structural: ANY wire schema that uses `z.date()` for
 * a field that the BE serialises will break the same way. The "all-wire-
 * schemas use coerce.date" test below catches the family of bugs, not
 * just the one instance.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ImportErrorSchema, ImportJobSchema } from './import';

describe('§P0-4 — ImportJobSchema accepts ISO-string dates over the wire', () => {
  /** A representative payload as it would land from `JSON.parse(response)`. */
  const wirePayload = {
    id: '11111111-1111-1111-1111-111111111111',
    organizationId: '22222222-2222-2222-2222-222222222222',
    projectId: '33333333-3333-3333-3333-333333333333',
    status: 'done' as const,
    fileName: 'owners.xlsx',
    fileSizeBytes: 1024,
    totalRows: 10,
    processedRows: 10,
    okRows: 10,
    failedRows: 0,
    dryRun: false,
    createdBy: '44444444-4444-4444-4444-444444444444',
    createdAt: '2026-05-25T10:00:00.000Z',
    updatedAt: '2026-05-25T10:05:00.000Z',
    startedAt: '2026-05-25T10:01:00.000Z',
    finishedAt: '2026-05-25T10:05:00.000Z',
  };

  it('1) parses a wire payload where every date is an ISO string', () => {
    expect(() => ImportJobSchema.parse(wirePayload)).not.toThrow();
    const parsed = ImportJobSchema.parse(wirePayload);
    expect(parsed.createdAt).toBeInstanceOf(Date);
    expect(parsed.updatedAt).toBeInstanceOf(Date);
    expect(parsed.startedAt).toBeInstanceOf(Date);
    expect(parsed.finishedAt).toBeInstanceOf(Date);
  });

  it('2) accepts null on nullable date fields', () => {
    const idle = { ...wirePayload, startedAt: null, finishedAt: null };
    const parsed = ImportJobSchema.parse(idle);
    expect(parsed.startedAt).toBeNull();
    expect(parsed.finishedAt).toBeNull();
  });

  it('3) coerces dates inside an array of items (list-endpoint shape)', () => {
    // The /api/v1/imports list endpoint returns `{ data: ImportJob[] }`.
    // Adapters call `z.array(ImportJobSchema).parse(res.data)`. If any
    // item has a string date and the schema is strict, the WHOLE array
    // parse throws — the empty-state UI never gets to render and the
    // page goes to error overlay. Pin the array case.
    const arr = [wirePayload, { ...wirePayload, id: '55555555-5555-5555-5555-555555555555' }];
    const parsed = z.array(ImportJobSchema).parse(arr);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.createdAt).toBeInstanceOf(Date);
    expect(parsed[1]!.createdAt).toBeInstanceOf(Date);
  });

  it('4) ImportErrorSchema also coerces createdAt from ISO string', () => {
    const errorRow = {
      id: '66666666-6666-6666-6666-666666666666',
      rowNumber: 5,
      code: 'invalid_national_id',
      message: 'national_id is not a valid checksum',
      field: 'national_id',
      createdAt: '2026-05-25T10:00:00.000Z',
    };
    const parsed = ImportErrorSchema.parse(errorRow);
    expect(parsed.createdAt).toBeInstanceOf(Date);
  });
});

describe('§P0-4 family-defense — every wire-schema date field must be coercible', () => {
  /**
   * Structural test: any future schema author who writes `z.date()`
   * for a wire field is creating the same bug. We scan the package
   * source for the pattern and fail if found.
   *
   * Allowed patterns:
   *   - `z.coerce.date()` — coerces ISO string → Date
   *   - `z.string().datetime()` — keeps as string (also wire-safe)
   *
   * Forbidden:
   *   - `z.date()` standalone — strict Date instance check
   *
   * False-positives this test deliberately accepts:
   *   - The word `z.date()` inside a `//` or `/* * /` comment is matched.
   *     Authors should escape it as `z.date( )` in prose or use the
   *     phrasing "the strict date schema". The alternative (a real
   *     parser) is overkill for a regression guard.
   */
  it('5) no wire schema uses bare z.date() (use z.coerce.date() instead)', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const here = dirname(fileURLToPath(import.meta.url));
    const offenders: string[] = [];
    for (const entry of readdirSync(here)) {
      if (!entry.endsWith('.ts') || entry.endsWith('.spec.ts')) continue;
      const path = join(here, entry);
      if (!statSync(path).isFile()) continue;
      const src = readFileSync(path, 'utf8');
      // Strip block + line comments before scanning so doc-comments that
      // MENTION `z.date()` don't false-trigger. Simple stripper: enough
      // for our well-formatted source files.
      const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      // Match `z.date(` not preceded by `coerce.`.
      const matches = stripped.match(/(?<!coerce\.)z\.date\(/g);
      if (matches && matches.length > 0) {
        offenders.push(`${entry}: ${matches.length}× bare z.date()`);
      }
    }
    expect(offenders, `Found bare z.date() in: ${offenders.join('; ')}`).toEqual([]);
  });
});
