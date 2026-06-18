/**
 * Magic-byte (real-content-type) verification for the documents path.
 *
 * SECURITY (SECURITY-UPLOAD-AUDIT.md threat #3 — "type spoofing") — the
 * document upload path trusts the CLIENT-DECLARED `mimeType` end-to-end:
 * `create` stores `input.mimeType` verbatim and the download presign
 * re-stamps it. ClamAV catches KNOWN malware, not a renamed-but-benign-
 * looking executable, an HTML/PDF polyglot, or an honest accident (a `.docx`
 * uploaded as `application/pdf`). This is the cheap, synchronous type-
 * confusion defense AV doesn't provide.
 *
 * This MIRRORS the import path's established pattern
 * (`apps/worker/src/parser/zip-preflight.ts`), which sniffs the ZIP
 * local-file-header magic `50 4B 03 04` before handing bytes to ExcelJS.
 * We deliberately HAND-ROLL the signature table (the same rationale as the
 * zip pre-flight): the formats are a small fixed set, the byte signatures
 * are stable (no library surface to drift), no new dependency, and it runs
 * in CJS without the ESM-only `file-type` package's interop friction.
 *
 * Scope: this is a DEFENSE-IN-DEPTH layer, NOT the security boundary (the AV
 * scan + R2 origin-separation + forced-attachment serving remain that). It
 * runs where the server ALREADY holds the bytes (the scan gate + the
 * sensitive content path) → zero extra I/O, zero UX cost for valid files.
 */

/** Result of a magic-byte verification. */
export interface MagicByteCheck {
  /** True when the leading bytes are CONSISTENT with the declared MIME. */
  ok: boolean;
}

/**
 * A signature is a sequence of bytes that must appear at `offset` for a file
 * of this family. `null` entries are wildcards (don't-care bytes) — used for
 * container formats whose magic has variable bytes between fixed markers.
 */
interface Signature {
  offset: number;
  bytes: ReadonlyArray<number | null>;
}

/**
 * For each allow-listed MIME (`DocumentMimeEnum` in
 * `@emapp/shared-types/document.ts`), the byte signature(s) that a REAL file
 * of that type must begin with. A MIME present here with a NON-empty array is
 * ENFORCED: the leading bytes must match at least one signature.
 *
 * Types absent from this table (or mapped to `[]`) are NOT byte-verifiable —
 * `text/plain` and `text/csv` are plain UTF-8/ASCII with no reliable magic
 * number, so we cannot reject on signature without false-positives on
 * legitimate text. They keep today's behaviour (declared MIME trusted). This
 * is intentional and matches the audit's framing (the high-value targets are
 * the binary/active-content types: PDF, images, Office docs).
 *
 * NOTE: docx/xlsx (OOXML) and the legacy `application/msword`/`vnd.ms-excel`
 * are handled specially below (they share the ZIP and OLE2 container magics
 * respectively), so a docx whose bytes are really a PDF is still caught.
 */
const SIGNATURES: Readonly<Record<string, ReadonlyArray<Signature>>> = {
  // %PDF-  (a PDF may have leading whitespace/BOM in the wild, but %PDF at
  // byte 0 is the spec requirement and what every real producer emits).
  'application/pdf': [{ offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] }],
  // \x89PNG\r\n\x1a\n
  'image/png': [{ offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  // JPEG SOI + marker: FF D8 FF
  'image/jpeg': [{ offset: 0, bytes: [0xff, 0xd8, 0xff] }],
  // RIFF....WEBP  (bytes 0-3 = 'RIFF', 8-11 = 'WEBP'; 4-7 = file size, wild)
  'image/webp': [
    {
      offset: 0,
      // R    I     F     F     *     *     *     *     W     E     B     P
      bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
    },
  ],
  // GIF87a / GIF89a
  'image/gif': [
    { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] },
    { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] },
  ],
};

/** ZIP local-file-header (and the empty-archive EOCD) — the container magic
 *  shared by every OOXML file (docx/xlsx). Mirrors `zip-preflight.ts`. */
const ZIP_LOCAL_FILE_HEADER: Signature = { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] };
const ZIP_EMPTY_EOCD: Signature = { offset: 0, bytes: [0x50, 0x4b, 0x05, 0x06] };

/** OLE2 / Compound File Binary — the container magic shared by the legacy
 *  `application/msword` (.doc) and `application/vnd.ms-excel` (.xls). */
const OLE2_HEADER: Signature = {
  offset: 0,
  bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
};

/** OOXML (docx/xlsx) are ZIP containers — accept either the standard local-
 *  file-header or the (rare) empty-archive EOCD. */
const OOXML_MIMES: ReadonlySet<string> = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
]);

/** Legacy Office binary (.doc/.xls) are OLE2 compound files. */
const OLE2_MIMES: ReadonlySet<string> = new Set([
  'application/msword', // .doc
  'application/vnd.ms-excel', // .xls
]);

/** MIMEs we deliberately DON'T byte-verify (plain text has no magic). */
const UNVERIFIABLE_MIMES: ReadonlySet<string> = new Set(['text/plain', 'text/csv']);

function matchesSignature(buffer: Buffer, sig: Signature): boolean {
  const end = sig.offset + sig.bytes.length;
  if (buffer.length < end) return false;
  for (let i = 0; i < sig.bytes.length; i += 1) {
    const expected = sig.bytes[i];
    if (expected === null) continue; // wildcard
    if (buffer[sig.offset + i] !== expected) return false;
  }
  return true;
}

/**
 * Verify the leading bytes of `buffer` are CONSISTENT with the `declaredMime`.
 *
 * Returns `{ ok: true }` when:
 *   - the declared MIME is one we don't byte-verify (plain text), OR
 *   - the leading bytes match a known signature for the declared MIME family
 *     (direct table, OOXML→ZIP, or legacy-Office→OLE2).
 *
 * Returns `{ ok: false }` (a type-spoof / accident) when the declared MIME IS
 * byte-verifiable but the leading bytes do not match any of its signatures —
 * e.g. PNG/ZIP/EXE bytes declared as `application/pdf`.
 *
 * The caller (documents.service.ts) is fail-closed: a `false` result rejects
 * the upload with the SAME archive+reject posture used for infected/oversized
 * files. The file bytes are NEVER logged.
 */
export function verifyMagicBytes(buffer: Buffer, declaredMime: string): MagicByteCheck {
  // Empty buffer is a separate (size) concern handled upstream; nothing to
  // sniff, so don't manufacture a spoof verdict here.
  if (buffer.length === 0) return { ok: true };

  if (UNVERIFIABLE_MIMES.has(declaredMime)) return { ok: true };

  if (OOXML_MIMES.has(declaredMime)) {
    const ok =
      matchesSignature(buffer, ZIP_LOCAL_FILE_HEADER) || matchesSignature(buffer, ZIP_EMPTY_EOCD);
    return { ok };
  }

  if (OLE2_MIMES.has(declaredMime)) {
    return { ok: matchesSignature(buffer, OLE2_HEADER) };
  }

  const sigs = SIGNATURES[declaredMime];
  if (!sigs) {
    // Not in any table — a MIME the allow-list accepts but we have no
    // signature for. Don't block (no signature ⇒ no spoof evidence). The
    // allow-list (DocumentMimeEnum) already excludes the dangerous types
    // (html/svg/executables), so an un-tabled allow-listed MIME is benign.
    return { ok: true };
  }

  return { ok: sigs.some((sig) => matchesSignature(buffer, sig)) };
}
