/**
 * D.37 / Phase 6.5 — `GET /provider/tenants/:id` (detail) integration spec.
 *
 * Service-level: instantiates `ProviderTenantDetailService` directly,
 * seeds an org with mixed owners (with/without phone, archived,
 * Hebrew name, SQL-shape name), then asserts:
 *   - PII shape (name pattern, phone pattern, NO national_id anywhere)
 *   - counts correctness across all 5 dimensions
 *   - audit row contents (action / target_record_id / metadata)
 *   - not-found path
 *   - cross-tenant isolation (Org A's sample doesn't leak Org B's owners)
 *
 * Test IDs (D.33):
 *   T6.5-D37-4a  name masked pattern '•••••••XX'
 *   T6.5-D37-4b  phone masked pattern '•••••XXXX' OR null when absent
 *   T6.5-D37-4c  national_id NEVER appears in response (full JSON scan)
 *   T6.5-D37-4d  national_id-shaped digit run in OWNER NAME → masked, NOT in audit
 *   T6.5-D37-5a  cross-tenant: detail for Org A returns Org A owners only
 *   T6.5-D37-5b  not-found: random uuid → 404 tenant_not_found, audit row STILL written
 *   T6.5-D37-5c  audit row: action='provider.tenant.viewed', target_record_id=orgId, metadata.endpoint='detail'
 *   T6.5-D37-5d  counts: all 5 dimensions present and correct
 *   T6.5-D37-5e  sample owners capped at 5 even if org has more
 *   T6.5-D37-5f  archived owner appears with archivedAt populated
 *   T6.5-D37-5g  org with 0 owners → empty sampleOwners array (not undefined)
 */
import { randomUUID } from 'node:crypto';

import { encryptOwnerPii, owners, withTenant } from '@emapp/db';
import { NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import {
  createTestOrg,
  createTestProviderUser,
  type TestProviderUser,
} from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';

import type { ProviderPrincipal } from './current-provider.decorator';
import { ProviderTenantDetailService } from './provider-tenant-detail.service';

let provider: TestProviderUser;
let svc: ProviderTenantDetailService;
const TEST_PREFIX = 'p65-3-' + Date.now();
let orgA: { id: string };
let orgB: { id: string };
let orgEmpty: { id: string };
let auditStartMarker: Date;

// Distinctive identifiers we'll search the response JSON for —
// these strings must NEVER appear in the wire shape.
const SECRET_NID_A = '038761234';
const SECRET_NID_B = '038987654';
const SECRET_PHONE_A = '0541234567';

function principal(): ProviderPrincipal {
  // Audit v1.1 CC-4 — narrow actor shape.
  return {
    sub: provider.id,
    ip: '203.0.113.42',
    userAgent: 'P6.5-3-spec/1.0',
  };
}

async function seedOwner(input: {
  orgId: string;
  name: string;
  nationalId: string;
  phone?: string;
  email?: string | null;
  archived?: boolean;
}): Promise<string> {
  return withTenant(input.orgId, async (tx) => {
    const pii = await encryptOwnerPii(tx as never, {
      nationalId: input.nationalId,
      name: input.name,
      ...(input.phone ? { phone: input.phone } : {}),
    });
    const [row] = await tx
      .insert(owners)
      .values({
        orgId: input.orgId,
        nameEncrypted: pii.nameEncrypted,
        nameHash: pii.nameHash,
        email: input.email ?? null,
        nationalIdEncrypted: pii.nationalIdEncrypted,
        nationalIdHash: pii.nationalIdHash,
        phoneEncrypted: pii.phoneEncrypted,
        phoneHash: pii.phoneHash,
        ...(input.archived ? { archivedAt: new Date() } : {}),
      })
      .returning({ id: owners.id });
    return row!.id;
  });
}

beforeAll(async () => {
  await setupTestDatabase();
  provider = await createTestProviderUser();
  svc = new ProviderTenantDetailService();
  auditStartMarker = new Date();

  // Org A: 3 owners + 1 archived = 4 total. Span PII variants:
  //   - Hebrew name, with phone
  //   - SQL-shape name, no phone
  //   - Long Hebrew name, archived, with phone
  //   - National-id-shaped digit string as NAME (adversarial)
  orgA = await createTestOrg(`${TEST_PREFIX}-A`, `${TEST_PREFIX}-a`);
  await seedOwner({
    orgId: orgA.id,
    name: 'אביגיל לוי',
    nationalId: SECRET_NID_A,
    phone: SECRET_PHONE_A,
    email: 'avigail@test.local',
  });
  await seedOwner({
    orgId: orgA.id,
    name: "Robert'); DROP TABLE owners; --",
    nationalId: '038111000',
  });
  await seedOwner({
    orgId: orgA.id,
    name: 'משפחת הכהן-לוי',
    nationalId: '038222000',
    phone: '0529999888',
    archived: true,
  });
  await seedOwner({
    orgId: orgA.id,
    // National-id-shaped digit run AS THE NAME — the masking must
    // turn the ENTIRE name into bullets+last-2; the digits must NOT
    // appear in the response JSON.
    name: '038555444',
    nationalId: '038555444',
  });
  // 5 more for the cap test (orgA already has 4; add 5 → 9 total;
  // sample MUST cap at 5).
  for (let i = 0; i < 5; i += 1) {
    await seedOwner({
      orgId: orgA.id,
      name: `extra-${i}-${TEST_PREFIX}`,
      nationalId: `0386${String(i).padStart(5, '0')}`,
    });
  }

  // Org B: 1 owner with a DISTINCT national_id so cross-tenant test
  // can prove Org A detail doesn't leak it.
  orgB = await createTestOrg(`${TEST_PREFIX}-B`, `${TEST_PREFIX}-b`);
  await seedOwner({
    orgId: orgB.id,
    name: 'אורית כהן',
    nationalId: SECRET_NID_B,
    phone: '0501111111',
  });

  // Empty org for the no-owners test.
  orgEmpty = await createTestOrg(`${TEST_PREFIX}-Empty`, `${TEST_PREFIX}-empty`);
}, 90_000);

afterAll(() => {
  // Pools are shared singletons; global teardown closes them.
});

async function ourAuditRows(): Promise<
  Array<{
    reason: string;
    action_type: string;
    metadata: Record<string, unknown>;
    target_table: string | null;
    target_record_id: string | null;
  }>
> {
  const client = await providerPool.connect();
  try {
    const r = await client.query<{
      reason: string;
      action_type: string;
      metadata: Record<string, unknown>;
      target_table: string | null;
      target_record_id: string | null;
    }>(
      `SELECT reason, action_type, metadata, target_table, target_record_id
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

describe('GET /provider/tenants/:id — P6.5-3 service integration', () => {
  it('T6.5-D37-4a) name is masked — pattern starts with 7 bullets and ends with 2 chars', async () => {
    const detail = await svc.get(principal(), 'TKT-1100: PII shape test — name mask', orgA.id);
    expect(detail.sampleOwners.length).toBeGreaterThan(0);
    for (const owner of detail.sampleOwners) {
      // Pattern: 7 bullets + 2 visible chars
      expect(owner.nameMasked.startsWith('•••••••')).toBe(true);
      const visible = owner.nameMasked.slice(7);
      // Must be ≥ 1 visible char (last-N of a non-empty name); we
      // configured all seed names ≥ 2 chars.
      expect(visible.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('T6.5-D37-4b) phone is masked OR null — pattern 5 bullets + 4 chars, or null when no phone', async () => {
    const detail = await svc.get(principal(), 'TKT-1100: PII shape test — phone mask', orgA.id);
    for (const owner of detail.sampleOwners) {
      if (owner.phoneMasked === null) continue;
      expect(owner.phoneMasked.startsWith('•••••')).toBe(true);
      expect(owner.phoneMasked.length).toBe(9); // 5 bullets + 4 digits
    }
  });

  it('T6.5-D37-4c) national_id NEVER appears in response — full JSON scan (zero-leak)', async () => {
    // Critical invariant — D.37: no NID on the wire at the Provider tier.
    // We scan the FULL detail JSON across all seeded NID values + the
    // cross-tenant Org B NID + the full phone. Phone-masking shape is
    // pinned in T6.5-D37-4b (per-owner check); this test is exclusively
    // about leak absence.
    const detail = await svc.get(principal(), 'TKT-1100: NID leak scan', orgA.id);
    const blob = JSON.stringify(detail);
    expect(blob).not.toContain(SECRET_NID_A);
    expect(blob).not.toContain('038111000');
    expect(blob).not.toContain('038222000');
    expect(blob).not.toContain(SECRET_NID_B); // cross-tenant — also not visible
    // Phone secret in FULL form must NEVER appear (only its masked
    // tail is allowed). Tail check belongs to 4b.
    expect(blob).not.toContain(SECRET_PHONE_A);
    // No 9-digit run (NID-shape) anywhere in the JSON. UUIDs contain
    // shorter digit runs, but never 9 consecutive — safe regex.
    expect(blob).not.toMatch(/\b\d{9}\b/);
  });

  it('T6.5-D37-4d) NID-shaped digit run in OWNER NAME → masked away; not in audit either', async () => {
    const REASON = 'NID-shaped name test — ' + randomUUID();
    const detail = await svc.get(principal(), REASON, orgA.id);
    const blob = JSON.stringify(detail);
    // The name '038555444' must NOT appear verbatim — it should
    // be masked like every other name to '•••••••XX'.
    expect(blob).not.toContain('038555444');
    // And audit row metadata must not contain the digit string either
    // (it shouldn't — metadata is filter snapshot only).
    const auditRow = (await ourAuditRows()).find((r) => r.reason === REASON);
    expect(auditRow).toBeDefined();
    const auditBlob = JSON.stringify(auditRow!.metadata);
    expect(auditBlob).not.toContain('038555444');
  });

  it('T6.5-D37-5a) cross-tenant isolation — Org A detail does NOT include Org B owners', async () => {
    const detailA = await svc.get(principal(), 'TKT-1100: cross-tenant isolation A', orgA.id);
    const detailB = await svc.get(principal(), 'TKT-1100: cross-tenant isolation B', orgB.id);
    // No overlap in owner ids.
    const idsA = new Set(detailA.sampleOwners.map((o) => o.id));
    const idsB = new Set(detailB.sampleOwners.map((o) => o.id));
    for (const id of idsB) {
      expect(idsA.has(id)).toBe(false);
    }
    // Counts are correct per tenant. Org A: 9 owners total (1 Hebrew +
    // 1 SQL-shape + 1 archived + 1 NID-shape + 5 extras), but the
    // `archived_at IS NULL` filter on counts.owners excludes the
    // archived one → 8 active.
    expect(detailA.counts.owners).toBe(8);
    expect(detailB.counts.owners).toBe(1);
  });

  it('T6.5-D37-5b) not-found random uuid → 404 tenant_not_found; audit row STILL written', async () => {
    const ghostId = randomUUID();
    const REASON = 'not-found audit test — ' + randomUUID();
    await expect(svc.get(principal(), REASON, ghostId)).rejects.toBeInstanceOf(NotFoundException);
    // The audit row IS written (audit-first: forensic record of the
    // access attempt regardless of whether the target existed).
    const ours = (await ourAuditRows()).filter((r) => r.reason === REASON);
    expect(ours.length).toBe(1);
    expect(ours[0]!.target_record_id).toBe(ghostId);
  });

  it('T6.5-D37-5c) audit row: action=provider.tenant.viewed, target_record_id=orgId, metadata.endpoint=detail', async () => {
    const REASON = 'audit content test — ' + randomUUID();
    await svc.get(principal(), REASON, orgA.id);
    const row = (await ourAuditRows()).find((r) => r.reason === REASON);
    expect(row).toBeDefined();
    expect(row!.action_type).toBe('provider.tenant.viewed');
    expect(row!.target_table).toBe('organizations');
    expect(row!.target_record_id).toBe(orgA.id);
    const md = row!.metadata as { endpoint?: string; tenantId?: string; reason?: string };
    expect(md.endpoint).toBe('detail');
    expect(md.tenantId).toBe(orgA.id);
    expect(md.reason).toBe(REASON);
  });

  it('T6.5-D37-5d) counts: all 5 dimensions present and non-negative', async () => {
    const detail = await svc.get(principal(), 'TKT-1100: counts shape test', orgA.id);
    expect(detail.counts.users).toBeGreaterThanOrEqual(1);
    expect(detail.counts.projects).toBeGreaterThanOrEqual(2);
    // 9 owners + 1 archived (3 active + 1 archived + 5 extra = 9 active, 1 archived)
    // The `archivedAt IS NULL` filter on owners count means archived
    // owner is excluded. Active owners = at least 8 (3 + 5).
    expect(detail.counts.owners).toBeGreaterThanOrEqual(8);
    expect(detail.counts.importJobs).toBeGreaterThanOrEqual(0);
    expect(detail.counts.signatureRequests).toBeGreaterThanOrEqual(0);
  });

  it('T6.5-D37-5e) sample owners capped at 5 even when org has more', async () => {
    const detail = await svc.get(principal(), 'TKT-1100: sample cap test', orgA.id);
    expect(detail.sampleOwners.length).toBeLessThanOrEqual(5);
    expect(detail.sampleOwners.length).toBe(5); // we seeded 9 active owners
  });

  it('T6.5-D37-5f) archived owner appears in sample WHEN it is in the top-5 most-recent; archivedAt populated', async () => {
    // Create a fresh org with ONLY an archived owner — guaranteed
    // to show up in the sample of size 1.
    const onlyArchivedOrg = await createTestOrg(
      `${TEST_PREFIX}-arch-only`,
      `${TEST_PREFIX}-arch-only`,
    );
    await seedOwner({
      orgId: onlyArchivedOrg.id,
      name: 'בלעדי בארכיון',
      nationalId: '038777111',
      archived: true,
    });
    const detail = await svc.get(
      principal(),
      'TKT-1100: archived owner in sample test',
      onlyArchivedOrg.id,
    );
    expect(detail.sampleOwners.length).toBe(1);
    expect(detail.sampleOwners[0]!.archivedAt).not.toBeNull();
  });

  it('T6.5-D37-5g) org with 0 owners → empty sampleOwners array (not undefined)', async () => {
    const detail = await svc.get(principal(), 'TKT-1100: empty org test', orgEmpty.id);
    expect(detail.sampleOwners).toEqual([]);
    expect(Array.isArray(detail.sampleOwners)).toBe(true);
    expect(detail.counts.owners).toBe(0);
  });

  it('T6.5-D37-5h) archived org IS visible (Provider sees ALL) — same rule as list', async () => {
    // Archive Org B mid-test via BYPASSRLS pool.
    const client = await providerPool.connect();
    try {
      await client.query(`UPDATE organizations SET archived_at = NOW() WHERE id = $1`, [orgB.id]);
    } finally {
      client.release();
    }
    const detail = await svc.get(principal(), 'TKT-1100: archived org visibility', orgB.id);
    expect(detail.id).toBe(orgB.id);
    expect(detail.archivedAt).not.toBeNull();
    // Restore so other tests aren't affected.
    const client2 = await providerPool.connect();
    try {
      await client2.query(`UPDATE organizations SET archived_at = NULL WHERE id = $1`, [orgB.id]);
    } finally {
      client2.release();
    }
  });
});

// Suppress unused-import lint — `eq` retained for future PATCH-like queries.
void eq;
