'use client';

import { SubmitMappingInput, type SubmitMapping } from '@emapp/shared-types';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useImport, useSubmitMapping } from '@/hooks/use-imports';
import { ApiClientError } from '@/lib/api/projects';
import { cn } from '@/lib/utils';

/** The 6 canonical fields per D.34 / shared-types/import.ts:159.
 *  Order is the recommended UX order, not the spec order. */
const FIELDS = [
  'national_id',
  'name',
  'phone',
  'apartment_number',
  'building_address',
  'ownership_pct',
] as const;
const REQUIRED_FIELDS = new Set([
  'national_id',
  'name',
  'phone',
  'apartment_number',
  'building_address',
]);

/**
 * D.34 manual mapping wizard.
 *
 * Page semantics:
 *  - Only reachable when the import status === 'awaiting_mapping'.
 *  - The Manager provides a column-index per canonical field (the
 *    columns are the Excel header row indices as the parser saw
 *    them, 0-based).
 *  - 5 fields are required; `ownership_pct` is optional.
 *  - Optional `templateName` saves the mapping for future
 *    same-fingerprint imports (worker re-uses via TemplateResolver).
 *  - On submit, the BE re-enqueues the worker; the user is bounced
 *    back to the detail page where the SSE stream resumes from
 *    `queued`.
 *
 * Note: we do NOT load the actual header row from the BE — the
 * Manager remembers which column is which from their own Excel file.
 * A future enhancement (post-MVP) would surface `parsed_headers`
 * from the awaiting_mapping row so the user picks by header name
 * instead of by index.
 */
export default function MappingWizardPage() {
  const t = useTranslations('imports.mapping');
  const tp = useTranslations('projects');
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const { data, isLoading, isError } = useImport(id);
  const submit = useSubmitMapping(id ?? '');
  const [columns, setColumns] = useState<Record<string, number | undefined>>({});
  const [templateName, setTemplateName] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (isLoading) return <p className="text-sm text-muted-foreground">{t('loading')}</p>;
  if (isError || !data) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{t('loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={() => router.push('/imports')}>
          {tp('backToList')}
        </Button>
      </div>
    );
  }

  if (!data.isAwaitingMapping) {
    // Wrong state — bounce back. The import may have been resolved
    // or cancelled while the user was on this page.
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{t('notInAwaitingState')}</p>
        <Button variant="outline" size="sm" onClick={() => router.push(`/imports/${data.id}`)}>
          {tp('backToList')}
        </Button>
      </div>
    );
  }

  // Validation: required fields all set; no duplicate column indexes
  const required_set = REQUIRED_FIELDS;
  const missing = [...required_set].filter((k) => typeof columns[k] !== 'number');
  const usedColumns = new Set<number>();
  const dupes = new Set<number>();
  for (const v of Object.values(columns)) {
    if (typeof v === 'number') {
      if (usedColumns.has(v)) dupes.add(v);
      else usedColumns.add(v);
    }
  }
  const canSubmit = missing.length === 0 && dupes.size === 0;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!id) return;
    setError(null);
    const onlySet = Object.fromEntries(
      Object.entries(columns).filter(([, v]) => typeof v === 'number'),
    ) as SubmitMapping['columns'];
    const body: SubmitMapping = {
      columns: onlySet,
      ...(templateName.trim() ? { templateName: templateName.trim() } : {}),
    };
    const parsed = SubmitMappingInput.safeParse(body);
    if (!parsed.success) {
      setError(t('clientInvalid'));
      return;
    }
    try {
      await submit.mutateAsync(parsed.data);
      router.push(`/imports/${id}`);
    } catch (e) {
      if (e instanceof ApiClientError) {
        if (e.code === 'mapping_duplicate_column') setError(t('serverDupe'));
        else if (e.code === 'import_not_in_awaiting_mapping') setError(t('notInAwaitingState'));
        else if (e.code === 'import_status_changed') setError(t('statusChanged'));
        else setError(t('submitFailed'));
      } else {
        setError(t('submitFailed'));
      }
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <p className="text-sm">
        <Link href={`/imports/${id}`} className="underline">
          {tp('backToList')}
        </Link>
      </p>
      <h1 className="text-2xl font-bold">{t('title')}</h1>
      <p className="text-sm text-muted-foreground">{t('hint')}</p>

      {/* §S5-SEC1 — method="post" defense in depth (see login/page.tsx). */}
      <form method="post" action="" onSubmit={onSubmit} className="space-y-4" dir="rtl">
        {FIELDS.map((field) => (
          <div
            key={field}
            className={cn(
              'flex items-center gap-3 rounded-md border bg-card p-3',
              typeof columns[field] === 'number' && dupes.has(columns[field] as number)
                ? 'border-destructive'
                : '',
            )}
          >
            <div className="flex min-w-[10rem] flex-col">
              <label htmlFor={`col-${field}`} className="text-sm font-medium">
                {t(`fields.${field}`)}
              </label>
              {REQUIRED_FIELDS.has(field) && (
                <span className="text-xs text-muted-foreground">{t('requiredField')}</span>
              )}
            </div>
            <input
              id={`col-${field}`}
              type="number"
              inputMode="numeric"
              min="0"
              max="1023"
              placeholder={t('columnIndexPlaceholder')}
              value={columns[field] ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                setColumns((prev) => ({
                  ...prev,
                  [field]: v === '' ? undefined : Number(v),
                }));
              }}
              className="w-24 rounded-md border px-3 py-2 text-end text-sm"
              dir="ltr"
            />
          </div>
        ))}

        <div className="space-y-1">
          <label htmlFor="template-name" className="text-sm font-medium">
            {t('templateNameLabel')}
          </label>
          <input
            id="template-name"
            type="text"
            maxLength={120}
            placeholder={t('templateNamePlaceholder')}
            value={templateName}
            onChange={(e) => setTemplateName(e.target.value)}
            className="w-full rounded-md border px-3 py-2 text-sm"
          />
          <p className="text-xs text-muted-foreground">{t('templateNameHint')}</p>
        </div>

        {dupes.size > 0 && <p className="text-xs text-destructive">{t('dupesError')}</p>}
        {missing.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {t('missingFields', { count: missing.length })}
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => router.back()}>
            {tp('cancel')}
          </Button>
          <Button type="submit" disabled={!canSubmit || submit.isPending}>
            {submit.isPending ? t('submitting') : t('submit')}
          </Button>
        </div>
      </form>
    </div>
  );
}
