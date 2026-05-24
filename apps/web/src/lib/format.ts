/**
 * Locale-specific format helpers — used by adapters to produce display
 * strings (the ViewModel layer per docs/05 §9.8). Pure functions; no
 * hooks, no I/O. Hebrew-first by default, with English fallback when
 * called from an EN-locale route.
 */

const HE_RTF = new Intl.RelativeTimeFormat('he', { numeric: 'auto' });
const EN_RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/**
 * "לפני שלושה ימים" / "3 days ago" — for createdAt / updatedAt-style
 * fields. Falls back to the absolute ISO date when the delta is over
 * 30 days (relative gets confusing past a month).
 */
export function formatRelative(at: Date | string, locale: 'he' | 'en' = 'he'): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  const now = Date.now();
  const deltaMs = d.getTime() - now;
  const deltaDays = Math.round(deltaMs / 86_400_000);
  const rtf = locale === 'he' ? HE_RTF : EN_RTF;
  if (Math.abs(deltaDays) >= 30) {
    return d.toISOString().slice(0, 10);
  }
  if (Math.abs(deltaDays) >= 1) return rtf.format(deltaDays, 'day');
  const deltaHours = Math.round(deltaMs / 3_600_000);
  if (Math.abs(deltaHours) >= 1) return rtf.format(deltaHours, 'hour');
  const deltaMinutes = Math.round(deltaMs / 60_000);
  return rtf.format(deltaMinutes, 'minute');
}
