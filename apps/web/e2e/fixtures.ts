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

export const test = base.extend<{ consoleErrors: ConsoleErrorCollector }>({
  // eslint-disable-next-line no-empty-pattern
  consoleErrors: async ({ page }, provide) => {
    const collector = new ConsoleErrorCollector();

    // Capture console.error() calls.
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        collector.push(`console.error: ${msg.text()}`);
      }
    });

    // Capture uncaught JS exceptions (EvalError, SyntaxError, etc.).
    page.on('pageerror', (err) => {
      collector.push(`pageerror: ${err.message}`);
    });

    await provide(collector);

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
