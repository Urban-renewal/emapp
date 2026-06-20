/**
 * P4 #14 + E2 Wave-2 E2.1 — test for the role-aware Agent dashboard home.
 *
 * The contract this guards: an Agent is assigned-projects-scoped +
 * capability-gated. AgentHome must surface ONLY data the agent is already
 * authorized to read, and never reach for a manager-only / org-wide privileged
 * endpoint.
 *
 * E2.1 redesign: AgentHome now LEADS with the shared `MissionControlHome`
 * island (the B1 `/org/signature-pulse` board, scope-aware on the BE → an
 * agent's own assigned slice) and KEEPS its own work context below — tasks
 * assigned to me + my notifications — via two already-authorized list hooks:
 * `useTaskList` (BE → tasks assigned to me) and `useNotificationList` (RLS
 * self-scoped). The former "My projects" card was dropped (the board already
 * ranks the agent's projects). `MissionControlHome` is stubbed here so this
 * spec stays focused on the agent-context sections + the no-scope-widening
 * contract (the island has its own spec).
 *
 * Harness mirrors `data-state.spec.ts` / the prior agent-home spec: vitest env
 * is `node` (no jsdom), so we render via `react-dom/server`'s
 * `renderToStaticMarkup` and stub next-intl / next-link / lucide / the island.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Real he.json `home.agent` strings the agent sees.
const AGENT = {
  viewAll: 'הצג הכול',
  loading: 'טוען…',
  loadFailed: 'טעינת הנתונים נכשלה',
  tasksTitle: 'המשימות שלי',
  tasksEmpty: 'אין משימות משויכות',
  notificationsTitle: 'התראות אחרונות',
  notificationsEmpty: 'אין התראות',
} as const;

const T: Record<string, string> = {
  viewAll: AGENT.viewAll,
  loading: AGENT.loading,
  loadFailed: AGENT.loadFailed,
  'tasks.title': AGENT.tasksTitle,
  'tasks.empty': AGENT.tasksEmpty,
  'tasks.overdue': 'באיחור',
  'notifications.title': AGENT.notificationsTitle,
  'notifications.empty': AGENT.notificationsEmpty,
};

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const raw = T[key] ?? `MISSING:${key}`;
    if (key === 'tasks.dueAt') return `יעד: ${String(vars?.['rel'] ?? '')}`;
    return raw;
  },
  useLocale: () => 'he',
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...rest }, children),
}));

vi.mock('lucide-react', () => ({
  Bell: () => createElement('span', { 'data-icon': 'bell' }),
  CheckSquare: () => createElement('span', { 'data-icon': 'check' }),
}));

// The mission-control island is stubbed — it has its own spec; here we only
// assert it is MOUNTED (the agent leads with the board) without pulling its
// hooks into this test.
vi.mock('./mission-control-home', () => ({
  MissionControlHome: () => createElement('div', { 'data-testid': 'mission-control' }),
}));

type HookState<T> = {
  data?: { items: T[]; page?: unknown };
  isLoading: boolean;
  isError: boolean;
};

let tasksState: HookState<{
  id: string;
  title: string;
  statusLabel: string;
  intent: string;
  dueRelative: string | null;
  isOverdue: boolean;
}>;
let notificationsState: HookState<{
  id: string;
  title: string;
  body: string | null;
  isRead: boolean;
  createdRelative: string;
}>;

type HookArg = { limit?: number; cursor?: string } | undefined;
const taskListMock = vi.fn((_arg?: HookArg) => tasksState);
const notificationListMock = vi.fn((_arg?: HookArg) => notificationsState);

vi.mock('@/hooks/use-tasks', () => ({ useTaskList: (arg?: HookArg) => taskListMock(arg) }));
vi.mock('@/hooks/use-notifications', () => ({
  useNotificationList: (arg?: HookArg) => notificationListMock(arg),
}));

vi.mock('@/components/ui/status-badge', () => ({
  StatusBadge: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}));

// NameDisplay is NOT stubbed — test 4 asserts the REAL <bdi> + bidi-strip.

import { AgentHome } from './agent-home';

const here = dirname(fileURLToPath(import.meta.url));

function seedDefaults(): void {
  tasksState = {
    data: {
      items: [
        {
          id: 't1',
          title: 'לאסוף חתימה מדירה 3',
          statusLabel: 'בתהליך',
          intent: 'warning',
          dueRelative: 'מחר',
          isOverdue: false,
        },
      ],
    },
    isLoading: false,
    isError: false,
  };
  notificationsState = {
    data: {
      items: [
        {
          id: 'n1',
          title: 'בקשת חתימה חדשה',
          body: 'נשלחה בקשה',
          isRead: false,
          createdRelative: 'לפני שעה',
        },
      ],
    },
    isLoading: false,
    isError: false,
  };
}

function render(): string {
  return renderToStaticMarkup(createElement(AgentHome));
}

beforeEach(() => {
  seedDefaults();
  taskListMock.mockClear();
  notificationListMock.mockClear();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('AgentHome (P4 #14 + E2.1)', () => {
  it('1) leads with the mission-control board + renders My-tasks / My-notifications', () => {
    const html = render();

    // The agent leads with the same board the manager sees (agent-scoped on BE).
    expect(html).toContain('data-testid="mission-control"');

    // The two agent-context sections + their seeded rows.
    expect(html).toContain(AGENT.tasksTitle);
    expect(html).toContain(AGENT.notificationsTitle);
    expect(html).toContain('לאסוף חתימה מדירה 3'); // task title
    expect(html).toContain('בקשת חתימה חדשה'); // notification title

    // Rows link to the per-entity detail / list routes (no PII in URL).
    expect(html).toMatch(/href="\/tasks\/t1"/);
    expect(html).toMatch(/href="\/tasks"/);
    expect(html).toMatch(/href="\/notifications"/);
  });

  it('2) invokes ONLY the two agent-scoped context hooks, each bounded to limit:5', () => {
    render();

    expect(taskListMock).toHaveBeenCalledTimes(1);
    expect(notificationListMock).toHaveBeenCalledTimes(1);
    expect(taskListMock).toHaveBeenCalledWith({ limit: 5 });
    expect(notificationListMock).toHaveBeenCalledWith({ limit: 5 });
  });

  it('2b) source CODE imports NONE of the manager-only data hooks/endpoints', () => {
    const raw = readFileSync(resolve(here, 'agent-home.tsx'), 'utf8');
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    const importSpecifiers = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

    // The agent-scoped context hooks ARE imported.
    expect(importSpecifiers).toContain('@/hooks/use-tasks');
    expect(importSpecifiers).toContain('@/hooks/use-notifications');

    // NO manager-only / org-wide privileged data module is imported directly
    // (the shared board reads the BE-scoped pulse, which is NOT org/stats).
    const forbidden = /use-members|use-owners|org-stats|use-org\b/;
    expect(importSpecifiers.filter((s) => forbidden.test(s ?? ''))).toHaveLength(0);
    expect(code).not.toMatch(/\borg\/stats\b/);
    expect(code).not.toMatch(/useOrgStats|fetchOrgStats|useMemberList|useOwnerList/);
    expect(code).not.toMatch(/\bManagerHome\b/);
  });

  it('3a) a context hook in isLoading shows that section loading ONLY; sibling renders', () => {
    tasksState = { isLoading: true, isError: false };
    const html = render();

    expect(html).toContain(AGENT.loading);
    expect(html).toContain('בקשת חתימה חדשה'); // notifications unaffected
    expect(html).not.toContain(AGENT.tasksEmpty);
  });

  it('3b) a context hook in isError shows that section error ONLY; sibling renders', () => {
    tasksState = { isLoading: false, isError: true };
    const html = render();

    expect(html).toContain(AGENT.loadFailed);
    expect(html).toContain('בקשת חתימה חדשה'); // notifications unaffected
    expect(html).not.toContain('לאסוף חתימה מדירה 3');
  });

  it('3c) empty lists show each section empty-state copy (not error copy)', () => {
    tasksState = { data: { items: [] }, isLoading: false, isError: false };
    notificationsState = { data: { items: [] }, isLoading: false, isError: false };
    const html = render();

    expect(html).toContain(AGENT.tasksEmpty);
    expect(html).toContain(AGENT.notificationsEmpty);
    expect(html).not.toContain(AGENT.loadFailed);
  });

  it('4) wraps task/notification names in <bdi> and strips bidi overrides', () => {
    // U+202E written as an escape (not the literal codepoint) so this spec
    // file doesn't trip eslint security/detect-bidi-characters.
    const RLO = '\u202E';
    tasksState = {
      data: {
        items: [
          {
            id: 't1',
            title: `משימה${RLO}x`,
            statusLabel: 'x',
            intent: 'neutral',
            dueRelative: null,
            isOverdue: false,
          },
        ],
      },
      isLoading: false,
      isError: false,
    };
    notificationsState = {
      data: {
        items: [
          { id: 'n1', title: `התראה${RLO}y`, body: null, isRead: true, createdRelative: 'עכשיו' },
        ],
      },
      isLoading: false,
      isError: false,
    };
    const html = render();

    expect(html).not.toContain(RLO);
    expect(html).toContain('<bdi>');
    expect(html).toContain('משימהx');
    expect(html).toContain('התראהy');
  });
});
