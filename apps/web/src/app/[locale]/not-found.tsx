import Link from 'next/link';
import { useTranslations } from 'next-intl';

/**
 * Locale-segment 404 page. Rendered when `notFound()` is called under
 * `/[locale]/…` or a route doesn't match. Server component — the NextIntl
 * provider from the locale layout is in scope, so `useTranslations` works.
 *
 * No error internals here by construction (404 carries no exception), but it
 * shares the branded, RTL shell so a missing page looks intentional, not like
 * the default Next.js 404.
 */
export default function NotFound() {
  const t = useTranslations('notFoundPage');

  return (
    <main
      className="flex min-h-screen items-center justify-center p-6"
      style={{ background: 'var(--bg-app)' }}
    >
      <div className="card card-pad w-full max-w-[440px] text-center">
        <div
          className="mb-3 text-5xl font-bold tabular"
          style={{ color: 'var(--navy-700)' }}
          aria-hidden="true"
        >
          404
        </div>
        <h1 className="mb-2 text-xl font-bold" style={{ color: 'var(--text)' }}>
          {t('title')}
        </h1>
        <p className="mb-6 text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {t('description')}
        </p>
        <Link href="/" className="btn btn-primary btn-lg w-full">
          {t('home')}
        </Link>
      </div>
    </main>
  );
}
