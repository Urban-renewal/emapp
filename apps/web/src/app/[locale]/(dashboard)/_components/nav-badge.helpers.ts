/**
 * Pure display logic for the sidebar ambient count pill (`<NavBadge>`) — a PLAIN
 * module (NO `'use client'`, no React) so the decision can be unit-tested in the
 * node vitest env (the web specs are `.spec.ts` / pure-logic only; there is no
 * jsdom + `@testing-library/react` here — see export-xlsx-button.spec.ts). The
 * `<NavBadge>` component is a thin render shell over this one function, so the
 * "hidden at 0 / true total / 99+ ceiling" rule has ONE source of truth (it also
 * matches the topbar bell's BADGE_DISPLAY_CAP, so nav + bell never disagree).
 */

/** Visual display ceiling — a render cap, never a lie that more don't exist.
 *  Matches the bell's cap (notifications-bell.tsx) so both say "99+" at the same
 *  threshold. */
export const NAV_BADGE_DISPLAY_CAP = 99;

/**
 * The pill's visible text, or `null` when no pill should render.
 *   - `null` for 0 / negative / non-finite (calm: no "0" badge, fail-safe on a
 *     bad wire value).
 *   - the exact count up to the cap.
 *   - `"99+"` above the cap (a display ceiling; the real total still drives the
 *     aria-label + any logic).
 */
export function navBadgeLabel(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  if (count > NAV_BADGE_DISPLAY_CAP) return `${NAV_BADGE_DISPLAY_CAP}+`;
  return String(count);
}
