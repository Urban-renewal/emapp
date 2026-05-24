/**
 * Header-to-domain-field mapping — Phase 6 S4 (T6.2).
 *
 * docs/03 §10 says "Mapping templates — auto-detect by fingerprint של
 * headers". For MVP we ship a canonical mapping registry in-process —
 * NOT a database table. Reasoning:
 *   - Customers can't customize templates yet (no UI for it).
 *   - A code-resident registry is reviewed in PR + change-controlled
 *     (vs a runtime row that bypasses code review).
 *   - When customizable templates land, the registry pattern stays —
 *     we add a `mapping_templates` table + merge resolved aliases.
 *
 * The "fingerprint" today is: normalised(header-set) → canonical match
 * score. If S4 needs to persist per-customer templates later, the same
 * `normaliseHeader` function becomes the table's fingerprint key.
 *
 * Required fields = the minimum to materialise an owner record at
 * persistence (S6). The importer rejects a file that can't map all
 * required fields — that's `mapping_incomplete` (audit_log).
 *
 * Security note: header strings can be attacker-controlled (Excel
 * uploaded by anyone with write to the org's import endpoint, S8).
 * We normalise + match, but NEVER eval / interpolate the raw header
 * into SQL or log lines. This module emits structured ColumnMapping
 * only.
 */

/** Domain fields the importer knows how to fill. Order in the union
 *  is irrelevant; the registry below carries the canonical definitions. */
export type CanonicalField =
  | 'national_id'
  | 'phone'
  | 'name'
  | 'apartment_number'
  | 'building_address'
  | 'ownership_pct';

/** Which fields MUST be present for an import to proceed. Optional
 *  fields are filled with sensible defaults at persistence time
 *  (e.g. ownership_pct = 100 when the apartment has a single owner). */
const REQUIRED_FIELDS: ReadonlySet<CanonicalField> = new Set<CanonicalField>([
  'national_id',
  'phone',
  'name',
  'apartment_number',
  'building_address',
]);

/** Alias registry. Both Hebrew and English are recognised. Values are
 *  ALREADY normalised by `normaliseHeader` (lowercase, trimmed, no
 *  punctuation/whitespace) so the matcher does an O(1) Set lookup. */
const ALIASES: Record<CanonicalField, ReadonlySet<string>> = {
  national_id: new Set(
    [
      'תעודתזהות',
      'תז',
      'תעודה',
      'ת.ז.',
      'תזהות',
      'nationalid',
      'idnumber',
      'id',
      'nationalidnumber',
    ].map(normaliseHeader),
  ),
  phone: new Set(
    ['טלפון', 'נייד', 'phone', 'mobile', 'phonenumber', 'mobilephone', 'cell', 'cellular'].map(
      normaliseHeader,
    ),
  ),
  name: new Set(
    ['שם', 'שםמלא', 'בעלהדירה', 'בעלים', 'name', 'fullname', 'ownername', 'owner'].map(
      normaliseHeader,
    ),
  ),
  apartment_number: new Set(
    [
      'מספרדירה',
      'דירה',
      'apartment',
      'apt',
      'aptnumber',
      'apartmentnumber',
      'unit',
      'unitnumber',
    ].map(normaliseHeader),
  ),
  building_address: new Set(
    ['כתובת', 'address', 'בניין', 'building', 'buildingaddress', 'street', 'רחוב'].map(
      normaliseHeader,
    ),
  ),
  ownership_pct: new Set(
    [
      'אחוזבעלות',
      'אחוזים',
      'אחוז',
      'אחוזיבעלות',
      'ownership',
      'ownershippct',
      'percent',
      'percentage',
      'share',
      'shareofownership',
      '%',
    ].map(normaliseHeader),
  ),
};

/** Resolved mapping result. `columns[field]` is the 0-based index into
 *  the header array (and thus into each data row). Unmapped optional
 *  fields are absent from the record. */
export interface ColumnMapping {
  /** Column index per canonical field. Required fields are always
   *  present (otherwise resolveMapping throws). */
  columns: Partial<Record<CanonicalField, number>>;
  /** Headers that did not match any canonical alias. Useful for the
   *  preview wizard — the manager sees "we ignored: …" and decides. */
  unmapped: Array<{ index: number; header: string }>;
  /** Headers that matched multiple canonical fields — flagged for
   *  manual review. Empty in well-formed templates. */
  ambiguous: Array<{ index: number; header: string; candidates: CanonicalField[] }>;
}

export type MappingErrorCode =
  | 'mapping_incomplete' // required field had no header match
  | 'mapping_duplicate'; // same canonical mapped from two columns

export class MappingError extends Error {
  override readonly name = 'MappingError';
  constructor(
    message: string,
    public readonly code: MappingErrorCode,
    /** Which required fields were missing (`mapping_incomplete`) or
     *  which canonical was double-mapped (`mapping_duplicate`). */
    public readonly fields: CanonicalField[],
  ) {
    super(message);
  }
}

/** Resolve headers → canonical column map.
 *
 *  Algorithm:
 *    1. Normalise each header.
 *    2. For each header, find the set of canonical fields whose alias
 *       set contains the normalised string.
 *    3. Single-match → bind. Multi-match → push to `ambiguous`.
 *    4. After all headers processed, verify every REQUIRED canonical
 *       has a column. Missing ones → MappingError(`mapping_incomplete`).
 *    5. Verify no canonical was bound twice (two headers normalising
 *       to the same canonical). Duplicates → MappingError
 *       (`mapping_duplicate`).
 */
export function resolveMapping(headers: string[]): ColumnMapping {
  const columns: Partial<Record<CanonicalField, number>> = {};
  const unmapped: ColumnMapping['unmapped'] = [];
  const ambiguous: ColumnMapping['ambiguous'] = [];
  const duplicates: CanonicalField[] = [];

  for (let i = 0; i < headers.length; i += 1) {
    const raw = headers[i] ?? '';
    const norm = normaliseHeader(raw);
    if (!norm) {
      // Empty header column — count as unmapped but don't error; the
      // wizard surfaces it to the manager.
      unmapped.push({ index: i, header: raw });
      continue;
    }

    const matches: CanonicalField[] = [];
    for (const field of Object.keys(ALIASES) as CanonicalField[]) {
      if (ALIASES[field].has(norm)) matches.push(field);
    }

    if (matches.length === 0) {
      unmapped.push({ index: i, header: raw });
      continue;
    }
    if (matches.length > 1) {
      ambiguous.push({ index: i, header: raw, candidates: matches });
      continue;
    }

    const field = matches[0]!;
    if (columns[field] !== undefined) {
      duplicates.push(field);
      continue;
    }
    columns[field] = i;
  }

  if (duplicates.length > 0) {
    throw new MappingError(
      `duplicate column mapping for ${duplicates.join(', ')}`,
      'mapping_duplicate',
      dedupe(duplicates),
    );
  }

  const missing: CanonicalField[] = [];
  for (const f of REQUIRED_FIELDS) {
    if (columns[f] === undefined) missing.push(f);
  }
  if (missing.length > 0) {
    throw new MappingError(
      `required fields not found in header: ${missing.join(', ')}`,
      'mapping_incomplete',
      missing,
    );
  }

  return { columns, unmapped, ambiguous };
}

/** Normalise a header for matching:
 *   - NFC-normalise unicode (precomposed Hebrew + Latin)
 *   - lowercase (ASCII; Hebrew is unchanged)
 *   - strip ASCII punctuation, whitespace, control chars
 *
 *  Designed to be deterministic + idempotent. We strip whitespace
 *  ENTIRELY (not just trim) so "Phone Number" and "phonenumber" map
 *  the same way.
 *
 *  Why this is also the future fingerprint key: `normaliseHeader` is
 *  pure, deterministic, and side-effect-free — when persisted-template
 *  storage lands, fingerprint = sha256(headers.map(normaliseHeader)
 *  .sort().join('|')). */
export function normaliseHeader(s: string): string {
  // NFC handles "פ" + combining marks vs precomposed; defends against
  // homograph attacks where the same visual header maps differently.
  let out = s.normalize('NFC').toLowerCase();
  // Strip ASCII whitespace + ASCII punctuation. Hebrew letters
  // (U+0590..U+05FF) and ASCII alnum are kept. The '%' character is
  // semantically meaningful for ownership_pct so we keep it.
  out = out.replace(/[\s!"#$&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, '');
  return out;
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}
