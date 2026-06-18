/**
 * E2.1 — ManagerMissionControl render guard (docs/DESIGN-NORTH-STAR.md).
 *
 * The pure triage math is covered by `triage.spec.ts`; this spec proves the
 * island WIRES that triage into the four IA sections with real he.json copy and
 * real wire data — and that it stays honest (no fabricated numbers, no human
 * "why" layer). Harness mirrors `agent-home.spec.ts`: vitest `node` env →
 * `renderToStaticMarkup`, with next-intl / next-link / lucide / permission hook
 * stubbed. `useProjectList` is seeded per test.
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectViewModel } from '@/models/project.vm';

// next-intl: a tiny ICU-ish stub. We only need substring assertions, so the
// stub echoes the key with interpolated vars appended — enough to prove the
// right key + the right REAL numbers reach the DOM.
vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string, vars?: Record<string, unknown>) => {
    const full = ns ? `${ns}.${key}` : key;
    const v = vars
      ? ' ' +
        Object.entries(vars)
          .map(([k, val]) => `${k}=${String(val)}`)
          .join(',')
      : '';
    return `[${full}${v}]`;
  },
  useLocale: () => 'he',
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) =>
    createElement('a', { href, ...rest }, children),
}));

// Every lucide icon any of the manager components import → inert markers.
vi.mock('lucide-react', () => {
  const icon = (name: string) => () => createElement('span', { 'data-icon': name });
  const names = [
    // org-pulse / mission-control
    'ChevronLeft',
    'Eye',
    // needs-attention-list
    'AlertCircle',
    'ArrowLeft',
    'CheckCircle2',
    'PlayCircle',
    // project-triage-row
    'CircleCheck',
    'CircleDashed',
    'CircleDot',
    'Hourglass',
    'TrendingUp',
  ] as const;
  return Object.fromEntries(names.map((n) => [n, icon(n)]));
});

// HomeActions is a permission-gated island; stub it inert so this spec doesn't
// pull in the permissions hook graph (its own concern, tested elsewhere).
vi.mock('../home-actions', () => ({
  HomeActions: () => createElement('span', { 'data-actions': '1' }),
}));

let projectsState: {
  data?: { items: ProjectViewModel[]; page?: unknown };
  isLoading: boolean;
  isError: boolean;
};
const projectListMock = vi.fn(() => projectsState);
vi.mock('@/hooks/use-projects', () => ({
  useProjectList: () => projectListMock(),
}));

import { ManagerMissionControl } from './manager-mission-control';

function vm(over: Partial<ProjectViewModel>): ProjectViewModel {
  return {
    id: 'p',
    name: 'פרויקט',
    type: 'tama38_1',
    typeLabel: 'תמ"א 38/1',
    status: 'gathering_signatures',
    statusLabel: 'איסוף חתימות',
    statusColor: 'amber',
    targetConsentPct: 66,
    signatureMilestones: [],
    description: null,
    developerName: null,
    developerCompanyId: null,
    existingUnits: null,
    plannedUnits: null,
    extraAreaSqm: null,
    relocationType: null,
    relocationNotes: null,
    futureTrackLabel: null,
    block: null,
    parcel: null,
    subparcel: null,
    isArchived: false,
    createdRelative: 'היום',
    createdAtIso: '2026-06-18T00:00:00.000Z',
    buildingsCount: 1,
    unitsCount: undefined,
    signaturesPendingCount: undefined,
    signaturesSignedCount: undefined,
    agentsCount: 0,
    ...over,
  };
}

function render(name = 'דנה'): string {
  return renderToStaticMarkup(createElement(ManagerMissionControl, { name }));
}

beforeEach(() => {
  projectsState = {
    data: {
      items: [
        // near-threshold (gate 14, signed 13 → 1 short)
        vm({ id: 'near', name: 'מגדל הרצל', unitsCount: 20, signaturesSignedCount: 13 }),
        // not-started
        vm({ id: 'zero', name: 'רחוב הים', unitsCount: 10, signaturesSignedCount: 0 }),
        // past-threshold (gate 7, signed 9)
        vm({ id: 'won', name: 'שדרות בן גוריון', unitsCount: 10, signaturesSignedCount: 9 }),
      ],
    },
    isLoading: false,
    isError: false,
  };
  projectListMock.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe('ManagerMissionControl (E2.1)', () => {
  it('renders the greeting with the real actor name + the four IA sections', () => {
    const html = render('דנה');
    // Greeting uses the name (NameDisplay <bdi>) + a summary key.
    expect(html).toContain('דנה');
    expect(html).toMatch(/home\.manager\.greeting\.(morning|afternoon|evening)/);
    expect(html).toContain('home.manager.greeting.summaryWithExceptions');
    // Org pulse chips (one key each).
    expect(html).toContain('home.manager.pulse.active');
    expect(html).toContain('home.manager.pulse.pastThreshold');
    // "Needs you now" + "worth a look" section headings.
    expect(html).toContain('home.manager.needs.title');
    expect(html).toContain('home.manager.triage.title');
    expect(html).toContain('home.manager.triage.allProjects');
  });

  it('surfaces ONLY the exception projects in "needs you now", with deep links', () => {
    const html = render();
    // The two exceptions (near + not-started) link to their project pages.
    expect(html).toMatch(/href="\/projects\/near"/);
    expect(html).toMatch(/href="\/projects\/zero"/);
    // near-threshold sentence carries the REAL remaining count (1).
    expect(html).toContain('home.manager.needs.nearSentence remaining=1');
    // The past-threshold project is NOT an exception (no "needs" alarm row),
    // but DOES appear in the urgency-ranked "worth a look" list.
    expect(html).toMatch(/href="\/projects\/won"/);
    expect(html).toContain('home.manager.triage.pastThreshold');
  });

  it('shows the calm empty state when nothing needs attention', () => {
    projectsState = {
      data: {
        items: [
          vm({ id: 'won', name: 'שדרות בן גוריון', unitsCount: 10, signaturesSignedCount: 9 }),
          vm({
            id: 'done',
            name: 'הגליל',
            status: 'completed',
            unitsCount: 5,
            signaturesSignedCount: 5,
          }),
        ],
      },
      isLoading: false,
      isError: false,
    };
    const html = render();
    expect(html).toContain('home.manager.needs.emptyTitle');
    // 0 exceptions → the calm summary, not the "things need you" one.
    expect(html).toContain('home.manager.greeting.summaryCalm');
  });

  it('renders loading and error states with the greeting still present', () => {
    projectsState = { isLoading: true, isError: false };
    expect(render()).toContain('home.manager.loading');

    projectsState = { isLoading: false, isError: true };
    const errHtml = render();
    expect(errHtml).toContain('home.manager.loadFailed');
    // Greeting renders even on error (exceptionCount 0 → calm summary).
    expect(errHtml).toContain('home.manager.greeting.summaryCalm');
  });

  it('does NOT fabricate the human "why" layer (no objection-reason copy)', () => {
    const html = render();
    // The E2 backend follow-up signals must NOT appear — we omit, never fake.
    expect(html).not.toContain('מתנגד'); // "objecting" (objection reason)
    expect(html).not.toMatch(/אין תנועה \d+ יום/); // fabricated "no movement N days"
  });
});
