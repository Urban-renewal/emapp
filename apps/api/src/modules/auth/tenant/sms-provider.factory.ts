import { InforuSmsProvider, NoopSMSProvider, type ISMSProvider } from '@emapp/db';

/**
 * SMS provider selection (D.20) — mirrors `emailProviderFactory` (members/
 * invite-email.ts). Tenant OTP login and signature-link SMS are UNDELIVERABLE
 * with `NoopSMSProvider`, so:
 *
 *   - If real credentials are present (`SMS_PROVIDER_USER` + `_TOKEN` +
 *     `_SENDER`) → use the real Israeli gateway (Inforu), in ANY env. This is
 *     the single config-swap point: provision the creds in Infisical (Gate-4
 *     SECRETS LAW) and confirm the API shape in `inforu.provider.ts`.
 *   - Else in PRODUCTION → FAIL FAST at boot. A prod deploy must never silently
 *     no-op OTP/signature SMS (that would lock every resident out and make
 *     phone-only owners un-reachable for signatures).
 *   - Else (dev / test / unset) → `NoopSMSProvider` (logs, sends nothing).
 *
 * The token name `SMS_PROVIDER` stays the DI seam (otp.service.ts); only the
 * concrete class changes here.
 */
export function smsProviderFactory(): ISMSProvider {
  const user = process.env['SMS_PROVIDER_USER'];
  const token = process.env['SMS_PROVIDER_TOKEN'];
  const sender = process.env['SMS_PROVIDER_SENDER'];
  const apiUrl = process.env['SMS_PROVIDER_API_URL'] ?? 'https://capi.inforu.co.il';

  if (user && token && sender) {
    return new InforuSmsProvider({ apiUrl, user, token, sender });
  }

  // FAIL-CLOSED (red-team #14) — NoopSMSProvider is dev/test ONLY. Production, an
  // UNSET NODE_ENV (a deployed image that forgot `ENV NODE_ENV=production`), or a
  // typo'd value must NOT silently no-op OTP/signature SMS — that would lock every
  // resident out and make phone-only owners un-reachable. Only an EXPLICIT
  // development/test env gets Noop; everything else fails fast at boot. Mirrors the
  // step-up allowlist + the dev-auth-bypass raw-NODE_ENV fail-closed pattern.
  const rawNodeEnv = process.env['NODE_ENV'];
  if (rawNodeEnv !== 'development' && rawNodeEnv !== 'test') {
    throw new Error(
      `SMS_PROVIDER: refusing to boot — no real SMS provider configured and NODE_ENV is ` +
        `"${rawNodeEnv ?? '(unset)'}" (not development/test). NoopSMSProvider would make ` +
        'Tenant OTP login AND signature-link SMS silently undeliverable. Provision ' +
        'SMS_PROVIDER_USER / SMS_PROVIDER_TOKEN / SMS_PROVIDER_SENDER in Infisical (D.20), ' +
        'or set NODE_ENV=development for local dev. See DECISIONS D.20.',
    );
  }

  return new NoopSMSProvider();
}
