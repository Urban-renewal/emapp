'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ListPageShell } from '@/components/ui/list-page-shell';
import { NameDisplay } from '@/components/ui/name-display';
import { StatusBadge } from '@/components/ui/status-badge';
import { useHasPermission } from '@/hooks/use-permissions';
import { useTaskList } from '@/hooks/use-tasks';

/**
 * Tasks list — D.17 read=ALL with Agent service-layer scoping.
 *
 * The BE returns ONLY rows the caller may see (Manager/Viewer → org;
 * Agent → own assignments). The FE doesn't replicate this filter — it
 * just renders what the wire delivers. IAM slice 5b: the "create" CTA now
 * renders only for actors holding `tasks.create` (manager + agent; viewer
 * never) — no more dead button. BE AuthorizationGuard stays authoritative.
 */
export default function TasksPage() {
  const t = useTranslations('tasks');
  const tp = useTranslations('projects');
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const canCreate = useHasPermission('tasks.create');
  const { data, isLoading, isError, refetch } = useTaskList({ limit: 25, cursor });
  const items = data?.items ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{t('listTitle')}</h1>
        {canCreate && (
          <Button asChild>
            <Link href="/tasks/new">{t('create')}</Link>
          </Button>
        )}
      </div>

      <ListPageShell
        isLoading={isLoading}
        isError={isError}
        itemCount={items.length}
        page={data?.page}
        cursor={cursor}
        loadFailedLabel={t('loadFailed')}
        emptyLabel={t('empty')}
        retryLabel={tp('retry')}
        nextLabel={tp('next')}
        resetLabel={tp('resetToFirstPage')}
        onRetry={() => refetch()}
        onNext={(next) => setCursor(next)}
        onReset={() => setCursor(undefined)}
      >
        <ul className="space-y-2">
          {items.map((task) => (
            <li key={task.id} className="rounded-md border bg-card p-4">
              <Link href={`/tasks/${task.id}`} className="block">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate text-base font-semibold">
                        <NameDisplay name={task.title} />
                      </h2>
                      <StatusBadge color={task.statusColor}>{task.statusLabel}</StatusBadge>
                      {task.priority === 3 && (
                        <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                          {task.priorityLabel}
                        </span>
                      )}
                      {task.isOverdue && (
                        <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800">
                          {t('overdue')}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {task.dueRelative ? <>{t('dueAt', { rel: task.dueRelative })} · </> : null}
                      {task.createdRelative}
                    </p>
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </ListPageShell>
    </div>
  );
}
