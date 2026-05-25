import { defineConfig, devices } from '@playwright/test';

/**
 * Phase 4a S11 — Playwright E2E config.
 *
 * Mode: MSW-backed (no live BE required). `webServer` boots the
 * Next.js dev server with `NEXT_PUBLIC_MSW=1`; the wired-up MswInit
 * provider (apps/web/src/mocks/msw-init.tsx) installs the worker on
 * first paint so every `/api/v1/*` call is intercepted.
 *
 * Why dev-mode (not `next start`):
 *  - Service-Worker registration is the same in dev + prod, so the
 *    MSW interception path is identical.
 *  - Dev avoids the `pnpm build` cost in CI and keeps the test
 *    surface focused on UI behavior (not bundler output).
 *
 * Why Chromium only:
 *  - MVP target is desktop Hebrew RTL; we test one engine on one
 *    viewport. Mobile / WebKit can come later once the responsive
 *    polish slice lands.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: 1,
  reporter: process.env['CI'] ? 'github' : 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    baseURL: 'http://localhost:3001',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Dev server WITHOUT MSW — we stub /api/v1/* per-test via
    // Playwright's `page.route()`. The MSW service worker added a
    // first-paint timing race (SW registration vs first fetch) that
    // is unnecessary when Playwright is itself the interceptor.
    // MSW remains wired into the app for `pnpm dev` offline-mode
    // (NEXT_PUBLIC_MSW=1), just not for E2E.
    command: 'pnpm dev',
    cwd: '.',
    url: 'http://localhost:3001',
    env: {
      NODE_ENV: 'development',
    },
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
