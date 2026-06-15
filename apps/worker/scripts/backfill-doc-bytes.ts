/**
 * Backfill placeholder PDF bytes for documents whose R2 object is missing.
 *
 * The dev seed (packages/db/scripts/seed-dev.ts) created document METADATA only
 * — the file bytes were never uploaded to R2, so every seeded document 404s on
 * open ("documents don't open for reading"). This uploads a small RENDERABLE
 * placeholder PDF (one page, the doc name as text) to each non-sensitive
 * document's r2Key so View/Download work in dev. putObject is idempotent
 * (deterministic bytes), so re-running is safe. Sensitive (encrypted) docs are
 * SKIPPED — their bytes are an EMAPPENC envelope, not a raw PDF.
 *
 * Run (needs R2_* + DATABASE_URL via Infisical), from the worker package:
 *   infisical run --env=dev -- pnpm --filter @emapp/worker exec tsx scripts/backfill-doc-bytes.ts
 */
/* eslint-disable no-console -- operational backfill script */
import { db, documents } from '@emapp/db';
import { and, eq, isNull } from 'drizzle-orm';

import { storageProviderFactory } from '../src/storage-provider';

/** Minimal single-page PDF (renderable) with `text` on it; xref offsets are
 *  computed against the accumulating byte length so the table is valid. */
function minimalPdf(text: string): Buffer {
  const safe = text.replace(/[\\()]/g, (c) => `\\${c}`).slice(0, 80);
  const stream = `BT /F1 18 Tf 60 780 Td (${safe}) Tj ET`;
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

async function main(): Promise<void> {
  const storage = storageProviderFactory();
  const rows = await db
    .select({ id: documents.id, name: documents.name, r2Key: documents.r2Key })
    .from(documents)
    .where(and(eq(documents.sensitive, false), isNull(documents.archivedAt)));

  console.log(`Uploading placeholder PDFs for ${rows.length} non-sensitive documents…`);
  const BATCH = 25;
  let n = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    await Promise.all(
      slice.map((d) =>
        storage.putObject(d.r2Key, minimalPdf(d.name), { contentType: 'application/pdf' }),
      ),
    );
    n += slice.length;
    if (n % 200 === 0 || n === rows.length) console.log(`  …${n}/${rows.length}`);
  }
  console.log(`Done: uploaded ${n} placeholder PDFs to R2.`);
  process.exit(0);
}

void main().catch((e) => {
  console.error('backfill failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
