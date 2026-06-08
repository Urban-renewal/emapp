import { getMe } from '@/lib/auth';

import { AgentHome } from './_components/agent-home';
import { ManagerHome } from './_components/manager-home';

/**
 * Role-aware dashboard home (#14 agent-home).
 *
 * An Agent (Tier-1 org user, assigned-projects-scoped, capability-gated)
 * lands here. The manager-oriented `ManagerHome` (org-wide KPI cards from
 * `GET /org/stats`, which an agent can't read) isn't useful — and would
 * show "—" everywhere. So we branch on the actor's role:
 *
 *   - `role === 'agent'` → `AgentHome`: a client island scoped to the
 *     agent's OWN work (my assigned projects / tasks assigned to me / my
 *     notifications), reusing the same agent-scoped list endpoints the
 *     list pages use. No new endpoint; no widened scope — the BE already
 *     scopes every list to the agent (RLS + service-layer JOINs).
 *   - manager / viewer (or anything else) → the existing `ManagerHome`,
 *     unchanged (its markup was extracted verbatim into the component to
 *     keep the V11 design / tests intact).
 *
 * Server Component — resolves the actor server-side via `getMe()` (the
 * same `/me` payload the layout already reads), so the correct home is
 * chosen on the first paint with no client-side flash. `getMe()` returns
 * null only when the session is unresolvable; the layout's AuthGuard has
 * already gated unauthenticated access, so we default to `ManagerHome`
 * (the BE stays authoritative for every datum either home renders).
 */
export default async function HomePage() {
  const me = await getMe();

  if (me?.role === 'agent') {
    return <AgentHome />;
  }

  return <ManagerHome />;
}
