/**
 * D.37 / Phase 6.5 — `GET /provider/tenants` (list) integration spec.
 *
 * Service-level: instantiates `ProviderTenantsService` directly with
 * the real Neon dev DB. Hits `withProvider` on every call → exercises
 * BYPASSRLS, the audit row write, and the cursor pagination math
 * end-to-end (same pattern imports.s8.spec.ts uses for the org tier).
 *
 * Test IDs mapped to D.33:
 *   T6.5-D37-1   cross-tenant visibility (Provider sees both A + B)
 *   T6.5-D37-2a  cursor pagination — limit=1 → second page
 *   T6.5-D37-2b  cursor pagination — full walk yields every row exactly once
 *   T6.5-D37-2c  invalid cursor → 400 invalid_cursor
 *   T6.5-D37-2d  empty result set (no orgs visible) — well-formed envelope
 *   T6.5-D37-3   audit row content (action / metadata.reason / metadata.endpoint)
 *   T6.5-D37-3b  counts correctness (users / projects / owners)
 *   T6.5-D37-3c  archived orgs ARE visible to Provider (different from org tier)
 *   T6.5-D37-3d  cursor row is NOT re-emitted (strict-less-than predicate)
 */
import { randomUUID } from 'node:crypto';

import { owners, encryptOwnerPii, withTenant } from '@emapp/db';
import { BadRequestException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import {
  createTestOrg,
  createTestProviderUser,
  type TestProviderUser,
} from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';

import type { ProviderPrincipal } from './current-provider.decorator';
import { ProviderTenantsService } from './provider-tenants.service';

let provider: TestProviderUser;
let svc: ProviderTenantsService;
// Two orgs created at suite start — guaranteed cross-tenant visibility.
const TEST_PREFIX = 'p65-2-' + Date.now();
let orgA: { id: string };
let orgB: { id: string };
let auditStartMarker: Date;

function principal(): ProviderPrincipal {
  // Audit v1.1 CC-4 — services consume the narrow ProviderActor
  // (sub / ip / userAgent); role / sid / type stay in the guard
  // layer and are unused by service code.
  return {
    sub: provider.id,
    ip: '203.0.113.5',
    userAgent: 'P6.5-2-spec/1.0',
  };
}

beforeAll(async () => {
  await setupTestDatabase();
  provider = await createTestProviderUser();
  svc = new ProviderTenantsService();
  // The "start marker" lets us scope audit-row queries to ONLY rows
  // written during this test run — every other parallel spec creating
  // provider_audit_log rows is invisible to us.
  auditStartMarker = new Date();
  orgA = await createTestOrg(`${TEST_PREFIX}-A`, `${TEST_PREFIX}-a`);
  orgB = await createTestOrg(`${TEST_PREFIX}-B`, `${TEST_PREFIX}-b`);
}, 60_000);

afterAll(() => {
  // pools are shared singletons — global teardown handles them
});

async function ourAuditRows(): Promise<
  Array<{
    reason: string;
    action_type: string;
    metadata: Record<string, unknown>;
    ip: string | null;
  }>
> {
  const client = await providerPool.connect();
  try {
    const r = await client.query<{
      reason: string;
      action_type: string;
      metadata: Record<string, unknown>;
      ip: string | null;
    }>(
      `SELECT reason, action_type, metadata, ip
       FROM provider_audit_log
       WHERE provider_user_id = $1 AND started_at >= $2
       ORDER BY started_at ASC`,
      [provider.id, auditStartMarker.toISOString()],
    );
    return r.rows;
  } finally {
    client.release();
  }
}

describe('GET /provider/tenants — P6.5-2 service integration', () => {
  it('T6.5-D37-1) cross-tenant visibility — Provider sees BOTH Org A and Org B (BYPASSRLS via withProvider)', async () => {
    const result = await svc.list(principal(), 'TKT-1100: cross-tenant visibility test', {
      limit: 100,
    });
    const slugs = result.data.map((t) => t.slug);
    expect(slugs).toContain(`${TEST_PREFIX}-a`);
    expect(slugs).toContain(`${TEST_PREFIX}-b`);
    // Page envelope shape (D.16)
    expect(result.page.limit).toBe(100);
    expect(typeof result.page.has_more).toBe('boolean');
  });

  it('T6.5-D37-2a) cursor pagination — limit=1 returns a single row + cursor + has_more=true', async () => {
    const first = await svc.list(principal(), 'TKT-1100: pagination test page 1', { limit: 1 });
    expect(first.data.length).toBe(1);
    expect(first.page.has_more).toBe(true);
    expect(first.page.cursor).toBeTruthy();
  });

  it(
    'T6.5-D37-2b) cursor walk yields every row exactly once across pages (no dup, no skip)',
    { timeout: 30_000 },
    async () => {
      // Walk the full list 1 page at a time, accumulate ids.
      const seen = new Set<string>();
      let cursor: string | undefined = undefined;
      let pages = 0;
      // Hard cap: shouldn't take more than 20 pages for this small dataset;
      // a runaway is a bug.
      while (pages < 20) {
        const page = await svc.list(principal(), `pagination walk page ${pages}`, {
          limit: 2,
          cursor,
        });
        for (const t of page.data) {
          // CRITICAL: no duplicates. Strict-less-than predicate guarantees this.
          expect(seen.has(t.id)).toBe(false);
          seen.add(t.id);
        }
        if (!page.page.has_more) break;
        cursor = page.page.cursor ?? undefined;
        pages += 1;
      }
      // At minimum we must have seen both of OUR test orgs.
      const orgIds = [orgA.id, orgB.id];
      for (const id of orgIds) expect(seen.has(id)).toBe(true);
    },
  );

  it('T6.5-D37-2c) invalid cursor → 400 invalid_cursor (no Provider session opened)', async () => {
    const auditBefore = (await ourAuditRows()).length;
    await expect(
      svc.list(principal(), 'TKT-1100: invalid cursor test', {
        limit: 5,
        cursor: 'not-base64url-garbage',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const auditAfter = (await ourAuditRows()).length;
    // The rejection happens BEFORE withProvider — so no audit row.
    expect(auditAfter).toBe(auditBefore);
  });

  it('T6.5-D37-2d) empty result set (filter to non-existent universe) — well-formed envelope', async () => {
    // Use a cursor pointing to "before time" — fakeable via a date
    // far in the past wouldn't work (we want to filter OUT, not IN).
    // Trick: cursor at a far-future time → no rows have createdAt > future.
    // Cursor uses strict-LESS-THAN; cursor at year 1970 → 0 rows pass.
    const past = Buffer.from(
      JSON.stringify({ c: '1970-01-01T00:00:00.000Z', i: '00000000-0000-0000-0000-000000000000' }),
    ).toString('base64url');
    const result = await svc.list(principal(), 'TKT-1100: empty page test', {
      limit: 5,
      cursor: past,
    });
    expect(result.data).toEqual([]);
    expect(result.page.has_more).toBe(false);
    expect(result.page.cursor).toBeNull();
  });

  it('T6.5-D37-3) every call writes ONE audit row with action="provider.tenant.viewed" and metadata.reason + metadata.endpoint', async () => {
    const REASON = 'audit content verification — ' + randomUUID();
    await svc.list(principal(), REASON, { limit: 5 });
    const rows = await ourAuditRows();
    const ours = rows.filter((r) => r.reason === REASON);
    expect(ours.length).toBe(1);
    expect(ours[0]!.action_type).toBe('provider.tenant.viewed');
    expect(ours[0]!.ip).toBe('203.0.113.5');
    const md = ours[0]!.metadata as {
      reason?: string;
      endpoint?: string;
      filter?: { limit?: number };
    };
    expect(md.reason).toBe(REASON);
    expect(md.endpoint).toBe('list');
    expect(md.filter?.limit).toBe(5);
  });

  it('T6.5-D37-3b) counts correctness — Org A has 1 user + 2 projects + 0 owners by default', async () => {
    // Factory's createTestOrg creates: 1 manager + 2 projects + 0 owners
    const result = await svc.list(principal(), 'TKT-1100: count correctness test', { limit: 100 });
    const a = result.data.find((t) => t.id === orgA.id);
    expect(a).toBeDefined();
    expect(a!.counts.users).toBeGreaterThanOrEqual(1);
    expect(a!.counts.projects).toBeGreaterThanOrEqual(2);
    expect(a!.counts.owners).toBe(0);
  });

  it('T6.5-D37-3b2) counts reflect changes — add an owner → count increments', async () => {
    // Seed an owner under orgA via withTenant (the only allowed path).
    await withTenant(orgA.id, async (tx) => {
      const pii = await encryptOwnerPii(tx as never, {
        nationalId: '038123456',
        name: 'test count owner',
      });
      await tx.insert(owners).values({
        orgId: orgA.id,
        nameEncrypted: pii.nameEncrypted,
        nameHash: pii.nameHash,
        nationalIdEncrypted: pii.nationalIdEncrypted,
        nationalIdHash: pii.nationalIdHash,
        phoneEncrypted: null,
        phoneHash: null,
      });
    });
    const result = await svc.list(principal(), 'TKT-1100: recount after owner insert', {
      limit: 100,
    });
    const a = result.data.find((t) => t.id === orgA.id);
    expect(a!.counts.owners).toBeGreaterThanOrEqual(1);
  });

  it('T6.5-D37-3c) archived orgs ARE visible to Provider (different from org tier — Provider sees ALL)', async () => {
    // Create + archive an org, then verify it surfaces in the list.
    const archived = await createTestOrg(`${TEST_PREFIX}-archived`, `${TEST_PREFIX}-arch`);
    const client = await providerPool.connect();
    try {
      await client.query(`UPDATE organizations SET archived_at = NOW() WHERE id = $1`, [
        archived.id,
      ]);
    } finally {
      client.release();
    }
    const result = await svc.list(principal(), 'TKT-1100: archived visibility test', {
      limit: 200,
    });
    const found = result.data.find((t) => t.id === archived.id);
    expect(found).toBeDefined();
    expect(found!.archivedAt).not.toBeNull();
  });

  it('T6.5-D37-3d) cursor row itself is NOT re-emitted on the next page (strict-less-than)', async () => {
    const first = await svc.list(principal(), 'TKT-1100: cursor exclusivity page 1', { limit: 1 });
    expect(first.data.length).toBe(1);
    const lastId = first.data[0]!.id;
    const cursor = first.page.cursor;
    expect(cursor).toBeTruthy();
    const second = await svc.list(principal(), 'TKT-1100: cursor exclusivity page 2', {
      limit: 5,
      cursor: cursor!,
    });
    // The id from page 1 MUST NOT appear in page 2.
    const secondIds = second.data.map((t) => t.id);
    expect(secondIds).not.toContain(lastId);
  });

  it('T6.5-D37-3e) tenant id is a UUID + name is non-empty (shape sanity)', async () => {
    const result = await svc.list(principal(), 'TKT-1100: shape sanity', { limit: 5 });
    for (const t of result.data) {
      expect(t.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(t.name.length).toBeGreaterThan(0);
      expect(t.slug.length).toBeGreaterThan(0);
      expect(t.createdAt).toBeInstanceOf(Date);
      expect(t.counts).toBeDefined();
      expect(typeof t.counts.users).toBe('number');
    }
  });

  it('T6.5-D37-3f) limit boundary — limit=1 + limit=100 both accepted', async () => {
    const small = await svc.list(principal(), 'TKT-1100: limit 1 test', { limit: 1 });
    expect(small.data.length).toBeLessThanOrEqual(1);
    const big = await svc.list(principal(), 'TKT-1100: limit 100 test', { limit: 100 });
    expect(big.data.length).toBeLessThanOrEqual(100);
  });
});
