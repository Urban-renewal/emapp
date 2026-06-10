import type { IMetricsProvider } from '../metrics/metrics.interface';

import type { IAlertSink } from './alert.interface';

/**
 * BreachDetectionService (P0.B2) — single-responsibility: OBSERVE security-
 * relevant signals, and when one crosses a threshold inside a sliding window,
 * fire ONE alert through the injected {@link IAlertSink}. It also mirrors the
 * live window size to a gauge via the {@link IMetricsProvider} so a dashboard
 * shows the pressure even below the alert line.
 *
 * Why a separate service (SOLID):
 *   - It does NOT touch the audit_log (append-only — D.21) and adds NO table.
 *     It OBSERVES the same events the audit/auth code already emits, via thin
 *     `observe*` seams the call-sites invoke right after they audit. Audit
 *     semantics are untouched; this is a parallel, in-memory detector.
 *   - It owns no transport (that's the sink) and no metric backend (that's the
 *     metrics provider) — it only decides WHEN something is anomalous.
 *
 * Detection model: per-(kind, scope) fixed-window counters. A window is a
 * wall-clock bucket of `windowMs`. When a bucket's count first reaches its
 * threshold we fire exactly once (`alertedThisWindow`) so a sustained attack
 * does not spam the pager every event. Old buckets are reaped lazily on each
 * observe to bound memory (no timers, worker-friendly).
 *
 * Fail-SAFE: a sink that rejects/throws is caught and logged here — a breach-
 * detection hiccup must never crash login or a provider read.
 *
 * NO PII: scopes are opaque ids (orgId / providerUserId UUIDs) or coarse
 * buckets; alert payloads carry counts + thresholds + ids only. Email / phone
 * / national_id never enter this service.
 */

export interface BreachThresholds {
  /** Sliding window length in ms. Default 5 min. */
  windowMs: number;
  /** Failed-login burst within window (per org) → alert. Default 10. */
  failedLoginBurst: number;
  /** Authz-denial burst within window (per actor) → alert. Default 20. */
  authzDenialBurst: number;
  /** Provider PII-access count within window (per provider user) → alert. Default 30. */
  providerPiiAccessSpike: number;
}

export const DEFAULT_BREACH_THRESHOLDS: BreachThresholds = {
  windowMs: 5 * 60_000,
  failedLoginBurst: 10,
  authzDenialBurst: 20,
  providerPiiAccessSpike: 30,
};

interface WindowState {
  windowStart: number;
  count: number;
  alertedThisWindow: boolean;
}

type SignalKind = 'auth.bruteforce_burst' | 'authz.denial_burst' | 'provider.pii_access_spike';

export class BreachDetectionService {
  private readonly windows = new Map<string, WindowState>();
  private readonly thresholds: BreachThresholds;

  constructor(
    private readonly alerts: IAlertSink,
    private readonly metrics: IMetricsProvider,
    thresholds?: Partial<BreachThresholds>,
    private readonly now: () => number = Date.now,
  ) {
    this.thresholds = { ...DEFAULT_BREACH_THRESHOLDS, ...thresholds };
  }

  /** A failed login attempt (call right after the audit row is written). */
  observeFailedLogin(orgId: string): void {
    this.observe(
      'auth.bruteforce_burst',
      orgId,
      this.thresholds.failedLoginBurst,
      'warning',
      (count) => `Failed-login burst: ${count} in ${this.windowSeconds()}s for one org`,
      { orgId },
    );
  }

  /** An authorization denial (policy/guard rejected an authenticated actor). */
  observeAuthzDenial(actorId: string): void {
    this.observe(
      'authz.denial_burst',
      actorId,
      this.thresholds.authzDenialBurst,
      'warning',
      (count) => `Authz-denial burst: ${count} denials in ${this.windowSeconds()}s for one actor`,
      { actorId },
    );
  }

  /** A Provider-tier read that touched tenant PII (cross-tenant privileged). */
  observeProviderPiiAccess(providerUserId: string): void {
    this.observe(
      'provider.pii_access_spike',
      providerUserId,
      this.thresholds.providerPiiAccessSpike,
      'critical',
      (count) =>
        `Provider PII-access spike: ${count} privileged reads in ${this.windowSeconds()}s by one provider user`,
      { providerUserId },
    );
  }

  private windowSeconds(): number {
    return Math.round(this.thresholds.windowMs / 1000);
  }

  private observe(
    kind: SignalKind,
    scope: string,
    threshold: number,
    severity: 'warning' | 'critical',
    summary: (count: number) => string,
    metaIds: Record<string, string>,
  ): void {
    try {
      const key = `${kind}#${scope}`;
      const t = this.now();
      let w = this.windows.get(key);
      if (!w || t - w.windowStart >= this.thresholds.windowMs) {
        w = { windowStart: t, count: 0, alertedThisWindow: false };
        this.windows.set(key, w);
        this.reap(t);
      }
      w.count += 1;

      // Mirror live pressure to a gauge (low-cardinality: kind only, NOT the
      // per-scope id — that would be high-cardinality / re-identifying).
      this.metrics.gauge('breach_window_count', w.count, { kind });

      if (!w.alertedThisWindow && w.count >= threshold) {
        w.alertedThisWindow = true;
        this.metrics.counter('breach_alert_fired_total', 1, { kind, severity });
        // Fire-and-forget; the sink is fail-safe and so are we.
        void this.fire(kind, severity, summary(w.count), {
          ...metaIds,
          count: w.count,
          threshold,
          window_seconds: this.windowSeconds(),
        });
      }
    } catch (e) {
      // Detection must never crash the observed path.
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[BreachDetection] observe(${kind}) failed: ${msg}\n`);
    }
  }

  private async fire(
    kind: SignalKind,
    severity: 'warning' | 'critical',
    summary: string,
    meta: Record<string, string | number | boolean>,
  ): Promise<void> {
    try {
      await this.alerts.alert({ severity, kind, summary, meta });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[BreachDetection] alert sink failed for ${kind}: ${msg}\n`);
    }
  }

  /** Lazily drop windows older than 2× the window length to bound memory. */
  private reap(now: number): void {
    const cutoff = now - this.thresholds.windowMs * 2;
    for (const [key, w] of this.windows) {
      if (w.windowStart < cutoff) this.windows.delete(key);
    }
  }
}
