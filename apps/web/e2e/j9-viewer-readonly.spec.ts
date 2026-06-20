/**
 * §E-J9 — Viewer read-only enforcement (FE sidebar gating).
 *
 * Wave 1 slice 4 — covers MATRIX-V2 §7 item #9:
 * "Viewer — Read-only enforcement (no create/edit buttons visible)".
 *
 * Scope note: per `policy.ts` + D.17, Viewer is a read-only role.
 * The BE enforces the contract via AuthorizationGuard (every write
 * returns 403). The FE adds a COSMETIC layer per Phase 4c S1/S4:
 * the sidebar HIDES the Members + Audit nav items (Manager-only)
 * from Agent and Viewer. This test pins that cosmetic gate +
 * verifies the parallel Manager case (positive control).
 *
 * What this test does NOT cover (intentionally):
 *   - Per-page "Create" buttons (e.g. projects/new, owners/new) —
 *     those are NOT FE-gated today (the projects/page.tsx renders
 *     `<Link href="/projects/new">` unconditionally; click → 403
 *     from BE → loadFailed UI). FE-gating those is a Phase 8 polish
 *     concern. If it lands, add a spec here.
 *   - The actual ACTION rejection — that's a BE unit-spec
 *     (policy.spec.ts proves D.17). The FE's job is the cosmetic.
 *
 * The mock-backend's GET /me handler differentiates roles via the
 * access_token cookie value prefix (mock-backend.ts:131-134):
 *   - 'e2e-manager-...' → SEED_MANAGER (role=manager)
 *   - 'e2e-agent-...'   → SEED_AGENT   (role=agent)
 *   - 'e2e-viewer-...'  → SEED_VIEWER  (role=viewer)
 *
 * D.17 cells exercised:
 *   - sidebar.tsx role-gating (Members/Audit links Manager-only).
 *
 * 5-axis TUVAS coverage:
 *   T — pre-seed cookies with role-prefix value; navigate /he/.
 *   U — URL clean (no PII / role markers).
 *   V — sidebar items presence/absence per role.
 *   A — no role-specific API calls (the role is determined by /me
 *       which the layout already fetches; no extra endpoint).
 *   S — console clean.
 */
import { test, expect } from './fixtures';

async function seedRoleCookie(
  context: import('@playwright/test').BrowserContext,
  role: 'manager' | 'agent' | 'viewer',
): Promise<void> {
  await context.addCookies([
    {
      name: 'access_token',
      value: `e2e-${role}-access-jwt`,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: false,
    },
  ]);
}

test.describe('§E-J9 — Sidebar role gating (Members + Audit are Manager-only)', () => {
  test('1) viewer — Members + Audit links NOT in sidebar', async ({
    page,
    context,
    consoleErrors,
  }) => {
    await seedRoleCookie(context, 'viewer');

    // Benign catch-all (notifications / etc) — return empty list so
    // the dashboard renders without 404s in the console.
    await page.route('**/api/v1/**', async (route) => {
      // Let /me reach the mock-backend — it returns the role's effective
      // PERMISSIONS, which the slice-5b client-side sidebar gating needs.
      // Everything else → empty list.
      if (/\/api\/v1\/me(\?|$)/.test(route.request().url())) return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
      });
    });

    await page.goto('/he/');

    // §AXIS-V — the role badge proves getMe() resolved to a viewer.
    // V11 A.S2 reskin moved the identity block (avatar + name + role)
    // from the topbar to the sidebar footer per partner design — the
    // role badge now lives inside the <aside> landmark (implicit
    // `complementary` role from the HTML element). Scope to that
    // landmark to avoid Playwright strict-mode violations when the
    // word "צופה" appears elsewhere on the page (e.g. members role
    // filter / phase 4c additions).
    // `exact: true` — the mock user's display name (SEED_VIEWER =
    // "ויקי צופה") ALSO contains the substring "צופה"; the bare
    // role badge is the exact match.
    await expect(page.getByRole('complementary').getByText('צופה', { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // Members + Audit are Manager-only — must NOT appear.
    // Use the locale label (Hebrew) anchored to the navigation
    // landmark so we don't accidentally match a content occurrence.
    const sidebar = page.getByRole('navigation');
    await expect(sidebar.getByRole('link', { name: 'חברי ארגון' })).toBeHidden();
    await expect(sidebar.getByRole('link', { name: 'יומן ביקורת' })).toBeHidden();

    // Provider link MUST also be hidden for non-provider roles
    // (D.37 — cosmetic seam mirroring tier separation).
    await expect(sidebar.getByRole('link', { name: 'מטה Provider' })).toBeHidden();

    // Items the Viewer DOES see (positive control — proves the
    // sidebar rendered, we're not just missing the whole nav).
    await expect(sidebar.getByRole('link', { name: 'פרויקטים' })).toBeVisible();
    await expect(sidebar.getByRole('link', { name: 'בעלי דירות' })).toBeVisible();
    await expect(sidebar.getByRole('link', { name: 'מסמכים' })).toBeVisible();

    expect(consoleErrors.count, 'no console errors on viewer dashboard').toBe(0);
  });

  test('2) agent — Members + Audit links NOT in sidebar', async ({
    page,
    context,
    consoleErrors,
  }) => {
    await seedRoleCookie(context, 'agent');

    await page.route('**/api/v1/**', async (route) => {
      // Let /me reach the mock-backend — it returns the role's effective
      // PERMISSIONS, which the slice-5b client-side sidebar gating needs.
      // Everything else → empty list.
      if (/\/api\/v1\/me(\?|$)/.test(route.request().url())) return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
      });
    });

    await page.goto('/he/');
    // Scope to sidebar landmark + exact match (see test 1 comment —
    // V11 A.S2 moved the role badge from topbar to sidebar footer;
    // display name "אבי סוכן" / "אבי אגנט" can also contain "אגנט").
    await expect(page.getByRole('complementary').getByText('אגנט', { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    const sidebar = page.getByRole('navigation');
    await expect(sidebar.getByRole('link', { name: 'חברי ארגון' })).toBeHidden();
    await expect(sidebar.getByRole('link', { name: 'יומן ביקורת' })).toBeHidden();

    expect(consoleErrors.count, 'no console errors on agent dashboard').toBe(0);
  });

  test('3) manager — POSITIVE control: Members + Audit links ARE visible', async ({
    page,
    context,
    consoleErrors,
  }) => {
    await seedRoleCookie(context, 'manager');

    await page.route('**/api/v1/**', async (route) => {
      // Let /me reach the mock-backend — it returns the role's effective
      // PERMISSIONS, which the slice-5b client-side sidebar gating needs.
      // Everything else → empty list.
      if (/\/api\/v1\/me(\?|$)/.test(route.request().url())) return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
      });
    });

    await page.goto('/he/');
    // Scope to sidebar landmark + exact match — V11 A.S2 moved the
    // role badge from topbar to sidebar footer; display name "מיכל
    // מנהלת" contains substring "מנהל" which also matches role badge.
    await expect(page.getByRole('complementary').getByText('מנהל', { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    const sidebar = page.getByRole('navigation');
    // The positive control: Manager IS supposed to see these. If
    // these assertions fail it means the role-gate flipped polarity
    // (a P0 — Manager couldn't access admin functions) AND every
    // other role test in this file is moot.
    // E2 Wave-1 IA-S2: members + audit moved into the collapsible "ניהול
    // וכלים" group — expand it, then assert the Manager CAN reach them
    // (the role-gate-polarity control is intact, just one disclosure deeper).
    await sidebar.getByRole('button', { name: 'ניהול וכלים' }).click();
    await expect(sidebar.getByRole('link', { name: 'חברי ארגון' })).toBeVisible();
    await expect(sidebar.getByRole('link', { name: 'יומן ביקורת' })).toBeVisible();

    expect(consoleErrors.count, 'no console errors on manager dashboard').toBe(0);
  });
});
