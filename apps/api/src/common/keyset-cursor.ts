/**
 * Opaque keyset cursor (D.16: cursor pagination ONLY, never offset).
 *
 * The (createdAt desc, id desc) pair is a stable total order, so paging is
 * consistent under concurrent inserts/deletes. The cursor is base64url JSON
 * — opaque to clients; a tampered value decodes to null and the caller MUST
 * surface a 400 `invalid_cursor` (never a 500).
 */
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
