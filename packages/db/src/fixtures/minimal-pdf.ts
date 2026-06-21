/**
 * MINIMAL_PDF — a genuinely RENDERABLE one-page PDF fixture for dev/seed.
 *
 * Why this exists
 * ---------------
 * Dev seed scripts (seed-dev / seed-demo) historically created document
 * METADATA only — the file bytes were never written to storage. Opening a
 * seeded document therefore 404'd (R2 had no object), and an ad-hoc QA flow
 * that DID write a stub wrote 21 bytes of plain text ("sig doc <ms>") served
 * as application/pdf — which no PDF viewer will render. The owner bar is:
 * document preview MUST work locally.
 *
 * A header-only stub like `%PDF-1.4\n%%EOF` is NOT enough — browsers' PDF
 * viewers (pdf.js / Chrome) need a complete object graph: catalog → pages →
 * a page object with a MediaBox → a content stream → an xref table whose
 * byte offsets are correct → a trailer pointing at the catalog → %%EOF.
 *
 * This module builds exactly that, with the xref offsets computed against the
 * accumulating byte length so the table is valid. The output opens in any
 * conformant PDF viewer (verified by a real parser in the unit test). It is a
 * pure Buffer with NO AWS-SDK / storage dependency, so it is safe to import
 * from @emapp/db src, the seed scripts, and the backfill script alike.
 *
 * All bytes are latin1 (single-byte) so the byte offsets in the xref table
 * equal the string character offsets we accumulate.
 */

/**
 * Build a minimal, structurally-valid, single-page PDF that renders the given
 * caption text. The caption is sanitised for the PDF literal-string syntax
 * (escape `\`, `(`, `)`) and truncated, and any non-ASCII (e.g. Hebrew doc
 * names) is dropped because the built-in Helvetica font used here is
 * WinAnsi-only — the goal is a viewer-renderable page, not faithful Hebrew.
 *
 * @param caption optional text drawn on the page (e.g. the document name).
 */
export function buildMinimalPdf(caption = 'EMAPP dev document'): Buffer {
  const safe = caption
    // drop non-ASCII (Helvetica/WinAnsi can't draw Hebrew glyphs anyway)
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[\\()]/g, (c) => `\\${c}`)
    .slice(0, 80)
    .trim();
  const label = safe.length > 0 ? safe : 'EMAPP dev document';

  const stream = `BT /F1 18 Tf 60 780 Td (${label}) Tj ET`;
  const bodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
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

/**
 * A ready-made, structurally-valid one-page PDF. Reuse this constant for the
 * default dev fixture; call {@link buildMinimalPdf} when you want the document
 * name printed on the page.
 */
export const MINIMAL_PDF: Buffer = buildMinimalPdf();
