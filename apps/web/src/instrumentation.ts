export async function register() {
  if (process.env['NEXT_RUNTIME'] === 'nodejs') {
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
