'use client';

import type { UpdateNote } from '@emapp/shared-types';
import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';

import type { AssignmentMemberLookup } from '@/adapters/project-assignment';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { ListSkeleton } from '@/components/ui/list-skeleton';
import { NameDisplay } from '@/components/ui/name-display';
import { useApiErrorHandler } from '@/hooks/use-api-error-handler';
import { useArchiveNote, useNote, useUpdateNote } from '@/hooks/use-notes';
import { useHasPermission } from '@/hooks/use-permissions';
import { ApiClientError } from '@/lib/api/errors';
import { listMembers } from '@/lib/api/members';
import { useDisplayLocale } from '@/lib/locale';

/**
 * Note detail (D.17 — read=ALL; update/delete = Manager OR original author
 * per the BE service-layer check).
 *
 * IAM slice 5b: the edit form + archive controls render only for actors who
 * hold `notes.update` / `notes.archive` (managers + agents; viewers never).
 * The BE keeps the finer-grained "manager OR author" check — an agent who
 * isn't the author still 403s; that 403 surfaces as a localized message via
 * `useApiErrorHandler`. A viewer simply sees the note read-only.
 */
export default function NoteDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const t = useTranslations('notes');
  const locale = useDisplayLocale();

  // /members side-load — Manager-only resource, used here only to
  // resolve createdBy → name on the detail header.
  const membersQuery = useQuery({
    queryKey: ['members', 'list', { limit: 100 }, locale, 'note-detail-side-load'],
    queryFn: () => listMembers({ limit: 100 }),
    staleTime: 30_000,
    retry: false,
  });
  const lookup = useMemo<Map<string, AssignmentMemberLookup> | undefined>(() => {
    if (!membersQuery.data) return undefined;
    const m = new Map<string, AssignmentMemberLookup>();
    for (const item of membersQuery.data.items) {
      m.set(item.userId, { name: item.name, email: item.email });
    }
    return m;
  }, [membersQuery.data]);

  const { data: note, isLoading, isError, error } = useNote(id, lookup);
  const updateMutation = useUpdateNote();
  const archiveMutation = useArchiveNote();
  const canEdit = useHasPermission('notes.update');
  const canArchive = useHasPermission('notes.archive');
  const { confirm, dialog: confirmDialog } = useConfirm();

  const [bodyDraft, setBodyDraft] = useState<string | null>(null);
  const [pinnedDraft, setPinnedDraft] = useState<boolean | null>(null);

  useEffect(() => {
    // Reset drafts whenever the underlying note id (route) changes.
    setBodyDraft(null);
    setPinnedDraft(null);
  }, [id]);

  const editError = useApiErrorHandler<UpdateNote>({
    codeOverrides: { forbidden: () => t('forbiddenEdit') },
    fallback: () => t('updateFailed'),
  });
  // V10-S5 closure — archive failures used to surface the edit-error
  // message ("Only Manager/author may EDIT this note") because the
  // catch block reused `editError`. The user just clicked Archive
  // though — show an archive-specific message. The BE returns the
  // same `forbidden` code for both ops; the FE message is what
  // disambiguates intent.
  const archiveError = useApiErrorHandler<UpdateNote>({
    codeOverrides: { forbidden: () => t('forbiddenArchive') },
    fallback: () => t('archiveFailed'),
  });

  if (isLoading) return <ListSkeleton withRows={false} />;
  if (isError || !note) {
    const notFound = error instanceof ApiClientError && error.code === 'not_found';
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{notFound ? t('notFound') : t('loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={() => router.push('/notes')}>
          {t('backToList')}
        </Button>
      </div>
    );
  }

  const currentBody = bodyDraft ?? note.body;
  const currentPinned = pinnedDraft ?? note.pinned;
  const dirty =
    (bodyDraft !== null && bodyDraft !== note.body) ||
    (pinnedDraft !== null && pinnedDraft !== note.pinned);

  async function onSave() {
    if (!id || !dirty) return;
    editError.reset();
    const body: UpdateNote = {};
    if (bodyDraft !== null && bodyDraft !== note!.body) body.body = bodyDraft;
    if (pinnedDraft !== null && pinnedDraft !== note!.pinned) body.pinned = pinnedDraft;
    try {
      await updateMutation.mutateAsync({ id, body });
      setBodyDraft(null);
      setPinnedDraft(null);
    } catch (e) {
      editError.handle(e);
    }
  }

  async function onArchive() {
    if (!id) return;
    if (!(await confirm({ message: t('archiveConfirm'), destructive: true }))) return;
    archiveError.reset();
    try {
      await archiveMutation.mutateAsync(id);
      router.push('/notes');
    } catch (e) {
      archiveError.handle(e);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6" dir="rtl">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <h1 className="text-2xl font-bold">{t('detailTitle')}</h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>
              {note.createdByName ? (
                <NameDisplay name={note.createdByName} />
              ) : (
                <span className="font-mono" dir="ltr">
                  {t('byUser')} {note.createdByShort}
                </span>
              )}
            </span>
            <span>·</span>
            <span>{note.createdRelative}</span>
            {note.createdAtIso !== note.updatedAtIso && (
              <>
                <span>·</span>
                <span>{t('updatedAt', { rel: note.updatedRelative })}</span>
              </>
            )}
            {note.isArchived && (
              <span className="rounded-full bg-gray-200 px-2 py-0.5 font-medium text-gray-700">
                {t('archivedBadge')}
              </span>
            )}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => router.push('/notes')}>
          {t('backToList')}
        </Button>
      </div>

      <div className="rounded-md border bg-card p-4">
        {canEdit ? (
          <form
            method="post"
            action=""
            onSubmit={(e) => {
              e.preventDefault();
              onSave();
            }}
            className="space-y-3"
          >
            <div className="space-y-1">
              <label htmlFor="body" className="text-sm font-medium">
                {t('field.body')}
              </label>
              <textarea
                id="body"
                rows={10}
                value={currentBody}
                onChange={(e) => setBodyDraft(e.target.value)}
                className="w-full rounded-md border px-3 py-2 text-sm"
                disabled={note.isArchived}
              />
            </div>

            <div className="flex items-center gap-2">
              <input
                id="pinned"
                type="checkbox"
                checked={currentPinned}
                onChange={(e) => setPinnedDraft(e.target.checked)}
                disabled={note.isArchived}
                className="rounded"
              />
              <label htmlFor="pinned" className="text-sm">
                {t('field.pinned')}
              </label>
            </div>

            {editError.serverError && (
              <p className="text-sm text-destructive">{editError.serverError}</p>
            )}

            <div className="flex items-center justify-end">
              <Button
                type="submit"
                disabled={!dirty || note.isArchived || updateMutation.isPending}
              >
                {updateMutation.isPending ? t('saving') : t('save')}
              </Button>
            </div>
          </form>
        ) : (
          /* IAM slice 5b — read-only note body for actors without
             `notes.update` (e.g. viewer); no editable form, no save button. */
          <div className="space-y-1">
            <span className="text-sm font-medium">{t('field.body')}</span>
            <p className="whitespace-pre-wrap text-sm">
              <NameDisplay name={currentBody} />
            </p>
          </div>
        )}
      </div>

      {!note.isArchived && canArchive && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4">
          <h2 className="mb-2 text-base font-semibold text-destructive">{t('archiveSection')}</h2>
          <p className="mb-3 text-xs text-muted-foreground">{t('archiveHint')}</p>
          {archiveError.serverError && (
            <p className="mb-3 text-sm text-destructive">{archiveError.serverError}</p>
          )}
          <Button
            type="button"
            variant="destructive"
            onClick={onArchive}
            disabled={archiveMutation.isPending}
          >
            {archiveMutation.isPending ? t('archiving') : t('archive')}
          </Button>
        </div>
      )}
      {confirmDialog}
    </div>
  );
}
