/**
 * `navBadgeLabel` — the sidebar ambient count pill's display rule (the React
 * `<NavBadge>` shell is a thin wrapper; its rendering + the group auto-expand are
 * verified by the per-slice browser smoke, the web-spec convention being
 * pure-logic `.spec.ts` only — no jsdom/RTL here).
 *
 * Locks the three acceptance properties: hidden at 0 (calm), the true total up to
 * the cap, and the "99+" display ceiling.
 */
import { describe, expect, it } from 'vitest';

import { NAV_BADGE_DISPLAY_CAP, navBadgeLabel } from './nav-badge.helpers';

describe('navBadgeLabel — sidebar ambient count pill', () => {
  it('hides (null) at 0 — no calm-breaking "0" badge', () => {
    expect(navBadgeLabel(0)).toBeNull();
  });

  it('hides (null) for negative / non-finite (fail-safe on a bad wire value)', () => {
    expect(navBadgeLabel(-1)).toBeNull();
    expect(navBadgeLabel(Number.NaN)).toBeNull();
    expect(navBadgeLabel(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('shows the exact count for 1..cap', () => {
    expect(navBadgeLabel(1)).toBe('1');
    expect(navBadgeLabel(3)).toBe('3');
    expect(navBadgeLabel(42)).toBe('42');
    expect(navBadgeLabel(NAV_BADGE_DISPLAY_CAP)).toBe(String(NAV_BADGE_DISPLAY_CAP));
  });

  it('applies the "99+" ceiling above the cap (display cap, not a magnitude lie)', () => {
    expect(navBadgeLabel(NAV_BADGE_DISPLAY_CAP + 1)).toBe(`${NAV_BADGE_DISPLAY_CAP}+`);
    expect(navBadgeLabel(1000)).toBe(`${NAV_BADGE_DISPLAY_CAP}+`);
  });

  it('caps at the SAME threshold the topbar bell uses (no nav/bell drift)', () => {
    // notifications-bell.tsx BADGE_DISPLAY_CAP === 99; keep them aligned.
    expect(NAV_BADGE_DISPLAY_CAP).toBe(99);
  });
});
