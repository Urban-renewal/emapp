'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { NameDisplay } from '@/components/ui/name-display';
import { useArchiveDocument, useDocument, useDownloadDocument } from '@/hooks/use-documents';
import { ApiClientError } from '@/lib/api/projects';

export default function DocumentDetailPage() {
  const t = useTranslations('documents');
  const tp = useTranslations('projects');
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const { data, isLoading, isError, error } = useDocument(id);
  const archive = useArchiveDocument();
  const download = useDownloadDocument();
  const [actionError, setActionError] = useState<string | null>(null);

  if (isLoading) return <p className="text-sm text-muted-foreground">{t('loading')}</p>;
  if (isError) {
    const notFound = error instanceof ApiClientError && error.code === 'not_found';
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{notFound ? t('notFound') : t('loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={() => router.push('/documents')}>
          {tp('backToList')}
        </Button>
      </div>
    );
  }
  if (!data) return null;

  async function onDownload() {
    if (!id) return;
    setActionError(null);
    try {
      const { url } = await download.mutateAsync(id);
      // Open in a new tab — the URL is a short-lived presigned GET,
      // honored by R2 as `Content-Disposition: attachment` server-side.
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      setActionError(t('downloadFailed'));
    }
  }

  async function onArchive() {
    if (!id) return;
    setActionError(null);
    if (!window.confirm(t('archiveConfirm'))) return;
    try {
      await archive.mutateAsync(id);
      router.push('/documents');
    } catch {
      setActionError(t('archiveFailed'));
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <Link href="/documents" className="underline">
          {tp('backToList')}
        </Link>
      </p>

      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold">
            <NameDisplay name={data.name} />
          </h1>
          <p className="text-xs text-muted-foreground">
            {data.typeLabel} · {data.sizeLabel} · {data.createdRelative}
          </p>
          {data.isArchived && (
            <span className="inline-block rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700">
              {tp('archived')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!data.isArchived && (
            <Button size="sm" onClick={onDownload} disabled={download.isPending}>
              {download.isPending ? t('downloading') : t('download')}
            </Button>
          )}
          {!data.isArchived && (
            <Button variant="outline" size="sm" onClick={onArchive} disabled={archive.isPending}>
              {archive.isPending ? tp('archiving') : tp('archive')}
            </Button>
          )}
        </div>
      </div>

      {actionError && <p className="text-sm text-destructive">{actionError}</p>}
    </div>
  );
}
