'use client';

import { useEffect } from 'react';

import './globals.css';

/**
 * ROOT error boundary (Next.js 15). This catches errors thrown in the root
 * layout itself — the one place the locale `error.tsx` cannot reach. When it
 * renders it REPLACES the root layout, so it MUST emit its own
 * `<html><body>…` (Next requirement) and it CANNOT rely on the NextIntl
 * provider (that lives in the locale layout, which has been torn down). Hence
 * plain Hebrew literals — this is the last-resort fallback.
 *
 * SECURITY (owner requirement): identical rule to the locale boundary — the
 * DOM NEVER shows `error.message` / `error.stack` / any internals. Only the
 * opaque `error.digest` is surfaced, for support correlation. Full error →
 * console (and Sentry via instrumentation.ts), never the page.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error(error);
  }, [error]);

  return (
    <html lang="he" dir="rtl">
      <body className="font-sans antialiased">
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
              משהו השתבש
            </h1>
            <p className="mb-6 text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              אירעה תקלה בלתי צפויה. הצוות שלנו קיבל על כך התראה. אפשר לנסות שוב או לחזור לדף הבית.
            </p>

            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => reset()}
                className="btn btn-primary btn-lg w-full"
              >
                נסה שוב
              </button>
              <a href="/" className="btn btn-secondary btn-lg w-full">
                חזרה לדף הבית
              </a>
            </div>

            {error.digest && (
              <p className="mt-5 text-xs" style={{ color: 'var(--text-soft)' }}>
                מזהה לפנייה לתמיכה:{' '}
                <span className="tabular" dir="ltr">
                  {error.digest}
                </span>
              </p>
            )}
          </div>
        </main>
      </body>
    </html>
  );
}
