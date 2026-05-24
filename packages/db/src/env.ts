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

    // Cloudflare R2 storage (D.28 / Gate-5). All four are optional at
    // the schema level — when ALL FOUR are present, the storage
    // factories construct an R2StorageProvider. When ANY is missing:
    //   - dev/test  → FakeStorageProvider (in-memory)
    //   - production → factory throws (FAIL FAST — same posture as the
    //     pre-R2 era; prevents accidentally booting prod with no
    //     real storage).
    // This shape lets dev opt-in to real R2 (paste the 4 vars in
    // Infisical's dev env) WITHOUT forcing every dev to set them up.
    R2_ACCESS_KEY_ID: z.string().min(1).optional(),
    R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    R2_BUCKET: z.string().min(1).optional(),
    R2_ENDPOINT: z.string().url().optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
