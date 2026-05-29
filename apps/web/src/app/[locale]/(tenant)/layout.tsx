import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { LogoutButton } from '../(dashboard)/_components/logout-button';
import { QueryProvider } from '../(dashboard)/_components/query-provider';

import { TenantAuthGuard } from './_components/tenant-auth-guard';

/**
 * V11 A.S14a — Tenant tier layout.
 *
 * The tenant portal is deliberately OUTSIDE the (dashboard) route group
 * so it doesn't inherit the org Sidebar / Topbar. A resident sees a
 * simpler chrome: just a slim header with the brand + a logout button.
 *
 * Auth gate posture:
 *  - The middleware already enforces `tenant_access_token` for any
 *    /<locale>/portal/* path (see `middleware.ts` TENANT_TIER_REGEX).
 *    By the time this Server Component runs, the cookie is present.
 *  - We re-check the cookie here as a belt-and-suspenders defense (same
 *    pattern as (dashboard)/provider/layout.tsx) — if a future
 *    middleware bypass ever lands, the layout still refuses to render
 *    a portal page without the tenant cookie.
 *
 * Why NO `/api/v1/portal/me` fetch here:
 *  - The me-fetch belongs in the page Server Component (or a hook) that
 *    actually needs the data. Pushing it into the layout would couple
 *    every portal page to a non-cached BE round-trip on first paint.
 *  - The cookie check below is enough to gate the layout itself.
 *
 * Why we still need QueryProvider:
 *  - The portal pages (A.S14b — hero / apartment / docs / sigs) will
 *    use TanStack Query for the 4 GET endpoints. Mounting the provider
 *    here keeps the cache scoped to the tenant tier; logout +
 *    re-login starts with a fresh cache.
 */
export default async function TenantLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const hasTenantToken = cookieStore.has('tenant_access_token');
  if (!hasTenantToken) redirect('/tenant/login');

  return (
    <QueryProvider>
      <div className="flex min-h-screen flex-col" style={{ background: 'var(--bg-app)' }}>
        {/* Slim header — brand + logout, no nav (tenant has a single
            scrollable view at /portal that owns its own sub-navigation
            in A.S14b). */}
        <header
          className="flex items-center justify-between"
          style={{
            background: 'var(--bg-surface)',
            borderBottom: '1px solid var(--border)',
            padding: '14px 20px',
          }}
        >
          <div className="flex items-center gap-2.5">
            <div
              className="flex h-8 w-8 items-center justify-center rounded-lg font-bold tracking-wider text-white"
              style={{ background: 'var(--navy-900)', fontSize: 14 }}
              aria-hidden="true"
            >
              EM
            </div>
            <div>
              <div className="text-[14px] font-semibold" style={{ color: 'var(--text)' }}>
                EMAPP
              </div>
              <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {/* Inline literal — this is the only place the tenant
                    chrome surfaces it and a single line doesn't justify
                    a new i18n namespace round-trip. */}
                פורטל דייר
              </div>
            </div>
          </div>
          <LogoutButton tier="tenant" />
        </header>

        <main className="flex-1 overflow-auto p-6">{children}</main>
        <TenantAuthGuard />
      </div>
    </QueryProvider>
  );
}
