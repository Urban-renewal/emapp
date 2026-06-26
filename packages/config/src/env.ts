import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

export const serverEnv = createEnv({
  skipValidation: !!process.env['SKIP_ENV_VALIDATION'],
  server: {
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    DATABASE_URL: z.string().url(),
    DATABASE_URL_PROVIDER: z.string().url().optional(),
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().default('auto'),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_BUCKET: z.string().min(1).optional(),
    RESEND_API_KEY: z.string().min(1).optional(),
    SENTRY_DSN_API: z.string().url().optional(),
    BETTER_AUTH_SECRET: z.string().min(32),
    JWT_SECRET: z.string().min(44),
    /** Phase 5 (docs/03 §9): a JWT secret SEPARATE from JWT_SECRET, used
     *  ONLY for signature-link tokens (7-day TTL, single-use, public-link
     *  signing flow). The spec explicitly mandates separation: a leak of
     *  one secret must not compromise the other (different threat models,
     *  different blast radii). Optional in schema so non-Phase-5 envs
     *  still boot; the SignatureTokenService throws at construction if
     *  unset — same governed pattern as RESEND_API_KEY. */
    SIGNATURE_TOKEN_SECRET: z.string().min(44).optional(),
    /** FL-1 / X-S1 (V13) — a JWT secret SEPARATE from JWT_SECRET, used ONLY
     *  for external-share access tokens (the contractor / external-party read
     *  credential, audience `emapp-share`). The council split this off so a
     *  leak of the org-session secret (`JWT_SECRET`) does NOT compromise the
     *  long-lived share credentials (30-day TTL, cross-party access), and vice
     *  versa — different threat models, different blast radii.
     *
     *  Optional in schema with a DEV FALLBACK in `ShareTokenService` (it falls
     *  back to JWT_SECRET when unset) so CI / non-configured envs still boot and
     *  stay green. The PRODUCTION value is an OWNER-DEPLOY step (Infisical
     *  staging+prod) — until set, share tokens are signed with JWT_SECRET via
     *  the fallback, acceptable ONLY as a pre-deploy bridge; the dual-verify
     *  grace window then accepts both. Generate with:
     *    node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
     *  Tracked in docs/MASTER-PLAN-V13.md → "prod ... SHARE_TOKEN_SECRET deploy
     *  values" (owner-deploy-gated). */
    SHARE_TOKEN_SECRET: z.string().min(44).optional(),
    PII_ENCRYPTION_KEY: z.string().min(32).optional(),
    PII_HASH_KEY: z.string().min(32).optional(),
    /** DEV-ONLY auth bypass opt-in. When '1' AND the RAW (undefaulted)
     *  `process.env.NODE_ENV` is EXACTLY 'development' (or 'test'), a fixed code
     *  ('000000') is accepted for tenant OTP + provider MFA so local testing
     *  doesn't need a phone/authenticator. FAIL-CLOSED: `isDevAuthBypass` reads
     *  the RAW NODE_ENV — an UNSET NODE_ENV does NOT enable it. (An earlier
     *  version trusted serverEnv's 'development' default, which would have armed
     *  the bypass in a deploy that set this flag but forgot NODE_ENV — closed in
     *  dev-auth-bypass.ts.) `assertDevBypassNotInProduction` REFUSES to boot when
     *  this is '1' and NODE_ENV isn't explicitly development/test. A conformance
     *  spec asserts the fixed code is REJECTED whenever this is unset or NODE_ENV
     *  is not development. NEVER set in staging/production; local dev MUST set
     *  NODE_ENV=development. */
    DEV_AUTH_BYPASS: z.string().optional(),
    /** Public self-service signup gate (owner-approved, refines D.21). The
     *  active B2B onboarding path is provider-led (`POST /provider/tenants`
     *  → invite first manager → `/auth/accept-invite`), so `POST /auth/signup`
     *  is INACTIVE by default: when this is anything other than '1' the route
     *  behaves as if it does not exist (404, before any work). Set to '1' to
     *  restore the original self-service signup behavior. The signup route +
     *  service + DTO + D.21 `withBootstrap` are all RETAINED, just unreachable
     *  while this is off. See docs/decision-records/disable-public-signup.md. */
    PUBLIC_SIGNUP_ENABLED: z.string().default('0'),
    /** Global campaign-send kill-switch (E2 Wave-0 N15). OPT-OUT: campaign
     *  fan-out is ENABLED by default; set to '0' or 'false' to disable the
     *  project-wide signature-campaign send (operational lever, no redeploy). */
    CAMPAIGN_SEND_ENABLED: z.string().default('1'),
    PORT_API: z.coerce.number().default(3000),
    PORT_WEB: z.coerce.number().default(3001),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
