import {
  BreachDetectionService,
  NoopAlertSink,
  NoopMetricsProvider,
  PrometheusMetricsProvider,
  WebhookAlertSink,
  type BreachThresholds,
  type IAlertSink,
  type IMetricsProvider,
} from '@emapp/db';
import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/node';

/**
 * Env-driven selection for the observability seam (P0.B2) — mirrors
 * `smsProviderFactory` (auth/tenant/sms-provider.factory.ts):
 *
 *   - Metrics: `METRICS_BACKEND=prometheus` → in-process Prometheus registry
 *     (scraped at `/metrics`). Else → `NoopMetricsProvider` (dev/test). Metrics
 *     are fail-open and non-essential, so — unlike SMS — there is NO fail-fast
 *     in prod: a missing metrics backend degrades observability, it does not
 *     lock users out.
 *
 *   - Alerts: `ALERT_WEBHOOK_URL` present → real `WebhookAlertSink`. Else →
 *     `NoopAlertSink`. (Future: a SentryAlertSink could be added here behind
 *     the same token without touching the detector.)
 *
 *   - Thresholds: optional env overrides; otherwise the library defaults.
 *
 * Wiring the real backends is a pure Infisical config swap — no code change.
 */

export function metricsProviderFactory(): IMetricsProvider {
  const backend = process.env['METRICS_BACKEND'];
  if (backend === 'prometheus') {
    return new PrometheusMetricsProvider();
  }
  return new NoopMetricsProvider();
}

export function alertSinkFactory(): IAlertSink {
  const url = process.env['ALERT_WEBHOOK_URL'];
  if (url) {
    return new WebhookAlertSink({
      url,
      authToken: process.env['ALERT_WEBHOOK_TOKEN'],
      timeoutMs: numericEnv('ALERT_WEBHOOK_TIMEOUT_MS'),
    });
  }
  // S3 (audit Theme A) — in PRODUCTION a missing ALERT_WEBHOOK_URL means
  // breach-detection SECURITY alerts (failed-login bursts, authz-denial bursts,
  // provider-PII spikes) are detected but delivered to a NO-OP sink, silently.
  // We deliberately do NOT hard-fail (D.59): alerting is operator observability,
  // not essential-to-serving — coupling app UPTIME to an operator-only config
  // would be a self-inflicted DoS, and contradicts the fail-open stance the
  // metrics factory above documents. Instead we make the gap LOUD and
  // impossible to miss — an ERROR log + a Sentry warning (Sentry is wired by
  // S1/S2) — then return the no-op sink so the app still boots.
  if (process.env['NODE_ENV'] === 'production') {
    const message =
      'ALERT_WEBHOOK_URL is unset in production — breach-detection alerts are going to a NO-OP sink. ' +
      'Security alerts (failed-login bursts, authz-denial bursts, provider-PII spikes) will NOT be ' +
      'delivered. Set ALERT_WEBHOOK_URL (Infisical) to wire real alerting.';
    new Logger('alertSinkFactory').error(message);
    Sentry.captureMessage(message, 'warning');
  }
  return new NoopAlertSink();
}

export function breachThresholdsFromEnv(): Partial<BreachThresholds> {
  const t: Partial<BreachThresholds> = {};
  const win = numericEnv('BREACH_WINDOW_MS');
  const fail = numericEnv('BREACH_FAILED_LOGIN_BURST');
  const denial = numericEnv('BREACH_AUTHZ_DENIAL_BURST');
  const pii = numericEnv('BREACH_PROVIDER_PII_SPIKE');
  if (win !== undefined) t.windowMs = win;
  if (fail !== undefined) t.failedLoginBurst = fail;
  if (denial !== undefined) t.authzDenialBurst = denial;
  if (pii !== undefined) t.providerPiiAccessSpike = pii;
  return t;
}

export function breachDetectionFactory(
  alerts: IAlertSink,
  metrics: IMetricsProvider,
): BreachDetectionService {
  return new BreachDetectionService(alerts, metrics, breachThresholdsFromEnv());
}

function numericEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}
