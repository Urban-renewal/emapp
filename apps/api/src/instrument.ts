import { setPoolErrorObserver } from '@emapp/db';
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env['SENTRY_DSN_API'],
  environment: process.env['NODE_ENV'] ?? 'development',
  tracesSampleRate: 0.1,
});

// Forward pg-pool resilience-guard events (Neon idle drop, network blip,
// any client-level error pg-pool reaps) to Sentry as breadcrumbs.
// Breadcrumb — not captureException — because the guard ALREADY contained
// the failure; this is observability for chronic-rate detection, not a
// surfaced error. Only err.message is forwarded (pg connection-layer,
// no query text / PII — enforced at the @emapp/db boundary).
// TODO(metrics): pool_client_reaped_total{pool} counter when a metrics
// stack is adopted (no prom-client / OpenTelemetry today).
setPoolErrorObserver((event) => {
  Sentry.addBreadcrumb({
    category: 'db.pool',
    level: 'warning',
    message: `${event.pool} client error (reaped): ${event.message}`,
    data: { pool: event.pool, source: event.source },
  });
});
