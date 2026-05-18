import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db, pool } from '../src/client';
import { decryptField, encryptField, hashField } from '../src/helpers/owners';

import { setupTestDatabase } from './setup';

const TEST_ENC_KEY = 'test-pgcrypto-passphrase-for-unit-tests-only';
const TEST_HASH_KEY = 'test-hmac-key-for-unit-tests-only';

describe('T1.8 — PII encryption round-trip and HMAC determinism', () => {
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('pgcrypto encrypt + decrypt returns original value', async () => {
    const original = '123456789';
    const encrypted = await encryptField(db, original, TEST_ENC_KEY);
    const decrypted = await decryptField(db, encrypted, TEST_ENC_KEY);
    expect(decrypted).toBe(original);
  });

  it('encrypted output is a Buffer (binary), not plaintext', async () => {
    const original = 'sensitive-value';
    const encrypted = await encryptField(db, original, TEST_ENC_KEY);
    expect(encrypted).toBeInstanceOf(Buffer);
    expect(encrypted.toString('utf8')).not.toContain(original);
  });

  it('different values produce different ciphertexts', async () => {
    const enc1 = await encryptField(db, 'value-one', TEST_ENC_KEY);
    const enc2 = await encryptField(db, 'value-two', TEST_ENC_KEY);
    expect(enc1.equals(enc2)).toBe(false);
  });

  it('wrong decryption key throws an error', async () => {
    const encrypted = await encryptField(db, 'secret', TEST_ENC_KEY);
    await expect(decryptField(db, encrypted, 'wrong-key')).rejects.toThrow();
  });

  it('HMAC is deterministic: same input → same hash', async () => {
    const value = '052-12-3456';
    const hash1 = hashField(value, TEST_HASH_KEY);
    const hash2 = hashField(value, TEST_HASH_KEY);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex
  });

  it('HMAC distinguishes different inputs', async () => {
    const hash1 = hashField('052-12-3456', TEST_HASH_KEY);
    const hash2 = hashField('052-12-3457', TEST_HASH_KEY);
    expect(hash1).not.toBe(hash2);
  });

  it('HMAC with different key produces different hash', async () => {
    const value = '052-12-3456';
    const hash1 = hashField(value, TEST_HASH_KEY);
    const hash2 = hashField(value, 'different-hmac-key');
    expect(hash1).not.toBe(hash2);
  });
});
