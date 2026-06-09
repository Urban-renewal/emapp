import { BreachDetectionService, type IAlertSink, type IMetricsProvider } from '@emapp/db';
import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { MetricsController } from './metrics.controller';
import { MetricsInterceptor } from './metrics.interceptor';
import {
  alertSinkFactory,
  breachDetectionFactory,
  metricsProviderFactory,
} from './observability.factory';
import { ALERT_SINK, BREACH_DETECTION, METRICS_PROVIDER } from './observability.tokens';

/**
 * P0.B2 — pluggable observability + breach-detection seam.
 *
 * `@Global` so any module (auth, provider, …) can inject the metrics
 * provider / breach detector by token WITHOUT importing this module
 * explicitly — same convenience as a shared infra module, and it keeps the
 * per-call-site change to a single constructor param.
 *
 * Everything is interface-behind-a-token + factory-selected (Noop in
 * dev/test, real in prod), mirroring `AuthModule`'s `SMS_PROVIDER` wiring.
 * `MetricsInterceptor` is registered globally so request count/latency is
 * captured for every route with no per-controller change.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    { provide: METRICS_PROVIDER, useFactory: metricsProviderFactory },
    { provide: ALERT_SINK, useFactory: alertSinkFactory },
    {
      provide: BREACH_DETECTION,
      useFactory: (alerts: IAlertSink, metrics: IMetricsProvider): BreachDetectionService =>
        breachDetectionFactory(alerts, metrics),
      inject: [ALERT_SINK, METRICS_PROVIDER],
    },
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
  exports: [METRICS_PROVIDER, ALERT_SINK, BREACH_DETECTION],
})
export class ObservabilityModule {}
