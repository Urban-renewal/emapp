import { serverEnv } from '@emapp/config';

import { computeDevAuthBypass, DEV_FIXED_AUTH_CODE } from './dev-auth-bypass.gate';

export { DEV_FIXED_AUTH_CODE } from './dev-auth-bypass.gate';

/**
 * DEV-ONLY auth bypass — see `dev-auth-bypass.gate.ts` for the (pure, tested)
 * gate. A fixed code is accepted for tenant OTP + provider MFA so local dev
 * doesn't need a phone / authenticator. Double-gated; impossible in prod.
 */
export function isDevAuthBypass(): boolean {
  return computeDevAuthBypass(serverEnv.NODE_ENV, serverEnv.DEV_AUTH_BYPASS);
}

/** True iff the bypass is active AND the presented code is the fixed dev code. */
export function isDevBypassCode(code: string): boolean {
  return isDevAuthBypass() && code === DEV_FIXED_AUTH_CODE;
}

/**
 * Fail-fast boot guard (defense-in-depth beyond the code-level gate). The gate
 * is already prod-impossible, but this turns a future env MISconfiguration
 * (someone sets DEV_AUTH_BYPASS=1 in production) from a silent dormant flag
 * into a LOUD boot crash. Call once at bootstrap.
 */
export function assertDevBypassNotInProduction(): void {
  if (serverEnv.NODE_ENV === 'production' && serverEnv.DEV_AUTH_BYPASS === '1') {
    throw new Error(
      'DEV_AUTH_BYPASS=1 is set with NODE_ENV=production — refusing to start. ' +
        'This dev-only auth bypass must never be enabled in a deployed environment.',
    );
  }
}
