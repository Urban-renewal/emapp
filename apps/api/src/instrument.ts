import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env['SENTRY_DSN_API'],
  environment: process.env['NODE_ENV'] ?? 'development',
  tracesSampleRate: 0.1,
});
