import { defineConfig, mergeConfig } from 'vitest/config';

import rootConfig from '../../vitest.config';

/**
 * API test config.
 *
 * `globalSetup` mirrors @emapp/db's once-per-run migration step so api
 * specs that use `withTenant` directly (Phase 6 S2 imports-stream
 * spec — T6.9) start against a migrated schema. The setup file is
 * shared with the db package; migrate() is idempotent (drizzle journal
 * tracks applied state) so running it from multiple packages is safe.
 *
 * Black-box contract specs (auth.contract.spec.ts, documents.contract
 * .spec.ts, …) skip automatically when the live API URL is unreachable,
 * so they're unaffected by the added setup.
 */
export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      include: ['src/**/*.spec.ts'],
      env: {
        SKIP_ENV_VALIDATION: 'true',
      },
      globalSetup: ['../../packages/db/test/global-setup.ts'],
    },
  }),
);
