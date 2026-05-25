/**
 * §provider-health adapter — severity rule pin (D.37 system-health).
 *
 * Each severity rule is locked to the spec table in
 * `adapters/provider-health.ts`. Changing a threshold (e.g. retry
 * warn from 10 → 20) requires updating this test — the operator
 * intent is preserved across refactors.
 *
 * Threat-model linkage: the page renders these gauges to a Provider
 * Admin who acts on the signals. A regression that flips `crit` →
 * `ok` would silently hide a queue stall or pool exhaustion until
 * users notice. This spec is the loud guardrail.
 */
import { describe, expect, it } from 'vitest';

import { toSystemHealthVM } from './provider-health';

function makeWire(
  overrides: {
    queue?: Partial<{
      active: number;
      created: number;
      retry: number;
      failed: number;
      completed: number;
    }>;
    appPool?: Partial<{ total: number; idle: number; waiting: number }>;
    providerPool?: Partial<{ total: number; idle: number; waiting: number }>;
    r2?: Partial<{ errorsSinceBoot: number; lastErrorAt: Date | null }>;
    timestamp?: Date;
  } = {},
) {
  return {
    queue: {
      active: 0,
      created: 0,
      retry: 0,
      failed: 0,
      completed: 0,
      ...overrides.queue,
    },
    pool: {
      app: { total: 10, idle: 10, waiting: 0, ...overrides.appPool },
      provider: { total: 4, idle: 4, waiting: 0, ...overrides.providerPool },
    },
    r2: { errorsSinceBoot: 0, lastErrorAt: null, ...overrides.r2 },
    timestamp: overrides.timestamp ?? new Date('2026-05-25T10:00:00Z'),
  };
}

const NOW = new Date('2026-05-25T10:00:00Z');

describe('§provider-health — queue severity', () => {
  it('1) all-zero queue → overall ok', () => {
    const vm = toSystemHealthVM(makeWire(), NOW);
    expect(vm.queue.overall).toBe('ok');
    expect(vm.overall).toBe('ok');
  });

  it('2) failed > 0 → crit (any permanent failure deserves attention)', () => {
    const vm = toSystemHealthVM(makeWire({ queue: { failed: 1 } }), NOW);
    expect(vm.queue.failed.severity).toBe('crit');
    expect(vm.queue.overall).toBe('crit');
    expect(vm.overall).toBe('crit');
  });

  it('3) retry > 10 → warn; retry = 10 stays ok', () => {
    const warn = toSystemHealthVM(makeWire({ queue: { retry: 11 } }), NOW);
    expect(warn.queue.retry.severity).toBe('warn');
    expect(warn.queue.overall).toBe('warn');
    const ok = toSystemHealthVM(makeWire({ queue: { retry: 10 } }), NOW);
    expect(ok.queue.retry.severity).toBe('ok');
    expect(ok.queue.overall).toBe('ok');
  });

  it('4) failed + retry both elevated → overall takes the worst (crit > warn)', () => {
    const vm = toSystemHealthVM(makeWire({ queue: { failed: 1, retry: 50 } }), NOW);
    expect(vm.queue.overall).toBe('crit');
  });
});

describe('§provider-health — pool severity', () => {
  it('5) idle pool → ok', () => {
    const vm = toSystemHealthVM(makeWire(), NOW);
    expect(vm.pool.app.severity).toBe('ok');
    expect(vm.pool.provider.severity).toBe('ok');
  });

  it('6) waiting > 0 on app pool → crit', () => {
    const vm = toSystemHealthVM(makeWire({ appPool: { waiting: 1, idle: 0, total: 10 } }), NOW);
    expect(vm.pool.app.severity).toBe('crit');
    expect(vm.overall).toBe('crit');
  });

  it('7) saturated (idle=0, total>0, no waiting yet) → warn', () => {
    const vm = toSystemHealthVM(makeWire({ appPool: { idle: 0, waiting: 0, total: 10 } }), NOW);
    expect(vm.pool.app.severity).toBe('warn');
    expect(vm.overall).toBe('warn');
  });

  it('8) provider pool waiting also surfaces — independently severity-rated', () => {
    const vm = toSystemHealthVM(makeWire({ providerPool: { total: 4, idle: 0, waiting: 1 } }), NOW);
    expect(vm.pool.provider.severity).toBe('crit');
    expect(vm.pool.app.severity).toBe('ok');
    expect(vm.overall).toBe('crit');
  });
});

describe('§provider-health — R2 severity (count + recency)', () => {
  it('9) errorsSinceBoot=0 → ok regardless of lastErrorAt', () => {
    const vm = toSystemHealthVM(makeWire({ r2: { errorsSinceBoot: 0, lastErrorAt: null } }), NOW);
    expect(vm.r2.severity).toBe('ok');
  });

  it('10) error within 60s → crit', () => {
    const recent = new Date(NOW.getTime() - 30_000);
    const vm = toSystemHealthVM(makeWire({ r2: { errorsSinceBoot: 1, lastErrorAt: recent } }), NOW);
    expect(vm.r2.severity).toBe('crit');
    expect(vm.overall).toBe('crit');
  });

  it('11) error between 1min and 5min → warn', () => {
    const mid = new Date(NOW.getTime() - 2 * 60_000);
    const vm = toSystemHealthVM(makeWire({ r2: { errorsSinceBoot: 1, lastErrorAt: mid } }), NOW);
    expect(vm.r2.severity).toBe('warn');
    expect(vm.overall).toBe('warn');
  });

  it('12) error older than 5min → ok (stale; alert noise)', () => {
    const old = new Date(NOW.getTime() - 10 * 60_000);
    const vm = toSystemHealthVM(makeWire({ r2: { errorsSinceBoot: 1, lastErrorAt: old } }), NOW);
    expect(vm.r2.severity).toBe('ok');
  });

  it('13) edge case: errorsSinceBoot > 0 but lastErrorAt=null → ok (no recency signal)', () => {
    const vm = toSystemHealthVM(makeWire({ r2: { errorsSinceBoot: 5, lastErrorAt: null } }), NOW);
    expect(vm.r2.severity).toBe('ok');
  });
});

describe('§provider-health — overall takes the worst across subsystems', () => {
  it('14) queue.ok + pool.warn + r2.crit → overall crit', () => {
    const vm = toSystemHealthVM(
      makeWire({
        appPool: { idle: 0, waiting: 0, total: 10 }, // warn
        r2: { errorsSinceBoot: 1, lastErrorAt: new Date(NOW.getTime() - 30_000) }, // crit
      }),
      NOW,
    );
    expect(vm.overall).toBe('crit');
  });

  it('15) all warn → overall warn', () => {
    const vm = toSystemHealthVM(
      makeWire({
        queue: { retry: 11 }, // warn
        appPool: { idle: 0, total: 5, waiting: 0 }, // warn
        r2: { errorsSinceBoot: 1, lastErrorAt: new Date(NOW.getTime() - 2 * 60_000) }, // warn
      }),
      NOW,
    );
    expect(vm.overall).toBe('warn');
  });
});

describe('§provider-health — passthrough fields', () => {
  it('16) raw queue numbers come through unmodified', () => {
    const vm = toSystemHealthVM(
      makeWire({ queue: { active: 7, created: 3, retry: 5, failed: 0, completed: 100 } }),
      NOW,
    );
    expect(vm.queue.active.value).toBe(7);
    expect(vm.queue.created.value).toBe(3);
    expect(vm.queue.retry.value).toBe(5);
    expect(vm.queue.failed.value).toBe(0);
    expect(vm.queue.completed.value).toBe(100);
  });

  it('17) timestamp is preserved', () => {
    const ts = new Date('2026-05-25T11:30:00Z');
    const vm = toSystemHealthVM(makeWire({ timestamp: ts }), NOW);
    expect(vm.timestamp).toEqual(ts);
  });
});
