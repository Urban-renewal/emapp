'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useEffect } from 'react';

/**
 * Locale-segment error boundary (Next.js 15 App Router). Next passes
 * `{ error, reset }` to every `error.tsx`; this one catches render/runtime
 * errors thrown anywhere under `/[locale]/…` (it does NOT catch errors in the
 * root layout — see `app/global-error.tsx` for that).
 *
 * SECURITY (owner requirement): we NEVER render `error.message` / `error.stack`
 * / any exception internals into the DOM. A leaked stack/message is an outward
 * information-disclosure surface (file paths, SQL, internal call shape). The
 * ONLY error-derived value shown to the user is `error.digest` — the opaque,
 * non-reversible id Next.js generates for support correlation. The full error
 * goes to the console (and Sentry, which the global error handler ships) — the
 * server/observability side, never the page.
 */
export default function LocaleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('errorBoundary');

  useEffect(() => {
    // Console only — this string never reaches the rendered DOM. Sentry's
    // global handler (instrumentation.ts beforeSend) captures + scrubs it.
    // eslint-disable-next-line no-console
    console.error(error);
  }, [error]);

  return (
    <main
      className="flex min-h-screen items-center justify-center p-6"
      style={{ background: 'var(--bg-app)' }}
    >
      <div className="card card-pad w-full max-w-[440px] text-center">
        <div
          className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full"
          style={{ background: 'var(--danger-50)', color: 'var(--danger-600)' }}
          aria-hidden="true"
        >
          <svg
            width="26"
            height="26"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
        </div>

        <h1 className="mb-2 text-xl font-bold" style={{ color: 'var(--text)' }}>
          {t('title')}
        </h1>
        <p className="mb-6 text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          {t('description')}
        </p>

        <div className="flex flex-col gap-2">
          <button type="button" onClick={() => reset()} className="btn btn-primary btn-lg w-full">
            {t('retry')}
          </button>
          <Link href="/" className="btn btn-secondary btn-lg w-full">
            {t('home')}
          </Link>
        </div>

        {error.digest && (
          <p className="mt-5 text-xs" style={{ color: 'var(--text-soft)' }}>
            {t('referenceId')}:{' '}
            <span className="tabular" dir="ltr">
              {error.digest}
            </span>
          </p>
        )}
      </div>
    </main>
  );
}
