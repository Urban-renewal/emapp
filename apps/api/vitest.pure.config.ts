import { defineConfig, mergeConfig } from 'vitest/config';

import rootConfig from '../../vitest.config';

/**
 * Pure-unit config: NO `globalSetup` (no DB migrate, no pool) and NO coverage
 * thresholds. For self-contained modules under `src/` that resolve purely
 * in-memory (no `pg`, no pool, no `withTenant`) — e.g. the authz engine's
 * layering logic exercised with stubbed fetches
 * (`common/authz/member-permission-overrides.spec.ts`). Run with:
 *   pnpm --filter @emapp/api exec vitest run --config vitest.pure.config.ts <spec>
 *
 * Mirrors packages/db/vitest.pure.config.ts.
 */
export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      include: ['src/**/*.spec.ts'],
      env: {
        SKIP_ENV_VALIDATION: 'true',
      },
      coverage: { enabled: false },
    },
  }),
);
