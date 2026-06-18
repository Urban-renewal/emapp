import { HydrationBoundary } from '@tanstack/react-query';
import { getLocale } from 'next-intl/server';

import { projectsListQueryKey } from '@/hooks/use-projects.keys';
import { serverListProjects } from '@/lib/api/projects.server';
import { getMe } from '@/lib/auth';
import { prefetchToDehydratedState } from '@/lib/query/prefetch';

import { ManagerMissionControl } from './manager/manager-mission-control';

/**
 * ManagerHome — E2.1 signature mission-control (docs/DESIGN-NORTH-STAR.md).
 *
 * Replaces the former cold 4-KPI grid + "coming soon" calendar/conversation
 * stubs with a calm, scale-aware triage home: a warm greeting, a compact org
 * pulse, the FEW exception items that need the manager now, and an
 * urgency-ranked "needs a look" project list. The full searchable/filterable
 * power lives one tap away at /projects.
 *
 * Server Component (RSC-prefetch pattern, mirrors projects/page.tsx):
 *   - Resolves the actor server-side via `getMe()` (same /me the layout reads)
 *     so the greeting renders the real name on first paint — no client /me hop.
 *   - Server-prefetches `GET /projects?limit=100` into a throwaway QueryClient
 *     and dehydrates it through `<HydrationBoundary>`, so the island's
 *     `useProjectList({ limit: 100 })` resolves SYNCHRONOUSLY on first render
 *     (no fetch-after-hydration waterfall). Query-key parity with the hook is
 *     load-bearing: same `projectsListQueryKey({ limit: 100 }, locale)` builder.
 *
 * ALL triage (pulse, exceptions, "needs a look") is derived CLIENT-SIDE from
 * that one list inside the island — no new endpoint, no widened scope. The home
 * is honest about gaps: the human "why" layer (owner objection reasons) and the
 * "no movement for X days" duration are OMITTED because the wire doesn't carry
 * them (E2 backend follow-up; see DESIGN-NORTH-STAR.md). The role-branch in
 * page.tsx is unchanged — an Agent still gets AgentHome.
 *
 * Failure posture: a failed prefetch leaves an empty dehydrated cache → the
 * island transparently runs its own fetch + loading/error UI. `getMe()` null
 * (unresolvable session — already gated by the layout AuthGuard) degrades the
 * greeting to a neutral fallback name; the page never throws.
 */
const HOME_PROJECT_LIMIT = 100;

export async function ManagerHome() {
  const rawLocale = await getLocale();
  const locale: 'he' | 'en' = rawLocale === 'en' ? 'en' : 'he';

  const [me, dehydratedState] = await Promise.all([
    getMe(),
    prefetchToDehydratedState([
      (qc) =>
        qc.prefetchQuery({
          queryKey: projectsListQueryKey({ limit: HOME_PROJECT_LIMIT }, locale),
          queryFn: () => serverListProjects({ limit: HOME_PROJECT_LIMIT }),
        }),
    ]),
  ]);

  // The greeting name: the actor's display name when resolvable, else a neutral
  // fallback (the layout AuthGuard has already gated unauthenticated access).
  const name = me?.name ?? '';

  return (
    <HydrationBoundary state={dehydratedState}>
      <ManagerMissionControl name={name} />
    </HydrationBoundary>
  );
}
