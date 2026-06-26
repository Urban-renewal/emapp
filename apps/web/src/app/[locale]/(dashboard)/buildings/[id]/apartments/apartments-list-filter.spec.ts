/**
 * Apartments LIST — status-filter UI render probe (independent TEST-AUTHOR).
 *
 * The repo's vitest env is `node` (no DOM / testing-library), so the REAL
 * `<ApartmentsPage>` is rendered via `react-dom/server` (`renderToStaticMarkup`
 * → HTML string) — the SAME technique as `projects-list.client.spec.ts`. The
 * apartments list hook, the permission hook, next-intl, next/link, next params
 * and the display-locale hook are stubbed so the static render is a pure
 * status-filter-UI probe.
 *
 * What is proven here (and what is NOT, stated honestly):
 *   1. The status chip group renders ALL 6 apartment_status chips + an "all"
 *      chip with the REAL he.json `apartments.statusFilter.*` labels — a
 *      renamed/dropped key surfaces as a loud MISSING token.
 *   2. The chip group is exposed to assistive tech (role="group" + the
 *      `statusFilterLabel` aria-label) — the technophobe-legible control.
 *   3. Items render (number + status badge) when the hook returns rows.
 *   4. Zero items at the DEFAULT (unfiltered) render → the onboarding `empty`
 *      copy, NOT the `emptyFiltered` copy. The interactive filtered-empty
 *      transition is component-state driven (a chip click), which a static SSR
 *      string cannot set — it is covered by the BE DB-backed filter spec + the
 *      orchestrator real-browser walk, NOT here (stated, not hidden).
 *
 * The SERVER-SIDE behaviour of the `status` filter (the actual predicate, keyset
 * intact, server-not-client filtering) is proven by
 * `apps/api/src/modules/apartments/apartments-list-filter.spec.ts` against the
 * real DB; this file is purely the FE-render contract.
 */
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import heMessages from '@/messages/he.json';

// ─── next-intl: resolve REAL he.json `apartments.*` keys (dotted) ────────────
const apartmentsMessages = (heMessages as Record<string, unknown>)['apartments'] as Record<
  string,
  unknown
>;
function resolveKey(key: string): string {
  const parts = key.split('.');
  let node: unknown = apartmentsMessages;
  for (const p of parts) {
    if (node && typeof node === 'object' && p in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[p];
    } else {
      return `MISSING:${key}`;
    }
  }
  return typeof node === 'string' ? node : `MISSING:${key}`;
}
// Namespaces used by the page: `apartments` (t), `apartments.generate` (the
// lead generate form, Slice 2.1) and `projects` (tp). For an `apartments.*`
// namespace we strip the leading `apartments.` and resolve the rest against the
// apartments message tree; `projects.*` keys resolve to a stable stub so they
// never read as MISSING and never collide with the assertions.
vi.mock('next-intl', () => ({
  useTranslations: (ns?: string) => (key: string) => {
    if (ns === 'projects') return `proj.${key}`;
    const sub =
      ns && ns.startsWith('apartments.') ? `${ns.slice('apartments.'.length)}.${key}` : key;
    return resolveKey(sub);
  },
}));

// next/link → plain anchor so the static render emits labels/options.
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) =>
    createElement('a', { href: String(href) }, children),
}));

// Route param (the building id) + display locale.
vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1' }),
}));
vi.mock('@/lib/locale', () => ({
  useDisplayLocale: () => 'he',
}));

// Permission hook — manager (can create); irrelevant to the filter probe.
vi.mock('@/hooks/use-permissions', () => ({
  useHasPermission: () => true,
}));

// The apartments list hook — controllable per test. Default: empty, not loading.
const listState = {
  data: {
    items: [] as unknown[],
    page: { limit: 25, cursor: null as string | null, has_more: false },
  },
  isLoading: false,
  isError: false,
  refetch: () => {},
};
vi.mock('@/hooks/use-apartments', () => ({
  useApartmentList: () => listState,
  // Slice 2.1 — the page now leads with <GenerateApartmentsForm>, which calls
  // this hook. Stub it inert (idle mutation) so this filter-UI probe renders.
  useGenerateApartments: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// Slice 2.7 — the page now renders <ApartmentStatesSummary>, which reads
// `useOrgStats` (TanStack). Stub it inert (no apartmentStates) so the summary
// renders nothing and this filter-UI probe stays a pure status-filter render.
vi.mock('@/hooks/use-org-stats', () => ({
  useOrgStats: () => ({ data: undefined }),
}));

import ApartmentsPage from './page';

afterEach(() => {
  // Restore the default empty state between tests.
  listState.data = { items: [], page: { limit: 25, cursor: null, has_more: false } };
  listState.isLoading = false;
  listState.isError = false;
  vi.clearAllMocks();
});

const ALL_STATUSES = ['pending', 'contacted', 'meeting', 'signed', 'refused', 'unreachable'];

describe('apartments list — status filter UI', () => {
  it('1) renders the "all" chip + all 6 apartment_status chips with real he.json labels', () => {
    const html = renderToStaticMarkup(createElement(ApartmentsPage));
    expect(html).not.toContain('MISSING:');
    expect(html).toContain(resolveKey('statusFilter.all'));
    for (const s of ALL_STATUSES) {
      expect(html).toContain(resolveKey(`statusFilter.${s}`));
    }
  });

  it('2) the chip group is exposed to assistive tech (role=group + aria-label)', () => {
    const html = renderToStaticMarkup(createElement(ApartmentsPage));
    expect(html).toContain('role="group"');
    expect(html).toContain(resolveKey('statusFilterLabel'));
    // The default-selected "all" chip is pressed.
    expect(html).toContain('aria-pressed="true"');
  });

  it('3) renders apartment rows (number + status label) when the hook returns items', () => {
    listState.data = {
      items: [
        {
          id: 'a1',
          buildingId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
          number: '7',
          floor: 2,
          sizeSqm: 85,
          rooms: 3.5,
          status: 'pending',
          statusLabel: 'בהמתנה',
          intent: 'neutral',
          factsLine: 'קומה 2 · 3.5 חדרים',
          notes: null,
          isArchived: false,
          createdRelative: 'לפני יום',
          statusChangedRelative: 'לפני יום',
        },
      ] as unknown[],
      page: { limit: 25, cursor: null, has_more: false },
    };
    const html = renderToStaticMarkup(createElement(ApartmentsPage));
    expect(html).toContain('בהמתנה');
    // The apartment label includes the verbatim number.
    expect(html).toContain('7');
    // Chips still render above the list (persistent shell).
    expect(html).toContain(resolveKey('statusFilter.all'));
  });

  it('4) zero items at the DEFAULT (unfiltered) render → onboarding `empty`, NOT `emptyFiltered`', () => {
    const html = renderToStaticMarkup(createElement(ApartmentsPage));
    // `empty` copy contains escaped quotes under renderToStaticMarkup; assert on
    // its quote-free prefix (a renamed key still surfaces via tests 1-2).
    expect(html).toContain('אין עדיין דירות בבניין');
    // The filtered-empty copy must NOT show at the default 'all' filter.
    expect(html).not.toContain('אין דירות בסטטוס');
  });
});
