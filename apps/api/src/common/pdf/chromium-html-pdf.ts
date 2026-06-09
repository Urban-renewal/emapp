import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { ServiceUnavailableException } from '@nestjs/common';
import { chromium, type Browser, type LaunchOptions } from 'playwright-core';

/**
 * Shared HTML→PDF rendering via headless Chromium (playwright-core).
 *
 * Both the project export (`PdfExportService`) and the signed-certificate
 * renderer (`PdfSignedDocumentRenderer`) rasterise an HTML template through a
 * real browser so the Unicode Bidi Algorithm + complex-script shaping are done
 * by Chromium — NOT by hand-rolled bidi logic (which mirror-reversed Hebrew in
 * the pdf-lib certificate path; see PR #317). Factoring the launch + font CSS
 * here keeps ONE Chromium integration with one security posture.
 *
 * Why playwright-core: already an apps/api runtime dep, reuses apps/web's
 * pre-installed Chromium binary (no 300 MB puppeteer download). See
 * pdf-export.service.ts for the full rationale.
 */

/** Stable, non-leaky failure the GlobalExceptionFilter renders as a 503. The
 *  detailed cause goes to the server log at the call site — never to the wire
 *  (no chromium path / cwd / node_modules layout disclosure; redteam E-H3/E-H4). */
export function pdfUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    error: { code: 'pdf_unavailable', message: 'PDF rendering temporarily unavailable' },
  });
}

/**
 * A process-singleton headless Chromium with self-heal + graceful shutdown.
 *
 * One browser per process, lazily launched on first render (test suites that
 * never render pay nothing). Per-render isolation is a fresh `BrowserContext`.
 * If Chromium dies, `isConnected()` is false on the next call and we relaunch
 * transparently. Callers own their Nest lifecycle hook and forward
 * `onModuleDestroy` → `close()`.
 */
export class ChromiumBrowserPool {
  private browser: Browser | null = null;
  private launchPromise: Promise<Browser> | null = null;

  constructor(
    private readonly launchOptions: LaunchOptions = { headless: true },
    /** Called with the underlying error message on launch failure (server-side
     *  diagnostics only — the thrown error stays non-leaky). */
    private readonly onLaunchError?: (message: string) => void,
  ) {}

  /**
   * Get-or-launch the singleton. Concurrent first callers share one launch via
   * `launchPromise`. A dead browser (Chromium crash) is detected via
   * `isConnected()` and relaunched. On launch failure throws `pdfUnavailable()`
   * (503) — the underlying cause is reported to `onLaunchError`, never leaked.
   */
  async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    this.browser = null;
    if (this.launchPromise) return this.launchPromise;
    this.launchPromise = chromium
      .launch(this.launchOptions)
      .then((b) => {
        this.browser = b;
        b.on('disconnected', () => {
          if (this.browser === b) this.browser = null;
        });
        return b;
      })
      .catch((e: unknown) => {
        this.onLaunchError?.(e instanceof Error ? e.message : 'unknown');
        throw pdfUnavailable();
      })
      .finally(() => {
        this.launchPromise = null;
      });
    return this.launchPromise;
  }

  /**
   * Render an HTML document to PDF bytes in an isolated context. Waits for
   * `document.fonts.ready` so the base64 @font-face has actually rasterised
   * (otherwise Chromium emits the fallback font instead of Heebo). The context
   * is always closed in `finally`; an optional `AbortSignal` closes it early on
   * client disconnect.
   */
  async renderPdf(html: string, options: RenderPdfOptions = {}): Promise<Buffer> {
    const browser = await this.getBrowser();
    const ctx = await browser.newContext();
    const onAbort = (): void => {
      ctx.close().catch(() => {
        /* already-closed is fine */
      });
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const page = await ctx.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      await page.evaluate(
        () =>
          (globalThis as unknown as { document: { fonts: { ready: Promise<void> } } }).document
            .fonts.ready,
      );
      const pdf = await page.pdf({
        format: options.format ?? 'A4',
        landscape: options.landscape ?? false,
        printBackground: true,
        margin: options.margin ?? { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' },
      });
      return Buffer.from(pdf);
    } finally {
      await ctx.close();
    }
  }

  /** Close the singleton on graceful shutdown. Never throws. */
  async close(): Promise<string | null> {
    const b = this.browser;
    if (!b) return null;
    this.browser = null;
    try {
      await b.close();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : 'unknown';
    }
  }
}

export interface RenderPdfOptions {
  landscape?: boolean;
  format?: 'A4';
  margin?: { top: string; right: string; bottom: string; left: string };
  signal?: AbortSignal;
}

// ── Heebo @font-face CSS (base64-embedded, self-contained) ───────────────────
// Source: `@fontsource/heebo` (Google Fonts OFL), npm-pinned so we never fetch
// Google Fonts at render time (no leak, no latency, works air-gapped). Embedded
// as base64 data: URLs so the PDF is fully self-contained.

let cachedFontCss: string | null = null;

/**
 * Load the Heebo @font-face CSS block (Hebrew + Latin, 400 + 700). Cached after
 * first read (~80 KB in process memory). Throws `pdfUnavailable()` if the font
 * files can't be located — the candidate-path diagnostic goes to `onError`
 * (server log), never to the response (redteam E-H3: no node_modules layout
 * disclosure).
 */
export function loadHeeboFontCss(onError?: (message: string) => void): string {
  if (cachedFontCss !== null) return cachedFontCss;
  const files = [
    'heebo-hebrew-400-normal.woff2',
    'heebo-hebrew-700-normal.woff2',
    'heebo-latin-400-normal.woff2',
    'heebo-latin-700-normal.woff2',
  ];
  const cwd = process.cwd();
  // Robust to webpack/CJS/ESM/tsx: walk fixed candidate roots relative to cwd
  // instead of require.resolve (webpack inlines node:module so `.resolve`
  // disappears at runtime).
  const candidates = [
    resolvePath(cwd, 'apps/api/node_modules/@fontsource/heebo/files'),
    resolvePath(cwd, 'node_modules/@fontsource/heebo/files'),
    resolvePath(cwd, '../../node_modules/@fontsource/heebo/files'),
    resolvePath(cwd, '../node_modules/@fontsource/heebo/files'),
  ];
  let base: string | null = null;
  for (const cand of candidates) {
    if (existsSync(`${cand}/${files[0]}`)) {
      base = cand;
      break;
    }
  }
  if (!base) {
    onError?.(`pdf font lookup failed. CWD=${cwd}. Tried: ${candidates.join(' | ')}`);
    throw pdfUnavailable();
  }
  const css = files
    .map((name) => {
      const buf = readFileSync(`${base}/${name}`);
      const b64 = buf.toString('base64');
      const weight = name.includes('700') ? 700 : 400;
      return `@font-face {
  font-family: 'Heebo';
  font-style: normal;
  font-weight: ${weight};
  font-display: block;
  src: url(data:font/woff2;base64,${b64}) format('woff2');
}`;
    })
    .join('\n');
  cachedFontCss = css;
  return css;
}

/**
 * Escape a user-supplied string for safe interpolation into HTML text/attribute
 * content. LOAD-BEARING: the HTML→Chromium path is a NEW injection surface the
 * pdf-lib path never had — an owner/document name containing `<script>` or
 * `"><img onerror=…>` would otherwise execute in the render context. Escapes
 * the five HTML-significant characters.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
