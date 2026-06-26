import { serverEnv } from '@emapp/config';

import { computeDevAuthBypass, DEV_FIXED_AUTH_CODE } from './dev-auth-bypass.gate';

export { DEV_FIXED_AUTH_CODE } from './dev-auth-bypass.gate';

/**
 * DEV-ONLY auth bypass — see `dev-auth-bypass.gate.ts` for the (pure, tested)
 * gate. A fixed code is accepted for tenant OTP + provider MFA so local dev
 * doesn't need a phone / authenticator. Double-gated; impossible in prod.
 */
export function isDevAuthBypass(): boolean {
  // FAIL-CLOSED: read the RAW `process.env.NODE_ENV`, NOT `serverEnv.NODE_ENV`.
  // serverEnv `.default('development')`, so an UNSET NODE_ENV resolves to
  // 'development' there — which would OPEN this auth bypass in a deployed env
  // that merely forgot to set NODE_ENV while DEV_AUTH_BYPASS leaked on (the exact
  // misconfig the boot guard exists to catch). The pure gate already fail-closes
  // on `undefined` (computeDevAuthBypass(undefined,'1') === false); handing it the
  // undefaulted raw value is what makes that protection actually take effect, and
  // keeps this gate consistent with the raw-`process.env` checks the dev outbox
  // module-registration + email factory already use.
  return computeDevAuthBypass(process.env['NODE_ENV'], serverEnv.DEV_AUTH_BYPASS);
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
  // Fail-fast on a LOUD boot crash rather than run with a dormant-but-armed auth
  // bypass. The flag is set, so the env MUST be an explicit dev/test — anything
  // else (production, a typo, OR an UNSET NODE_ENV that would silently default to
  // 'development') means the bypass leaked into a deployed environment. Uses the
  // RAW NODE_ENV (unset counts as "not dev"), matching `isDevAuthBypass`.
  const rawNodeEnv = process.env['NODE_ENV'];
  if (serverEnv.DEV_AUTH_BYPASS === '1' && rawNodeEnv !== 'development' && rawNodeEnv !== 'test') {
    throw new Error(
      `DEV_AUTH_BYPASS=1 requires an explicit NODE_ENV=development (or test); got ` +
        `NODE_ENV=${rawNodeEnv ?? '<unset>'} — refusing to start. This dev-only auth ` +
        `bypass must never be armed in a deployed environment. Unset DEV_AUTH_BYPASS, ` +
        `or set NODE_ENV=development for local dev.`,
    );
  }
}
