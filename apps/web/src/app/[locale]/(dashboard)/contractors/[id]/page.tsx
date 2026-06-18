'use client';

import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { ListSkeleton } from '@/components/ui/list-skeleton';
import { NameDisplay } from '@/components/ui/name-display';
import { useApiErrorHandler } from '@/hooks/use-api-error-handler';
import { useArchiveContractor, useContractor } from '@/hooks/use-contractors';
import { useHasPermission } from '@/hooks/use-permissions';
import { ApiClientError } from '@/lib/api/errors';

/**
 * Contractor detail (read=ALL). IAM slice 5b: the archive action renders only
 * for actors holding `contractors.archive` (no dead archive button for
 * agent/viewer). The PATCH/edit surface is deferred to a future polish slice.
 */
export default function ContractorDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const t = useTranslations('contractors');
  const tp = useTranslations('projects');
  const { data: c, isLoading, isError, error } = useContractor(id);
  const archive = useArchiveContractor();
  const canArchive = useHasPermission('contractors.archive');
  const { confirm, dialog: confirmDialog } = useConfirm();

  const archiveError = useApiErrorHandler({
    codeOverrides: { forbidden: () => t('forbiddenArchive') },
    fallback: () => t('archiveFailed'),
  });

  if (isLoading) return <ListSkeleton withRows={false} />;
  if (isError || !c) {
    const notFound = error instanceof ApiClientError && error.code === 'not_found';
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{notFound ? t('notFound') : t('loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={() => router.push('/contractors')}>
          {t('backToList')}
        </Button>
      </div>
    );
  }

  async function onArchive() {
    if (!id) return;
    if (!(await confirm({ message: t('archiveConfirm'), destructive: true }))) return;
    archiveError.reset();
    try {
      await archive.mutateAsync(id);
      router.push('/contractors');
    } catch (e) {
      archiveError.handle(e);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6" dir="rtl">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-2xl font-bold">
            <NameDisplay name={c.name} />
          </h1>
          <p className="text-xs text-muted-foreground">{c.createdRelative}</p>
          {c.isArchived && (
            <span className="rounded-full bg-gray-200 px-2 py-0.5 text-xs font-medium text-gray-700">
              {tp('archived')}
            </span>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={() => router.push('/contractors')}>
          {t('backToList')}
        </Button>
      </div>

      <div className="rounded-md border bg-card p-4 space-y-2 text-sm">
        <div>
          <span className="font-medium">{t('field.contactEmail')}: </span>
          <span dir="ltr" className="font-mono">
            <NameDisplay name={c.contactEmail} />
          </span>
        </div>
        {c.contactPhone && (
          <div>
            <span className="font-medium">{t('field.contactPhone')}: </span>
            <span dir="ltr" className="font-mono">
              {c.contactPhone}
            </span>
          </div>
        )}
        {c.specialty && (
          <div>
            <span className="font-medium">{t('field.specialty')}: </span>
            <NameDisplay name={c.specialty} />
          </div>
        )}
        {c.companyId && (
          <div>
            <span className="font-medium">{t('field.companyId')}: </span>
            <span dir="ltr" className="font-mono">
              {c.companyId}
            </span>
          </div>
        )}
        {c.notes && (
          <div>
            <span className="font-medium">{t('field.notes')}: </span>
            <span className="whitespace-pre-wrap">
              <NameDisplay name={c.notes} />
            </span>
          </div>
        )}
      </div>

      {!c.isArchived && canArchive && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4">
          <h2 className="mb-2 text-base font-semibold text-destructive">{t('archiveSection')}</h2>
          <p className="mb-3 text-xs text-muted-foreground">{t('archiveHint')}</p>
          {archiveError.serverError && (
            <p className="mb-2 text-sm text-destructive">{archiveError.serverError}</p>
          )}
          <Button
            type="button"
            variant="destructive"
            onClick={onArchive}
            disabled={archive.isPending}
          >
            {archive.isPending ? t('archiving') : t('archive')}
          </Button>
        </div>
      )}
      {confirmDialog}
    </div>
  );
}
