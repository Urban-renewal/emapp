/**
 * 7c F2 — apartment designation label, duplication-safe.
 * FL-9   — building/floor qualifier (disambiguate same-number apartments).
 *
 * Live multi-role smoke (V12 ledger, 2026-06-12) found "דירה דירה 7" on the
 * S5d drill-down and the tenant portal: imported/extracted data stores
 * `apartments.number` values that ALREADY carry the "דירה" word (e.g.
 * "דירה 7"), and the designation templates prepended another.
 *
 * Live QA (V13) then found the opposite problem: when a project spans several
 * buildings/floors the same `number` repeats ("דירה 1" twice, different
 * building/floor), so a bare "דירה {number}" is AMBIGUOUS. FL-9 lets callers
 * pass the floor (and, when a project spans multiple buildings, the building)
 * they already have so the label disambiguates — calm and Hebrew-RTL-correct,
 * appended with " · " only when a qualifier is actually present.
 *
 * `formatApartmentLabel` is the ONE place that decides:
 *   1. whether to prepend the apartment word — if the (trimmed) number already
 *      starts with a known apartment word it is returned as-is (the 7c F2
 *      "דירה דירה 7" guard); otherwise the requested prefix is prepended;
 *   2. which disambiguating qualifiers to append (floor, then building),
 *      each only when the caller actually supplies it.
 *
 * The number segment stays unchanged when no context is passed, so every
 * existing call site (and its pinned label) is byte-for-byte unaffected.
 *
 * Used by `adapters/project.ts` (S5d drill-down + BM-1 leverage card),
 * `adapters/portal.ts` (tenant portal line) and the apartment list/detail
 * pages.
 *
 * Pure function — no React, no locale lookup. The caller picks the prefix AND
 * the qualifier words for its locale (Hebrew default; English passes
 * `prefix: 'Apt'` + `{ floorWord: 'Floor' }`).
 */
import { stripBidiOverrides } from './bidi';

/** Words that mean an explicit prefix is already present in the number. */
const KNOWN_PREFIXES = ['דירה', 'Apt', 'Apartment'] as const;

/** Separator between the number segment and each qualifier ("דירה 4 · קומה 2"). */
const SEP = ' · ';

export interface ApartmentLabelContext {
  /**
   * Apartment floor. Appended as "{floorWord} {floor}" when present. `null` /
   * `undefined` (storage units, unknown) → no floor segment. `0` is a valid
   * floor (קומת קרקע) and IS rendered.
   */
  floor?: number | null;
  /**
   * Building designation (name or number). Appended as its own segment when
   * present + non-blank — the caller passes it ONLY when the project spans
   * multiple buildings (so a single-building project stays uncluttered). Most
   * call sites have no building context on the wire and simply omit it.
   *
   * Safe-by-default: the building is a potential free-text (user/import-authored)
   * NAME, so it is bidi-stripped INSIDE the util (§v9-H-3 RTL-spoof defense) — a
   * caller cannot accidentally route an embedded U+202E/U+2067 mark through. The
   * floor/number segments need no strip (floor is a validated integer; the
   * number is already stripped by adapters that handle imported data).
   */
  building?: string | null;
  /** Hebrew "קומה" by default; English callers pass "Floor". */
  floorWord?: string;
}

export function formatApartmentLabel(
  number: string,
  prefix: string = 'דירה',
  context: ApartmentLabelContext = {},
): string {
  const trimmed = number.trim();
  const alreadyPrefixed = KNOWN_PREFIXES.some((p) => trimmed === p || trimmed.startsWith(p + ' '));
  const base = alreadyPrefixed ? trimmed : `${prefix} ${trimmed}`;

  const { floor, building, floorWord = 'קומה' } = context;
  const segments: string[] = [base];
  if (floor !== null && floor !== undefined) {
    segments.push(`${floorWord} ${floor}`);
  }
  const buildingSeg = building ? stripBidiOverrides(building).trim() : '';
  if (buildingSeg) {
    segments.push(buildingSeg);
  }
  return segments.join(SEP);
}
