/**
 * Pins the shared PII-safe pg-error scrub (Theme-C — dedup of the API filter S1
 * + worker S2 scrubs). The load-bearing security property: pg `cause.detail` /
 * `hint` (column VALUES, e.g. national_id) are removed from the WHOLE cause
 * chain before an error can be handed to Sentry; the SQLSTATE code is kept.
 * Fail-closed: a frozen cause that can't be scrubbed reports `scrubbed:false`.
 *
 * Pure unit — no DB. Markers are assembled at runtime so no literal constant
 * could be trivially matched.
 */
import { describe, expect, it } from 'vitest';

import { scrubPgErrorPii } from '../src/pg-error-scrub';

function leakyPgError(): { err: Error; detail: string; hint: string; detail2: string } {
  const detail = `PG-DETAIL-national_id-${(123_456_789).toString()}`;
  const hint = `PG-HINT-${(999).toString()}`;
  const detail2 = `PG-DETAIL-phone-${(555_123).toString()}`;
  const err = new Error('duplicate key');
  (err as { cause?: unknown }).cause = {
    code: '23505',
    message: 'duplicate key value violates unique constraint',
    detail,
    hint,
    cause: { code: '23503', detail: detail2, hint: 'nested' },
  };
  return { err, detail, hint, detail2 };
}

describe('scrubPgErrorPii', () => {
  it('deletes detail/hint at EVERY depth and reports scrubbed:true', () => {
    const { err, detail, hint, detail2 } = leakyPgError();
    const res = scrubPgErrorPii(err);

    expect(res.scrubbed).toBe(true);
    const c1 = (err as { cause?: Record<string, unknown> }).cause!;
    expect(c1).not.toHaveProperty('detail');
    expect(c1).not.toHaveProperty('hint');
    const c2 = (c1 as { cause?: Record<string, unknown> }).cause!;
    expect(c2).not.toHaveProperty('detail');
    expect(c2).not.toHaveProperty('hint');
    // None of the PII values survive anywhere on the chain.
    const serialized = JSON.stringify(err, (_k, v) => v) + JSON.stringify(c1) + JSON.stringify(c2);
    expect(serialized).not.toContain(detail);
    expect(serialized).not.toContain(hint);
    expect(serialized).not.toContain(detail2);
  });

  it('collects the SQLSTATE codes (PII-safe) from every level', () => {
    const { err } = leakyPgError();
    expect(scrubPgErrorPii(err).pgCodes).toEqual(['23505', '23503']);
  });

  it('keeps the pg code + message (allowed) — only detail/hint are removed', () => {
    const { err } = leakyPgError();
    scrubPgErrorPii(err);
    const c1 = (err as { cause?: Record<string, unknown> }).cause!;
    expect(c1.code).toBe('23505');
    expect(c1.message).toBe('duplicate key value violates unique constraint');
  });

  it('FAILS CLOSED on a frozen cause (delete throws) — scrubbed:false, never throws', () => {
    const err = new Error('frozen');
    (err as { cause?: unknown }).cause = Object.freeze({
      code: '23505',
      detail: 'LEAK',
      hint: 'H',
    });
    let res!: ReturnType<typeof scrubPgErrorPii>;
    expect(() => {
      res = scrubPgErrorPii(err);
    }).not.toThrow();
    expect(res.scrubbed).toBe(false);
    // pgCode is still collected (it's read, not deleted).
    expect(res.pgCodes).toContain('23505');
  });

  it('handles no cause / non-error inputs without throwing', () => {
    expect(scrubPgErrorPii(new Error('no cause'))).toEqual({ pgCodes: [], scrubbed: true });
    expect(scrubPgErrorPii(undefined)).toEqual({ pgCodes: [], scrubbed: true });
    expect(scrubPgErrorPii(null)).toEqual({ pgCodes: [], scrubbed: true });
    expect(scrubPgErrorPii('a string')).toEqual({ pgCodes: [], scrubbed: true });
  });

  it('is depth-bounded (does not walk an absurdly deep / cyclic chain forever)', () => {
    const err = new Error('deep');
    let node: Record<string, unknown> = err as unknown as Record<string, unknown>;
    for (let i = 0; i < 20; i++) {
      const next = { code: '23505', detail: `d${i}`, hint: `h${i}`, cause: undefined as unknown };
      node.cause = next;
      node = next;
    }
    const res = scrubPgErrorPii(err);
    // Bounded at 5 — collects at most 5 codes, never hangs.
    expect(res.pgCodes.length).toBeLessThanOrEqual(5);
    expect(res.scrubbed).toBe(true);
  });
});
