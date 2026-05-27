import { redirect } from 'next/navigation';

import { getCurrentSessionUser } from '@/lib/session';

import { AuthGuard } from './_components/auth-guard';
import { PCSidebar } from './_components/pc-sidebar';
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
 *
 * V11 A.S2 — restructured to match partner AppShell:
 *   Outer: flex row (RTL flow places Sidebar visually on the right).
 *   Sidebar: full-height navy panel (240px).
 *   Main column: TopBar (64px) at top + scrollable content below.
 *
 * Prior layout was Topbar-full-width-on-top + Sidebar/main row below;
 * the partner design puts Sidebar full-height alongside a TopBar-only-
 * over-main layout. Both Sidebar and TopBar still receive the same
 * session data; the restructure is purely visual.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentSessionUser();
  if (!session) redirect('/login');

  // V11 A.S13 — branch the sidebar shell on tier. Provider Admins get
  // the Platform Console PCSidebar (13 nav items, partner navy variant);
  // org users keep the existing Sidebar.
  const isProvider = session.tier === 'provider';

  return (
    <QueryProvider>
      <div className="flex h-screen" style={{ background: 'var(--bg-app)' }}>
        {isProvider ? (
          <PCSidebar userName={session.profile.name} userRole={session.profile.role} />
        ) : (
          <Sidebar
            role={session.profile.role}
            userName={session.profile.name}
            userRole={session.profile.role}
            tier={session.tier}
          />
        )}
        <main className="flex min-w-0 flex-1 flex-col">
          <Topbar user={session} />
          <div className="flex-1 overflow-auto p-6">{children}</div>
        </main>
        <AuthGuard />
      </div>
    </QueryProvider>
  );
}
