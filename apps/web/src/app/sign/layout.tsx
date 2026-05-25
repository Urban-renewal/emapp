import type { Metadata } from 'next';
import { Heebo } from 'next/font/google';

import '../globals.css';

const heebo = Heebo({
  subsets: ['hebrew', 'latin'],
  weight: ['300', '400', '500', '600', '700', '800'],
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
 * Hebrew RTL hardcoded (no next-intl) — residents always sign in
 * Hebrew; the URL is JWT-only and carries no locale. Layout is
 * deliberately minimal so the resident's focus stays on the document
 * + the canvas.
 */
export default function SignLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl" className={heebo.variable}>
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
