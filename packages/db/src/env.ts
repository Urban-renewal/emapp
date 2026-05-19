import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

export const env = createEnv({
  skipValidation: !!process.env['SKIP_ENV_VALIDATION'] || process.env['NODE_ENV'] === 'test',
  server: {
    DATABASE_URL: z.string().url(),
    PROVIDER_DATABASE_URL: z.string().url().optional(),
    PII_ENCRYPTION_KEY: z.string().length(44),
    PII_HASH_KEY: z.string().length(44),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    // Connection-layer scale knobs — ops-tunable per environment WITHOUT
    // a code change (e.g. lower per-pod `max` behind the Neon transaction
    // pooler; tighter statement_timeout in prod). client.ts applies these
    // with the current production-safe constants as hard fallbacks (so
    // SKIP_ENV_VALIDATION / test still work — t3 returns raw env then).
    DB_POOL_MAX: z.coerce.number().int().positive().optional(),
    DB_POOL_IDLE_MS: z.coerce.number().int().positive().optional(),
    DB_POOL_CONN_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
    DB_PROVIDER_POOL_MAX: z.coerce.number().int().positive().optional(),
    DB_PROVIDER_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
