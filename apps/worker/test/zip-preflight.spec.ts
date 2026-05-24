/**
 * Test #3 — Zip-bomb decompressed-size cap (audit-pass v2 C8, HIGH).
 *
 * Two layers:
 *   A. Unit tests against `zipPreflight()` with synthetic zip CD
 *      buffers. We hand-build adversarial CD entries (the bytes that
 *      live AFTER all compressed payloads, declaring uncompressed
 *      sizes) and verify the preflight rejects oversize totals
 *      WITHOUT decompressing anything.
 *   B. Integration: feed a maliciously-crafted xlsx to parseExcelHeader
 *      / parseExcelFull and verify the error surfaces as
 *      ExcelParserError('decompressed_too_large') BEFORE ExcelJS
 *      decompresses (memory delta stays bounded).
 *
 * Pinned invariants:
 *   1. CD entry with realistic 5MB uncompressed → accept, return total
 *   2. CD entries summing to >200MB → 'decompressed_too_large'
 *   3. ZIP64 sentinel (0xFFFFFFFF) → 'decompressed_too_large' (refused)
 *   4. Realistic xlsx workbook → preflight passes, ExcelJS loads
 *   5. Real ExcelJS-built xlsx integration → parseExcelHeader OK
 *   6. The reject fires BEFORE ExcelJS load — memory growth bounded
 */
import { Readable } from 'node:stream';

import { Workbook } from 'exceljs';
import { describe, expect, it } from 'vitest';

import { parseExcelFull, parseExcelHeader } from '../src/parser/excel.parser';
import { MAX_DECOMPRESSED_BYTES, zipPreflight } from '../src/parser/zip-preflight';

/** Build a synthetic zip Central Directory buffer. NOT a valid zip —
 *  we don't need the local file headers or compressed data, only the
 *  CD entries that the preflight scans. Each entry declares whatever
 *  compressed/uncompressed sizes the test wants.
 *
 *  CD entry layout (PKWARE §4.4):
 *    0  : 0x02014b50 (signature, "PK\x01\x02")
 *    4  : version made by (2)
 *    6  : version needed (2)
 *    8  : flags (2)
 *    10 : compression method (2)
 *    12 : last-mod time (2)
 *    14 : last-mod date (2)
 *    16 : crc32 (4)
 *    20 : compressed size (4, LE)
 *    24 : uncompressed size (4, LE)
 *    28 : file name length (2, LE)  — n
 *    30 : extra field length (2, LE) — m
 *    32 : file comment length (2, LE) — k
 *    34 : disk number start (2)
 *    36 : internal attrs (2)
 *    38 : external attrs (4)
 *    42 : local header offset (4)
 *    46 : file name (n bytes)
 *    46+n : extra (m bytes)
 *    46+n+m : comment (k bytes)
 */
function buildCdEntry(opts: {
  compressedSize: number;
  uncompressedSize: number;
  fileName: string;
}): Buffer {
  const fileName = Buffer.from(opts.fileName, 'utf8');
  const headerSize = 46;
  const buf = Buffer.alloc(headerSize + fileName.length);
  buf.writeUInt32LE(0x02014b50, 0); // CD signature
  // ... bytes 4-19 left as zeros (we don't care)
  buf.writeUInt32LE(opts.compressedSize, 20);
  buf.writeUInt32LE(opts.uncompressedSize, 24);
  buf.writeUInt16LE(fileName.length, 28);
  buf.writeUInt16LE(0, 30); // extra field length
  buf.writeUInt16LE(0, 32); // file comment length
  // bytes 34-45 left as zeros
  fileName.copy(buf, 46);
  // v8 SOLID-3 / Sec-7: zip-preflight now magic-checks the first 4
  // bytes BEFORE scanning the central directory. These hand-crafted
  // CD-only test fixtures lack the local-file-header (50 4B 03 04)
  // that real ZIPs start with. Prepend it so the unit tests still
  // exercise the CD-scan / decompressed-size guard rather than
  // tripping the new magic-byte gate.
  const lfh = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  return Buffer.concat([lfh, buf]);
}

describe('Test #3a — zipPreflight unit (audit-pass v2 C8)', () => {
  it('1) realistic 5MB uncompressed entry → accept, return totals', () => {
    const buf = buildCdEntry({
      compressedSize: 500_000,
      uncompressedSize: 5_000_000,
      fileName: 'xl/sharedStrings.xml',
    });
    const out = zipPreflight(buf);
    expect(out.totalUncompressed).toBe(5_000_000);
    expect(out.entryCount).toBe(1);
  });

  it('2) two entries summing >200MB → decompressed_too_large', () => {
    const entry = buildCdEntry({
      compressedSize: 100_000,
      uncompressedSize: 150_000_000, // 150MB each
      fileName: 'a',
    });
    // Two such entries = 300MB > 200MB cap.
    const buf = Buffer.concat([entry, entry]);
    expect(() => zipPreflight(buf)).toThrow(
      expect.objectContaining({ name: 'ExcelParserError', code: 'decompressed_too_large' }),
    );
  });

  it('3) ZIP64 sentinel uncompressedSize → decompressed_too_large', () => {
    // Real ZIP64 archives stash the size in the extra field. We refuse
    // outright — legitimate 50MB-cap xlsx never needs ZIP64.
    const buf = buildCdEntry({
      compressedSize: 1000,
      uncompressedSize: 0xffffffff,
      fileName: 'sentinel',
    });
    expect(() => zipPreflight(buf)).toThrow(
      expect.objectContaining({ code: 'decompressed_too_large' }),
    );
  });

  it('3b) ZIP64 sentinel compressedSize → also refused', () => {
    const buf = buildCdEntry({
      compressedSize: 0xffffffff,
      uncompressedSize: 100,
      fileName: 'sentinel-c',
    });
    expect(() => zipPreflight(buf)).toThrow(
      expect.objectContaining({ code: 'decompressed_too_large' }),
    );
  });

  it('4) single entry RIGHT AT the cap → accept', () => {
    const buf = buildCdEntry({
      compressedSize: 1024,
      uncompressedSize: MAX_DECOMPRESSED_BYTES,
      fileName: 'borderline',
    });
    const out = zipPreflight(buf);
    expect(out.totalUncompressed).toBe(MAX_DECOMPRESSED_BYTES);
  });

  it('5) single entry one byte OVER the cap → reject', () => {
    const buf = buildCdEntry({
      compressedSize: 1024,
      uncompressedSize: MAX_DECOMPRESSED_BYTES + 1,
      fileName: 'over',
    });
    expect(() => zipPreflight(buf)).toThrow(
      expect.objectContaining({ code: 'decompressed_too_large' }),
    );
  });

  it('6) non-zip buffer → rejected by v8 magic-byte gate (was: passed-through to ExcelJS)', () => {
    // v8 SOLID-3 / Sec-7: the magic-byte gate now rejects non-ZIP
    // input BEFORE the CD scan, with a more specific error code
    // (`wrong_file_type`) than the previous "let ExcelJS fail with
    // generic corrupt_file" posture.
    const buf = Buffer.from('not a zip at all, just text');
    expect(() => zipPreflight(buf)).toThrow(expect.objectContaining({ code: 'wrong_file_type' }));
  });

  it('7) MANY small entries summing to a safe total → accept', () => {
    // 40 entries × 1MB each = 40MB total (under the 50MB cap, D4 fix).
    const entry = buildCdEntry({
      compressedSize: 100,
      uncompressedSize: 1_000_000,
      fileName: 'small',
    });
    const buf = Buffer.concat(Array(40).fill(entry));
    const out = zipPreflight(buf);
    expect(out.entryCount).toBe(40);
    expect(out.totalUncompressed).toBe(40_000_000);
  });

  it('8) MANY small entries summing OVER cap → reject (fail-fast)', () => {
    // 100 entries × 1MB = 100MB > 50MB cap (D4). Preflight should throw
    // mid-loop without examining all 100.
    const entry = buildCdEntry({
      compressedSize: 100,
      uncompressedSize: 1_000_000,
      fileName: 's',
    });
    const buf = Buffer.concat(Array(100).fill(entry));
    expect(() => zipPreflight(buf)).toThrow(
      expect.objectContaining({ code: 'decompressed_too_large' }),
    );
  });
});

describe('Test #3b — zipPreflight integration vs real xlsx', () => {
  it('9) realistic xlsx → preflight passes, parseExcelHeader succeeds', async () => {
    const wb = new Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['national_id', 'phone', 'name', 'apartment', 'address']);
    for (let i = 0; i < 50; i += 1) {
      ws.addRow([`12345678${i % 10}`, '0501234567', `Name${i}`, String(i + 1), 'Herzl 10']);
    }
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    // Preflight pure:
    const summary = zipPreflight(buf);
    expect(summary.entryCount).toBeGreaterThan(0);
    expect(summary.totalUncompressed).toBeLessThan(MAX_DECOMPRESSED_BYTES);

    // End-to-end:
    const out = await parseExcelHeader(Readable.from(buf));
    expect(out.rowCount).toBe(50);
  });

  it('10) hand-built oversize CD prepended to a real xlsx → rejected BEFORE ExcelJS load', async () => {
    // Build a real xlsx as a control, then prepend a CD entry claiming
    // 500MB uncompressed. The preflight scans from byte 0 forward and
    // hits our planted entry first.
    const wb = new Workbook();
    wb.addWorksheet('Sheet1').addRow(['a', 'b']);
    const realXlsx = Buffer.from(await wb.xlsx.writeBuffer());
    const bomb = buildCdEntry({
      compressedSize: 1024,
      uncompressedSize: 500_000_000,
      fileName: 'bomb',
    });
    const adversarial = Buffer.concat([bomb, realXlsx]);

    // The preflight finds the bomb entry first → reject.
    await expect(parseExcelFull(Readable.from(adversarial))).rejects.toMatchObject({
      name: 'ExcelParserError',
      code: 'decompressed_too_large',
    });
  });

  it('11) memory delta on rejection stays bounded (no OOM-allocate-then-throw)', async () => {
    // The preflight must FAIL FAST without allocating the decompressed
    // surface. We measure heapUsed before/after and assert growth is
    // small (<10MB), which proves no decompression happened.
    if (global.gc) global.gc();
    const before = process.memoryUsage().heapUsed;

    const bomb = buildCdEntry({
      compressedSize: 1000,
      uncompressedSize: 2 ** 30, // 1GB
      fileName: 'oom',
    });
    try {
      zipPreflight(bomb);
    } catch {
      /* expected */
    }

    if (global.gc) global.gc();
    const delta = process.memoryUsage().heapUsed - before;
    // The bomb buffer itself is ~50 bytes; preflight allocates nothing
    // material. 10MB headroom for V8 / vitest overhead.
    expect(delta).toBeLessThan(10 * 1024 * 1024);
  });
});
