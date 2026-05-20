import { defineConfig, mergeConfig } from 'vitest/config';

import rootConfig from '../../vitest.config';

/**
 * Worker test config — mirrors @emapp/db's setup so integration tests
 * (T6.8 — ImportJobHandler against the real DB) can rely on the same
 * once-per-run migration step. The handler depends on the real schema
 * (import_jobs CHECK constraint, RLS policies, audit_log triggers),
 * so a real Postgres is required; pure mocks would not exercise the
 * D.21 / D.07 invariants the audit-pass requires.
 *
 * The global-setup is shared with packages/db (same pool, same migrate
 * step). Running it twice across packages is safe — drizzle's migrator
 * is idempotent and the `meta/_journal.json` tracks applied state.
 */
export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      include: ['test/**/*.spec.ts'],
      env: {
        SKIP_ENV_VALIDATION: 'true',
      },
      // Re-use the db package's globalSetup. Resolved relative to this
      // file; vitest passes the absolute path through to the runner.
      globalSetup: ['../../packages/db/test/global-setup.ts'],
      // Integration specs against remote Neon traverse 4-6 withTenant
      // round-trips per test (state machine × audit writes). Each tx is
      // ~600ms over the pooled connection. Default 5s timeout is below
      // the realistic upper bound; 30s gives headroom without masking
      // a real regression (a stuck test fails fast vs. an integration
      // test occasionally needing 15s).
      testTimeout: 30_000,
    },
  }),
);
