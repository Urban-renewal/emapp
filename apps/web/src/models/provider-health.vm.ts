import type { SystemHealth } from '@emapp/shared-types';

/**
 * Provider system-health ViewModel — D.37 read-only gauges.
 *
 * The wire numbers are passed through verbatim; the adapter precomputes
 * a per-gauge \"severity\" (`ok` / `warn` / `crit`) using rules locked
 * to the BE invariants. Pages render a single dot + tooltip per gauge.
 *
 * Severity rules (locked, change requires updating the adapter
 * spec — `provider-health.spec.ts`):
 *  - Queue.failed > 0 → `crit` (any permanent failure deserves
 *    operator attention; D.31 imports playbook).
 *  - Queue.retry > 10 → `warn` (back-pressure building).
 *  - Pool.waiting > 0 on EITHER pool → `crit` (request is blocked
 *    on connection checkout; symptom of pool exhaustion).
 *  - Pool.idle = 0 AND total > 0 → `warn` (saturated but no
 *    waiting yet).
 *  - R2.errorsSinceBoot > 0 AND lastErrorAt within 5 minutes → `warn`
 *    (recent storage issue); within 1 minute → `crit`.
 *  - Otherwise → `ok`.
 *
 * The VM does NOT decide UI color directly — pages map severity to
 * the StatusBadge color via i18n (`gray` / `amber` / `red`).
 */
export type ProviderHealthSeverity = 'ok' | 'warn' | 'crit';

export interface ProviderHealthGaugeVM<T> {
  value: T;
  severity: ProviderHealthSeverity;
}

export interface ProviderQueueGaugeVM {
  active: ProviderHealthGaugeVM<number>;
  created: ProviderHealthGaugeVM<number>;
  retry: ProviderHealthGaugeVM<number>;
  failed: ProviderHealthGaugeVM<number>;
  completed: ProviderHealthGaugeVM<number>;
  /** Overall severity = max(severity of {failed, retry}). */
  overall: ProviderHealthSeverity;
}

export interface ProviderPoolGaugeVM {
  total: number;
  idle: number;
  waiting: number;
  /** Overall severity per the rules above. */
  severity: ProviderHealthSeverity;
}

export interface ProviderR2GaugeVM {
  errorsSinceBoot: number;
  lastErrorAt: Date | null;
  /** Severity factors in BOTH the count AND recency. */
  severity: ProviderHealthSeverity;
}

export interface ProviderSystemHealthVM {
  queue: ProviderQueueGaugeVM;
  pool: {
    app: ProviderPoolGaugeVM;
    provider: ProviderPoolGaugeVM;
  };
  r2: ProviderR2GaugeVM;
  /** Timestamp on the wire — when this snapshot was taken. */
  timestamp: Date;
  /** Convenience: worst severity across the three subsystems. */
  overall: ProviderHealthSeverity;
}

export type { SystemHealth };
