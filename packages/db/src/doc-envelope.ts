/**
 * EMAPPENC app-envelope — the SENSITIVE-document at-rest encryption format,
 * SHARED between the API (apps/api documents.service.ts) and the standalone
 * backfill/re-encrypt script (packages/db/scripts/reencrypt-sensitive-docs.ts).
 *
 * The API owns the canonical envelope wire format; this module is a SECOND,
 * byte-identical implementation so the `@emapp/db` package (which has no
 * dependency on apps/api) can encrypt/parse the SAME format from a plain
 * standalone process. A doc encrypted here decrypts byte-for-byte via the
 * API's `decryptEnvelope`, and vice versa — pinned by a cross-compat test.
 *
 * At-rest layout (self-describing — no migration needed for the format):
 *   'EMAPPENC'(8B ascii) | version(1B=0x01) | keyId(2B BE) | iv(12B) |
 *   tag(16B) | ciphertext  (AES-256-GCM ⇒ ciphertext length === plaintext len)
 *
 * Key = the 32-byte AES-256 key resolved from DOC_ENCRYPTION_KEY via the same
 * registry rules the API enforces (legacy single bare key ⇒ keyId 1, or the
 * "v2;active=<id>;<id>=<b64>;…" multi-key form). iv is RANDOM PER OBJECT (a GCM
 * iv reuse under one key is catastrophic). NO AAD (matches the API; a future
 * AAD addition must update BOTH implementations + their specs).
 *
 * Key MATERIAL is never logged and never placed in an error message — only
 * ids / lengths / a structural reason.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const ENVELOPE_MAGIC = Buffer.from('EMAPPENC', 'ascii');
export const ENVELOPE_VERSION = 0x01;
const ENVELOPE_KEY_ID_LEN = 2;
const ENVELOPE_IV_LEN = 12;
const ENVELOPE_TAG_LEN = 16;
/** magic(8) + version(1) + keyId(2) + iv(12) + tag(16) */
export const ENVELOPE_HEADER_LEN =
  ENVELOPE_MAGIC.length + 1 + ENVELOPE_KEY_ID_LEN + ENVELOPE_IV_LEN + ENVELOPE_TAG_LEN;

/** Reserved keyId for the legacy single-key configuration AND for every
 *  envelope written before the multi-key registry (hard-coded keyId 0x0001). */
export const LEGACY_DEFAULT_KEY_ID = 1;
const MIN_KEY_ID = 1;
const MAX_KEY_ID = 0xffff;
const DOC_KEY_BYTES = 32; // AES-256
const DOC_KEY_B64_LEN = 44; // base64 of 32 bytes
const REGISTRY_PREFIX = 'v2;';

/** Structural failure parsing DOC_ENCRYPTION_KEY (absent / malformed / unknown
 *  keyId). NEVER carries key material — only a stable reason. */
export class DocEnvelopeConfigError extends Error {
  constructor(public readonly reason: string) {
    super(`doc_encryption config invalid: ${reason}`);
    this.name = 'DocEnvelopeConfigError';
  }
}

/** A corrupt / non-EMAPPENC / wrong-version / auth-tag-mismatch envelope. NEVER
 *  carries bytes — only that the object did not parse/decrypt. */
export class DocEnvelopeFormatError extends Error {
  constructor(reason: string) {
    super(`doc_envelope malformed: ${reason}`);
    this.name = 'DocEnvelopeFormatError';
  }
}

function decodeKey(keyId: number, b64: string): Buffer {
  if (b64.length !== DOC_KEY_B64_LEN) {
    throw new DocEnvelopeConfigError(`key ${keyId} is not 44-char base64`);
  }
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== DOC_KEY_BYTES) {
    throw new DocEnvelopeConfigError(`key ${keyId} does not decode to 32 bytes`);
  }
  return buf;
}

function parseKeyId(raw: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new DocEnvelopeConfigError(`malformed keyId "${raw}"`);
  }
  const id = Number(raw);
  if (id < MIN_KEY_ID || id > MAX_KEY_ID) {
    throw new DocEnvelopeConfigError(`keyId ${id} out of range [${MIN_KEY_ID}, ${MAX_KEY_ID}]`);
  }
  return id;
}

/**
 * Parsed keyId→key registry — the SAME rules the API's DocKeyRegistry uses
 * (legacy single bare key ⇒ keyId 1; or "v2;active=<id>;<id>=<b64>;…"). Kept a
 * standalone copy here so `@emapp/db` does not depend on apps/api. Fail-closed
 * at construction.
 */
export class DocEnvelopeKeyRegistry {
  private constructor(
    private readonly keys: ReadonlyMap<number, Buffer>,
    private readonly activeKeyId: number,
  ) {}

  static fromEnv(raw: string | undefined): DocEnvelopeKeyRegistry {
    if (raw === undefined || raw === '') {
      throw new DocEnvelopeConfigError('DOC_ENCRYPTION_KEY is not set');
    }
    if (!raw.startsWith(REGISTRY_PREFIX)) {
      const key = decodeKey(LEGACY_DEFAULT_KEY_ID, raw);
      return new DocEnvelopeKeyRegistry(
        new Map([[LEGACY_DEFAULT_KEY_ID, key]]),
        LEGACY_DEFAULT_KEY_ID,
      );
    }
    const body = raw.slice(REGISTRY_PREFIX.length);
    const segments = body.split(';').filter((s) => s.length > 0);
    let activeKeyId: number | undefined;
    const keys = new Map<number, Buffer>();
    for (const seg of segments) {
      const eq = seg.indexOf('=');
      if (eq <= 0) throw new DocEnvelopeConfigError('malformed segment (expected "lhs=rhs")');
      const lhs = seg.slice(0, eq);
      const rhs = seg.slice(eq + 1);
      if (lhs === 'active') {
        if (activeKeyId !== undefined) {
          throw new DocEnvelopeConfigError('duplicate active= directive');
        }
        activeKeyId = parseKeyId(rhs);
        continue;
      }
      const id = parseKeyId(lhs);
      if (keys.has(id)) throw new DocEnvelopeConfigError(`duplicate keyId ${id}`);
      keys.set(id, decodeKey(id, rhs));
    }
    if (activeKeyId === undefined) throw new DocEnvelopeConfigError('missing active= directive');
    if (keys.size === 0) throw new DocEnvelopeConfigError('registry defines no keys');
    if (!keys.has(activeKeyId)) {
      throw new DocEnvelopeConfigError(`active keyId ${activeKeyId} has no key in the registry`);
    }
    return new DocEnvelopeKeyRegistry(keys, activeKeyId);
  }

  forEncrypt(): { keyId: number; key: Buffer } {
    const key = this.keys.get(this.activeKeyId);
    if (!key) throw new DocEnvelopeConfigError('active key missing at encrypt time');
    return { keyId: this.activeKeyId, key };
  }

  forDecrypt(keyId: number): Buffer {
    const key = this.keys.get(keyId);
    if (!key) throw new DocEnvelopeConfigError(`no key configured for keyId ${keyId}`);
    return key;
  }
}

/** Build the at-rest envelope: EMAPPENC|v1|keyId|iv|tag|ciphertext. iv is RANDOM
 *  per object (GCM requirement); NO AAD. */
export function encryptDocEnvelope(plain: Buffer, registry: DocEnvelopeKeyRegistry): Buffer {
  const { keyId, key } = registry.forEncrypt();
  const keyIdBytes = Buffer.alloc(ENVELOPE_KEY_ID_LEN);
  keyIdBytes.writeUInt16BE(keyId, 0);
  const iv = randomBytes(ENVELOPE_IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([
    ENVELOPE_MAGIC,
    Buffer.from([ENVELOPE_VERSION]),
    keyIdBytes,
    iv,
    tag,
    ciphertext,
  ]);
}

/** Parse + decrypt an at-rest envelope. Throws DocEnvelopeFormatError on a
 *  malformed/garbled object (corruption / not an envelope / auth-tag mismatch)
 *  and DocEnvelopeConfigError when the stamped keyId has no configured key. */
export function decryptDocEnvelope(envelope: Buffer, registry: DocEnvelopeKeyRegistry): Buffer {
  if (
    envelope.length < ENVELOPE_HEADER_LEN ||
    !envelope.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC) ||
    envelope[ENVELOPE_MAGIC.length] !== ENVELOPE_VERSION
  ) {
    throw new DocEnvelopeFormatError('bad magic/version/length');
  }
  const keyIdStart = ENVELOPE_MAGIC.length + 1;
  const keyId = envelope.readUInt16BE(keyIdStart);
  const ivStart = keyIdStart + ENVELOPE_KEY_ID_LEN;
  const iv = envelope.subarray(ivStart, ivStart + ENVELOPE_IV_LEN);
  const tag = envelope.subarray(ivStart + ENVELOPE_IV_LEN, ENVELOPE_HEADER_LEN);
  const ciphertext = envelope.subarray(ENVELOPE_HEADER_LEN);
  // Key fetch OUTSIDE the decrypt try — a config/rotation gap must surface as a
  // config error, never be swallowed as corruption.
  const key = registry.forDecrypt(keyId);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new DocEnvelopeFormatError('auth-tag mismatch / decrypt failed');
  }
}

/** True iff the buffer's leading bytes are a well-formed EMAPPENC header. Used
 *  by the re-encrypt backfill to detect an already-encrypted object (idempotency
 *  / round-trip verify) WITHOUT needing the key. */
export function looksLikeDocEnvelope(buf: Buffer): boolean {
  return (
    buf.length >= ENVELOPE_HEADER_LEN &&
    buf.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC) &&
    buf[ENVELOPE_MAGIC.length] === ENVELOPE_VERSION
  );
}
