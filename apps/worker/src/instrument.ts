/**
 * Worker Sentry init (audit slice S2) — mirrors apps/api/src/instrument.ts.
 *
 * DSN-gated: only initialise Sentry when `SENTRY_DSN_WORKER` is configured. A
 * DSN-less deploy gains nothing from initialising it, and (per the API's
 * QA-OTP-1 root-cause) a DSN-less `Sentry.init` still wires the OTel/event
 * pipeline, which can amplify into a CPU spin under a tight error loop. Import
 * this FIRST in main.ts so the SDK is ready before any handler runs.
 */
import * as Sentry from '@sentry/node';

const dsn = process.env['SENTRY_DSN_WORKER'];
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env['NODE_ENV'] ?? 'development',
    tracesSampleRate: 0.1,
  });
}
