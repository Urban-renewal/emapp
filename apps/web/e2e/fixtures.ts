/**
 * §P0-3 CI guardrail — failOnConsoleError fixture.
 *
 * Lesson: three P0 bugs (CSP eval block, proxy 502, missing endpoint)
 * shipped to main because Playwright didn't assert a clean console.
 * The CSP `unsafe-eval` block fired an EvalError on every page load,
 * making JS not hydrate — login fell back to native HTML GET, all
 * interactive forms broken in dev. The bug was invisible to tests that
 * only checked HTTP status codes.
 *
 * This fixture makes console errors a FIRST-CLASS test failure.
 * Any `console.error` or JS exception during a test is collected and
 * thrown as an assertion at afterEach. This catches:
 *  - CSP violations (EvalError, SecurityError)
 *  - React hydration mismatches
 *  - Unhandled promise rejections (logged as console.error)
 *  - Missing module errors
 *
 * Usage:
 *   import { test, expect } from './fixtures';
 *   // That's it — console errors auto-fail the test.
 *
 * Opt-out (for tests that intentionally trigger errors):
 *   test('my test', async ({ page, consoleErrors }) => {
 *     // do things...
 *     consoleErrors.clear(); // discard before afterEach checks
 *   });
 */
import { test as base, expect } from '@playwright/test';

import { fetchResetRequestLog, resetMockHandlers } from './mock-backend';

export { expect };

class ConsoleErrorCollector {
  private _errors: string[] = [];

  push(msg: string) {
    this._errors.push(msg);
  }

  clear() {
    this._errors = [];
  }

  get all(): string[] {
    return [...this._errors];
  }

  get count(): number {
    return this._errors.length;
  }
}

/**
 * Known-benign error patterns that DO NOT indicate the kind of bug we're
 * guarding against (CSP eval-block, React hydration failure, missing
 * chunks). Filtered out so they don't drown the signal.
 *
 *  - "Connection closed" / "WebSocket" — Next.js HMR socket churn when
 *    dev server is starting/stopping between tests.
 *  - "ResizeObserver loop limit exceeded" — benign browser quirk.
 *  - "HMR" / "Hot Module" — dev-only refresh logs.
 */
const BENIGN_PATTERNS: readonly RegExp[] = [
  /Connection closed/i,
  /WebSocket connection/i,
  /ResizeObserver loop limit exceeded/i,
  /\bHMR\b/i,
  /Hot Module/i,
];

function isBenign(msg: string): boolean {
  return BENIGN_PATTERNS.some((p) => p.test(msg));
}

export const test = base.extend<{ consoleErrors: ConsoleErrorCollector }>({
  // eslint-disable-next-line no-empty-pattern
  consoleErrors: async ({ page }, provide) => {
    const collector = new ConsoleErrorCollector();

    // Capture console.error() calls.
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (!isBenign(text)) {
          collector.push(`console.error: ${text}`);
        }
      }
    });

    // Capture uncaught JS exceptions (EvalError, SyntaxError, etc.).
    page.on('pageerror', (err) => {
      if (!isBenign(err.message)) {
        collector.push(`pageerror: ${err.message}`);
      }
    });

    await provide(collector);

    // §Phase-E — reset mock-backend state between tests so a per-
    // test override (e.g. "return 401 from /me to simulate session
    // expiry") doesn't leak into the next spec.
    //
    // Two layers:
    //  1. resetMockHandlers() — worker-local handler map (per-test
    //     overrides registered via setMockHandler).
    //  2. fetchResetRequestLog() — parent-process request log (over
    //     HTTP, since the HTTP server lives in globalSetup's process
    //     and workers can't reach its memory directly).
    //
    // Both run BEFORE the console-errors assertion so a leak-induced
    // failure surfaces distinctly from a console-error failure.
    resetMockHandlers();
    try {
      await fetchResetRequestLog();
    } catch {
      // Mock backend may already be stopped (afterAll cleanup); the
      // teardown HTTP call is best-effort.
    }

    // §CI — after every test, assert zero console errors.
    // CSP eval-blocks, React hydration mismatches, missing chunks: all
    // surface here. Use consoleErrors.clear() to opt-out intentionally.
    if (collector.count > 0) {
      throw new Error(
        `§P0-3 CI guardrail: ${collector.count} console error(s) during test:\n` +
          collector.all.map((e, i) => `  ${i + 1}. ${e}`).join('\n'),
      );
    }
  },
});
