/**
 * V11 B.S10 visual smoke — render the EXACT same HTML the PdfExportService
 * rasterises, and screenshot it for the agent + partner to visually
 * confirm the output of the live `/api/v1/projects/:id/export` endpoint.
 *
 * Closes the "structural-only smoke" gap recorded in
 * memory/feedback_visual_smoke_gap.md.
 *
 * Usage:  ORG_ID=… USER_ID=… PROJECT_ID=… pnpm tsx scripts/b10-visual.ts
 */
/* eslint-disable no-console */
import { writeFileSync } from 'node:fs';

import { chromium } from 'playwright-core';

import { ExportComposerService } from '../apps/api/src/modules/export/export-composer.service';
import { PdfExportService } from '../apps/api/src/modules/export/pdf-export.service';

const ORG = process.env['ORG_ID']!;
const USER = process.env['USER_ID']!;
const PROJECT = process.env['PROJECT_ID']!;

async function main(): Promise<void> {
  const composer = new ExportComposerService();
  const pdf = new PdfExportService();

  // Compose the input using the SAME path the HTTP endpoint uses
  // (withTenant + RLS + decrypt). This gives a true end-to-end
  // visual smoke: anything the endpoint sees, this sees too.
  const { input, rowCount } = await composer.composeProjectExport(
    {
      sub: USER,
      orgId: ORG,
      role: 'manager',
      sid: '00000000-0000-0000-0000-000000000000',
      type: 'access',
      iat: 0,
      exp: 0,
    } as unknown as Parameters<typeof composer.composeProjectExport>[0],
    PROJECT,
    'pdf',
  );

  const html = pdf.renderProjectHtml(input);
  // Also write the HTML itself for the agent to grep.
  writeFileSync('C:/Users/matanya/AppData/Local/Temp/b10-render.html', html);

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(
      () =>
        (globalThis as unknown as { document: { fonts: { ready: Promise<void> } } }).document.fonts
          .ready,
    );
    await page.screenshot({
      path: 'C:/Users/matanya/AppData/Local/Temp/b10-pdf-visual.png',
      fullPage: false,
    });
  } finally {
    await browser.close();
  }

  console.log(
    JSON.stringify({
      rowCount,
      htmlBytes: html.length,
      png: 'C:/Users/matanya/AppData/Local/Temp/b10-pdf-visual.png',
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
