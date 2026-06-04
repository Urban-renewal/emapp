/**
 * §E-J8 — Agent assigned-only project visibility.
 *
 * Wave 1 slice 8 — covers MATRIX-V2 §7 item #8: "Agent — Assigned-
 * only visibility (sees only assigned projects/tasks)".
 *
 * The BE filters the projects list to assignments for Agent role
 * (services/projects.service.ts via project_assignments JOIN). The
 * FE just renders what comes back. This test pins:
 *
 *   1. Agent sees the SAME list shape (D.16 envelope) as Manager —
 *      no special handling required.
 *   2. The page shows the (subset) items the BE returned, NOT the
 *      full org's projects.
 *   3. The "create" CTA is still visible (FE doesn't gate; BE
 *      rejects on POST — Manager-only per D.17).
 *
 * Scope note: a contractual test of "Agent never sees Manager-only
 * Org A project N+1" would require a stateful mock that knows the
 * agent's assignments. We pin the simpler invariant: whatever the
 * BE returns IS what the page renders, no FE-side post-filter that
 * could either over- or under-show.
 *
 * D.17 cells exercised:
 *   - `projects.read` (Agent: assigned-only — record-scoped at BE).
 *
 * 5-axis TUVAS:
 *   T — pre-seed Agent cookies; stub /projects with 1-item list.
 *   U — URL = /he/projects throughout.
 *   V — exactly the stubbed project's name visible; the "create"
 *       CTA visible (FE-gating absent today).
 *   A — exactly one GET /projects (no second call probing for more).
 *   S — console clean.
 */
import { test, expect } from './fixtures';

const ASSIGNED_PROJECT_ID = '00000000-0000-4000-8000-000a558aaaaa';
const ASSIGNED_PROJECT_NAME = 'תמ"א 38 — דירת הסוכן';
const ORG_ID = '00000000-0000-4000-8000-000000000002';
const AGENT_USER_ID = '00000000-0000-4000-8000-000000000003';

test.describe('§E-J8 — Agent assigned-only projects', () => {
  test('1) Agent → /he/projects shows the BE-filtered subset', async ({
    page,
    context,
    consoleErrors,
  }) => {
    await context.addCookies([
      {
        name: 'access_token',
        value: 'e2e-agent-access-jwt',
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        secure: false,
      },
    ]);

    let projectsListCalls = 0;
    const now = new Date().toISOString();

    // Benign catch-all.
    await page.route('**/api/v1/**', async (route) => {
      const url = new URL(route.request().url());
      // /me must reach the mock-backend (role's effective permissions for the
      // slice-5b client-side gating); /projects is stubbed below.
      if (url.pathname === '/api/v1/me' || url.pathname === '/api/v1/projects') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
      });
    });

    // Stub the LIST endpoint to return ONE project — what the BE
    // would return for this agent's assignments. Manager would see
    // more; we don't pin Manager's perspective here (that's J2-flow).
    await page.route('**/api/v1/projects?**', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      projectsListCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: ASSIGNED_PROJECT_ID,
              organizationId: ORG_ID,
              name: ASSIGNED_PROJECT_NAME,
              type: 'tama38_2',
              status: 'gathering_signatures',
              description: null,
              targetSignaturePct: null,
              startedAt: null,
              createdBy: AGENT_USER_ID,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
              // list/get responses are ProjectListItem (Project + stats) —
              // the FE parses ProjectListItemSchema, so the mock must carry them.
              buildingsCount: 0,
              unitsCount: 0,
              signaturesPendingCount: 0,
              signaturesSignedCount: 0,
              agentsCount: 0,
            },
          ],
          page: { limit: 25, cursor: null, has_more: false },
        }),
      });
    });

    await page.goto('/he/projects');

    // §AXIS-V — the stubbed project's name renders.
    await expect(page.getByText(ASSIGNED_PROJECT_NAME)).toBeVisible({ timeout: 15_000 });

    // §AXIS-V — exactly ONE project row in the list (matches the
    // BE-filtered subset; no FE-side duplication).
    const projectLinks = page.getByRole('link', { name: /תמ"א/ });
    await expect(projectLinks).toHaveCount(1);

    // §AXIS-V — the "create project" CTA is HIDDEN for an Agent. IAM slice 5b
    // gates it on the `projects.create` permission, which the Agent role does
    // NOT hold — so the FE no longer renders a dead control that 403s on click
    // (the DV-ORG-9 class). The project name + the count-of-1 above are the
    // render-proof. The HE label is "צור פרויקט" (messages/he.json).
    await expect(page.getByRole('link', { name: 'צור פרויקט' })).toBeHidden();

    // §AXIS-U — URL stays on /he/projects.
    expect(page.url()).toMatch(/\/he\/projects$/);

    // §AXIS-A — the BE was called once. TanStack Query may retry
    // 4xx (per query-provider.tsx:35 — see J10 fix), but 200s have
    // no retry. One call = one render.
    expect(projectsListCalls, 'exactly one GET /projects (no double-fetch)').toBe(1);

    // §AXIS-S (console) — fixture auto-asserts.
    expect(consoleErrors.count, 'no console errors on agent projects page').toBe(0);
  });
});
