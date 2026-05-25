import type { SystemHealth } from '@emapp/shared-types';

import type {
  ProviderHealthSeverity,
  ProviderPoolGaugeVM,
  ProviderQueueGaugeVM,
  ProviderR2GaugeVM,
  ProviderSystemHealthVM,
} from '@/models/provider-health.vm';

/**
 * Wire → VM for D.37 system-health gauges.
 *
 * Severity rules (locked — change requires updating spec):
 *  - **Queue:** `failed > 0` → `crit`; `retry > 10` → `warn`; else `ok`.
 *  - **Pool (either):** `waiting > 0` → `crit`; `idle = 0 && total > 0`
 *    → `warn`; else `ok`.
 *  - **R2:** `errorsSinceBoot > 0` AND lastErrorAt within 60s → `crit`;
 *    within 5 min → `warn`; else `ok`.
 *  - **Overall:** max severity across queue / app-pool / provider-pool
 *    / R2 (ordering: crit > warn > ok).
 *
 * Pure function — `now` is parameterised so the spec can pin a fixed
 * clock. Production passes `Date.now()` implicitly.
 */

const ONE_MINUTE_MS = 60_000;
const FIVE_MINUTES_MS = 5 * ONE_MINUTE_MS;
const QUEUE_RETRY_WARN_THRESHOLD = 10;

const SEVERITY_RANK: Record<ProviderHealthSeverity, number> = {
  ok: 0,
  warn: 1,
  crit: 2,
};

function worse(a: ProviderHealthSeverity, b: ProviderHealthSeverity): ProviderHealthSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

function queueSeverity(q: SystemHealth['queue']): {
  active: ProviderHealthSeverity;
  created: ProviderHealthSeverity;
  retry: ProviderHealthSeverity;
  failed: ProviderHealthSeverity;
  completed: ProviderHealthSeverity;
  overall: ProviderHealthSeverity;
} {
  // Active/created/completed are informational gauges — they have a
  // healthy range that's domain-specific (queue load varies by tenant
  // count). Severity here is always `ok` so the dot stays neutral;
  // pages can still display the raw number prominently.
  const failed: ProviderHealthSeverity = q.failed > 0 ? 'crit' : 'ok';
  const retry: ProviderHealthSeverity = q.retry > QUEUE_RETRY_WARN_THRESHOLD ? 'warn' : 'ok';
  return {
    active: 'ok',
    created: 'ok',
    retry,
    failed,
    completed: 'ok',
    overall: worse(failed, retry),
  };
}

function toPoolVM(p: SystemHealth['pool']['app']): ProviderPoolGaugeVM {
  let severity: ProviderHealthSeverity = 'ok';
  if (p.waiting > 0) severity = 'crit';
  else if (p.idle === 0 && p.total > 0) severity = 'warn';
  return { total: p.total, idle: p.idle, waiting: p.waiting, severity };
}

function toR2VM(r: SystemHealth['r2'], nowMs: number): ProviderR2GaugeVM {
  if (r.errorsSinceBoot === 0 || r.lastErrorAt === null) {
    return { errorsSinceBoot: r.errorsSinceBoot, lastErrorAt: r.lastErrorAt, severity: 'ok' };
  }
  const ageMs = nowMs - r.lastErrorAt.getTime();
  let severity: ProviderHealthSeverity = 'ok';
  if (ageMs <= ONE_MINUTE_MS) severity = 'crit';
  else if (ageMs <= FIVE_MINUTES_MS) severity = 'warn';
  return { errorsSinceBoot: r.errorsSinceBoot, lastErrorAt: r.lastErrorAt, severity };
}

export function toSystemHealthVM(
  wire: SystemHealth,
  now: Date = new Date(),
): ProviderSystemHealthVM {
  const nowMs = now.getTime();
  const qSev = queueSeverity(wire.queue);
  const appPool = toPoolVM(wire.pool.app);
  const providerPool = toPoolVM(wire.pool.provider);
  const r2 = toR2VM(wire.r2, nowMs);
  const queueVM: ProviderQueueGaugeVM = {
    active: { value: wire.queue.active, severity: qSev.active },
    created: { value: wire.queue.created, severity: qSev.created },
    retry: { value: wire.queue.retry, severity: qSev.retry },
    failed: { value: wire.queue.failed, severity: qSev.failed },
    completed: { value: wire.queue.completed, severity: qSev.completed },
    overall: qSev.overall,
  };
  const overall = [queueVM.overall, appPool.severity, providerPool.severity, r2.severity].reduce(
    worse,
    'ok' as ProviderHealthSeverity,
  );
  return {
    queue: queueVM,
    pool: { app: appPool, provider: providerPool },
    r2,
    timestamp: wire.timestamp,
    overall,
  };
}
