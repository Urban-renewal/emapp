'use client';

import type { TaskStatus } from '@emapp/shared-types';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { DataState } from '@/components/ui/data-state';
import { NameDisplay } from '@/components/ui/name-display';
import { StatusBadge } from '@/components/ui/status-badge';
import { useHasPermission } from '@/hooks/use-permissions';
import type { TaskPriorityLevel, TaskViewModel } from '@/models/task.vm';

import {
  buildTasksPulseSentence,
  countByDueDate,
  filterTasks,
  groupByDueDate,
  type DueBucket,
  type TaskGroup,
} from './group-tasks';
import { useTasksFeed } from './use-tasks-feed';

/**
 * Tasks SITUATION-PICTURE (Slice 3.1) — turns the flat keyset wall into an
 * at-a-glance, attention-first board, consistent with the home/inbox boards
 * (same grammar: pulse line → filter rail → grouped sections → honesty line →
 * accumulate "show more").
 *
 * Why it is not a flat wall (CLAUDE.md §G-QA SCALE-READY / NO-FLAT): at 150
 * tasks the legacy single `.map` is unscannable. Here the feed ACCUMULATES every
 * keyset page (`useTasksFeed`) BEFORE grouping, so the buckets (overdue / today /
 * week / later) are real cross-page groups — an overdue task on page 2 joins
 * page 1's overdue section, never forms a second one. A light status/priority
 * chip rail narrows the loaded set, and a one-line plain-Hebrew pulse
 * ("3 שחלפו · 12 היום") states the whole picture in one glance.
 *
 * Single source of truth: it COMPOSES the canonical `useTaskList` (via
 * `useTasksFeed`) + the `groupByKind`/`buildPulseSentence` idioms — it does not
 * re-implement grouping or the list fetch. The BE stays authoritative on
 * visibility (D.17 role scoping); the FE only renders what the wire delivers.
 *
 * RSC prefetch parity: `useTasksFeed`'s first page key matches the dehydrated
 * seed `page.tsx` writes, so the first render resolves synchronously (no
 * fetch-after-hydration waterfall).
 */
export function TasksListClient() {
  const t = useTranslations('tasks');
  const feed = useTasksFeed();
  const canCreate = useHasPermission('tasks.create');

  const [status, setStatus] = useState<TaskStatus | null>(null);
  const [priority, setPriority] = useState<TaskPriorityLevel | null>(null);

  // Filter the ACCUMULATED set client-side (status + priority). The grouping
  // then runs over the filtered list, so the pulse + sections + honesty line all
  // describe the SAME narrowed set (one source, never drifting).
  const filtered = useMemo(
    () => filterTasks(feed.items, { status, priority }),
    [feed.items, status, priority],
  );

  // Group + tally are computed from a single, stable `now` so a row never lands
  // in one bucket while the pulse counts it in another (sync, one computation).
  const { groups, counts } = useMemo(() => {
    const now = new Date();
    return { groups: groupByDueDate(filtered, now), counts: countByDueDate(filtered, now) };
  }, [filtered]);

  const pulse = buildTasksPulseSentence(t, counts);
  const isFilterActive = status !== null || priority !== null;
  const showFilteredEmpty = !feed.isLoading && feed.items.length > 0 && filtered.length === 0;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      {/* Situation header — LEADS with the pulse (the user's picture), CTA aside. */}
      <header className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">{t('listTitle')}</h1>
          {canCreate && (
            <Button asChild>
              <Link href="/tasks/new">{t('create')}</Link>
            </Button>
          )}
        </div>
        {feed.items.length > 0 && (
          <p className="text-[15px] font-medium" style={{ color: 'var(--text)' }}>
            {pulse}
          </p>
        )}
      </header>

      {/* Filter rail — status + priority chips. Narrows the loaded set; scannable
          at hundreds of tasks. Hidden until there's more than one task. */}
      {feed.items.length > 1 && (
        <TaskFilterRail
          status={status}
          priority={priority}
          onStatus={setStatus}
          onPriority={setPriority}
        />
      )}

      <DataState
        isLoading={feed.isLoading}
        isError={feed.isError}
        error={feed.error}
        onRetry={() => feed.retry()}
        skeleton="list"
        isEmpty={!feed.isLoading && feed.items.length === 0}
        emptyTitle={t('empty')}
        emptyHint={t('emptyHint')}
      >
        {/* HONESTY LINE — a non-technical user must never read the loaded groups
            as "everything". States how many tasks are loaded (and, when filtered,
            how many of the loaded set match) + that "Show more" loads the rest. */}
        {feed.items.length > 0 && (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }} role="status">
            {isFilterActive
              ? t('loadedFiltered', { shown: filtered.length, loaded: feed.items.length })
              : feed.isExhausted
                ? t('loadedAll', { count: feed.items.length })
                : t('loadedPartial', { count: feed.items.length })}
          </p>
        )}

        {/* Filtered-to-empty — the loaded set has tasks but none match the chips.
            Legible (not a dead end): tell him + offer to clear the filter. */}
        {showFilteredEmpty ? (
          <div
            className="rounded-md border p-4 text-sm"
            style={{ color: 'var(--text-muted)', borderColor: 'var(--border)' }}
          >
            <p>{t('noMatch')}</p>
            <button
              type="button"
              onClick={() => {
                setStatus(null);
                setPriority(null);
              }}
              className="mt-2 text-xs font-medium underline"
              style={{ color: 'var(--text)' }}
            >
              {t('clearFilter')}
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {groups.map((group) => (
              <TaskGroupSection key={group.bucket} group={group} />
            ))}
          </div>
        )}

        {/* Accumulate "show more" — pages the feed; grouping runs over the whole
            loaded set. Mirrors the inbox / documents feed's LoadMore. */}
        {feed.canLoadMore && (
          <div className="mt-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => feed.loadMore()}
              disabled={feed.isFetchingMore}
            >
              {feed.isFetchingMore ? t('loadingMore') : t('loadMore')}
            </Button>
          </div>
        )}
      </DataState>
    </div>
  );
}

/** The status + priority filter rail — calm chips mirroring the inbox
 *  `KindFilter`. Each axis has an "all" chip; selecting narrows the loaded set
 *  client-side. Toggling a pressed chip clears that axis. */
function TaskFilterRail({
  status,
  priority,
  onStatus,
  onPriority,
}: {
  status: TaskStatus | null;
  priority: TaskPriorityLevel | null;
  onStatus: (s: TaskStatus | null) => void;
  onPriority: (p: TaskPriorityLevel | null) => void;
}) {
  const t = useTranslations('tasks');
  const statuses: TaskStatus[] = ['pending', 'in_progress', 'completed', 'cancelled'];
  const priorities: TaskPriorityLevel[] = [3, 2, 1];

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5" aria-label={t('filter.statusLabel')}>
        <FilterChip
          active={status === null}
          onClick={() => onStatus(null)}
          label={t('filter.all')}
        />
        {statuses.map((s) => (
          <FilterChip
            key={s}
            active={status === s}
            onClick={() => onStatus(status === s ? null : s)}
            label={t(`status.${s}`)}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5" aria-label={t('filter.priorityLabel')}>
        <FilterChip
          active={priority === null}
          onClick={() => onPriority(null)}
          label={t('filter.allPriorities')}
        />
        {priorities.map((p) => (
          <FilterChip
            key={p}
            active={priority === p}
            onClick={() => onPriority(priority === p ? null : p)}
            label={t(`priority.${p}`)}
          />
        ))}
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className="rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors"
      style={{
        background: active ? 'var(--text)' : 'var(--bg-surface)',
        color: active ? 'var(--bg-surface)' : 'var(--text-muted)',
        border: active ? 'none' : '1px solid var(--border)',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

/** One due-date group: an attention-shaped heading (label + count) over the task
 *  rows for that bucket. The heading reads the plain-Hebrew bucket label (never a
 *  raw bucket key). Mirrors the inbox `InboxGroupSection`. */
function TaskGroupSection({ group }: { group: TaskGroup }) {
  const t = useTranslations('tasks');
  const heading = t(`bucket.${group.bucket}`);

  return (
    <section aria-label={heading} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
          {heading}
        </h2>
        <span
          className="shrink-0 rounded-full px-1.5 text-xs tabular-nums"
          style={{ background: 'var(--bg-subtle)', color: 'var(--text-muted)' }}
        >
          {t('bucket.count', { count: group.items.length })}
        </span>
      </div>
      <ul className="space-y-2">
        {group.items.map((task) => (
          <TaskRow key={task.id} task={task} bucket={group.bucket} />
        ))}
      </ul>
    </section>
  );
}

/** One task row — the legacy card markup, preserved (status + priority + overdue
 *  badges, due/created relative line), now living inside its bucket. */
function TaskRow({ task, bucket }: { task: TaskViewModel; bucket: DueBucket }) {
  const t = useTranslations('tasks');
  return (
    <li className="rounded-md border bg-card p-4">
      <Link href={`/tasks/${task.id}`} className="block">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-base font-semibold">
                <NameDisplay name={task.title} />
              </h3>
              <StatusBadge intent={task.intent}>{task.statusLabel}</StatusBadge>
              {task.priority === 3 && (
                <span className="rounded-full bg-status-danger-bg px-2 py-0.5 text-xs font-medium text-status-danger-fg">
                  {task.priorityLabel}
                </span>
              )}
              {/* The overdue badge is redundant inside the "overdue" bucket — the
                  section heading already says it — so suppress it there to keep
                  the row calm; it stays for an overdue task surfaced elsewhere. */}
              {task.isOverdue && bucket !== 'overdue' && (
                <span className="rounded-full bg-status-danger-bg px-2 py-0.5 text-xs font-medium text-status-danger-fg">
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
  );
}
