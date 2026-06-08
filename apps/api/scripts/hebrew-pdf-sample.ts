/**
 * Throwaway eyeball script — renders a signed-certificate PDF with realistic
 * Hebrew (mixed Hebrew + digits + dates) so an owner can open the file and
 * confirm the bidi fix reads correctly. Writes to the gitignored `tmp/`.
 *
 *   pnpm --filter @emapp/api exec tsx scripts/hebrew-pdf-sample.ts
 *
 * NOT wired into the build/tests. The sample data is fictional — no real PII.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { PdfSignedDocumentRenderer } from '../src/modules/signatures/pdf-signed-document.renderer';
import type { SignedCertificateData } from '../src/modules/signatures/signed-document.types';

async function main(): Promise<void> {
  const data: SignedCertificateData = {
    // Mixed Hebrew + an embedded number + a date inside one Hebrew sentence,
    // plus a Hebrew address with a house number — the exact shapes that the
    // old hand-rolled bidi garbled.
    documentName: 'הסכם התחדשות עירונית — דירה 12, רחוב הרצל 5, תל אביב',
    documentHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    authMethod: 'public_link_v1',
    signedAt: new Date('2026-06-05T09:30:00.000Z'),
    ownerName: 'ישראל ישראלי',
    signatureSvg:
      '<svg viewBox="0 0 300 100"><path d="M10 80 C 40 10, 65 10, 95 80 S 150 150, 180 80" /></svg>',
  };

  const renderer = new PdfSignedDocumentRenderer();
  try {
    const { bytes } = await renderer.render(data);

    const out = resolve(__dirname, '../../../tmp/hebrew-pdf-sample.pdf');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, bytes);
    // eslint-disable-next-line no-console -- one-off script, not app code.
    console.log(`Wrote ${bytes.length} bytes → ${out}`);
  } finally {
    // The renderer holds a singleton Chromium open; close it so the script exits.
    await renderer.onModuleDestroy();
  }
}

void main();
