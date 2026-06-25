'use client';

import { useProposalsPendingCount } from '@/hooks/use-proposals';

import { navBadgeLabel } from './nav-badge.helpers';

/**
 * Sidebar ambient unread/pending count pill — the at-a-glance "this needs you"
 * signal on a nav row (Approval Inbox pending · Notifications unread · Messages
 * unread). A thin render shell over `navBadgeLabel` (nav-badge.helpers.ts), which
 * mirrors the topbar bell's display rule EXACTLY (one source of truth for the cap
 * + the "hidden at 0" rule — see notifications-bell.tsx BADGE_DISPLAY_CAP), so
 * the nav signal and the surface's own badge never drift.
 *
 * Calm by design: renders NOTHING at 0 (no "0" badge to add noise), shows the
 * TRUE total up to the cap, and "99+" above it (a display ceiling, NOT a lie
 * about magnitude — the value behind it is the real constant-time count from the
 * indexed endpoint the surface itself reads).
 *
 * Token colors only (danger-600 reads as the urgent dot on the navy sidebar);
 * no inline hex, no `text-muted` trap.
 */

interface NavBadgeProps {
  /** The TRUE constant-time total from the surface's own count hook. */
  count: number;
  /**
   * Accessible label describing WHAT the count means for screen readers, e.g.
   * "3 החלטות ממתינות". The visible pill shows only the number; the label
   * carries the meaning so the badge isn't a bare, context-free digit to AT.
   */
  ariaLabel: string;
}

export function NavBadge({ count, ariaLabel }: NavBadgeProps) {
  // Calm: no badge at 0 (and defensively for any negative/NaN) — `navBadgeLabel`
  // returns null in that case (the single source of truth for the display rule).
  const label = navBadgeLabel(count);
  if (label === null) return null;
  return (
    <span
      // The row already carries the label text; the pill adds the count meaning.
      role="status"
      aria-label={ariaLabel}
      className="ms-auto inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[10px] font-bold leading-none text-white"
      style={{ background: 'var(--danger-600)' }}
    >
      {label}
    </span>
  );
}

/**
 * The Approval-Inbox pending-decisions badge. Reads the manager-only constant-
 * time `GET /proposals/pending-count` (the SAME `useProposalsPendingCount` the
 * inbox surface reads — single source of truth). Kept as its OWN component so the
 * requireManager-gated request fires ONLY where this is mounted: the manager's
 * inbox nav row. Non-manager roles never render this, so they never hit the
 * 403-on-non-manager endpoint (which would otherwise trip the console guardrail).
 */
export function InboxNavBadge({ ariaLabel }: { ariaLabel: (count: number) => string }) {
  const { data } = useProposalsPendingCount();
  const count = data?.count ?? 0;
  return <NavBadge count={count} ariaLabel={ariaLabel(count)} />;
}
