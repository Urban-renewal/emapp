'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { NameDisplay } from '@/components/ui/name-display';
import { useArchiveProject, useProject } from '@/hooks/use-projects';
import { ApiClientError } from '@/lib/api/projects';
import { cn } from '@/lib/utils';

const STATUS_BADGE: Record<'gray' | 'amber' | 'emerald' | 'red', string> = {
  gray: 'bg-gray-100 text-gray-700',
  amber: 'bg-amber-100 text-amber-800',
  emerald: 'bg-emerald-100 text-emerald-800',
  red: 'bg-red-100 text-red-800',
};

export default function ProjectDetailPage() {
  const t = useTranslations('projects');
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const { data, isLoading, isError, error } = useProject(id);
  const archive = useArchiveProject();
  const [actionError, setActionError] = useState<string | null>(null);

  if (isLoading) return <p className="text-sm text-muted-foreground">{t('loading')}</p>;

  if (isError) {
    const notFound = error instanceof ApiClientError && error.code === 'not_found';
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{notFound ? t('notFound') : t('loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={() => router.push('/projects')}>
          {t('backToList')}
        </Button>
      </div>
    );
  }

  if (!data) return null;

  async function onArchive() {
    if (!id) return;
    setActionError(null);
    if (!window.confirm(t('archiveConfirm'))) return;
    try {
      await archive.mutateAsync(id);
      router.push('/projects');
    } catch (e) {
      if (e instanceof ApiClientError) {
        setActionError(t('archiveFailed'));
      } else {
        setActionError(t('archiveFailed'));
      }
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold">
            <NameDisplay name={data.name} />
          </h1>
          <div className="flex items-center gap-2">
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-xs font-medium',
                STATUS_BADGE[data.statusColor],
              )}
            >
              {data.statusLabel}
            </span>
            <span className="text-xs text-muted-foreground">{data.typeLabel}</span>
            <span className="text-xs text-muted-foreground">· {data.createdRelative}</span>
            {data.isArchived && (
              <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700">
                {t('archived')}
              </span>
            )}
          </div>
        </div>
        {!data.isArchived && (
          <Button variant="outline" size="sm" onClick={onArchive} disabled={archive.isPending}>
            {archive.isPending ? t('archiving') : t('archive')}
          </Button>
        )}
      </div>

      {data.description && (
        <div className="rounded-md border bg-card p-4">
          <h2 className="text-sm font-semibold">{t('field.description')}</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
            {data.description}
          </p>
        </div>
      )}

      <div className="rounded-md border bg-card p-4">
        <h2 className="text-sm font-semibold">{t('buildingsSection')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('buildingsHint')}</p>
        <div className="mt-3">
          <Button asChild variant="outline" size="sm">
            <Link href={`/projects/${data.id}/buildings`}>{t('buildingsManage')}</Link>
          </Button>
        </div>
      </div>

      {actionError && <p className="text-sm text-destructive">{actionError}</p>}
    </div>
  );
}
