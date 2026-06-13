/**
 * Opaque keyset cursor (D.16: cursor pagination ONLY, never offset).
 *
 * The (createdAt desc, id desc) pair is a stable total order, so paging is
 * consistent under concurrent inserts/deletes. The cursor is base64url JSON
 * — opaque to clients; a tampered value decodes to null and the caller MUST
 * surface a 400 `invalid_cursor` (never a 500).
 *
 * PRECISION (D.58) — the cursor's `c` is `Date.toISOString()` = MILLISECOND
 * precision, but `created_at` columns are `timestamptz` = Postgres MICROSECOND
 * precision. A naive keyset that compares the full-precision column against the
 * ms-truncated cursor SILENTLY DROPS rows that share the boundary's millisecond
 * but carry nonzero microseconds (the pg driver hands JS a ms-truncated Date,
 * so the micros are gone before `encodeCursor` even runs). The fix: compare and
 * order at a CONSISTENT millisecond precision via `date_trunc('milliseconds',
 * created_at)` on BOTH sides. Ranking AND filtering MUST use the same precision
 * or the id tie-breaker desynchronises. Build keyset predicates and ordering
 * ONLY through `keysetCondition` / `keysetOrderBy` below — never hand-roll the
 * `lt(createdAt, new Date(cur.c))` form again. See DECISIONS D.58.
 */
import { BadRequestException } from '@nestjs/common';
import { and, eq, lt, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

export interface KeysetCursor {
  c: string; // createdAt ISO (millisecond precision)
  i: string; // id (tie-breaker)
}

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ c: row.createdAt.toISOString(), i: row.id })).toString(
    'base64url',
  );
}

/**
 * The keyset predicate for "rows strictly before (createdAt DESC, id DESC) the
 * cursor", compared at MILLISECOND precision so it round-trips the ms cursor
 * losslessly (D.58). `created_at` is truncated to ms so a row sharing the
 * boundary's millisecond is matched, then the id tie-breaker orders within the
 * millisecond. Pass the SAME columns to `keysetOrderBy`.
 */
export function keysetCondition(
  createdAtCol: AnyPgColumn,
  idCol: AnyPgColumn,
  cur: KeysetCursor,
): SQL {
  const boundaryMs = sql`date_trunc('milliseconds', ${createdAtCol})`;
  const cursorMs = sql`${cur.c}::timestamptz`;
  return or(lt(boundaryMs, cursorMs), and(eq(boundaryMs, cursorMs), lt(idCol, cur.i))) as SQL;
}

/**
 * The ORDER BY that pairs with `keysetCondition` — `(date_trunc('milliseconds',
 * created_at) DESC, id DESC)`. MUST truncate to ms to match the predicate, else
 * within-millisecond rows rank by micros but filter by id and pagination skips
 * (D.58). Spread into `.orderBy(...keysetOrderBy(col, idCol))`.
 */
export function keysetOrderBy(createdAtCol: AnyPgColumn, idCol: AnyPgColumn): SQL[] {
  return [sql`date_trunc('milliseconds', ${createdAtCol}) desc`, sql`${idCol} desc`];
}

export function decodeCursor(raw: string): KeysetCursor | null {
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as KeysetCursor;
    if (typeof v?.c === 'string' && typeof v?.i === 'string' && !Number.isNaN(Date.parse(v.c))) {
      return v;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Audit v1.1 SA-11 closure — the 4-line `decode + null-check + throw 400`
 * dance was duplicated in every service that paginates (~18 sites). The
 * helper centralises the shape so a future change to the cursor envelope
 * (e.g. signed cursors) needs ONE edit, not eighteen.
 *
 * Migration policy: provider services adopt this in the SA-11 PR; org-tier
 * services migrate opportunistically as they're next touched (lower
 * blast-radius approach — many of them have golden contract suites that
 * assert error envelopes and we don't want to churn those in a refactor
 * PR).
 *
 * The error body matches D.16 — `{ error: { code: 'invalid_cursor' } }`,
 * no message. The two provider services that previously included
 * `message: 'Cursor is malformed'` are switching to the canonical org-tier
 * shape; no spec was asserting on the exact message (grep audited).
 */
export function decodeCursorOrThrow(raw: string): KeysetCursor {
  const decoded = decodeCursor(raw);
  if (!decoded) {
    throw new BadRequestException({ error: { code: 'invalid_cursor' } });
  }
  return decoded;
}
