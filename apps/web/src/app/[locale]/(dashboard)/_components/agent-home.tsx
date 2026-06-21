'use client';

import { Bell, CheckSquare } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { NameDisplay } from '@/components/ui/name-display';
import { StatusBadge } from '@/components/ui/status-badge';
import { useNotificationList } from '@/hooks/use-notifications';
import { useTaskList } from '@/hooks/use-tasks';

import { MissionControlHome } from './mission-control-home';

/**
 * AgentHome — the role-aware dashboard home for a Tier-1 Agent (#14).
 *
 * E2 Wave-2 E2.1 — the agent now LEADS with the same board-first
 * "signature mission-control" pulse the manager sees: the B1
 * `GET /org/signature-pulse` endpoint is scope-aware on the BE (an agent gets
 * ONLY their assigned projects, ranked most-urgent-first), so the SAME
 * `MissionControlHome` island serves both roles with no widened scope and no
 * role branch — the agent's board is just their slice of the org's.
 *
 * Below the pulse, the agent keeps their own work context (tasks assigned to
 * me + recent notifications), using ONLY data the agent is already authorized
 * to read:
 *
 *   - My tasks      → `useTaskList` → `GET /tasks` (BE returns only rows the
 *                     agent is ASSIGNED to — service-layer JOIN).
 *   - My notifications → `useNotificationList` → `GET /notifications`
 *                     (RLS-self-scoped: every row belongs to the current user).
 *
 * (The former "My projects" card is dropped — the mission-control board already
 * surfaces the agent's projects, ranked by what needs them now, so a second
 * unranked list would be redundant noise against the North-Star triage doctrine.)
 *
 * Client island (TanStack hooks) — matches the codebase's established dashboard
 * pattern. Read-only: no mutating forms. Token-only styling (EMAPP semantic
 * classes; the prior inline `var(--…)` color styles were re-homed to
 * `text-foreground` / `text-text-muted` / `.card` so a re-skin flows through).
 */

const HOME_LIMIT = 5;

export function AgentHome() {
  const t = useTranslations('home.agent');

  const tasks = useTaskList({ limit: HOME_LIMIT });
  const notifications = useNotificationList({ limit: HOME_LIMIT });

  const taskItems = tasks.data?.items ?? [];
  const notificationItems = notifications.data?.items ?? [];

  return (
    <div className="flex flex-col gap-6">
      {/* The agent-scoped mission-control pulse (same island as the manager). */}
      <MissionControlHome />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        {/* My tasks */}
        <section className="card" aria-labelledby="agent-home-tasks-heading">
          <div className="card-hd">
            <div className="flex items-center gap-2.5">
              <CheckSquare className="h-[18px] w-[18px] text-brand" aria-hidden="true" />
              <h3 id="agent-home-tasks-heading">{t('tasks.title')}</h3>
              <Link href="/tasks" className="me-0 ms-auto text-xs text-brand">
                {t('viewAll')}
              </Link>
            </div>
          </div>
          <div className="card-pad">
            {tasks.isLoading ? (
              <p className="text-sm text-text-muted">{t('loading')}</p>
            ) : tasks.isError ? (
              <p className="text-sm text-text-muted">{t('loadFailed')}</p>
            ) : taskItems.length === 0 ? (
              <p className="text-sm text-text-muted">{t('tasks.empty')}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {taskItems.map((task) => (
                  <li key={task.id}>
                    <Link
                      href={`/tasks/${task.id}`}
                      className="flex items-center justify-between gap-3 rounded-md p-2 transition-colors hover:bg-[var(--bg-subtle)]"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          <NameDisplay name={task.title} />
                        </span>
                        {(task.dueRelative || task.isOverdue) && (
                          <span className="text-xs text-text-muted">
                            {task.isOverdue
                              ? t('tasks.overdue')
                              : t('tasks.dueAt', { rel: task.dueRelative as string })}
                          </span>
                        )}
                      </span>
                      <StatusBadge intent={task.intent}>{task.statusLabel}</StatusBadge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* My recent notifications */}
        <section className="card" aria-labelledby="agent-home-notifications-heading">
          <div className="card-hd">
            <div className="flex items-center gap-2.5">
              <Bell className="h-[18px] w-[18px] text-brand" aria-hidden="true" />
              <h3 id="agent-home-notifications-heading">{t('notifications.title')}</h3>
              <Link href="/notifications" className="me-0 ms-auto text-xs text-brand">
                {t('viewAll')}
              </Link>
            </div>
          </div>
          <div className="card-pad">
            {notifications.isLoading ? (
              <p className="text-sm text-text-muted">{t('loading')}</p>
            ) : notifications.isError ? (
              <p className="text-sm text-text-muted">{t('loadFailed')}</p>
            ) : notificationItems.length === 0 ? (
              <p className="text-sm text-text-muted">{t('notifications.empty')}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {notificationItems.map((n) => (
                  <li
                    key={n.id}
                    className={`rounded-md p-2 ${n.isRead ? '' : 'bg-[var(--bg-subtle)]'}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="truncate text-sm font-medium text-foreground">
                        <NameDisplay name={n.title} />
                      </span>
                      <span className="shrink-0 text-xs text-text-muted">{n.createdRelative}</span>
                    </div>
                    {n.body && (
                      <p className="mt-0.5 truncate text-xs text-text-muted">
                        <NameDisplay name={n.body} />
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
