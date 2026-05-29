/**
 * V11 A.S15 — pure helpers for ExportXlsxButton.
 *
 * The button's React rendering is exercised via the per-slice browser
 * smoke (V11-BROWSER-SMOKE.md) — the dev environment doesn't ship the
 * `@testing-library/react` stack and the existing spec convention is
 * `.spec.ts` (pure logic) only.
 *
 * Covers:
 *   - `parseFilename` — Content-Disposition variants (RFC 6266 quoted +
 *     RFC 5987 UTF-8 encoded for Hebrew filenames + malformed/missing).
 *   - `defaultName` — ASCII-only slug; PII-bearing `fallbackName` is
 *     ignored on purpose.
 */
import { describe, expect, it } from 'vitest';

import { defaultName, parseFilename } from './export-xlsx-button';

describe('A.S15 / ExportXlsxButton helpers — parseFilename', () => {
  it('1) null header → null', () => {
    expect(parseFilename(null)).toBeNull();
  });

  it('2) plain quoted filename', () => {
    expect(parseFilename('attachment; filename="project-p1.xlsx"')).toBe('project-p1.xlsx');
  });

  it('3) plain unquoted filename', () => {
    expect(parseFilename('attachment; filename=project-p1.xlsx')).toBe('project-p1.xlsx');
  });

  it('4) RFC 5987 utf-8 encoded — Hebrew survives', () => {
    // "פרויקט-α.xlsx" — Hebrew + alpha
    const enc = encodeURIComponent('פרויקט-α.xlsx');
    const header = `attachment; filename="fallback.xlsx"; filename*=UTF-8''${enc}`;
    expect(parseFilename(header)).toBe('פרויקט-α.xlsx');
  });

  it('5) RFC 5987 preferred when both present', () => {
    const enc = encodeURIComponent('utf-name.xlsx');
    const header = `attachment; filename="ascii-name.xlsx"; filename*=UTF-8''${enc}`;
    expect(parseFilename(header)).toBe('utf-name.xlsx');
  });

  it('6) malformed RFC 5987 falls back to plain', () => {
    // `%FF` is not a valid UTF-8 sequence — decodeURIComponent throws,
    // we fall back to the plain filename per docstring contract.
    const header = `attachment; filename="fallback.xlsx"; filename*=UTF-8''%FF`;
    expect(parseFilename(header)).toBe('fallback.xlsx');
  });

  it('7) missing filename token → null', () => {
    expect(parseFilename('attachment')).toBeNull();
  });

  it('8) inline disposition with filename', () => {
    expect(parseFilename('inline; filename="inline.xlsx"')).toBe('inline.xlsx');
  });

  it('9) tolerates extra params', () => {
    expect(parseFilename('attachment; filename="p.xlsx"; size=1234; charset=binary')).toBe(
      'p.xlsx',
    );
  });
});

describe('A.S15 / ExportXlsxButton helpers — defaultName', () => {
  it('10) ASCII id passes through', () => {
    expect(defaultName('p1')).toBe('project-p1.xlsx');
  });

  it('11) uuid-style id passes through', () => {
    expect(defaultName('550e8400-e29b-41d4-a716-446655440000')).toBe(
      'project-550e8400-e29b-41d4-a716-446655440000.xlsx',
    );
  });

  it('12) strips non-ASCII / non-safe characters', () => {
    // Hebrew + path separators + nulls — all stripped.
    expect(defaultName('דירה/../etc\x00')).toBe('project-export.xlsx');
  });

  it('13) U+202E bidi-spoof in id is rejected (all-or-nothing defence)', () => {
    // Literal U+202E in test strings trips ESLint's bidi-attack rule;
    // construct via codepoint so the source bytes stay clean.
    const rtlOverride = String.fromCodePoint(0x202e);
    const dirty = `p${rtlOverride}1`;
    // ANY non-safe char ⇒ reject the entire id and use the generic
    // stub. Stripping would leak attacker intent through the surviving
    // fragment (here "p1") — see implementation docstring.
    expect(defaultName(dirty)).toBe('project-export.xlsx');
  });

  it('14) empty id → bare "project-export"', () => {
    expect(defaultName('')).toBe('project-export.xlsx');
  });
});
