import { redirect } from 'next/navigation';

import { AccessReasonGate } from '@/components/provider/access-reason-gate';
import { getMe } from '@/lib/auth';

/**
 * Provider Admin route layout — server component.
 *
 * Two gates:
 *  1. Role gate — fetches `getMe()` server-side and 302s away if the
 *     caller isn't `role === 'provider_admin'`. This is FE-side defense
 *     in depth on top of the BE's ProviderAuthGuard (which also rejects
 *     org-tier JWTs at the API level). The redirect target is `/he`
 *     (home) to avoid a confusing error page.
 *  2. Access-reason gate — a Client-Component blocker that prompts for
 *     a reason BEFORE any provider page renders. Lives below the
 *     server-side role check so an org-tier user never sees the form.
 *
 * Threat-model linkage (D.37):
 *  - Security: role check is server-side (no client-side trust); reason
 *    is per-session sessionStorage (not localStorage — fresh
 *    investigations get fresh intent).
 *  - Performance: getMe runs once per RSC navigation (Server Component);
 *    the AccessReasonGate is lazy/client-only (no SSR cost beyond
 *    a 200-pixel skeleton).
 *  - Error handling: getMe throwing (network / 401) → redirect; never
 *    leaks an error overlay on the provider subtree.
 */
export default async function ProviderLayout({ children }: { children: React.ReactNode }) {
  // Role gate (defense-in-depth — the BE already enforces tier
  // separation via ProviderAuthGuard; this just avoids loading any
  // provider UI for non-provider users in the first place).
  let user: Awaited<ReturnType<typeof getMe>> | null = null;
  try {
    user = await getMe();
  } catch {
    // Treat any /me failure as unauthenticated → middleware will route
    // the next navigation to /login. Redirect to /he so the dashboard
    // layout handles re-auth uniformly.
    redirect('/');
  }
  if (!user || user.role !== 'provider_admin') {
    redirect('/');
  }

  return <AccessReasonGate>{children}</AccessReasonGate>;
}
