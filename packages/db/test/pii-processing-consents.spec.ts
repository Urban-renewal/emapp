/**
 * P0.C2 — pii_processing_consents: the privacy-notice acknowledgment trail.
 *
 * Pins the four invariants the compliance feature depends on:
 *  C1  A consent record is recorded (INSERT works through withTenant) and
 *      references the notice VERSION + a notice HASH it was given against.
 *  C2  APPEND-ONLY / IMMUTABLE — app_user cannot UPDATE or DELETE a row
 *      (migration 0059 REVOKEs both). A consent, once given, is forensic.
 *  C3  TENANT-ISOLATED — FORCE RLS scopes reads/writes to the org GUC; org A
 *      cannot read org B's consents, and cannot INSERT with org B's org_id.
 *  C4  Provenance columns (ip / user_agent / method) round-trip and carry NO
 *      new PII (only refs + request provenance).
 */
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  db,
  encryptOwnerName,
  owners,
  piiProcessingConsents,
  pool,
  providerDb,
  withTenant,
} from '@emapp/db';

import { createTestOrg, type TestOrg } from './factories';
import { setupTestDatabase } from './setup';

/** A minimal owner per org. Names are pgcrypto-encrypted; we mint ciphertext
 *  via the shipped `encryptOwnerName` helper and insert through the BYPASSRLS
 *  providerDb (this is test fixture setup, not the path under test). */
async function createOwner(org: TestOrg): Promise<string> {
  const { nameEncrypted, nameHash } = await encryptOwnerName(providerDb, 'Test Owner');
  const [row] = await providerDb
    .insert(owners)
    .values({
      orgId: org.id,
      nameEncrypted,
      nameHash,
      nationalIdEncrypted: Buffer.from('placeholder'),
      nationalIdHash: `nid-${org.id}`,
    })
    .returning({ id: owners.id });
  return row!.id;
}

describe('P0.C2 — pii_processing_consents', () => {
  let orgA: TestOrg;
  let orgB: TestOrg;
  let ownerA: string;
  let ownerB: string;

  beforeAll(async () => {
    await setupTestDatabase();
    orgA = await createTestOrg(`C2-OrgA-${Date.now()}`, `c2-orga-${Date.now()}`);
    orgB = await createTestOrg(`C2-OrgB-${Date.now()}`, `c2-orgb-${Date.now()}`);
    ownerA = await createOwner(orgA);
    ownerB = await createOwner(orgB);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('C1 — records a consent referencing the notice version + hash', async () => {
    const [row] = await withTenant(orgA.id, async (tx) =>
      tx
        .insert(piiProcessingConsents)
        .values({
          orgId: orgA.id,
          ownerId: ownerA,
          noticeVersion: 'v1',
          noticeHash: 'a'.repeat(64),
          method: 'public_sign_v1',
          consentIp: '203.0.113.7',
          consentUserAgent: 'vitest-UA',
        })
        .returning(),
    );
    expect(row?.noticeVersion).toBe('v1');
    expect(row?.noticeHash).toBe('a'.repeat(64));
    expect(row?.method).toBe('public_sign_v1');
    expect(row?.ownerId).toBe(ownerA);

    // C4 — provenance round-trips.
    const [read] = await withTenant(orgA.id, async (tx) =>
      tx.select().from(piiProcessingConsents).where(eq(piiProcessingConsents.id, row!.id)),
    );
    expect(read?.consentUserAgent).toBe('vitest-UA');
    expect(String(read?.consentIp)).toContain('203.0.113.7');
  });

  it('C2 — APPEND-ONLY: app_user cannot UPDATE a consent', async () => {
    const [row] = await withTenant(orgA.id, async (tx) =>
      tx
        .insert(piiProcessingConsents)
        .values({
          orgId: orgA.id,
          ownerId: ownerA,
          noticeVersion: 'v1',
          noticeHash: 'b'.repeat(64),
          method: 'public_sign_v1',
        })
        .returning(),
    );
    await expect(
      withTenant(orgA.id, async (tx) =>
        tx
          .update(piiProcessingConsents)
          .set({ noticeVersion: 'tampered' })
          .where(eq(piiProcessingConsents.id, row!.id)),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('C2 — APPEND-ONLY: app_user cannot DELETE a consent', async () => {
    const [row] = await withTenant(orgA.id, async (tx) =>
      tx
        .insert(piiProcessingConsents)
        .values({
          orgId: orgA.id,
          ownerId: ownerA,
          noticeVersion: 'v1',
          noticeHash: 'c'.repeat(64),
          method: 'public_sign_v1',
        })
        .returning(),
    );
    await expect(
      withTenant(orgA.id, async (tx) =>
        tx.delete(piiProcessingConsents).where(eq(piiProcessingConsents.id, row!.id)),
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('C3 — TENANT-ISOLATED: org A cannot read org B consents', async () => {
    const [bRow] = await withTenant(orgB.id, async (tx) =>
      tx
        .insert(piiProcessingConsents)
        .values({
          orgId: orgB.id,
          ownerId: ownerB,
          noticeVersion: 'v1',
          noticeHash: 'd'.repeat(64),
          method: 'public_sign_v1',
        })
        .returning(),
    );

    const seenByA = await withTenant(orgA.id, async (tx) =>
      tx.select().from(piiProcessingConsents).where(eq(piiProcessingConsents.id, bRow!.id)),
    );
    expect(seenByA).toHaveLength(0);

    // org B still sees its own.
    const seenByB = await withTenant(orgB.id, async (tx) =>
      tx.select().from(piiProcessingConsents).where(eq(piiProcessingConsents.id, bRow!.id)),
    );
    expect(seenByB).toHaveLength(1);
  });

  it('C3 — TENANT-ISOLATED: org A cannot INSERT with org B org_id (WITH CHECK)', async () => {
    await expect(
      withTenant(orgA.id, async (tx) =>
        tx.insert(piiProcessingConsents).values({
          orgId: orgB.id,
          ownerId: ownerB,
          noticeVersion: 'v1',
          noticeHash: 'e'.repeat(64),
          method: 'public_sign_v1',
        }),
      ),
    ).rejects.toThrow();
  });

  it('C3 — confirms the raw BYPASSRLS pool sees all orgs (sanity, not a leak)', async () => {
    // The app pool (withTenant) is scoped; the raw db pool is BYPASSRLS by
    // design (used only for migrations/auth). This asserts our isolation test
    // above is meaningful — the rows DO exist cross-org, RLS just hides them.
    const all = await db
      .select({ orgId: piiProcessingConsents.orgId })
      .from(piiProcessingConsents)
      .where(
        and(
          eq(piiProcessingConsents.method, 'public_sign_v1'),
          eq(piiProcessingConsents.noticeHash, 'd'.repeat(64)),
        ),
      );
    expect(all.length).toBeGreaterThan(0);
  });
});
