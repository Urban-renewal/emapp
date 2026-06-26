/**
 * Tasks situation-picture grouping + filtering invariants (Slice 3.1).
 *
 * The tasks list is NO LONGER a flat keyset wall: the ACCUMULATED feed is
 * bucketed by DUE DATE (overdue / today / week / later) for at-a-glance triage,
 * mirroring the inbox `groupByKind` idiom. The bug this guards: grouping per
 * keyset PAGE fractures a bucket across page boundaries (an overdue task on page
 * 2 forming a SECOND overdue section). The fix groups the CONCATENATION of all
 * loaded pages — so this pins `groupByDueDate` over a two-page concatenation.
 *
 * `vitest` env is `node` here (no DOM), so we test the EXPORTED pure functions
 * directly (same discipline as `inbox-grouping.spec.ts`).
 */
import type { TaskStatus } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import type { TaskPriorityLevel, TaskViewModel } from '@/models/task.vm';

import {
  buildTasksPulseSentence,
  classifyTaskDue,
  countByDueDate,
  filterTasks,
  groupByDueDate,
} from './group-tasks';

/** A fixed "now" — local noon, so the local-day buckets are TZ-independent
 *  (a UTC ISO near midnight would roll to a different local day on some hosts).
 *  Built from local components, then offset for due dates via `inDays`. */
const NOW = new Date(2026, 5, 25, 12, 0, 0);

/** A due ISO `days` from NOW (fractional ok), kept on stable ground vs midnight
 *  by anchoring to local noon. `inDays(0.25)` = later today; `inDays(3)` = this
 *  week; `inDays(30)` = later. */
function inDays(days: number): string {
  return new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

/** A minimal PII-free task VM; the grouping reads only id / status / priority /
 *  isOverdue / dueAtIso. Everything else is filler the buckets ignore. */
function task(
  id: string,
  opts: {
    dueAtIso?: string | null;
    isOverdue?: boolean;
    status?: TaskStatus;
    priority?: TaskPriorityLevel;
  } = {},
): TaskViewModel {
  return {
    id,
    organizationId: 'org-1',
    projectId: null,
    apartmentId: null,
    title: `task ${id}`,
    description: null,
    type: 'generic',
    status: opts.status ?? 'pending',
    statusLabel: 'ממתין',
    intent: 'neutral',
    priority: opts.priority ?? 2,
    priorityLabel: 'רגילה',
    priorityBadge: 'neutral',
    dueAtIso: opts.dueAtIso ?? null,
    dueRelative: null,
    durationMinutes: null,
    completedAtIso: null,
    completedRelative: null,
    completedBy: null,
    createdBy: 'u-1',
    createdAtIso: '2026-06-20T08:00:00.000Z',
    createdRelative: 'לפני יומיים',
    isOverdue: opts.isOverdue ?? false,
    isTerminal: false,
    isArchived: false,
  };
}

describe('classifyTaskDue', () => {
  it('an isOverdue task is overdue regardless of its dueAt', () => {
    expect(classifyTaskDue(task('a', { isOverdue: true }), NOW)).toBe('overdue');
  });

  it('due later today → today', () => {
    expect(classifyTaskDue(task('a', { dueAtIso: inDays(0.25) }), NOW)).toBe('today');
  });

  it('due within the next 7 days (but after today) → week', () => {
    expect(classifyTaskDue(task('a', { dueAtIso: inDays(3) }), NOW)).toBe('week');
  });

  it('due beyond a week → later', () => {
    expect(classifyTaskDue(task('a', { dueAtIso: inDays(36) }), NOW)).toBe('later');
  });

  it('no due date → later (a deadline-less task is never urgent)', () => {
    expect(classifyTaskDue(task('a', { dueAtIso: null }), NOW)).toBe('later');
  });

  it('an unparseable dueAt → later (never throws)', () => {
    expect(classifyTaskDue(task('a', { dueAtIso: 'not-a-date' }), NOW)).toBe('later');
  });
});

describe('groupByDueDate', () => {
  it('buckets tasks into the canonical attention-first order', () => {
    const items = [
      task('later', { dueAtIso: inDays(40) }),
      task('today', { dueAtIso: inDays(0.2) }),
      task('overdue', { isOverdue: true }),
      task('week', { dueAtIso: inDays(3) }),
    ];
    expect(groupByDueDate(items, NOW).map((g) => g.bucket)).toEqual([
      'overdue',
      'today',
      'week',
      'later',
    ]);
  });

  it('ACCUMULATE-ACROSS-PAGES: one bucket per concatenated page, not per (page, bucket)', () => {
    // Each keyset page carries an overdue + a today task across the boundary.
    const page1 = [task('o1', { isOverdue: true }), task('t1', { dueAtIso: inDays(0.2) })];
    const page2 = [task('o2', { isOverdue: true }), task('t2', { dueAtIso: inDays(0.3) })];
    const groups = groupByDueDate([...page1, ...page2], NOW);

    const overdue = groups.find((g) => g.bucket === 'overdue')!;
    const today = groups.find((g) => g.bucket === 'today')!;
    // ONE overdue group with BOTH pages' overdue tasks (the fractured-wall bug fix).
    expect(overdue.items.map((x) => x.id)).toEqual(['o1', 'o2']);
    expect(today.items.map((x) => x.id)).toEqual(['t1', 't2']);
    expect(groups).toHaveLength(2);
  });

  it('drops empty buckets (only non-empty sections render)', () => {
    const groups = groupByDueDate([task('o', { isOverdue: true })], NOW);
    expect(groups.map((g) => g.bucket)).toEqual(['overdue']);
  });

  it('an empty feed yields no groups (empty state is legible upstream)', () => {
    expect(groupByDueDate([], NOW)).toEqual([]);
  });
});

describe('countByDueDate + buildTasksPulseSentence', () => {
  // A trivial t() stub: echoes the leaf key with its count so we can assert the
  // pulse composition without pulling in next-intl.
  const t = ((key: string, vars?: { count?: number }) =>
    vars?.count === undefined ? key : `${vars.count} ${key}`) as unknown as Parameters<
    typeof buildTasksPulseSentence
  >[0];

  it('tallies every bucket', () => {
    const counts = countByDueDate(
      [
        task('o1', { isOverdue: true }),
        task('o2', { isOverdue: true }),
        task('t1', { dueAtIso: inDays(0.2) }),
        task('l1', { dueAtIso: null }),
      ],
      NOW,
    );
    expect(counts).toEqual({ overdue: 2, today: 1, week: 0, later: 1 });
  });

  it('joins only the non-zero clauses with " · "', () => {
    const counts = { overdue: 3, today: 12, week: 0, later: 0 };
    expect(buildTasksPulseSentence(t, counts)).toBe('3 pulse.overdue · 12 pulse.today');
  });

  it('an all-zero picture returns the calm empty clause', () => {
    const counts = { overdue: 0, today: 0, week: 0, later: 0 };
    expect(buildTasksPulseSentence(t, counts)).toBe('pulse.none');
  });
});

describe('filterTasks (the chip rail narrows the loaded set)', () => {
  const items = [
    task('a', { status: 'pending', priority: 3 }),
    task('b', { status: 'completed', priority: 1 }),
    task('c', { status: 'pending', priority: 1 }),
  ];

  it('a null axis matches everything (the "all" chip)', () => {
    expect(filterTasks(items, { status: null, priority: null })).toHaveLength(3);
  });

  it('narrows by status', () => {
    expect(filterTasks(items, { status: 'pending', priority: null }).map((x) => x.id)).toEqual([
      'a',
      'c',
    ]);
  });

  it('narrows by priority', () => {
    expect(filterTasks(items, { status: null, priority: 3 }).map((x) => x.id)).toEqual(['a']);
  });

  it('ANDs both axes', () => {
    expect(filterTasks(items, { status: 'pending', priority: 1 }).map((x) => x.id)).toEqual(['c']);
  });

  it('a filter that matches nothing yields an empty set (drives the legible no-match panel)', () => {
    expect(filterTasks(items, { status: 'cancelled', priority: null })).toEqual([]);
  });
});
