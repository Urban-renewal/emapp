/**
 * S3 (audit, Theme A) — `alertSinkFactory` must NOT silently drop breach-detection
 * SECURITY alerts in production.
 *
 * Today `alertSinkFactory` returns a real `WebhookAlertSink` when
 * `ALERT_WEBHOOK_URL` is set, and otherwise SILENTLY returns a `NoopAlertSink`.
 * In production a missing `ALERT_WEBHOOK_URL` therefore means failed-login bursts,
 * authz-denial bursts and provider-PII spikes (emitted by `BreachDetectionService`)
 * are detected but delivered NOWHERE — no log, no page.
 *
 * The contract pinned here (RED until the impl lands) is LOUD-WARN, NOT hard-fail
 * (alerting is operator observability, not essential-to-serving — consistent with
 * the metrics fail-open stance in the same file: a missing pager must not DoS the
 * app):
 *
 *   1. production + ALERT_WEBHOOK_URL UNSET ⇒ LOUD warning:
 *        - `Logger.prototype.error(...)` called once, message mentions the
 *          alert/webhook gap;
 *        - `Sentry.captureMessage(<message>, 'warning')` called once;
 *      THEN STILL returns a `NoopAlertSink` (app must boot — fail-open).
 *   2. production + ALERT_WEBHOOK_URL SET ⇒ `WebhookAlertSink`; NO Logger.error,
 *      NO Sentry.captureMessage (no regression on the happy path).
 *   3. non-production (development AND test) + UNSET ⇒ `NoopAlertSink`; NO
 *      Logger.error, NO Sentry.captureMessage (dev/test silence — only prod is loud).
 *
 * Harness: pure unit test (no DB) — run with the DB-less pure config, mirroring
 * `http-exception.filter.sentry.spec.ts`:
 *   pnpm --filter @emapp/api exec vitest run --config vitest.pure.config.ts observability.factory
 */
import { NoopAlertSink, WebhookAlertSink } from '@emapp/db';
import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/node', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  init: vi.fn(),
}));

import { alertSinkFactory } from './observability.factory';

const DUMMY_WEBHOOK_URL = 'https://hooks.example/test';

describe('alertSinkFactory — S3: prod must not silently drop breach alerts', () => {
  // Save originals so we can restore exactly (delete when originally undefined).
  let savedNodeEnv: string | undefined;
  let savedWebhookUrl: string | undefined;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    savedNodeEnv = process.env['NODE_ENV'];
    savedWebhookUrl = process.env['ALERT_WEBHOOK_URL'];
    // Silence + observe the loud-warn log line.
    errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (savedNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = savedNodeEnv;
    if (savedWebhookUrl === undefined) delete process.env['ALERT_WEBHOOK_URL'];
    else process.env['ALERT_WEBHOOK_URL'] = savedWebhookUrl;
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  // ---- (1) production + UNSET ⇒ LOUD warn, then fail-open Noop ----
  it('production + ALERT_WEBHOOK_URL UNSET ⇒ logs an error, captures a Sentry warning, and still returns a NoopAlertSink', () => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['ALERT_WEBHOOK_URL'];

    const sink = alertSinkFactory();

    // Fail-open: the app must boot even with no pager configured.
    expect(sink).toBeInstanceOf(NoopAlertSink);

    // Loud server log — called exactly once, mentioning the alert/webhook gap.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const loggedMsg = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(loggedMsg).toMatch(/ALERT_WEBHOOK_URL|alert/i);

    // Loud Sentry warning — called once, with level 'warning'.
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    const [sentryMsg, sentryLevel] = (Sentry.captureMessage as ReturnType<typeof vi.fn>).mock
      .calls[0] as [unknown, unknown];
    expect(String(sentryMsg)).toMatch(/ALERT_WEBHOOK_URL|alert/i);
    expect(sentryLevel).toBe('warning');
  });

  // ---- (2) production + SET ⇒ real sink, NO loud warn (no regression) ----
  it('production + ALERT_WEBHOOK_URL SET ⇒ returns a WebhookAlertSink with no warning log or Sentry capture', () => {
    process.env['NODE_ENV'] = 'production';
    process.env['ALERT_WEBHOOK_URL'] = DUMMY_WEBHOOK_URL;

    const sink = alertSinkFactory();

    expect(sink).toBeInstanceOf(WebhookAlertSink);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
  });

  // ---- (3) non-production + UNSET ⇒ silent Noop (dev/test are not loud) ----
  it.each(['development', 'test'])(
    'NODE_ENV=%s + ALERT_WEBHOOK_URL UNSET ⇒ returns a NoopAlertSink silently (no warning log or Sentry capture)',
    (nodeEnv) => {
      process.env['NODE_ENV'] = nodeEnv;
      delete process.env['ALERT_WEBHOOK_URL'];

      const sink = alertSinkFactory();

      expect(sink).toBeInstanceOf(NoopAlertSink);
      expect(errorSpy).not.toHaveBeenCalled();
      expect(Sentry.captureMessage).not.toHaveBeenCalled();
    },
  );
});
