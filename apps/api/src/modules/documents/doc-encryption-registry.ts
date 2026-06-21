/**
 * FL-3 — DOC_ENCRYPTION_KEY keyId→key registry (rotation-ready, back-compat).
 *
 * The sensitive-document app-envelope (EMAPPENC, see documents.service.ts) has
 * carried a 2-byte keyId field in its header since 7d:
 *
 *   'EMAPPENC'(8) | version(1)=0x01 | keyId(2) | iv(12) | tag(16) | ciphertext
 *
 * Until FL-3 the keyId was a hard-coded constant (0x0001) that decrypt ignored
 * — every object was encrypted with, and decrypted with, the single bare
 * `DOC_ENCRYPTION_KEY`. This module makes that keyId MEANINGFUL: a registry maps
 * each keyId to its 32-byte AES-256-GCM key, so the active key can rotate while
 * old objects still decrypt under their original (now historical) keyId.
 *
 * The keyId lives in the ENVELOPE HEADER BYTES (already present) — NO DB column,
 * NO migration. The `documents` table is untouched.
 *
 * ── ENV FORMAT (backward-compatible) ──────────────────────────────────────────
 *
 *  LEGACY (today's shape, single bare base64 key — 44 chars, no separators):
 *      DOC_ENCRYPTION_KEY="<base64 of 32 bytes>"
 *    → registry { 1: <key> }, ACTIVE keyId = 1 (the reserved LEGACY default).
 *      This is byte-for-byte identical to the pre-FL-3 behaviour: new objects
 *      are stamped keyId 0x0001 and encrypted with this key, and every object
 *      written before FL-3 (also keyId 0x0001) decrypts under it unchanged.
 *
 *  REGISTRY (multi-key, rotation):
 *      DOC_ENCRYPTION_KEY="v2;active=<id>;<id>=<b64>;<id>=<b64>;..."
 *    e.g. "v2;active=2;1=<oldKeyB64>;2=<newKeyB64>"
 *    → registry { 1: oldKey, 2: newKey }, ACTIVE keyId = 2.
 *      keyId 1 stays the reserved LEGACY default so pre-FL-3 objects (and any
 *      objects written while keyId 1 was active) keep decrypting. To rotate:
 *      add the new key with a fresh id and point `active=` at it; NEVER remove
 *      a historical id while objects encrypted under it still exist.
 *
 * Parsing is FAIL-CLOSED at construction (boot) — a malformed config throws here
 * so the process never serves a half-built registry and decrypt-time never has
 * to reason about config validity. Key MATERIAL is never logged and never placed
 * in an error message (only ids / lengths / the remedy).
 */

/** The reserved keyId for the legacy single-key configuration AND for every
 *  envelope written before FL-3 (which hard-coded keyId 0x0001). MUST stay 1. */
export const LEGACY_DEFAULT_KEY_ID = 1;

/** keyId is a uint16 in the header (2 bytes) → [1, 65535]. 0 is reserved/unused
 *  (a 0x0000 keyId would be indistinguishable from a zeroed/corrupt header). */
const MIN_KEY_ID = 1;
const MAX_KEY_ID = 0xffff;

const DOC_KEY_BYTES = 32; // AES-256
/** base64 of 32 bytes is always 44 chars (with `=` padding). */
const DOC_KEY_B64_LEN = 44;

/** Marker prefix for the multi-key registry form. A value that does NOT start
 *  with this is treated as the legacy single bare key. */
const REGISTRY_PREFIX = 'v2;';

/**
 * Thrown when DOC_ENCRYPTION_KEY is absent or structurally invalid. Carries a
 * stable reason code and NEVER any key material. The service maps this to the
 * existing ops-facing 503 `doc_encryption_unavailable`.
 */
export class DocEncryptionConfigError extends Error {
  constructor(public readonly reason: string) {
    // The message is deliberately generic — no key bytes, no base64, ever.
    super(`doc_encryption config invalid: ${reason}`);
    this.name = 'DocEncryptionConfigError';
  }
}

/** base64-decode one key value, fail-closed on a non-32-byte result. The error
 *  references the keyId only — never the (in)valid bytes. */
function decodeKey(keyId: number, b64: string): Buffer {
  // Length-gate BEFORE decode so a wildly-wrong value never allocates oddly.
  if (b64.length !== DOC_KEY_B64_LEN) {
    throw new DocEncryptionConfigError(`key ${keyId} is not 44-char base64`);
  }
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== DOC_KEY_BYTES) {
    throw new DocEncryptionConfigError(`key ${keyId} does not decode to 32 bytes`);
  }
  return buf;
}

function parseKeyId(raw: string): number {
  // Strict integer: reject leading zeros, signs, whitespace, decimals.
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new DocEncryptionConfigError(`malformed keyId "${raw}"`);
  }
  const id = Number(raw);
  if (id < MIN_KEY_ID || id > MAX_KEY_ID) {
    throw new DocEncryptionConfigError(`keyId ${id} out of range [${MIN_KEY_ID}, ${MAX_KEY_ID}]`);
  }
  return id;
}

/**
 * A parsed, validated keyId→key registry. Immutable after construction.
 * `forEncrypt()` returns the active (keyId, key); `forDecrypt(keyId)` looks up a
 * historical key or fails closed if absent.
 */
export class DocKeyRegistry {
  private constructor(
    private readonly keys: ReadonlyMap<number, Buffer>,
    private readonly activeKeyId: number,
  ) {}

  /**
   * Build from the raw DOC_ENCRYPTION_KEY env value. Fail-closed (throws
   * DocEncryptionConfigError) on any structural problem. Accepts BOTH the
   * legacy single-bare-key shape and the v2 multi-key registry shape.
   */
  static fromEnv(raw: string | undefined): DocKeyRegistry {
    if (raw === undefined || raw === '') {
      throw new DocEncryptionConfigError('DOC_ENCRYPTION_KEY is not set');
    }

    if (!raw.startsWith(REGISTRY_PREFIX)) {
      // Legacy single-key shape → reserved keyId 1, active.
      const key = decodeKey(LEGACY_DEFAULT_KEY_ID, raw);
      return new DocKeyRegistry(new Map([[LEGACY_DEFAULT_KEY_ID, key]]), LEGACY_DEFAULT_KEY_ID);
    }

    // v2 registry: "v2;active=<id>;<id>=<b64>;<id>=<b64>;..."
    const body = raw.slice(REGISTRY_PREFIX.length);
    const segments = body.split(';').filter((s) => s.length > 0);

    let activeKeyId: number | undefined;
    const keys = new Map<number, Buffer>();

    for (const seg of segments) {
      const eq = seg.indexOf('=');
      if (eq <= 0) {
        throw new DocEncryptionConfigError(`malformed segment (expected "lhs=rhs")`);
      }
      const lhs = seg.slice(0, eq);
      const rhs = seg.slice(eq + 1);

      if (lhs === 'active') {
        if (activeKeyId !== undefined) {
          throw new DocEncryptionConfigError('duplicate active= directive');
        }
        activeKeyId = parseKeyId(rhs);
        continue;
      }

      const id = parseKeyId(lhs);
      if (keys.has(id)) {
        throw new DocEncryptionConfigError(`duplicate keyId ${id}`);
      }
      keys.set(id, decodeKey(id, rhs));
    }

    if (activeKeyId === undefined) {
      throw new DocEncryptionConfigError('missing active= directive');
    }
    if (keys.size === 0) {
      throw new DocEncryptionConfigError('registry defines no keys');
    }
    if (!keys.has(activeKeyId)) {
      throw new DocEncryptionConfigError(`active keyId ${activeKeyId} has no key in the registry`);
    }

    return new DocKeyRegistry(keys, activeKeyId);
  }

  /** The (keyId, key) to stamp + encrypt NEW envelopes with. */
  forEncrypt(): { keyId: number; key: Buffer } {
    const key = this.keys.get(this.activeKeyId);
    // Unreachable post-construction (fromEnv guarantees it) — fail-closed anyway.
    if (!key) {
      throw new DocEncryptionConfigError('active key missing at encrypt time');
    }
    return { keyId: this.activeKeyId, key };
  }

  /**
   * The key for an envelope's stamped keyId. FAIL-CLOSED: an unknown keyId
   * throws (no plaintext fallback, no silent default) so a doc encrypted under a
   * key that is no longer configured surfaces as an ops error rather than
   * leaking or corrupting bytes.
   */
  forDecrypt(keyId: number): Buffer {
    const key = this.keys.get(keyId);
    if (!key) {
      throw new DocEncryptionConfigError(`no key configured for keyId ${keyId}`);
    }
    return key;
  }
}
