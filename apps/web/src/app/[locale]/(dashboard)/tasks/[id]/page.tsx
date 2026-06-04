'use client';

import { TaskStatusEnum, type TaskStatus, type UpdateTask } from '@emapp/shared-types';
import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import type { AssignmentMemberLookup } from '@/adapters/project-assignment';
import { Button } from '@/components/ui/button';
import { ListSkeleton } from '@/components/ui/list-skeleton';
import { NameDisplay } from '@/components/ui/name-display';
import { StatusBadge } from '@/components/ui/status-badge';
import { useApiErrorHandler } from '@/hooks/use-api-error-handler';
import { useHasPermission } from '@/hooks/use-permissions';
import {
  useAddTaskAssignee,
  useArchiveTask,
  useRemoveTaskAssignee,
  useTask,
  useTaskAssignees,
  useUpdateTask,
} from '@/hooks/use-tasks';
import { ApiClientError } from '@/lib/api/errors';
import { listMembers } from '@/lib/api/members';
import { useDisplayLocale } from '@/lib/locale';

/**
 * Task detail page (D.17 read=ALL with Agent service-layer scoping).
 *
 * IAM slice 5b — gating cut over to effective permissions:
 *  - The status + description edit form renders only with `tasks.update`
 *    (manager + agent hold it; viewer never → no dead edit form for the
 *    read-only viewer). The BE still service-layer-scopes an agent to their
 *    OWN assigned tasks; a cross-task PATCH 403s and surfaces as a message.
 *  - Manager-only extras (add/remove assignees, archive) stay gated by the
 *    `/members` 403-vs-200 side-load signal (`isManager`) — a coarse proxy
 *    that the slice-2 engine will replace when a dedicated capability is
 *    wired; kept as-is here to avoid scope-creep.
 *
 * Defense in depth on top of the BE AuthorizationGuard + service-layer
 * restrictions; the BE remains the authoritative gate.
 */
export default function TaskDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const t = useTranslations('tasks');
  const tp = useTranslations('projects');
  const tt = useTranslations('tasks.priority');
  const tst = useTranslations('tasks.status');
  const locale = useDisplayLocale();

  const { data: task, isLoading, isError, error } = useTask(id);

  // Side-load /members — Manager-only enrichment. Same retry: false
  // pattern as the project-assignments page (avoid 7s of retry chatter
  // for Agent/Viewer).
  const membersQuery = useQuery({
    queryKey: ['members', 'list', { limit: 100 }, locale, 'task-detail-side-load'],
    queryFn: () => listMembers({ limit: 100 }),
    staleTime: 30_000,
    retry: false,
  });
  const isManager = membersQuery.isSuccess;
  // IAM slice 5b — the base status/description edit form gates on this.
  const canUpdate = useHasPermission('tasks.update');
  const lookup = useMemo<Map<string, AssignmentMemberLookup> | undefined>(() => {
    if (!membersQuery.data) return undefined;
    const m = new Map<string, AssignmentMemberLookup>();
    for (const item of membersQuery.data.items) {
      m.set(item.userId, { name: item.name, email: item.email });
    }
    return m;
  }, [membersQuery.data]);

  const assignees = useTaskAssignees(id, lookup);
  const updateMutation = useUpdateTask();
  const archiveMutation = useArchiveTask();
  const addAssigneeMutation = useAddTaskAssignee(id);
  const removeAssigneeMutation = useRemoveTaskAssignee(id);

  const [statusDraft, setStatusDraft] = useState<TaskStatus | null>(null);
  const [descDraft, setDescDraft] = useState<string | null>(null);
  const [assignUserId, setAssignUserId] = useState<string>('');

  const editError = useApiErrorHandler<UpdateTask>({
    codeOverrides: { forbidden: () => t('forbiddenEdit') },
    fallback: () => t('updateFailed'),
  });
  const assignError = useApiErrorHandler<UpdateTask>({
    codeOverrides: {
      assignee_exists: () => t('assigneeExists'),
      invalid_assignee: () => t('invalidAssignee'),
      forbidden: () => t('forbiddenEdit'),
    },
    fallback: () => t('assignFailed'),
  });

  // Eligible members for the assignee dropdown — only active members
  // that aren't already assigned to this task. MUST live before any
  // early return — React Hooks rules require unconditional invocation
  // order across renders (react-hooks/rules-of-hooks).
  const eligibleMembers = useMemo(() => {
    if (!membersQuery.data) return [];
    const already = new Set((assignees.data ?? []).map((a) => a.userId));
    return membersQuery.data.items.filter(
      (m) => m.revokedAt === null && m.acceptedAt !== null && !already.has(m.userId),
    );
  }, [membersQuery.data, assignees.data]);

  if (isLoading) return <ListSkeleton withRows={false} />;
  if (isError || !task) {
    const notFound = error instanceof ApiClientError && error.code === 'not_found';
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{notFound ? t('notFound') : t('loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={() => router.push('/tasks')}>
          {t('backToList')}
        </Button>
      </div>
    );
  }

  const currentStatus = statusDraft ?? task.status;
  const currentDesc = descDraft ?? task.description ?? '';
  const dirty =
    (statusDraft !== null && statusDraft !== task.status) ||
    (descDraft !== null && descDraft !== (task.description ?? ''));

  async function onSave() {
    if (!id || !dirty) return;
    editError.reset();
    const body: UpdateTask = {};
    if (statusDraft !== null && statusDraft !== task!.status) body.status = statusDraft;
    if (descDraft !== null && descDraft !== (task!.description ?? '')) {
      body.description = descDraft.length === 0 ? null : descDraft;
    }
    try {
      await updateMutation.mutateAsync({ id, body });
      setStatusDraft(null);
      setDescDraft(null);
    } catch (e) {
      editError.handle(e);
    }
  }

  async function onArchive() {
    if (!id) return;
    if (!window.confirm(t('archiveConfirm'))) return;
    try {
      await archiveMutation.mutateAsync(id);
      router.push('/tasks');
    } catch (e) {
      editError.handle(e);
    }
  }

  async function onAssign(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!assignUserId) return;
    assignError.reset();
    try {
      await addAssigneeMutation.mutateAsync({ userId: assignUserId });
      setAssignUserId('');
    } catch (err) {
      assignError.handle(err);
    }
  }

  async function onRemoveAssignee(userId: string) {
    if (!window.confirm(t('removeAssigneeConfirm'))) return;
    try {
      await removeAssigneeMutation.mutateAsync(userId);
    } catch (err) {
      assignError.handle(err);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6" dir="rtl">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          <h1 className="truncate text-2xl font-bold">
            <NameDisplay name={task.title} />
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <StatusBadge color={task.statusColor}>{task.statusLabel}</StatusBadge>
            <span>·</span>
            <span>{tt(String(task.priority))}</span>
            {task.dueRelative && (
              <>
                <span>·</span>
                <span>{t('dueAt', { rel: task.dueRelative })}</span>
              </>
            )}
            {task.isOverdue && (
              <span className="rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-800">
                {t('overdue')}
              </span>
            )}
            <span>·</span>
            <span>{task.createdRelative}</span>
            {task.isArchived && (
              <span className="rounded-full bg-gray-200 px-2 py-0.5 font-medium text-gray-700">
                {tp('archived')}
              </span>
            )}
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => router.push('/tasks')}>
          {t('backToList')}
        </Button>
      </div>

      {/* Editable surface — status + description. IAM slice 5b: rendered only
          with `tasks.update` (manager + agent); the read-only viewer gets a
          plain read view instead of a dead form. The BE still scopes an agent
          to their OWN tasks (a cross-task PATCH 403s → localized message). */}
      <div className="rounded-md border bg-card p-4">
        <h2 className="mb-3 text-base font-semibold">{t('editSection')}</h2>
        {canUpdate ? (
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
              <label htmlFor="status" className="text-sm font-medium">
                {t('field.status')}
              </label>
              <select
                id="status"
                value={currentStatus}
                onChange={(e) => setStatusDraft(e.target.value as TaskStatus)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                disabled={task.isArchived}
              >
                {TaskStatusEnum.options.map((s) => (
                  <option key={s} value={s} dir="auto">
                    {tst(s)}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label htmlFor="description" className="text-sm font-medium">
                {t('field.description')}
              </label>
              <textarea
                id="description"
                rows={4}
                value={currentDesc}
                onChange={(e) => setDescDraft(e.target.value)}
                className="w-full rounded-md border px-3 py-2 text-sm"
                disabled={task.isArchived}
              />
            </div>

            {editError.serverError && (
              <p className="text-sm text-destructive">{editError.serverError}</p>
            )}

            <div className="flex items-center justify-end">
              <Button
                type="submit"
                disabled={!dirty || task.isArchived || updateMutation.isPending}
              >
                {updateMutation.isPending ? t('saving') : t('save')}
              </Button>
            </div>
          </form>
        ) : (
          /* Read-only view for actors without `tasks.update` (e.g. viewer). */
          <div className="space-y-3 text-sm">
            <div className="space-y-1">
              <span className="font-medium">{t('field.status')}</span>
              <div>{tst(currentStatus)}</div>
            </div>
            <div className="space-y-1">
              <span className="font-medium">{t('field.description')}</span>
              <p className="whitespace-pre-wrap text-muted-foreground">
                {currentDesc ? <NameDisplay name={currentDesc} /> : '—'}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Assignees — read-only for everyone; Manager-only add/remove. */}
      <div className="rounded-md border bg-card p-4">
        <h2 className="mb-3 text-base font-semibold">{t('assigneesSection')}</h2>
        {assignees.isLoading && <ListSkeleton rows={2} />}
        {assignees.isError && (
          <p className="text-sm text-destructive">{t('assigneesLoadFailed')}</p>
        )}
        {assignees.data && assignees.data.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('noAssignees')}</p>
        )}
        {assignees.data && assignees.data.length > 0 && (
          <ul className="mb-3 space-y-1">
            {assignees.data.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-3 rounded-md border bg-background p-2 text-sm"
              >
                <div className="min-w-0 flex-1">
                  {a.name ? (
                    <span className="font-medium">
                      <NameDisplay name={a.name} />
                    </span>
                  ) : (
                    <span className="font-mono text-xs text-muted-foreground" dir="ltr">
                      {t('userIdPrefix')} {a.userIdShort}
                    </span>
                  )}
                  {a.email && (
                    <span className="ms-2 text-xs text-muted-foreground">
                      <NameDisplay name={a.email} />
                    </span>
                  )}
                  <span className="ms-2 text-xs text-muted-foreground">{a.assignedRelative}</span>
                </div>
                {isManager && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onRemoveAssignee(a.userId)}
                    disabled={removeAssigneeMutation.isPending}
                  >
                    {t('removeAssignee')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}

        {isManager && !task.isArchived && (
          <form method="post" action="" onSubmit={onAssign} className="space-y-2">
            <div className="space-y-1">
              <label htmlFor="assignUserId" className="text-sm font-medium">
                {t('addAssignee')}
              </label>
              <select
                id="assignUserId"
                value={assignUserId}
                onChange={(e) => setAssignUserId(e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              >
                <option value="" dir="auto">
                  {t('pickAssignee')}
                </option>
                {eligibleMembers.map((m) => (
                  <option key={m.userId} value={m.userId} dir="auto">
                    {m.name} · {m.email}
                  </option>
                ))}
              </select>
              {eligibleMembers.length === 0 && (
                <p className="text-xs text-muted-foreground">{t('noEligibleAssignees')}</p>
              )}
            </div>
            {assignError.serverError && (
              <p className="text-sm text-destructive">{assignError.serverError}</p>
            )}
            <div className="flex items-center justify-end">
              <Button
                type="submit"
                size="sm"
                disabled={!assignUserId || addAssigneeMutation.isPending}
              >
                {addAssigneeMutation.isPending ? t('assigning') : t('assign')}
              </Button>
            </div>
          </form>
        )}
      </div>

      {/* Archive — Manager-only and only when not yet archived. */}
      {isManager && !task.isArchived && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4">
          <h2 className="mb-2 text-base font-semibold text-destructive">{t('archiveSection')}</h2>
          <p className="mb-3 text-xs text-muted-foreground">{t('archiveHint')}</p>
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
    </div>
  );
}
