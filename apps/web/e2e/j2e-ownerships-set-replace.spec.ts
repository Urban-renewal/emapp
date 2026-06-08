/**
 * §E-J2e — Ownerships set-replace (D.25 LAW, sum=100). FINAL STEP
 * of the J2 hierarchy.
 *
 * Wave 1 slice 12 — closes MATRIX-V2 §7 item #2.
 *
 * D.25 LAW pinned:
 *   - Composition is **atomic per apartment** (set-replace).
 *   - The wire shape is a SINGLE PUT `/api/v1/apartments/:id/ownerships`
 *     with body `{ owners: [{ ownerId, ownershipPct }] }` — NOT N
 *     separate POSTs.
 *   - Sum MUST equal 100 (or the rows array is empty — "no
 *     ownerships"). The FE pre-validates via
 *     `SetOwnershipsInput.safeParse` before fetching.
 *
 * D.17 cells exercised:
 *   - `ownerships.update` (Manager-only PUT).
 *
 * 5-axis TUVAS:
 *   T — pre-seed Manager cookies; stub current=[] + catalog=[1 owner];
 *       click "Add row", set 100%, click Save.
 *   U — URL stays on /he/apartments/<id>/ownerships during edit;
 *       redirects to /he/apartments/<id> after save.
 *   V — empty-state copy "אין בעלויות פעילות כרגע" hidden after
 *       Add Row; save button enabled when sum=100.
 *   A — exactly one PUT to /apartments/<id>/ownerships; body matches
 *       SetOwnershipsInput shape (`{ owners: [{ ownerId, ownershipPct }] }`).
 *   S — console clean.
 */
import { test, expect } from './fixtures';

const APT_ID = '00000000-0000-4000-8000-a070a070a001';
const OWNER_ID = '00000000-0000-4000-8000-000000770044';
const OWNER_NAME = 'דנה כהן';
const ORG_ID = '00000000-0000-4000-8000-000000000002';

test.describe('§E-J2e — Ownerships set-replace (D.25 sum=100)', () => {
  test('1) Manager adds 1 owner @ 100% → single PUT → redirect to apt', async ({
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

    let putCount = 0;
    let putBody: string | null = null;

    // Benign catch-all.
    await page.route('**/api/v1/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], page: { limit: 25, cursor: null, has_more: false } }),
      });
    });

    // GET current ownerships → empty (no rows yet).
    await page.route(`**/api/v1/apartments/${APT_ID}/owners`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [] }),
      });
    });

    // GET owners catalog → 1 owner (Dana).
    const now = new Date().toISOString();
    await page.route('**/api/v1/owners?**', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              id: OWNER_ID,
              organizationId: ORG_ID,
              name: OWNER_NAME,
              email: null,
              nationalIdMasked: '•••••••44',
              phoneMasked: null,
              notes: null,
              createdAt: now,
              updatedAt: now,
              archivedAt: null,
            },
          ],
          page: { limit: 100, cursor: null, has_more: false },
        }),
      });
    });

    // PUT — the call we OWN. D.25 set-replace.
    await page.route(`**/api/v1/apartments/${APT_ID}/ownerships`, async (route) => {
      if (route.request().method() !== 'PUT') {
        await route.fallback();
        return;
      }
      putCount += 1;
      putBody = route.request().postData();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            {
              ownerId: OWNER_ID,
              ownerName: OWNER_NAME,
              ownershipPct: 100,
            },
          ],
        }),
      });
    });

    // GET apartment detail (post-redirect).
    await page.route(`**/api/v1/apartments/${APT_ID}`, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      const t = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: {
            id: APT_ID,
            buildingId: '00000000-0000-4000-8000-b000b000b001',
            number: '3א',
            floor: 2,
            sizeSqm: 85,
            rooms: 4,
            status: 'pending',
            statusChangedAt: t,
            lastContactAt: null,
            notes: null,
            // V11 F1 fix (Track B PR #118) — ApartmentSchema gained 3
            // fields from migration 0035 (D.39). DB defaults used here.
            unitType: 'apt',
            areaSqm: null,
            entrance: null,
            createdAt: t,
            updatedAt: t,
            archivedAt: null,
          },
        }),
      });
    });

    await page.goto(`/he/apartments/${APT_ID}/ownerships`);

    // §AXIS-V — empty-state copy is visible initially.
    await expect(page.getByText(/אין בעלויות פעילות כרגע/)).toBeVisible({
      timeout: 15_000,
    });

    // §AXIS-T — click "Add row" (HE: "הוסף שורה"). The FE auto-picks
    // the first uncovered owner from the catalog.
    await page.getByRole('button', { name: 'הוסף שורה' }).click();

    // §AXIS-V — empty-state copy now hidden (the row is present).
    await expect(page.getByText(/אין בעלויות פעילות כרגע/)).toBeHidden();

    // §AXIS-T — set percentage to 100. The input is a number input
    // with aria-label that we don't reliably know in HE; use the
    // row's number input directly.
    const pctInput = page.locator('input[type="number"][step="0.01"]');
    await expect(pctInput).toBeVisible();
    await pctInput.fill('100');

    // §AXIS-T — click Save (HE: "שמור").
    await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url().endsWith(`/api/v1/apartments/${APT_ID}/ownerships`) &&
          r.request().method() === 'PUT',
        { timeout: 10_000 },
      ),
      page.getByRole('button', { name: 'שמור' }).click(),
    ]);

    // §AXIS-A — exactly one PUT; body matches D.25 shape. Feature A:
    // each entry now carries `relationship` ('owner' for a 100% holder).
    expect(putCount, 'exactly one PUT — atomic set-replace').toBe(1);
    const body = JSON.parse(putBody ?? '{}') as Record<string, unknown>;
    expect(body['owners']).toEqual([
      { ownerId: OWNER_ID, ownershipPct: 100, relationship: 'owner' },
    ]);
    // Sum invariant — proved by the BE's expected response shape +
    // the FE's `safeParse` before the PUT. We re-assert here:
    const owners = body['owners'] as Array<{ ownershipPct: number }>;
    const sum = owners.reduce((a, o) => a + o.ownershipPct, 0);
    expect(sum, 'D.25 LAW — sum MUST equal 100').toBe(100);

    // §AXIS-U — landed on apartment detail.
    await page.waitForURL(new RegExp(`/he/apartments/${APT_ID}$`), { timeout: 10_000 });
    expect(page.url()).toMatch(new RegExp(`/he/apartments/${APT_ID}$`));

    expect(consoleErrors.count, 'no console errors during save').toBe(0);
  });
});
