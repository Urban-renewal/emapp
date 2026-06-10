import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { type Browser } from 'playwright-core';

import {
  ChromiumBrowserPool,
  escapeHtml,
  loadHeeboFontCss,
} from '../../common/pdf/chromium-html-pdf';

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
 * Performance budget (docs/03 §11 T7.8): 1000 rows < 45 s. The
 * 1-second user rule (CLAUDE.md: "more than 1 second is excessive") is
 * what drives the Wave 5 F1 fix below.
 *
 * Wave 5 F1 (perf audit 2026-05-28): SINGLETON BROWSER. The previous
 * code launched a fresh Chromium per request (`chromium.launch` in the
 * critical path of `renderProjectPdf`). On Linux containers that is
 * 600-1200 ms baseline (process fork + Chromium init + DevTools
 * handshake) — by itself blowing past the 1 s rule. Now:
 *   - One `Browser` per process, lazy-initialised on first render
 *     (so test suites that never call `renderProjectPdf` don't pay
 *     the launch cost, and dev startup is unaffected).
 *   - Per-request `browser.newContext()` + `.close()` is the
 *     isolation boundary (Playwright contexts are independent cookie/
 *     storage jars; sharing a browser between requests is the
 *     intended pattern).
 *   - `onModuleDestroy` closes the singleton on graceful shutdown.
 *   - Self-heal: if `browser.isConnected()` is false on the next
 *     render (Chromium crashed), we relaunch transparently. Closes
 *     the operational hole where one bad render kills exports forever.
 *
 * Cold path: 1.2-2.5 s on a fresh process. Warm path: ~400-700 ms
 * (newContext + setContent + fonts.ready + page.pdf + context.close).
 * Both fit within the 1 s rule for everything past the first call.
 */
@Injectable()
export class PdfExportService implements OnModuleDestroy {
  private readonly logger = new Logger(PdfExportService.name);

  // Wave 5 F1 + PR #317: singleton browser, lazy-initialised, now provided by
  // the shared ChromiumBrowserPool (same launch dedup, self-heal, and
  // non-leaky 503-on-launch-failure as before — factored out so the signed-
  // certificate renderer reuses ONE Chromium integration).
  private readonly pool = new ChromiumBrowserPool({ headless: true }, (msg) =>
    this.logger.error(`Chromium launch failed: ${msg}`),
  );

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

  async renderProjectPdf(input: ProjectExportInput, signal?: AbortSignal): Promise<Buffer> {
    const t0 = Date.now();
    const html = this.buildHtml(input);
    // Render through the shared pool: get-or-launch the singleton, render in a
    // fresh BrowserContext (Playwright isolation), wait for fonts.ready, close
    // the context (not the browser) so the next call skips the launch. The
    // AbortSignal (from `reply.raw.on('close')`) closes the context early on
    // client disconnect — prevents an abandoned export holding Chromium for up
    // to ~45 s (Wave 6 E-H1).
    const pdf = await this.pool.renderPdf(html, { landscape: true, signal });
    const dataRows = this.dataRowCount(input);
    this.logger.log(
      `rendered project ${input.project.id} → pdf (${dataRows} data rows, ${pdf.byteLength} bytes, ${Date.now() - t0}ms)`,
    );
    return pdf;
  }

  /**
   * Wave 5 F1: get-or-launch the singleton browser (delegated to the shared
   * pool). Concurrent first callers share one launch; a crashed Chromium is
   * detected via `isConnected()` and relaunched; a launch failure surfaces as
   * a non-leaky 503 `pdf_unavailable`.
   *
   * Exposed for tests (not a real public API): the spec asserts subsequent
   * calls return the SAME `Browser` instance.
   */
  async getBrowser(): Promise<Browser> {
    return this.pool.getBrowser();
  }

  /**
   * Nest lifecycle hook — runs on `app.close()` and SIGINT/SIGTERM
   * (Nest installs a process listener when `enableShutdownHooks()` is
   * called). Closes the singleton browser cleanly so Chromium doesn't
   * stay alive after the API process exits.
   */
  async onModuleDestroy(): Promise<void> {
    const err = await this.pool.close();
    if (err) this.logger.warn(`Chromium close on shutdown failed: ${err}`);
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
    // Heebo @font-face (Hebrew + Latin, 400 + 700), base64-embedded. Delegated
    // to the shared loader (PR #317); the candidate-path diagnostic on failure
    // goes to the server log only — never to the response (redteam E-H3).
    return loadHeeboFontCss((msg) => this.logger.error(`pdf-export ${msg}`));
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
