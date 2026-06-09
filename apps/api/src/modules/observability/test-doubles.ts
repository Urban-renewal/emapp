import { BreachDetectionService, NoopAlertSink, NoopMetricsProvider } from '@emapp/db';

/**
 * Test doubles for the P0.B2 observability seam.
 *
 * `AuthService` (and a few other services) take an `IMetricsProvider` + a
 * `BreachDetectionService` in their constructor. Unit tests that `new` the
 * service directly use these silent Noop-backed doubles so they don't have to
 * stand up the DI module. Kept in one place so a future constructor change is
 * a single edit, not a sweep across every auth spec.
 */
export function noopMetricsForTest(): NoopMetricsProvider {
  return new NoopMetricsProvider({ verbose: false });
}

export function noopBreachForTest(): BreachDetectionService {
  return new BreachDetectionService(
    new NoopAlertSink({ verbose: false }),
    new NoopMetricsProvider({ verbose: false }),
  );
}
