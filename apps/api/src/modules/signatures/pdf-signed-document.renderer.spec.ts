/**
 * PDF artifact proof for the signed-certificate renderer (no DB / no R2 — the
 * renderer takes a plain SignedCertificateData and returns bytes).
 *
 * Asserts the rendered bytes are a real PDF AND that the Heebo subset is
 * EMBEDDED as a Type0/CIDFont (FontFile2). The font dict lives inside the PDF's
 * FlateDecode object streams, so the markers only appear AFTER inflating those
 * streams — this test inflates them and asserts the embedded-font markers.
 *
 * Also exercises encodeSafe robustness end-to-end: an exotic CJK+emoji owner
 * name must render (degrading to '?' for non-encodable glyphs) WITHOUT throwing.
 */
import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { PdfSignedDocumentRenderer } from './pdf-signed-document.renderer';
import type { SignedCertificateData } from './signed-document.types';

/** Inflate every FlateDecode stream in a PDF and concatenate the latin1 text,
 *  so we can search font/structure markers that pdf-lib compresses away. */
function inflatedStreamText(bytes: Uint8Array): string {
  const s = Buffer.from(bytes).toString('latin1');
  const streamRe = /stream(?:\r\n|\n|\r)([\s\S]*?)endstream/g;
  let out = '';
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(s)) !== null) {
    const raw = Buffer.from(m[1]!, 'latin1');
    try {
      out += inflateSync(raw).toString('latin1');
    } catch {
      // Not a flate stream (e.g. raw content) — ignore; we only need the
      // compressed object streams that carry the font dictionaries.
    }
  }
  return out;
}

const baseData: SignedCertificateData = {
  // The exact shapes the old hand-rolled bidi garbled: Hebrew + an embedded
  // number + a Hebrew address with a house number, in one document name.
  documentName: 'הסכם התחדשות עירונית — דירה 12, רחוב הרצל 5',
  documentHash: 'a3f1c0de9b8a7766554433221100ffeeddccbbaa00112233445566778899aabb',
  authMethod: 'public_link_v1',
  signedAt: new Date('2026-06-05T09:30:00.000Z'),
  ownerName: 'ישראל ישראלי',
  signatureSvg:
    '<svg viewBox="0 0 300 100"><path d="M10 80 C 40 10, 65 10, 95 80 S 150 150, 180 80" /></svg>',
};

describe('PdfSignedDocumentRenderer — artifact', () => {
  it('renders a valid PDF with the Heebo subset embedded (Type0/CIDFont/FontFile2)', async () => {
    const { bytes, contentType, fileExtension } = await new PdfSignedDocumentRenderer().render(
      baseData,
    );

    expect(contentType).toBe('application/pdf');
    expect(fileExtension).toBe('pdf');
    expect(bytes.byteLength).toBeGreaterThan(1000);

    // Valid PDF header + EOF marker.
    const head = Buffer.from(bytes.subarray(0, 5)).toString('latin1');
    expect(head).toBe('%PDF-');
    const tail = Buffer.from(bytes.subarray(bytes.length - 64)).toString('latin1');
    expect(tail).toContain('%%EOF');

    // Embedded-font proof: these markers are NOT visible in the raw bytes
    // (they're inside FlateDecode object streams) — only after inflation.
    const inflated = inflatedStreamText(bytes);
    expect(inflated).toContain('Type0'); // composite font (required for Hebrew)
    expect(inflated).toContain('CIDFont'); // CID-keyed descendant font
    expect(inflated).toContain('FontFile'); // embedded font program (FontFile2)
    expect(inflated).toContain('Identity-H'); // CID encoding for the subset
  });

  it('keeps the font dictionary compressed (markers absent until streams inflate)', async () => {
    // Guards the previous test: proves the font markers genuinely require
    // inflation, so finding them above demonstrates real EMBEDDING (a compressed
    // CIDFont dict) rather than an incidental uncompressed string match.
    const { bytes } = await new PdfSignedDocumentRenderer().render(baseData);
    const raw = Buffer.from(bytes).toString('latin1');

    // pdf-lib writes the font dict + program inside FlateDecode object streams,
    // so these appear only after inflation — never in the raw bytes.
    expect(raw).not.toContain('FontFile2');
    expect(raw).not.toContain('CIDFontType2');

    // But after inflating, they ARE present — closing the loop.
    const inflated = inflatedStreamText(bytes);
    expect(inflated).toContain('FontFile2');
  });

  it('renders an exotic CJK+emoji owner name without throwing (encodeSafe degrade)', async () => {
    const exotic: SignedCertificateData = { ...baseData, ownerName: '李明 🎉' };
    let bytes: Uint8Array | undefined;
    await expect(
      (async () => {
        bytes = (await new PdfSignedDocumentRenderer().render(exotic)).bytes;
      })(),
    ).resolves.not.toThrow();
    expect(bytes).toBeDefined();
    expect(Buffer.from(bytes!.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
  });

  it('renders a name with Arabic + Cyrillic + emoji without throwing', async () => {
    const exotic: SignedCertificateData = {
      ...baseData,
      ownerName: 'محمد Иван 🚀',
      documentName: 'דירה 7 — owner محمد',
    };
    const { bytes } = await new PdfSignedDocumentRenderer().render(exotic);
    expect(Buffer.from(bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });
});
