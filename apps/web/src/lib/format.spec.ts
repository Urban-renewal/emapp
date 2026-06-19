/**
 * P-TZ-1 — formatRelative pinned to Asia/Jerusalem civil days.
 *
 * The bug this slice closes: the old formatRelative computed its
 * day-level bucket as `Math.round((target - now) / 86_400_000)` — a raw
 * elapsed-millisecond diff. Near a midnight boundary, and especially on a
 * UTC-pinned runtime (CI), that mis-buckets "today" vs "yesterday" by a
 * whole day because it never projects the two instants onto Israel civil
 * calendar days first. CLAUDE.md hard rule: store UTC, DISPLAY Asia/Jerusalem.
 *
 * Test IDs:
 *   T-TZ-1.A   UTC-boundary regression — two instants on the SAME Israel
 *              civil day where the naive diff would say "yesterday".
 *   T-TZ-1.B   inverse boundary — instants that cross Israel midnight but
 *              the naive whole-day round would say "today".
 *   T-TZ-1.C   plain multi-day delta still works (sanity / no regression).
 *   T-TZ-1.D   Hebrew dual is emitted natively by Intl for -2 days.
 *   T-TZ-1.E   sub-day elapsed buckets (hours/minutes) unchanged.
 *   T-TZ-1.F   >30-day fallback renders the Israel-civil ISO date.
 *
 * Every test injects `now` (the 3rd param) so the assertions are
 * deterministic. The TZ-correctness claim is additionally proven under a
 * UTC process clock — see `format.utc-boundary.spec.ts`, which sets
 * `process.env.TZ = 'UTC'` and re-runs the boundary cases to mirror CI.
 */
import { describe, expect, it } from 'vitest';

import { formatRelative, formatJerusalem } from './format';

describe('formatRelative — Asia/Jerusalem civil-day pinning', () => {
  it('T-TZ-1.A) UTC-boundary: same Israel civil day → NOT "yesterday"', () => {
    // target 2026-06-15T21:00Z = 2026-06-16 00:00 Israel (UTC+3, DST)
    // now    2026-06-16T20:00Z = 2026-06-16 23:00 Israel
    // Both are 2026-06-16 in Israel → same civil day. The naive elapsed
    // round (-23h ≈ -1 day) would have said "אתמול"; the fix must not.
    const target = new Date('2026-06-15T21:00:00Z');
    const now = new Date('2026-06-16T20:00:00Z');
    const he = formatRelative(target, 'he', now);
    expect(he).not.toBe('אתמול');
    expect(he).toBe('לפני 23 שעות');
    expect(formatRelative(target, 'en', now)).toBe('23 hours ago');
  });

  it('T-TZ-1.B) inverse boundary: crosses Israel midnight → "yesterday"', () => {
    // target 2026-06-16T20:30Z = 2026-06-16 23:30 Israel
    // now    2026-06-16T21:30Z = 2026-06-17 00:30 Israel
    // Only ~1h elapsed (naive round → -0 days → "today"), but the two
    // instants land on DIFFERENT Israel civil days → must be "אתמול".
    const target = new Date('2026-06-16T20:30:00Z');
    const now = new Date('2026-06-16T21:30:00Z');
    expect(formatRelative(target, 'he', now)).toBe('אתמול');
    expect(formatRelative(target, 'en', now)).toBe('yesterday');
  });

  it('T-TZ-1.C) plain multi-day delta (no boundary edge)', () => {
    const target = new Date('2026-06-10T09:00:00Z');
    const now = new Date('2026-06-15T09:00:00Z');
    expect(formatRelative(target, 'en', now)).toBe('5 days ago');
  });

  it('T-TZ-1.D) Hebrew dual: -2 Israel civil days renders the named dual form', () => {
    // 2 days ago in Hebrew is "שלשום" (the named dual) under numeric:auto —
    // Intl emits the dual category natively; we just feed it the correct
    // Israel-civil day count.
    const target = new Date('2026-06-13T09:00:00Z');
    const now = new Date('2026-06-15T09:00:00Z');
    expect(formatRelative(target, 'he', now)).toBe('שלשום');
  });

  it('T-TZ-1.E) sub-day elapsed buckets unchanged (hours / minutes)', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    expect(formatRelative(new Date('2026-06-15T09:00:00Z'), 'en', now)).toBe('3 hours ago');
    expect(formatRelative(new Date('2026-06-15T11:30:00Z'), 'en', now)).toBe('30 minutes ago');
  });

  it('T-TZ-1.F) >30-day fallback → Israel-civil ISO date', () => {
    const target = new Date('2026-01-01T22:30:00Z'); // 2026-01-02 00:30 Israel (UTC+2 winter)
    const now = new Date('2026-06-15T09:00:00Z');
    // Fallback must reflect the ISRAEL civil date, not the UTC date.
    expect(formatRelative(target, 'he', now)).toBe('2026-01-02');
  });
});

describe('formatJerusalem — absolute timestamp pinned to Israel', () => {
  it('renders the Israel wall-clock day, not the UTC day, near midnight', () => {
    // 2026-06-15T22:00Z = 2026-06-16 01:00 Israel.
    const at = new Date('2026-06-15T22:00:00Z');
    const out = formatJerusalem(at, 'en');
    expect(out).toContain('16/06/2026');
    expect(out).toContain('01:00');
  });
});
