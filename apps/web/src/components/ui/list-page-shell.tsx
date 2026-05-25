'use client';

import type { ReactNode } from 'react';

import { Button } from './button';
import { ListSkeleton } from './list-skeleton';

/**
 * ListPageShell — the loading/error/empty/pagination chrome that
 * every dashboard list page wears, extracted.
 *
 * §SOLID-M4 closure — was duplicated across 7 list pages with subtle
 * variations (some had different empty-state copy, some skipped the
 * pagination buttons when cursor=undefined, etc.). One shell keeps the
 * pattern consistent and lets each page focus on the body.
 *
 * Props are intentionally minimal — the body is `children` so callers
 * keep full control of the row layout. The chrome handles:
 *  - <ListSkeleton> while loading (per §PERF-M4)
 *  - Error banner + retry button
 *  - Empty state message (when items count = 0)
 *  - Cursor-based pagination "Next" / "Reset to first" buttons
 *
 * Designed for Phase 4b reuse: Provider Admin cross-tenant lists will
 * share this exact chrome.
 */

export interface ListPageShellProps {
  /** Page state from a TanStack list query. */
  isLoading: boolean;
  isError: boolean;
  /** Item count (used for empty-state branch). Renders children when > 0. */
  itemCount: number;
  /** Cursor-pagination state from the query. */
  page?: { cursor: string | null; has_more: boolean };
  /** Current cursor in URL state (so we can render "back to first"). */
  cursor: string | undefined;

  /** Localized strings. */
  loadFailedLabel: string;
  emptyLabel: string;
  retryLabel: string;
  nextLabel: string;
  resetLabel: string;

  /** Handlers. */
  onRetry: () => void;
  onNext: (nextCursor: string) => void;
  onReset: () => void;

  /** Page body (the list itself). Rendered only when itemCount > 0. */
  children: ReactNode;
}

export function ListPageShell({
  isLoading,
  isError,
  itemCount,
  page,
  cursor,
  loadFailedLabel,
  emptyLabel,
  retryLabel,
  nextLabel,
  resetLabel,
  onRetry,
  onNext,
  onReset,
  children,
}: ListPageShellProps) {
  if (isLoading) {
    return <ListSkeleton rows={6} />;
  }
  if (isError) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{loadFailedLabel}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {retryLabel}
        </Button>
      </div>
    );
  }
  return (
    <>
      {itemCount === 0 ? <p className="text-sm text-muted-foreground">{emptyLabel}</p> : children}
      {page?.has_more && page.cursor && (
        <Button variant="outline" size="sm" onClick={() => onNext(page.cursor as string)}>
          {nextLabel}
        </Button>
      )}
      {cursor && (
        <Button variant="ghost" size="sm" onClick={onReset}>
          {resetLabel}
        </Button>
      )}
    </>
  );
}
