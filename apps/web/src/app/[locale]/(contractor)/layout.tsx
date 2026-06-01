import { QueryProvider } from '../(dashboard)/_components/query-provider';

/**
 * D2-DEF-1 — Contractor read-tier layout.
 *
 * A minimal, no-nav shell for the public contractor read-view. There is NO
 * org/tenant session here: the share-access token in the URL is the sole
 * credential (verified at the BE by ContractorAuthGuard). The middleware
 * marks `/<locale>/contractor/share/<jwt>` PUBLIC, so this layout never
 * gates on a cookie. `QueryProvider` is mounted for the page's TanStack
 * reads (scoped to this tab; nothing org-tier is cached here).
 */
export default function ContractorLayout({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider>
      <div className="flex min-h-screen flex-col" style={{ background: 'var(--bg-app)' }}>
        <header
          className="flex items-center"
          style={{
            background: 'var(--bg-surface)',
            borderBottom: '1px solid var(--border)',
            padding: '14px 20px',
          }}
        >
          <div
            className="flex h-8 w-8 items-center justify-center rounded-lg font-bold tracking-wider text-white"
            style={{ background: 'var(--navy-900)', fontSize: 14 }}
            aria-hidden="true"
          >
            EM
          </div>
          <span className="ms-2.5 text-[14px] font-semibold" style={{ color: 'var(--text)' }}>
            EMAPP
          </span>
        </header>
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </QueryProvider>
  );
}
