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
 * Static security headers (closes §v9-P0-5 + Doc 07 §6.13 + ISO A.14).
 *
 * §MQA-1 — the `Content-Security-Policy` is NO LONGER set here. It needs a
 * PER-REQUEST nonce (Next App Router emits inline bootstrap + RSC-flight
 * scripts that a static `script-src 'self'` blocks → blank prod app), which a
 * config-level header cannot mint. The CSP now lives in `src/middleware.ts`
 * (built by `src/lib/csp.ts`) and is set per request on both the request
 * headers (so Next nonces its inline scripts) and the response. These remaining
 * headers carry NO per-request value, so they stay here and apply to every
 * non-`/api` response (including `_next` assets the middleware matcher skips).
 *
 *  - `frame-ancestors 'none'` lives in the CSP (middleware); `X-Frame-Options:
 *    DENY` here is the legacy-browser superset.
 *  - HSTS deferred to production-only (browsers honor it only on HTTPS; dev
 *    http://localhost would log a warning).
 *
 * The Pages Function reverse-proxy strips these from BE responses (per D.35) so
 * api-response payloads only carry what the BE chose.
 */
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig: NextConfig = {
  output: process.env['NEXT_OUTPUT'] === 'standalone' ? 'standalone' : undefined,
  reactStrictMode: true,
  // Next 15: `typedRoutes` graduated from `experimental` to top-level.
  typedRoutes: true,
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
