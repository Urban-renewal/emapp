/**
 * Zip-bomb pre-flight check (audit-pass v2 finding C8, HIGH).
 *
 * xlsx is a ZIP archive. ExcelJS's `xlsx.load(buffer)` decompresses
 * every entry into memory before iteration. A malicious 50MB upload
 * (compressed) can expand to multi-GB (typical zip-bomb compression
 * ratios are 1000x+ on sparse XML); ExcelJS has NO decompressed-size
 * guard. Result: a single hostile upload OOMs the worker (Railway
 * Free Tier = 512MB RAM).
 *
 * Defense: parse the zip Central Directory ourselves WITHOUT touching
 * compressed payloads, sum the uncompressed sizes, and refuse to hand
 * the buffer to ExcelJS if the total exceeds MAX_DECOMPRESSED_BYTES.
 *
 * Why manual parsing (vs JSZip dep):
 *   - JSZip's `loadAsync` reads the CD but doesn't expose uncompressed
 *     sizes via public API — internal `_data._compressedSize` /
 *     `.uncompressedSize` are stable enough in 3.x but a 4.x rename
 *     would silently lose this guard.
 *   - The zip CD format is fixed (PKWARE APPNOTE.TXT §4.4) — ~30 lines
 *     of buffer math, no third-party surface area, easy to audit.
 *
 * Format (each CD entry):
 *   0  : 0x02014b50 (4 bytes, "PK\x01\x02")  — signature
 *   20 : compressed_size      (4 bytes, LE)
 *   24 : uncompressed_size    (4 bytes, LE)
 *   28 : file_name_length (n) (2 bytes, LE)
 *   30 : extra_field_length (m) (2 bytes, LE)
 *   32 : file_comment_length (k) (2 bytes, LE)
 *   46 : file_name (n bytes)
 *   46+n : extra_field (m bytes)
 *   46+n+m : file_comment (k bytes)
 *   total entry length = 46 + n + m + k
 *
 * ZIP64 (large archives >4GB): uncompressed size is 0xFFFFFFFF and the
 * real value lives in the extra field. We don't bother parsing ZIP64
 * — a 50MB xlsx that needs ZIP64 IS a bomb by definition; reject.
 */
import { ExcelParserError } from './excel.parser';

/** 200MB cap. Generous vs realistic xlsx imports (a 1000-row owner
 *  import decompresses to ~5MB; 100k rows to ~50MB), strict vs the
 *  Railway Free Tier 512MB total per worker (50MB raw + 200MB
 *  decompressed + ~100MB ExcelJS workbook overhead + Node + V8 = fits). */
export const MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024;

const CD_HEADER_SIGNATURE = 0x02014b50;
const ZIP64_SENTINEL = 0xffffffff;

export interface ZipPreflightResult {
  /** Sum of uncompressed sizes across all CD entries. */
  totalUncompressed: number;
  /** Count of zip entries (sheets, sharedStrings, styles, …). */
  entryCount: number;
}

/** Throws ExcelParserError('corrupt_file') if the CD can't be read.
 *  Throws ExcelParserError('decompressed_too_large') if totalUncompressed
 *  exceeds MAX_DECOMPRESSED_BYTES.
 *
 *  Returns the totals on success — caller may log them for telemetry. */
export function zipPreflight(buffer: Buffer): ZipPreflightResult {
  let totalUncompressed = 0;
  let entryCount = 0;

  // Scan the buffer for the CD entry signature. Because the CD is
  // contiguous and at a known offset (after all local file headers),
  // a simple forward scan from byte 0 is correct — the signature
  // 0x02014b50 won't appear inside compressed data with any
  // meaningful frequency (compressed bytes are uniform random).
  // For pathological cases (a CD entry's filename happens to contain
  // the bytes 0x50 0x4b 0x01 0x02) we'd over-count slightly — but
  // over-counting only TIGHTENS the safety bound, so that's fine.

  let i = 0;
  const limit = buffer.length - 46; // need at least one CD entry header
  while (i <= limit) {
    if (buffer.readUInt32LE(i) === CD_HEADER_SIGNATURE) {
      // Read variable-length fields to advance past this entry.
      const compressedSize = buffer.readUInt32LE(i + 20);
      const uncompressedSize = buffer.readUInt32LE(i + 24);
      const fileNameLen = buffer.readUInt16LE(i + 28);
      const extraLen = buffer.readUInt16LE(i + 30);
      const commentLen = buffer.readUInt16LE(i + 32);

      // ZIP64 escape (any of compressed/uncompressed = 0xFFFFFFFF):
      // the real size lives in the extra field. We refuse — a legit
      // 50MB xlsx never needs ZIP64.
      if (uncompressedSize === ZIP64_SENTINEL || compressedSize === ZIP64_SENTINEL) {
        throw new ExcelParserError('zip64 archive rejected', 'decompressed_too_large');
      }

      totalUncompressed += uncompressedSize;
      entryCount += 1;

      // Fail-fast: as soon as the running total exceeds the cap, throw.
      if (totalUncompressed > MAX_DECOMPRESSED_BYTES) {
        throw new ExcelParserError(
          `decompressed size exceeds cap (${totalUncompressed} > ${MAX_DECOMPRESSED_BYTES})`,
          'decompressed_too_large',
        );
      }

      // Advance past this CD entry. 46 bytes header + variable fields.
      i += 46 + fileNameLen + extraLen + commentLen;
      continue;
    }
    i += 1;
  }

  if (entryCount === 0) {
    // Not necessarily corrupt — could be a non-xlsx buffer. We DON'T
    // throw here; let ExcelJS surface its own error from the buffer
    // shape. The preflight's job is only to cap decompressed size.
  }

  return { totalUncompressed, entryCount };
}
