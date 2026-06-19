import { Skeleton } from './skeleton';

/**
 * ListSkeleton — shimmer rows for list-page loading states.
 *
 * §PERF-M4 closure — list pages used to render plain `<p>טוען...</p>`
 * during the in-flight fetch. The shimmer skeleton gives the user
 * immediate structural feedback (perceived latency drops noticeably on
 * cold cache + cold-DB requests). Real cost is one extra render but
 * the shimmer is CSS-only (no JS animation loop).
 *
 * E2 Wave-0 C2 — re-homed onto the token-driven `<Skeleton>` primitive
 * (`.skeleton` in globals.css). The shimmer duration is the
 * `--motion-duration-slow` token, so `prefers-reduced-motion` zeroes it
 * for free (no per-component media query).
 *
 * Usage:
 *   if (isLoading) return <ListSkeleton rows={6} />;
 */
export interface ListSkeletonProps {
  /** Number of placeholder rows. Default 6 — matches the average
   *  above-the-fold count on the dashboard's list pages. */
  rows?: number;
  /** When false, render shimmer only on the title row (no body rows).
   *  Useful for detail pages. */
  withRows?: boolean;
}

export function ListSkeleton({ rows = 6, withRows = true }: ListSkeletonProps) {
  return (
    <div aria-busy="true" aria-live="polite" className="space-y-3">
      <Skeleton className="h-7 w-48" />
      {withRows && (
        <ul className="space-y-2">
          {Array.from({ length: rows }, (_, i) => (
            <li key={i} className="flex items-center gap-3 rounded-md border bg-card p-4">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="ms-auto h-4 w-20" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
