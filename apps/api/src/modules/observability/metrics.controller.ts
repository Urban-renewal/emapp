import { type IMetricsProvider, PrometheusMetricsProvider } from '@emapp/db';
import { Controller, Get, Header, Inject } from '@nestjs/common';

import { METRICS_PROVIDER } from './observability.tokens';

/**
 * `/api/v1/metrics` — Prometheus scrape endpoint (P0.B2).
 *
 * Only exposes a body when the configured metrics backend is the
 * Prometheus registry (prod). Under the Noop provider (dev/test) it returns
 * an empty body, so the endpoint exists everywhere but reveals nothing in
 * dev. The registry contents are aggregate counts only — NO PII (the metric
 * contract forbids PII labels) — so this is safe to expose to the scrape
 * target. Network-level access to `/metrics` is restricted at the Railway /
 * ingress layer (scrape target allow-list), the standard posture; documented
 * here so a reviewer doesn't expect app-layer auth on a metrics endpoint.
 */
@Controller()
export class MetricsController {
  constructor(@Inject(METRICS_PROVIDER) private readonly metrics: IMetricsProvider) {}

  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): string {
    if (this.metrics instanceof PrometheusMetricsProvider) {
      return this.metrics.scrape();
    }
    // Noop backend (dev/test) — nothing to expose.
    return '';
  }
}
