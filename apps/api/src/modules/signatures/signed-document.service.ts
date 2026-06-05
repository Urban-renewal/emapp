import { serverEnv } from '@emapp/config';
import {
  decryptField,
  decryptOwnerName,
  documents,
  owners,
  signatures,
  withTenant,
} from '@emapp/db';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import fontkit from '@pdf-lib/fontkit';
import { eq } from 'drizzle-orm';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

import type { AccessTokenPayload } from '../auth/auth.service';

import { HEEBO_HEBREW_400_WOFF_B64 } from './heebo-font';
import { SignatureRequestsService } from './signature-requests.service';

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });

/**
 * Produces the downloadable SIGNED ARTIFACT for a completed signature.
 *
 * Until now signing was write-only: the resident's SVG was stored
 * (encrypted) but never composed into anything a manager could open. This
 * service generates, on demand, a self-contained "אישור חתימה דיגיטלית"
 * (digital signature certificate) PDF that:
 *   - names the signed document + its content hash (what was signed),
 *   - names the signer + signed-at (Asia/Jerusalem) + auth method,
 *   - renders the captured signature itself (vector, via drawSvgPath).
 *
 * Gated on `owners.reveal_pii` (the artifact carries decrypted owner PII —
 * the signer name + their signature), AND record-scoped via the SR read
 * path (agent assigned-project visibility). Signer IP is deliberately NOT
 * rendered (it is not on any read surface — D.50 projection rule).
 *
 * The hash binds the certificate to the exact bytes that were signed, so
 * the artifact is verifiable even though the original document is stored
 * separately. Generated per-request (no extra storage); RLS-scoped read.
 */
@Injectable()
export class SignedDocumentService {
  private readonly logger = new Logger(SignedDocumentService.name);

  constructor(private readonly signatureRequests: SignatureRequestsService) {}

  async generate(
    user: AccessTokenPayload,
    signatureRequestId: string,
  ): Promise<{ pdf: Uint8Array; fileName: string }> {
    const encKey = serverEnv.PII_ENCRYPTION_KEY;
    if (!encKey || encKey.length < 32) {
      this.logger.error('PII_ENCRYPTION_KEY not configured — cannot render signed document');
      throw NOT_FOUND;
    }

    // Authorization + record-scope visibility: reuse the SR read path. get()
    // enforces existence + RLS (org) + the AGENT assigned-project visibility
    // check (assertDocVisibleForAgent) — so an agent of project X cannot pull
    // project Y's certificate. The controller already gates on
    // owners.reveal_pii (PII content). Anything not visible / not found → 404.
    const sr = await this.signatureRequests.get(user, signatureRequestId);
    // Only a SIGNED request has an artifact. Otherwise → 404 (no oracle).
    if (sr.status !== 'signed' || !sr.signedSignatureId) throw NOT_FOUND;
    const signatureId = sr.signedSignatureId;

    const data = await withTenant(
      user.orgId,
      async (tx) => {
        const [sig] = await tx
          .select({
            blob: signatures.signatureBlob,
            documentHash: signatures.documentHash,
            authMethod: signatures.authMethod,
            signedAt: signatures.signedAt,
          })
          .from(signatures)
          .where(eq(signatures.id, signatureId))
          .limit(1);
        if (!sig) throw NOT_FOUND;

        const [doc] = await tx
          .select({ name: documents.name })
          .from(documents)
          .where(eq(documents.id, sr.documentId))
          .limit(1);
        const [own] = await tx
          .select({ nameEncrypted: owners.nameEncrypted })
          .from(owners)
          .where(eq(owners.id, sr.ownerId))
          .limit(1);
        if (!own) throw NOT_FOUND;

        // FAIL HARD on decrypt failure (D.51 — no plaster): a certificate
        // that cannot render the actual signature / signer is NOT a valid
        // attestation. An unreadable blob means a real key/crypto fault, so
        // we surface it (→ generic 500) rather than emit a placeholder cert.
        const svg = await decryptField(tx, sig.blob, encKey);
        const ownerName = await decryptOwnerName(tx, own.nameEncrypted);

        return {
          documentName: doc?.name ?? '—',
          documentHash: sig.documentHash,
          authMethod: sig.authMethod,
          signedAt: sig.signedAt,
          ownerName,
          svg,
        };
      },
      { userId: user.sub },
    );

    const pdf = await buildSignatureCertificatePdf(data);
    // D.50 hygiene — release decrypted PII references once rendered.
    data.svg = '';
    data.ownerName = '';
    return { pdf, fileName: `signed-${signatureRequestId}.pdf` };
  }
}

// pdf-lib has no native bidi AND the embedded Heebo woff is a HEBREW SUBSET
// (no Latin glyphs / digits). So we split each string into runs by script and
// render each run with the right font (Heebo for Hebrew, Helvetica for
// ASCII/digits/punct), laying runs out right-to-left. Hebrew runs are
// reversed so they read RTL when drawn LTR; ASCII runs (numbers, "EMAPP",
// hashes) keep their order. This fixes mixed strings like "הרצל 10 — דירה 1".
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

interface CertData {
  documentName: string;
  documentHash: string;
  authMethod: string;
  signedAt: Date;
  ownerName: string;
  svg: string;
}

async function buildSignatureCertificatePdf(d: CertData): Promise<Uint8Array> {
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

  // Draw Hebrew/mixed text right-aligned at the right margin, run-by-run
  // with per-script font fallback (Heebo=Hebrew, Helvetica=ASCII/digits).
  // This is SINGLE-LEVEL bidi (Hebrew runs reversed, LTR runs kept, laid
  // out right→left) — sufficient for names + labels + embedded numbers in
  // this certificate; NOT a full Unicode Bidi Algorithm (no nested levels).
  const drawRtlMixed = (text: string, size: number, color = navy): void => {
    let x = right;
    for (const run of splitRuns(text)) {
      const font = run.heb ? heebo : helv;
      const glyphs = run.heb ? [...run.text].reverse().join('') : run.text;
      const w = font.widthOfTextAtSize(glyphs, size);
      x -= w;
      page.drawText(glyphs, { x, y, size, font, color });
    }
  };
  // LTR value, left-aligned (hashes/timestamps/IDs — pure ASCII).
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

  // A labelled row: Hebrew label on the right, ASCII value below on the left.
  const row = (labelHe: string, value: string, valueFont = helv): void => {
    drawRtlMixed(labelHe, 11, gray);
    y -= 16;
    ltrLeft(value, 12, valueFont, navy);
    y -= 26;
  };
  // A labelled row whose value is Hebrew/mixed (right-aligned).
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
  const boxX = left;
  const boxW = width - 100;
  const boxH = 90;
  page.drawRectangle({
    x: boxX,
    y,
    width: boxW,
    height: boxH,
    borderColor: rgb(0.8, 0.8, 0.8),
    borderWidth: 1,
    color: rgb(0.99, 0.99, 0.99),
  });
  drawSignature(page, d.svg, boxX + 12, y + boxH - 10, boxW - 24, boxH - 20);
  y -= 28;

  // Footer attestation.
  drawRtlMixed('מסמך זה מאשר כי החתימה לעיל נקלטה דרך קישור החתימה הציבורי של EMAPP', 9, gray);
  y -= 13;
  drawRtlMixed('וכי טביעת התוכן לעיל מזהה באופן ייחודי את המסמך שנחתם.', 9, gray);

  return pdf.save();
}

function formatJerusalem(date: Date): string {
  // ASCII, unambiguous: DD/MM/YYYY HH:mm.
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return f.format(date);
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
      page.drawSvgPath(dAttr, {
        x,
        y,
        scale,
        borderColor: rgb(0.1, 0.1, 0.1),
        borderWidth: 1.5,
      });
    }
  } catch {
    // A malformed signature path must not break the certificate.
  }
}
