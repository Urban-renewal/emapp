/**
 * §E-J13 — Auth anti-enumeration (D.14 / ISO A.9.4.3).
 *
 * Wave 1 slice 3 — covers MATRIX-V2 §7 item #13 (FE side):
 * "Auth recovery (locked → 15min → unlock)".
 *
 * The 15-minute lockout window is a BE-side timer + counter state
 * machine (apps/api/src/modules/auth/auth.service.ts MAX_FAILED +
 * LOCK_MS). What the FE owns — and what this test pins — is the
 * D.14 anti-enumeration contract:
 *
 *   The FE MUST display the SAME generic message regardless of
 *   which 401 error code the BE returned (invalid_credentials,
 *   account_locked, future-codes). A user attacking the login
 *   form CANNOT learn from the UI whether an email is registered,
 *   whether a password was wrong, or whether the account is
 *   currently locked.
 *
 * Defensive scope notes:
 *   - We do NOT exercise the BE's lockout counter (that's a unit
 *     spec on the API side). The FE contract is verified by
 *     stubbing each distinct 401 code and asserting the UI
 *     converges to the same string.
 *   - validation_error (400) is NOT covered here — it's a DIFFERENT
 *     flow (field-level errors via applyValidationErrors), already
 *     pinned by J1's "validation_error" test.
 *
 * D.17 cells exercised:
 *   - `auth.login` (public) — D.14 anti-enum contract.
 *
 * 5-axis TUVAS coverage:
 *   T — submit login with stubbed 401-shape variations.
 *   U — URL stays on /he/login (no redirect); no credentials in URL.
 *   V — `<p class="...text-destructive">` shows the SAME copy
 *       across all 401 codes (anti-enum).
 *   A — exactly one POST per attempt; body matches LoginSchema.
 *   S — no session cookies set on failure; console clean.
 */
import { test, expect } from './fixtures';

// All 401 codes the login endpoint can legitimately return. They MUST
// all surface as the same FE message. Add new codes here when the BE
// gains them — the test will catch any FE-side branching that
// distinguishes them.
const LOGIN_401_CODES = [
  'invalid_credentials',
  // BE returns invalid_credentials even for locked accounts
  // (auth.service.ts D.14 — same code, no `account_locked` on wire).
  // BUT the FE login page's switch fell through to the same generic
  // copy regardless of code, so we ALSO test other plausible codes
  // to catch a future regression that branches on code.
  'account_locked',
  'too_many_attempts',
  'session_revoked',
] as const;

const GENERIC_ERROR_HE = 'אימייל או סיסמה שגויים';

const VALID_LOGIN_INPUT = {
  email: 'jane.e2e@example.test',
  password: 'TestPassword123!',
} as const;

test.describe('§E-J13 — Auth anti-enumeration on /he/login', () => {
  for (const code of LOGIN_401_CODES) {
    test(`login 401 "${code}" → same generic message; URL clean; no cookies`, async ({
      page,
      context,
      consoleErrors,
    }) => {
      let postCount = 0;
      let capturedBody: string | null = null;

      await page.route('**/api/v1/auth/login', async (route) => {
        postCount += 1;
        capturedBody = route.request().postData();
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code, message: `auth: ${code}` },
          }),
        });
      });

      // Benign catch-all so any other browser-side /api/v1/* fetches
      // (notifications poll if the page mounts one) don't 404.
      await page.route('**/api/v1/**', async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === '/api/v1/auth/login') {
          await route.fallback();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ data: null }),
        });
      });

      await page.goto('/he/login');
      await expect(page).toHaveURL(/\/he\/login$/);

      await page.locator('input#email').fill(VALID_LOGIN_INPUT.email);
      await page.locator('input#password').fill(VALID_LOGIN_INPUT.password);

      await Promise.all([
        page.waitForResponse(
          (r) => r.url().includes('/api/v1/auth/login') && r.request().method() === 'POST',
          { timeout: 10_000 },
        ),
        page.locator('button[type="submit"]').click(),
      ]);

      // §AXIS-A — exactly ONE POST per code; the FE must not retry
      // (otherwise rate-limiting + lockout state could be subverted
      // by retry storms from a buggy client).
      expect(postCount, 'exactly one POST per submit (no FE-side retry)').toBe(1);
      const body = JSON.parse(capturedBody ?? '{}') as Record<string, unknown>;
      expect(body['email']).toBe(VALID_LOGIN_INPUT.email);
      expect(body['password']).toBe(VALID_LOGIN_INPUT.password);

      // §AXIS-V — the generic error pill MUST be visible with the
      // canonical copy. If a future change distinguishes codes (e.g.
      // shows "אנא נסה שוב מאוחר יותר" only for account_locked),
      // that's a D.14 violation and this test fails.
      await expect(page.getByText(GENERIC_ERROR_HE)).toBeVisible({ timeout: 5_000 });

      // The "code"-revealing copy MUST NOT render. We assert each
      // BE-style descriptor doesn't surface — guards against a
      // future FE that helpfully shows "Account locked, try in 15
      // minutes" or similar, which would enumerate the lock state.
      await expect(page.getByText(/locked/i)).toBeHidden();
      await expect(page.getByText(/חסום/)).toBeHidden();
      await expect(page.getByText(/too many/i)).toBeHidden();
      await expect(page.getByText(/יותר מדי/)).toBeHidden();

      // §AXIS-U — URL untouched.
      const url = page.url();
      expect(url, 'URL must stay on /he/login').toMatch(/\/he\/login$/);
      expect(url, 'no email in URL').not.toContain(encodeURIComponent(VALID_LOGIN_INPUT.email));
      expect(url, 'no password in URL').not.toContain(VALID_LOGIN_INPUT.password);
      expect(url).not.toMatch(/[?&](email|password)=/);

      // §AXIS-S — no session cookies were set on failure.
      const cookies = await context.cookies();
      expect(
        cookies.find((c) => c.name === 'access_token'),
        'no access_token on failed login',
      ).toBeUndefined();
      expect(
        cookies.find((c) => c.name === 'refresh_token'),
        'no refresh_token on failed login',
      ).toBeUndefined();

      // §AXIS-S (console) — Chromium logs the stubbed 401 from the
      // network layer; filter it out same as J1 test 2 / sign-flow.
      const real = consoleErrors.all.filter((e) => !/\b401\b/.test(e) && !/Unauthorized/i.test(e));
      expect(real, `unexpected console errors: ${real.join(' | ')}`).toEqual([]);
      consoleErrors.clear();
    });
  }
});
