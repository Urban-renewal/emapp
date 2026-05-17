import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

export const serverEnv = createEnv({
  skipValidation: !!process.env['SKIP_ENV_VALIDATION'],
  server: {
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    DATABASE_URL: z.string().url(),
    DATABASE_URL_PROVIDER: z.string().url(),
    S3_ENDPOINT: z.string().url(),
    S3_REGION: z.string().default('auto'),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_BUCKET: z.string().min(1),
    RESEND_API_KEY: z.string().min(1),
    SENTRY_DSN_API: z.string().url().optional(),
    BETTER_AUTH_SECRET: z.string().min(32).optional(),
    PII_ENCRYPTION_KEY: z.string().min(32).optional(),
    PII_HASH_KEY: z.string().min(32).optional(),
    PORT_API: z.coerce.number().default(3000),
    PORT_WEB: z.coerce.number().default(3001),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
