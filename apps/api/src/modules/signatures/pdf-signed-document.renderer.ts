import { Injectable } from '@nestjs/common';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import { HEEBO_HEBREW_400_WOFF_B64 } from './heebo-font';
import type {
  ISignedDocumentRenderer,
  RenderedArtifact,
  SignedCertificateData,
} from './signed-document.types';

/**
 * Built-in renderer: a self-contained "אישור חתימה דיגיטלית" certificate PDF
 * (pdf-lib). One implementation of ISignedDocumentRenderer — swappable for an
 * external e-sign integration without touching SignedDocumentService.
 *
 * KNOWN ISSUE (tracked, see docs/AUTONOMOUS-PROGRESS.md B-A1): the Hebrew
 * layout uses a hand-rolled single-level bidi (manual reversal + per-run x).
 * It is correct for simple labels but reportedly renders messy in some viewers.
 * Because this is now isolated behind the interface, the fix (proper UBA via
 * bidi-js, or rasterise-Hebrew-to-image) is a single-class change here.
 */
@Injectable()
export class PdfSignedDocumentRenderer implements ISignedDocumentRenderer {
  async render(data: SignedCertificateData): Promise<RenderedArtifact> {
    const bytes = await buildSignatureCertificatePdf(data);
    return { bytes, contentType: 'application/pdf', fileExtension: 'pdf' };
  }
}

// ── pdf-lib certificate composition ──────────────────────────────────────────
// pdf-lib has no native bidi AND the embedded Heebo woff is a HEBREW SUBSET
// (no Latin glyphs / digits). So we split each string into runs by script and
// render each run with the right font (Heebo for Hebrew, Helvetica for
// ASCII/digits/punct), laying runs out right-to-left.
function isHebrew(ch: string): boolean {
  return /[֐-׿]/.test(ch);
}
function splitRuns(s: string): { text: string; heb: boolean }[] {
  const runs: { text: string; heb: boolean }[] = [];
  for (const ch of s) {
    const heb = isHebrew(ch);
    const last = runs[runs.length - 1];
    if (last && last.heb === heb) last.text += ch;
    else runs.push({ text: ch, heb });
  }
  return runs;
}

async function buildSignatureCertificatePdf(d: SignedCertificateData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const heebo = await pdf.embedFont(Buffer.from(HEEBO_HEBREW_400_WOFF_B64, 'base64'));
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const page = pdf.addPage([595.28, 841.89]); // A4 portrait (pt)
  const { width, height } = page.getSize();
  const right = width - 50; // RTL right margin
  const left = 50;
  const navy = rgb(0.11, 0.16, 0.28);
  const gray = rgb(0.4, 0.4, 0.4);
  let y = height - 70;

  // Helvetica (a StandardFont, WinAnsi) THROWS on any codepoint it can't encode,
  // and the embedded Heebo is a Hebrew subset. Owner/document names are
  // user-supplied (Arabic, Cyrillic, CJK, emoji are realistic). Sanitize per
  // run so a non-encodable name degrades to '?' instead of crashing the cert.
  const encodeSafe = (font: typeof helv | typeof heebo, s: string): string => {
    try {
      font.widthOfTextAtSize(s, 1);
      return s;
    } catch {
      return [...s]
        .map((ch) => {
          try {
            font.widthOfTextAtSize(ch, 1);
            return ch;
          } catch {
            return '?';
          }
        })
        .join('');
    }
  };
  // Draw Hebrew/mixed text right-aligned, run-by-run with per-script font.
  const drawRtlMixed = (text: string, size: number, color = navy): void => {
    let x = right;
    for (const run of splitRuns(text)) {
      const font = run.heb ? heebo : helv;
      const raw = run.heb ? [...run.text].reverse().join('') : run.text;
      const glyphs = encodeSafe(font, raw);
      const w = font.widthOfTextAtSize(glyphs, size);
      x -= w;
      page.drawText(glyphs, { x, y, size, font, color });
    }
  };
  // LTR value, left-aligned (hashes/timestamps — pure ASCII).
  const ltrLeft = (text: string, size: number, font = helv, color = navy): void => {
    page.drawText(text, { x: left, y, size, font, color });
  };

  drawRtlMixed('אישור חתימה דיגיטלית', 22, navy);
  y -= 16;
  drawRtlMixed('EMAPP — התחדשות עירונית', 11, gray);
  y -= 34;
  page.drawLine({
    start: { x: left, y },
    end: { x: right, y },
    thickness: 1,
    color: rgb(0.85, 0.85, 0.85),
  });
  y -= 30;

  const row = (labelHe: string, value: string, valueFont = helv): void => {
    drawRtlMixed(labelHe, 11, gray);
    y -= 16;
    ltrLeft(value, 12, valueFont, navy);
    y -= 26;
  };
  const rowHe = (labelHe: string, valueHe: string): void => {
    drawRtlMixed(labelHe, 11, gray);
    y -= 16;
    drawRtlMixed(valueHe, 13, navy);
    y -= 26;
  };

  rowHe('המסמך שנחתם', d.documentName);
  row('טביעת תוכן המסמך (SHA-256)', d.documentHash, helv);
  rowHe('חתם/ה', d.ownerName);
  row('נחתם בתאריך (Asia/Jerusalem)', formatJerusalem(d.signedAt), helvBold);
  row('אופן האימות', d.authMethod, helv);

  // Signature box.
  y -= 6;
  drawRtlMixed('החתימה', 11, gray);
  y -= 96;
  const boxW = width - 100;
  const boxH = 90;
  page.drawRectangle({
    x: left,
    y,
    width: boxW,
    height: boxH,
    borderColor: rgb(0.8, 0.8, 0.8),
    borderWidth: 1,
    color: rgb(0.99, 0.99, 0.99),
  });
  drawSignature(page, d.signatureSvg, left + 12, y + boxH - 10, boxW - 24, boxH - 20);
  y -= 28;

  drawRtlMixed('מסמך זה מאשר כי החתימה לעיל נקלטה דרך קישור החתימה הציבורי של EMAPP', 9, gray);
  y -= 13;
  drawRtlMixed('וכי טביעת התוכן לעיל מזהה באופן ייחודי את המסמך שנחתם.', 9, gray);

  return pdf.save();
}

function formatJerusalem(date: Date): string {
  // ASCII, unambiguous: DD/MM/YYYY HH:mm.
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

type PdfPage = ReturnType<PDFDocument['addPage']>;

/** Extract path `d` data from the stored SVG and draw it, scaled to fit. */
function drawSignature(
  page: PdfPage,
  svg: string,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  if (!svg) return;
  try {
    const vb = /viewBox\s*=\s*["']\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*["']/i.exec(svg);
    const vbW = vb ? Number(vb[3]) : 300;
    const vbH = vb ? Number(vb[4]) : 100;
    const scale = Math.min(w / (vbW || 1), h / (vbH || 1));
    const paths = [...svg.matchAll(/<path[^>]*\sd\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!);
    for (const dAttr of paths) {
      page.drawSvgPath(dAttr, { x, y, scale, borderColor: rgb(0.1, 0.1, 0.1), borderWidth: 1.5 });
    }
  } catch {
    // A malformed signature path must not break the certificate.
  }
}
