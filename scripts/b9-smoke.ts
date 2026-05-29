/**
 * V11 B.S9 smoke runner — Project → PDF export.
 *
 * Produces a real .pdf file on disk PLUS a screenshot PNG of the
 * rendered first page so the partner — and the agent itself — can
 * visually confirm:
 *   - RTL layout (columns A→O reading right-to-left)
 *   - Hebrew text rendered with the embedded Heebo font
 *   - Header row + project metadata visible
 *   - Status / unit_type Hebrew labels applied
 *
 * Usage:  pnpm tsx scripts/b9-smoke.ts <out-prefix>
 *   produces <prefix>.pdf and <prefix>.png
 */
/* eslint-disable no-console */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { chromium } from 'playwright-core';

import type { ProjectExportInput } from '../apps/api/src/modules/export/export.service';
import {
  PdfExportService,
  // re-export type via the same module
} from '../apps/api/src/modules/export/pdf-export.service';

const outPrefix = resolve(process.argv[2] ?? './b9-smoke');
const svc = new PdfExportService();

const input: ProjectExportInput = {
  project: {
    id: 'demo-proj',
    name: 'דיזנגוף 100 — תמ"א 38',
    type: 'tama38_1',
    status: 'gathering_signatures',
  },
  generatedAt: new Date('2026-05-27T12:00:00Z'),
  generatedBy: { name: 'B.S9 Manager', email: 'mgr@example.com' },
  buildings: [
    {
      id: 'b1',
      address: 'דיזנגוף 100',
      city: 'תל אביב',
      block: '7104',
      parcel: '42',
      apartments: [
        {
          id: 'a1',
          number: '1',
          floor: 1,
          sizeSqm: 85,
          rooms: 3.5,
          status: 'signed',
          unitType: 'apt',
          areaSqm: null,
          entrance: 'א',
          owners: [
            {
              name: 'דוד כהן',
              nationalId: '000000018',
              phone: '0501234567',
              email: 'david@example.com',
              ownershipPct: 50,
            },
            {
              name: 'שרה כהן',
              nationalId: '000000026',
              phone: '0507654321',
              email: 'sara@example.com',
              ownershipPct: 50,
            },
          ],
        },
        {
          id: 'a2',
          number: '2',
          floor: 1,
          sizeSqm: 95,
          rooms: 4,
          status: 'pending',
          unitType: 'shop',
          areaSqm: null,
          entrance: 'א',
          owners: [
            {
              name: 'משה לוי',
              nationalId: '000000034',
              phone: '0501112233',
              email: 'moshe@example.com',
              ownershipPct: 100,
            },
          ],
        },
        {
          id: 'a3',
          number: '3',
          floor: 2,
          sizeSqm: 110,
          rooms: 4.5,
          status: 'declined',
          unitType: 'apt',
          areaSqm: null,
          entrance: 'א',
          owners: [],
        },
      ],
    },
  ],
};

(async () => {
  const t0 = Date.now();
  const pdfBuf = await svc.renderProjectPdf(input);
  const pdfPath = `${outPrefix}.pdf`;
  writeFileSync(pdfPath, pdfBuf);

  // Visual smoke: open the HTML through Chromium AGAIN and screenshot
  // the first page so we can SEE the render (closes the "structural
  // checks pass but font may not actually render" gap from B.S8 in
  // memory/feedback_visual_smoke_gap.md).
  const browser = await chromium.launch({ headless: true });
  try {
    const html = svc.renderProjectHtml(input);
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 850 } });
    const page = await ctx.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const pngPath = `${outPrefix}.png`;
    await page.screenshot({ path: pngPath, fullPage: false });
    console.log(
      JSON.stringify({
        pdf: { path: pdfPath, bytes: pdfBuf.byteLength, magic: pdfBuf.subarray(0, 4).toString() },
        png: { path: pngPath },
        elapsedMs: Date.now() - t0,
      }),
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
