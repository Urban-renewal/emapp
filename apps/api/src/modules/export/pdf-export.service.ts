import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { Injectable, Logger } from '@nestjs/common';
import { chromium, type Browser } from 'playwright-core';

import type {
  ProjectExportApartment,
  ProjectExportBuilding,
  ProjectExportInput,
  ProjectExportOwner,
} from './export.service';

/**
 * V11 B.S9 — Project → PDF export service (Phase 7 / D.38 scope).
 *
 * Reads the SAME `ProjectExportInput` shape as the B.S8 xlsx service
 * so the two formats stay column-aligned. Renders an HTML template
 * server-side with the Heebo font base64-embedded, then converts to
 * PDF via headless Chromium.
 *
 * Why playwright-core (not puppeteer, which the V11 master plan
 * literally names):
 *   - Playwright is already installed in `apps/web` for E2E and ships
 *     a headless Chromium binary in `~/.cache/ms-playwright/`.
 *   - `playwright-core` is the just-the-JS-API package (no browser
 *     download), so installing it as a runtime dep on apps/api adds
 *     ~5 MB of code and zero MB of binaries — versus puppeteer's
 *     ~300 MB Chromium pull.
 *   - The user authorised the deviation explicitly ("puppeteer-core
 *     + reuse playwright's Chromium" / "תמשיך"). playwright-core is
 *     the same intent (reuse playwright's chromium) with one fewer
 *     npm dep than puppeteer-core would need.
 *   - Production: Railway containers can preinstall the same browsers
 *     via `playwright install --with-deps chromium` in the buildpack
 *     hook; identical CLI to what `apps/web` already runs in CI.
 *
 * Heebo embedding:
 *   - Source: `@fontsource/heebo` (Google Fonts OFL, npm-distributed
 *     so we get a stable, version-pinned TTF/WOFF2 instead of fetching
 *     Google Fonts at render time — which would (a) leak the render
 *     to Google, (b) add latency, (c) break in air-gapped Railway).
 *   - We embed Hebrew 400 + 700 (regular + bold) only. Latin 400/700
 *     come along for Heebo's Latin fallback (project IDs, English
 *     descriptions). Total embed size ~80 KB.
 *   - Embedded as base64 `@font-face` URLs in the HTML <style> so the
 *     PDF is fully self-contained — recipients with no Heebo install
 *     still see the document exactly as the manager rendered it.
 *
 * Conventions (pinned by `pdf-export.service.spec.ts`):
 *   - Output starts with the 4 bytes `%PDF` and ends with `%%EOF`
 *     (well-formed PDF wrapper).
 *   - At least one page (we render landscape A4; long tables paginate
 *     automatically via CSS).
 *   - Hebrew text in the PDF stream — the spec greps the raw bytes
 *     for the Hebrew header labels to prove the embedded font carried
 *     them through (PDFs encode glyphs, not literal UTF-8 for non-
 *     ASCII; for woff2-embedded fonts the literal text typically
 *     does survive as a /ToUnicode CMap reverse-mapping. Where it
 *     does not, the test falls back to asserting at least one Hebrew
 *     codepoint anywhere in the byte stream.)
 *   - PII safety: same posture as B.S8 — workbook-equivalent metadata
 *     (PDF /Info dict: /Producer, /Creator, /Author) NEVER contains
 *     national_id or phone strings.
 *
 * Performance budget (docs/03 §11 T7.8): 1000 rows < 45 s. We
 * launch one Chromium per call; a pool comes in a follow-up when
 * concurrent exports become common (the master plan calls for "4
 * pages פתוחות מראש" but a pool only matters at >1 concurrent caller
 * and the MVP has none yet).
 */
@Injectable()
export class PdfExportService {
  private readonly logger = new Logger(PdfExportService.name);

  // Lazily read on first render; once loaded, the base64 strings stay
  // in process memory (~80 KB). woff2 is already the smallest font
  // wire format, no further compression possible.
  private cachedFontCss: string | null = null;

  /**
   * Render a project to a PDF Buffer. Caller composes the input from
   * inside `withTenant` (B.S10 will own that boundary).
   */
  /**
   * Exposed publicly so the B.S9 smoke script can screenshot the same
   * HTML the PDF rasterises from (closes the visual-smoke gap recorded
   * in `feedback_visual_smoke_gap.md`). Pure function of input + the
   * lazily-cached Heebo CSS.
   */
  renderProjectHtml(input: ProjectExportInput): string {
    return this.buildHtml(input);
  }

  async renderProjectPdf(input: ProjectExportInput): Promise<Buffer> {
    const t0 = Date.now();
    const html = this.buildHtml(input);
    const browser = await this.launchBrowser();
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      // `setContent` returns when the DOM is ready, but `document.fonts.ready`
      // is the only signal that @font-face has actually parsed + rasterised
      // the base64 woff2. Without this wait, Chromium emits the PDF with the
      // fallback (Arial) glyphs instead of Heebo — visible in the visual
      // smoke and detectable in tests as the absence of a /FontFile*
      // reference in the PDF stream.
      await page.setContent(html, { waitUntil: 'load' });
      // page.evaluate runs in the browser context — `document` exists
      // there, not in our Node tsconfig.lib. Cast to `unknown` then
      // call to bypass the missing-DOM-types check.
      await page.evaluate(
        () =>
          (globalThis as unknown as { document: { fonts: { ready: Promise<void> } } }).document
            .fonts.ready,
      );
      const pdf = await page.pdf({
        format: 'A4',
        landscape: true,
        printBackground: true,
        margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' },
      });
      const dataRows = this.dataRowCount(input);
      this.logger.log(
        `rendered project ${input.project.id} → pdf (${dataRows} data rows, ${pdf.byteLength} bytes, ${Date.now() - t0}ms)`,
      );
      // playwright returns a Node Buffer on Node runtime; the type
      // is `Buffer` already but TS sees Uint8Array — cast for clarity.
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }

  private async launchBrowser(): Promise<Browser> {
    // Honours the standard playwright env (PLAYWRIGHT_BROWSERS_PATH,
    // PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH). On dev machines + CI that
    // ran `pnpm --filter @emapp/web test:e2e:install`, the binary is
    // already discoverable; no extra config needed.
    return chromium.launch({ headless: true });
  }

  private dataRowCount(input: ProjectExportInput): number {
    let n = 0;
    for (const b of input.buildings) {
      for (const apt of b.apartments) {
        n += Math.max(1, apt.owners.length);
      }
    }
    return n;
  }

  private fontCss(): string {
    if (this.cachedFontCss !== null) return this.cachedFontCss;
    // Use createRequire so we get the same module-resolution algorithm
    // pnpm wired up at install time (handles pnpm's symlinked node_modules
    // layout) — works under both CJS (Nest's webpack output) and ESM
    // (Vitest). `import.meta.url` works under ESM only; createRequire
    // accepts the same URL/path and bridges into the CJS resolver.
    const req = createRequire(__filename);
    const files = [
      'heebo-hebrew-400-normal.woff2',
      'heebo-hebrew-700-normal.woff2',
      'heebo-latin-400-normal.woff2',
      'heebo-latin-700-normal.woff2',
    ];
    const css = files
      .map((name) => {
        const path = req.resolve(`@fontsource/heebo/files/${name}`);
        const buf = readFileSync(path);
        const b64 = buf.toString('base64');
        const weight = name.includes('700') ? 700 : 400;
        return `@font-face {
  font-family: 'Heebo';
  font-style: normal;
  font-weight: ${weight};
  font-display: block;
  src: url(data:font/woff2;base64,${b64}) format('woff2');
}`;
      })
      .join('\n');
    this.cachedFontCss = css;
    return css;
  }

  private buildHtml(input: ProjectExportInput): string {
    const fmt = new Intl.DateTimeFormat('he-IL', {
      timeZone: 'Asia/Jerusalem',
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    const generatedAtLabel = fmt.format(input.generatedAt);

    const headerCells = [
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
    ];

    const rowsHtml = input.buildings
      .flatMap((b) =>
        b.apartments.flatMap((apt) =>
          apt.owners.length === 0
            ? [this.rowHtml(b, apt, null)]
            : apt.owners.map((owner) => this.rowHtml(b, apt, owner)),
        ),
      )
      .join('\n');

    // Style notes:
    //   - `direction: rtl` on <html> flips text + table column order.
    //   - `lang="he"` engages the recipient's hyphenation / bidi
    //     algorithm correctly even before the embedded font kicks in.
    //   - Print-friendly: A4 landscape, page-break-inside avoid on
    //     rows so a single (apt, owner) tuple doesn't split.
    return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(input.project.name)}</title>
<style>
${this.fontCss()}
* { box-sizing: border-box; }
html, body { font-family: 'Heebo', Arial, sans-serif; margin: 0; padding: 0; color: #1f2937; }
header { padding: 0 0 12px 0; border-bottom: 2px solid #94a3b8; margin-bottom: 12px; }
h1 { font-size: 18pt; font-weight: 700; margin: 0; }
.meta { color: #475569; font-size: 9pt; margin-top: 4px; }
table { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
thead th { background: #e8eef7; border-bottom: 1px solid #94a3b8; padding: 6px 4px; text-align: right; font-weight: 700; }
tbody td { border-bottom: 1px solid #e5e7eb; padding: 5px 4px; vertical-align: middle; }
tr { page-break-inside: avoid; }
.gap { color: #9ca3af; font-style: italic; }
</style>
</head>
<body>
<header>
  <h1>פרויקט: ${escapeHtml(input.project.name)}</h1>
  <div class="meta">סוג: ${escapeHtml(input.project.type)} · סטטוס: ${escapeHtml(input.project.status)}</div>
  <div class="meta">הופק על-ידי ${escapeHtml(input.generatedBy.name)} בתאריך ${escapeHtml(generatedAtLabel)}</div>
</header>
<table>
<thead><tr>${headerCells.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
<tbody>
${rowsHtml}
</tbody>
</table>
</body>
</html>`;
  }

  private rowHtml(
    b: ProjectExportBuilding,
    apt: ProjectExportApartment,
    owner: ProjectExportOwner | null,
  ): string {
    const cells = [
      b.address,
      b.city,
      b.block ?? '',
      b.parcel ?? '',
      apt.number,
      apt.floor === null ? '' : String(apt.floor),
      apt.entrance ?? '',
      unitTypeHebrew(apt.unitType),
      apt.sizeSqm !== null ? String(apt.sizeSqm) : apt.areaSqm !== null ? String(apt.areaSqm) : '',
      apt.rooms !== null ? String(apt.rooms) : '',
      statusHebrew(apt.status),
      owner?.name ?? '',
      owner?.nationalId ?? '',
      owner?.phone ?? '',
      owner ? `${owner.ownershipPct.toFixed(2)}%` : '',
    ];
    const tds = cells
      .map((c, i) => {
        // Mark the owner-name cell as gap when there's no owner.
        if (!owner && i === 11) return `<td class="gap">— ללא בעלים —</td>`;
        return `<td>${escapeHtml(c)}</td>`;
      })
      .join('');
    return `<tr>${tds}</tr>`;
  }
}

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

function statusHebrew(status: string): string {
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
