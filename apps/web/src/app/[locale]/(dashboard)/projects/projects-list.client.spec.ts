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

  it('2) segment <select> renders the "all" option + the 3 NS1 system segments', () => {
    const html = renderToStaticMarkup(createElement(ProjectsListClient));
    expect(html).toContain(resolveKey('filter.segmentAll'));
    for (const s of ['stalled', 'expiring', 'mine']) {
      expect(html).toContain(resolveKey(`filter.segment.${s}`));
    }
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
});
