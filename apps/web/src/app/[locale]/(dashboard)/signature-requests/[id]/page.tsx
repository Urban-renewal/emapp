'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ListSkeleton } from '@/components/ui/list-skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { useHasPermission } from '@/hooks/use-permissions';
import { useSessionProfile } from '@/hooks/use-session';
import { useCancelSignatureRequest, useSignatureRequest } from '@/hooks/use-signature-requests';
import { ApiClientError } from '@/lib/api/errors';
import { fetchSignedDocument } from '@/lib/api/signature-requests';

export default function SignatureRequestDetailPage() {
  const t = useTranslations('signatureRequests');
  const tp = useTranslations('projects');
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const { data, isLoading, isError, error } = useSignatureRequest(id);
  const cancel = useCancelSignatureRequest();
  // The signed certificate carries decrypted owner PII (signer name + the
  // signature), so the download button is gated on the SAME signal as the
  // owner-detail PII reveal: `/me.view_owner_pii` (manager always · agent iff
  // capability granted · viewer never) — mirrors the BE fidelity gate, so the
  // button never shows for someone the endpoint would 403.
  const { data: profile } = useSessionProfile();
  const canDownloadSigned = profile?.view_owner_pii === true;
  const canCancel = useHasPermission('signature_requests.cancel');
  const [actionError, setActionError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  if (isLoading) return <ListSkeleton withRows={false} />;
  if (isError) {
    const notFound = error instanceof ApiClientError && error.code === 'not_found';
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{notFound ? t('notFound') : t('loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={() => router.push('/signature-requests')}>
          {tp('backToList')}
        </Button>
      </div>
    );
  }
  if (!data) return null;

  async function onDownloadSigned() {
    if (!id) return;
    setActionError(null);
    setDownloading(true);
    try {
      const blob = await fetchSignedDocument(id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `signed-${id}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      setActionError(t('downloadSignedFailed'));
    } finally {
      setDownloading(false);
    }
  }

  async function onCancel() {
    if (!id) return;
    setActionError(null);
    if (!window.confirm(t('cancelConfirm'))) return;
    try {
      await cancel.mutateAsync(id);
    } catch (e) {
      if (e instanceof ApiClientError) {
        if (e.code === 'signature_request_already_signed') {
          setActionError(t('alreadySigned'));
        } else {
          setActionError(t('cancelFailed'));
        }
      } else {
        setActionError(t('cancelFailed'));
      }
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm">
        <Link href="/signature-requests" className="underline">
          {tp('backToList')}
        </Link>
      </p>

      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold">{t('detailTitle')}</h1>
            <StatusBadge color={data.statusColor}>{data.statusLabel}</StatusBadge>
            {data.isExpired && (
              <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                {t('expired')}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {t('createdAt', { rel: data.createdRelative })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data.signedRelative && canDownloadSigned && (
            <Button variant="outline" onClick={onDownloadSigned} disabled={downloading}>
              {downloading ? t('downloadingSigned') : t('downloadSigned')}
            </Button>
          )}
          {canCancel && data.isCancellable && (
            <Button variant="destructive" onClick={onCancel} disabled={cancel.isPending}>
              {cancel.isPending ? t('cancelling') : t('cancel')}
            </Button>
          )}
        </div>
      </div>

      {actionError && <p className="text-sm text-destructive">{actionError}</p>}

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-md border bg-card p-4">
          <dt className="text-xs text-muted-foreground">{t('field.expiresAt')}</dt>
          <dd className="mt-1 text-sm font-medium">{data.expiresRelative}</dd>
        </div>
        {data.signedRelative && (
          <div className="rounded-md border bg-card p-4">
            <dt className="text-xs text-muted-foreground">{t('field.signedAt')}</dt>
            <dd className="mt-1 text-sm font-medium">{data.signedRelative}</dd>
          </div>
        )}
        {data.cancelledRelative && (
          <div className="rounded-md border bg-card p-4">
            <dt className="text-xs text-muted-foreground">{t('field.cancelledAt')}</dt>
            <dd className="mt-1 text-sm font-medium">{data.cancelledRelative}</dd>
          </div>
        )}
        <div className="rounded-md border bg-card p-4">
          <dt className="text-xs text-muted-foreground">{t('field.documentId')}</dt>
          <dd className="mt-1 font-mono text-xs" dir="ltr">
            {data.documentId}
          </dd>
        </div>
        <div className="rounded-md border bg-card p-4">
          <dt className="text-xs text-muted-foreground">{t('field.ownerId')}</dt>
          <dd className="mt-1 font-mono text-xs" dir="ltr">
            {data.ownerId}
          </dd>
        </div>
      </dl>
    </div>
  );
}
