/**
 * §PERF-4 — error feedback must be fast (was 7–9s).
 *
 * Root cause: the global TanStack `retry: 3` + 1s/2s/4s backoff retried
 * EVERY failed query, including deterministic server responses (a 404/500
 * can't succeed on retry) — so the error UI only appeared after ~7s of
 * pointless backoff. The fix stops retrying a structured `ApiClientError`
 * (any HTTP response) and retries only genuine network failures.
 *
 * Verification is MECHANISM-based (D.51), not just a stopwatch:
 *   - request COUNT to the failing endpoint must be exactly 1 (proves the
 *     retry was suppressed — a caching/timeout plaster could pass a pure
 *     "<1.5s" check but could NOT collapse 4 requests to 1).
 *   - AND the error surface appears within the budget, measured from the
 *     first request (so route-compile time is excluded).
 *
 * Driven through the owners list, whose query uses the global retry
 * default (no per-hook override).
 */
import { test, expect } from './fixtures';

const MANAGER_COOKIE = {
  name: 'access_token',
  value: 'e2e-manager-access-jwt',
  domain: 'localhost',
  path: '/',
  httpOnly: true,
  sameSite: 'Lax' as const,
  secure: false,
};

const ERROR_BUDGET_MS = 1500;

for (const { status, code, label } of [
  { status: 404, code: 'not_found', label: 'forced-404' },
  { status: 500, code: 'internal_error', label: 'forced-500' },
]) {
  test(`§PERF-4 ${label} — owners list error shows once, fast (no retry storm)`, async ({
    page,
    context,
    consoleErrors,
  }) => {
    await context.addCookies([MANAGER_COOKIE]);

    let ownersRequests = 0;
    let firstRequestAt = 0;

    // Benign catch-all for unrelated browser fetches.
    await page.route('**/api/v1/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
      });
    });

    // The endpoint under test — always fails with a definitive HTTP error.
    await page.route('**/api/v1/owners?**', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      ownersRequests += 1;
      if (ownersRequests === 1) firstRequestAt = Date.now();
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code, message: 'forced failure for PERF-4 test' } }),
      });
    });

    await page.goto('/he/owners');

    // The owners error surface (loadFailed banner). Wait for it, then
    // measure latency from the FIRST request (excludes cold-compile).
    await expect(page.getByText('טעינת בעלי הדירות נכשלה')).toBeVisible({ timeout: 10_000 });
    const latencyMs = Date.now() - firstRequestAt;

    // §mechanism — the retry was suppressed: a definitive HTTP error is
    // fetched exactly once. Pre-fix this was 4 (1 + retry:3).
    expect(ownersRequests, 'definitive HTTP error fetched exactly once (no retry)').toBe(1);

    // §symptom — feedback within budget (pre-fix ≈ 7s of backoff).
    expect(latencyMs, `error shown within ${ERROR_BUDGET_MS}ms of the request`).toBeLessThan(
      ERROR_BUDGET_MS,
    );

    // The retry affordance is present so the user can re-try by choice.
    await expect(page.getByRole('button', { name: 'נסה שוב' })).toBeVisible();

    // The browser logs a "Failed to load resource: <status>" for the
    // forced HTTP error — that is expected here (we deliberately fail the
    // endpoint) and is a browser network log, not an app error. Assert
    // there are NO OTHER console errors, then clear the expected one so
    // the fixture's afterEach guard passes.
    const unexpected = consoleErrors.all.filter((m) => !/Failed to load resource/i.test(m));
    expect(unexpected, 'no console errors beyond the forced resource-load failure').toEqual([]);
    consoleErrors.clear();
  });
}
