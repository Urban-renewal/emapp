/**
 * Real-DB spec for the `getOrgSettings` DB resolver (P1-1 org-settings seam).
 *
 * The resolver is a thin SELECT wrapper: it reads `organizations.settings`
 * (jsonb) for the current org inside the caller's `withTenant` tx and delegates
 * the parse/merge to the pure `resolveOrgSettings`. There are exactly TWO
 * branches to pin, and this spec drives BOTH against a real, RLS-scoped row —
 * no mocking of the tx (a hand-mocked drizzle query chain would only re-assert
 * the mock's own return value and hide whether the SELECT/branch wiring is
 * real). The pure merge logic itself is covered exhaustively in
 * `@emapp/shared-types`'s `org-settings.spec.ts`; here we assert the resolver
 * faithfully (a) returns DEFAULT_ORG_SETTINGS for a MISSING row, and (b) feeds
 * the STORED jsonb through `resolveOrgSettings` for a PRESENT row — including
 * the fail-soft (per-namespace) degradation on a malformed stored blob.
 *
 * Written by the TEST-AUTHOR agent — independent of the builder.
 */
import { randomUUID } from 'node:crypto';

import { organizations, withTenant } from '@emapp/db';
import { DEFAULT_ORG_SETTINGS } from '@emapp/shared-types';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestOrg, type TestOrg } from '../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../packages/db/test/setup';

import { getOrgSettings } from './org-settings.resolver';

let org: TestOrg;

/** Replace `organizations.settings` for `org` (RLS-scoped via withTenant). */
async function setOrgSettings(value: Record<string, unknown>): Promise<void> {
  await withTenant(org.id, async (tx) => {
    await tx.update(organizations).set({ settings: value }).where(eq(organizations.id, org.id));
  });
}

beforeAll(async () => {
  await setupTestDatabase();
  org = await createTestOrg(`OrgSettingsResolver ${randomUUID().slice(0, 8)}`);
});

afterAll(async () => {
  // Reset to the column default so the row doesn't leak custom settings into
  // any other suite that happens to read this org (defensive; orgs are unique).
  await setOrgSettings({});
});

describe('getOrgSettings — branch (a): MISSING org row → DEFAULT_ORG_SETTINGS', () => {
  it('a non-existent org id (no row visible) returns the exact default tree, no throw', async () => {
    // RLS scopes the SELECT to the tx's org; a DIFFERENT random id yields no
    // row → the resolver's `if (!row) return DEFAULT_ORG_SETTINGS` branch.
    const missingId = randomUUID();
    const resolved = await withTenant(org.id, (tx) => getOrgSettings(tx, missingId));
    expect(resolved).toEqual(DEFAULT_ORG_SETTINGS);
    // Spot-check a few concrete leaves (not just deep-equal-to-itself):
    expect(resolved.locale).toBe('he');
    expect(resolved.signatures.linkTtlDays).toBe(7);
    expect(resolved.limits.bulkCap).toBe(200);
  });
});

describe('getOrgSettings — branch (b): PRESENT row → resolveOrgSettings(row.settings)', () => {
  it('empty stored settings ({} column default) → full default tree', async () => {
    await setOrgSettings({});
    const resolved = await withTenant(org.id, (tx) => getOrgSettings(tx, org.id));
    expect(resolved).toEqual(DEFAULT_ORG_SETTINGS);
  });

  it('a partial/override stored value → correctly-resolved deep-merge (overrides applied, siblings default)', async () => {
    await setOrgSettings({
      locale: 'en',
      signatures: { linkTtlDays: 30 },
      limits: { defaultPageSize: 50 },
    });
    const resolved = await withTenant(org.id, (tx) => getOrgSettings(tx, org.id));
    // overrides honored:
    expect(resolved.locale).toBe('en');
    expect(resolved.signatures.linkTtlDays).toBe(30);
    expect(resolved.limits.defaultPageSize).toBe(50);
    // sibling leaves / namespaces filled from defaults (deep-merge):
    expect(resolved.signatures.channels).toEqual(['sms', 'email', 'whatsapp']);
    expect(resolved.limits.bulkCap).toBe(200);
    expect(resolved.timezone).toBe('Asia/Jerusalem');
    expect(resolved.consent.tama38_1).toBe(66);
  });

  it('a MALFORMED stored namespace fails SOFT per-namespace (no throw): bad namespace reverts, valid sibling survives', async () => {
    // `signatures.linkTtlDays` is a string → the signatures namespace reverts to
    // its default; the valid `locale:'en'` sibling MUST survive (per-namespace
    // fallback, not whole-tree, and definitely not a throw / 500).
    await setOrgSettings({ locale: 'en', signatures: { linkTtlDays: 'abc' } });

    let resolved!: Awaited<ReturnType<typeof getOrgSettings>>;
    await expect(
      withTenant(org.id, async (tx) => {
        resolved = await getOrgSettings(tx, org.id);
      }),
    ).resolves.not.toThrow();

    // valid sibling survived:
    expect(resolved.locale).toBe('en');
    // malformed namespace reverted to its own default (both leaves):
    expect(resolved.signatures.linkTtlDays).toBe(7);
    expect(resolved.signatures.channels).toEqual(['sms', 'email', 'whatsapp']);
  });

  it('a top-level non-object stored blob (array) → fail-soft to the FULL default tree (outermost catch)', async () => {
    // jsonb can legally hold a top-level array; the resolver must not throw and
    // must degrade to all-defaults (the schema's outermost `.catch`).
    await setOrgSettings([{ locale: 'en' }] as unknown as Record<string, unknown>);
    const resolved = await withTenant(org.id, (tx) => getOrgSettings(tx, org.id));
    expect(resolved).toEqual(DEFAULT_ORG_SETTINGS);
  });
});
