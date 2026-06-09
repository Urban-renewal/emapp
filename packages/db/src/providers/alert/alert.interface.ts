/**
 * Pluggable alert sink (P0.B2) — the seam a real SOC / on-call / breach-
 * notification flow plugs into.
 *
 * Today Sentry CAPTURES errors but nobody is PAGED, and there is no channel
 * that carries a security-relevant signal (a brute-force burst, a spike in
 * Provider PII access) to a human inside the Israeli "immediate / 72h" breach-
 * notification window (Privacy Protection Regulations / GDPR-aligned). This
 * interface is that channel. `BreachDetectionService` decides WHEN to fire; an
 * `IAlertSink` impl decides WHERE it goes (Sentry message, webhook, PagerDuty,
 * an email to the DPO …) — selected by an env factory, swapped without
 * touching the detector.
 *
 * PII contract (CRITICAL): an `AlertEvent` MUST NOT carry national_id, phone,
 * email, token, or any free-text that could embed them. `meta` is for COUNTS,
 * KINDS, and opaque IDS (orgId / actorId UUIDs) only. The breach detector
 * builds the payload from those primitives; sinks must not enrich with PII.
 *
 * Failure contract: alerts are FAIL-SAFE — a sink failure (Sentry down, webhook
 * timeout) MUST NOT crash the path that fired the alert, but it MUST be logged
 * (a silently-dropped breach alert is itself an incident). Impls catch + log;
 * `alert()` resolves regardless.
 */

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertEvent {
  /** Triage priority. `critical` is the page-someone-now tier. */
  severity: AlertSeverity;
  /**
   * Stable machine kind for routing/dedup, e.g.
   * `auth.bruteforce_burst`, `provider.pii_access_spike`,
   * `authz.denial_burst`. A constant — never user input.
   */
  kind: string;
  /** Short human-readable, PII-free one-liner for the on-call. */
  summary: string;
  /**
   * Structured, NON-PII context: counts, thresholds, window seconds, opaque
   * ids. No national_id / phone / email / token / free user text.
   */
  meta?: Record<string, string | number | boolean>;
}

export interface IAlertSink {
  alert(event: AlertEvent): Promise<void>;
}
