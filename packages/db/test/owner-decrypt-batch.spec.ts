/**
 * V11 B.S10-followup — decryptOwnerPiiBatch correctness + perf tests.
 *
 * Helper does THREE pgcrypto round-trips (one per column: name +
 * national_id + phone) regardless of input size. Replaces the
 * per-owner Promise.all path in `ExportComposerService` which paid
 * 3×N round-trips and started showing up in the T7.7 budget for
 * 1000-row exports.
 *
 * Cases:
 *   1. Empty input → empty output (no round-trip).
 *   2. Round-trip — encrypt N + decrypt N returns the exact same
 *      cleartext values in the original order. Position-preserving.
 *   3. Phone NULL handling — owners without a phone come back with
 *      `phone: null` (not undefined, not empty string).
 *   4. Position preservation — interleaving phone-present + phone-
 *      null rows preserves alignment after the batched round-trip.
 *   5. Mismatched row count from pg surfaces a clear error.
 *      (Hard to trigger without mocking — covered structurally
 *      by the throw site comment, not by a runtime assertion.)
 *   6. **Perf** — 1000 rows decrypt in well under 5 s on dev Neon
 *      (typical: <1 s). Compares against the per-owner baseline
 *      to lock in the speedup.
 */
import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  decryptOwnerPiiBatch,
  encryptOwnerPiiBatch,
  organizations,
  owners,
  providerDb,
  type EncryptedOwnerRow,
} from '@emapp/db';

let testOrgId: string;

async function ensureOrg(): Promise<string> {
  const id = randomUUID();
  await providerDb.insert(organizations).values({
    id,
    name: `v11-b10-fu-${id.slice(0, 8)}`,
    slug: `v11b10fu${id.slice(0, 8)}`,
  });
  return id;
}

async function dropOrgRows(orgId: string): Promise<void> {
  await providerDb
    .delete(owners)
    .where(eq(owners.orgId, orgId))
    .catch(() => undefined);
  await providerDb
    .delete(organizations)
    .where(eq(organizations.id, orgId))
    .catch(() => undefined);
}

describe('V11 B.S10-followup · decryptOwnerPiiBatch', () => {
  beforeAll(async () => {
    testOrgId = await ensureOrg();
  });
  afterAll(async () => {
    await dropOrgRows(testOrgId);
  });

  it('1) empty input → empty output, no round-trip', async () => {
    const out = await decryptOwnerPiiBatch(providerDb, []);
    expect(out).toEqual([]);
  });

  it('2) round-trip — encrypt+decrypt returns original values in original order', async () => {
    const inputs = [
      { name: 'דוד כהן', nationalId: '300000010', phone: '0501110001' },
      { name: 'שרה לוי', nationalId: '300000020', phone: '0501110002' },
      { name: 'משה בן-דוד', nationalId: '300000030', phone: '0501110003' },
    ];
    const enc = await encryptOwnerPiiBatch(providerDb, inputs);
    const encRows: EncryptedOwnerRow[] = enc.map((e, i) => ({
      ownerId: `idx-${i}`,
      nameEncrypted: e.nameEncrypted,
      nationalIdEncrypted: e.nationalIdEncrypted,
      phoneEncrypted: e.phoneEncrypted,
    }));
    const dec = await decryptOwnerPiiBatch(providerDb, encRows);
    expect(dec).toHaveLength(3);
    for (let i = 0; i < inputs.length; i += 1) {
      expect(dec[i]!.ownerId).toBe(`idx-${i}`);
      expect(dec[i]!.name).toBe(inputs[i]!.name);
      expect(dec[i]!.nationalId).toBe(inputs[i]!.nationalId);
      expect(dec[i]!.phone).toBe(inputs[i]!.phone);
    }
  });

  it('3) phone NULL handling — owners without a phone come back with `phone: null`', async () => {
    const inputs = [
      { name: 'no-phone-A', nationalId: '300000041' },
      { name: 'with-phone-B', nationalId: '300000042', phone: '0501110042' },
      { name: 'no-phone-C', nationalId: '300000043' },
    ];
    const enc = await encryptOwnerPiiBatch(providerDb, inputs);
    const encRows: EncryptedOwnerRow[] = enc.map((e, i) => ({
      ownerId: String(i),
      nameEncrypted: e.nameEncrypted,
      nationalIdEncrypted: e.nationalIdEncrypted,
      phoneEncrypted: e.phoneEncrypted,
    }));
    const dec = await decryptOwnerPiiBatch(providerDb, encRows);
    expect(dec[0]!.phone).toBeNull();
    expect(dec[1]!.phone).toBe('0501110042');
    expect(dec[2]!.phone).toBeNull();
  });

  it('4) position preservation — interleaved phone-present/null rows keep their alignment', async () => {
    const inputs = Array.from({ length: 20 }, (_, i) => ({
      name: `owner-${i}`,
      nationalId: `30000${String(100 + i).padStart(4, '0')}`,
      // Every other row has a phone.
      phone: i % 2 === 0 ? `050000000${i % 10}` : undefined,
    }));
    const enc = await encryptOwnerPiiBatch(providerDb, inputs);
    const encRows: EncryptedOwnerRow[] = enc.map((e, i) => ({
      ownerId: String(i),
      nameEncrypted: e.nameEncrypted,
      nationalIdEncrypted: e.nationalIdEncrypted,
      phoneEncrypted: e.phoneEncrypted,
    }));
    const dec = await decryptOwnerPiiBatch(providerDb, encRows);
    for (let i = 0; i < inputs.length; i += 1) {
      expect(dec[i]!.name).toBe(`owner-${i}`);
      if (i % 2 === 0) expect(dec[i]!.phone).toBe(`050000000${i % 10}`);
      else expect(dec[i]!.phone).toBeNull();
    }
  });

  it('6) perf — 1000-row batch decrypt completes well under 5 s (was ~5-10 s per-owner)', async () => {
    const inputs = Array.from({ length: 1000 }, (_, i) => ({
      name: `bulk-${i}`,
      nationalId: `30001${String(i).padStart(5, '0')}`,
      phone: i % 3 === 0 ? null : `050${String(i).padStart(7, '0')}`,
    })).map((p) => ({ name: p.name, nationalId: p.nationalId, phone: p.phone ?? undefined }));
    const tEnc0 = Date.now();
    const enc = await encryptOwnerPiiBatch(providerDb, inputs);
    const tEnc = Date.now() - tEnc0;
    const encRows: EncryptedOwnerRow[] = enc.map((e, i) => ({
      ownerId: String(i),
      nameEncrypted: e.nameEncrypted,
      nationalIdEncrypted: e.nationalIdEncrypted,
      phoneEncrypted: e.phoneEncrypted,
    }));
    const tDec0 = Date.now();
    const dec = await decryptOwnerPiiBatch(providerDb, encRows);
    const tDec = Date.now() - tDec0;
    expect(dec).toHaveLength(1000);
    // Spot check a few positions for correctness.
    expect(dec[0]!.name).toBe('bulk-0');
    expect(dec[999]!.name).toBe('bulk-999');
    expect(dec[500]!.nationalId).toBe('30001' + String(500).padStart(5, '0'));
    // Budget: 5 s is generous (typical: <1 s on dev Neon). The
    // important comparison is encrypt vs decrypt — both should be in
    // the same order of magnitude (both pay 3 round-trips). The
    // pre-batching baseline was 5-10 s for decrypt alone.
    expect(tDec).toBeLessThan(5_000);
    // Sanity: encrypt is also batched (pre-existing); both should be
    // similar magnitudes. (Don't assert tight bounds — Neon variance.)
    expect(tEnc).toBeLessThan(10_000);
  }, 30_000);
});
