import { redirect } from 'next/navigation';

import { getCurrentSessionUser } from '@/lib/session';

import { AuthGuard } from './_components/auth-guard';
import { QueryProvider } from './_components/query-provider';
import { Sidebar } from './_components/sidebar';
import { Topbar } from './_components/topbar';

/**
 * V10-S1 closure (H1 architectural fix) — the dashboard layout is the
 * parent of EVERY authenticated route, including `/provider/*`. It
 * previously called `getMe()` directly (org-tier only), so Provider
 * Admins with `provider_access_token` but no `access_token` got
 * redirected to `/login` before the provider subtree could render.
 *
 * Now: `getCurrentSessionUser()` returns a discriminated union
 * `{ tier: 'org' | 'provider', profile: UserProfile | ProviderProfile }`.
 * The middleware has already enforced tier-appropriate cookie presence
 * (V10-S4 — Provider tier paths require provider_access_token; org
 * paths require access_token), so by the time this Server Component
 * runs, the session is whichever tier the URL implied.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentSessionUser();
  if (!session) redirect('/login');

  return (
    <QueryProvider>
      <div className="flex h-screen flex-col">
        <Topbar user={session} />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar role={session.profile.role} />
          <main className="flex-1 overflow-auto p-6">{children}</main>
        </div>
        <AuthGuard />
      </div>
    </QueryProvider>
  );
}
