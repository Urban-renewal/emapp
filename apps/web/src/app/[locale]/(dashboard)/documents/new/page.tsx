'use client';

import {
  DocumentMimeEnum,
  DocumentTypeEnum,
  type DocumentMime,
  type DocumentType,
} from '@emapp/shared-types';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';

import { DOCUMENT_TYPE_LABELS_HE } from '@/adapters/document';
import { Button } from '@/components/ui/button';
import { useUploadDocument } from '@/hooks/use-documents';
import { ApiClientError } from '@/lib/api/projects';

const DOC_TYPES: DocumentType[] = [...DocumentTypeEnum.options];
const ALLOWED_MIMES = new Set<DocumentMime>(DocumentMimeEnum.options);

export default function NewDocumentPage() {
  const t = useTranslations('documents');
  const tp = useTranslations('projects');
  const router = useRouter();
  const upload = useUploadDocument();
  const [type, setType] = useState<DocumentType>('contract');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setError(null);
    setFile(f);
    if (!f) return;
    if (!ALLOWED_MIMES.has(f.type as DocumentMime)) {
      setError(t('mimeNotAllowed'));
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    if (f.size > 52_428_800) {
      setError(t('tooLarge'));
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setError(t('pickFile'));
      return;
    }
    if (!ALLOWED_MIMES.has(file.type as DocumentMime)) {
      setError(t('mimeNotAllowed'));
      return;
    }
    setError(null);
    try {
      const doc = await upload.mutateAsync({
        file,
        type,
        mimeType: file.type as DocumentMime,
      });
      router.push(`/documents/${doc.id}`);
    } catch (e) {
      if (e instanceof ApiClientError) {
        if (e.code === 'storage_unavailable') setError(t('storageUnavailable'));
        else if (e.code === 'upload_size_mismatch') setError(t('sizeMismatch'));
        else if (e.code === 'upload_failed') setError(t('uploadFailed'));
        else setError(t('createFailed'));
      } else {
        setError(t('createFailed'));
      }
    }
  }

  return (
    <div className="mx-auto max-w-xl space-y-6" dir="rtl">
      <h1 className="text-2xl font-bold">{t('upload')}</h1>
      <p className="text-xs text-muted-foreground">{t('uploadHint')}</p>
      {/* §S5-SEC1 — method="post" defense in depth (see login/page.tsx).
          File uploads use FormData/XHR so the URL stays clean even
          without JS, but the attribute prevents URL-encoded fallback
          on browsers that downgrade. */}
      <form method="post" action="" onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="type" className="text-sm font-medium">
            {t('field.type')}
          </label>
          <select
            id="type"
            value={type}
            onChange={(e) => setType(e.target.value as DocumentType)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          >
            {DOC_TYPES.map((dt) => (
              <option key={dt} value={dt}>
                {DOCUMENT_TYPE_LABELS_HE[dt]}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label htmlFor="file" className="text-sm font-medium">
            {t('field.file')}
          </label>
          <input
            ref={inputRef}
            id="file"
            type="file"
            onChange={onPick}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.xlsx,.xls,.csv,.docx,.doc,.txt"
          />
          {file && (
            <p className="text-xs text-muted-foreground">
              {file.name} · {(file.size / 1024).toFixed(0)} KB
            </p>
          )}
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => router.back()}>
            {tp('cancel')}
          </Button>
          <Button type="submit" disabled={!file || upload.isPending}>
            {upload.isPending ? t('uploading') : t('upload')}
          </Button>
        </div>
      </form>
    </div>
  );
}
