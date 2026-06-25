/**
 * C-1 (findable at scale) — contractors-list SERVER-SEARCH + specialty-facet UI.
 *
 * Independent TEST-AUTHOR suite, mirroring `projects-list.client.spec.ts`. The
 * repo's vitest env is `node` (no DOM), so the REAL `<ContractorsListClient>` is
 * rendered via `react-dom/server` (`renderToStaticMarkup` → HTML string). The
 * TanStack list hook, the permission hook, next-intl and next/link are stubbed
 * so the static render is a pure UI probe.
 *
 * What is actually proven (honestly stated):
 *   1. The search box is a CONTROLLED <input type="search"> with NO enclosing
 *      <form> → no native submit → no GET-fallback credential-leak class.
 *   2. The specialty filter chips are DATA-DERIVED: given `facets.specialties`,
 *      every specialty renders as a chip plus an "all" chip (real he.json
 *      labels). A renamed/dropped translation key surfaces as a MISSING token.
 *   3. When `facets.specialties` is EMPTY, the chip group does NOT render (no
 *      hardcoded chips — the facet is the only source).
 *   4. Zero items + no active filter → the onboarding `empty` copy. (The
 *      filtered-empty `noResults` branch is `hasActiveFilter`-driven component
 *      state, not settable from a static SSR string — covered by the live walk;
 *      here we pin the DEFAULT render and assert `noResults` is NOT shown.)
 *   5. Items render with the contractor name (wrapped for bidi safety).
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import heMessages from '@/messages/he.json';

// ─── next-intl: resolve REAL he.json keys (dotted) for BOTH namespaces ───────
const messages = heMessages as Record<string, Record<string, unknown>>;
function makeResolver(ns: string) {
  return (key: string): string => {
    const parts = key.split('.');
    let node: unknown = messages[ns];
    for (const p of parts) {
      if (node && typeof node === 'object' && p in (node as Record<string, unknown>)) {
        node = (node as Record<string, unknown>)[p];
      } else {
        return `MISSING:${ns}.${key}`;
      }
    }
    return typeof node === 'string' ? node : `MISSING:${ns}.${key}`;
  };
}
vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => makeResolver(ns),
}));
const tc = makeResolver('contractors');

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) =>
    createElement('a', { href: String(href) }, children),
}));

// shadcn Button uses `asChild` (Radix Slot) — stub to a plain wrapper so the
// static render emits the child anchor/label without pulling Radix.
vi.mock('@/components/ui/button', () => ({
  Button: ({ children }: { children: ReactNode }) => createElement('div', null, children),
}));

vi.mock('@/hooks/use-permissions', () => ({
  useHasPermission: () => true,
}));

// The TanStack list hook — controllable per test. Default: empty + facet present.
const listState = {
  data: {
    items: [] as unknown[],
    facets: { specialties: [] as string[] },
    page: { limit: 25, cursor: null, has_more: false },
  },
  isLoading: false,
  isError: false,
  error: null as unknown,
  refetch: () => {},
};
vi.mock('@/hooks/use-contractors', () => ({
  useContractorList: () => listState,
}));

import { ContractorsListClient } from './contractors-list.client';

afterEach(() => {
  // Reset to the default state between tests.
  listState.data = {
    items: [],
    facets: { specialties: [] },
    page: { limit: 25, cursor: null, has_more: false },
  };
  vi.clearAllMocks();
});

describe('C-1 — contractors-list search + specialty facet render', () => {
  it('1) the search box is a controlled <input type="search"> with NO <form> (no GET-fallback)', () => {
    const html = renderToStaticMarkup(createElement(ContractorsListClient));
    expect(html).toContain('type="search"');
    expect(html).not.toContain('<form');
    // The placeholder resolves (no MISSING token = the key exists in he.json).
    expect(html).not.toContain('MISSING:');
  });

  it('2) DATA-DERIVED specialty chips: every facet value renders + the "all" chip', () => {
    listState.data = {
      items: [],
      facets: { specialties: ['חשמל', 'אדריכלות', 'ליווי משפטי'] },
      page: { limit: 25, cursor: null, has_more: false },
    };
    const html = renderToStaticMarkup(createElement(ContractorsListClient));
    expect(html).not.toContain('MISSING:');
    // The "all specialties" chip + every data-derived specialty.
    expect(html).toContain(tc('filter.specialtyAll'));
    expect(html).toContain('חשמל');
    expect(html).toContain('אדריכלות');
    expect(html).toContain('ליווי משפטי');
    // The group is exposed to assistive tech with the real label.
    expect(html).toContain(tc('filter.specialtyLabel'));
  });

  it('3) NO facets → the chip group does NOT render (no hardcoded chips)', () => {
    listState.data = {
      items: [],
      facets: { specialties: [] },
      page: { limit: 25, cursor: null, has_more: false },
    };
    const html = renderToStaticMarkup(createElement(ContractorsListClient));
    // The "all specialties" chip only exists inside the (conditionally rendered)
    // group — with no facets it must be absent.
    expect(html).not.toContain(tc('filter.specialtyAll'));
    expect(html).not.toContain(tc('filter.specialtyLabel'));
  });

  it('4) zero items + no active filter → onboarding `empty` copy (not `noResults`)', () => {
    const html = renderToStaticMarkup(createElement(ContractorsListClient));
    // `renderToStaticMarkup` HTML-escapes `"` → `&quot;`, so assert the
    // quote-free prefix of the `empty` copy; `noResults` has no escapable chars.
    expect(html).toContain('אין עדיין קבלנים');
    expect(html).not.toContain(tc('noResults'));
  });

  it('5) items render the contractor name', () => {
    listState.data = {
      items: [
        {
          id: 'c1',
          name: 'אורבן בנייה בע״מ',
          contactEmail: 'info@urban.dev',
          contactPhone: '03-5551001',
          companyId: null,
          specialty: 'קבלן מבצע',
          notes: null,
          isArchived: false,
          createdAtIso: '2026-05-01T10:00:00Z',
          createdRelative: 'לפני חודש',
        },
      ] as unknown[],
      facets: { specialties: ['קבלן מבצע'] },
      page: { limit: 25, cursor: null, has_more: false },
    };
    const html = renderToStaticMarkup(createElement(ContractorsListClient));
    expect(html).toContain('אורבן בנייה בע״מ');
    expect(html).toContain('info@urban.dev');
    expect(html).not.toContain('MISSING:');
  });
});
