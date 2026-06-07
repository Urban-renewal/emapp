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

  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(
      'SMS_PROVIDER: refusing to boot — production requires a real SMS provider ' +
        '(D.20). NoopSMSProvider would make Tenant OTP login AND signature-link ' +
        'SMS silently undeliverable. Provision SMS_PROVIDER_USER / SMS_PROVIDER_TOKEN ' +
        '/ SMS_PROVIDER_SENDER in Infisical and confirm the Inforu (or 019) API shape ' +
        'in inforu.provider.ts before deploying. See DECISIONS D.20.',
    );
  }

  return new NoopSMSProvider();
}
