import { getTranslations } from 'next-intl/server';

/**
 * V11 A.S14a — Tenant portal placeholder.
 *
 * Sub-slice scope: A.S14a ships the **login + tier-routing infrastructure**
 * (middleware tenant gate, /tenant/login 2-step OTP flow, tenant logout
 * server action). This page proves end-to-end that:
 *   1. Unauthenticated → middleware redirects to /tenant/login
 *   2. OTP verify → BE sets `tenant_access_token` → middleware lets us in
 *   3. Logout → cookie cleared → middleware bounces back to /tenant/login
 *
 * The 4 wired portal screens (hero / apartment / docs / signatures) are
 * A.S14b. They will live as nested routes under this same `(tenant)`
 * layout (e.g. `/portal/apartment`, `/portal/documents`) or as tabbed
 * sections of this page — TBD at S14b kickoff.
 *
 * Server Component (no client state needed). Reads i18n via
 * getTranslations so the placeholder copy is locale-aware from the
 * first paint.
 */
export default async function TenantPortalPage() {
  const t = await getTranslations('portal');

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-4">
      <h1 className="text-xl font-bold" style={{ color: 'var(--text)' }}>
        {t('welcomeTitle')}
      </h1>
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        {t('welcomeBody')}
      </p>
      <div className="card card-pad flex flex-col gap-2">
        <h2
          className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: 'var(--text-muted)' }}
        >
          {t('comingSoonSection')}
        </h2>
        <ul className="flex flex-col gap-1.5 text-sm" style={{ color: 'var(--text)' }}>
          <li>· {t('comingApartment')}</li>
          <li>· {t('comingDocuments')}</li>
          <li>· {t('comingSignatures')}</li>
        </ul>
        <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {t('comingHint')}
        </p>
      </div>
    </div>
  );
}
