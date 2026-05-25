/**
 * Opaque keyset cursor (D.16: cursor pagination ONLY, never offset).
 *
 * The (createdAt desc, id desc) pair is a stable total order, so paging is
 * consistent under concurrent inserts/deletes. The cursor is base64url JSON
 * — opaque to clients; a tampered value decodes to null and the caller MUST
 * surface a 400 `invalid_cursor` (never a 500).
 */
import { BadRequestException } from '@nestjs/common';

export interface KeysetCursor {
  c: string; // createdAt ISO
  i: string; // id (tie-breaker)
}

export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify({ c: row.createdAt.toISOString(), i: row.id })).toString(
    'base64url',
  );
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
