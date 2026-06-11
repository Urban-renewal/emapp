'use client';

import { DocumentMimeEnum, type DocumentMime, type DocumentType } from '@emapp/shared-types';
import { useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';

import { useUploadDocument } from '@/hooks/use-documents';
import { ApiClientError } from '@/lib/api/errors';

/**
 * Slice 5c — project-scoped document-upload affordance.
 *
 * In-context "upload a signature document" control on the project detail page
 * that reuses `useUploadDocument` PRE-SCOPED to the current project (projectId
 * set, apartmentId null) so the doc hangs off the project WITHOUT the manager
 * leaving for /documents/new (where the upload is org-level / unparented).
 *
 * No dialog/toast primitive exists in this repo (see ExportXlsxButton /
 * SignatureCampaignAction) — this mirrors that inline-status pattern: a file
 * input + button + an aria-live status line. The error feedback surfaces the
 * finalize `details.field` ("size" → גודל / "hash" → תוכן) so a truncated vs.
 * tampered re-upload gives the owner an actionable message.
 *
 * On success it invalidates the project documents query (so the S5b campaign
 * picker sees the new doc) AND the S5a signature-progress query (a refetch —
 * flag for e2e stubbing).
 */
const ALLOWED_MIMES = new Set<DocumentMime>(DocumentMimeEnum.options);
const MAX_SIZE_BYTES = 52_428_800; // 50MB, mirrors /documents/new.

/**
 * Pure seam between the UI and the upload hook: maps (projectId, picked file,
 * type, mime) → the EXACT `useUploadDocument().mutate` arg object, pre-scoped
 * to the project. apartmentId is an explicit `null` (a project-scoped, NOT
 * apartment-scoped, upload — and NOT the org-level both-null upload that
 * /documents/new produces). file / type / mimeType pass through unchanged.
 *
 * Exported for the unit seam test (project-document-upload.spec.ts).
 */
export function buildProjectScopedUploadArgs(args: {
  projectId: string;
  file: File;
  type: DocumentType;
  mimeType: DocumentMime;
}): {
  file: File;
  type: DocumentType;
  mimeType: DocumentMime;
  projectId: string;
  apartmentId: null;
} {
  return {
    file: args.file,
    type: args.type,
    mimeType: args.mimeType,
    projectId: args.projectId,
    apartmentId: null,
  };
}

const PROJECTS_KEY = ['projects'] as const;

type UploadState = 'idle' | 'uploading' | 'ok' | 'error';

export function ProjectDocumentUpload({ projectId }: { projectId: string }) {
  const t = useTranslations('projects.docUpload');
  const qc = useQueryClient();
  const upload = useUploadDocument();
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<UploadState>('idle');
  const [message, setMessage] = useState<string | null>(null);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setState('idle');
    setMessage(null);
    if (!file) return;
    if (!ALLOWED_MIMES.has(file.type as DocumentMime)) {
      setState('error');
      setMessage(t('mimeNotAllowed'));
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      setState('error');
      setMessage(t('tooLarge'));
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    void onUpload(file);
  }

  async function onUpload(file: File) {
    if (upload.isPending) return;
    setState('uploading');
    setMessage(null);
    try {
      await upload.mutateAsync(
        buildProjectScopedUploadArgs({
          projectId,
          file,
          type: 'agreement',
          mimeType: file.type as DocumentMime,
        }),
      );
      // The hook already invalidates ['documents']; additionally refetch the
      // S5a signature-progress board for this project (a new project doc can
      // change the campaign surface / counts).
      qc.invalidateQueries({ queryKey: [...PROJECTS_KEY, 'signature-progress', projectId] });
      setState('ok');
      setMessage(t('uploaded'));
    } catch (e) {
      setState('error');
      setMessage(errorMessage(e, t));
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  const isUploading = state === 'uploading' || upload.isPending;

  return (
    <div className="relative flex flex-col gap-2">
      <div>
        <input
          ref={inputRef}
          id="project-doc-upload-input"
          type="file"
          onChange={onPick}
          disabled={isUploading}
          data-testid="project-document-upload-input"
          accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.docx,.doc"
          className="hidden"
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={isUploading}
          aria-busy={isUploading}
          data-testid="project-document-upload-button"
          className="btn btn-secondary btn-sm disabled:cursor-wait disabled:opacity-60"
        >
          <Upload className="h-3.5 w-3.5" aria-hidden="true" />
          <span>{isUploading ? t('uploading') : t('cta')}</span>
        </button>
      </div>

      {state !== 'idle' && state !== 'uploading' && message && (
        <p
          role="status"
          aria-live="polite"
          data-testid={`project-document-upload-${state}`}
          className="whitespace-nowrap rounded-md border px-2 py-1 text-[11px] shadow-sm"
          style={{
            color: state === 'ok' ? 'var(--success-700)' : 'var(--danger-700)',
            background: 'var(--bg-surface)',
            borderColor: 'var(--border)',
          }}
        >
          {message}
        </p>
      )}
    </div>
  );
}

/**
 * Map a finalize/upload failure to a localized, ACTIONABLE message. When the
 * BE returns the Slice 5c integrity-mismatch `details.field`, surface the
 * field-specific copy ("size" → גודל / "hash" → תוכן); otherwise a generic
 * upload-failed message.
 */
function errorMessage(e: unknown, t: (k: string) => string): string {
  if (e instanceof ApiClientError) {
    if (e.code === 'document_integrity_mismatch') {
      const field = integrityField(e.details);
      if (field === 'size') return t('sizeMismatch');
      if (field === 'hash') return t('hashMismatch');
    }
    if (e.code === 'storage_unavailable' || e.code === 'upload_failed') return t('failed');
  }
  return t('failed');
}

function integrityField(details: unknown): 'size' | 'hash' | null {
  if (details && typeof details === 'object' && 'field' in details) {
    const f = (details as { field?: unknown }).field;
    if (f === 'size' || f === 'hash') return f;
  }
  return null;
}
