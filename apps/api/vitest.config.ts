import { fileURLToPath } from 'node:url';

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
    resolve: {
      alias: [
        // P3b — packages/db/scripts/* are workspace SCRIPTS (not exported via
        // the @emapp/db barrel). The parcel-data-provider spec reaches the
        // loader via a deep RELATIVE dynamic import; on Windows vite-node
        // resolves runtime-dynamic relative specifiers against the
        // ROOT-relative module id (walks past '/'), so the specifier never
        // reaches the real file. Pin the exact specifier to the absolute
        // file instead (no wildcard — exactly this one script).
        {
          // The runner URL-joins the relative specifier against the
          // ROOT-relative importer id first, clamping at '/', so the id that
          // reaches the resolver is exactly '/packages/db/scripts/…'.
          find: /^(?:(?:\.\.\/)+|\/)packages\/db\/scripts\/load-parcel-lookup(?:\.ts)?$/,
          replacement: fileURLToPath(
            new URL('../../packages/db/scripts/load-parcel-lookup.ts', import.meta.url),
          ),
        },
      ],
    },
    test: {
      include: ['src/**/*.spec.ts'],
      env: {
        SKIP_ENV_VALIDATION: 'true',
      },
      globalSetup: ['../../packages/db/test/global-setup.ts'],
    },
  }),
);
