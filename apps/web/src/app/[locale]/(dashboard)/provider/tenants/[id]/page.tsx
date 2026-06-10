'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { TenantSuspensionPanel } from '@/components/provider/tenant-suspension-panel';
import { Button } from '@/components/ui/button';
import { ListSkeleton } from '@/components/ui/list-skeleton';
import { NameDisplay } from '@/components/ui/name-display';
import { useProviderTenant } from '@/hooks/use-provider';
import { ApiClientError } from '@/lib/api/errors';

/**
 * Provider Admin — tenant detail (D.37).
 *
 * Wire returns: name + slug + 5 counts + ≤5 sample owners (PII masked
 * at the BE — `nameMasked` `•••••••XX`, `phoneMasked` `•••••XXXX`,
 * national_id NEVER on the wire). The page presents these as a counts
 * grid + a small sample table. No drill-down further than what the BE
 * surfaces (write actions remain Gate-6).
 *
 * Security posture (D.37):
 *  - Every render through this page already wrote a `provider_audit_log`
 *    row at the BE — the `withProvider` wrapper logs the read.
 *  - The PII discipline (D.19) is enforced at the wire: this page CANNOT
 *    accidentally show cleartext PII because it isn't here to show.
 *  - `<NameDisplay>` wraps every name field (bidi-spoofing defense in
 *    depth — §v9-H-3).
 */
export default function ProviderTenantDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const t = useTranslations('provider.tenantDetail');
  const tList = useTranslations('provider.tenants');
  const tp = useTranslations('projects'); // archived label
  const { data, isLoading, isError, error } = useProviderTenant(id);

  if (isLoading) return <ListSkeleton withRows={false} />;

  if (isError) {
    const notFound = error instanceof ApiClientError && error.code === 'tenant_not_found';
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{notFound ? t('notFound') : tList('loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={() => router.push('/provider/tenants')}>
          {t('backToList')}
        </Button>
      </div>
    );
  }

  if (!data) return null;

  const counts = [
    { key: 'users' as const, value: data.counts.users },
    { key: 'projects' as const, value: data.counts.projects },
    { key: 'owners' as const, value: data.counts.owners },
    { key: 'importJobs' as const, value: data.counts.importJobs },
    { key: 'signatureRequests' as const, value: data.counts.signatureRequests },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2 min-w-0 flex-1">
          <h1 className="truncate text-2xl font-bold">
            <NameDisplay name={data.name} />
          </h1>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span
              className="rounded-full bg-gray-100 px-2 py-0.5 font-mono text-foreground"
              dir="ltr"
            >
              {data.slug}
            </span>
            <span>{data.createdRelative}</span>
            {data.isArchived && (
              <span className="rounded-full bg-gray-200 px-2 py-0.5 font-medium text-gray-700">
                {tp('archived')}
              </span>
            )}
            {data.isSuspended && (
              <span className="rounded-full bg-amber-200 px-2 py-0.5 font-medium text-amber-900">
                {t('suspension.badge')}
              </span>
            )}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => router.push('/provider/tenants')}>
          {t('backToList')}
        </Button>
      </div>

      {/* D.49 — Provider write actions (suspend / reactivate). */}
      <TenantSuspensionPanel tenant={data} />

      {/* Counts grid — one card per metric. */}
      <section>
        <h2 className="mb-3 text-base font-semibold">{t('countsSection')}</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {counts.map((c) => (
            <div key={c.key} className="rounded-md border bg-card p-3">
              <p className="text-xs text-muted-foreground">{t(`counts.${c.key}`)}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums">{c.value}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Sample owners — masked PII only. */}
      <section>
        <h2 className="mb-3 text-base font-semibold">{t('sampleOwnersSection')}</h2>
        <p className="mb-3 text-xs text-muted-foreground">{t('sampleOwnersHint')}</p>
        {data.sampleOwners.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noSampleOwners')}</p>
        ) : (
          <ul className="space-y-2">
            {data.sampleOwners.map((o) => (
              <li key={o.id} className="rounded-md border bg-card p-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {/* Already masked at the wire; passes through. */}
                      <NameDisplay name={o.nameMasked} />
                    </p>
                    <p className="mt-1 font-mono text-xs text-muted-foreground" dir="ltr">
                      {o.phoneMasked && (
                        <>
                          {t('phoneLabel')} {o.phoneMasked}
                        </>
                      )}
                      {o.email && (
                        <>
                          {o.phoneMasked ? ' · ' : ''}
                          <NameDisplay name={o.email} />
                        </>
                      )}
                    </p>
                  </div>
                  {o.isArchived && (
                    <span className="shrink-0 rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700">
                      {tp('archived')}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Drill-downs: org users management (P4) + per-tenant audit. */}
      <section className="flex flex-wrap gap-2">
        <Button asChild variant="outline" size="sm">
          <Link href={`/provider/tenants/${data.id}/users` as '/provider'}>
            {t('viewUsersForTenant')}
          </Link>
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href={{ pathname: '/provider/audit', query: { orgId: data.id } } as const}>
            {t('viewAuditForTenant')}
          </Link>
        </Button>
      </section>
    </div>
  );
}
