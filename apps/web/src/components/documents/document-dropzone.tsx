'use client';

/**
 * S3 — the ONE generic, scope-aware document dropzone.
 *
 * Replaces BOTH the old flat 19-option `<select>` (documents/new) and the
 * hardcoded `type:'agreement'` project upload. The human picks a FILE; the system
 * files it correctly — manual category-picking happens ONLY on genuine ambiguity.
 *
 * REUSES the canonical seams (composes, never re-implements):
 *   - scope = the page you stand on (free, never asked) — `scope` prop.
 *   - `POST /documents/classify` (DH3) via useDocumentClassify → confidence bands
 *     (lib/document-classify.ts): AUTO ≥0.85 / CONFIRM 0.5–0.85 / ASK <0.5.
 *   - `POST /documents/dedup-check` (DH4) via useDocumentDedup (same sha256 the
 *     upload flow declares) → "קשר לקיים" vs "העלה בכל זאת".
 *   - `useUploadDocument` (the canonical create→PUT→finalize / sensitive content
 *     path) PRE-SCOPED to the page's project/apartment/org.
 *   - SENSITIVE_DOC_TYPES (shared-types) → sensitive types ALWAYS pause for the
 *     encrypt notice (content path), even at AUTO confidence.
 *   - party is DERIVED (providerPartyForDocType) — never asked.
 */
import {
  DOCUMENT_MAX_SIZE_BYTES,
  DOCUMENT_SCAN_REJECTED_CODE,
  DocumentMimeEnum,
  DocumentTypeEnum,
  isSensitiveDocType,
  type DocumentMime,
  type DocumentType,
} from '@emapp/shared-types';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useMemo, useRef, useState } from 'react';

import { DOCUMENT_TYPE_LABELS_EN, DOCUMENT_TYPE_LABELS_HE } from '@/adapters/document';
import { useToast } from '@/components/ui/action-toast';
import { useDocumentClassify } from '@/hooks/use-document-classify';
import { useDocumentDedup } from '@/hooks/use-document-dedup';
import { useArchiveDocument, useUploadDocument } from '@/hooks/use-documents';
import { integrityMismatchField } from '@/lib/api/documents';
import { ApiClientError } from '@/lib/api/errors';
import { decideBand, type ClassifyBand } from '@/lib/document-classify';
import { useDisplayLocale } from '@/lib/locale';

const ALLOWED_MIMES = new Set<DocumentMime>(DocumentMimeEnum.options);
const ALL_DOC_TYPES: DocumentType[] = [...DocumentTypeEnum.options];

/** The page-context scope (free — derived from the route, never asked). */
export type DropzoneScope = 'org' | 'project' | 'apartment';

export interface DocumentDropzoneProps {
  scope: DropzoneScope;
  /** Set when scope === 'project' (the page's project). */
  projectId?: string;
  /** Set when scope === 'apartment' (the page's apartment). */
  apartmentId?: string;
  /** The scope's MISSING required types ("חסר כאן") — surfaced FIRST in CONFIRM's
   *  "שינוי" picker and in the ASK band, so the human picks from what's actually
   *  needed here, not all 19. Each page computes it from data it already holds
   *  (project → checklist `missing`; org → board unmet types). */
  gapTypes?: DocumentType[];
  /** Deep-link pre-fill (S2 board links here): `?type=` pre-selects a type and
   *  shorts straight to CONFIRM, skipping classify. */
  prefillType?: DocumentType | null;
  /** Fired after a successful upload with the created doc id + resolved type.
   *  documents/new routes to the doc; the project page toasts + stays. */
  onUploaded?: (result: { id: string; type: DocumentType }) => void;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'analyzing'; file: File; mimeType: DocumentMime }
  | {
      kind: 'decide';
      file: File;
      mimeType: DocumentMime;
      band: ClassifyBand;
      suggestedType: DocumentType | null;
      sensitive: boolean;
      /** A dedup hit (an existing doc with the same content) — offer link-or-upload. */
      duplicateId: string | null;
      /** ASK/CONFIRM-"שינוי" expanded the full type list (beyond the gaps). */
      showAll: boolean;
    }
  | { kind: 'uploading'; file: File }
  | { kind: 'error'; message: string };

function isAllowedMime(t: string): t is DocumentMime {
  return ALLOWED_MIMES.has(t as DocumentMime);
}

export function DocumentDropzone({
  scope,
  projectId,
  apartmentId,
  gapTypes = [],
  prefillType = null,
  onUploaded,
}: DocumentDropzoneProps) {
  const t = useTranslations('documents.dropzone');
  const locale = useDisplayLocale();
  const router = useRouter();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  const classify = useDocumentClassify();
  const dedup = useDocumentDedup();
  const upload = useUploadDocument();
  const archive = useArchiveDocument();

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const labels = locale === 'he' ? DOCUMENT_TYPE_LABELS_HE : DOCUMENT_TYPE_LABELS_EN;
  const labelFor = useCallback((dt: DocumentType): string => labels[dt] ?? dt, [labels]);

  // Pre-scope the upload to the page (free — the scope is the route).
  const uploadScope = useMemo(
    () => ({
      projectId: scope === 'project' ? (projectId ?? null) : null,
      apartmentId: scope === 'apartment' ? (apartmentId ?? null) : null,
    }),
    [scope, projectId, apartmentId],
  );

  /** Run the canonical upload (create→PUT→finalize / sensitive content path),
   *  pre-scoped, then notify. A SENSITIVE type is derived server-side from the
   *  type — the create response routes the content path automatically. */
  const doUpload = useCallback(
    async (file: File, mimeType: DocumentMime, type: DocumentType) => {
      setPhase({ kind: 'uploading', file });
      try {
        const doc = await upload.mutateAsync({ file, type, mimeType, ...uploadScope });
        setPhase({ kind: 'idle' });
        if (inputRef.current) inputRef.current.value = '';
        onUploaded?.({ id: doc.id, type });
      } catch (e) {
        setPhase({ kind: 'error', message: uploadErrorMessage(e, t) });
        if (inputRef.current) inputRef.current.value = '';
      }
    },
    [upload, uploadScope, onUploaded, t],
  );

  /** AUTO band, non-sensitive, no dedup hit → file silently, then an undo toast
   *  ("שויך כ-{type} · בטל"). Undo archives the just-created doc. */
  const doAutoFile = useCallback(
    async (file: File, mimeType: DocumentMime, type: DocumentType) => {
      setPhase({ kind: 'uploading', file });
      try {
        const doc = await upload.mutateAsync({ file, type, mimeType, ...uploadScope });
        setPhase({ kind: 'idle' });
        if (inputRef.current) inputRef.current.value = '';
        toast.show({
          message: t('autoFiled', { type: labelFor(type) }),
          undo: {
            label: t('undo'),
            onUndo: () => archive.mutateAsync(doc.id),
          },
        });
        onUploaded?.({ id: doc.id, type });
      } catch (e) {
        setPhase({ kind: 'error', message: uploadErrorMessage(e, t) });
        if (inputRef.current) inputRef.current.value = '';
      }
    },
    [upload, uploadScope, toast, t, labelFor, archive, onUploaded],
  );

  const onPick = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0] ?? null;
      if (!file) return;
      if (!isAllowedMime(file.type)) {
        setPhase({ kind: 'error', message: t('mimeNotAllowed') });
        if (inputRef.current) inputRef.current.value = '';
        return;
      }
      const mimeType = file.type;
      if (file.size > DOCUMENT_MAX_SIZE_BYTES) {
        setPhase({ kind: 'error', message: t('tooLarge') });
        if (inputRef.current) inputRef.current.value = '';
        return;
      }

      // Deep-link pre-fill short-circuits classify: the board already chose the
      // type. Still run dedup. Go straight to CONFIRM (the human confirms/changes).
      if (prefillType) {
        setPhase({ kind: 'analyzing', file, mimeType });
        const dup = await safeDedup(dedup, file);
        setPhase({
          kind: 'decide',
          file,
          mimeType,
          band: 'confirm',
          suggestedType: prefillType,
          sensitive: isSensitiveDocType(prefillType),
          duplicateId: dup,
          showAll: false,
        });
        return;
      }

      setPhase({ kind: 'analyzing', file, mimeType });
      // Classify + dedup in parallel (both advisory; either failing degrades, never
      // blocks). Dedup reuses the SAME sha256 the upload flow declares.
      const [decision, dup] = await Promise.all([
        safeClassify(classify, file, mimeType),
        safeDedup(dedup, file),
      ]);

      // AUTO (non-sensitive, no duplicate) → file silently with the undo toast.
      if (decision.band === 'auto' && decision.suggestedType && !decision.sensitive && !dup) {
        void doAutoFile(file, mimeType, decision.suggestedType);
        return;
      }

      setPhase({
        kind: 'decide',
        file,
        mimeType,
        band: decision.band,
        suggestedType: decision.suggestedType,
        sensitive: decision.sensitive,
        duplicateId: dup,
        showAll: false,
      });
    },
    [prefillType, classify, dedup, doAutoFile, t],
  );

  function reset() {
    setPhase({ kind: 'idle' });
    if (inputRef.current) inputRef.current.value = '';
  }

  const busy = phase.kind === 'analyzing' || phase.kind === 'uploading' || upload.isPending;

  return (
    <div className="space-y-3" dir={locale === 'he' ? 'rtl' : 'ltr'}>
      <input
        ref={inputRef}
        id="document-dropzone-input"
        type="file"
        onChange={onPick}
        disabled={busy}
        data-testid="document-dropzone-input"
        accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.xlsx,.xls,.csv,.docx,.doc,.txt"
        className="hidden"
      />

      {/* The pick affordance — always present unless mid-decision. */}
      {(phase.kind === 'idle' || phase.kind === 'error') && (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          data-testid="document-dropzone-pick"
          className="btn btn-primary"
        >
          {t('pick')}
        </button>
      )}

      {phase.kind === 'analyzing' && (
        <p role="status" aria-live="polite" className="text-sm text-text-muted">
          {t('analyzing')}
        </p>
      )}

      {phase.kind === 'uploading' && (
        <p role="status" aria-live="polite" className="text-sm text-text-muted">
          {t('uploading')}
        </p>
      )}

      {phase.kind === 'decide' && (
        <DecidePanel
          phase={phase}
          gapTypes={gapTypes}
          labelFor={labelFor}
          onChoose={(type) => void doUpload(phase.file, phase.mimeType, type)}
          onShowAll={() => setPhase({ ...phase, showAll: true })}
          onLinkExisting={(id) => {
            reset();
            router.push(`/documents/${id}`);
          }}
          onCancel={reset}
          t={t}
        />
      )}

      {phase.kind === 'error' && (
        <p role="alert" className="text-sm text-danger-700" data-testid="document-dropzone-error">
          {phase.message}
        </p>
      )}
    </div>
  );
}

/** The band-driven decision UI. CONFIRM pre-selects the top type; "שינוי" opens
 *  the gaps-here list (then "אחר" → all 19). ASK leads with the gaps. SENSITIVE
 *  always shows the encrypt notice. A dedup hit offers link-or-upload first. */
function DecidePanel({
  phase,
  gapTypes,
  labelFor,
  onChoose,
  onShowAll,
  onLinkExisting,
  onCancel,
  t,
}: {
  phase: Extract<Phase, { kind: 'decide' }>;
  gapTypes: DocumentType[];
  labelFor: (dt: DocumentType) => string;
  onChoose: (type: DocumentType) => void;
  onShowAll: () => void;
  onLinkExisting: (id: string) => void;
  onCancel: () => void;
  t: (k: string, v?: Record<string, string>) => string;
}) {
  const { band, suggestedType, sensitive, duplicateId, showAll, file } = phase;

  // De-duped "gaps here" first, then (when expanded / ASK with no gaps) all types.
  const gapList = gapTypes.filter((g) => g !== suggestedType);
  const restTypes = ALL_DOC_TYPES.filter((dt) => dt !== suggestedType && !gapList.includes(dt));

  return (
    <div
      className="space-y-3 rounded-md border p-3"
      data-testid="document-dropzone-decide"
      style={{ borderColor: 'var(--border)', background: 'var(--bg-surface)' }}
    >
      <p className="text-xs text-text-muted">{file.name}</p>

      {/* Dedup — an identical document already exists in scope. */}
      {duplicateId && (
        <div
          className="space-y-2 rounded-md border p-2"
          data-testid="document-dropzone-dedup"
          style={{ borderColor: 'var(--warning-300, var(--border))' }}
        >
          <p className="text-sm">{t('dedup.title')}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onLinkExisting(duplicateId)}
              data-testid="document-dropzone-link-existing"
            >
              {t('dedup.link')}
            </button>
            {/* "העלה בכל זאת" just falls through to the normal band UI below. */}
          </div>
        </div>
      )}

      {sensitive && (
        <p
          className="rounded-md p-2 text-sm"
          data-testid="document-dropzone-sensitive-notice"
          style={{
            background: 'var(--warning-50, var(--bg-surface))',
            color: 'var(--warning-700)',
          }}
        >
          {t('sensitiveNotice')}
        </p>
      )}

      {/* CONFIRM — a single strong suggestion to accept or change. */}
      {band === 'confirm' && suggestedType && !showAll && (
        <div className="space-y-2">
          <p className="text-sm">{t('confirm.prompt', { type: labelFor(suggestedType) })}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => onChoose(suggestedType)}
              data-testid="document-dropzone-confirm"
            >
              {sensitive ? t('confirm.acceptSensitive') : t('confirm.accept')}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onShowAll}
              data-testid="document-dropzone-change"
            >
              {t('confirm.change')}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
              {t('cancel')}
            </button>
          </div>
        </div>
      )}

      {/* ASK (or CONFIRM after "שינוי") — pick from the gaps-here first, then all. */}
      {(band === 'ask' || (band === 'confirm' && showAll)) && (
        <div className="space-y-2">
          <p className="text-sm">{t('ask.prompt')}</p>
          {gapList.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-text-muted">{t('ask.gapsHere')}</p>
              <div className="flex flex-wrap gap-2">
                {gapList.map((dt) => (
                  <TypeChip key={dt} type={dt} label={labelFor(dt)} onChoose={onChoose} />
                ))}
              </div>
            </div>
          )}
          {/* The full list — the "אחר" escape hatch, never the default. */}
          {showAll || gapList.length === 0 ? (
            <div className="space-y-1">
              <p className="text-xs text-text-muted">{t('ask.other')}</p>
              <div className="flex flex-wrap gap-2">
                {(suggestedType ? [suggestedType, ...restTypes] : restTypes).map((dt) => (
                  <TypeChip key={dt} type={dt} label={labelFor(dt)} onChoose={onChoose} />
                ))}
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={onShowAll}
              data-testid="document-dropzone-show-all"
            >
              {t('ask.showAll')}
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            {t('cancel')}
          </button>
        </div>
      )}
    </div>
  );
}

function TypeChip({
  type,
  label,
  onChoose,
}: {
  type: DocumentType;
  label: string;
  onChoose: (type: DocumentType) => void;
}) {
  return (
    <button
      type="button"
      className="btn btn-secondary btn-sm"
      onClick={() => onChoose(type)}
      data-testid={`document-dropzone-type-${type}`}
    >
      {label}
    </button>
  );
}

/** Classify, degrading to ASK on any failure (advisory — never a blocker). */
async function safeClassify(
  classify: ReturnType<typeof useDocumentClassify>,
  file: File,
  mimeType: DocumentMime,
) {
  try {
    const result = await classify.mutateAsync({ file, mimeType });
    return decideBand(result);
  } catch {
    return { band: 'ask' as ClassifyBand, suggestedType: null, confidence: 0, sensitive: false };
  }
}

/** Dedup, degrading to "no duplicate" on any failure (advisory — a failed probe
 *  must NEVER stop a legitimate upload). Returns the first duplicate's id or null. */
async function safeDedup(
  dedup: ReturnType<typeof useDocumentDedup>,
  file: File,
): Promise<string | null> {
  try {
    const res = await dedup.mutateAsync(file);
    return res.hasDuplicate ? (res.duplicates[0]?.documentId ?? null) : null;
  } catch {
    return null;
  }
}

/** Map an upload failure to a localized, actionable message (mirrors the old
 *  /documents/new + ProjectDocumentUpload error mapping). */
function uploadErrorMessage(e: unknown, t: (k: string) => string): string {
  if (e instanceof ApiClientError) {
    if (e.code === 'storage_unavailable') return t('storageUnavailable');
    if (e.code === 'upload_size_mismatch') return t('sizeMismatch');
    if (e.code === 'document_integrity_mismatch') {
      return integrityMismatchField(e.details) === 'size' ? t('sizeMismatch') : t('hashMismatch');
    }
    if (e.code === DOCUMENT_SCAN_REJECTED_CODE) return t('scanRejected');
    if (e.code === 'document_too_large') return t('tooLarge');
    if (e.code === 'upload_failed') return t('uploadFailed');
  }
  return t('createFailed');
}
