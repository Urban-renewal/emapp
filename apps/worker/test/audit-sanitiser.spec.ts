/**
 * Test #1 — PII never lands in audit_log metadata via err.message.
 *
 * Audit-pass v2 finding C2: drizzle/pg unique-violation messages
 * include the offending column value (e.g. `Key (national_id)=(...)
 * already exists`). The handler's markFailed() audits the failure
 * with `metadata.reason = err.message` — that value lands in jsonb
 * queryable by every Manager. Direct docs/07 §5 violation.
 *
 * Fix: `summariseFailureForAudit(err)` returns a value-free record.
 * This spec pins every angle so a future regression can't widen the
 * audit surface accidentally.
 */
import { NonRetryableJobError } from '@emapp/jobs';
import { describe, expect, it } from 'vitest';

import { summariseFailureForAudit } from '../src/security/audit-sanitiser';

/** Mimic a Drizzle-wrapped pg unique-violation error. The shape
 *  follows what node-postgres throws and Drizzle re-wraps. */
function pgUniqueViolation(value: string): Error {
  const inner = new Error(
    `duplicate key value violates unique constraint "owners_org_natid_unique_active": ` +
      `Key (national_id_hash)=(${value}) already exists.`,
  );
  Object.assign(inner, {
    code: '23505',
    constraint: 'owners_org_natid_unique_active',
    detail: `Key (national_id_hash)=(${value}) already exists.`,
    table: 'owners',
    schema: 'public',
  });
  const wrapped = new Error(`Failed query: insert into "owners" (...)`);
  (wrapped as { cause?: unknown }).cause = inner;
  return wrapped;
}

describe('summariseFailureForAudit — Test #1 (PII non-leak)', () => {
  it('1) plain Error → class only, no leak surface', () => {
    const out = summariseFailureForAudit(new Error('whatever'));
    expect(out.error_class).toBe('Error');
    expect(out.non_retryable_code).toBeNull();
    expect(out.pg_code).toBeNull();
    expect(out.pg_constraint).toBeNull();
  });

  it('2) NonRetryableJobError → carries code, NOT the message', () => {
    const out = summariseFailureForAudit(
      new NonRetryableJobError('parse failed: corrupt_file', 'parse_corrupt_file'),
    );
    expect(out.error_class).toBe('NonRetryableJobError');
    expect(out.non_retryable_code).toBe('parse_corrupt_file');
    // Critically: no `reason` / `message` field anywhere on the result.
    expect(out).not.toHaveProperty('reason');
    expect(out).not.toHaveProperty('message');
  });

  it('3) pg unique-violation chained via cause → code+constraint surface, value GONE', () => {
    const out = summariseFailureForAudit(pgUniqueViolation('123456789'));
    expect(out.pg_code).toBe('23505');
    expect(out.pg_constraint).toBe('owners_org_natid_unique_active');

    // The audit summary must NOT carry the violated value anywhere.
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain('123456789');
    expect(serialised).not.toContain('Key (');
    expect(serialised).not.toContain('detail');
    expect(serialised).not.toContain('already exists');
  });

  it('4) deeply nested cause chain (≥3 deep) — still no leak', () => {
    // Simulate: middleware wraps the wrapper that wraps pg.
    const pg = pgUniqueViolation('987654321');
    const w1 = new Error('repository: failed insert');
    (w1 as { cause?: unknown }).cause = pg;
    const w2 = new Error('service: import row N failed');
    (w2 as { cause?: unknown }).cause = w1;
    const w3 = new Error('handler: validateStage');
    (w3 as { cause?: unknown }).cause = w2;

    const out = summariseFailureForAudit(w3);
    expect(out.pg_code).toBe('23505');
    expect(JSON.stringify(out)).not.toContain('987654321');
  });

  it('5) cause chain longer than the bounded walk depth (8) → no infinite loop', () => {
    // Build a cycle-free 20-deep chain.
    let cur: Error = new Error('leaf');
    for (let i = 0; i < 20; i += 1) {
      const wrap = new Error(`level ${i}`);
      (wrap as { cause?: unknown }).cause = cur;
      cur = wrap;
    }
    const out = summariseFailureForAudit(cur);
    // Resolves without throwing; no pg fields present at this depth.
    expect(out.pg_code).toBeNull();
    expect(out.pg_constraint).toBeNull();
  });

  it('6) self-referential cause cycle → bounded walk does not hang', () => {
    const a = new Error('a');
    const b = new Error('b');
    (a as { cause?: unknown }).cause = b;
    (b as { cause?: unknown }).cause = a; // cycle
    const out = summariseFailureForAudit(a);
    expect(out.error_class).toBe('Error');
  });

  it('7) malformed pg fields (non-string code / over-long constraint) → ignored', () => {
    const malformed = new Error('weird');
    Object.assign(malformed, {
      code: 12345, // numeric, not string
      constraint: 'A'.repeat(500), // way too long
    });
    const out = summariseFailureForAudit(malformed);
    expect(out.pg_code).toBeNull();
    expect(out.pg_constraint).toBeNull();
  });

  it('8) non-Error inputs → still safe (no crash, default class)', () => {
    expect(summariseFailureForAudit(null).error_class).toBe('Unknown');
    expect(summariseFailureForAudit(undefined).error_class).toBe('Unknown');
    expect(summariseFailureForAudit('a string').error_class).toBe('Unknown');
    expect(summariseFailureForAudit(42).error_class).toBe('Unknown');
    expect(summariseFailureForAudit({ random: 'object' }).error_class).toBe('Unknown');
  });

  it('9) the WHOLE OUTPUT is a flat string-or-null record — no nested objects that could grow', () => {
    const out = summariseFailureForAudit(pgUniqueViolation('123456789'));
    for (const [, v] of Object.entries(out)) {
      expect(v === null || typeof v === 'string').toBe(true);
    }
  });

  it('10) pg `detail` / `hint` / `where` are NEVER copied to the summary', () => {
    const err = new Error('Failed query');
    const inner = new Error('pg-inner');
    Object.assign(inner, {
      code: '23514',
      constraint: 'import_jobs_status_valid',
      detail: 'Failing row contains (123e4567-..., bad-status, 1024).',
      hint: 'Use one of the allowed statuses.',
      where: 'SQL function "...":4',
    });
    (err as { cause?: unknown }).cause = inner;

    const out = summariseFailureForAudit(err);
    const ser = JSON.stringify(out);
    expect(ser).not.toContain('Failing row');
    expect(ser).not.toContain('Use one of');
    expect(ser).not.toContain('SQL function');
    expect(out.pg_code).toBe('23514');
    expect(out.pg_constraint).toBe('import_jobs_status_valid');
  });
});
