'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { NameDisplay } from '@/components/ui/name-display';
import { useArchiveBuilding, useBuilding } from '@/hooks/use-buildings';
import { ApiClientError } from '@/lib/api/projects';

export default function BuildingDetailPage() {
  const t = useTranslations('buildings');
  const tp = useTranslations('projects');
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const { data, isLoading, isError, error } = useBuilding(id);
  const archive = useArchiveBuilding();
  const [actionError, setActionError] = useState<string | null>(null);

  if (isLoading) return <p className="text-sm text-muted-foreground">{t('loading')}</p>;
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
  const projectId = data.projectId;

  async function onArchive() {
    if (!id) return;
    setActionError(null);
    if (!window.confirm(t('archiveConfirm'))) return;
    try {
      await archive.mutateAsync(id);
      router.push(`/projects/${projectId}/buildings`);
    } catch {
      setActionError(t('archiveFailed'));
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <Link href={`/projects/${data.projectId}/buildings`} className="underline">
          {tp('backToList')}
        </Link>
      </p>

      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold">
            <NameDisplay name={data.addressLine} />
          </h1>
          <p className="text-xs text-muted-foreground">
            {t('aptCountLabel', { count: data.aptCount })}
            {data.parcelSummary && <> · {data.parcelSummary}</>}
            <> · {data.createdRelative}</>
          </p>
          {data.isArchived && (
            <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700">
              {tp('archived')}
            </span>
          )}
        </div>
        {!data.isArchived && (
          <Button variant="outline" size="sm" onClick={onArchive} disabled={archive.isPending}>
            {archive.isPending ? tp('archiving') : tp('archive')}
          </Button>
        )}
      </div>

      {data.notes && (
        <div className="rounded-md border bg-card p-4">
          <h2 className="text-sm font-semibold">{t('field.notes')}</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
            <NameDisplay name={data.notes} />
          </p>
        </div>
      )}

      <div className="rounded-md border bg-card p-4">
        <h2 className="text-sm font-semibold">{t('apartmentsSection')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('apartmentsHint')}</p>
        <div className="mt-3">
          <Button asChild variant="outline" size="sm">
            <Link href={`/buildings/${data.id}/apartments`}>{t('apartmentsManage')}</Link>
          </Button>
        </div>
      </div>

      {actionError && <p className="text-sm text-destructive">{actionError}</p>}
    </div>
  );
}
