'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { ListPageShell } from '@/components/ui/list-page-shell';
import { NameDisplay } from '@/components/ui/name-display';
import { useAuditList } from '@/hooks/use-audit';

/**
 * Audit log viewer — Manager-only (D.17 policy.ts:68 + BE
 * AuditReadService role check, 403 to anyone else). The list is
 * chronological (BE keyset cursor by createdAt DESC, id DESC) — no
 * client-side filters in Phase 4c because the BE only supports
 * limit + cursor today. Adding action / actor / date filters would
 * require a BE wire change and is recorded as a future closure
 * candidate (see PR description).
 *
 * Projection: who (actorType + actorEmail) · what (category + action
 * suffix raw) · target (table + id) · when (relative + absolute). No
 * before/after diffs, no IP, no user-agent — those stay BE-side per
 * docs/07 §8.1.
 */
export function AuditListClient() {
  const t = useTranslations('audit');
  const tp = useTranslations('projects');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const { data, isLoading, isError, error, refetch } = useAuditList({ limit: 25, cursor });
  const items = data?.items ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{t('listTitle')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('hint')}</p>
        </div>
      </div>

      <ListPageShell
        isLoading={isLoading}
        isError={isError}
        error={error}
        itemCount={items.length}
        page={data?.page}
        cursor={cursor}
        loadFailedLabel={t('loadFailed')}
        emptyLabel={t('empty')}
        accessDeniedTitle={tp('accessDeniedTitle')}
        accessDeniedBody={tp('accessDeniedBody')}
        retryLabel={tp('retry')}
        nextLabel={tp('next')}
        resetLabel={tp('resetToFirstPage')}
        onRetry={() => refetch()}
        onNext={(next) => setCursor(next)}
        onReset={() => setCursor(undefined)}
      >
        <ul className="space-y-2">
          {items.map((e) => (
            <li key={e.id} className="rounded-md border bg-card p-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                    {e.categoryLabel}
                  </span>
                  {/* Phase 4g — curated HE/EN label first; raw machine
                       suffix kept as a small monospace chip when it
                       differs from the label (forensic identifier for
                       cross-referencing log search; Doc 07 §8.1). */}
                  <span className="text-sm font-medium">{e.actionSuffixLabel || e.action}</span>
                  {e.actionSuffix && e.actionSuffixLabel !== e.actionSuffix && (
                    <code
                      className="truncate rounded bg-muted/40 px-1 font-mono text-[10px] text-muted-foreground"
                      dir="ltr"
                      title={e.action}
                    >
                      {e.actionSuffix}
                    </code>
                  )}
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{e.createdRelative}</span>
              </div>
              <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span className="rounded bg-muted/50 px-1.5 py-0.5">{e.actorTypeLabel}</span>
                {e.actorEmail ? (
                  <NameDisplay name={e.actorEmail} />
                ) : (
                  <span className="font-mono" dir="ltr">
                    {e.actorId ? e.actorId.slice(0, 8) : '—'}
                  </span>
                )}
                {e.targetTable && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>{t('targetLabel')}:</span>
                    <code className="font-mono" dir="ltr">
                      {e.targetTable}
                      {e.targetId ? `/${e.targetId.slice(0, 8)}` : ''}
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
