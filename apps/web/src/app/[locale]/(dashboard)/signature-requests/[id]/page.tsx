'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { ListSkeleton } from '@/components/ui/list-skeleton';
import { StatusBadge } from '@/components/ui/status-badge';
import { useHasPermission } from '@/hooks/use-permissions';
import { useSessionProfile } from '@/hooks/use-session';
import {
  useCancelSignatureRequest,
  useRetrieveSignatureLink,
  useSignatureRequest,
} from '@/hooks/use-signature-requests';
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
  const retrieveLink = useRetrieveSignatureLink();
  const { confirm, dialog: confirmDialog } = useConfirm();
  // The signed certificate carries decrypted owner PII (signer name + the
  // signature), so the download button is gated on the SAME signal as the
  // owner-detail PII reveal: `/me.view_owner_pii` (manager always · agent iff
  // capability granted · viewer never) — mirrors the BE fidelity gate, so the
  // button never shows for someone the endpoint would 403.
  const { data: profile } = useSessionProfile();
  const canDownloadSigned = profile?.view_owner_pii === true;
  const canCancel = useHasPermission('signature_requests.cancel');
  // P4 phone-less-owner path: a manager/authorized agent can RETRIEVE the
  // signing link to deliver it out-of-band. Same coarse gate as the send path
  // (the BE is authoritative — `.send` + the manage_signatures capability); a
  // read-only Viewer must never see this control (the signUrl is a bearer cred).
  const canRetrieveLink = useHasPermission('signature_requests.send');
  const [actionError, setActionError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  // Transient "copied" confirmation. We NEVER render the raw signUrl — it is a
  // bearer credential; copy-to-clipboard is the only surface, and the flag
  // resets after a few seconds so the page holds no signal of the live token.
  const [linkCopied, setLinkCopied] = useState(false);

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

  async function onCopySigningLink() {
    if (!id) return;
    setActionError(null);
    setLinkCopied(false);
    try {
      const { signUrl } = await retrieveLink.mutateAsync(id);
      // Copy immediately; never store signUrl in state / render it in the DOM.
      await navigator.clipboard.writeText(signUrl);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 4000);
    } catch (e) {
      if (e instanceof ApiClientError) {
        if (e.code === 'signature_request_not_pending') {
          setActionError(t('copyLinkNotPending'));
        } else if (e.code === 'forbidden') {
          setActionError(t('forbidden'));
        } else {
          setActionError(t('copyLinkFailed'));
        }
      } else {
        // clipboard write rejection or network — generic, no signUrl leaked.
        setActionError(t('copyLinkFailed'));
      }
    }
  }

  async function onCancel() {
    if (!id) return;
    setActionError(null);
    if (!(await confirm({ message: t('cancelConfirm'), destructive: true }))) return;
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
            <StatusBadge intent={data.intent}>{data.statusLabel}</StatusBadge>
            {data.isExpired && <span className="badge badge-danger">{t('expired')}</span>}
          </div>
          <p className="text-xs text-muted-foreground">
            {t('createdAt', { rel: data.createdRelative })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canRetrieveLink && data.status === 'pending' && (
            <Button variant="outline" onClick={onCopySigningLink} disabled={retrieveLink.isPending}>
              {retrieveLink.isPending
                ? t('copyLinkWorking')
                : linkCopied
                  ? t('copyLinkCopied')
                  : t('copyLink')}
            </Button>
          )}
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

      {canRetrieveLink && data.status === 'pending' && (
        <p className="text-xs text-muted-foreground">{t('copyLinkHint')}</p>
      )}
      {linkCopied && <p className="text-xs text-status-success-fg">{t('copyLinkConfirm')}</p>}

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
      {confirmDialog}
    </div>
  );
}
