/**
 * ListSkeleton — shimmer rows for list-page loading states.
 *
 * §PERF-M4 closure — list pages used to render plain `<p>טוען...</p>`
 * during the in-flight fetch. The shimmer skeleton gives the user
 * immediate structural feedback (perceived latency drops noticeably on
 * cold cache + cold-DB requests). Real cost is one extra render but
 * the shimmer is `animate-pulse` (CSS only — no JS animation loop).
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
      <div className="h-7 w-48 animate-pulse rounded-md bg-muted" />
      {withRows && (
        <ul className="space-y-2">
          {Array.from({ length: rows }, (_, i) => (
            <li key={i} className="flex items-center gap-3 rounded-md border bg-card p-4">
              <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
              <div className="h-4 w-16 animate-pulse rounded bg-muted" />
              <div className="ms-auto h-4 w-20 animate-pulse rounded bg-muted" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
