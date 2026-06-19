'use client';

import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

import { Button } from './button';
import { isPermissionDenied } from './list-page-shell';
import { ListSkeleton } from './list-skeleton';
import { Skeleton } from './skeleton';

/**
 * DataState — the ONE reusable wrapper that gives every data-driven surface a
 * CALM, consistent treatment of the four non-happy states (E2 Wave-0 C2,
 * v5 primitive #5 "Failure-Grace"). It replaces ad-hoc / `return null`
 * handling so a surface NEVER silently blanks.
 *
 * This FORMALIZES the shape `ListPageShell` already established (loading →
 * skeleton, error → calm retry, 403 → muted access-denied, empty → guided)
 * rather than forking a competing one. The 403 branch reuses the SAME
 * `isPermissionDenied` predicate (the BE's `code:'forbidden'`, D.16 envelope)
 * — a 403 is access-denied, NOT a load error (D.31 / members-audit precedent),
 * and a retry won't change the actor's permissions so it gets NO retry button.
 *
 * Render precedence (first match wins):
 *   forbidden → error → loading → empty → children
 *
 * `isForbidden` is an explicit override; when omitted we derive it from
 * `error` via `isPermissionDenied` so a TanStack 403 is treated as
 * access-denied even if the caller only passed `isError` + `error`.
 *
 * Token-only styling (no default-palette classes, no inline color). All copy
 * via next-intl `dataState.*` with caller-supplied empty-state copy. RTL-first
 * (logical props: `ms-*`, `text-start`).
 */
export interface DataStateProps {
  /** Query is in-flight (first load). Renders the skeleton. */
  isLoading: boolean;
  /** Query errored. Renders the calm retry treatment (unless forbidden). */
  isError?: boolean;
  /** Raw query error — inspected to distinguish a 403 (access-denied,
   *  terminal, no retry) from a network / 5xx failure (retryable). */
  error?: unknown;
  /** Explicit access-denied override. When omitted, derived from `error`
   *  via `isPermissionDenied`. */
  isForbidden?: boolean;
  /** Loaded successfully but there's nothing to show. Renders the guided
   *  empty state. */
  isEmpty?: boolean;
  /** Retry handler for the error state (e.g. `() => query.refetch()`).
   *  Omit it to render the error message with no retry affordance. */
  onRetry?: () => void;

  /** Skeleton to render while loading. Defaults to a simple block skeleton;
   *  pass `<ListSkeleton />` for list surfaces, or `'list'` for the same. */
  skeleton?: ReactNode | 'list' | 'block';

  /** Guided empty state. Title is required; hint + action are optional. */
  emptyTitle: string;
  emptyHint?: string;
  /** Primary next action for the empty state (a button / link node). */
  emptyAction?: ReactNode;

  /** Body — rendered only when not forbidden / errored / loading / empty.
   *  Optional so a surface can use DataState purely for its non-happy
   *  treatment, but in practice this is the content the wrapper guards. */
  children?: ReactNode;
}

export function DataState({
  isLoading,
  isError = false,
  error,
  isForbidden,
  isEmpty = false,
  onRetry,
  skeleton = 'block',
  emptyTitle,
  emptyHint,
  emptyAction,
  children,
}: DataStateProps) {
  const t = useTranslations('dataState');

  // 1) forbidden — explicit prop OR a 403 derived from the error. Terminal:
  //    a retry won't grant access, so this is a muted access-denied panel
  //    with NO retry button — distinct from the error treatment below.
  const forbidden = isForbidden ?? (isError && isPermissionDenied(error));
  if (forbidden) {
    return (
      <div className="space-y-1 text-start" role="status">
        <p className="text-sm font-medium text-foreground">{t('forbiddenTitle')}</p>
        <p className="text-sm text-muted">{t('forbiddenBody')}</p>
      </div>
    );
  }

  // 2) error — calm, non-alarming message + a retry action. NOT a red dump.
  if (isError) {
    return (
      <div className="space-y-2 text-start" role="status">
        <p className="text-sm font-medium text-foreground">{t('errorTitle')}</p>
        <p className="text-sm text-muted">{t('errorBody')}</p>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            {t('retry')}
          </Button>
        )}
      </div>
    );
  }

  // 3) loading — skeleton. `'list'` → ListSkeleton; `'block'` (default) → a
  //    simple block; or a caller-supplied node for full control.
  if (isLoading) {
    if (skeleton === 'list') return <ListSkeleton />;
    if (skeleton === 'block') {
      return (
        <div aria-busy="true" aria-live="polite" className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-20 w-full" />
        </div>
      );
    }
    return <>{skeleton}</>;
  }

  // 4) empty — a GUIDED empty state (short line + the primary next action),
  //    never a blank screen.
  if (isEmpty) {
    return (
      <div
        className="flex flex-col items-center gap-2 px-4 py-12 text-center"
        role="status"
        aria-live="polite"
      >
        <p className="text-sm font-medium text-foreground">{emptyTitle}</p>
        {emptyHint && <p className="text-sm text-muted">{emptyHint}</p>}
        {emptyAction && <div className="mt-2">{emptyAction}</div>}
      </div>
    );
  }

  // 5) happy path.
  return <>{children}</>;
}
