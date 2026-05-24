/**
 * T6.1 — Excel header detection.
 *
 * Pure unit tests against the parser. Fixtures are built in-memory
 * with ExcelJS's writer so we can vary header shape, formulas, blank
 * rows, sparse cells, Hebrew text, etc. without storing binary
 * fixtures in the repo.
 *
 * Asserts (T6.1 + security):
 *   1. Standard 2-column header + N data rows → correct headers + rowCount
 *   2. Hebrew headers parse byte-equivalent
 *   3. Leading blank rows skipped — first non-empty row is the header
 *   4. Trailing blank rows excluded from rowCount
 *   5. Sparse header (1 cell) → ExcelParserError('sparse_header')
 *   6. Formula in header → ExcelParserError('formula_in_header')
 *   7. Empty workbook → ExcelParserError('empty_workbook')
 *   8. No header row in first sheet → ExcelParserError('no_header_row')
 *   9. Number / Date cells in header → stringified, accepted
 *  10. Stream destruction in finally — no leak when parse throws
 */
import { Readable } from 'node:stream';

import { Workbook, type Worksheet } from 'exceljs';
import { describe, expect, it } from 'vitest';

import { ExcelParserError, parseExcelHeader } from '../src/parser/excel.parser';

/** Build an xlsx Buffer from a 2D string-or-Date array. Optional `inject`
 *  callback lets a test set a formula cell after rows are written. */
async function buildXlsx(
  rows: Array<Array<string | number | Date | null>>,
  inject?: (ws: Worksheet) => void,
): Promise<Buffer> {
  const wb = new Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (const row of rows) {
    // Null becomes empty cell (preserves sparse-row shape).
    ws.addRow(row.map((v) => (v == null ? null : v)));
  }
  inject?.(ws);
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

function bufToStream(buf: Buffer): Readable {
  return Readable.from(buf);
}

describe('T6.1 — parseExcelHeader', () => {
  it('1) standard 2-col header + 3 data rows', async () => {
    const buf = await buildXlsx([
      ['ID', 'Name'],
      ['1', 'Alice'],
      ['2', 'Bob'],
      ['3', 'Carol'],
    ]);
    const out = await parseExcelHeader(bufToStream(buf));
    expect(out.headers).toEqual(['ID', 'Name']);
    expect(out.rowCount).toBe(3);
  });

  it('2) Hebrew headers parse byte-equivalent', async () => {
    const buf = await buildXlsx([
      ['תעודת זהות', 'טלפון', 'שם'],
      ['123', '050', 'אבי'],
    ]);
    const out = await parseExcelHeader(bufToStream(buf));
    expect(out.headers).toEqual(['תעודת זהות', 'טלפון', 'שם']);
    expect(out.rowCount).toBe(1);
  });

  it('3) leading blank rows skipped — first non-empty is header', async () => {
    const buf = await buildXlsx([
      [null, null],
      [null, null],
      ['col1', 'col2'],
      ['v1', 'v2'],
    ]);
    const out = await parseExcelHeader(bufToStream(buf));
    expect(out.headers).toEqual(['col1', 'col2']);
    expect(out.rowCount).toBe(1);
  });

  it('4) trailing blank rows excluded from rowCount', async () => {
    const buf = await buildXlsx([
      ['a', 'b'],
      ['1', '2'],
      [null, null],
      [null, null],
    ]);
    const out = await parseExcelHeader(bufToStream(buf));
    expect(out.rowCount).toBe(1);
  });

  it('5) sparse header (1 non-empty cell) → sparse_header', async () => {
    const buf = await buildXlsx([['only-one']]);
    await expect(parseExcelHeader(bufToStream(buf))).rejects.toMatchObject({
      name: 'ExcelParserError',
      code: 'sparse_header',
    });
  });

  it('6) formula in header → formula_in_header (CSV-injection guard)', async () => {
    const buf = await buildXlsx(
      [
        ['ok-header-a', 'ok-header-b'],
        ['1', '2'],
      ],
      (ws) => {
        // Replace header cell B1 with a formula. ExcelJS doesn't expose
        // a typed setter for { formula, result }, so we set .value
        // directly with the object shape ExcelJS uses internally.
        const cell = ws.getCell('B1');
        cell.value = { formula: '=SUM(1,2)', result: 3 };
      },
    );
    await expect(parseExcelHeader(bufToStream(buf))).rejects.toMatchObject({
      name: 'ExcelParserError',
      code: 'formula_in_header',
    });
  });

  it('7) empty workbook → wrong_file_type (v8 SOLID-3: zero-byte → magic-byte gate, was corrupt_file)', async () => {
    // ExcelJS refuses to write a workbook without sheets, so simulate
    // an empty/corrupt file with a zero-byte stream. v8 SOLID-3
    // tightened the discrimination: a 0-byte upload can't even fail
    // the ZIP magic check (no bytes to compare), so the new gate
    // raises `wrong_file_type` with the more specific "file too
    // small" message rather than the generic ExcelJS-thrown
    // `corrupt_file`. Better signal for the FE.
    await expect(parseExcelHeader(Readable.from(Buffer.alloc(0)))).rejects.toMatchObject({
      name: 'ExcelParserError',
      code: 'wrong_file_type',
    });
  });

  it('8) only-blank-rows sheet → no_header_row', async () => {
    const buf = await buildXlsx([
      [null, null],
      [null, null],
    ]);
    await expect(parseExcelHeader(bufToStream(buf))).rejects.toMatchObject({
      name: 'ExcelParserError',
      code: 'no_header_row',
    });
  });

  it('9) numeric / date cells in header → stringified, accepted', async () => {
    const buf = await buildXlsx([
      [2026, new Date('2026-01-01T00:00:00.000Z')],
      ['v', 'w'],
    ]);
    const out = await parseExcelHeader(bufToStream(buf));
    // Numbers and dates become their stringified forms; we don't pin
    // the exact format (ExcelJS may render the Date through a number),
    // we only assert "two non-empty header cells".
    expect(out.headers).toHaveLength(2);
    expect(out.headers[0]!.length).toBeGreaterThan(0);
    expect(out.headers[1]!.length).toBeGreaterThan(0);
    expect(out.rowCount).toBe(1);
  });

  it('10) stream is destroyed in finally — no leak when parse throws', async () => {
    const stream = Readable.from(Buffer.alloc(0));
    expect(stream.destroyed).toBe(false);
    await expect(parseExcelHeader(stream)).rejects.toBeInstanceOf(ExcelParserError);
    expect(stream.destroyed).toBe(true);
  });

  it('11) stream is destroyed in finally — no leak on success', async () => {
    const buf = await buildXlsx([
      ['a', 'b'],
      ['1', '2'],
    ]);
    const stream = bufToStream(buf);
    await parseExcelHeader(stream);
    expect(stream.destroyed).toBe(true);
  });
});
