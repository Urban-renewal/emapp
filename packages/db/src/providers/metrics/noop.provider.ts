import type { IMetricsProvider, MetricLabels } from './metrics.interface';

/**
 * Dev/test metrics sink — records nothing to a backend.
 *
 * In `test` it is a pure no-op (silent, so the suite output stays clean).
 * In `development` it writes a single terse line to stderr per sample so a
 * developer can SEE that a metric fired at a seam without standing up a
 * Prometheus/OTel stack — the same "visible but inert" posture as
 * `NoopSMSProvider`. Never throws (fail-open guarantee).
 */
export class NoopMetricsProvider implements IMetricsProvider {
  private readonly verbose: boolean;

  constructor(opts?: { verbose?: boolean }) {
    // Default: quiet under NODE_ENV=test, one-liner otherwise.
    this.verbose = opts?.verbose ?? process.env['NODE_ENV'] !== 'test';
  }

  private emit(kind: string, name: string, value: number, labels?: MetricLabels): void {
    if (!this.verbose) return;
    try {
      const l = labels && Object.keys(labels).length > 0 ? ` ${JSON.stringify(labels)}` : '';
      process.stderr.write(`[NoopMetrics] ${kind} ${name}=${value}${l}\n`);
    } catch {
      // fail-open: a logging hiccup must never propagate into the caller.
    }
  }

  counter(name: string, value = 1, labels?: MetricLabels): void {
    this.emit('counter', name, value, labels);
  }

  gauge(name: string, value: number, labels?: MetricLabels): void {
    this.emit('gauge', name, value, labels);
  }

  timing(name: string, valueMs: number, labels?: MetricLabels): void {
    this.emit('timing', name, valueMs, labels);
  }
}
