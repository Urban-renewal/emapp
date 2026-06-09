import { defineConfig, mergeConfig } from 'vitest/config';

import rootConfig from '../../vitest.config';

// Pure-unit config: NO `globalSetup` (no DB migrate, no pool) and NO
// coverage thresholds. For self-contained helper modules under `src/`
// that import nothing impure (no `pg`, no pool) — e.g.
// `src/helpers/provider-validators.ts`. Run with:
//   pnpm --filter @emapp/db exec vitest run --config vitest.pure.config.ts <spec>
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
