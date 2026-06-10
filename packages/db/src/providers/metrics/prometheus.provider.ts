import type { IMetricsProvider, MetricLabels } from './metrics.interface';

/**
 * Production metrics provider — an in-memory Prometheus-text registry.
 *
 * ⚠️ VERIFY-BEFORE-GO-LIVE (same posture as `InforuSmsProvider`): this is a
 * dependency-free, self-contained registry that already produces a valid
 * Prometheus exposition body via {@link scrape}. It is correct for a single
 * process. BEFORE relying on it as the production telemetry backbone, decide
 * the real topology and either keep this (scraped by Prometheus/Grafana
 * Agent on Railway) OR swap the concrete class for a `prom-client` registry
 * / an OTel `MeterProvider` exporter — the {@link IMetricsProvider} seam and
 * every call-site stay identical; only this file changes. Multi-replica
 * aggregation (Railway can run >1 instance) is a scrape-target concern, not a
 * code concern: each replica exposes its own `/metrics` and Prometheus sums.
 *
 * Implementation notes:
 *   - Counters and gauges are keyed by `name` + a STABLE-SORTED label
 *     signature, so `{method:"GET",route:"/x"}` and `{route:"/x",method:"GET"}`
 *     collapse to one series.
 *   - `timing` keeps a fixed-bucket histogram (`_bucket`/`_sum`/`_count`),
 *     the standard Prometheus latency shape.
 *   - Every public method is wrapped fail-open: a registry bug must never
 *     throw into a request path (metrics are observability, not behaviour).
 *   - Cardinality guard: a hard cap on distinct series. If a buggy call-site
 *     ever passes a high-cardinality label (a UUID, a timestamp), we stop
 *     creating new series rather than leak memory / re-identify a subject.
 */

const DEFAULT_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000] as const;
const MAX_SERIES = 5000;

interface HistogramState {
  buckets: number[]; // cumulative counts aligned to DEFAULT_BUCKETS_MS
  sum: number;
  count: number;
}

function labelSignature(labels?: MetricLabels): string {
  if (!labels) return '';
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}=${labels[k]}`).join(',');
}

function renderLabels(labels: MetricLabels | undefined, extra?: Record<string, string>): string {
  const merged: Record<string, string> = { ...(labels ?? {}), ...(extra ?? {}) };
  const keys = Object.keys(merged).sort();
  if (keys.length === 0) return '';
  const body = keys
    .map((k) => `${k}="${String(merged[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(',');
  return `{${body}}`;
}

export class PrometheusMetricsProvider implements IMetricsProvider {
  private readonly counters = new Map<string, { labels?: MetricLabels; value: number }>();
  private readonly gauges = new Map<string, { labels?: MetricLabels; value: number }>();
  private readonly histograms = new Map<string, { labels?: MetricLabels; state: HistogramState }>();

  private atSeriesCap(): boolean {
    return this.counters.size + this.gauges.size + this.histograms.size >= MAX_SERIES;
  }

  counter(name: string, value = 1, labels?: MetricLabels): void {
    try {
      const key = `${name}#${labelSignature(labels)}`;
      const existing = this.counters.get(key);
      if (existing) {
        existing.value += value;
      } else if (!this.atSeriesCap()) {
        this.counters.set(key, { labels, value });
      }
    } catch {
      /* fail-open */
    }
  }

  gauge(name: string, value: number, labels?: MetricLabels): void {
    try {
      const key = `${name}#${labelSignature(labels)}`;
      const existing = this.gauges.get(key);
      if (existing) {
        existing.value = value;
      } else if (!this.atSeriesCap()) {
        this.gauges.set(key, { labels, value });
      }
    } catch {
      /* fail-open */
    }
  }

  timing(name: string, valueMs: number, labels?: MetricLabels): void {
    try {
      const key = `${name}#${labelSignature(labels)}`;
      let entry = this.histograms.get(key);
      if (!entry) {
        if (this.atSeriesCap()) return;
        entry = {
          labels,
          state: { buckets: new Array(DEFAULT_BUCKETS_MS.length).fill(0), sum: 0, count: 0 },
        };
        this.histograms.set(key, entry);
      }
      entry.state.sum += valueMs;
      entry.state.count += 1;
      DEFAULT_BUCKETS_MS.forEach((upper, i) => {
        if (valueMs <= upper) entry!.state.buckets[i] = (entry!.state.buckets[i] ?? 0) + 1;
      });
    } catch {
      /* fail-open */
    }
  }

  /**
   * Render the current registry as a Prometheus exposition (text/plain;
   * version=0.0.4) body. The `/metrics` controller returns this verbatim.
   */
  scrape(): string {
    const lines: string[] = [];

    for (const [key, c] of this.counters) {
      const name = key.slice(0, key.indexOf('#'));
      lines.push(`${name}${renderLabels(c.labels)} ${c.value}`);
    }
    for (const [key, g] of this.gauges) {
      const name = key.slice(0, key.indexOf('#'));
      lines.push(`${name}${renderLabels(g.labels)} ${g.value}`);
    }
    for (const [key, h] of this.histograms) {
      const name = key.slice(0, key.indexOf('#'));
      DEFAULT_BUCKETS_MS.forEach((upper, i) => {
        const cumulative = h.state.buckets[i] ?? 0;
        lines.push(`${name}_bucket${renderLabels(h.labels, { le: String(upper) })} ${cumulative}`);
      });
      lines.push(`${name}_bucket${renderLabels(h.labels, { le: '+Inf' })} ${h.state.count}`);
      lines.push(`${name}_sum${renderLabels(h.labels)} ${h.state.sum}`);
      lines.push(`${name}_count${renderLabels(h.labels)} ${h.state.count}`);
    }

    return lines.join('\n') + (lines.length > 0 ? '\n' : '');
  }
}
