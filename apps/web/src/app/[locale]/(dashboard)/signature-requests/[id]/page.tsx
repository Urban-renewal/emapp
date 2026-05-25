'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useCancelSignatureRequest, useSignatureRequest } from '@/hooks/use-signature-requests';
import { ApiClientError } from '@/lib/api/projects';
import { cn } from '@/lib/utils';

const STATUS_BADGE: Record<'gray' | 'amber' | 'emerald' | 'red', string> = {
  gray: 'bg-gray-100 text-gray-700',
  amber: 'bg-amber-100 text-amber-800',
  emerald: 'bg-emerald-100 text-emerald-800',
  red: 'bg-red-100 text-red-800',
};

export default function SignatureRequestDetailPage() {
  const t = useTranslations('signatureRequests');
  const tp = useTranslations('projects');
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const { data, isLoading, isError, error } = useSignatureRequest(id);
  const cancel = useCancelSignatureRequest();
  const [actionError, setActionError] = useState<string | null>(null);

  if (isLoading) return <p className="text-sm text-muted-foreground">{t('loading')}</p>;
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
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-xs font-medium',
                STATUS_BADGE[data.statusColor],
              )}
            >
              {data.statusLabel}
            </span>
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
        {data.isCancellable && (
          <Button variant="destructive" onClick={onCancel} disabled={cancel.isPending}>
            {cancel.isPending ? t('cancelling') : t('cancel')}
          </Button>
        )}
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
