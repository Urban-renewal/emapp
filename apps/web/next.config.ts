import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

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
      "font-src 'self' data: https://fonts.gstatic.com",
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
