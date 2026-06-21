'use client';

import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ListPageShell } from '@/components/ui/list-page-shell';
import { NameDisplay } from '@/components/ui/name-display';
import { useProviderTenantUsers } from '@/hooks/use-provider';

/**
 * Provider Admin — org users management (P4, PLAN-provider-console §3
 * Tier-1 #1). Lists the target org's MEMBERS: masked name + email, their
 * role(s), membership status (invited / active / revoked), and a cheap
 * last-activity signal.
 *
 * Security posture (mirrors the org-detail page — D.37 + D.19):
 *  - Lives under the provider `layout.tsx`, so the AccessReasonGate already
 *    blocked rendering until the operator supplied an investigation reason;
 *    no auth is re-implemented here.
 *  - Every render wrote a `provider_audit_log` row at the BE
 *    (`provider.tenant.users.viewed`) via the `withProvider` wrapper.
 *  - The PII discipline is enforced at the WIRE: this page CANNOT show
 *    cleartext name/email/national_id/phone because they aren't here —
 *    only `nameMasked` / `emailMasked` arrive. `<NameDisplay>` still wraps
 *    every masked string (bidi-spoofing defense, §v9-H-3).
 *  - READ-ONLY — no member actions (resend invite / deactivate) in this
 *    slice (Gate-6 gates any provider write).
 */
export default function ProviderTenantUsersPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const t = useTranslations('provider.tenantUsers');
  const tp = useTranslations('projects');
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const list = useProviderTenantUsers(id, cursor ? { cursor } : {});
  const items = list.data?.items ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t('hint')}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => router.push(`/provider/tenants/${id}`)}>
          {t('backToTenant')}
        </Button>
      </div>

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
          {items.map((m) => (
            <li key={m.id} className="rounded-md border bg-card p-3 text-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {/* Already masked at the wire; passes through. */}
                    <NameDisplay name={m.nameMasked} />
                    {m.isPrimary && (
                      <span className="ms-2 rounded-full bg-status-info-bg px-2 py-0.5 text-xs font-medium text-status-info-fg">
                        {t('primaryBadge')}
                      </span>
                    )}
                  </p>
                  <p className="mt-1 font-mono text-xs text-muted-foreground" dir="ltr">
                    <NameDisplay name={m.emailMasked} />
                  </p>
                </div>
                <span
                  className={
                    m.status === 'active'
                      ? 'shrink-0 rounded-full bg-status-neutral-bg px-2 py-0.5 text-xs font-medium text-status-neutral-fg'
                      : m.status === 'invited'
                        ? 'shrink-0 rounded-full bg-status-warning-bg px-2 py-0.5 text-xs font-medium text-status-warning-fg'
                        : 'shrink-0 rounded-full bg-status-neutral-bg px-2 py-0.5 text-xs font-medium text-status-neutral-fg'
                  }
                >
                  {t(`status.${m.status}`)}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="rounded bg-muted/50 px-1.5 py-0.5 font-medium text-foreground">
                  {t(`role.${m.role}`)}
                </span>
                {m.roleKeys.map((key) => (
                  <span key={key} className="rounded bg-muted/50 px-1.5 py-0.5 font-mono" dir="ltr">
                    {key}
                  </span>
                ))}
                <span aria-hidden="true">·</span>
                <span>
                  {t('joinedLabel')} {m.createdRelative}
                </span>
                {m.lastLoginRelative && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>
                      {t('lastLoginLabel')} {m.lastLoginRelative}
                    </span>
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
