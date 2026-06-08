import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';

import {
  ChromiumBrowserPool,
  escapeHtml,
  loadHeeboFontCss,
} from '../../common/pdf/chromium-html-pdf';

import type {
  ISignedDocumentRenderer,
  RenderedArtifact,
  SignedCertificateData,
} from './signed-document.types';

/**
 * Built-in renderer: a self-contained "אישור חתימה דיגיטלית" certificate PDF.
 * One implementation of ISignedDocumentRenderer — swappable for an external
 * e-sign integration without touching SignedDocumentService.
 *
 * Rendering (PR #317): an RTL HTML template (`dir="rtl"`, the base64-embedded
 * Heebo web font) rasterised through headless Chromium — the SAME mechanism the
 * project export uses. Chromium performs the Unicode Bidi Algorithm + Hebrew
 * shaping natively, so mixed content ("דירה 12", "רחוב הרצל 5", dates) reads
 * correctly with ZERO hand-rolled bidi.
 *
 * Why this replaced the pdf-lib + bidi-js path: pdf-lib has no native bidi. The
 * hand-rolled logical→visual reordering produced MIRROR-REVERSED Hebrew (the
 * letters came out backwards in real viewers) — the owner caught it. The
 * browser is the proven-correct reference (the export already renders Hebrew
 * correctly this way); reusing it eliminates the entire class of bug.
 *
 * Security posture (NEW injection surface vs. pdf-lib): every user-supplied
 * string (owner name, document name, auth method) is HTML-escaped before
 * interpolation. The signature SVG is NOT embedded as raw markup — we extract
 * only the `<path d="…">` geometry and rebuild a clean, attribute-escaped SVG,
 * so a malicious stored SVG cannot inject `<script>` / event handlers into the
 * render context. No PII is logged.
 */
@Injectable()
export class PdfSignedDocumentRenderer implements ISignedDocumentRenderer, OnModuleDestroy {
  private readonly logger = new Logger(PdfSignedDocumentRenderer.name);

  // Process-singleton Chromium (lazy-launched on first render). The
  // certificate is small + low-volume, but reusing the pool keeps the launch
  // cost amortised and the lifecycle managed.
  private readonly pool = new ChromiumBrowserPool({ headless: true }, (msg) =>
    this.logger.error(`Chromium launch failed: ${msg}`),
  );

  async render(data: SignedCertificateData): Promise<RenderedArtifact> {
    const html = buildCertificateHtml(data, (msg) => this.logger.error(msg));
    const bytes = await this.pool.renderPdf(html, { format: 'A4', landscape: false });
    return { bytes, contentType: 'application/pdf', fileExtension: 'pdf' };
  }

  async onModuleDestroy(): Promise<void> {
    const err = await this.pool.close();
    if (err) this.logger.warn(`Chromium close on shutdown failed: ${err}`);
  }
}

// ── HTML certificate composition ─────────────────────────────────────────────

/**
 * Build the certificate HTML. Pure function of the input (+ the lazily-cached
 * Heebo CSS). Exported for the smoke/eyeball script and tests so they can
 * render the exact HTML Chromium rasterises.
 */
/** DoS bound (security-review HIGH): user-controlled fields are capped before they
 *  enter the Chromium-rendered HTML so a pathologically large stored name/SVG cannot
 *  pin a browser context. The values are the owner's own decrypted record (authz-gated);
 *  these caps are generous defense-in-depth. */
const MAX_TEXT_FIELD = 512;
const MAX_SIGNATURE_SVG = 200_000;

export function buildCertificateHtml(
  d: SignedCertificateData,
  onFontError?: (message: string) => void,
): string {
  const fontCss = loadHeeboFontCss(onFontError);
  const signedAt = formatJerusalem(d.signedAt);
  const signatureSvg = sanitizeSignatureSvg(d.signatureSvg.slice(0, MAX_SIGNATURE_SVG));

  // Every dynamic value below is HTML-escaped (injection guard — load-bearing).
  // The document hash is ASCII-hex but escaped anyway for uniformity.
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8" />
<title>אישור חתימה דיגיטלית</title>
<style>
${fontCss}
* { box-sizing: border-box; }
html, body { font-family: 'Heebo', Arial, sans-serif; margin: 0; padding: 0; color: #1c2947; }
body { padding: 8px 4px; }
h1 { font-size: 22pt; font-weight: 700; margin: 0; color: #1c2947; }
.brand { color: #666; font-size: 11pt; margin-top: 6px; }
hr { border: none; border-top: 1px solid #d9d9d9; margin: 22px 0; }
.row { margin-bottom: 18px; }
.label { color: #666; font-size: 10.5pt; margin-bottom: 4px; }
.value { font-size: 13pt; color: #1c2947; word-break: break-word; }
.value.mono { font-family: 'Courier New', monospace; font-size: 11pt; direction: ltr; text-align: right; }
.value.ltr { direction: ltr; text-align: right; }
.sigbox { border: 1px solid #cccccc; background: #fcfcfc; border-radius: 4px; height: 110px;
          display: flex; align-items: center; justify-content: center; padding: 8px; }
.sigbox svg { max-height: 92px; max-width: 100%; }
.legal { color: #777; font-size: 9pt; line-height: 1.5; margin-top: 26px; }
</style>
</head>
<body>
<h1>אישור חתימה דיגיטלית</h1>
<div class="brand">EMAPP — התחדשות עירונית</div>
<hr />

<div class="row">
  <div class="label">המסמך שנחתם</div>
  <div class="value">${escapeHtml(d.documentName.slice(0, MAX_TEXT_FIELD))}</div>
</div>

<div class="row">
  <div class="label">טביעת תוכן המסמך (SHA-256)</div>
  <div class="value mono">${escapeHtml(d.documentHash)}</div>
</div>

<div class="row">
  <div class="label">חתם/ה</div>
  <div class="value">${escapeHtml(d.ownerName.slice(0, MAX_TEXT_FIELD))}</div>
</div>

<div class="row">
  <div class="label">נחתם בתאריך (Asia/Jerusalem)</div>
  <div class="value ltr">${escapeHtml(signedAt)}</div>
</div>

<div class="row">
  <div class="label">אופן האימות</div>
  <div class="value ltr">${escapeHtml(d.authMethod)}</div>
</div>

<div class="row">
  <div class="label">החתימה</div>
  <div class="sigbox">${signatureSvg}</div>
</div>

<div class="legal">
  מסמך זה מאשר כי החתימה לעיל נקלטה דרך קישור החתימה הציבורי של EMAPP
  וכי טביעת התוכן לעיל מזהה באופן ייחודי את המסמך שנחתם.
</div>
</body>
</html>`;
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

/**
 * Build a CLEAN signature SVG from the stored markup. We do NOT embed the raw
 * user SVG (a stored SVG can carry `<script>` / `onload=` and would execute in
 * the Chromium render context). Instead we extract only the `<path d="…">`
 * geometry, escape each `d` value as attribute content, and emit a controlled
 * SVG with a viewBox we read from the source (falling back to a sane default).
 * If nothing usable is found, returns an empty string (no signature drawn) —
 * never raw user markup.
 */
function sanitizeSignatureSvg(svg: string): string {
  if (!svg) return '';
  const vb = /viewBox\s*=\s*["']\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*["']/i.exec(svg);
  const vbW = vb ? Number(vb[3]) : 300;
  const vbH = vb ? Number(vb[4]) : 100;
  const viewBox = `0 0 ${Number.isFinite(vbW) && vbW > 0 ? vbW : 300} ${Number.isFinite(vbH) && vbH > 0 ? vbH : 100}`;
  const paths = [...svg.matchAll(/<path[^>]*\sd\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1] ?? '');
  if (paths.length === 0) return '';
  const pathEls = paths
    .map(
      (dAttr) =>
        `<path d="${escapeHtml(dAttr)}" fill="none" stroke="#1a1a1a" stroke-width="1.5" />`,
    )
    .join('');
  return `<svg viewBox="${escapeHtml(viewBox)}" xmlns="http://www.w3.org/2000/svg">${pathEls}</svg>`;
}
