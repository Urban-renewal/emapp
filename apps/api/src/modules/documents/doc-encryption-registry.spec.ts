/**
 * FL-3 — DOC_ENCRYPTION_KEY keyId→key registry (rotation-ready, back-compat).
 *
 * Proves, with NO DB and NO dev server (pure node:crypto + the registry):
 *   - active-keyId encrypt → decrypt round-trip;
 *   - a LEGACY envelope (single bare key, keyId 0x0001) still decrypts via the
 *     reserved legacy default key — byte-for-byte back-compat;
 *   - an envelope stamped with keyId A decrypts when A is in the registry and
 *     FAILS CLOSED (clear error, no plaintext) when A is absent;
 *   - rotating the active keyId does not break decrypt of old-keyId objects;
 *   - the registry parse REJECTS malformed config (fail-closed at construction);
 *   - key material is never surfaced in a config error message.
 *
 * The envelope layout mirrors documents.service.ts exactly:
 *   'EMAPPENC'(8) | version(1)=0x01 | keyId(2 BE) | iv(12) | tag(16) | ciphertext
 * so a round-trip here is byte-compatible with what the service writes/reads.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  DocEncryptionConfigError,
  DocKeyRegistry,
  LEGACY_DEFAULT_KEY_ID,
} from './doc-encryption-registry';

// ── envelope layout (must match documents.service.ts) ───────────────────────
const MAGIC = Buffer.from('EMAPPENC', 'ascii');
const VERSION = 0x01;
const KEY_ID_LEN = 2;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + 1 + KEY_ID_LEN + IV_LEN + TAG_LEN;

const PLAINTEXT = Buffer.from('sensitive נסח tabu PDF bytes — לא ללוג', 'utf8');

function b64key(): string {
  return randomBytes(32).toString('base64');
}

/** Encrypt exactly as the service does, given a (keyId, key). */
function encryptEnvelope(plain: Buffer, keyId: number, key: Buffer): Buffer {
  const keyIdBytes = Buffer.alloc(KEY_ID_LEN);
  keyIdBytes.writeUInt16BE(keyId, 0);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), keyIdBytes, iv, tag, ciphertext]);
}

/** Decrypt exactly as the service does: read keyId → registry lookup → GCM. */
function decryptEnvelope(envelope: Buffer, reg: DocKeyRegistry): Buffer {
  const keyId = envelope.readUInt16BE(MAGIC.length + 1);
  const ivStart = MAGIC.length + 1 + KEY_ID_LEN;
  const iv = envelope.subarray(ivStart, ivStart + IV_LEN);
  const tag = envelope.subarray(ivStart + IV_LEN, HEADER_LEN);
  const ciphertext = envelope.subarray(HEADER_LEN);
  const key = reg.forDecrypt(keyId); // throws DocEncryptionConfigError if absent
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

describe('FL-3 · DocKeyRegistry — active round-trip', () => {
  it('active-keyId encrypt → decrypt yields the original plaintext', () => {
    const reg = DocKeyRegistry.fromEnv(b64key());
    const { keyId, key } = reg.forEncrypt();
    const env = encryptEnvelope(PLAINTEXT, keyId, key);
    expect(decryptEnvelope(env, reg).equals(PLAINTEXT)).toBe(true);
  });

  it('a single bare key resolves to the reserved legacy default keyId (1)', () => {
    const reg = DocKeyRegistry.fromEnv(b64key());
    expect(reg.forEncrypt().keyId).toBe(LEGACY_DEFAULT_KEY_ID);
    expect(LEGACY_DEFAULT_KEY_ID).toBe(1);
  });

  it('the v2 multi-key form encrypts under the active key and round-trips', () => {
    const oldB64 = b64key();
    const newB64 = b64key();
    const reg = DocKeyRegistry.fromEnv(`v2;active=2;1=${oldB64};2=${newB64}`);
    const { keyId, key } = reg.forEncrypt();
    expect(keyId).toBe(2);
    // active key must be the keyId-2 material, not keyId-1.
    expect(key.equals(Buffer.from(newB64, 'base64'))).toBe(true);
    const env = encryptEnvelope(PLAINTEXT, keyId, key);
    expect(env.readUInt16BE(MAGIC.length + 1)).toBe(2);
    expect(decryptEnvelope(env, reg).equals(PLAINTEXT)).toBe(true);
  });
});

describe('FL-3 · back-compat — a pre-FL-3 / legacy envelope still decrypts', () => {
  it('an envelope stamped keyId 0x0001 by the legacy single-key path decrypts via the default', () => {
    const bare = b64key();
    // Legacy producer: keyId hard-coded 0x0001, key = the bare DOC_ENCRYPTION_KEY.
    const legacyEnv = encryptEnvelope(PLAINTEXT, 1, Buffer.from(bare, 'base64'));
    expect(legacyEnv.readUInt16BE(MAGIC.length + 1)).toBe(1);

    // Today's registry (same single bare key) must still decrypt it.
    const reg = DocKeyRegistry.fromEnv(bare);
    expect(decryptEnvelope(legacyEnv, reg).equals(PLAINTEXT)).toBe(true);
  });

  it('after rotating to a NEW active key (v2), the OLD legacy keyId-1 object still decrypts', () => {
    const bare = b64key(); // the original legacy key
    const legacyEnv = encryptEnvelope(PLAINTEXT, 1, Buffer.from(bare, 'base64'));

    // Rotate: keyId 1 kept as historical, keyId 2 is now active.
    const newB64 = b64key();
    const rotated = DocKeyRegistry.fromEnv(`v2;active=2;1=${bare};2=${newB64}`);

    // New encryptions use keyId 2…
    expect(rotated.forEncrypt().keyId).toBe(2);
    // …and the OLD keyId-1 object is untouched: still decrypts under the default.
    expect(decryptEnvelope(legacyEnv, rotated).equals(PLAINTEXT)).toBe(true);
  });
});

describe('FL-3 · fail-closed — unknown keyId never leaks plaintext', () => {
  it('keyId A decrypts when A is in the registry', () => {
    const k1 = b64key();
    const k7 = b64key();
    const reg = DocKeyRegistry.fromEnv(`v2;active=7;1=${k1};7=${k7}`);
    const env = encryptEnvelope(PLAINTEXT, 7, Buffer.from(k7, 'base64'));
    expect(decryptEnvelope(env, reg).equals(PLAINTEXT)).toBe(true);
  });

  it('keyId A FAILS CLOSED (throws, no plaintext) when A is absent from the registry', () => {
    // Object encrypted under keyId 9, but the registry only knows keyId 1.
    const k9 = b64key();
    const env = encryptEnvelope(PLAINTEXT, 9, Buffer.from(k9, 'base64'));
    const reg = DocKeyRegistry.fromEnv(b64key()); // only keyId 1

    let thrown: unknown;
    let out: Buffer | undefined;
    try {
      out = decryptEnvelope(env, reg);
    } catch (e) {
      thrown = e;
    }
    expect(out, 'no plaintext may be produced for an unknown keyId').toBeUndefined();
    expect(thrown).toBeInstanceOf(DocEncryptionConfigError);
    expect((thrown as DocEncryptionConfigError).message).toContain('keyId 9');
  });

  it('forDecrypt does NOT silently fall back to the active/default key', () => {
    const reg = DocKeyRegistry.fromEnv(`v2;active=2;1=${b64key()};2=${b64key()}`);
    // keyId 5 is not configured — must throw, NOT return key 1 or key 2.
    expect(() => reg.forDecrypt(5)).toThrow(DocEncryptionConfigError);
  });
});

describe('FL-3 · config parse fails closed at construction', () => {
  it('unset / empty value throws', () => {
    expect(() => DocKeyRegistry.fromEnv(undefined)).toThrow(DocEncryptionConfigError);
    expect(() => DocKeyRegistry.fromEnv('')).toThrow(DocEncryptionConfigError);
  });

  it('a bare key that is not 44-char base64 / not 32 bytes throws', () => {
    expect(() => DocKeyRegistry.fromEnv('too-short')).toThrow(DocEncryptionConfigError);
    // 44 chars of base64 that decodes to the wrong byte length.
    const wrongLen = Buffer.alloc(20).toString('base64').padEnd(44, 'A');
    expect(() => DocKeyRegistry.fromEnv(wrongLen)).toThrow(DocEncryptionConfigError);
  });

  it('v2 with a missing active= directive throws', () => {
    expect(() => DocKeyRegistry.fromEnv(`v2;1=${b64key()}`)).toThrow(DocEncryptionConfigError);
  });

  it('v2 whose active keyId has no key throws (no half-built registry)', () => {
    expect(() => DocKeyRegistry.fromEnv(`v2;active=3;1=${b64key()}`)).toThrow(
      DocEncryptionConfigError,
    );
  });

  it('v2 with a duplicate keyId throws', () => {
    const k = b64key();
    expect(() => DocKeyRegistry.fromEnv(`v2;active=1;1=${k};1=${b64key()}`)).toThrow(
      DocEncryptionConfigError,
    );
  });

  it('v2 with a malformed keyId (non-numeric / leading zero / out of range) throws', () => {
    expect(() => DocKeyRegistry.fromEnv(`v2;active=1;abc=${b64key()}`)).toThrow(
      DocEncryptionConfigError,
    );
    expect(() => DocKeyRegistry.fromEnv(`v2;active=1;01=${b64key()}`)).toThrow(
      DocEncryptionConfigError,
    );
    expect(() => DocKeyRegistry.fromEnv(`v2;active=99999;99999=${b64key()}`)).toThrow(
      DocEncryptionConfigError,
    );
  });

  it('a v2 key value of the wrong length throws (per-key length gate)', () => {
    expect(() => DocKeyRegistry.fromEnv(`v2;active=1;1=not-base64`)).toThrow(
      DocEncryptionConfigError,
    );
  });
});

describe('FL-3 · key material is never surfaced in errors', () => {
  it('a config error never echoes base64 key bytes', () => {
    const secret = b64key();
    let msg = '';
    try {
      // active points at a keyId whose key is provided but a SECOND, bad key
      // segment triggers the throw — ensure the good secret never leaks.
      DocKeyRegistry.fromEnv(`v2;active=1;1=${secret};2=bad`);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toContain(secret);
    expect(msg).not.toContain('bad'); // not even the offending value, only ids/remedy
  });
});
