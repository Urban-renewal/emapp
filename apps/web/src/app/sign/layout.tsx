import type { Metadata } from 'next';
import { Heebo } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';

import heMessages from '@/messages/he.json';
import { MswInit } from '@/mocks/msw-init';
import '../globals.css';

// §PERF-M1 — same narrowed weight set as the dashboard layout.
const heebo = Heebo({
  subsets: ['hebrew', 'latin'],
  weight: ['400', '600', '700'],
  variable: '--font-heebo',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'EMAPP — חתימה',
  description: 'חתימה דיגיטלית על מסמך',
  // S10 — block search engines from indexing the public signing page;
  // the URL contains a bearer token and must never end up in a search
  // index or cached preview (ISO A.13.2.1 / A.18.1.4).
  robots: { index: false, follow: false, nocache: true, noimageindex: true },
};

/**
 * S10 — public residents' signing surface (D.12 LAW).
 *
 * §SOLID-H2 closure — i18n via `next-intl` (HE messages). The route
 * is outside `[locale]` (residents always sign in Hebrew, no locale
 * prefix in URL), but we still pipe the HE messages through
 * `NextIntlClientProvider` so the page uses the same `useTranslations`
 * shape as the dashboard (no hardcoded strings, no Hebrew literals in
 * the .tsx file).
 *
 * Layout is deliberately minimal so the resident's focus stays on the
 * document + the canvas.
 */
export default function SignLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl" className={heebo.variable}>
      <body className="font-sans antialiased">
        <NextIntlClientProvider locale="he" messages={heMessages}>
          <MswInit>{children}</MswInit>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
