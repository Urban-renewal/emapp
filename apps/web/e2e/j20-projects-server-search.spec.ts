/**
 * E-J20 -- NS6 (MASTER-PLAN-V13 Wave C): projects-list SERVER-SIDE search.
 *
 * Proves the client-side .filter() is GONE and the search box + status/segment
 * filters now drive the merged NS1 endpoint (GET /projects?q=&status=&segment=,
 * keyset). The 4-axis DOD-BROWSER-SMOKE for the search interaction:
 *
 *   T -- pre-seed Manager cookie; stub the projects list (GET) recording every
 *        request's query string; the first (unfiltered) load returns TWO
 *        projects, a q=<tower> request returns ONE (server-narrowed).
 *   U -- URL stays /he/projects (the search box is a CONTROLLED input -- it
 *        never navigates; no q= ever lands in the BROWSER address bar).
 *   V -- typing the tower's name re-renders to the single server-matched
 *        project; the other project disappears (server filtered it, not the
 *        client).
 *   A -- NETWORK: a debounced GET /projects?q=<tower> actually fires (the
 *        server does the search). No form GET-fallback navigation.
 *   S -- console clean (the P0-3 guardrail fixture auto-asserts).
 */
import { test, expect } from './fixtures';

const ORG_ID = '00000000-0000-4000-8000-000000000002';
const MANAGER_USER_ID = '00000000-0000-4000-8000-000000000001';
const TOWER_ID = '00000000-0000-4000-8000-000a558a0001';
const COURTYARD_ID = '00000000-0000-4000-8000-000a558a0002';
// Hebrew lives ONLY in these code string constants -- never in comments (RTL
// runs adjacent to ASCII inside comments confuse the TS scanner).
const TOWER_NAME = 'מגדל הצפון';
const COURTYARD_NAME = 'חצר המערב';
const SEARCH_TERM = 'מגדל';

function projectRow(id: string, name: string, now: string) {
  return {
    id,
    organizationId: ORG_ID,
    name,
    type: 'tama38_2',
    status: 'gathering_signatures',
    description: null,
    targetSignaturePct: null,
    startedAt: null,
    createdBy: MANAGER_USER_ID,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    // list response is ProjectListItem (Project + stats).
    buildingsCount: 0,
    unitsCount: 0,
    signaturesPendingCount: 0,
    signaturesSignedCount: 0,
    agentsCount: 0,
  };
}

test.describe('E-J20 -- projects-list server search (NS6)', () => {
  test('1) typing in the search box fires GET /projects?q= and renders the server-narrowed page', async ({
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

    const now = new Date().toISOString();
    /** Every query string the FE sent to GET /projects, in order. */
    const sentQueries: string[] = [];

    // Benign catch-all (notifications, members, ...). /me + the bare
    // /projects path fall through; the more specific query-string route below
    // takes the filtered list GET (Playwright = last-registered wins).
    await page.route('**/api/v1/**', async (route) => {
      const url = new URL(route.request().url());
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

    // NS1 server-search stub: read q from the query string and return the
    // SERVER-narrowed page. With no q both projects; with a matching q only
    // the tower. This is what proves the search is server-side: the client
    // never sees the courtyard row once q is set.
    await page.route('**/api/v1/projects?**', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      const url = new URL(route.request().url());
      sentQueries.push(url.search);
      const q = url.searchParams.get('q');
      const rows =
        q && TOWER_NAME.includes(q)
          ? [projectRow(TOWER_ID, TOWER_NAME, now)]
          : [projectRow(TOWER_ID, TOWER_NAME, now), projectRow(COURTYARD_ID, COURTYARD_NAME, now)];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: rows,
          page: { limit: 25, cursor: null, has_more: false },
        }),
      });
    });

    await page.goto('/he/projects');

    // AXIS-V -- initial unfiltered load shows BOTH projects.
    await expect(page.getByText(TOWER_NAME)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(COURTYARD_NAME)).toBeVisible();

    // Type a name substring into the controlled search box.
    const searchBox = page.getByRole('searchbox');
    await searchBox.fill(SEARCH_TERM);

    // AXIS-A (network) -- the debounced server GET carrying q fires.
    await expect
      .poll(() =>
        sentQueries.some(
          (s) => s.includes('q=') && decodeURIComponent(s).includes(SEARCH_TERM),
        ),
      )
      .toBe(true);

    // AXIS-V -- the page now shows ONLY the server-matched tower; the courtyard
    // is gone because the SERVER filtered it (not a client-side filter).
    await expect(page.getByText(TOWER_NAME)).toBeVisible();
    await expect(page.getByText(COURTYARD_NAME)).toBeHidden();

    // AXIS-U -- the search never navigates; URL stays put, no q= in the bar.
    expect(page.url()).toMatch(/\/he\/projects$/);

    // AXIS-S -- console clean (fixture auto-asserts at afterEach).
    expect(consoleErrors.count, 'no console errors on projects search').toBe(0);
  });
});
