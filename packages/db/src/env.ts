import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

export const env = createEnv({
  skipValidation: !!process.env['SKIP_ENV_VALIDATION'],
  server: {
    DATABASE_URL: z.string().url(),
    PROVIDER_DATABASE_URL: z.string().url().optional(),
    PII_ENCRYPTION_KEY: z.string().length(44),
    PII_HASH_KEY: z.string().length(44),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
