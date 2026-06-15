'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useDocumentList } from '@/hooks/use-documents';
import { useOwnerList } from '@/hooks/use-owners';
import { useApartmentOwners } from '@/hooks/use-ownerships';
import { useCreateSignatureRequest } from '@/hooks/use-signature-requests';
import { ApiClientError } from '@/lib/api/projects';

export default function NewSignatureRequestPage() {
  const t = useTranslations('signatureRequests');
  const tp = useTranslations('projects');
  const router = useRouter();
  const documents = useDocumentList({ limit: 100 });
  const owners = useOwnerList({ limit: 100 });
  const create = useCreateSignatureRequest();
  const [documentId, setDocumentId] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [signUrl, setSignUrl] = useState<string | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const documentItems = documents.data?.items ?? [];

  // The server only accepts a recipient who OWNS the document's apartment
  // (recipient_not_associated otherwise). So scope the owner dropdown to that
  // apartment's owners — a wrong pick becomes impossible instead of a cryptic
  // failure. A project-scoped document (no apartment) falls back to all owners.
  const selectedDoc = documentItems.find((d) => d.id === documentId);
  const apartmentId = selectedDoc?.apartmentId ?? null;
  const apartmentOwners = useApartmentOwners(apartmentId ?? undefined);
  // Normalise both sources to { id, name } — apartment owners are
  // OwnershipViewModel ({ ownerId, displayName }); the all-owners fallback is
  // OwnerViewModel ({ id, name }).
  const ownerItems: { id: string; name: string }[] = apartmentId
    ? (apartmentOwners.data?.items ?? []).map((o) => ({ id: o.ownerId, name: o.displayName }))
    : (owners.data?.items ?? []).map((o) => ({
        id: o.id,
        name: o.name ?? t('field.unnamedOwner'),
      }));
  const ownerSelectDisabled =
    !documentId || (apartmentId ? apartmentOwners.isLoading : owners.isLoading);

  // Clear a stale recipient when the document (and therefore the eligible
  // owners) changes.
  useEffect(() => {
    setOwnerId('');
  }, [documentId]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!documentId) return setError(t('pickDocument'));
    if (!ownerId) return setError(t('pickOwner'));
    try {
      const res = await create.mutateAsync({ documentId, ownerId });
      setSignUrl(res.signUrl);
      setRequestId(res.request.id);
    } catch (e) {
      if (e instanceof ApiClientError) {
        if (e.code === 'signature_request_pending_exists') setError(t('pendingExists'));
        else if (e.code === 'recipient_not_associated') setError(t('recipientNotAssociated'));
        else if (e.code === 'storage_unavailable') setError(t('storageUnavailable'));
        else if (e.code === 'validation_error') setError(t('validationError'));
        else if (e.code === 'forbidden') setError(t('forbidden'));
        else setError(t('createFailed'));
      } else {
        setError(t('createFailed'));
      }
    }
  }

  async function copyToClipboard() {
    if (!signUrl) return;
    try {
      await navigator.clipboard.writeText(signUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  if (signUrl && requestId) {
    return (
      <div className="mx-auto max-w-xl space-y-4" dir="rtl">
        <h1 className="text-2xl font-bold">{t('createdTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('createdHint')}</p>
        <div className="space-y-2 rounded-md border bg-card p-4">
          <label className="text-xs font-medium text-muted-foreground">{t('signUrlLabel')}</label>
          {/* dir=ltr so the URL renders left-to-right regardless of doc direction */}
          <input
            type="text"
            value={signUrl}
            readOnly
            dir="ltr"
            onFocus={(e) => e.currentTarget.select()}
            className="w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
          />
          <div className="flex gap-2">
            <Button type="button" onClick={copyToClipboard}>
              {copied ? t('copied') : t('copy')}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => router.push(`/signature-requests/${requestId}`)}
            >
              {t('viewRequest')}
            </Button>
          </div>
        </div>
        <p className="text-xs text-destructive">{t('signUrlWarning')}</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl space-y-6" dir="rtl">
      <h1 className="text-2xl font-bold">{t('create')}</h1>
      <p className="text-xs text-muted-foreground">{t('createHint')}</p>
      {/* §S5-SEC1 — method="post" defense in depth (see login/page.tsx). */}
      <form method="post" action="" onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="document" className="text-sm font-medium">
            {t('field.document')}
          </label>
          <select
            id="document"
            value={documentId}
            onChange={(e) => setDocumentId(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            disabled={documents.isLoading}
          >
            <option value="" disabled>
              {t('field.documentPlaceholder')}
            </option>
            {documentItems.map((d) => (
              // §SEC-M4 — dir="auto" gives <option> partial bidi
              // isolation (HTML5; valid; no JS). NameDisplay can't be
              // a child of <option>.
              <option key={d.id} value={d.id} dir="auto">
                {d.name}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label htmlFor="owner" className="text-sm font-medium">
            {t('field.owner')}
          </label>
          <select
            id="owner"
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            disabled={ownerSelectDisabled}
          >
            <option value="" disabled>
              {!documentId ? t('field.ownerNeedsDocument') : t('field.ownerPlaceholder')}
            </option>
            {ownerItems.map((o) => (
              // §SEC-M4 — dir="auto" gives <option> partial bidi
              // isolation. NameDisplay can't be a child of <option>;
              // RLS guarantees no cross-org leakage of names but
              // intra-org bidi spoofing is still possible.
              <option key={o.id} value={o.id} dir="auto">
                {o.name}
              </option>
            ))}
          </select>
          {documentId && apartmentId && ownerItems.length === 0 && !apartmentOwners.isLoading && (
            <p className="text-xs text-muted-foreground">{t('field.noApartmentOwners')}</p>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => router.back()}>
            {tp('cancel')}
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? t('creating') : t('create')}
          </Button>
        </div>
      </form>
    </div>
  );
}
