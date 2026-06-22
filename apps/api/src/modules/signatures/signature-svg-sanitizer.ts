/**
 * Allowlist signature-SVG sanitiser — the SINGLE source of truth for turning an
 * untrusted resident-drawn signature SVG into a clean, controlled SVG that
 * carries ONLY drawing geometry (a viewBox + `<path d="…">` strokes).
 *
 * WHY THIS EXISTS (defense-in-depth — signature-flow H2):
 * The public-sign payload `signatureSvg` is validated on the wire only by an
 * outer-tag Zod regex (`/^<svg[\s\S]*<\/svg>$/i`) + a byte cap. That regex
 * accepts ARBITRARY inner content — `<script>`, `onload=`, `<foreignObject>`,
 * `<image href>` (SSRF), `<use href>` — so without this step a malicious SVG
 * would be encrypted + STORED verbatim (latent stored-XSS the moment any future
 * code path renders the raw blob).
 *
 * The defence is an ALLOWLIST REBUILD, not a blocklist strip: we never try to
 * remove dangerous tokens from the source markup. We extract ONLY the values we
 * trust (the viewBox numbers + each `<path d="…">` geometry string), attribute-
 * escape them, and emit a brand-new SVG. Nothing from the source survives except
 * the (escaped) path geometry — so no script / event-handler / external-ref /
 * foreignObject can possibly persist.
 *
 * Applied at INGEST (`PublicSignService.sign` — before encrypt+store) so the
 * STORED blob is already safe, AND at RENDER (`buildCertificateHtml`) as belt-
 * and-suspenders for any blob written before this guard existed. The function is
 * idempotent for real signatures: valid SVG path data (`M`/`L`/`C`, digits,
 * spaces, commas) contains none of `& < > " '`, so re-sanitising a stored blob
 * reproduces it.
 *
 * This module is intentionally dependency-free (no Nest / Node / browser
 * imports) so it can be reused anywhere without dragging in playwright.
 */

/** Escape a string for safe use as HTML/SVG attribute or text content. `&` MUST
 *  be replaced first so the `&` introduced by the later entities is not double-
 *  escaped. (Same five-char policy as the PDF renderer's HTML escaper.) */
function escapeSvgAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Rebuild a CLEAN signature SVG from untrusted markup.
 *
 * Returns a controlled `<svg viewBox="…"><path d="…" …/></svg>` containing only
 * the extracted path geometry, or an EMPTY STRING when no usable `<path d="…">`
 * is found (pure-payload input → nothing drawable → drop it; callers treat an
 * empty result as "no valid signature").
 */
export function sanitizeSignatureSvg(svg: string): string {
  if (!svg) return '';
  // viewBox: capture the four numbers; fall back to a sane default box. A
  // missing/garbage viewBox never carries markup into the output.
  const vb = /viewBox\s*=\s*["']\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*["']/i.exec(svg);
  const vbW = vb ? Number(vb[3]) : 300;
  const vbH = vb ? Number(vb[4]) : 100;
  const viewBox = `0 0 ${Number.isFinite(vbW) && vbW > 0 ? vbW : 300} ${
    Number.isFinite(vbH) && vbH > 0 ? vbH : 100
  }`;
  // Extract the geometry of every <path d="…">. `[^"']+` stops at the first
  // quote, so a `d` value carrying a `"`/`>` cannot break out of the attribute.
  const paths = [...svg.matchAll(/<path[^>]*\sd\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1] ?? '');
  if (paths.length === 0) return '';
  const pathEls = paths
    .map(
      (dAttr) =>
        `<path d="${escapeSvgAttr(dAttr)}" fill="none" stroke="#1a1a1a" stroke-width="1.5" />`,
    )
    .join('');
  return `<svg viewBox="${escapeSvgAttr(viewBox)}" xmlns="http://www.w3.org/2000/svg">${pathEls}</svg>`;
}
