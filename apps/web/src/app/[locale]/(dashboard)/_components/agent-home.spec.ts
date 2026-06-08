/**
 * P4 #14 — test for the role-aware Agent dashboard home.
 *
 * The contract this guards (and the reason the home was split at all):
 * an Agent is assigned-projects-scoped + capability-gated. `ManagerHome`
 * surfaces org-WIDE aggregates (`GET /org/stats`) the agent can't read,
 * so the agent gets `AgentHome` — a strictly agent-scoped surface that
 * shows ONLY the agent's own work via three already-authorized list
 * hooks: `useProjectList` (BE → assigned projects), `useTaskList`
 * (BE → tasks assigned to me), `useNotificationList` (RLS self-scoped).
 *
 * Why render the REAL component (not a source grep): the load-bearing
 * property is "the agent home cannot surface data an agent isn't
 * authorized for". We prove that two ways:
 *   (a) by mocking the three agent-scoped hooks and asserting the markup
 *       contains exactly their seeded data + the real he.json headings;
 *   (b) by asserting NO manager-only data path is reachable — the module
 *       imports none of the org/stats / members / owners machinery, and
 *       only the three agent hooks are invoked during a render.
 *
 * Harness mirrors `sidebar.spec.ts` exactly: vitest env is `node` (no
 * jsdom), so we render via `react-dom/server`'s `renderToStaticMarkup`
 * (an HTML string we assert on) and stub next-intl / next-link.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Real he.json `home.agent` strings — the headings/labels a real
//     agent sees. Asserting against these (not made-up copy) means a
//     renamed/removed translation key surfaces here as a loud failure. ---
const AGENT = {
  pageTitle: 'המשימות שלי',
  pageSubtitle: 'הפרויקטים, המשימות וההתראות שמשויכים אליך',
  viewAll: 'הצג הכול',
  loading: 'טוען…',
  loadFailed: 'טעינת הנתונים נכשלה',
  projectsTitle: 'הפרויקטים שלי',
  projectsEmpty: 'אין פרויקטים משויכים',
  tasksTitle: 'המשימות שלי',
  tasksEmpty: 'אין משימות משויכות',
  notificationsTitle: 'התראות אחרונות',
  notificationsEmpty: 'אין התראות',
} as const;

// next-intl: useTranslations('home.agent') → keyed lookup into a table
// built from the real strings. A key the component asks for that isn't
// modelled here renders a visible MISSING:<key> token → loud failure.
const T: Record<string, string> = {
  pageTitle: AGENT.pageTitle,
  pageSubtitle: AGENT.pageSubtitle,
  viewAll: AGENT.viewAll,
  loading: AGENT.loading,
  loadFailed: AGENT.loadFailed,
  'projects.title': AGENT.projectsTitle,
  'projects.empty': AGENT.projectsEmpty,
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

// next/link → plain anchor so renderToStaticMarkup emits href + children.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...rest }, children),
}));

// lucide-react icons → inert markers (the real SVG components pull in no
// data; stubbing keeps the markup small + deterministic).
vi.mock('lucide-react', () => ({
  Bell: () => createElement('span', { 'data-icon': 'bell' }),
  CheckSquare: () => createElement('span', { 'data-icon': 'check' }),
  FolderKanban: () => createElement('span', { 'data-icon': 'folder' }),
}));

// --- The three agent-scoped data hooks. Each is independently seedable
//     per test (loading / error / empty / data). We DELIBERATELY do not
//     provide any manager hook — if AgentHome tried to import one, the
//     unmocked real module would load (and its absence of org/stats data
//     would be observable); test 2 asserts it imports none. ---
type HookState<T> = {
  data?: { items: T[]; page?: unknown };
  isLoading: boolean;
  isError: boolean;
};

let projectsState: HookState<{
  id: string;
  name: string;
  statusLabel: string;
  statusColor: string;
}>;
let tasksState: HookState<{
  id: string;
  title: string;
  statusLabel: string;
  statusColor: string;
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

// Each hook takes a single options object ({ limit, cursor }); the spy
// records it so test 2 can assert the bounded `{ limit: 5 }` call.
type HookArg = { limit?: number; cursor?: string } | undefined;
const projectListMock = vi.fn((_arg?: HookArg) => projectsState);
const taskListMock = vi.fn((_arg?: HookArg) => tasksState);
const notificationListMock = vi.fn((_arg?: HookArg) => notificationsState);

vi.mock('@/hooks/use-projects', () => ({
  useProjectList: (arg?: HookArg) => projectListMock(arg),
}));
vi.mock('@/hooks/use-tasks', () => ({ useTaskList: (arg?: HookArg) => taskListMock(arg) }));
vi.mock('@/hooks/use-notifications', () => ({
  useNotificationList: (arg?: HookArg) => notificationListMock(arg),
}));

// StatusBadge is a pure pill; passthrough so the label text renders.
vi.mock('@/components/ui/status-badge', () => ({
  StatusBadge: ({ children }: { children: ReactNode }) => createElement('span', null, children),
}));

// NameDisplay is NOT stubbed — test 4 asserts the REAL <bdi> + bidi-strip
// behaviour (names are wire-supplied, so they must be wrapped). It is a
// pure component (no data), safe to render directly under react-dom/server.

import { AgentHome } from './agent-home';

const here = dirname(fileURLToPath(import.meta.url));

/** Default each hook to a single seeded row before every test. */
function seedDefaults(): void {
  projectsState = {
    data: {
      items: [
        { id: 'p1', name: 'מגדל הרצל 14', statusLabel: 'באיסוף חתימות', statusColor: 'amber' },
      ],
    },
    isLoading: false,
    isError: false,
  };
  tasksState = {
    data: {
      items: [
        {
          id: 't1',
          title: 'לאסוף חתימה מדירה 3',
          statusLabel: 'בתהליך',
          statusColor: 'amber',
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
  projectListMock.mockClear();
  taskListMock.mockClear();
  notificationListMock.mockClear();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('AgentHome (P4 #14)', () => {
  // ---- TEST 1: the three agent-scoped sections + their seeded data ----
  it('1) renders My-projects / My-tasks / My-notifications headings + seeded rows', () => {
    const html = render();

    // Section headings (real he.json strings).
    expect(html).toContain(AGENT.projectsTitle);
    expect(html).toContain(AGENT.tasksTitle);
    expect(html).toContain(AGENT.notificationsTitle);
    // Page header.
    expect(html).toContain(AGENT.pageTitle);
    expect(html).toContain(AGENT.pageSubtitle);

    // Seeded data from each hook.
    expect(html).toContain('מגדל הרצל 14'); // project name
    expect(html).toContain('לאסוף חתימה מדירה 3'); // task title
    expect(html).toContain('בקשת חתימה חדשה'); // notification title

    // Rows link to the per-entity detail / list routes (no PII in URL).
    expect(html).toMatch(/href="\/projects\/p1"/);
    expect(html).toMatch(/href="\/tasks\/t1"/);
    // "Show all" deep-links to each list page.
    expect(html).toMatch(/href="\/projects"/);
    expect(html).toMatch(/href="\/tasks"/);
    expect(html).toMatch(/href="\/notifications"/);
  });

  // ---- TEST 2: NO scope-widening — only the three agent hooks are used,
  //      and the module imports none of the manager-only data paths. ----
  it('2) invokes ONLY the three agent-scoped hooks (no org/stats, members, owners)', () => {
    render();

    // Exactly the three agent-scoped hooks ran — once each.
    expect(projectListMock).toHaveBeenCalledTimes(1);
    expect(taskListMock).toHaveBeenCalledTimes(1);
    expect(notificationListMock).toHaveBeenCalledTimes(1);

    // And each was called with the home page-size cap (limit:5), i.e. a
    // bounded read — never an unscoped "fetch everything".
    expect(projectListMock).toHaveBeenCalledWith({ limit: 5 });
    expect(taskListMock).toHaveBeenCalledWith({ limit: 5 });
    expect(notificationListMock).toHaveBeenCalledWith({ limit: 5 });
  });

  it('2b) source CODE imports NONE of the manager-only data hooks/endpoints', () => {
    // A static guard backing the runtime proof above: the agent home must
    // not even REFERENCE org-stats / members / owners in CODE — surfaces an
    // agent is not authorized for. Catches a future edit that adds a manager
    // import whose hook simply isn't called on the happy path.
    //
    // We strip comments first: the component's JSDoc legitimately EXPLAINS
    // why it avoids org/stats + ManagerHome, so a raw substring grep would
    // false-positive on the prose. The contract is about executable code,
    // and `import` lines specifically — so we assert over the imports.
    const raw = readFileSync(resolve(here, 'agent-home.tsx'), 'utf8');
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments (incl. the JSDoc)
      .replace(/\/\/.*$/gm, ''); // line comments

    // Collect the module specifiers the component actually imports from.
    const importSpecifiers = [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

    // The three agent-scoped hooks ARE imported.
    expect(importSpecifiers).toContain('@/hooks/use-projects');
    expect(importSpecifiers).toContain('@/hooks/use-tasks');
    expect(importSpecifiers).toContain('@/hooks/use-notifications');

    // NO manager-only / org-wide / privileged data module is imported.
    const forbidden = /use-members|use-owners|org-stats|use-org/;
    expect(importSpecifiers.filter((s) => forbidden.test(s ?? ''))).toHaveLength(0);

    // And the CODE (comments removed) calls none of the org-wide fetchers
    // nor renders the manager home.
    expect(code).not.toMatch(/\borg\/stats\b/);
    expect(code).not.toMatch(/useOrgStats|fetchOrgStats|useMemberList|useOwnerList/);
    expect(code).not.toMatch(/\bManagerHome\b/);
  });

  // ---- TEST 3: per-section loading / error / empty are INDEPENDENT ----
  it('3a) a hook in isLoading shows that section loading ONLY; siblings still render', () => {
    projectsState = { isLoading: true, isError: false };
    const html = render();

    // Projects section is loading…
    expect(html).toContain(AGENT.loading);
    // …but the OTHER two sections rendered their seeded rows normally.
    expect(html).toContain('לאסוף חתימה מדירה 3');
    expect(html).toContain('בקשת חתימה חדשה');
    // Projects did NOT fall through to its empty copy.
    expect(html).not.toContain(AGENT.projectsEmpty);
  });

  it('3b) a hook in isError shows that section error ONLY; siblings still render', () => {
    tasksState = { isLoading: false, isError: true };
    const html = render();

    // Tasks section degraded to the load-failed note.
    expect(html).toContain(AGENT.loadFailed);
    // Siblings unaffected.
    expect(html).toContain('מגדל הרצל 14');
    expect(html).toContain('בקשת חתימה חדשה');
    // The failed task list did NOT render the seeded task row.
    expect(html).not.toContain('לאסוף חתימה מדירה 3');
  });

  it('3c) an empty list shows that section empty-state copy', () => {
    projectsState = { data: { items: [] }, isLoading: false, isError: false };
    tasksState = { data: { items: [] }, isLoading: false, isError: false };
    notificationsState = { data: { items: [] }, isLoading: false, isError: false };
    const html = render();

    expect(html).toContain(AGENT.projectsEmpty);
    expect(html).toContain(AGENT.tasksEmpty);
    expect(html).toContain(AGENT.notificationsEmpty);
    // Empty is NOT the same as error — no failure copy on a clean empty.
    expect(html).not.toContain(AGENT.loadFailed);
  });

  // ---- TEST 4: wire-supplied names go through NameDisplay (<bdi> + strip) ----
  it('4) wraps project/task/notification names in <bdi> and strips bidi overrides', () => {
    // U+202E RLO embedded in each wire-supplied name. NameDisplay must
    // strip the codepoint AND isolate the result in <bdi> so it cannot
    // reverse-render neighbouring UI (the §v9-H-3 spoofing defense).
    // U+202E written as an escape (NOT the literal codepoint) so this spec
    // file itself doesn't trip eslint security/detect-bidi-characters — same
    // convention as `lib/bidi.ts`.
    const RLO = '\u202E';
    projectsState = {
      data: { items: [{ id: 'p1', name: `דירה${RLO}3`, statusLabel: 'x', statusColor: 'gray' }] },
      isLoading: false,
      isError: false,
    };
    tasksState = {
      data: {
        items: [
          {
            id: 't1',
            title: `משימה${RLO}x`,
            statusLabel: 'x',
            statusColor: 'gray',
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

    // The dangerous codepoint is gone from the rendered output entirely.
    expect(html).not.toContain(RLO);
    // …and the names render inside <bdi> (the isolation wrapper).
    expect(html).toContain('<bdi>');
    // Cleaned text is present (the strip removed only the override mark).
    expect(html).toContain('דירה3');
    expect(html).toContain('משימהx');
    expect(html).toContain('התראהy');
  });
});
