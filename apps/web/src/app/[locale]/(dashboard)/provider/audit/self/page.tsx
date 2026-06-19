'use client';

import { ProviderSelfAuditQuerySchema, type ProviderSelfAuditQuery } from '@emapp/shared-types';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ListPageShell } from '@/components/ui/list-page-shell';
import { NameDisplay } from '@/components/ui/name-display';
import { useProviderSelfAudit } from '@/hooks/use-provider';

/**
 * Provider self-audit (B-PROVIDER-2) — the CURRENT operator's OWN action
 * history from `provider_audit_log`. A self-accountability / transparency
 * view: "what did *I* access, when, and with what reason."
 *
 * Distinct from the cross-tenant `/provider/audit` search (which reads the
 * customers' `audit_log`). Unlike that page there is NO SA-4 mandatory
 * date-span — `provider_audit_log` is bounded by the provider team's own
 * activity — so all filters are optional. The page reuses the same
 * loading/error/empty/pagination chrome (`ListPageShell`) and renders, per
 * row: the absolute Asia/Jerusalem timestamp, the action, the target org
 * (if any), the access reason, and the coarse result.
 *
 * It lives under the provider `layout.tsx`, so the AccessReasonGate already
 * guarantees a non-null `access_reason` before any hook fires — no auth is
 * re-implemented here.
 */
function defaultFromDate(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 30);
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

export default function ProviderSelfAuditPage() {
  const t = useTranslations('provider.selfAudit');
  const tp = useTranslations('projects');

  const [affectedOrgId, setAffectedOrgId] = useState<string>('');
  const [actionType, setActionType] = useState<string>('');
  const [fromDate, setFromDate] = useState<Date | null>(defaultFromDate());
  const [toDate, setToDate] = useState<Date | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [formError, setFormError] = useState<string | null>(null);

  // Build the query — useMemo so the hook's queryKey is stable when the
  // form values didn't actually change. Returns `null` if the schema
  // would reject (only constraint here: fromDate <= toDate); the form
  // error then surfaces a localized hint.
  const query = useMemo<ProviderSelfAuditQuery | null>(() => {
    const candidate: Record<string, unknown> = { limit: 25 };
    if (cursor) candidate['cursor'] = cursor;
    if (affectedOrgId) candidate['affectedOrgId'] = affectedOrgId;
    if (actionType) candidate['actionType'] = actionType;
    if (fromDate) candidate['fromDate'] = fromDate;
    if (toDate) candidate['toDate'] = toDate;
    const parsed = ProviderSelfAuditQuerySchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  }, [affectedOrgId, actionType, fromDate, toDate, cursor]);

  const queryError = useMemo<string | null>(() => {
    if (fromDate && toDate && toDate < fromDate) return t('errorFromAfterTo');
    return null;
  }, [fromDate, toDate, t]);

  const list = useProviderSelfAudit(query ?? { limit: 25 });
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
    setAffectedOrgId('');
    setActionType('');
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
        {/* §S1-SEC1 — method="post" defense in depth even though the form
            filters never hit the wire as a POST (TanStack rerun on state). */}
        <form method="post" action="" onSubmit={onSubmit} className="space-y-3" dir="rtl">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor="affectedOrgId" className="text-sm font-medium">
                {t('field.affectedOrgId')}
              </label>
              <input
                id="affectedOrgId"
                type="text"
                value={affectedOrgId}
                onChange={(e) => setAffectedOrgId(e.target.value.trim())}
                placeholder={t('field.affectedOrgIdPlaceholder')}
                dir="ltr"
                className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="actionType" className="text-sm font-medium">
                {t('field.actionType')}
              </label>
              <input
                id="actionType"
                type="text"
                value={actionType}
                onChange={(e) => setActionType(e.target.value)}
                placeholder={t('field.actionTypePlaceholder')}
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
                    {row.actionType}
                  </code>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {row.startedAtJerusalem}
                </span>
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span
                  className={
                    row.result === 'completed'
                      ? 'rounded bg-muted/50 px-1.5 py-0.5'
                      : 'rounded bg-status-warning-bg px-1.5 py-0.5 text-status-warning-fg'
                  }
                >
                  {t(`result.${row.result}`)}
                </span>
                {row.affectedOrgs && row.affectedOrgs.length > 0 ? (
                  <span className="flex flex-wrap items-center gap-1">
                    <span aria-hidden="true">·</span>
                    {row.affectedOrgs.map((orgId) => (
                      <Link
                        key={orgId}
                        href={`/provider/tenants/${orgId}`}
                        className="rounded bg-muted/50 px-1.5 py-0.5 font-mono underline"
                        dir="ltr"
                      >
                        {orgId.slice(0, 8)}
                      </Link>
                    ))}
                  </span>
                ) : (
                  <span className="text-muted-foreground/70">{t('noTargetOrg')}</span>
                )}
                {row.targetTable && (
                  <>
                    <span aria-hidden="true">·</span>
                    <code className="font-mono" dir="ltr">
                      {row.targetTable}
                      {row.targetRecordId ? `/${row.targetRecordId.slice(0, 8)}` : ''}
                    </code>
                  </>
                )}
              </div>

              <div className="mt-1.5 text-xs text-foreground">
                <span className="text-muted-foreground">{t('reasonLabel')} </span>
                <NameDisplay name={row.reason} />
              </div>
            </li>
          ))}
        </ul>
      </ListPageShell>
    </div>
  );
}
