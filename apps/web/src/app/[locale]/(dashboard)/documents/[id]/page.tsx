'use client';

import { DOCUMENT_UPLOAD_INCOMPLETE_CODE } from '@emapp/shared-types';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ListSkeleton } from '@/components/ui/list-skeleton';
import { NameDisplay } from '@/components/ui/name-display';
import { useArchiveDocument, useDocument, useDownloadDocument } from '@/hooks/use-documents';
import { useHasPermission } from '@/hooks/use-permissions';
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
  const canDownload = useHasPermission('documents.download');
  const canArchive = useHasPermission('documents.archive');
  const [actionError, setActionError] = useState<string | null>(null);
  // Which disposition is currently in flight, so only the clicked button
  // shows its pending label (both share the one download mutation).
  const [pendingDisposition, setPendingDisposition] = useState<'inline' | 'attachment' | null>(
    null,
  );

  if (isLoading) return <ListSkeleton withRows={false} />;
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

  // Slice 2 — `attachment` keeps the save-dialog behaviour (Download);
  // `inline` mints a presigned URL R2 serves as `Content-Disposition:
  // inline`, so the PDF renders in the new tab (View). Same mutation,
  // same error handling, same https re-check.
  async function openWithDisposition(disposition: 'inline' | 'attachment') {
    if (!id) return;
    setActionError(null);
    setPendingDisposition(disposition);
    try {
      const { url } = await download.mutateAsync({ id, disposition });
      // §RED-1 defense-in-depth — schema-level scheme allowlist is the
      // primary defense (DocumentDownloadResponseSchema.url is
      // HttpsUrlSchema), but we re-verify the protocol here before
      // calling window.open. A javascript:/data: URL that somehow
      // slipped past would otherwise execute attacker JS in the
      // opener's brief about:blank inheritance window.
      if (!/^https:\/\//i.test(url)) {
        setActionError(t('downloadFailed'));
        return;
      }
      // Open in a new tab — the URL is a short-lived presigned GET,
      // honored by R2 with the requested Content-Disposition server-side.
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      // 0050 (ghost-doc UX) — the BE returns the distinct
      // `document_upload_incomplete` code ONLY for the owner's own
      // never-finalised doc (a foreign id stays a generic 404). Surface the
      // actionable "re-upload" message instead of a generic failure.
      if (e instanceof ApiClientError && e.code === DOCUMENT_UPLOAD_INCOMPLETE_CODE) {
        setActionError(t('uploadIncomplete'));
        return;
      }
      setActionError(t('downloadFailed'));
    } finally {
      setPendingDisposition(null);
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
          {canDownload && !data.isArchived && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => openWithDisposition('inline')}
              disabled={download.isPending}
            >
              {pendingDisposition === 'inline' ? t('opening') : t('view')}
            </Button>
          )}
          {canDownload && !data.isArchived && (
            <Button
              size="sm"
              onClick={() => openWithDisposition('attachment')}
              disabled={download.isPending}
            >
              {pendingDisposition === 'attachment' ? t('downloading') : t('download')}
            </Button>
          )}
          {canArchive && !data.isArchived && (
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
