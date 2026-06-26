'use client';

import { ApartmentStatusEnum, type ApartmentStatus } from '@emapp/shared-types';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { APARTMENT_STATUS_LABELS_EN, APARTMENT_STATUS_LABELS_HE } from '@/adapters/apartment';
import { ApartmentStatesSection } from '@/components/apartments/apartment-states-section';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { ListSkeleton } from '@/components/ui/list-skeleton';
import { NameDisplay } from '@/components/ui/name-display';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  useApartment,
  useArchiveApartment,
  useUpdateApartmentStatus,
} from '@/hooks/use-apartments';
import { useApartmentCoOwnerShares } from '@/hooks/use-ownerships';
import { useHasPermission } from '@/hooks/use-permissions';
import { formatApartmentLabel } from '@/lib/apartment-label';
import { ApiClientError } from '@/lib/api/errors';
import { useDisplayLocale } from '@/lib/locale';

import { TabuReviewSection } from './_components/tabu-review-section';

export default function ApartmentDetailPage() {
  const t = useTranslations('apartments');
  const tp = useTranslations('projects');
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const { data, isLoading, isError, error } = useApartment(id);
  // S3d — co-owners with their EXACT Tabu share as a fraction (e.g. "1/3").
  const { data: coOwners } = useApartmentCoOwnerShares(id);
  const archive = useArchiveApartment();
  const updateStatus = useUpdateApartmentStatus();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const canUpdate = useHasPermission('apartments.update');
  const canArchive = useHasPermission('apartments.archive');
  const locale = useDisplayLocale();
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingStatus, setPendingStatus] = useState<ApartmentStatus | ''>('');

  // The [id] route does a SOFT navigation (no remount) between apartments, so
  // local state survives. Reset the unsaved status draft when the apartment
  // changes — otherwise an un-saved selection on apartment A would pre-fill
  // (and could be saved onto) apartment B. (code-review CRITICAL.)
  useEffect(() => {
    setPendingStatus('');
    setActionError(null);
  }, [id]);

  if (isLoading) return <ListSkeleton withRows={false} />;
  if (isError) {
    const notFound = error instanceof ApiClientError && error.code === 'not_found';
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{notFound ? t('notFound') : t('loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={() => router.back()}>
          {tp('backToList')}
        </Button>
      </div>
    );
  }
  if (!data) return null;
  const buildingId = data.buildingId;
  const statusLabels = locale === 'he' ? APARTMENT_STATUS_LABELS_HE : APARTMENT_STATUS_LABELS_EN;
  const effectiveStatus: ApartmentStatus = pendingStatus || data.status;

  async function onSaveStatus() {
    if (!id || !data) return;
    const next = pendingStatus || data.status;
    if (next === data.status) return;
    setActionError(null);
    try {
      await updateStatus.mutateAsync({ id, status: next });
      setPendingStatus('');
    } catch {
      setActionError(t('statusUpdateFailed'));
    }
  }

  async function onArchive() {
    if (!id) return;
    setActionError(null);
    if (!(await confirm({ message: t('archiveConfirm'), destructive: true }))) return;
    try {
      await archive.mutateAsync(id);
      router.push(`/buildings/${buildingId}/apartments`);
    } catch {
      setActionError(t('archiveFailed'));
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <Link href={`/buildings/${buildingId}/apartments`} className="underline">
          {tp('backToList')}
        </Link>
      </p>

      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          {/* 7c F2 — formatApartmentLabel dedups numbers that already carry
              the "דירה" word (live finding: h1 rendered "דירה דירה 7"). */}
          <h1 className="text-2xl font-bold">
            {formatApartmentLabel(data.number, locale === 'he' ? 'דירה' : 'Apartment')}
          </h1>
          <div className="flex items-center gap-2">
            <StatusBadge intent={data.intent}>{data.statusLabel}</StatusBadge>
            <span className="text-xs text-muted-foreground">
              {t('statusChangedLabel', { rel: data.statusChangedRelative })}
            </span>
            {data.isArchived && <span className="badge badge-neutral">{tp('archived')}</span>}
          </div>
          {data.factsLine && <p className="text-xs text-muted-foreground">{data.factsLine}</p>}
        </div>
        {canArchive && !data.isArchived && (
          <Button variant="outline" size="sm" onClick={onArchive} disabled={archive.isPending}>
            {archive.isPending ? tp('archiving') : tp('archive')}
          </Button>
        )}
      </div>

      {canUpdate && !data.isArchived && (
        <div className="rounded-md border bg-card p-4">
          <h2 className="text-sm font-semibold">{t('statusSection')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('statusHint')}</p>
          <div className="mt-3 flex items-center gap-2">
            <label htmlFor="apartment-status" className="sr-only">
              {t('statusSection')}
            </label>
            <select
              id="apartment-status"
              className="rounded-md border bg-background px-3 py-2 text-sm"
              value={effectiveStatus}
              onChange={(e) => setPendingStatus(e.target.value as ApartmentStatus)}
              disabled={updateStatus.isPending}
            >
              {ApartmentStatusEnum.options.map((s) => (
                <option key={s} value={s}>
                  {statusLabels[s]}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              onClick={onSaveStatus}
              disabled={updateStatus.isPending || effectiveStatus === data.status}
            >
              {updateStatus.isPending ? t('statusSaving') : t('statusSave')}
            </Button>
          </div>
        </div>
      )}

      {data.notes && (
        <div className="rounded-md border bg-card p-4">
          <h2 className="text-sm font-semibold">{t('field.notes')}</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
            <NameDisplay name={data.notes} />
          </p>
        </div>
      )}

      <div className="rounded-md border bg-card p-4">
        <h2 className="text-sm font-semibold">{t('ownershipsSection')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('ownershipsHint')}</p>
        {/* S3d — co-owners with their EXACT Tabu share rendered as a fraction
         *  (e.g. "1/3") rather than only the lossy compat percent. */}
        {coOwners && coOwners.length > 0 && (
          <ul className="mt-3 flex flex-col gap-1.5">
            {coOwners.map((c) => (
              <li key={c.ownerId} className="flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0 truncate">
                  <NameDisplay name={c.displayName} />
                </span>
                <span className="tabular font-medium" dir="ltr">
                  {c.shareLabel}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3">
          <Button asChild variant="outline" size="sm">
            <Link href={`/apartments/${data.id}/ownerships`}>{t('ownershipsManage')}</Link>
          </Button>
        </div>
      </div>

      {/* Slice 2.7 — apartment legal/life states (deceased/dispute/poa/eviction/
       *  repairs/rights-transfer). Active states as legible badges (blocking ones
       *  flagged), one-click add/resolve for managers. PII-FREE — no person/contact
       *  fields. The BE re-asserts manager-tier on writes; reads are any-org-role. */}
      <ApartmentStatesSection apartmentId={data.id} canManage={canUpdate} />

      {/* 7c F3 — נסח-טאבו extraction review + confirm. Write-flow: mounted
          only for actors holding apartments.update (mirrors the BE gate, so
          the section's queries never fire for viewers). */}
      {canUpdate && !data.isArchived && <TabuReviewSection apartmentId={data.id} />}

      {actionError && <p className="text-sm text-destructive">{actionError}</p>}
      {confirmDialog}
    </div>
  );
}
