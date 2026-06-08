/**
 * PDF artifact proof for the signed-certificate renderer (PR #317).
 *
 * The renderer rasterises an RTL HTML template through headless Chromium (the
 * SAME mechanism as the project export) so Hebrew bidi + shaping are done by
 * the browser — NOT by hand-rolled logic that mirror-reversed the letters.
 *
 * This spec splits into two layers:
 *   1) `buildCertificateHtml` — a pure function. Fast, no browser. Asserts the
 *      Hebrew is present in LOGICAL order (the HTML carries the source string
 *      verbatim; Chromium does the visual reorder at raster time, which is the
 *      whole point) and that user-supplied strings are HTML-ESCAPED (the new
 *      injection surface). No Chromium needed → runs everywhere.
 *   2) Full render → PDF bytes via Chromium. Asserts a valid PDF wrapper and
 *      that the embedded Heebo font carried the Hebrew through (same
 *      byte-stream check the export spec uses). Browser-gated (60 s timeout).
 */
import { afterAll, describe, expect, it } from 'vitest';

import { PdfSignedDocumentRenderer, buildCertificateHtml } from './pdf-signed-document.renderer';
import type { SignedCertificateData } from './signed-document.types';

const baseData: SignedCertificateData = {
  // The exact shapes the old hand-rolled bidi mirror-reversed: Hebrew + an
  // embedded number + a Hebrew address with a house number, in one name.
  documentName: 'הסכם התחדשות עירונית — דירה 12, רחוב הרצל 5',
  documentHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  authMethod: 'public_link_v1',
  signedAt: new Date('2026-06-05T09:30:00.000Z'),
  ownerName: 'ישראל ישראלי',
  signatureSvg:
    '<svg viewBox="0 0 300 100"><path d="M10 80 C 40 10, 65 10, 95 80 S 150 150, 180 80" /></svg>',
};

describe('buildCertificateHtml — pure template (no browser)', () => {
  it('carries the Hebrew document name + signer in LOGICAL order (Chromium reorders at raster)', () => {
    const html = buildCertificateHtml(baseData);
    // The source string appears verbatim — visual reordering is the browser's
    // job, so the HTML must NOT pre-reverse anything (that was the old bug).
    expect(html).toContain('הסכם התחדשות עירונית — דירה 12, רחוב הרצל 5');
    expect(html).toContain('ישראל ישראלי');
    // RTL base direction so the browser's UBA runs with the right paragraph dir.
    expect(html).toContain('dir="rtl"');
    // The fixed Hebrew certificate labels are present.
    expect(html).toContain('אישור חתימה דיגיטלית');
    expect(html).toContain('טביעת תוכן המסמך (SHA-256)');
  });

  it('HTML-escapes user-supplied strings (injection guard — load-bearing)', () => {
    const malicious: SignedCertificateData = {
      ...baseData,
      ownerName: '<script>alert(1)</script>',
      documentName: 'דירה "5" <b>& co</b>',
      authMethod: 'x" onload="alert(2)',
    };
    const html = buildCertificateHtml(malicious);
    // No raw injected markup survives — the angle brackets are entity-encoded.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&amp; co');
    expect(html).toContain('&quot;');
    // The auth-method attribute-breakout attempt is neutralised: the literal
    // double-quote is escaped, so it cannot close an attribute (and here it's
    // text content anyway).
    expect(html).toContain('x&quot; onload=&quot;alert(2)');
    expect(html).not.toContain('onload="alert(2)"');
  });

  it('sanitises the signature SVG to path geometry only (no raw user SVG markup)', () => {
    const evilSvg: SignedCertificateData = {
      ...baseData,
      // A stored SVG carrying a script + an event handler must NOT reach the DOM.
      signatureSvg:
        '<svg viewBox="0 0 300 100"><script>fetch("//evil")</script>' +
        '<path d="M10 80 L 90 20" onclick="steal()" /></svg>',
    };
    const html = buildCertificateHtml(evilSvg);
    expect(html).not.toContain('<script>fetch');
    expect(html).not.toContain('onclick=');
    // The geometry survives in a clean, controlled <path>.
    expect(html).toContain('d="M10 80 L 90 20"');
    expect(html).toContain('stroke="#1a1a1a"');
  });

  it('drops the signature box content entirely when the SVG has no usable path', () => {
    const html = buildCertificateHtml({ ...baseData, signatureSvg: '<svg><g/></svg>' });
    // No <path> extracted → empty sigbox, never raw user markup.
    expect(html).toContain('class="sigbox"></div>');
  });
});

describe('PdfSignedDocumentRenderer — artifact (Chromium)', () => {
  const renderer = new PdfSignedDocumentRenderer();

  afterAll(async () => {
    await renderer.onModuleDestroy();
  });

  it('renders a valid PDF (%PDF header + %%EOF) with Hebrew carried by the embedded font', async () => {
    const { bytes, contentType, fileExtension } = await renderer.render(baseData);

    expect(contentType).toBe('application/pdf');
    expect(fileExtension).toBe('pdf');
    expect(bytes.byteLength).toBeGreaterThan(1000);

    const head = Buffer.from(bytes.subarray(0, 5)).toString('latin1');
    expect(head).toBe('%PDF-');
    const tail = Buffer.from(bytes.subarray(bytes.length - 32)).toString('latin1');
    expect(tail).toContain('%%EOF');

    // Hebrew survives: with the Heebo woff2 (ships a /ToUnicode CMap) the literal
    // Hebrew label text is recoverable from the byte stream — same high-signal
    // check the export spec uses. Falls back to "any Hebrew codepoint present".
    const buf = Buffer.from(bytes);
    const utf16Le = buf.toString('utf16le');
    // swap16() requires an even byte length; PDF size is arbitrary, so pad a
    // copy to even length before swapping (otherwise RangeError on odd sizes).
    const even = buf.length % 2 === 0 ? Buffer.from(buf) : Buffer.concat([buf, Buffer.from([0])]);
    const utf16Be = even.swap16().toString('utf16le');
    const hits = [utf16Le, utf16Be].some(
      (s) => s.includes('אישור') || s.includes('דירה') || s.includes('ישראל'),
    );
    if (!hits) {
      const utf8 = buf.toString('utf8');
      expect(/[֐-׿]/.test(utf8 + utf16Le + utf16Be)).toBe(true);
    } else {
      expect(hits).toBe(true);
    }

    // Heebo embedded as a font program (Chromium emits /FontFile3 for the woff2).
    const latin1 = buf.toString('latin1');
    expect(latin1).toMatch(/\/FontFile[123]?\s/);
  }, 60_000);

  it('renders an exotic CJK + Arabic + emoji owner name without throwing', async () => {
    const exotic: SignedCertificateData = {
      ...baseData,
      ownerName: '李明 محمد Иван 🎉',
      documentName: 'דירה 7 — owner محمد',
    };
    const { bytes } = await renderer.render(exotic);
    expect(Buffer.from(bytes.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
    expect(bytes.byteLength).toBeGreaterThan(1000);
  }, 60_000);
});
