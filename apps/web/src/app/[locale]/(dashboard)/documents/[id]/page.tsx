'use client';

import { DOCUMENT_SCAN_REJECTED_CODE, DOCUMENT_UPLOAD_INCOMPLETE_CODE } from '@emapp/shared-types';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { isStepUpCancelled, useStepUpUnlock } from '@/components/step-up-unlock';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
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
  // 7c F1 — sensitive docs answer 403 `pii_step_up_required` until the
  // session holds a fresh PII unlock; the hook opens the OTP dialog and
  // retries the download (replacing the bare "ההורדה נכשלה." for that code).
  const stepUp = useStepUpUnlock();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [actionError, setActionError] = useState<string | null>(null);
  // OUTCOME feedback (Phase 2b) — a successful View/Download must VISIBLY change
  // the page (the "fired but shows nothing" bug). This transient line is set on
  // success and cleared the next time an action starts.
  const [actionStatus, setActionStatus] = useState<string | null>(null);
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
  // 7d — a SENSITIVE doc's /download answers the decrypt-streamed BYTES
  // instead of JSON (a presigned URL would serve ciphertext); the hook
  // returns `{ kind: 'bytes', blob, filename }` and we open/save a local
  // object URL per the same disposition.
  async function openWithDisposition(disposition: 'inline' | 'attachment') {
    if (!id) return;
    setActionError(null);
    setActionStatus(null);
    setPendingDisposition(disposition);
    try {
      // 7c F1 — on 403 pii_step_up_required the unlock dialog opens
      // (request→code→verify) and the download is retried once. All other
      // errors keep their existing handling below.
      const result = await stepUp.withStepUp(() => download.mutateAsync({ id, disposition }));
      if (result.kind === 'presign') {
        // §RED-1 defense-in-depth — schema-level scheme allowlist is the
        // primary defense (DocumentDownloadResponseSchema.url is
        // HttpsUrlSchema), but we re-verify the protocol here before
        // calling window.open. A javascript:/data: URL that somehow
        // slipped past would otherwise execute attacker JS in the
        // opener's brief about:blank inheritance window.
        if (!/^https:\/\//i.test(result.url)) {
          setActionError(t('downloadFailed'));
          return;
        }
        // Open in a new tab — the URL is a short-lived presigned GET,
        // honored by R2 with the requested Content-Disposition server-side.
        // `inline` → a viewable new tab; `attachment` → R2 serves it as a
        // save-dialog, so the tab self-closes and the OUTCOME is a download.
        const opened = openInNewTab(result.url);
        reportOpenOutcome(opened, disposition);
        return;
      }
      // 7d bytes leg — local blob: URL only (never a remote URL, so no
      // scheme re-check applies). The Blob keeps the response mime, so
      // `inline` renders the PDF/image in the new tab.
      const opened = openByteStream(result.blob, result.filename, disposition, id);
      reportOpenOutcome(opened, disposition);
    } catch (e) {
      // 7c F1 — the user dismissed the step-up dialog: not a failure, no
      // error line (they can click הצג/הורד again whenever they're ready).
      if (isStepUpCancelled(e)) {
        return;
      }
      // 0050 (ghost-doc UX) — the BE returns the distinct
      // `document_upload_incomplete` code ONLY for the owner's own
      // never-finalised doc (a foreign id stays a generic 404). Surface the
      // actionable "re-upload" message instead of a generic failure.
      if (e instanceof ApiClientError && e.code === DOCUMENT_UPLOAD_INCOMPLETE_CODE) {
        setActionError(t('uploadIncomplete'));
        return;
      }
      // 7d — a doc the AV gate rejected is never servable (fail-closed
      // 409). Distinct, actionable copy instead of the generic failure.
      if (e instanceof ApiClientError && e.code === DOCUMENT_SCAN_REJECTED_CODE) {
        setActionError(t('scanRejected'));
        return;
      }
      setActionError(t('downloadFailed'));
    } finally {
      setPendingDisposition(null);
    }
  }

  // OUTCOME line — translate the open result into the visible page change the
  // user needs: a success status ("opened in a new tab" / "download started")
  // OR, when the new tab never opened, the actionable pop-up-blocked guidance.
  // `attachment` that resolved to a presigned URL still opens a (self-closing)
  // tab, so a blocked pop-up is a real failure there too.
  function reportOpenOutcome(opened: boolean, disposition: 'inline' | 'attachment') {
    if (!opened) {
      setActionError(t('detail.popupBlocked'));
      return;
    }
    setActionStatus(
      disposition === 'inline' ? t('detail.openedNewTab') : t('detail.downloadStarted'),
    );
  }

  async function onArchive() {
    if (!id) return;
    setActionError(null);
    if (!(await confirm({ message: t('archiveConfirm'), destructive: true }))) return;
    try {
      await archive.mutateAsync(id);
      router.push('/documents');
    } catch {
      setActionError(t('archiveFailed'));
    }
  }

  // Scan-status → badge variant. `clean` is the only servable/calm state;
  // `infected`/`error` are blocking (danger); `pending` is in-progress (neutral).
  const scanBadgeVariant =
    data.scanStatus === 'clean'
      ? 'badge-success'
      : data.scanStatus === 'infected' || data.scanStatus === 'error'
        ? 'badge-danger'
        : 'badge-neutral';

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
            <span className="badge badge-neutral inline-block">{tp('archived')}</span>
          )}
        </div>
        {!data.isArchived && (
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex items-center gap-2">
              {canDownload && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openWithDisposition('inline')}
                  disabled={download.isPending}
                >
                  {pendingDisposition === 'inline' ? t('opening') : t('view')}
                </Button>
              )}
              {canDownload && (
                <Button
                  size="sm"
                  onClick={() => openWithDisposition('attachment')}
                  disabled={download.isPending}
                >
                  {pendingDisposition === 'attachment' ? t('downloading') : t('download')}
                </Button>
              )}
              {canArchive && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onArchive}
                  disabled={archive.isPending}
                >
                  {archive.isPending ? tp('archiving') : tp('archive')}
                </Button>
              )}
            </div>
            {/* A sensitive doc's View/Download triggers a step-up OTP — say so
                up front so the unlock prompt is expected, not a surprise. */}
            {canDownload && data.isSensitive && (
              <p className="text-xs text-muted-foreground">🔒 {t('detail.stepUpHint')}</p>
            )}
          </div>
        )}
      </div>

      {/* OUTCOME — a transient success line so View/Download VISIBLY change the
          page (the "fired but shows nothing" bug). aria-live announces it. */}
      {actionStatus && (
        <p
          className="text-sm"
          style={{ color: 'var(--success-700)' }}
          role="status"
          aria-live="polite"
        >
          {actionStatus}
        </p>
      )}
      {actionError && (
        <p className="text-sm text-destructive" role="status" aria-live="polite">
          {actionError}
        </p>
      )}

      {/* METADATA BLOCK — situation-picture-at-a-glance: is this doc PII, has it
          cleared the AV scan, and which project/apartment does it belong to. */}
      <div className="card space-y-3 p-4">
        <h2 className="text-sm font-semibold text-muted-foreground">{t('detail.metaTitle')}</h2>
        <div className="flex flex-wrap items-center gap-2">
          {data.isSensitive && (
            <span className="badge badge-warning" title={t('detail.sensitiveHint')}>
              <span className="badge-dot" aria-hidden="true" />
              {t('detail.sensitive')}
            </span>
          )}
          <span className={`badge ${scanBadgeVariant}`}>
            <span className="badge-dot" aria-hidden="true" />
            {t('detail.scanLabel')}: {data.scanStatusLabel}
          </span>
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
          <div className="flex items-center gap-2">
            <dt className="text-muted-foreground">{t('detail.parentProject')}:</dt>
            <dd>
              {data.projectId && data.projectName ? (
                <Link href={`/projects/${data.projectId}`} className="underline">
                  <NameDisplay name={data.projectName} />
                </Link>
              ) : (
                <span className="text-muted-foreground">{t('detail.noParent')}</span>
              )}
            </dd>
          </div>
          {data.apartmentName && (
            <div className="flex items-center gap-2">
              <dt className="text-muted-foreground">{t('detail.parentApartment')}:</dt>
              <dd>
                <NameDisplay name={data.apartmentName} />
              </dd>
            </div>
          )}
        </dl>
      </div>

      {/* ARCHIVED affordance — not a silent dead-end. The BE fail-closes
          get/download on an archived doc (loadVisible throws NOT_FOUND), so the
          bytes are genuinely NOT servable here; explain that + point to the
          archived list (where a restore path lives) instead of vanished buttons.
          No restore endpoint exists on documents today, so we don't fake one. */}
      {data.isArchived && (
        <div className="card space-y-2 p-4">
          <h2 className="text-sm font-semibold">{t('detail.archivedTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('detail.archivedBody')}</p>
          <Button variant="outline" size="sm" onClick={() => router.push('/documents')}>
            {t('detail.archivedToList')}
          </Button>
        </div>
      )}

      {/* 7c F1 — the step-up unlock modal (renders null while closed). */}
      {stepUp.dialog}
      {confirmDialog}
    </div>
  );
}

/** How long an `inline` blob: URL stays alive before revocation — long
 *  enough for the new tab to start reading it (revoking synchronously
 *  races the tab's load and blanks it), short enough not to retain a
 *  50MB blob for the whole session. */
const INLINE_BLOB_REVOKE_MS = 60_000;

/**
 * Open a URL in a new tab AND report whether it actually opened (so the page
 * can show the OUTCOME / a pop-up-blocked hint).
 *
 * Why not `window.open(url, '_blank', 'noopener,noreferrer')`: with `noopener`
 * in the feature string the call returns `null` on SUCCESS too, so the return
 * value can't distinguish "opened" from "blocked". Instead we open WITHOUT the
 * feature and immediately sever the opener link by nulling `win.opener` — which
 * gives the exact anti-tabnabbing guarantee `noopener` provides (the new tab
 * can't reach back into `window.opener`) while still letting us read the handle.
 * A `null` handle now unambiguously means the browser blocked the pop-up.
 *
 * The presigned/blob URL is validated by the caller (https-only re-check for
 * presigns; blob: is a same-origin local object URL) before reaching here.
 */
function openInNewTab(url: string): boolean {
  const win = window.open(url, '_blank');
  if (!win) return false;
  // Sever the opener reference — equivalent to `noopener`, but applied after we
  // captured the handle so block-detection still works. Wrapped defensively:
  // a cross-origin tab may make `opener` read-only in some engines.
  try {
    win.opener = null;
  } catch {
    // best-effort; the tab still opened.
  }
  return true;
}

/**
 * 7d — open/save a decrypt-streamed sensitive document. Mirrors the
 * ExportXlsxButton blob pattern:
 *  - `attachment` → synthetic <a download> click (created + clicked +
 *    removed in one tick; the href is a local blob: URL, never remote)
 *    then immediate revoke.
 *  - `inline` → window.open on the blob: URL (the Blob carries the
 *    response mime, so PDFs/images render in-tab) + delayed revoke.
 * Filename comes from the BE Content-Disposition header (authoritative,
 * Hebrew-safe via RFC 5987) — never from the user-supplied display name
 * (PII / U+202E spoof rationale, see export-xlsx-button.tsx). Fallback is
 * the ASCII-safe document id.
 *
 * Returns whether the user-visible action started: `attachment` is a synthetic
 * <a download> click (never pop-up-blocked → always true); `inline` opens a tab
 * and returns false if the browser blocked the pop-up (the caller then shows
 * the "allow pop-ups" hint instead of a bogus success line).
 */
function openByteStream(
  blob: Blob,
  filename: string | null,
  disposition: 'inline' | 'attachment',
  id: string,
): boolean {
  const objectUrl = URL.createObjectURL(blob);
  if (disposition === 'attachment') {
    try {
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename ?? `document-${id}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
    return true;
  }
  const opened = openInNewTab(objectUrl);
  if (opened) {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), INLINE_BLOB_REVOKE_MS);
  } else {
    // Blocked → no tab will read it; revoke now so we don't leak the blob.
    URL.revokeObjectURL(objectUrl);
  }
  return opened;
}
