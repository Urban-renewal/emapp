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
/**
 * §Phase-E — wave 1 infra additions:
 *
 *  1. `globalSetup` / `globalTeardown` — start/stop a Node-side mock
 *     backend (apps/web/e2e/mock-backend.ts). It listens on
 *     127.0.0.1:9999 and serves the server-side proxy traffic that
 *     Playwright's `page.route()` cannot intercept (the dashboard
 *     layout's getMe() call goes Server Component → Next proxy →
 *     this mock). Without it any post-auth journey would
 *     redirect-loop in SSR.
 *
 *  2. `webServer.env.API_BACKEND_URL` — pin the upstream the proxy
 *     calls to the mock backend. `global-setup.ts` also writes this
 *     to process.env so subprocess inheritance is bullet-proof.
 *
 *  3. `webServer.command` — `infisical run --env=dev -- pnpm dev`.
 *     Without Infisical-loaded secrets the Next dev server's Sentry
 *     instrumentation hook hangs every HTTP request (observed
 *     2026-05-25). Infisical's dev env carries the minimal secrets
 *     needed for the dev server to actually respond.
 *
 *  4. `reporter: 'list'` always — the 'github' reporter buffers all
 *     output until the run completes, which makes long-running CI
 *     hangs invisible. 'list' gives streaming feedback.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: 1,
  reporter: process.env['CI']
    ? [
        ['list'],
        ['github'],
      ]
    : 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
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
    // §Phase-E — Infisical-loaded dev server. Without `infisical run`
    // the dev server hangs every HTTP request mid-flight (the Sentry
    // instrumentation hook never resolves). API_BACKEND_URL is
    // overridden in `env` below to point at the mock backend started
    // by global-setup; Infisical's dev value (if any) is preempted
    // by the explicit env entry here.
    command: 'infisical run --env=dev -- pnpm dev',
    cwd: '.',
    url: 'http://localhost:3001/he/signup',
    env: {
      NODE_ENV: 'development',
      // §E2E — server-side proxy upstream points at the mock backend
      // started by ./e2e/global-setup.ts. The mock listens on 9999
      // by default; override via E2E_MOCK_BACKEND_PORT.
      API_BACKEND_URL: `http://127.0.0.1:${process.env['E2E_MOCK_BACKEND_PORT'] ?? '9999'}`,
    },
    reuseExistingServer: !process.env['CI'],
    timeout: 180_000,
  },
});
