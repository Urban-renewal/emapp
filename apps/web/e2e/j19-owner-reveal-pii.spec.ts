/**
 * §E-J19 — Owner "Reveal PII" (D.54 reveal-on-demand) on the owner dossier.
 *
 *   /he/owners/:id  →  masked PII  →  click "Reveal PII"
 *   →  POST /owners/:id/reveal-pii  →  cleartext shown transiently  →  Hide
 *
 * Pins the security contract + 4-axis smoke:
 *   Network — reveal is a POST to .../reveal-pii (never a GET → the id and
 *     result never land in a query string / history / access log).
 *   URL     — the cleartext national_id NEVER appears in the URL; the page
 *     stays on /owners/:id throughout.
 *   Cookies — the reveal POST carries the org `access_token`.
 *   Redirect— none; reveal/hide toggle in place.
 *   + the cleartext is shown only AFTER the click and is removed on Hide.
 *   + a Viewer never sees the reveal button (role-gated UX; BE 403 is the
 *     real gate).
 *
 * Auth/role: `useSessionProfile` is a client `GET /me`; we stub it per test
 * to drive the role. The owner detail + reveal are stubbed via page.route.
 */
import { test, expect } from './fixtures';

const OWNER_ID = '00000000-0000-4000-8000-00000000c901';
const CLEARTEXT_NID = '012345678';
const CLEARTEXT_PHONE = '0501234567';

const MASKED_OWNER = {
  id: OWNER_ID,
  organizationId: '00000000-0000-4000-8000-000000000002',
  name: 'דנה כהן',
  email: null,
  nationalIdMasked: '•••••••78',
  phoneMasked: '•••••4567',
  notes: null,
  createdAt: '2026-05-20T10:00:00.000Z',
  updatedAt: '2026-05-20T10:00:00.000Z',
  archivedAt: null,
};

function profile(role: 'manager' | 'agent' | 'viewer', viewOwnerPii = role === 'manager') {
  return {
    id: '00000000-0000-4000-8000-000000000003',
    name: 'מנהלת',
    email: 'mgr@alpha.dev',
    role,
    avatarColor: null,
    organization: {
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Alpha',
      slug: 'alpha-dev',
    },
    view_owner_pii: viewOwnerPii,
  };
}

/**
 * Seed an org session cookie. The mock-backend's SERVER-side `/me` selects the
 * role from the access_token VALUE PREFIX (`e2e-agent*` → agent, `e2e-viewer*`
 * → viewer, else manager). This matters because the dashboard layout resolves
 * the session server-side (`getMe`) and SEEDS the client `useSessionProfile`
 * cache from it — so the role-gated reveal button is driven by THIS cookie,
 * not only by the browser-side `page.route('/me')` stub. The two must agree.
 */
async function seedSession(context: import('@playwright/test').BrowserContext, tokenValue: string) {
  await context.addCookies([
    {
      name: 'access_token',
      value: tokenValue,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: false,
    },
  ]);
}

const seedManager = (context: import('@playwright/test').BrowserContext) =>
  seedSession(context, 'e2e-manager-access-jwt');
const seedViewer = (context: import('@playwright/test').BrowserContext) =>
  seedSession(context, 'e2e-viewer-access-jwt');
const seedAgent = (context: import('@playwright/test').BrowserContext) =>
  seedSession(context, 'e2e-agent-access-jwt');

test.describe('§E-J19 — owner reveal PII (D.54)', () => {
  test('1) Manager reveals → POST fires, cleartext shown, URL clean, Hide restores mask', async ({
    page,
    context,
    consoleErrors,
  }) => {
    await seedManager(context);

    let revealMethod = '';
    let revealUrl = '';
    let revealCookie = '';

    await page.route('**/api/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.startsWith('/api/v1/owners') || p === '/api/v1/me') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
      });
    });
    await page.route('**/api/v1/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: profile('manager') }),
      });
    });
    await page.route('**/api/v1/owners/*/reveal-pii', async (route) => {
      const req = route.request();
      revealMethod = req.method();
      revealUrl = req.url();
      revealCookie = (await req.allHeaders())['cookie'] ?? '';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: { id: OWNER_ID, nationalId: CLEARTEXT_NID, phone: CLEARTEXT_PHONE },
        }),
      });
    });
    // S3d — the owner-detail "Projects" section fetches GET /owners/:id/projects
    // on mount (useOwnerProjects). The `**/api/v1/owners/*` GET stub below does
    // NOT cover it (single `*` doesn't cross the `/projects` slash), so without
    // this stub the call falls through to the network → 404 → a "Failed to load
    // resource" console error that trips the §P0-3 guardrail. 200 {data:[]} keeps
    // the section empty and the console clean.
    await page.route('**/api/v1/owners/*/projects', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [] }),
      });
    });
    await page.route('**/api/v1/owners/*', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: MASKED_OWNER }),
      });
    });

    await page.goto(`/he/owners/${OWNER_ID}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // §AXIS-V — masked by default; cleartext NOT present yet.
    await expect(page.getByText('•••••••78')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(CLEARTEXT_NID)).toHaveCount(0);

    // Reveal.
    await page.getByRole('button', { name: 'הצג נתונים גלויים' }).click();

    // §AXIS-V — cleartext now visible.
    await expect(page.getByText(CLEARTEXT_NID)).toBeVisible({ timeout: 10_000 });

    // §AXIS-U — cleartext NID must never be in the URL.
    expect(page.url()).not.toContain(CLEARTEXT_NID);
    expect(page.url()).toContain(`/owners/${OWNER_ID}`);

    // §AXIS-A + Cookies — reveal was a POST carrying the access_token.
    expect(revealMethod).toBe('POST');
    expect(revealUrl).toContain(`/owners/${OWNER_ID}/reveal-pii`);
    expect(revealUrl).not.toContain('?');
    expect(revealCookie).toContain('access_token=');

    // Hide → mask restored, cleartext gone.
    await page.getByRole('button', { name: 'הסתר' }).click();
    await expect(page.getByText(CLEARTEXT_NID)).toHaveCount(0);
    await expect(page.getByText('•••••••78')).toBeVisible();

    expect(consoleErrors.count, 'no console errors on reveal flow').toBe(0);
  });

  test('2) Viewer never sees the reveal button (role-gated UX)', async ({ page, context }) => {
    await seedViewer(context); // server getMe → SEED_VIEWER (no owners.reveal_pii)
    await page.route('**/api/v1/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: profile('viewer') }),
      });
    });
    await page.route('**/api/v1/owners/*/projects', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [] }),
      });
    });
    await page.route('**/api/v1/owners/*', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: MASKED_OWNER }),
      });
    });
    await page.route('**/api/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.startsWith('/api/v1/owners') || p === '/api/v1/me') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
      });
    });

    await page.goto(`/he/owners/${OWNER_ID}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect(page.getByText('•••••••78')).toBeVisible({ timeout: 15_000 });
    // No reveal button for a viewer.
    await expect(page.getByRole('button', { name: 'הצג נתונים גלויים' })).toHaveCount(0);
  });

  // D2-DEF-3 — the button is gated on the agent's view_owner_pii capability
  // (now carried on the /me profile), not just the role.
  async function stubFor(
    page: import('@playwright/test').Page,
    me: ReturnType<typeof profile>,
  ): Promise<void> {
    await page.route('**/api/v1/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: me }),
      });
    });
    await page.route('**/api/v1/owners/*/projects', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [] }),
      });
    });
    await page.route('**/api/v1/owners/*', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: MASKED_OWNER }),
      });
    });
    await page.route('**/api/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.startsWith('/api/v1/owners') || p === '/api/v1/me') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
      });
    });
  }

  test('3) Agent WITHOUT view_owner_pii does NOT see the reveal button', async ({
    page,
    context,
  }) => {
    await seedAgent(context); // server getMe → SEED_AGENT (view_owner_pii false)
    await stubFor(page, profile('agent', false));
    await page.goto(`/he/owners/${OWNER_ID}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect(page.getByText('•••••••78')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'הצג נתונים גלויים' })).toHaveCount(0);
  });

  test('4) Agent WITH view_owner_pii sees the reveal button', async ({ page, context }) => {
    await seedManager(context);
    await stubFor(page, profile('agent', true));
    await page.goto(`/he/owners/${OWNER_ID}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'הצג נתונים גלויים' })).toBeVisible({
      timeout: 15_000,
    });
  });
});
