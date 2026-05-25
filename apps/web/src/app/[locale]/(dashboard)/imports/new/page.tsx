'use client';

import { IMPORT_MAX_SIZE_BYTES } from '@emapp/shared-types';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useUploadImport } from '@/hooks/use-imports';
import { useProjectList } from '@/hooks/use-projects';
import { ApiClientError } from '@/lib/api/projects';

/** Excel mime allow-list — what the FE accepts in the file picker.
 *  The BE worker uses magic-byte ZIP preflight (v8 Sec-7) — this
 *  client-side check is UX, not security. */
const EXCEL_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.ms-excel', // xls
  'application/octet-stream', // some browsers report this for .xlsx
]);

export default function NewImportPage() {
  const t = useTranslations('imports');
  const tp = useTranslations('projects');
  const router = useRouter();
  const projects = useProjectList({ limit: 100 });
  const upload = useUploadImport();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [projectId, setProjectId] = useState<string>('');
  const [dryRun, setDryRun] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);

  const projectItems = projects.data?.items ?? [];

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null;
    setError(null);
    if (!f) {
      setFile(null);
      return;
    }
    if (!f.name.toLowerCase().endsWith('.xlsx') && !f.name.toLowerCase().endsWith('.xls')) {
      setError(t('mimeNotAllowed'));
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    if (f.size > IMPORT_MAX_SIZE_BYTES) {
      setError(t('tooLarge'));
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    setFile(f);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setError(t('pickFile'));
      return;
    }
    if (!projectId) {
      setError(t('pickProject'));
      return;
    }
    setError(null);
    setProgress({ loaded: 0, total: file.size });
    try {
      const job = await upload.mutateAsync({
        projectId,
        file,
        dryRun,
        onProgress: (loaded, total) => setProgress({ loaded, total }),
      });
      router.push(`/imports/${job.id}`);
    } catch (e) {
      if (e instanceof ApiClientError) {
        // D.36 caveat #2 — presigned PUT TTL is 5min; if user takes
        // too long between create and upload, R2 returns 403 which
        // we surface as `upload_failed` from uploadToPresignedXhr.
        if (e.code === 'upload_failed') setError(t('uploadFailedRetry'));
        else if (e.code === 'import_conflict') setError(t('importConflict'));
        else if (e.code === 'upload_size_mismatch') setError(t('sizeMismatch'));
        else if (e.code === 'storage_unavailable') setError(t('storageUnavailable'));
        else if (e.code === 'validation_error') setError(t('validationError'));
        else if (e.code === 'wrong_file_type') setError(t('mimeNotAllowed'));
        else setError(t('createFailed'));
      } else {
        setError(t('createFailed'));
      }
      setProgress(null);
    }
  }

  EXCEL_MIMES.size; // keep the const live (UX guidance; BE does the real check)

  return (
    <div className="mx-auto max-w-xl space-y-6" dir="rtl">
      <h1 className="text-2xl font-bold">{t('upload')}</h1>
      <p className="text-xs text-muted-foreground">{t('uploadHint')}</p>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-1">
          <label htmlFor="project" className="text-sm font-medium">
            {t('field.project')}
          </label>
          <select
            id="project"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
            disabled={projects.isLoading}
          >
            <option value="" disabled>
              {t('field.projectPlaceholder')}
            </option>
            {projectItems.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
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
            accept=".xlsx,.xls"
            onChange={onPick}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          />
          {file && (
            <p className="text-xs text-muted-foreground">
              {file.name} · {(file.size / 1024).toFixed(0)} KB
            </p>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          <span>{t('field.dryRun')}</span>
        </label>
        <p className="text-xs text-muted-foreground">{t('field.dryRunHint')}</p>

        {progress && progress.total > 0 && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>{t('uploadingProgress')}</span>
              <span>{Math.round((progress.loaded / progress.total) * 100)}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${(progress.loaded / progress.total) * 100}%` }}
              />
            </div>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => router.back()}>
            {tp('cancel')}
          </Button>
          <Button type="submit" disabled={!file || !projectId || upload.isPending}>
            {upload.isPending ? t('uploading') : t('upload')}
          </Button>
        </div>
      </form>
    </div>
  );
}
