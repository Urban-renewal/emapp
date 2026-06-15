// Portable (win/posix) local-DB migrate wrapper.
//
// Routes through `infisical run` so PII_ENCRYPTION_KEY / PII_HASH_KEY reach the
// migrate runner (its assertPiiKeysPresent sentinel + the 0033 pgcrypto backfill
// REQUIRE them). It selects the LOCAL database TARGET (DB_TARGET=local) so the
// migrator resolves `LOCAL_DATABASE_URL` via `db-target.ts` — NOT Infisical's
// DATABASE_MIGRATE_URL (which points at Neon and would otherwise win, silently
// migrating the remote DB). DB_TARGET / LOCAL_DATABASE_URL are NOT Infisical
// secrets, so they pass through the injection untouched.
import { spawnSync } from 'node:child_process';

const LOCAL_DATABASE_URL =
  process.env.LOCAL_DATABASE_URL ?? 'postgresql://postgres:1234@localhost:5432/emapp?sslmode=disable';

const r = spawnSync(
  'infisical',
  ['run', '--env=dev', '--', 'pnpm', '--filter', '@emapp/db', 'db:migrate'],
  {
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      DB_TARGET: 'local',
      LOCAL_DATABASE_URL,
    },
  },
);
process.exit(r.status ?? 1);
