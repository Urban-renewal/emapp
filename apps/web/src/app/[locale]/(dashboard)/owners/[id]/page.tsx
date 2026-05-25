'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { NameDisplay } from '@/components/ui/name-display';
import { useArchiveOwner, useOwner } from '@/hooks/use-owners';
import { ApiClientError } from '@/lib/api/projects';

export default function OwnerDetailPage() {
  const t = useTranslations('owners');
  const tp = useTranslations('projects');
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const { data, isLoading, isError, error } = useOwner(id);
  const archive = useArchiveOwner();
  const [actionError, setActionError] = useState<string | null>(null);

  if (isLoading) return <p className="text-sm text-muted-foreground">{t('loading')}</p>;
  if (isError) {
    const notFound = error instanceof ApiClientError && error.code === 'not_found';
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{notFound ? t('notFound') : t('loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={() => router.push('/owners')}>
          {tp('backToList')}
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
      router.push('/owners');
    } catch {
      setActionError(t('archiveFailed'));
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <Link href="/owners" className="underline">
          {tp('backToList')}
        </Link>
      </p>

      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold">
            <NameDisplay name={data.name} />
          </h1>
          <dl className="space-y-1 font-mono text-sm" dir="ltr">
            <div className="flex gap-2">
              <dt className="text-muted-foreground">{t('idLabel')}</dt>
              <dd>{data.nationalIdMasked}</dd>
            </div>
            {data.phoneMasked && (
              <div className="flex gap-2">
                <dt className="text-muted-foreground">{t('phoneLabel')}</dt>
                <dd>{data.phoneMasked}</dd>
              </div>
            )}
            {data.email && (
              <div className="flex gap-2">
                <dt className="text-muted-foreground">{t('emailLabel')}</dt>
                <dd>
                  <NameDisplay name={data.email} />
                </dd>
              </div>
            )}
          </dl>
          {data.isArchived && (
            <span className="inline-block rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700">
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

      {actionError && <p className="text-sm text-destructive">{actionError}</p>}
    </div>
  );
}
