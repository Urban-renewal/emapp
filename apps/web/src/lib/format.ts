/**
 * Locale-specific format helpers — used by adapters to produce display
 * strings (the ViewModel layer per docs/05 §9.8). Pure functions; no
 * hooks, no I/O. Hebrew-first by default, with English fallback when
 * called from an EN-locale route.
 */

const HE_RTF = new Intl.RelativeTimeFormat('he', { numeric: 'auto' });
const EN_RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/**
 * The display timezone for every relative/absolute civil-date computation
 * in this module. CLAUDE.md hard rule: "store UTC, display Asia/Jerusalem".
 */
const DISPLAY_TZ = 'Asia/Jerusalem';

/**
 * Stable Y-M-D extractor pinned to Asia/Jerusalem civil time. `en-CA`
 * yields ISO-ordered `YYYY-MM-DD` parts regardless of the viewer locale,
 * so the numeric civil-day arithmetic below never depends on the JS
 * runtime's timezone. This is the linchpin of the TZ-correctness fix:
 * both `now` and the target are projected into Israel civil time BEFORE
 * the calendar-day difference is taken.
 */
const CIVIL_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: DISPLAY_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Project an instant onto its Asia/Jerusalem *civil* calendar day and
 * return that day as a UTC midnight epoch-millis. Two instants that fall
 * on the same Israel calendar day map to the same value; the difference
 * between two such values, divided by one day, is the exact integer
 * calendar-day delta in Israel time — immune to the runtime TZ and to
 * DST offset changes (we anchor each civil day at UTC midnight, so the
 * subtraction is pure whole-day arithmetic with no offset leakage).
 */
function civilDayUtcMs(at: Date): number {
  // en-CA → "YYYY-MM-DD". Parse the three numeric parts back out.
  const [y, m, d] = CIVIL_DATE_FMT.format(at).split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

/**
 * "לפני שלושה ימים" / "3 days ago" — for createdAt / updatedAt-style
 * fields. Falls back to the absolute ISO date when the delta is over
 * 30 days (relative gets confusing past a month).
 *
 * TZ correctness (P-TZ-1): the day-level bucket compares Asia/Jerusalem
 * *civil* calendar days for BOTH `now` and the target, so "אתמול /
 * yesterday" vs "היום / today" is decided by Israel wall-clock dates —
 * not by the JS runtime timezone. A timestamp at 22:30 UTC is already
 * "tomorrow" in Israel (UTC+2/+3); the naive `(t - now) / 86_400_000`
 * round used previously would mis-bucket such instants near midnight,
 * and was off by a whole day on a UTC runtime (e.g. CI).
 *
 * Sub-day buckets (hours / minutes) intentionally use the raw elapsed
 * instant delta: "לפני שעתיים" is elapsed-time, not a civil-calendar
 * notion, so it has no TZ-boundary ambiguity.
 *
 * @param now injectable clock for deterministic tests; defaults to the
 *   real wall clock. Always an absolute instant — it too is projected to
 *   Israel civil time before the day diff.
 */
export function formatRelative(
  at: Date | string,
  locale: 'he' | 'en' = 'he',
  now: Date = new Date(),
): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  const rtf = locale === 'he' ? HE_RTF : EN_RTF;

  // Day-level delta: Asia/Jerusalem civil calendar days, both sides.
  const civilDeltaDays = Math.round((civilDayUtcMs(d) - civilDayUtcMs(now)) / 86_400_000);

  if (Math.abs(civilDeltaDays) >= 30) {
    // Absolute fallback is also rendered in Israel civil time so the ISO
    // date matches the day the relative buckets reasoned about.
    return CIVIL_DATE_FMT.format(d);
  }
  if (Math.abs(civilDeltaDays) >= 1) return rtf.format(civilDeltaDays, 'day');

  // Same Israel calendar day → fall through to elapsed sub-day buckets.
  const deltaMs = d.getTime() - now.getTime();
  const deltaHours = Math.round(deltaMs / 3_600_000);
  if (Math.abs(deltaHours) >= 1) return rtf.format(deltaHours, 'hour');
  const deltaMinutes = Math.round(deltaMs / 60_000);
  return rtf.format(deltaMinutes, 'minute');
}

/**
 * Absolute date+time rendered in the Asia/Jerusalem timezone (per the
 * hard rule "store UTC, display Asia/Jerusalem"). Used where an exact
 * audited timestamp matters more than a relative "3 days ago" — e.g. the
 * provider self-audit log, where the operator needs the precise wall-clock
 * time of each access. Locale picks the digit/format conventions; the
 * timezone is pinned regardless of the viewer's browser tz.
 */
export function formatJerusalem(at: Date | string, locale: 'he' | 'en' = 'he'): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  return d.toLocaleString(locale === 'he' ? 'he-IL' : 'en-GB', {
    timeZone: DISPLAY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
