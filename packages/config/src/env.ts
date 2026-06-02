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
    PII_ENCRYPTION_KEY: z.string().min(32).optional(),
    PII_HASH_KEY: z.string().min(32).optional(),
    /** DEV-ONLY auth bypass opt-in. When '1' AND NODE_ENV==='development',
     *  a fixed code ('000000') is accepted for tenant OTP + provider MFA so
     *  local testing doesn't need a phone/authenticator. Double-gated (the
     *  explicit flag is the real guard, since NODE_ENV defaults to
     *  'development'); a conformance spec asserts the fixed code is REJECTED
     *  whenever this is unset or NODE_ENV is not development. NEVER set in
     *  staging/production. */
    DEV_AUTH_BYPASS: z.string().optional(),
    PORT_API: z.coerce.number().default(3000),
    PORT_WEB: z.coerce.number().default(3001),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
