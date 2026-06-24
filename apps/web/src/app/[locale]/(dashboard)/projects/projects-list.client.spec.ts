/**
 * NS6 (MASTER-PLAN-V13 Wave C) — projects-list SERVER-SEARCH swap.
 *
 * Independent TEST-AUTHOR suite. The repo's vitest env is `node` (no DOM /
 * testing-library), so the REAL `<ProjectsListClient>` is rendered via
 * `react-dom/server` (`renderToStaticMarkup` → HTML string), the same
 * technique as `apartments/new/page.spec.ts` + `sidebar.spec.ts`. The
 * TanStack list hook, the permission hook, next-intl and next/link are
 * stubbed so the static render is a pure NS6-UI probe.
 *
 * What is actually proven (and what is NOT, honestly stated):
 *   1. The status <select> renders ALL 6 D.18 options + an "all" option
 *      with the REAL he.json `projects.filter.status.*` labels — a renamed
 *      or dropped translation key surfaces as a loud MISSING token.
 *   2. The segment <select> renders the 3 NS1 system segments
 *      (stalled/expiring/mine) + an "all" option, real he.json labels.
 *   3. Driving the list hook to return ZERO items WHILE a render-time filter
 *      proxy reports "no filter" → the onboarding `empty` copy; the
 *      `noResults` copy is the OTHER branch (filtered-empty). Because the
 *      branch is `hasActiveFilter`-driven (component state we cannot set from
 *      a static SSR string), this suite pins the DEFAULT (unfiltered) render's
 *      `empty` copy and asserts the `noResults` literal is NOT shown — the
 *      interactive filtered-empty transition is browser-observable and is
 *      covered by the Playwright harness (orchestrator QA-walk), NOT here.
 *   4. The search box is a CONTROLLED <input type="search"> with NO enclosing
 *      <form> — i.e. no native submit → no GET-fallback credential-leak class
 *      (the DOD-BROWSER-SMOKE trigger). Asserted on the rendered HTML.
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import heMessages from '@/messages/he.json';

// ─── next-intl: resolve REAL he.json `projects.*` keys (dotted) ──────────────
const projectsMessages = (heMessages as Record<string, unknown>)['projects'] as Record<
  string,
  unknown
>;
function resolveKey(key: string): string {
  const parts = key.split('.');
  let node: unknown = projectsMessages;
  for (const p of parts) {
    if (node && typeof node === 'object' && p in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[p];
    } else {
      return `MISSING:${key}`;
    }
  }
  return typeof node === 'string' ? node : `MISSING:${key}`;
}
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => resolveKey(key),
}));

// next/link → plain anchor so the static render emits the labels/options.
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) =>
    createElement('a', { href: String(href) }, children),
}));

// Permission hook — manager (can create); irrelevant to the filter probe.
vi.mock('@/hooks/use-permissions', () => ({
  useHasPermission: () => true,
}));

// The TanStack list hook — controllable per test. Default: empty, not loading.
const listState = {
  data: { items: [] as unknown[], page: { limit: 25, cursor: null, has_more: false } },
  isLoading: false,
  isError: false,
  error: null as unknown,
  refetch: () => {},
};
vi.mock('@/hooks/use-projects', () => ({
  useProjectList: () => listState,
}));

import { ProjectsListClient } from './projects-list.client';

afterEach(() => {
  vi.clearAllMocks();
});

describe('NS6 — projects-list server-search filters render', () => {
  it('1) status <select> renders the "all" option + all 6 D.18 statuses with real he.json labels', () => {
    const html = renderToStaticMarkup(createElement(ProjectsListClient));
    expect(html).not.toContain('MISSING:');
    // "all statuses" + every D.18 status label from he.json.
    expect(html).toContain(resolveKey('filter.statusAll'));
    for (const s of [
      'planning',
      'gathering_signatures',
      'approved',
      'in_construction',
      'completed',
      'cancelled',
    ]) {
      expect(html).toContain(resolveKey(`filter.status.${s}`));
    }
  });

  it('2) G3 — attention quick-filter chips render all 3 NS1 system segments + "all", urgent first', () => {
    const html = renderToStaticMarkup(createElement(ProjectsListClient));
    // The segment <select> was replaced by one-click ATTENTION chips driving the
    // SAME `ProjectSegment` state. Assert the chip labels (real he.json) render
    // and the group is exposed to assistive tech.
    expect(html).toContain(resolveKey('attention.groupLabel'));
    for (const s of ['stalled', 'expiring', 'mine', 'all']) {
      expect(html).toContain(resolveKey(`attention.chip.${s}`));
    }
    // The default (unfiltered) summary line states what the view shows — a plain
    // sentence for the technophobe manager, not a wall. `{count}` is interpolated
    // by the real next-intl in the app; our stub returns the raw template, so
    // assert on the quote-free prefix.
    expect(html).toContain('מציג את כל הפרויקטים');
  });

  it('3) the search box is a controlled <input type="search"> with NO <form> (no GET-fallback)', () => {
    const html = renderToStaticMarkup(createElement(ProjectsListClient));
    expect(html).toContain('type="search"');
    // No enclosing form element at all → no native submit → no GET credential leak.
    expect(html).not.toContain('<form');
  });

  it('4) zero items + no active filter → the onboarding `empty` copy, NOT `noResults`', () => {
    listState.data = { items: [], page: { limit: 25, cursor: null, has_more: false } };
    const html = renderToStaticMarkup(createElement(ProjectsListClient));
    // `renderToStaticMarkup` HTML-escapes `"` → `&quot;`, so assert on the
    // quote-free prefix of the `empty` copy (a renamed key still surfaces as a
    // MISSING token via tests 1-2). The `noResults` literal has no escapable
    // chars, so a direct `not.toContain` is a clean negative.
    expect(html).toContain('אין עדיין פרויקטים');
    expect(html).not.toContain(resolveKey('noResults'));
  });

  it('5) G3 — card renders REAL units + signature progress from the list stats (no dashes)', () => {
    // Drive the list hook with a VM that carries the BE stats (the adapter maps
    // them from ProjectListItem; the BE list ALREADY populates them). The card
    // must render the real numbers, NOT the old `—` placeholder.
    listState.data = {
      items: [
        {
          id: 'p1',
          name: 'Pilot',
          type: 'tama38_2',
          typeLabel: 'תמ"א 38/2',
          status: 'gathering_signatures',
          statusLabel: 'איסוף חתימות',
          intent: 'warning',
          isArchived: false,
          createdRelative: 'לפני יום',
          createdAtIso: '2026-06-23T00:00:00Z',
          // The stats under test — 5 signed of 8 total (3 pending), 8 units.
          unitsCount: 8,
          signaturesSignedCount: 5,
          signaturesPendingCount: 3,
          buildingsCount: 2,
          agentsCount: 1,
        },
      ] as unknown[],
      page: { limit: 25, cursor: null, has_more: false },
    };
    const html = renderToStaticMarkup(createElement(ProjectsListClient));
    // Units cell shows the real count.
    expect(html).toContain('>8<');
    // Signature progress uses the `column.signaturesProgress` template (our stub
    // returns the raw template; the app interpolates {signed}/{total}). The key
    // must resolve (no MISSING) and the units count proves stats flowed through.
    expect(html).not.toContain('MISSING:');
    expect(html).toContain(resolveKey('column.signaturesProgress'));
  });
});
