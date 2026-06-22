/**
 * Gate-6 — `doc-envelope.ts` (the @emapp/db EMAPPENC primitive) unit + CROSS-IMPL
 * compatibility pins.
 *
 * The wire format is implemented TWICE (deliberately): here in @emapp/db (used by
 * the tabu sensitive-flip + the standalone backfill) and in apps/api's
 * DocumentsService.encryptEnvelope/decryptEnvelope (the content-upload + download
 * path). A doc encrypted by either MUST decrypt by the other, or a future edit to
 * one silently produces undecryptable PII at rest.
 *
 * This file pins the EXACT wire layout the API's `decryptEnvelope` parses
 * (`'EMAPPENC' | version(1) | keyId(2 BE) | iv(12) | tag(16) | ciphertext`,
 * AES-256-GCM, NO AAD), and decrypts a db-built envelope with a RAW
 * `createDecipheriv` exactly as the API does — so this test FAILS the moment the
 * two implementations drift (offsets / AAD / cipher / key rules).
 *
 * Run: pnpm --filter @emapp/db exec vitest run test/doc-envelope.spec.ts
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  DocEnvelopeFormatError,
  DocEnvelopeKeyRegistry,
  ENVELOPE_HEADER_LEN,
  ENVELOPE_MAGIC,
  ENVELOPE_VERSION,
  decryptDocEnvelope,
  encryptDocEnvelope,
  looksLikeDocEnvelope,
} from '../src/doc-envelope';

// Two TEST-ONLY 32-byte keys (NOT credentials) → 44-char base64.
const KEY_1 = Buffer.from('emapp-doc-envelope-spec-key-one!').toString('base64');
const KEY_2 = Buffer.from('emapp-doc-envelope-spec-key-two!').toString('base64');

const PLAIN = Buffer.from('%PDF-1.4\nנסח טאבו — national_id 123456782\n%%EOF\n');

describe('doc-envelope — round-trip', () => {
  it('encrypt → decrypt restores the exact plaintext (legacy single-key)', () => {
    const reg = DocEnvelopeKeyRegistry.fromEnv(KEY_1);
    const env = encryptDocEnvelope(PLAIN, reg);
    expect(decryptDocEnvelope(env, reg).equals(PLAIN)).toBe(true);
  });

  it('ciphertext length === plaintext length (GCM, no padding)', () => {
    const reg = DocEnvelopeKeyRegistry.fromEnv(KEY_1);
    const env = encryptDocEnvelope(PLAIN, reg);
    expect(env.length - ENVELOPE_HEADER_LEN).toBe(PLAIN.length);
  });

  it('IV is random per object (no GCM iv reuse under one key)', () => {
    const reg = DocEnvelopeKeyRegistry.fromEnv(KEY_1);
    const a = encryptDocEnvelope(PLAIN, reg);
    const b = encryptDocEnvelope(PLAIN, reg);
    const ivStart = ENVELOPE_MAGIC.length + 1 + 2;
    expect(a.subarray(ivStart, ivStart + 12).equals(b.subarray(ivStart, ivStart + 12))).toBe(false);
    expect(a.equals(b)).toBe(false);
  });

  it('a tampered tag / ciphertext fails closed (DocEnvelopeFormatError)', () => {
    const reg = DocEnvelopeKeyRegistry.fromEnv(KEY_1);
    const env = encryptDocEnvelope(PLAIN, reg);
    const last = env.length - 1;
    env[last] = (env[last]! ^ 0xff) & 0xff; // flip a ciphertext byte
    expect(() => decryptDocEnvelope(env, reg)).toThrow(DocEnvelopeFormatError);
  });

  it('looksLikeDocEnvelope detects an envelope but not arbitrary plaintext', () => {
    const reg = DocEnvelopeKeyRegistry.fromEnv(KEY_1);
    expect(looksLikeDocEnvelope(encryptDocEnvelope(PLAIN, reg))).toBe(true);
    expect(looksLikeDocEnvelope(PLAIN)).toBe(false);
    expect(looksLikeDocEnvelope(Buffer.from('EMAPPENC'))).toBe(false); // header too short
  });

  it('multi-key registry: encrypts under active, decrypts via stamped keyId', () => {
    // v2 registry with two keys, active=2; an envelope stamps keyId=2 and
    // decrypts even though key 1 is also present.
    const raw = `v2;active=2;1=${KEY_1};2=${KEY_2}`;
    const reg = DocEnvelopeKeyRegistry.fromEnv(raw);
    const env = encryptDocEnvelope(PLAIN, reg);
    const keyId = env.readUInt16BE(ENVELOPE_MAGIC.length + 1);
    expect(keyId).toBe(2);
    expect(decryptDocEnvelope(env, reg).equals(PLAIN)).toBe(true);
  });
});

describe('doc-envelope — CROSS-IMPL wire-format pin (must match apps/api DocumentsService)', () => {
  it('a db-built envelope decrypts with a RAW createDecipheriv exactly as the API does', () => {
    // This mirrors apps/api DocumentsService.decryptEnvelope byte-for-byte:
    // parse magic/version, read keyId, slice iv(12)+tag(16), GCM-decrypt with NO
    // AAD. If @emapp/db's encrypt ever diverges (offsets, AAD, cipher), THIS fails.
    const reg = DocEnvelopeKeyRegistry.fromEnv(KEY_1);
    const env = encryptDocEnvelope(PLAIN, reg);

    // header offsets — pinned constants the API also hard-codes
    expect(env.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC)).toBe(true);
    expect(env[ENVELOPE_MAGIC.length]).toBe(ENVELOPE_VERSION);
    const keyIdStart = ENVELOPE_MAGIC.length + 1;
    const ivStart = keyIdStart + 2;
    const iv = env.subarray(ivStart, ivStart + 12);
    const tag = env.subarray(ivStart + 12, ENVELOPE_HEADER_LEN);
    const ciphertext = env.subarray(ENVELOPE_HEADER_LEN);

    const key = Buffer.from(KEY_1, 'base64'); // keyId 1 = legacy default
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    expect(out.equals(PLAIN)).toBe(true);
  });

  it('an envelope built by the RAW (API-style) path decrypts via decryptDocEnvelope', () => {
    // The reverse direction: build the envelope with raw crypto the way the API
    // does, then decrypt with the @emapp/db primitive.
    const key = Buffer.from(KEY_1, 'base64');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(PLAIN), cipher.final()]);
    const tag = cipher.getAuthTag();
    const keyIdBytes = Buffer.alloc(2);
    keyIdBytes.writeUInt16BE(1, 0); // legacy default keyId
    const env = Buffer.concat([
      ENVELOPE_MAGIC,
      Buffer.from([ENVELOPE_VERSION]),
      keyIdBytes,
      iv,
      tag,
      ct,
    ]);
    const reg = DocEnvelopeKeyRegistry.fromEnv(KEY_1);
    expect(decryptDocEnvelope(env, reg).equals(PLAIN)).toBe(true);
  });
});
