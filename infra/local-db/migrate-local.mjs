// Portable (win/posix) local-DB migrate wrapper.
// Routes through `infisical run` so PII_ENCRYPTION_KEY / PII_HASH_KEY reach the
// migrate runner (its assertPiiKeysPresent sentinel + the 0033 pgcrypto backfill
// REQUIRE them) — only DATABASE_URL is overridden to the local container.
import { spawnSync } from 'node:child_process';
const r = spawnSync(
  'infisical',
  ['run', '--env=dev', '--', 'pnpm', '--filter', '@emapp/db', 'db:migrate'],
  {
    stdio: 'inherit',
    shell: true,
    env: {
      ...process.env,
      DATABASE_URL: 'postgresql://emapp@localhost:5433/emapp',
    },
  },
);
process.exit(r.status ?? 1);
