import { defineConfig, mergeConfig } from 'vitest/config';

import rootConfig from '../../vitest.config';

export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
      env: {
        SKIP_ENV_VALIDATION: 'true',
      },
      // Run migrations ONCE before any worker (was per-suite in parallel
      // workers → concurrent-DDL race that flaked CI on every new migration).
      globalSetup: ['./test/global-setup.ts'],
    },
  }),
);
