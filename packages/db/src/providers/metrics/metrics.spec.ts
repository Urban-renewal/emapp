import { describe, expect, it } from 'vitest';

import { NoopMetricsProvider } from './noop.provider';
import { PrometheusMetricsProvider } from './prometheus.provider';

describe('NoopMetricsProvider', () => {
  it('is a silent no-op in test env and never throws', () => {
    const m = new NoopMetricsProvider({ verbose: false });
    expect(() => {
      m.counter('x_total');
      m.counter('x_total', 5, { a: 'b' });
      m.gauge('g', 1);
      m.timing('t', 12, { route: '/x' });
    }).not.toThrow();
  });
});

describe('PrometheusMetricsProvider', () => {
  it('accumulates counters per stable label signature (order-independent)', () => {
    const m = new PrometheusMetricsProvider();
    m.counter('http_requests_total', 1, { method: 'GET', route: '/x' });
    m.counter('http_requests_total', 1, { route: '/x', method: 'GET' }); // same series
    m.counter('http_requests_total', 1, { method: 'POST', route: '/x' }); // distinct

    const out = m.scrape();
    expect(out).toContain('http_requests_total{method="GET",route="/x"} 2');
    expect(out).toContain('http_requests_total{method="POST",route="/x"} 1');
  });

  it('renders a histogram with buckets, sum and count', () => {
    const m = new PrometheusMetricsProvider();
    m.timing('http_request_duration_ms', 12, { route: '/x' });
    m.timing('http_request_duration_ms', 300, { route: '/x' });

    const out = m.scrape();
    expect(out).toContain('http_request_duration_ms_count{route="/x"} 2');
    expect(out).toContain('http_request_duration_ms_sum{route="/x"} 312');
    expect(out).toContain('le="+Inf"');
  });

  it('gauge takes the latest value', () => {
    const m = new PrometheusMetricsProvider();
    m.gauge('process_uptime_seconds', 10);
    m.gauge('process_uptime_seconds', 42);
    expect(m.scrape()).toContain('process_uptime_seconds 42');
  });

  it('caps new series at MAX_SERIES (5000) without throwing — fail-safe', () => {
    const m = new PrometheusMetricsProvider();
    expect(() => {
      for (let i = 0; i < 5100; i += 1) m.counter('cap_test_total', 1, { i: String(i) });
    }).not.toThrow();
    const series = m
      .scrape()
      .split('\n')
      .filter((l) => l.startsWith('cap_test_total{'));
    expect(series.length).toBeLessThanOrEqual(5000); // new series dropped at the cap
    // a series created BEFORE the cap still accumulates afterwards (the cap blocks
    // only NEW series, never updates to series that already exist)
    m.counter('cap_test_total', 1, { i: '0' });
    expect(m.scrape()).toContain('cap_test_total{i="0"} 2');
  });
});
