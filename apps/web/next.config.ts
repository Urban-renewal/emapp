import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/**
 * §RED-3 closure — refuse production build with NEXT_PUBLIC_MSW=1.
 *
 * MSW is wired in `apps/web/src/mocks/msw-init.tsx` behind an env-flag
 * gate. NEXT_PUBLIC_* values are INLINED at build time, so a Cloudflare
 * Pages build that accidentally sets this flag would ship the MSW
 * worker live in production — silently intercepting every /api/v1/*
 * call with SAMPLE_* fixtures and breaking auth + persisting nothing.
 *
 * This fail-fast assertion is the second line of defense (the first is
 * the .gitignore'd `public/mockServiceWorker.js` — if the worker file
 * isn't in the build, registration fails). Together they make accidental
 * MSW-in-prod a hard build error rather than a silent runtime corruption.
 */
if (process.env['NODE_ENV'] === 'production' && process.env['NEXT_PUBLIC_MSW'] === '1') {
  throw new Error(
    '[next.config] §RED-3 — refusing production build with NEXT_PUBLIC_MSW=1. ' +
      'MSW is dev-only; unset the env flag for production builds.',
  );
}

/**
 * Security headers (closes §v9-P0-5 + Doc 07 §6.13 + ISO A.14).
 *
 * Trade-offs:
 *  - `script-src 'self'` — no `unsafe-inline`. Tailwind ships zero
 *    inline scripts so this is safe. If Sentry browser SDK lands
 *    (Phase 9), add `https://*.sentry.io` to script-src + connect-src
 *    (Doc 02 §SHIELD2).
 *  - `style-src 'self' 'unsafe-inline'` — Tailwind generates inline
 *    style attributes via Heebo font + Next.js dev-mode HMR. The
 *    risk surface is bounded (style attrs cannot execute code).
 *  - `connect-src 'self'` — every API call is same-origin (D.35).
 *  - `frame-ancestors 'none'` — superset of X-Frame-Options: DENY
 *    (clickjacking).
 *  - `form-action 'self'` — only our own forms; no cross-origin
 *    form submission (CSRF defense-in-depth).
 *  - HSTS deferred to production-only (browsers honor it only on
 *    HTTPS; dev http://localhost would log a warning).
 *
 * These headers apply to EVERY response from the FE — middleware
 * doesn't add them per-route; Next.js applies the config-level
 * headers() globally. The Pages Function reverse-proxy strips them
 * from BE responses (per D.35) so api-response payloads only carry
 * what the BE chose.
 */
const securityHeaders = [
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      // §PERF-M3 — `next/font/google` self-hosts; gstatic allowance is dead.
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  output: process.env['NEXT_OUTPUT'] === 'standalone' ? 'standalone' : undefined,
  reactStrictMode: true,
  experimental: {
    typedRoutes: true,
  },
  async headers() {
    return [
      {
        // Apply to all routes EXCEPT the API proxy — the proxy returns
        // upstream BE responses verbatim; we don't want to overlay our
        // FE CSP on them (the BE has its own Helmet config).
        source: '/((?!api/).*)',
        headers: securityHeaders,
      },
    ];
  },
};

export default withNextIntl(nextConfig);
