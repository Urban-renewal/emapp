import { describe, expect, it } from 'vitest';

import { NoopMetricsProvider } from '../metrics/noop.provider';

import { BreachDetectionService } from './breach-detection.service';
import { NoopAlertSink } from './noop.provider';

function makeService(now: () => number, thresholds = {}) {
  const sink = new NoopAlertSink({ verbose: false });
  const metrics = new NoopMetricsProvider({ verbose: false });
  const svc = new BreachDetectionService(sink, metrics, thresholds, now);
  return { sink, svc };
}

describe('BreachDetectionService', () => {
  it('does NOT alert below the failed-login threshold', () => {
    const { sink, svc } = makeService(() => 1000, { failedLoginBurst: 5, windowMs: 60_000 });
    for (let i = 0; i < 4; i += 1) svc.observeFailedLogin('org-1');
    expect(sink.events).toHaveLength(0);
  });

  it('fires exactly ONCE when the failed-login threshold is crossed in-window', () => {
    const { sink, svc } = makeService(() => 1000, { failedLoginBurst: 5, windowMs: 60_000 });
    for (let i = 0; i < 8; i += 1) svc.observeFailedLogin('org-1');
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.kind).toBe('auth.bruteforce_burst');
    expect(sink.events[0]?.severity).toBe('warning');
  });

  it('scopes counts per org — one noisy org does not trip another', () => {
    const { sink, svc } = makeService(() => 1000, { failedLoginBurst: 3, windowMs: 60_000 });
    svc.observeFailedLogin('org-1');
    svc.observeFailedLogin('org-1');
    svc.observeFailedLogin('org-2'); // different scope
    expect(sink.events).toHaveLength(0);
  });

  it('resets the window after windowMs and can fire again', () => {
    let t = 1000;
    const { sink, svc } = makeService(() => t, { failedLoginBurst: 3, windowMs: 1000 });
    for (let i = 0; i < 3; i += 1) svc.observeFailedLogin('org-1'); // fire #1
    t = 5000; // new window
    for (let i = 0; i < 3; i += 1) svc.observeFailedLogin('org-1'); // fire #2
    expect(sink.events).toHaveLength(2);
  });

  it('provider PII-access spike is CRITICAL', () => {
    const { sink, svc } = makeService(() => 1000, {
      providerPiiAccessSpike: 2,
      windowMs: 60_000,
    });
    svc.observeProviderPiiAccess('prov-1');
    svc.observeProviderPiiAccess('prov-1');
    expect(sink.events[0]?.severity).toBe('critical');
    expect(sink.events[0]?.kind).toBe('provider.pii_access_spike');
  });

  it('emitted payloads carry NO PII — only ids, counts, thresholds, window', () => {
    const { sink, svc } = makeService(() => 1000, { failedLoginBurst: 2, windowMs: 60_000 });
    svc.observeFailedLogin('org-uuid-1');
    svc.observeFailedLogin('org-uuid-1');
    const ev = sink.events[0];
    expect(ev).toBeDefined();
    // Allowed keys only.
    const keys = Object.keys(ev?.meta ?? {}).sort();
    expect(keys).toEqual(['count', 'orgId', 'threshold', 'window_seconds'].sort());
    // No PII-looking values anywhere in the serialized event.
    const blob = JSON.stringify(ev);
    expect(blob).not.toMatch(/@/); // no email
    expect(blob).not.toMatch(/\b0\d{8,9}\b/); // no IL phone
    expect(blob).not.toMatch(/national_id|phone|email|token|password/i);
  });

  it('a throwing alert sink never propagates (fail-safe)', () => {
    const throwing = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async alert(): Promise<void> {
        throw new Error('sink down');
      },
    };
    const metrics = new NoopMetricsProvider({ verbose: false });
    const svc = new BreachDetectionService(throwing, metrics, {
      failedLoginBurst: 1,
      windowMs: 60_000,
    });
    expect(() => svc.observeFailedLogin('org-1')).not.toThrow();
  });
});
