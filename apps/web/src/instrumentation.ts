export async function register() {
  if (process.env['NEXT_RUNTIME'] === 'nodejs') {
    // PERF (2026-06-21): IPv4-first DNS (mirrors apps/api/src/instrument.ts).
    // Node 18+ resolves `localhost` to IPv6 `[::1]` first; on the Windows dev
    // host that loopback is slow (~0.2s/connection), and the authenticated SSR
    // pays it on every hop — getMe self-fetch → same-origin reverse-proxy route
    // handler (app/api/[...path]) → API — compounding into a ~1.6s home render
    // (every click > 1s). Forcing ipv4first in-process fixes it where
    // NODE_OPTIONS=--dns-result-order doesn't reach Next's render workers.
    // Harmless in prod (all upstreams have IPv4; it's the pre-Node-18 default).
    const dns = await import('node:dns');
    dns.setDefaultResultOrder('ipv4first');
    const { init } = await import('@sentry/nextjs');
    init({
      dsn: process.env['NEXT_PUBLIC_SENTRY_DSN_WEB'],
      environment: process.env['NODE_ENV'] ?? 'development',
      tracesSampleRate: 0.1,
      // §RED-4 closure — PII scrub. The Sentry SDK defaults to
      // sendDefaultPii=false in v8 but we pin it explicitly so a future
      // SDK default flip doesn't silently start shipping IPs / cookies.
      sendDefaultPii: false,
      beforeSend(event) {
        // Redact bearer tokens from /sign/<jwt> URLs — the JWT is the
        // resident's signing credential (D.12); leaking it to Sentry is
        // equivalent to handing the signing surface to anyone with
        // Sentry read access (ISO A.9.4.1).
        if (event.request?.url) {
          event.request.url = event.request.url.replace(
            /\/sign\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
            '/sign/<redacted-jwt>',
          );
        }
        if (event.breadcrumbs) {
          for (const b of event.breadcrumbs) {
            if (typeof b.data?.['url'] === 'string') {
              b.data['url'] = (b.data['url'] as string).replace(
                /\/sign\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
                '/sign/<redacted-jwt>',
              );
            }
          }
        }
        // Redact obvious PII keys from `extra` / `contexts` — defense
        // in depth in case validation_error details containing
        // national_id ever bubble up to an unhandled exception.
        const PII_KEYS = ['national_id', 'phone', 'signatureSvg', 'password'];
        function scrub(obj: Record<string, unknown> | undefined) {
          if (!obj) return;
          for (const k of PII_KEYS) {
            if (k in obj) obj[k] = '<redacted>';
          }
        }
        scrub(event.extra);
        if (event.contexts) {
          for (const ctx of Object.values(event.contexts)) {
            if (ctx && typeof ctx === 'object') scrub(ctx as Record<string, unknown>);
          }
        }
        return event;
      },
    });
  }
}
