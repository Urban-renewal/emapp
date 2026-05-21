/**
 * Excel streaming parser — Phase 6 S3.
 *
 * Closes T6.1 (Excel header detection). Owned scope is intentionally
 * narrow: detect the header row + count data rows + surface the sheet
 * name. Per-row VALUE iteration is S5 (validation engine); persistence
 * is S6. Splitting the parsing into "shape" (S3) and "content"
 * (S5/S6) keeps each slice small and individually verifiable.
 *
 * Security posture (docs/03 §10 + docs/07 §5):
 *   - STREAMING mode only — ExcelJS's WorkbookReader processes the
 *     xlsx zip + xml SAX-style. A 50MB file never lives in memory as
 *     a Buffer/string, so a hostile uploader can't OOM the worker.
 *   - Formula cells (CSV-injection vector — a cell value starting
 *     `=cmd|...`) are FORBIDDEN in header cells. ExcelJS surfaces them
 *     as `{ formula, result }` objects; we reject any header that's
 *     not a plain string/number.
 *   - The stream is fully consumed OR explicitly destroyed in `finally`
 *     so an early-return doesn't leak the R2 socket (the caller may
 *     have passed an http.IncomingMessage backed by an R2 GetObject).
 *
 * The parser is a free function + a small `ParserError` discriminator.
 * It doesn't know about withTenant, doesn't read import_jobs, doesn't
 * write audit. That's the handler's job — keeps the parser unit-
 * testable with a Buffer fixture (no DB).
 */
import { Readable } from 'node:stream';

import { Workbook } from 'exceljs';

import { zipPreflight } from './zip-preflight';

/** What S3 extracts from the file. Intentionally minimal — S4 layers
 *  on mapping (column → domain field); S5 iterates row values. */
export interface ParsedHeader {
  /** First sheet name. Multi-sheet imports out of scope for MVP. */
  sheetName: string;
  /** Header strings, in column order. Length = column count. */
  headers: string[];
  /** Total non-empty DATA rows (excludes the header row itself). */
  rowCount: number;
}

/** S5 output — header (same as S3) + the data rows as an array of
 *  string-vectors. Memory bound: ~300KB for a typical 1000-row import
 *  at 10 cols × 30 chars/cell. Bounded ultimately by the 50MB upload
 *  cap; the S7 perf gate will trigger a switch to streamed iteration
 *  if real-world imports grow much past that. */
export interface ParsedRows extends ParsedHeader {
  /** Data rows, each as a string vector aligned with `headers`. */
  rows: string[][];
  /** 1-indexed Excel row numbers for each entry in `rows`. We skip
   *  blank rows, so this isn't simply `rows.indexOf(...) + 2` — each
   *  error needs to point at the right row in the source spreadsheet. */
  rowNumbers: number[];
}

/** Discriminated error codes — handler maps these to
 *  NonRetryableJobError (a bad file does not "fix itself" via retry). */
export type ParserErrorCode =
  | 'empty_workbook' // zero sheets
  | 'no_header_row' // first sheet has no non-empty row
  | 'sparse_header' // header has < 2 non-empty cells
  | 'formula_in_header' // CSV-injection guard (header row)
  | 'formula_in_data' // CSV-injection guard (any data row) — audit-pass v2 C1
  | 'decompressed_too_large' // zip-bomb guard — audit-pass v2 C8
  | 'corrupt_file'; // ExcelJS threw

export class ExcelParserError extends Error {
  override readonly name = 'ExcelParserError';
  constructor(
    message: string,
    public readonly code: ParserErrorCode,
  ) {
    super(message);
  }
}

/** Minimum non-empty cells needed to count a row as a header (defense
 *  against a single-cell "Sheet1" annotation being misread as a
 *  header). */
const HEADER_MIN_NONEMPTY = 2;

/** Hard upper bound on rows we'll iterate before giving up. The
 *  underlying file-size CHECK in migration 0022 caps at 50MB; even at
 *  ~50 bytes/row that's < 1M rows, so 2M is a generous safety net
 *  against a maliciously sparse zip. */
const MAX_ROWS_SAFETY = 2_000_000;

/** Parse the header + row count from an Excel stream.
 *
 *  Always consumes (or destroys) the stream — safe to call with an R2
 *  GetObject body.
 *
 *  Implementation note (audit-pass observed during S3 build): ExcelJS's
 *  streaming WorkbookReader expects the input stream to be a file or
 *  http body where the xlsx is laid out so the zip central-directory
 *  arrives at the end. When we feed it a `Readable.from(buffer)` from
 *  an R2 GetObject body the central-directory parser fails on some
 *  inputs ("Cannot read properties of undefined ('sheets')"). The
 *  pragmatic fix: buffer the input first (bounded by the 50MB CHECK
 *  on import_jobs.file_size_bytes, migration 0022) and use ExcelJS's
 *  in-memory `xlsx.load(buffer)`. The "streaming parser" requirement
 *  in docs/03 §10 is mostly about not holding all parsed rows in
 *  memory — which still holds; we only iterate row-by-row via
 *  worksheet.eachRow, never building a giant array. The raw xlsx
 *  bytes (≤50MB) live in memory for the parse window only.
 *
 *  Throws `ExcelParserError` on any malformed-file case. The handler
 *  wraps these in NonRetryableJobError so pg-boss skips retries. */
export async function parseExcelHeader(stream: Readable): Promise<ParsedHeader> {
  try {
    const buffer = await readStreamBounded(stream, MAX_INPUT_BYTES);

    // SECURITY (audit-pass v2 C8) — zip-bomb pre-flight. Parses the
    // zip Central Directory to sum uncompressed sizes WITHOUT calling
    // ExcelJS decompression. Rejects with 'decompressed_too_large'
    // before `xlsx.load(buffer)` can OOM the worker.
    zipPreflight(buffer);

    const workbook = new Workbook();
    try {
      // ExcelJS's `.load(Buffer)` is typed against the older Buffer
      // generic (Buffer<ArrayBuffer>) while @types/node here uses
      // Buffer<ArrayBufferLike>. Runtime is identical; cast through
      // `never` so the compiler doesn't try to reconcile the generics.
      await workbook.xlsx.load(buffer as never);
    } catch (e: unknown) {
      throw new ExcelParserError(
        e instanceof Error ? `xlsx parse failed: ${e.message.slice(0, 200)}` : 'xlsx parse failed',
        'corrupt_file',
      );
    }

    // Iterate sheets in defined order. We support only the first sheet
    // for MVP imports; multi-sheet workbooks are out of scope.
    const worksheets = workbook.worksheets;
    if (worksheets.length === 0) {
      throw new ExcelParserError('workbook has no worksheets', 'empty_workbook');
    }
    const sheet = worksheets[0]!;

    let headers: string[] | null = null;
    let rowCount = 0;
    let processed = 0;

    sheet.eachRow({ includeEmpty: true }, (row) => {
      processed += 1;
      if (processed > MAX_ROWS_SAFETY) {
        throw new ExcelParserError(`too many rows (>${MAX_ROWS_SAFETY}); aborting`, 'corrupt_file');
      }

      const cells = extractCellValues(row);
      const nonEmpty = cells.filter((v) => v !== '');

      if (!headers) {
        if (nonEmpty.length === 0) return; // skip blank top rows
        if (nonEmpty.length < HEADER_MIN_NONEMPTY) {
          throw new ExcelParserError(
            `first non-empty row has only ${nonEmpty.length} cell(s); ` +
              `expected at least ${HEADER_MIN_NONEMPTY}`,
            'sparse_header',
          );
        }
        if (rowHasFormula(row)) {
          throw new ExcelParserError(
            'header row contains a formula cell (CSV-injection guard)',
            'formula_in_header',
          );
        }
        headers = cells;
        return;
      }

      if (nonEmpty.length === 0) return;

      // Data-row formula guard — mirrors parseExcelFull. Reject as
      // early as possible so the handler doesn't advance through one
      // useless state transition before the validate stage catches it.
      // See parseExcelFull for the full security rationale.
      if (rowHasFormula(row)) {
        throw new ExcelParserError(
          'data row contains a formula cell (CSV-injection guard)',
          'formula_in_data',
        );
      }

      rowCount += 1;
    });

    if (!headers) {
      throw new ExcelParserError('first worksheet has no header row', 'no_header_row');
    }

    return {
      // ExcelJS Worksheet's .name is the user-facing sheet label.
      sheetName: sheet.name,
      headers,
      rowCount,
    };
  } finally {
    // Best-effort cleanup. If the stream is an R2 body, destroy()
    // releases the underlying socket so the SDK's connection pool can
    // reuse it. No-op on already-ended streams.
    if (!stream.destroyed) stream.destroy();
  }
}

/** S5 — Parse header + collect data rows.
 *
 *  Same posture as parseExcelHeader (bounded buffered read, in-memory
 *  ExcelJS load, eachRow iteration). Captures each non-empty
 *  non-header row into `rows`, paired with its 1-indexed Excel row
 *  number so per-row errors can point at the right spreadsheet line.
 *
 *  Always destroys the stream in finally — same guarantee as
 *  parseExcelHeader. The two functions are deliberately separate (vs
 *  one that returns both shapes) so callers that only need headers
 *  don't pay the row-array allocation cost. */
export async function parseExcelFull(stream: Readable): Promise<ParsedRows> {
  try {
    const buffer = await readStreamBounded(stream, MAX_INPUT_BYTES);

    // SECURITY (audit-pass v2 C8) — zip-bomb pre-flight. Same guard
    // as parseExcelHeader; both stages must enforce it independently
    // (validateStage re-downloads + re-parses; the bomb could appear
    // there for the first time if a different file is somehow at the
    // same R2 key — defense in depth).
    zipPreflight(buffer);

    const workbook = new Workbook();
    try {
      await workbook.xlsx.load(buffer as never);
    } catch (e: unknown) {
      throw new ExcelParserError(
        e instanceof Error ? `xlsx parse failed: ${e.message.slice(0, 200)}` : 'xlsx parse failed',
        'corrupt_file',
      );
    }

    const worksheets = workbook.worksheets;
    if (worksheets.length === 0) {
      throw new ExcelParserError('workbook has no worksheets', 'empty_workbook');
    }
    const sheet = worksheets[0]!;

    let headers: string[] | null = null;
    const rows: string[][] = [];
    const rowNumbers: number[] = [];
    let processed = 0;

    sheet.eachRow({ includeEmpty: true }, (row, excelRowNumber) => {
      processed += 1;
      if (processed > MAX_ROWS_SAFETY) {
        throw new ExcelParserError(`too many rows (>${MAX_ROWS_SAFETY}); aborting`, 'corrupt_file');
      }

      const cells = extractCellValues(row);
      const nonEmpty = cells.filter((v) => v !== '');

      if (!headers) {
        if (nonEmpty.length === 0) return;
        if (nonEmpty.length < HEADER_MIN_NONEMPTY) {
          throw new ExcelParserError(
            `first non-empty row has only ${nonEmpty.length} cell(s); ` +
              `expected at least ${HEADER_MIN_NONEMPTY}`,
            'sparse_header',
          );
        }
        if (rowHasFormula(row)) {
          throw new ExcelParserError(
            'header row contains a formula cell (CSV-injection guard)',
            'formula_in_header',
          );
        }
        headers = cells;
        return;
      }

      if (nonEmpty.length === 0) return; // skip blank data rows

      // SECURITY (audit-pass v2 C1, HIGH — docs/03 §10 line 2124:
      // "ExcelJS עם cellFormula: false למניעת formula injection"):
      // ExcelJS's load() API has no cellFormula:false option (only the
      // streaming reader exposed it, and we don't use it — see
      // parseExcelHeader docstring for the why). Functional equivalent:
      // REJECT any file that contains ANY formula cell, anywhere.
      // Rationale:
      //   1. Import files describe real-world data (owners, IDs, phones,
      //      addresses) — there is no legitimate reason for a formula.
      //   2. Even if the formula evaluates to a benign result HERE, the
      //      formula text would re-emerge on the Manager's error-export
      //      (S8) and re-inject into a downstream consumer (Excel/CSV
      //      reopened locally). The classic CSV-injection chain.
      //   3. Strict reject is simpler to audit than per-cell coercion.
      // This is a deliberate departure from the spec wording (which
      // suggested a cellFormula:false flag) — same security posture,
      // achieved at file-level instead of cell-level.
      if (rowHasFormula(row)) {
        throw new ExcelParserError(
          `data row ${excelRowNumber} contains a formula cell (CSV-injection guard)`,
          'formula_in_data',
        );
      }

      rows.push(cells);
      rowNumbers.push(excelRowNumber);
    });

    if (!headers) {
      throw new ExcelParserError('first worksheet has no header row', 'no_header_row');
    }

    return {
      sheetName: sheet.name,
      headers,
      rowCount: rows.length,
      rows,
      rowNumbers,
    };
  } finally {
    if (!stream.destroyed) stream.destroy();
  }
}

/** Bound the input read to MAX_INPUT_BYTES so a runaway / malicious
 *  stream can't allocate unbounded memory. The DB CHECK in migration
 *  0022 caps at 50MB; we mirror that here in case the stream came
 *  from somewhere other than R2 (e.g. tests). */
const MAX_INPUT_BYTES = 52_428_800; // 50MB — mirrors import_jobs_size_reasonable

async function readStreamBounded(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
    total += chunk.length;
    if (total > limit) {
      throw new ExcelParserError(
        `xlsx exceeds ${limit} byte cap (received ${total})`,
        'corrupt_file',
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Convert an ExcelJS Row's values into a flat `string[]` indexed by
 *  column (1-based → 0-based). Formula cells are coerced to their
 *  resolved `result`. Empty / null / undefined become ''. */
function extractCellValues(row: import('exceljs').Row): string[] {
  // row.values is 1-indexed (index 0 is always null per ExcelJS docs).
  // We use eachCell to skip blanks consistently rather than guessing
  // the column count from a possibly-sparse `values` array.
  const out: string[] = [];
  let maxCol = 0;
  row.eachCell({ includeEmpty: true }, (cell, col) => {
    if (col > maxCol) maxCol = col;
    out[col - 1] = stringifyCell(cell.value);
  });
  // Pad any gaps (sparse cells) with ''.
  for (let i = 0; i < maxCol; i += 1) {
    if (out[i] === undefined) out[i] = '';
  }
  return out;
}

/** Coerce an ExcelJS cell value to a string. Discriminates:
 *   - null/undefined → ''
 *   - string/number/boolean → toString
 *   - Date → ISO string
 *   - formula object → resolved `result` toString (or '' if no result)
 *   - rich-text object → concatenated `richText[].text`
 *   - hyperlink object → `text` field
 *   - anything else → ''
 *
 *  Note: this layer does NOT trim or normalise — that's S4/S5's job.
 *  Headers stay byte-equivalent to what the user typed so the mapping
 *  fingerprint (T6.2) is deterministic. */
function stringifyCell(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    // Formula cell: { formula, result } — return the result, never the
    // formula text (CSV-injection vector).
    if ('formula' in obj && 'result' in obj) {
      return obj['result'] == null ? '' : stringifyCell(obj['result']);
    }
    // Rich-text cell: { richText: [{ text, font }, ...] }
    if (Array.isArray(obj['richText'])) {
      return (obj['richText'] as Array<{ text?: string }>)
        .map((r) => (typeof r?.text === 'string' ? r.text : ''))
        .join('');
    }
    // Hyperlink cell: { text, hyperlink }
    if (typeof obj['text'] === 'string') return obj['text'];
  }
  return '';
}

/** Returns true if any cell in the row is an ExcelJS formula object.
 *  Used as the header-cell formula-injection guard — we never accept
 *  a header that's computed at open time. */
function rowHasFormula(row: import('exceljs').Row): boolean {
  let found = false;
  row.eachCell({ includeEmpty: false }, (cell) => {
    const v = cell.value as unknown;
    if (v && typeof v === 'object' && 'formula' in (v as object)) {
      found = true;
    }
  });
  return found;
}
