/**
 * Pluggable application-metrics seam (P0.B2).
 *
 * Mirrors the canonical provider shape (sms / email / realtime): one
 * interface + a Noop (dev/test) + a real impl, selected by an env-driven
 * factory and wired via DI behind a token. The point is that today nobody
 * exports request/auth/scan metrics anywhere a dashboard or alerting rule
 * can read them; this gives one stable seam a prod metrics backend
 * (prom-client registry, OTel exporter, StatsD, …) plugs into without any
 * call-site change.
 *
 * Cardinality / PII contract (CRITICAL — a security-reviewer checks this):
 *   - `name` is a fixed metric identifier (a constant, never user input).
 *   - `labels` MUST be LOW-CARDINALITY and NON-PII. Allowed: route
 *     templates (`/api/v1/owners/:id`, NOT the concrete id), HTTP method,
 *     status-class (`2xx`), an enum verdict, a boolean. FORBIDDEN: any
 *     national_id / phone / email / token / raw URL with ids / free text.
 *     High-cardinality labels (a UUID, a timestamp) blow up the metric
 *     store and can re-identify a subject — never pass them.
 *
 * Failure contract: metrics are FAIL-OPEN. A metrics call MUST NEVER throw
 * into the request path. Implementations swallow their own errors; the
 * interface returns `void` (no async, nothing to await, nothing to reject).
 */

/** Low-cardinality, non-PII label set. Values are short enum-like strings. */
export type MetricLabels = Record<string, string>;

export interface IMetricsProvider {
  /**
   * Monotonic counter increment (e.g. `http_requests_total`,
   * `auth_login_failed_total`). `value` defaults to 1.
   */
  counter(name: string, value?: number, labels?: MetricLabels): void;

  /**
   * Point-in-time gauge (e.g. `process_uptime_seconds`,
   * `breach_window_failed_logins`). Sets the current value.
   */
  gauge(name: string, value: number, labels?: MetricLabels): void;

  /**
   * Distribution sample, typically a duration in milliseconds
   * (e.g. `http_request_duration_ms`). Named `timing` to read naturally at
   * the latency call-sites; a histogram-backed impl buckets it.
   */
  timing(name: string, valueMs: number, labels?: MetricLabels): void;
}
