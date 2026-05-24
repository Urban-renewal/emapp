/**
 * Per-row validation — Phase 6 S5.
 *
 * Closes T6.3 (Israeli ID Luhn) + T6.4 (in-file dedup detection).
 * Dry-run gate (T6.5) is handled at the HANDLER level (persistStage
 * early-exits when import_jobs.dry_run = true); the validator itself
 * is dry-run agnostic — it always validates, never persists.
 *
 * Pure function: takes a row + a row-number + a mutable dedup-set;
 * returns a list of structured errors (empty = row OK). NO DB, no
 * stream, no logging. Easy to test in isolation.
 *
 * Security:
 *  - PII (national_id, phone) is read from the row but NEVER logged.
 *    The validator only emits structural error codes ('invalid_luhn',
 *    'invalid_phone', 'empty_required') — never the raw value.
 *  - The dedup HASH is HMAC-equivalent at this layer: we use the
 *    normalised national_id string in a Set, which lives only for
 *    the duration of one import. No persistence; nothing leaks.
 */
import { isValidIsraeliId, normalizeIsraeliPhone } from '@emapp/validators';

import type { CanonicalField, ColumnMapping } from '../mapping/mapping';

/** Per-row validation result. ok=true iff `errors` is empty. */
export interface RowValidation {
  ok: boolean;
  errors: RowError[];
}

/** Structured per-row error. Maps 1:1 to a row in import_job_errors
 *  (no PII, no raw row data — just locator + classifier). */
export interface RowError {
  /** 1-indexed Excel row number (1 = header, 2 = first data row).
   *  Matches what the manager sees in their spreadsheet. */
  rowNumber: number;
  /** Which canonical field the error pertains to. `null` when the
   *  failure spans multiple cells (e.g. row-level uniqueness). */
  field: CanonicalField | null;
  /** Discriminator code — stable, machine-readable. */
  code: RowErrorCode;
  /** Hebrew message (UI-bound). Deliberately NOT a template literal
   *  embedding the row value — we keep PII out of audit_log surface. */
  message: string;
}

export type RowErrorCode =
  | 'invalid_luhn' // T6.3 — Israeli ID mod-10 fails
  | 'invalid_phone' // phone fails normalizeIsraeliPhone (Israeli E.164)
  | 'empty_required' // a required canonical's cell is blank
  | 'duplicate_national_id' // T6.4 — same id appeared earlier in THIS import
  | 'invalid_ownership_pct'; // ownership_pct not a number 0..100

/** Bounded length for the name field. Prevents a row from carrying a
 *  multi-MB string into pgcrypto-encrypt (memory + per-encrypt cost). */
const NAME_MAX_LEN = 200;

/** Validate one row against the resolved mapping.
 *
 *  @param row           Cell values from ExcelJS row (string[]), 0-indexed.
 *  @param rowNumber     1-indexed source row in the Excel file.
 *  @param mapping       Resolved canonical → column index (from S4).
 *  @param seenIds       MUTABLE set of normalised national_ids seen so
 *                       far IN THIS IMPORT. T6.4 dedup state. The
 *                       caller owns the set + decides reset semantics
 *                       (per-job — we never carry across jobs).
 *  @returns             RowValidation; mutates seenIds if id is new+valid. */
export function validateRow(
  row: string[],
  rowNumber: number,
  mapping: ColumnMapping,
  seenIds: Set<string>,
): RowValidation {
  const errors: RowError[] = [];

  // national_id — required, Luhn, dedup. We validate Luhn FIRST so a
  // malformed id is reported as 'invalid_luhn' rather than getting a
  // double-up flag from a malformed string being "deduped" against
  // another malformed string.
  const idCol = mapping.columns.national_id;
  if (idCol === undefined) {
    // Defensive — resolveMapping must have failed before reaching here.
    errors.push({
      rowNumber,
      field: 'national_id',
      code: 'empty_required',
      message: 'תעודת זהות חסרה',
    });
  } else {
    const idRaw = (row[idCol] ?? '').trim();
    if (idRaw === '') {
      errors.push({
        rowNumber,
        field: 'national_id',
        code: 'empty_required',
        message: 'תעודת זהות חסרה',
      });
    } else if (!isValidIsraeliId(idRaw)) {
      errors.push({
        rowNumber,
        field: 'national_id',
        code: 'invalid_luhn',
        message: 'תעודת זהות לא תקינה (בדיקת ספרת ביקורת)',
      });
    } else {
      // Normalise: pad to 9 digits so '12345678X' and '012345678X'
      // dedupe identically.
      const norm = idRaw.padStart(9, '0');
      if (seenIds.has(norm)) {
        errors.push({
          rowNumber,
          field: 'national_id',
          code: 'duplicate_national_id',
          message: 'תעודת זהות מופיעה כפילה בקובץ',
        });
      } else {
        seenIds.add(norm);
      }
    }
  }

  // phone — required, Israeli E.164.
  const phoneCol = mapping.columns.phone;
  if (phoneCol === undefined) {
    errors.push({ rowNumber, field: 'phone', code: 'empty_required', message: 'טלפון חסר' });
  } else {
    const phoneRaw = (row[phoneCol] ?? '').trim();
    if (phoneRaw === '') {
      errors.push({ rowNumber, field: 'phone', code: 'empty_required', message: 'טלפון חסר' });
    } else if (normalizeIsraeliPhone(phoneRaw) === null) {
      errors.push({
        rowNumber,
        field: 'phone',
        code: 'invalid_phone',
        message: 'טלפון לא תקין (פורמט ישראלי E.164)',
      });
    }
  }

  // name — required, bounded length.
  const nameCol = mapping.columns.name;
  if (nameCol === undefined) {
    errors.push({ rowNumber, field: 'name', code: 'empty_required', message: 'שם חסר' });
  } else {
    const nameRaw = (row[nameCol] ?? '').trim();
    if (nameRaw === '' || nameRaw.length > NAME_MAX_LEN) {
      errors.push({
        rowNumber,
        field: 'name',
        code: 'empty_required',
        message: 'שם חסר או ארוך מדי',
      });
    }
  }

  // apartment_number + building_address — required, non-empty.
  for (const f of ['apartment_number', 'building_address'] as const) {
    const c = mapping.columns[f];
    if (c === undefined) {
      errors.push({ rowNumber, field: f, code: 'empty_required', message: requiredMessage(f) });
      continue;
    }
    const v = (row[c] ?? '').trim();
    if (v === '') {
      errors.push({ rowNumber, field: f, code: 'empty_required', message: requiredMessage(f) });
    }
  }

  // ownership_pct — optional, but if present must parse as 0..100.
  const pctCol = mapping.columns.ownership_pct;
  if (pctCol !== undefined) {
    const raw = (row[pctCol] ?? '').trim();
    if (raw !== '') {
      const parsed = Number(raw.replace('%', ''));
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        errors.push({
          rowNumber,
          field: 'ownership_pct',
          code: 'invalid_ownership_pct',
          message: 'אחוז בעלות חייב להיות מספר בין 0 ל-100',
        });
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function requiredMessage(field: CanonicalField): string {
  switch (field) {
    case 'apartment_number':
      return 'מספר דירה חסר';
    case 'building_address':
      return 'כתובת בניין חסרה';
    default:
      return `${field} חסר`;
  }
}
