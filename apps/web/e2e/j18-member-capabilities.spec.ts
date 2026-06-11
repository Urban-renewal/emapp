/**
 * §E-J18 — Agent capability matrix (D.46 / D.54) on the member detail page.
 *
 * Manager edits an Agent's capability set:
 *   /he/members/:userId  →  toggle capabilities  →  Save
 *   →  PATCH /members/:userId/capabilities
 *
 * Pins the UI invariant + 4-axis smoke:
 *   - INVARIANT (D.54): `view_owner_pii` ⇒ `view_owners`. The PII toggle is
 *     disabled while "view owners" is off; turning "view owners" off
 *     force-clears the PII toggle. (Server-enforced too — provider/members
 *     BE specs — this pins the FE reflection.)
 *   Network — the save is a PATCH to .../capabilities (never a GET).
 *   URL     — no capability state leaks to the URL; stays on /members/:id.
 *   Cookies — the PATCH carries the manager `access_token`.
 *   Redirect— none; the panel updates in place.
 *
 * Auth: SSR `/me` (mock-backend) returns a Manager for any access_token
 * cookie; the members LIST + the capabilities PATCH are client fetches we
 * stub via page.route.
 */
import { test, expect } from './fixtures';

const AGENT_USER_ID = '00000000-0000-4000-8000-00000000a901';

const AGENT_MEMBER = {
  userId: AGENT_USER_ID,
  email: 'field.agent@alpha.dev',
  name: 'אגנט שדה',
  role: 'agent',
  isPrimary: false,
  invitedBy: null,
  acceptedAt: '2026-05-20T10:00:00.000Z',
  revokedAt: null,
  createdAt: '2026-05-20T10:00:00.000Z',
  capabilities: {
    edit_project_data: false,
    manage_documents: false,
    manage_signatures: false,
    manage_tasks: false,
    run_imports: false,
    view_owners: true,
    view_owner_pii: false,
  },
};

test.describe('§E-J18 — agent capability matrix (D.46/D.54)', () => {
  test('1) Manager toggles caps; pii⇒view_owners invariant holds; Save → PATCH', async ({
    page,
    context,
    consoleErrors,
  }) => {
    await context.addCookies([
      {
        name: 'access_token',
        value: 'e2e-manager-access-jwt',
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        secure: false,
      },
    ]);

    let patchBody: Record<string, boolean> | undefined;
    let patchMethod = '';
    let patchUrl = '';
    let patchCookie = '';

    // Benign catch-all for any unstubbed client call.
    await page.route('**/api/v1/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/v1/members')) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
      });
    });

    // Members LIST (client fetch behind useMember) — return the agent.
    await page.route('**/api/v1/members?**', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [AGENT_MEMBER],
          page: { limit: 100, cursor: null, has_more: false },
        }),
      });
    });

    // S4b (#8): the capabilities panel now fetches the preset catalog. Stub it
    // (registered AFTER the members?** route so it wins for this exact path —
    // Playwright matches last-registered first) so the GET returns a valid
    // (empty) catalog and the defensive Zod parse doesn't log a console error.
    await page.route('**/api/v1/members/capability-presets', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [] }),
      });
    });

    // Capabilities PATCH — capture the request shape, echo the updated set.
    await page.route('**/api/v1/members/*/capabilities', async (route) => {
      const req = route.request();
      patchMethod = req.method();
      patchUrl = req.url();
      patchCookie = (await req.allHeaders())['cookie'] ?? '';
      patchBody = JSON.parse(req.postData() ?? '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: { ...AGENT_MEMBER, capabilities: { ...AGENT_MEMBER.capabilities, ...patchBody } },
        }),
      });
    });

    // Longer nav budget — the /members route cold-compiles in the dev
    // server on first hit (known PERF-2 dev artifact, D.53).
    await page.goto(`/he/members/${AGENT_USER_ID}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });

    // §AXIS-V — the capability panel renders (view_owners checkbox present).
    const viewOwners = page.getByRole('checkbox', { name: 'צפייה בבעלי דירות' });
    await expect(viewOwners).toBeVisible({ timeout: 15_000 });
    const viewPii = page.getByRole('checkbox', { name: /PII גלוי/ });

    // Default agent set: view_owners ON, pii OFF but ENABLED.
    await expect(viewOwners).toBeChecked();
    await expect(viewPii).not.toBeChecked();
    await expect(viewPii).toBeEnabled();

    // Grant unmasked PII.
    await viewPii.check();
    await expect(viewPii).toBeChecked();

    // INVARIANT — turning view_owners OFF force-clears + disables the PII toggle.
    await viewOwners.uncheck();
    await expect(viewPii).not.toBeChecked();
    await expect(viewPii).toBeDisabled();

    // Re-enable view_owners + grant a write group, then save.
    await viewOwners.check();
    await page.getByRole('checkbox', { name: /ניהול מסמכים/ }).check();
    await page.getByRole('button', { name: 'שמור הרשאות' }).click();

    // §AXIS-V — saved confirmation appears.
    await expect(page.getByText('ההרשאות נשמרו.')).toBeVisible({ timeout: 10_000 });

    // §AXIS-A — the save was a PATCH to the capabilities endpoint, carrying
    // the manager cookie; body reflects the toggles; pii NOT granted (we
    // left it off after the invariant test).
    expect(patchMethod).toBe('PATCH');
    expect(patchUrl).toContain(`/members/${AGENT_USER_ID}/capabilities`);
    expect(patchCookie).toContain('access_token=');
    expect(patchBody?.manage_documents).toBe(true);
    expect(patchBody?.view_owners).toBe(true);
    expect(patchBody?.view_owner_pii).toBe(false);

    // §AXIS-U — never left the detail route; no capability state in the URL.
    expect(page.url()).toContain(`/members/${AGENT_USER_ID}`);
    expect(page.url()).not.toContain('view_owner');

    expect(consoleErrors.count, 'no console errors on capability edit').toBe(0);
  });

  test('2) Viewer member shows the read-only preset (no editable toggles)', async ({
    page,
    context,
  }) => {
    await context.addCookies([
      {
        name: 'access_token',
        value: 'e2e-manager-access-jwt',
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        secure: false,
      },
    ]);
    const VIEWER_ID = '00000000-0000-4000-8000-00000000b701';
    await page.route('**/api/v1/members?**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [{ ...AGENT_MEMBER, userId: VIEWER_ID, role: 'viewer' }],
          page: { limit: 100, cursor: null, has_more: false },
        }),
      });
    });
    await page.route('**/api/v1/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/v1/members')) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
      });
    });

    await page.goto(`/he/members/${VIEWER_ID}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // Read-only preset text; no capability checkboxes for a viewer.
    await expect(page.getByText(/צופה — קריאה בלבד/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('checkbox', { name: 'צפייה בבעלי דירות' })).toHaveCount(0);
  });
});
