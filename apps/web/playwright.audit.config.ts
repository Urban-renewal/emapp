import { defineConfig, devices } from '@playwright/test';

/**
 * LAYERED PRODUCT STATE AUDIT — independent Playwright config.
 *
 * UNLIKE `playwright.config.ts` (MSW-backed, boots its own dev server and
 * intercepts every /api/v1/* with fixtures), this config drives the REAL
 * running stack:
 *   - web:  http://localhost:3001  (next dev, real)
 *   - api:  http://localhost:3000  (NestJS, real Neon DB, real auth)
 *
 * Prerequisite: `infisical run --env=dev -- pnpm dev` already running.
 * This config does NOT start a webServer and does NOT run globalSetup/
 * mock-backend — every request hits the genuine backend so findings are
 * artifacts of the real product, not of mocks.
 */
export default defineConfig({
  testDir: './e2e/audit',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'e2e/audit/.report.json' }]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: '../../docs/audit/artifacts/_pw',
  use: {
    baseURL: 'http://localhost:3001',
    // Low-footprint: the coverage specs take their own explicit screenshots;
    // auto trace/video/screenshot filled the disk (ENOSPC) across re-runs.
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    actionTimeout: 5_000,
    navigationTimeout: 20_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
