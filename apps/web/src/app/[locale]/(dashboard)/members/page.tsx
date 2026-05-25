'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ListPageShell } from '@/components/ui/list-page-shell';
import { NameDisplay } from '@/components/ui/name-display';
import { StatusBadge } from '@/components/ui/status-badge';
import { useMemberList } from '@/hooks/use-members';

/**
 * Members list — Manager-only resource (D.17 — `members: MGR` for every
 * action). The sidebar hides this link for non-Manager users (cosmetic
 * gate); the BE's `AuthorizationGuard` is the actual enforcement and
 * returns 403 to anyone else (which the api-client surfaces as
 * `loadFailed`).
 *
 * The list shows ACTIVE + PENDING + REVOKED rows — the BE doesn't
 * filter on revokedAt for the list, so a Manager sees the full org
 * roster including expired/withdrawn invites (forensic value for ISO
 * A.9.4.1 — visible attestation of role assignments).
 */
export default function MembersPage() {
  const t = useTranslations('members');
  const tp = useTranslations('projects');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const { data, isLoading, isError, refetch } = useMemberList({ limit: 25, cursor });
  const items = data?.items ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('listTitle')}</h1>
        <Button asChild>
          <Link href="/members/new">{t('invite')}</Link>
        </Button>
      </div>

      <ListPageShell
        isLoading={isLoading}
        isError={isError}
        itemCount={items.length}
        page={data?.page}
        cursor={cursor}
        loadFailedLabel={t('loadFailed')}
        emptyLabel={t('empty')}
        retryLabel={tp('retry')}
        nextLabel={tp('next')}
        resetLabel={tp('resetToFirstPage')}
        onRetry={() => refetch()}
        onNext={(next) => setCursor(next)}
        onReset={() => setCursor(undefined)}
      >
        <ul className="space-y-2">
          {items.map((m) => (
            <li key={m.userId} className="rounded-md border bg-card p-4">
              <Link href={`/members/${m.userId}`} className="block">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-3">
                      <h2 className="truncate text-base font-semibold">
                        <NameDisplay name={m.name} />
                      </h2>
                      <StatusBadge color={m.stateColor}>{m.stateLabel}</StatusBadge>
                      {m.isPrimary && (
                        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
                          {t('primary')}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      <NameDisplay name={m.email} /> · {m.roleLabel} · {m.createdRelative}
                    </p>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </ListPageShell>
    </div>
  );
}
