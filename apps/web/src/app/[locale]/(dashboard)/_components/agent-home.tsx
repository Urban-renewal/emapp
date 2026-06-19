'use client';

import { Bell, CheckSquare, FolderKanban } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';

import { NameDisplay } from '@/components/ui/name-display';
import { StatusBadge } from '@/components/ui/status-badge';
import { useNotificationList } from '@/hooks/use-notifications';
import { useProjectList } from '@/hooks/use-projects';
import { useTaskList } from '@/hooks/use-tasks';

/**
 * AgentHome — the role-aware dashboard home for a Tier-1 Agent (#14).
 *
 * An Agent is assigned-projects-scoped + capability-gated, so the
 * manager-oriented `ManagerHome` (org-wide KPI cards from
 * `GET /org/stats`, which an agent can't read) is not useful to them.
 * This island shows the agent THEIR work, using ONLY data the agent is
 * already authorized to read — no new endpoint, no widened scope:
 *
 *   - My projects   → `useProjectList` → `GET /projects`. The BE scopes
 *                     the list to the agent's ASSIGNED projects
 *                     (service-layer). The FE doesn't filter; it renders
 *                     what the wire delivers.
 *   - My tasks      → `useTaskList` → `GET /tasks`. The BE returns ONLY
 *                     rows the agent is currently ASSIGNED to (service-
 *                     layer JOIN — see `models/task.vm.ts` D.17). So this
 *                     IS "tasks assigned to me" with no extra filter.
 *   - My notifications → `useNotificationList` → `GET /notifications`.
 *                     RLS-self-scoped: every row belongs to the current
 *                     user (see `notification.vm.ts`).
 *
 * Client island (TanStack hooks) — matches the codebase's established
 * dashboard pattern (every `(dashboard)/*` page is `'use client'` with
 * the same hooks; apps/web/CLAUDE.md §v9-M-1). Read-only: no forms.
 *
 * Each section is its own scope: a 403 on one list (e.g. an agent whose
 * capabilities deny a surface) degrades that card to an access-denied
 * note without breaking the others — defense in depth on top of the BE.
 */

const HOME_LIMIT = 5;

export function AgentHome() {
  const t = useTranslations('home.agent');

  const projects = useProjectList({ limit: HOME_LIMIT });
  const tasks = useTaskList({ limit: HOME_LIMIT });
  const notifications = useNotificationList({ limit: HOME_LIMIT });

  const projectItems = projects.data?.items ?? [];
  const taskItems = tasks.data?.items ?? [];
  const notificationItems = notifications.data?.items ?? [];

  return (
    <div className="flex flex-col gap-5">
      {/* Page header */}
      <div>
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
          {t('pageTitle')}
        </h1>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {t('pageSubtitle')}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
        {/* Left column: My projects + My tasks */}
        <div className="flex flex-col gap-4">
          {/* My projects */}
          <section className="card" aria-labelledby="agent-home-projects-heading">
            <div className="card-hd">
              <div className="flex items-center gap-2.5">
                <FolderKanban
                  className="h-[18px] w-[18px]"
                  style={{ color: 'var(--navy-700)' }}
                  aria-hidden="true"
                />
                <h3 id="agent-home-projects-heading">{t('projects.title')}</h3>
                <Link
                  href="/projects"
                  className="me-0 ms-auto text-xs"
                  style={{ color: 'var(--navy-700)' }}
                >
                  {t('viewAll')}
                </Link>
              </div>
            </div>
            <div className="card-pad">
              {projects.isLoading ? (
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  {t('loading')}
                </p>
              ) : projects.isError ? (
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  {t('loadFailed')}
                </p>
              ) : projectItems.length === 0 ? (
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  {t('projects.empty')}
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {projectItems.map((p) => (
                    <li key={p.id}>
                      <Link
                        href={`/projects/${p.id}`}
                        className="flex items-center justify-between gap-3 rounded-md p-2 transition-colors hover:bg-[var(--bg-subtle)]"
                      >
                        <span
                          className="truncate text-sm font-medium"
                          style={{ color: 'var(--text)' }}
                        >
                          <NameDisplay name={p.name} />
                        </span>
                        <StatusBadge intent={p.intent}>{p.statusLabel}</StatusBadge>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {/* My tasks */}
          <section className="card" aria-labelledby="agent-home-tasks-heading">
            <div className="card-hd">
              <div className="flex items-center gap-2.5">
                <CheckSquare
                  className="h-[18px] w-[18px]"
                  style={{ color: 'var(--navy-700)' }}
                  aria-hidden="true"
                />
                <h3 id="agent-home-tasks-heading">{t('tasks.title')}</h3>
                <Link
                  href="/tasks"
                  className="me-0 ms-auto text-xs"
                  style={{ color: 'var(--navy-700)' }}
                >
                  {t('viewAll')}
                </Link>
              </div>
            </div>
            <div className="card-pad">
              {tasks.isLoading ? (
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  {t('loading')}
                </p>
              ) : tasks.isError ? (
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  {t('loadFailed')}
                </p>
              ) : taskItems.length === 0 ? (
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  {t('tasks.empty')}
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {taskItems.map((task) => (
                    <li key={task.id}>
                      <Link
                        href={`/tasks/${task.id}`}
                        className="flex items-center justify-between gap-3 rounded-md p-2 transition-colors hover:bg-[var(--bg-subtle)]"
                      >
                        <span className="min-w-0 flex-1">
                          <span
                            className="block truncate text-sm font-medium"
                            style={{ color: 'var(--text)' }}
                          >
                            <NameDisplay name={task.title} />
                          </span>
                          {(task.dueRelative || task.isOverdue) && (
                            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
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
        </div>

        {/* Right column: My recent notifications */}
        <section className="card" aria-labelledby="agent-home-notifications-heading">
          <div className="card-hd">
            <div className="flex items-center gap-2.5">
              <Bell
                className="h-[18px] w-[18px]"
                style={{ color: 'var(--navy-700)' }}
                aria-hidden="true"
              />
              <h3 id="agent-home-notifications-heading">{t('notifications.title')}</h3>
              <Link
                href="/notifications"
                className="me-0 ms-auto text-xs"
                style={{ color: 'var(--navy-700)' }}
              >
                {t('viewAll')}
              </Link>
            </div>
          </div>
          <div className="card-pad">
            {notifications.isLoading ? (
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                {t('loading')}
              </p>
            ) : notifications.isError ? (
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                {t('loadFailed')}
              </p>
            ) : notificationItems.length === 0 ? (
              <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                {t('notifications.empty')}
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {notificationItems.map((n) => (
                  <li
                    key={n.id}
                    className="rounded-md p-2"
                    style={{ background: n.isRead ? 'transparent' : 'var(--bg-subtle)' }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span
                        className="truncate text-sm font-medium"
                        style={{ color: 'var(--text)' }}
                      >
                        <NameDisplay name={n.title} />
                      </span>
                      <span className="shrink-0 text-xs" style={{ color: 'var(--text-muted)' }}>
                        {n.createdRelative}
                      </span>
                    </div>
                    {n.body && (
                      <p className="mt-0.5 truncate text-xs" style={{ color: 'var(--text-muted)' }}>
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
