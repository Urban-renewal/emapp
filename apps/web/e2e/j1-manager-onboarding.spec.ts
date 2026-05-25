/**
 * §E-J1 — Manager Onboarding (signup form contract).
 *
 * Wave 1 — first journey in Phase E. Covers MATRIX-V2 §7 item #1:
 * "Manager onboarding (signup → create project)". This spec pins the
 * SIGNUP HALF; the project-creation half is J2 (separate spec).
 *
 * D.17 cells exercised:
 *   - `auth.signup` (public, no role) — D.14 anti-enumeration contract.
 *   - First Manager user creation post-bootstrap (atomic withBootstrap).
 *
 * 5-axis TUVAS coverage:
 *   T (Triggers)     — fill 4 fields, click submit.
 *   U (URL bar)      — never contains email / password / name / org_name
 *                       at any point. The GET-fallback bug (PR #43 §S1-VG1)
 *                       would put credentials directly into the URL on
 *                       click; we sample page.url() right after submit.
 *   V (Visible DOM)  — form has method="post" (D.07 §7.10 SSR defense);
 *                       no server-error pill renders on success.
 *   A (API/Network)  — exactly one POST to /api/v1/auth/signup with
 *                       Content-Type: application/json; body shape
 *                       conforms to SignupSchema (org_name/name/email/
 *                       password); response 201.
 *   S (Side effects) — context cookies include access_token with
 *                       HttpOnly + SameSite=Lax + hostOnly + Secure=false
 *                       (the last is INTENTIONAL in dev — see comment
 *                       inline); console clean per §P0-3 guardrail.
 *
 * Scope deliberately NARROW (Q3 disposition).
 * The post-signup landing render (`/he/`) is NOT asserted in this spec.
 * Rationale: the `(dashboard)/layout.tsx:11-12` is a Server Component
 * that calls `getMe()` server-side → `fetch(${selfOrigin}/api/v1/me)`
 * → Pages proxy → `${API_BACKEND_URL}/api/v1/me`. That chain runs
 * inside the Next.js Node process; Playwright's `page.route()` only
 * intercepts BROWSER requests, so we cannot stub the server-side /me
 * fetch. Until we add a Node-side mock backend (wave 1 infra
 * decision — see PR description), the only honest contract this spec
 * proves is: "the form correctly POSTs credentials and the
 * success-response cookies are applied to the context." That IS the
 * single most security-critical assertion (a regression on it would
 * either land credentials in the URL or skip cookie application
 * entirely — both Sev1).
 *
 * Threat-model linkage:
 *   - I3 (PII never in URL): if a future change removes method="post"
 *     OR the onSubmit/preventDefault path, browser default GET puts
 *     org_name / email / password in window.location.search. PR #43
 *     ("§S1-VG1") shipped exactly this bug under earlier RTL coverage.
 *   - I5 (cookies posture): if Set-Cookie passthrough at the proxy
 *     regresses (apps/web/src/app/api/[...path]/route.ts), or if the
 *     BE's COOKIE_BASE drifts (apps/api/src/modules/auth/auth.service.ts:58),
 *     the access_token won't appear in `context.cookies()` — the
 *     entire authenticated experience would be broken from this point.
 *   - I4 (D.16 envelope): the stub returns `{ data: { user: ... } }`
 *     — if the FE were to read raw response.body or treat the bare
 *     `user` as the envelope, this test would not change (the test
 *     only asserts the wire shape sent). The CONSUMER side of D.16
 *     is verified separately in the unit suite (api-client.spec.ts).
 */
import { test, expect } from './fixtures';

/* Test-fixture credentials. NOT real PII — `.test` is a reserved TLD
 * (RFC 2606), the email cannot exist; the password is the canonical
 * E2E placeholder. Importantly, all four field VALUES are distinct
 * enough that an accidental URL leak would be unambiguously visible
 * in failure output (no risk of "0501234567" colliding with a build
 * artifact hash). */
const VALID_SIGNUP = {
  org_name: 'Acme E2E',
  name: 'Jane Doe',
  email: 'jane.e2e@example.test',
  password: 'TestPassword123!',
} as const;

/** D.16 success envelope, mirroring auth.service.ts UserProfile shape. */
const SIGNUP_OK_BODY = {
  data: {
    user: {
      id: '00000000-0000-4000-8000-000000000001',
      name: VALID_SIGNUP.name,
      email: VALID_SIGNUP.email,
      role: 'manager',
      avatarColor: '#0f766e',
      organization: {
        id: '00000000-0000-4000-8000-000000000002',
        name: VALID_SIGNUP.org_name,
        slug: 'acme-e2e',
      },
    },
  },
};

/**
 * Set-Cookie shape mirrors apps/api/src/modules/auth/auth.service.ts:58-60
 * COOKIE_BASE. In dev (NODE_ENV !== 'production' && !== 'test'), SECURE
 * is FALSE — browsers reject `Secure` cookies on http://localhost, so
 * this is the production-safe + dev-loadable posture. We assert
 * `cookie.secure === false` below for the SAME reason: testing the
 * dev environment, expecting dev behavior. Cookies are HttpOnly +
 * SameSite=Lax + no `Domain=` (→ hostOnly). The refresh cookie is
 * Path-scoped to /api/v1/auth/refresh.
 */
const SET_COOKIE_ACCESS = 'access_token=test-access-jwt; Path=/; HttpOnly; SameSite=Lax';

test.describe('§E-J1 — Manager Onboarding (signup form contract)', () => {
  test('1) happy path: POST credentials, success envelope sets cookies, URL stays clean', async ({
    page,
    context,
    consoleErrors,
  }) => {
    // Capture the wire-level request shape for AXIS A assertions.
    let captured: {
      method: string;
      url: string;
      contentType: string | null;
      body: string;
    } | null = null;

    // §Playwright-route-order — handlers run in REVERSE-REGISTRATION
    // order (the LAST registered handler is tried first; if it calls
    // `route.fallback()`, the previous handler runs). So we register
    // the catch-all FIRST and the specific `/auth/signup` handler
    // LAST so the latter wins for that URL.

    // Catch-all safety net: any browser-side `/api/v1/*` GET that
    // isn't otherwise matched (e.g. a TanStack Query cold-fetch the
    // dashboard layout triggers post-navigation) gets a benign
    // D.16 envelope. Server-side traffic does NOT come through here
    // (it goes through the Next proxy → mock backend on port 9999).
    await page.route('**/api/v1/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: null }),
      });
    });

    // §AXIS-A stub — /auth/signup is the call we OWN. Registered LAST
    // so it runs FIRST for this URL (per Playwright route ordering).
    // 201 envelope per D.14 anti-enum (same 201 for duplicate-email,
    // not exercised here — see test 2 for validation_error path).
    await page.route('**/api/v1/auth/signup', async (route) => {
      const req = route.request();
      captured = {
        method: req.method(),
        url: req.url(),
        contentType: await req.headerValue('content-type'),
        body: req.postData() ?? '',
      };
      // §Chromium-quirk — `route.fulfill({ headers })` accepts only
      // ONE value per header name; concatenating two Set-Cookie values
      // with comma + space (the HTTP-spec way) is parsed unreliably
      // by Chromium for cookies whose attribute string ALSO contains
      // commas (e.g. `Expires=Wed, 21 ...`). To keep J1 deterministic
      // we stub ONLY the access_token here; refresh_token rotation
      // posture is owned by J14 (session-expiry / silent-refresh)
      // where we can use `context.addCookies()` to inject both
      // cookies before the test starts (no Set-Cookie comma race).
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        headers: {
          'Set-Cookie': SET_COOKIE_ACCESS,
        },
        body: JSON.stringify(SIGNUP_OK_BODY),
      });
    });

    // ── Navigate to the signup page.
    await page.goto('/he/signup');

    // §AXIS-U — pre-submit baseline: clean URL.
    await expect(page).toHaveURL(/\/he\/signup$/);

    // §AXIS-V — form rendered + method="post" (SSR HTML attribute,
    // §S1-SEC1 defense against GET-fallback URL credential leak per
    // docs/DOD-BROWSER-SMOKE.md "view-source self-check").
    const form = page.locator('form').first();
    await expect(form).toBeVisible({ timeout: 10_000 });
    const formMethod = await form.getAttribute('method');
    expect(formMethod?.toLowerCase(), 'GET-fallback defense (PR #43 §S1-VG1)').toBe('post');

    // §AXIS-T — fill all 4 SignupSchema fields.
    await page.locator('input#org_name').fill(VALID_SIGNUP.org_name);
    await page.locator('input#name').fill(VALID_SIGNUP.name);
    await page.locator('input#email').fill(VALID_SIGNUP.email);
    await page.locator('input#password').fill(VALID_SIGNUP.password);

    // Submit + wait for the POST round-trip. The Promise.all pattern
    // arms the wait BEFORE the click triggers it — without this, a
    // very fast 201 reply could race the wait registration on slow CI.
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/v1/auth/signup') && r.request().method() === 'POST',
        { timeout: 10_000 },
      ),
      page.locator('button[type="submit"]').click(),
    ]);

    // §AXIS-A — wire-level assertions.
    expect(captured, 'signup POST was intercepted by the route handler').not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by expect above
    const cap = captured!;
    expect(cap.method, 'method MUST be POST (GET-fallback = credential URL leak)').toBe('POST');
    expect(cap.url).toMatch(/\/api\/v1\/auth\/signup$/);
    expect(cap.contentType ?? '').toMatch(/application\/json/i);

    const parsedBody = JSON.parse(cap.body) as Record<string, unknown>;
    expect(parsedBody['org_name']).toBe(VALID_SIGNUP.org_name);
    expect(parsedBody['name']).toBe(VALID_SIGNUP.name);
    expect(parsedBody['email']).toBe(VALID_SIGNUP.email);
    expect(parsedBody['password']).toBe(VALID_SIGNUP.password);
    expect(Object.keys(parsedBody).sort()).toEqual(['email', 'name', 'org_name', 'password']);

    expect(response.status(), 'API returned the stubbed 201').toBe(201);

    // §AXIS-U — post-submit URL must NOT carry any of the 4 fields.
    // Capture IMMEDIATELY (router.push('/') may already be in flight
    // but the address bar at this moment is the source of truth for
    // "did the form do a GET fallback?"). The GET-fallback failure
    // mode would put `?org_name=...&password=...` here.
    const urlPostSubmit = page.url();
    expect(urlPostSubmit, 'no credential carried in URL').not.toContain(VALID_SIGNUP.password);
    expect(urlPostSubmit, 'no email leak in URL').not.toContain(
      encodeURIComponent(VALID_SIGNUP.email),
    );
    expect(urlPostSubmit).not.toContain(VALID_SIGNUP.email);
    expect(urlPostSubmit, 'no name leak in URL').not.toContain(
      encodeURIComponent(VALID_SIGNUP.name),
    );
    expect(urlPostSubmit, 'no org_name leak in URL').not.toContain(
      encodeURIComponent(VALID_SIGNUP.org_name),
    );
    expect(urlPostSubmit).not.toMatch(/[?&](email|password|name|org_name)=/);

    // §AXIS-S (cookies) — Set-Cookie passthrough applied to context.
    // Sample after a tiny tick to let the browser commit the Set-Cookie
    // headers from the just-received response (Playwright reads cookies
    // off the persistent context, not the in-flight response object).
    await page.waitForTimeout(50);
    const cookies = await context.cookies();
    const access = cookies.find((c) => c.name === 'access_token');

    expect(access, 'access_token cookie applied from Set-Cookie').toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by expect above
    const a = access!;

    expect(a.httpOnly, 'I5: access_token HttpOnly (no JS access)').toBe(true);
    expect(a.sameSite, 'I5: access_token SameSite=Lax (CSRF defense per D.35)').toMatch(/lax/i);
    // §INTENTIONAL — auth.service.ts:58 sets SECURE = NODE_ENV !==
    // 'development' && !== 'test'. Playwright runs the dev server with
    // NODE_ENV=development; the cookie is non-Secure here BY DESIGN
    // (Chromium would refuse a Secure cookie on http://localhost). In
    // staging/production this flips to true; verified by the API unit
    // suite, not by this E2E. A future hand seeing `expect(secure).toBe
    // (false)` should NOT "fix" it — that would re-introduce a Sev0
    // (cookies refused, auth broken on dev).
    expect(a.secure, 'D.21: secure=false in dev/test is intentional, NOT a regression').toBe(
      false,
    );
    // hostOnly: no `Domain=` attribute. Playwright reports `localhost`
    // (the request host) when Set-Cookie omits Domain — that IS the
    // hostOnly state (D.35: no Domain leak, no subdomain takeover risk).
    expect(a.domain, 'I5: hostOnly cookie (D.35 — no subdomain takeover surface)').toBe(
      'localhost',
    );
    expect(a.path, 'access_token path scoped to /').toBe('/');

    // refresh_token posture (path scoped to /api/v1/auth/refresh +
    // HttpOnly + Lax + non-Secure-in-dev) is exercised by J14
    // (silent-refresh) where the cookie is pre-seeded via
    // `context.addCookies()` — that pattern avoids the
    // Chromium multi-Set-Cookie parse quirk noted at the route stub.

    // §AXIS-V (post-submit DOM) — no server-error pill rendered.
    // The signup page renders `<p className="text-sm text-destructive">`
    // when `serverError` state is set; on a 201 it stays null. We assert
    // the heuristic "no destructive-styled paragraph anywhere on the page"
    // — proxy for "signup is not in error state".
    const errorPills = await page.locator('p.text-destructive, p.text-sm.text-destructive').count();
    expect(errorPills, 'no server-error rendered on success').toBe(0);

    // We DELIBERATELY do not assert post-navigation home page render —
    // see the spec header comment for full rationale. The contract this
    // test pins is: form → correct POST → correct cookies → URL never
    // dirty. Future J1b will pin the navigation half once the suite
    // gains a Node-side mock backend.

    // §AXIS-S (console) — the §P0-3 fixture auto-asserts in afterEach.
    // No carve-outs needed: the stubbed 201 path triggers ZERO 4xx/5xx
    // status lines, so no Chromium "failed to load resource" logs.
    // Any console error here would be a REAL CSP / hydration / module
    // failure during the signup-page render — exactly the bug class
    // §P0-3 exists to catch (the PR #43 CSP eval-block bug).
    expect(consoleErrors.count, 'no console errors during signup flow').toBe(0);
  });

  test('2) validation error: 400 response keeps URL clean and stays on /signup', async ({
    page,
    consoleErrors,
  }) => {
    // §AXIS-A — stub returns D.16 error envelope with `validation_error`
    // code. The FE switches on `error.code` (D.16 contract), maps to
    // field-level errors via applyValidationErrors().
    await page.route('**/api/v1/auth/signup', async (route) => {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: {
            code: 'validation_error',
            message: 'Validation failed',
            details: { fields: { email: 'invalid' } },
          },
        }),
      });
    });

    await page.goto('/he/signup');
    await page.locator('input#org_name').fill(VALID_SIGNUP.org_name);
    await page.locator('input#name').fill(VALID_SIGNUP.name);
    await page.locator('input#email').fill(VALID_SIGNUP.email);
    await page.locator('input#password').fill(VALID_SIGNUP.password);

    await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/v1/auth/signup') && r.request().method() === 'POST',
        { timeout: 10_000 },
      ),
      page.locator('button[type="submit"]').click(),
    ]);

    // Validation failures don't redirect — page stays on /signup.
    await expect(page).toHaveURL(/\/he\/signup$/);

    // §AXIS-U — URL must remain clean even on the unhappy path.
    const url = page.url();
    expect(url, 'no password in URL on validation failure').not.toContain(VALID_SIGNUP.password);
    expect(url).not.toContain(encodeURIComponent(VALID_SIGNUP.email));
    expect(url).not.toMatch(/[?&](email|password|name|org_name)=/);

    // §AXIS-S (console) — Chromium logs the stubbed 400 status line as a
    // console.error from the network layer (`Failed to load resource:
    // the server responded with a status of 400`). Carve that ONE
    // expected entry out; any other entry is a real bug (CSP /
    // hydration / etc.). Same carve-out pattern used in
    // sign-flow.spec.ts:200-210 for the stubbed 401.
    const realErrors = consoleErrors.all.filter(
      (e) => !/\b400\b/.test(e) && !/Bad Request/i.test(e),
    );
    expect(
      realErrors,
      `unexpected console errors (not the stubbed 400): ${realErrors.join(' | ')}`,
    ).toEqual([]);
    consoleErrors.clear();
  });
});
