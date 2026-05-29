import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect, USERS, loginAs } from './_helpers';

/**
 * Runs first (filename 00-). Logs in each dev role ONCE through the real
 * form and persists the httpOnly-cookie storageState to disk so every
 * later audit spec can reuse it via test.use({ storageState }) WITHOUT
 * re-hitting the 10/60s login rate-limit.
 */
const AUTH_DIR = join(__dirname, '.auth');

test.describe.configure({ mode: 'serial' });

for (const [key, user] of Object.entries(USERS)) {
  test(`auth-setup: ${key} (${user.role})`, async ({ page, context }) => {
    mkdirSync(AUTH_DIR, { recursive: true });
    await loginAs(page, user);
    // Confirm we actually landed authenticated (not bounced to login).
    expect(page.url()).not.toContain('/login');
    await context.storageState({ path: join(AUTH_DIR, `${key}.json`) });
  });
}
