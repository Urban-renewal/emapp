'use client';

import type { ReactNode } from 'react';

import { ApiClientError } from '@/lib/api/errors';

import { Button } from './button';
import { ListSkeleton } from './list-skeleton';

/**
 * The D.16 envelope `error.code` the BE's AuthorizationGuard emits on a
 * permission denial (`apps/api/src/common/authz/authorization.guard.ts`
 * + `agent-capabilities.ts` → `{ error: { code: 'forbidden' } }`). A
 * scoped list a caller may not read fails with THIS code. We branch on
 * the code — the single source of truth shared with the BE — never on
 * the (localized, mutable) message string.
 */
const FORBIDDEN_CODE = 'forbidden';

/**
 * Is this query error a permission denial (HTTP 403, `code:'forbidden'`)?
 *
 * Terminal: a retry won't change the actor's permissions, so the shell
 * renders an access-denied empty-state with NO retry affordance. The
 * global TanStack `retry` predicate (query-provider.tsx) already skips
 * any `ApiClientError`, so a 403 never auto-retries either.
 */
export function isPermissionDenied(error: unknown): boolean {
  return error instanceof ApiClientError && error.code === FORBIDDEN_CODE;
}

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
  /**
   * The raw query error (TanStack `query.error`). The shell inspects it
   * to distinguish a permission denial (403 `code:'forbidden'` → terminal
   * access-denied state, no retry) from a network / 5xx failure (the
   * existing retryable banner). Optional: when omitted, every error
   * falls through to the retryable banner (back-compat).
   */
  error?: unknown;
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
  /**
   * Copy for the permission-denied state (403). Optional: when omitted
   * the shell falls back to `loadFailedLabel` (still no retry button for
   * a 403). Callers pass the shared `projects.accessDenied*` strings.
   */
  accessDeniedTitle?: string;
  accessDeniedBody?: string;

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
  error,
  itemCount,
  page,
  cursor,
  loadFailedLabel,
  emptyLabel,
  retryLabel,
  nextLabel,
  resetLabel,
  accessDeniedTitle,
  accessDeniedBody,
  onRetry,
  onNext,
  onReset,
  children,
}: ListPageShellProps) {
  if (isLoading) {
    return <ListSkeleton rows={6} />;
  }
  if (isError) {
    // §P4-#13 — a 403 permission denial is TERMINAL: the actor lacks the
    // read permission for this scope and a retry won't change that, so
    // render a distinct access-denied state with NO retry button (and no
    // auto-retry — the global query `retry` predicate already skips any
    // ApiClientError). Everything else (network / 5xx / parse) keeps the
    // retryable banner.
    if (isPermissionDenied(error)) {
      return (
        <div className="space-y-1" role="status">
          <p className="text-sm font-medium text-foreground">
            {accessDeniedTitle ?? loadFailedLabel}
          </p>
          {accessDeniedBody && <p className="text-sm text-muted-foreground">{accessDeniedBody}</p>}
        </div>
      );
    }
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
