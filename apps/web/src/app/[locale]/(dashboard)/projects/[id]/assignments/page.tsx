'use client';

import { OrgRoleEnum, type CreateProjectAssignment } from '@emapp/shared-types';
import { useQuery } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import type { AssignmentMemberLookup } from '@/adapters/project-assignment';
import { Button } from '@/components/ui/button';
import { ListPageShell } from '@/components/ui/list-page-shell';
import { NameDisplay } from '@/components/ui/name-display';
import { useApiErrorHandler } from '@/hooks/use-api-error-handler';
import {
  useCreateProjectAssignment,
  useProjectAssignmentList,
  useUnassignProjectAssignment,
} from '@/hooks/use-assignments';
import { ApiClientError } from '@/lib/api/errors';
import { listMembers } from '@/lib/api/members';
import { useDisplayLocale } from '@/lib/locale';

/**
 * Project Assignments page (D.17 — read=ALL, write=MGR).
 *
 * The Wire shape carries only IDs; to render human names we side-load
 * `/members` (Manager-only) and JOIN client-side. For Agent / Viewer
 * the members fetch 403s → `lookup` stays undefined → adapter degrades
 * to `userIdShort`. The 403 is the SIGNAL we use to decide whether to
 * render the assign-form (only Manager can create; this matches the
 * BE's AuthorizationGuard exactly so the UI never offers a button that
 * can't succeed).
 *
 * `retry: false` on the members query: a Manager's first request
 * either returns 200 (cached for 30s afterwards) or 5xx (rare); a
 * non-Manager's request returns 403 immediately and we don't want
 * three exponential-backoff retries (~7s) before the UI settles into
 * its read-only mode.
 */
export default function ProjectAssignmentsPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const projectId = params?.id;
  const t = useTranslations('assignments');
  const tp = useTranslations('projects');
  const trl = useTranslations('nav.role');
  const locale = useDisplayLocale();

  // Side-load /members for the userId → {name,email} lookup. Cache-
  // shared with the Members page via a sibling queryKey so navigating
  // from /members to /projects/X/assignments is one fetch, not two.
  const membersQuery = useQuery({
    queryKey: ['members', 'list', { limit: 100 }, locale, 'assignments-side-load'],
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

  const isManager = membersQuery.isSuccess;
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const list = useProjectAssignmentList(projectId, { limit: 25, cursor }, lookup);
  // TanStack's structural sharing keeps `list.data.items` stable across
  // re-renders when the underlying rows don't change — referencing it
  // directly (rather than via a fallback `?? []` const) is what makes
  // the `eligibleMembers` useMemo cache stable. See the
  // react-hooks/exhaustive-deps lint warning that drove this shape.
  const items = useMemo(() => list.data?.items ?? [], [list.data?.items]);

  // Assign form state — only used by Managers.
  const [assignUserId, setAssignUserId] = useState<string>('');
  const [assignRole, setAssignRole] = useState<string>('agent');
  const createMutation = useCreateProjectAssignment(projectId);
  const unassignMutation = useUnassignProjectAssignment(projectId);

  const {
    serverError: assignError,
    handle: handleAssignError,
    reset: resetAssignError,
  } = useApiErrorHandler<CreateProjectAssignment>({
    codeOverrides: {
      assignment_exists: () => t('assignmentExists'),
      invalid_assignee: () => t('invalidAssignee'),
      forbidden: () => t('forbidden'),
    },
    fallback: () => t('createFailed'),
  });
  const {
    serverError: unassignError,
    handle: handleUnassignError,
    reset: resetUnassignError,
  } = useApiErrorHandler<CreateProjectAssignment>({
    codeOverrides: { forbidden: () => t('forbidden') },
    fallback: () => t('unassignFailed'),
  });

  // Eligible members for the dropdown — only active org users (not
  // revoked, not pending), and exclude userIds that already have an
  // active assignment on this project (the BE returns
  // `assignment_exists` if a duplicate is attempted; this is purely UI
  // sugar — a stale page that allows a dupe still maps to the same
  // error code via codeOverrides).
  const eligibleMembers = useMemo(() => {
    if (!membersQuery.data) return [];
    const assigned = new Set(items.filter((a) => a.active).map((a) => a.userId));
    return membersQuery.data.items.filter(
      (m) => m.revokedAt === null && m.acceptedAt !== null && !assigned.has(m.userId),
    );
  }, [membersQuery.data, items]);

  async function onAssignSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!projectId || !assignUserId) return;
    resetAssignError();
    try {
      await createMutation.mutateAsync({ userId: assignUserId, roleInProject: assignRole });
      setAssignUserId('');
      setAssignRole('agent');
    } catch (err) {
      handleAssignError(err);
    }
  }

  async function onUnassign(id: string) {
    resetUnassignError();
    if (!window.confirm(t('unassignConfirm'))) return;
    try {
      await unassignMutation.mutateAsync(id);
    } catch (err) {
      handleUnassignError(err);
    }
  }

  return (
    <div className="space-y-6" dir="rtl">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <Button variant="ghost" onClick={() => projectId && router.push(`/projects/${projectId}`)}>
          {tp('backToList').replace('לרשימה', 'לפרויקט')}
        </Button>
      </div>

      {/* Assign form — Manager-only. Hidden while the members query
          is in flight or after it 403s for non-Managers. */}
      {isManager && (
        <div className="rounded-md border bg-card p-4">
          <h2 className="mb-3 text-base font-semibold">{t('assignSection')}</h2>
          {/* §S1-SEC1 — method="post" defense in depth. */}
          <form method="post" action="" onSubmit={onAssignSubmit} className="space-y-3">
            <div className="space-y-1">
              <label htmlFor="userId" className="text-sm font-medium">
                {t('field.user')}
              </label>
              <select
                id="userId"
                value={assignUserId}
                onChange={(e) => setAssignUserId(e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              >
                <option value="" dir="auto">
                  {t('field.userPlaceholder')}
                </option>
                {eligibleMembers.map((m) => (
                  <option key={m.userId} value={m.userId} dir="auto">
                    {m.name} · {m.email} · {trl(m.role)}
                  </option>
                ))}
              </select>
              {eligibleMembers.length === 0 && (
                <p className="text-xs text-muted-foreground">{t('noEligibleMembers')}</p>
              )}
            </div>

            <div className="space-y-1">
              <label htmlFor="roleInProject" className="text-sm font-medium">
                {t('field.roleInProject')}
              </label>
              <select
                id="roleInProject"
                value={assignRole}
                onChange={(e) => setAssignRole(e.target.value)}
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
              >
                {OrgRoleEnum.options.map((r) => (
                  <option key={r} value={r} dir="auto">
                    {trl(r)}
                  </option>
                ))}
              </select>
            </div>

            {assignError && <p className="text-sm text-destructive">{assignError}</p>}

            <div className="flex items-center justify-end">
              <Button type="submit" disabled={!assignUserId || createMutation.isPending}>
                {createMutation.isPending ? t('assigning') : t('assign')}
              </Button>
            </div>
          </form>
        </div>
      )}

      {unassignError && <p className="text-sm text-destructive">{unassignError}</p>}

      <ListPageShell
        isLoading={list.isLoading}
        isError={list.isError}
        itemCount={items.length}
        page={list.data?.page}
        cursor={cursor}
        loadFailedLabel={t('loadFailed')}
        emptyLabel={t('empty')}
        retryLabel={tp('retry')}
        nextLabel={tp('next')}
        resetLabel={tp('resetToFirstPage')}
        onRetry={() => list.refetch()}
        onNext={(next) => setCursor(next)}
        onReset={() => setCursor(undefined)}
      >
        <ul className="space-y-2">
          {items.map((a) => (
            <li
              key={a.id}
              className="flex items-center justify-between gap-4 rounded-md border bg-card p-4"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3">
                  <h2 className="truncate text-base font-semibold">
                    {a.name ? (
                      <NameDisplay name={a.name} />
                    ) : (
                      <span className="font-mono text-sm text-muted-foreground" dir="ltr">
                        {t('userIdPrefix')} {a.userIdShort}
                      </span>
                    )}
                  </h2>
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs">
                    {a.roleInProject}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {a.email && (
                    <>
                      <NameDisplay name={a.email} /> ·{' '}
                    </>
                  )}
                  {t('assignedAt', { rel: a.assignedRelative })}
                </p>
              </div>
              {isManager && a.active && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onUnassign(a.id)}
                  disabled={unassignMutation.isPending}
                >
                  {unassignMutation.isPending ? t('unassigning') : t('unassign')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      </ListPageShell>

      {membersQuery.isError &&
        membersQuery.error instanceof ApiClientError &&
        membersQuery.error.code !== 'forbidden' && (
          <p className="text-xs text-muted-foreground">{t('lookupFailedHint')}</p>
        )}
    </div>
  );
}
