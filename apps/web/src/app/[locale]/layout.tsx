import type { Metadata } from 'next';
import { Heebo } from 'next/font/google';
import { notFound } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';

import { routing } from '@/i18n/routing';
import { MswInit } from '@/mocks/msw-init';
import '../globals.css';

// §PERF-M1 — narrowed from 6 weights × 2 subsets (12 woff2 files,
// ~250-400 KB) to the 3 weights actually used (400, 600, 700) — saves
// ~150 KB on first paint. If a new weight is needed, add it here.
const heebo = Heebo({
  subsets: ['hebrew', 'latin'],
  weight: ['400', '600', '700'],
  variable: '--font-heebo',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'EMAPP — התחדשות עירונית',
  description: 'מערכת לניהול פרויקטי תמ"א 38 ופינוי-בינוי',
};

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  if (!(routing.locales as readonly string[]).includes(locale)) {
    notFound();
  }

  const messages = await getMessages();
  const dir = locale === 'he' ? 'rtl' : 'ltr';

  return (
    <html lang={locale} dir={dir} className={heebo.variable}>
      <body className="font-sans antialiased">
        <NextIntlClientProvider messages={messages}>
          <MswInit>{children}</MswInit>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
