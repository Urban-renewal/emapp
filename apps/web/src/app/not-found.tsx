import './globals.css';

/**
 * ROOT 404 page (Next.js 15). Renders for URLs that match NO route at all —
 * e.g. `/he/sign/<bad>` (there is no `[locale]/sign` segment) or any path
 * outside the locale tree. The locale-segment `[locale]/not-found.tsx` only
 * catches `notFound()` within `/[locale]/…`; truly-unmatched URLs fell through
 * to Next.js's default English "404 — This page could not be found", which was
 * jarring in a Hebrew RTL product (S-1 from the manual review).
 *
 * Like `global-error.tsx`, this renders OUTSIDE the locale layout, so it cannot
 * use the NextIntl provider and MUST emit its own `<html><body>` (the root
 * `layout.tsx` is a pass-through). Plain Hebrew literals, branded RTL shell —
 * a missing page now looks intentional, not broken.
 */
export default function RootNotFound() {
  return (
    <html lang="he" dir="rtl">
      <body className="font-sans antialiased">
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
              הדף לא נמצא
            </h1>
            <p className="mb-6 text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              הקישור שגוי או שהדף הוסר. אפשר לחזור לדף הבית ולהמשיך משם.
            </p>
            <a href="/" className="btn btn-primary btn-lg w-full">
              חזרה לדף הבית
            </a>
          </div>
        </main>
      </body>
    </html>
  );
}
