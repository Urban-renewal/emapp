import type { AlertEvent, IAlertSink } from './alert.interface';

/**
 * Production alert sink — POSTs the (PII-free) alert event to a configured
 * webhook (Slack / Opsgenie / a SOC intake / a Sentry "alerts" webhook).
 *
 * ⚠️ VERIFY-BEFORE-GO-LIVE (same posture as `InforuSmsProvider`): the
 * transport is a plain JSON `POST`; CONFIRM the destination's expected body
 * shape (Slack wants `{text}`, Opsgenie wants `{message,priority}`, …) and
 * map {@link AlertEvent} to it before relying on paging in an incident. The
 * factory only selects this when `ALERT_WEBHOOK_URL` is set, so go-live is a
 * pure Infisical config swap — no code change at any call-site.
 *
 * Fail-SAFE: a delivery failure (webhook down, timeout, non-2xx) is caught
 * and LOGGED to stderr — it never rejects, so the security path that fired
 * the alert (login, provider read) cannot be crashed by a flaky pager. A
 * dropped alert is logged loudly because a silently-lost breach alert is
 * itself an incident.
 *
 * No PII leaves here: the event is forwarded as-built by the detector
 * (`severity` / `kind` / `summary` / `meta` of counts+ids). This sink does
 * NOT enrich with anything.
 */
export interface WebhookAlertConfig {
  url: string;
  /** ms before the POST is abandoned (fail-safe). Default 3000. */
  timeoutMs?: number;
  /** Optional bearer/shared-secret header value for the intake endpoint. */
  authToken?: string;
}

export class WebhookAlertSink implements IAlertSink {
  private readonly timeoutMs: number;

  constructor(private readonly config: WebhookAlertConfig) {
    this.timeoutMs = config.timeoutMs ?? 3000;
  }

  async alert(event: AlertEvent): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.config.authToken) headers['authorization'] = `Bearer ${this.config.authToken}`;

      const res = await fetch(this.config.url, {
        method: 'POST',
        headers,
        // Body is the detector-built, PII-free event verbatim.
        body: JSON.stringify({
          severity: event.severity,
          kind: event.kind,
          summary: event.summary,
          meta: event.meta ?? {},
          ts: new Date().toISOString(),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        process.stderr.write(
          `[WebhookAlertSink] alert delivery non-2xx (${res.status}) for kind=${event.kind} — alert NOT delivered\n`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(
        `[WebhookAlertSink] alert delivery FAILED for kind=${event.kind}: ${msg} — alert NOT delivered\n`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
