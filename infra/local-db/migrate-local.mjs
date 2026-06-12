// Portable (win/posix) local-DB migrate wrapper — sets DATABASE_URL for the
// child without needing cross-env at the workspace root.
import { spawnSync } from 'node:child_process';
const r = spawnSync('pnpm', ['--filter', '@emapp/db', 'db:migrate'], {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    DATABASE_URL: 'postgresql://emapp:emapp_local_dev@localhost:5433/emapp',
    SKIP_ENV_VALIDATION: 'true',
  },
});
process.exit(r.status ?? 1);
