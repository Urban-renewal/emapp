'use client';

import { ProviderAuditQuerySchema, type ProviderAuditQuery } from '@emapp/shared-types';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ListPageShell } from '@/components/ui/list-page-shell';
import { useProviderAudit } from '@/hooks/use-provider';

/**
 * Provider Admin — cross-tenant audit search (D.37 + Audit v1.1 SA-4).
 *
 * SA-4 enforces: at least one of (a) `orgId` set, OR (b) `fromDate`
 * set with span ≤ 31 days. The FE form pre-fills the past 7 days as
 * a sensible default — narrow enough to be cheap, wide enough to be
 * useful. The Zod parse (`ProviderAuditQuerySchema`) runs in
 * `lib/api/provider.ts:searchAudit` before the wire call; any client-
 * built query that violates SA-4 throws synchronously, which we catch
 * and surface as a localized form error.
 *
 * The URL search params support a single deep-link: `?orgId=<uuid>`
 * (used by the tenant detail page's "View audit" button). Other
 * filters stay in component state — the URL doesn't carry filter
 * combinations to keep the auditable wire surface minimal.
 *
 * UX:
 *  - All filters are optional except the SA-4 constraint above.
 *  - Default range = past 7 days (forms `fromDate` only; the BE
 *    treats `toDate` absent as `now`).
 *  - Cursor pagination — DESC by createdAt; the next page button
 *    appears only when `has_more` is true.
 */
function defaultFromDate(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** ISO date string slice for a `<input type="date">` value. */
function toDateInputValue(d: Date | null): string {
  if (d === null) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function parseDateInput(s: string): Date | null {
  if (s.length === 0) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export default function ProviderAuditPage() {
  const t = useTranslations('provider.audit');
  const tp = useTranslations('projects');
  const searchParams = useSearchParams();

  // Pre-fill orgId from URL (?orgId=<uuid>) — supports the tenant
  // detail "View audit" deep link.
  const initialOrgId = useMemo(() => {
    const raw = searchParams?.get('orgId') ?? '';
    return /^[0-9a-fA-F-]{36}$/.test(raw) ? raw : '';
  }, [searchParams]);

  const [orgId, setOrgId] = useState<string>(initialOrgId);
  const [actionFilter, setActionFilter] = useState<string>('');
  const [fromDate, setFromDate] = useState<Date | null>(defaultFromDate());
  const [toDate, setToDate] = useState<Date | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);

  // Build the query — useMemo so the hook's queryKey is stable when
  // the form values didn't actually change. Returns `null` if the SA-4
  // refinement would reject; the hook is then disabled and the form
  // error surfaces a localized hint.
  const query = useMemo<ProviderAuditQuery | null>(() => {
    const candidate: Record<string, unknown> = { limit: 25 };
    if (cursor) candidate['cursor'] = cursor;
    if (orgId) candidate['orgId'] = orgId;
    if (actionFilter) candidate['action'] = actionFilter;
    if (fromDate) candidate['fromDate'] = fromDate;
    if (toDate) candidate['toDate'] = toDate;
    const parsed = ProviderAuditQuerySchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  }, [orgId, actionFilter, fromDate, toDate, cursor]);

  // Re-validate on every form change — the SA-4 message helps the
  // operator narrow the search before they click anything.
  const queryError = useMemo<string | null>(() => {
    if (
      orgId ||
      (fromDate && (!toDate || toDate.getTime() - fromDate.getTime() <= 31 * 24 * 60 * 60 * 1000))
    ) {
      return null;
    }
    if (fromDate && toDate && toDate < fromDate) return t('errorFromAfterTo');
    return t('errorSa4');
  }, [orgId, fromDate, toDate, t]);

  const list = useProviderAudit(query ?? { limit: 25, fromDate: defaultFromDate() });
  const items = list.data?.items ?? [];

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setCursor(undefined); // reset pagination on a new query
    if (queryError) {
      setFormError(queryError);
      return;
    }
    setFormError(null);
  }

  function resetFilters() {
    setOrgId('');
    setActionFilter('');
    setFromDate(defaultFromDate());
    setToDate(null);
    setCursor(undefined);
    setFormError(null);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('hint')}</p>
      </div>

      <section className="rounded-md border bg-card p-4">
        {/* §S1-SEC1 — method="post" defense in depth even though the
            form filters never hit the wire as a POST (TanStack rerun
            on state). */}
        <form method="post" action="" onSubmit={onSubmit} className="space-y-3" dir="rtl">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor="orgId" className="text-sm font-medium">
                {t('field.orgId')}
              </label>
              <input
                id="orgId"
                type="text"
                value={orgId}
                onChange={(e) => setOrgId(e.target.value.trim())}
                placeholder={t('field.orgIdPlaceholder')}
                dir="ltr"
                className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="action" className="text-sm font-medium">
                {t('field.action')}
              </label>
              <input
                id="action"
                type="text"
                value={actionFilter}
                onChange={(e) => setActionFilter(e.target.value)}
                placeholder={t('field.actionPlaceholder')}
                dir="ltr"
                className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="fromDate" className="text-sm font-medium">
                {t('field.fromDate')}
              </label>
              <input
                id="fromDate"
                type="date"
                value={toDateInputValue(fromDate)}
                onChange={(e) => setFromDate(parseDateInput(e.target.value))}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="toDate" className="text-sm font-medium">
                {t('field.toDate')}
              </label>
              <input
                id="toDate"
                type="date"
                value={toDateInputValue(toDate)}
                onChange={(e) => setToDate(parseDateInput(e.target.value))}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              />
            </div>
          </div>

          {(formError || queryError) && (
            <p className="text-sm text-destructive">{formError ?? queryError}</p>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={resetFilters}>
              {t('reset')}
            </Button>
            <Button type="submit" size="sm" disabled={Boolean(queryError)}>
              {t('search')}
            </Button>
          </div>
        </form>
      </section>

      <ListPageShell
        isLoading={list.isLoading}
        isError={list.isError}
        error={list.error}
        itemCount={items.length}
        page={list.data?.page}
        cursor={cursor}
        loadFailedLabel={t('loadFailed')}
        emptyLabel={t('empty')}
        accessDeniedTitle={tp('accessDeniedTitle')}
        accessDeniedBody={tp('accessDeniedBody')}
        retryLabel={tp('retry')}
        nextLabel={tp('next')}
        resetLabel={tp('resetToFirstPage')}
        onRetry={() => list.refetch()}
        onNext={(next) => setCursor(next)}
        onReset={() => setCursor(undefined)}
      >
        <ul className="space-y-2">
          {items.map((row) => (
            <li key={row.id} className="rounded-md border bg-card p-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                    {row.actionCategory}
                  </span>
                  <code className="truncate font-mono text-xs" dir="ltr">
                    {row.action}
                  </code>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {row.createdRelative}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Link
                  href={`/provider/tenants/${row.organizationId}`}
                  className="rounded bg-muted/50 px-1.5 py-0.5 font-mono underline"
                  dir="ltr"
                >
                  {row.organizationId.slice(0, 8)}
                </Link>
                <span className="rounded bg-muted/50 px-1.5 py-0.5">{row.actorType}</span>
                {row.actorId && (
                  <span className="font-mono" dir="ltr">
                    {row.actorId.slice(0, 8)}
                  </span>
                )}
                {row.targetTable && (
                  <>
                    <span aria-hidden="true">·</span>
                    <code className="font-mono" dir="ltr">
                      {row.targetTable}
                      {row.targetId ? `/${row.targetId.slice(0, 8)}` : ''}
                    </code>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      </ListPageShell>
    </div>
  );
}
