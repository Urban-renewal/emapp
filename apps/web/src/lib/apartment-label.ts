/**
 * 7c F2 — apartment designation label, duplication-safe.
 *
 * Live multi-role smoke (V12 ledger, 2026-06-12) found "דירה דירה 7" on the
 * S5d drill-down and the tenant portal: imported/extracted data stores
 * `apartments.number` values that ALREADY carry the "דירה" word (e.g.
 * "דירה 7"), and the designation templates prepended another.
 *
 * `formatApartmentLabel` is the ONE place that decides whether to prepend:
 * if the (trimmed) number already starts with a known apartment word, it is
 * returned as-is; otherwise the requested prefix is prepended. Used by
 * `adapters/project.ts` (S5d drill-down) and `adapters/portal.ts` (tenant
 * portal line).
 *
 * Pure function — no React, no locale lookup (the caller picks the prefix
 * for its locale).
 */

/** Words that mean an explicit prefix is already present in the number. */
const KNOWN_PREFIXES = ['דירה', 'Apt', 'Apartment'] as const;

export function formatApartmentLabel(number: string, prefix: string = 'דירה'): string {
  const trimmed = number.trim();
  const alreadyPrefixed = KNOWN_PREFIXES.some((p) => trimmed === p || trimmed.startsWith(p + ' '));
  return alreadyPrefixed ? trimmed : `${prefix} ${trimmed}`;
}
