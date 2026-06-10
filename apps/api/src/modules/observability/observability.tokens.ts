/**
 * DI tokens for the P0.B2 observability seam.
 *
 * String tokens (not the classes) so every consumer depends on the
 * INTERFACE, never a concrete impl — the factory picks Noop (dev/test) vs
 * real (prod) and nothing downstream changes. Same pattern as `SMS_PROVIDER`
 * in auth (otp.service.ts).
 */
export const METRICS_PROVIDER = Symbol('METRICS_PROVIDER');
export const ALERT_SINK = Symbol('ALERT_SINK');
export const BREACH_DETECTION = Symbol('BREACH_DETECTION');
