import type { TaskStatus } from '@emapp/shared-types';
import type { useTranslations } from 'next-intl';

import type { TaskPriorityLevel, TaskViewModel } from '@/models/task.vm';

/**
 * Tasks situation-picture grouping — the `groupByKind` idiom
 * (`inbox/inbox-list.client.tsx`) re-applied to the tasks list, bucketing by
 * DUE DATE instead of proposal kind. Pure + deterministic so the
 * accumulate-across-pages invariant is unit-testable directly.
 */

/** The due-date buckets, in attention-shaped order (most-urgent first). A bucket
 *  not present in the loaded set is simply omitted from the rendered sections. */
export const DUE_BUCKET_ORDER = ['overdue', 'today', 'week', 'later'] as const;

export type DueBucket = (typeof DUE_BUCKET_ORDER)[number];

export interface TaskGroup {
  bucket: DueBucket;
  items: TaskViewModel[];
}

/** Counts per bucket — the shape the pulse sentence reads. */
export interface DueBucketCounts {
  overdue: number;
  today: number;
  week: number;
  later: number;
}

/**
 * Classify ONE task into its due-date bucket, relative to `now`:
 *  - `overdue` — the VM already derived `isOverdue` (dueAt < now AND not
 *     terminal); we trust that single source rather than recompute the cutoff.
 *  - `today`   — due today (same calendar day in the viewer's local tz).
 *  - `week`    — due within the next 7 days (after today).
 *  - `later`   — due beyond a week, OR no due date at all (a task with no
 *     deadline is never "urgent", so it sorts to the calm tail).
 *
 * Terminal tasks (completed / cancelled) keep their due bucket but are never
 * flagged overdue by the VM, so they fall to today/week/later naturally.
 */
export function classifyTaskDue(task: TaskViewModel, now: Date): DueBucket {
  if (task.isOverdue) return 'overdue';
  if (!task.dueAtIso) return 'later';

  const due = new Date(task.dueAtIso);
  if (Number.isNaN(due.getTime())) return 'later';

  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTomorrow = new Date(startOfToday);
  startOfTomorrow.setDate(startOfTomorrow.getDate() + 1);
  const startOfWeekEnd = new Date(startOfToday);
  startOfWeekEnd.setDate(startOfWeekEnd.getDate() + 7);

  if (due < startOfTomorrow) return 'today';
  if (due < startOfWeekEnd) return 'week';
  return 'later';
}

/**
 * Group the ACCUMULATED tasks feed by due-date bucket for at-a-glance triage.
 * Pure + deterministic; buckets render in `DUE_BUCKET_ORDER`, each preserving
 * the feed's incoming order. Empty buckets are dropped.
 *
 * Exported so the accumulate-across-pages invariant is unit-tested directly:
 * grouping the CONCATENATION of two keyset pages must yield ONE group per bucket
 * with combined counts (the per-page-grouping illusion this fixes).
 *
 * `now` is injectable so tests are deterministic; the UI passes the real clock.
 */
export function groupByDueDate(items: TaskViewModel[], now: Date = new Date()): TaskGroup[] {
  const byBucket = new Map<DueBucket, TaskViewModel[]>();
  for (const task of items) {
    const bucket = classifyTaskDue(task, now);
    const list = byBucket.get(bucket);
    if (list) list.push(task);
    else byBucket.set(bucket, [task]);
  }

  const groups: TaskGroup[] = [];
  for (const bucket of DUE_BUCKET_ORDER) {
    const list = byBucket.get(bucket);
    if (list && list.length > 0) groups.push({ bucket, items: list });
  }
  return groups;
}

/** Tally each bucket's size (drives the pulse sentence). */
export function countByDueDate(items: TaskViewModel[], now: Date = new Date()): DueBucketCounts {
  const counts: DueBucketCounts = { overdue: 0, today: 0, week: 0, later: 0 };
  for (const task of items) counts[classifyTaskDue(task, now)] += 1;
  return counts;
}

/** The active filter selection (null on an axis = "all"). The SINGLE source the
 *  filter rail writes and `filterTasks` reads — so the chips, the grouping, and
 *  the honesty line all describe the same narrowed set. */
export interface TaskFilter {
  status: TaskStatus | null;
  priority: TaskPriorityLevel | null;
}

/**
 * Apply the status + priority filter to the accumulated set — pure, so the
 * "filter works" invariant (a chip narrows the rendered tasks) is unit-testable
 * without a DOM. A null axis matches everything; both axes AND together.
 */
export function filterTasks(items: TaskViewModel[], filter: TaskFilter): TaskViewModel[] {
  return items.filter(
    (task) =>
      (filter.status === null || task.status === filter.status) &&
      (filter.priority === null || task.priority === filter.priority),
  );
}

/**
 * The ONE pulse sentence for the tasks board — the `buildPulseSentence` idiom
 * (`_components/situation-picture/board-primitives.tsx`): each non-zero bucket
 * contributes one plain clause, joined with " · " ("3 שחלפו · 12 היום"). When
 * nothing is loaded the calm empty clause is returned.
 *
 * Literal `t()` keys (never a template) so the i18n-coverage guard verifies them.
 */
export function buildTasksPulseSentence(
  t: ReturnType<typeof useTranslations>,
  counts: DueBucketCounts,
): string {
  const clauses: string[] = [];
  if (counts.overdue > 0) clauses.push(t('pulse.overdue', { count: counts.overdue }));
  if (counts.today > 0) clauses.push(t('pulse.today', { count: counts.today }));
  if (counts.week > 0) clauses.push(t('pulse.week', { count: counts.week }));
  if (counts.later > 0) clauses.push(t('pulse.later', { count: counts.later }));
  if (clauses.length === 0) return t('pulse.none');
  return clauses.join(' · ');
}
