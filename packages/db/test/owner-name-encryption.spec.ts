/**
 * Owner-name encryption helpers — v8 §v8-S3 closure tests.
 *
 * Pure unit tests around encryptOwnerName / decryptOwnerName /
 * hashOwnerName plus the batch path (encryptOwnerPiiBatch) that
 * folds in the name encryption.
 *
 * Uses the real `providerDb` connection because the helpers go
 * through pgcrypto (no mock). Each test cleans up its own row.
 */
import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  decryptOwnerName,
  encryptOwnerName,
  encryptOwnerPiiBatch,
  hashOwnerName,
  organizations,
  owners,
  providerDb,
} from '@emapp/db';

const TEST_ORG_NAME = 'v8-s3-test';
let testOrgId: string;

async function ensureOrg(): Promise<string> {
  const id = randomUUID();
  await providerDb.insert(organizations).values({
    id,
    name: `${TEST_ORG_NAME}-${id.slice(0, 8)}`,
    slug: `s3test${id.slice(0, 8)}`,
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

describe('owner-name encryption (v8 §v8-S3)', () => {
  beforeAll(async () => {
    testOrgId = await ensureOrg();
  });
  afterAll(async () => {
    await dropOrgRows(testOrgId);
  });

  describe('encryptOwnerName / decryptOwnerName round-trip', () => {
    it('1) encrypts then decrypts to the same string', async () => {
      const name = 'יעקב כהן';
      const { nameEncrypted } = await encryptOwnerName(providerDb, name);
      const back = await decryptOwnerName(providerDb, nameEncrypted);
      expect(back).toBe(name);
    });

    it('2) two encryptions of the SAME name produce different ciphertexts (pgcrypto IV randomness)', async () => {
      const name = 'Same Name';
      const a = await encryptOwnerName(providerDb, name);
      const b = await encryptOwnerName(providerDb, name);
      expect(a.nameEncrypted.equals(b.nameEncrypted)).toBe(false);
      // But both decrypt to the same plaintext.
      expect(await decryptOwnerName(providerDb, a.nameEncrypted)).toBe(name);
      expect(await decryptOwnerName(providerDb, b.nameEncrypted)).toBe(name);
    });

    it('3) HMAC hash is deterministic + 32 bytes (SHA-256 raw)', async () => {
      const name = 'דוד לוי';
      const { nameHash: hashA } = await encryptOwnerName(providerDb, name);
      const { nameHash: hashB } = await encryptOwnerName(providerDb, name);
      const local = hashOwnerName(name);
      expect(hashA.equals(hashB)).toBe(true);
      expect(hashA.equals(local)).toBe(true);
      expect(hashA.length).toBe(32);
    });

    it('4) different names produce different hashes', async () => {
      expect(hashOwnerName('alice').equals(hashOwnerName('bob'))).toBe(false);
    });

    it('5) empty string is a valid (if useless) input', async () => {
      const { nameEncrypted } = await encryptOwnerName(providerDb, '');
      expect(await decryptOwnerName(providerDb, nameEncrypted)).toBe('');
    });
  });

  describe('encryptOwnerPiiBatch with name', () => {
    it('6) folds name encryption into the batch (one extra round-trip)', async () => {
      const inputs = [
        { nationalId: '038123456', phone: '0521234567', name: 'יעקב כהן' },
        { nationalId: '039123456', name: 'Alice Brown' }, // no phone
      ];
      const out = await encryptOwnerPiiBatch(providerDb, inputs);
      expect(out).toHaveLength(2);
      // Names decrypt back correctly.
      expect(await decryptOwnerName(providerDb, out[0]!.nameEncrypted)).toBe('יעקב כהן');
      expect(await decryptOwnerName(providerDb, out[1]!.nameEncrypted)).toBe('Alice Brown');
      // Hashes deterministic and match the standalone helper.
      expect(out[0]!.nameHash.equals(hashOwnerName('יעקב כהן'))).toBe(true);
      expect(out[1]!.nameHash.equals(hashOwnerName('Alice Brown'))).toBe(true);
    });

    it('7) preserves input order (jsonb_array_elements_text WITH ORDINALITY)', async () => {
      const inputs = Array.from({ length: 20 }, (_, i) => ({
        nationalId: `0${i.toString().padStart(8, '0')}`,
        name: `Name-${i}`,
      }));
      const out = await encryptOwnerPiiBatch(providerDb, inputs);
      for (let i = 0; i < inputs.length; i += 1) {
        expect(await decryptOwnerName(providerDb, out[i]!.nameEncrypted)).toBe(`Name-${i}`);
      }
    });

    it('8) name is REQUIRED (typecheck — runtime: name=undefined → pgcrypto on undefined → throws)', async () => {
      // The TS type forbids omitting name; runtime would NPE inside
      // jsonb_array_elements_text on a `undefined` array entry → JSON.stringify
      // serialises undefined as `null` → pg returns NULL → "missing name ciphertext".
      await expect(
        encryptOwnerPiiBatch(providerDb, [
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { nationalId: 'x', name: undefined as any },
        ]),
      ).rejects.toThrow(/missing name ciphertext/);
    });
  });

  describe('owners-table integration', () => {
    it('9) inserts an owner with encrypted name, reads it back via decrypt SQL expression', async () => {
      const name = 'מנשה אבירם';
      const { nameEncrypted, nameHash } = await encryptOwnerName(providerDb, name);
      const inserted = await providerDb
        .insert(owners)
        .values({
          orgId: testOrgId,
          nameEncrypted,
          nameHash,
          nationalIdEncrypted: Buffer.from('placeholder'),
          nationalIdHash: 'placeholder-hash',
        })
        .returning({ id: owners.id });
      expect(inserted).toHaveLength(1);
      // Lookup by name_hash works exactly.
      const [byHash] = await providerDb
        .select({ id: owners.id, nameEncrypted: owners.nameEncrypted })
        .from(owners)
        .where(eq(owners.nameHash, nameHash))
        .limit(1);
      expect(byHash).toBeTruthy();
      expect(await decryptOwnerName(providerDb, byHash!.nameEncrypted)).toBe(name);
    });
  });
});
