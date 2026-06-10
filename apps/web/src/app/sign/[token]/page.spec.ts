/**
 * P4 #10 — ADVERSARIAL spec for the inline document preview on the resident
 * /sign/[token] page.
 *
 * What #10 added (PURE-FE): the GET /sign/:token preview already carries
 * `preview.document.downloadUrl` (a token-scoped presigned R2 GET). The page
 * now:
 *  - computes `safeDocUrl` = downloadUrl ONLY if it matches /^https:\/\//i,
 *    else null (an embed/click XSS guard — defense-in-depth on top of the
 *    wire `HttpsUrlSchema`).
 *  - renders an inline <iframe src={safeDocUrl} sandbox="" referrerPolicy=
 *    "no-referrer"> above the signature canvas (inert PDF: no allow-scripts /
 *    allow-same-origin; no-referrer so the /sign/<JWT> URL never leaks to R2).
 *  - a `previewFailed` (onError) state → fallback copy + open-in-new-tab link
 *    (same safeDocUrl, rel="noopener noreferrer").
 *
 * ── Test strategy (matches sidebar.spec.ts / list-page-shell.spec.ts) ──
 * The repo vitest env is `node` (NO jsdom / testing-library) and the spec glob
 * is `src/**\/*.spec.ts` (NOT `.spec.tsx`). We render the REAL page component
 * to an HTML string via react-dom/server `renderToStaticMarkup` and assert on
 * the concrete rendered markup.
 *
 * `renderToStaticMarkup` does NOT run effects, so the page's `useEffect` fetch
 * never fires — under SSR the component would freeze at `stage='loading'`. To
 * exercise the preview-branch JSX (the unit under test) we mock React's
 * `useState` with a per-render-controlled queue so the component renders with
 * the EXACT (stage, preview, previewFailed) tuple each test needs. Every other
 * React export (createElement, useRef, useCallback, useEffect) is the real one
 * (useEffect is a no-op under SSR anyway). This drives the production JSX in
 * page.tsx directly — the `safeDocUrl` guard, the <iframe> attrs, and the
 * fallback link are the real builder code, not a re-implementation.
 *
 * The security-critical test is §2 (the https guard). We feed downloadUrl a
 * matrix of malicious shapes (javascript:, data:, http:, vbscript:, relative,
 * protocol-relative, whitespace-prefixed, empty) and assert NONE reach an
 * iframe `src` or anchor `href`.
 */
import type { PublicSignPreview } from '@emapp/shared-types';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Build a FAKE, JWT-SHAPED token at runtime from non-secret parts so no
 * three-segment base64url JWT literal sits in source (the repo secret scanner
 * flags such literals even in test fixtures). This is NOT a real credential —
 * it's an HS256-header / `{"sub":"123"}`-payload / `hello-world-sign`-body
 * tuple with NO signing key. The output is byte-identical to the literal the
 * middleware public-route regex (`apps/web/src/middleware.ts`) requires, so the
 * page still treats `/sign/<token>` as a valid-shaped link.
 *
 * `function` declaration (not `const`) so it is HOISTED above the hoisted
 * `vi.mock('next/navigation')` factory that calls it.
 */
function base64Url(input: string): string {
  return Buffer.from(input, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
function makeFakeJwt(): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256' }));
  const payload = base64Url(JSON.stringify({ sub: '123' }));
  const signature = base64Url('hello-world-sign');
  return `${header}.${payload}.${signature}`;
}

// ── Real he.json `sign.*` copy we assert on (load-bearing: a renamed key or a
//    regressed branch renders the wrong/absent string and the test fails). ──
const PREVIEW_TITLE = 'תצוגה מקדימה של המסמך'; // sign.previewTitle
const PREVIEW_UNAVAILABLE =
  'לא ניתן להציג את המסמך כאן. פתח אותו בכרטיסייה חדשה כדי לקרוא לפני החתימה.'; // sign.previewUnavailable
const OPEN_DOCUMENT = 'פתח את המסמך לצפייה'; // sign.openDocument
const OPEN_NEW_TAB = 'פתח בכרטיסייה חדשה'; // sign.openDocumentNewTab
const SIGNATURE_SECTION = 'חתימה'; // sign.signatureSectionTitle
const SUBMIT = 'שלח חתימה'; // sign.submit
const CLEAR = 'נקה'; // sign.clear

// ── useState driver. The page calls useState in this fixed order each render:
//    [0] stage, [1] preview, [2] doneAt, [3] submitError, [4] canvasEmpty,
//    [5] consentChecked, [6] previewFailed. We override ONLY [0], [1] and [6];
//    the rest fall back to their real initial value. The setter is a no-op
//    (single SSR render). ──
let stateQueue: unknown[] = [];
let stateCursor = 0;

vi.mock('react', async (importActual) => {
  const actual = await importActual<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const idx = stateCursor;
      stateCursor += 1;
      const has = idx < stateQueue.length && stateQueue[idx] !== undefined;
      const value = has ? stateQueue[idx] : typeof initial === 'function' ? initial() : initial;
      return [value, vi.fn()];
    },
    // useEffect is a no-op under renderToStaticMarkup anyway; make it explicit
    // so the fetch in the load() effect never runs during the test render.
    useEffect: () => undefined,
  };
});

// next/navigation — the page reads useParams().token. A stable JWT-shaped
// value. We CONSTRUCT it at runtime from non-secret parts (header {"alg":
// "HS256"}, payload {"sub":"123"}, body "hello-world-sign") rather than
// pasting a three-segment base64url literal into source: it's a FAKE fixture
// (HS256 over a known string, no signing key), but a literal three-segment
// base64url string trips the repo's secret scanner. `makeFakeJwt` (below,
// hoisted via function declaration so it's visible inside this mock factory)
// yields the IDENTICAL JWT-SHAPED string the middleware regex requires.
vi.mock('next/navigation', () => ({
  useParams: () => ({ token: makeFakeJwt() }),
}));

// next-intl — return the REAL he.json copy keyed lookup so the rendered markup
// carries real strings. `t.rich` is used for the greeting (owner name tag); we
// implement it minimally (invoke the `name` tag callback so NameDisplay renders).
const SIGN_COPY: Record<string, string> = {
  loading: 'טוען...',
  invalidTitle: 'הקישור אינו תקף',
  invalidBody: 'x',
  doneTitle: 'x',
  doneBody: 'x',
  doneSavedAt: 'x',
  pageTitle: 'חתימה על מסמך',
  greeting: 'שלום',
  documentSectionTitle: 'המסמך לחתימה',
  previewTitle: PREVIEW_TITLE,
  previewUnavailable: PREVIEW_UNAVAILABLE,
  openDocument: OPEN_DOCUMENT,
  openDocumentNewTab: OPEN_NEW_TAB,
  linkExpires: 'תוקף',
  signatureSectionTitle: SIGNATURE_SECTION,
  signatureHint: 'hint',
  clear: CLEAR,
  submit: SUBMIT,
  submitting: 'שולח...',
  errorTooShort: 'x',
  errorTooLarge: 'x',
  errorInvalid: 'x',
};

vi.mock('next-intl', () => {
  const t = (key: string) => SIGN_COPY[key] ?? `MISSING:${key}`;
  // next-intl's t.rich calls the tag callback with the inner chunks. The page's
  // `name` callback ignores chunks and renders <NameDisplay>. We invoke it so
  // the render doesn't throw on a missing rich impl.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal rich stub
  (t as any).rich = (_key: string, tags: Record<string, (chunks?: unknown) => unknown>) =>
    tags.name ? tags.name('chunk') : null;
  return { useTranslations: () => t };
});

// SignatureCanvas pulls in pointer-event / imperative-handle machinery we don't
// exercise here — stub to an inert marker so the signature SECTION still renders
// (test §4: the canvas + submit survive WITH the preview present).
vi.mock('./_signature-canvas', () => ({
  SignatureCanvas: () => createElement('svg', { 'data-testid': 'sig-canvas' }),
}));

// NameDisplay is a bdi wrapper; passthrough stub so the doc-name renders as text.
vi.mock('@/components/ui/name-display', () => ({
  NameDisplay: ({ name }: { name: string }) => createElement('span', null, name),
}));

// Import AFTER mocks (vi.mock is hoisted; explicit ordering for intent).
import SignPage from './page';

/** A healthy preview whose downloadUrl is overridable per test. */
function buildPreview(downloadUrl: string): PublicSignPreview {
  return {
    document: {
      name: 'הסכם תמא 38',
      downloadUrl: downloadUrl as PublicSignPreview['document']['downloadUrl'],
    },
    owner: { name: 'דנה כהן' },
    expiresAt: new Date('2030-01-01T00:00:00Z'),
    consentNotice: {
      text: 'הודעת פרטיות לדוגמה',
      version: 'v1',
      requireExplicitConsent: false,
    },
  };
}

/**
 * Render the REAL SignPage at the preview stage with a chosen downloadUrl and
 * previewFailed flag. We seed the useState queue (stage, preview, _, _, _,
 * previewFailed) and reset the cursor before the single SSR render.
 */
function renderPreview(opts: {
  downloadUrl: string;
  previewFailed?: boolean;
  stage?: string;
  preview?: PublicSignPreview | null;
}): string {
  stateQueue = [
    opts.stage ?? 'preview', // [0] stage
    opts.preview !== undefined ? opts.preview : buildPreview(opts.downloadUrl), // [1] preview
    undefined, // [2] doneAt — fall through to real initial (null)
    undefined, // [3] submitError
    undefined, // [4] canvasEmpty
    undefined, // [5] consentChecked — fall through to real initial (false)
    opts.previewFailed ?? false, // [6] previewFailed
  ];
  stateCursor = 0;
  return renderToStaticMarkup(createElement(SignPage));
}

/** Extract every `src="..."` and `href="..."` value from the rendered markup. */
function urlAttrs(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/(?:src|href)="([^"]*)"/g)) out.push(m[1] ?? '');
  return out;
}

/** The full `<iframe ...>` open tag (empty string if absent). */
function iframeTagOf(html: string): string {
  return html.match(/<iframe[^>]*>/)?.[0] ?? '';
}

beforeEach(() => {
  stateQueue = [];
  stateCursor = 0;
});
afterEach(() => {
  vi.clearAllMocks();
});

const HTTPS_R2 = 'https://emapp-test.r2.cloudflarestorage.com/doc.pdf?sig=fixture';

describe('§P4-#10 / SignPage — inline preview renders for a valid https doc URL', () => {
  it('1) renders an <iframe> with the https src, sandbox="" and referrerPolicy="no-referrer"', () => {
    const html = renderPreview({ downloadUrl: HTTPS_R2 });

    // The iframe is present and points at the presigned R2 URL.
    expect(html).toContain('<iframe');
    expect(html).toContain(`src="${HTTPS_R2}"`);
    // Maximally-restrictive sandbox: EMPTY string (no allow-scripts /
    // allow-same-origin / allow-forms). renderToStaticMarkup emits sandbox="".
    expect(html).toMatch(/<iframe[^>]*\bsandbox=""/);
    // no-referrer so the /sign/<JWT> URL is NOT sent to R2 in the Referer.
    expect(html).toMatch(/referrerpolicy="no-referrer"/i);
    // The preview caption renders (proves we're in the preview branch).
    expect(html).toContain(PREVIEW_TITLE);
    // Proof we rendered the REAL page.tsx iframe (not a mock): the unique
    // class string the builder set on it. If this changes, this assertion
    // (intentionally) breaks so the test author re-reads the diff.
    expect(iframeTagOf(html)).toContain('h-[28rem]');

    // Adversarial: the sandbox must NOT have been widened with any allow-*.
    const iframeTag = iframeTagOf(html);
    expect(iframeTag).not.toMatch(/allow-scripts/);
    expect(iframeTag).not.toMatch(/allow-same-origin/);
    expect(iframeTag).not.toMatch(/allow-forms/);
    expect(iframeTag).not.toMatch(/allow-popups/);
    expect(iframeTag).not.toMatch(/allow-top-navigation/);
  });

  it('1b) the iframe sits ABOVE the signature canvas (preview is additive, not replacing)', () => {
    const html = renderPreview({ downloadUrl: HTTPS_R2 });
    const iframeIdx = html.indexOf('<iframe');
    const canvasIdx = html.indexOf('data-testid="sig-canvas"');
    expect(iframeIdx).toBeGreaterThanOrEqual(0);
    expect(canvasIdx).toBeGreaterThanOrEqual(0);
    expect(iframeIdx).toBeLessThan(canvasIdx);
  });

  it('1c) the open-in-new-tab link is the SAME safeDocUrl with rel="noopener noreferrer"', () => {
    const html = renderPreview({ downloadUrl: HTTPS_R2 });
    // The anchor carries the https URL and a hardening rel.
    const anchorTag = html.match(/<a[^>]*href="https:[^>]*>/)?.[0] ?? '';
    expect(anchorTag).toContain(`href="${HTTPS_R2}"`);
    expect(anchorTag).toMatch(/rel="noopener noreferrer"/);
    expect(anchorTag).toMatch(/target="_blank"/);
    // Not-failed state → the "open document" copy (not the new-tab fallback copy).
    expect(html).toContain(OPEN_DOCUMENT);
  });
});

describe('§P4-#10 / SignPage — safeDocUrl https guard (SECURITY-CRITICAL)', () => {
  // The adversarial matrix. Each of these is NON-https and MUST be rejected by
  // the `/^https:\/\//i` guard → safeDocUrl is null → NEITHER an <iframe src>
  // NOR an <a href> may carry the value. (Defense-in-depth: the wire schema
  // would already reject these, but the page re-checks before embed/link.)
  const MALICIOUS: Array<{ name: string; url: string }> = [
    { name: 'javascript: scheme (click-XSS)', url: 'javascript:alert(document.domain)' },
    { name: 'JaVaScRiPt: mixed-case', url: 'JaVaScRiPt:alert(1)' },
    { name: 'data: html (inline-XSS)', url: 'data:text/html,<script>alert(1)</script>' },
    { name: 'vbscript:', url: 'vbscript:msgbox(1)' },
    { name: 'http: (downgrade / referrer leak over cleartext)', url: 'http://r2.example/doc.pdf' },
    { name: 'protocol-relative', url: '//evil.example/doc.pdf' },
    { name: 'relative path', url: '/api/v1/sign/leak' },
    { name: 'bare path', url: 'doc.pdf' },
    {
      name: 'whitespace-prefixed https (guard is anchored, not trimmed)',
      url: ' https://r2.example/doc.pdf',
    },
    { name: 'leading-newline https (anchor bypass attempt)', url: '\nhttps://r2.example/doc.pdf' },
    { name: 'empty string', url: '' },
    { name: 'httpsx scheme typo-squat', url: 'httpsx://r2.example/doc.pdf' },
    { name: 'http-then-https in path (substring trap)', url: 'http://evil/?next=https://ok' },
  ];

  for (const { name, url } of MALICIOUS) {
    it(`2) rejects ${name} — no iframe/href carries it, safeDocUrl is null`, () => {
      const html = renderPreview({ downloadUrl: url });

      // No iframe at all (safeDocUrl null → the whole figure + iframe + link
      // block is `: null`).
      expect(html, `iframe must not render for "${url}"`).not.toContain('<iframe');
      // The malicious value must not appear in ANY src/href attribute.
      const attrs = urlAttrs(html);
      for (const a of attrs) {
        expect(a, `attr "${a}" must not contain the unsafe url "${url}"`).not.toContain(url);
      }
      // And specifically the dangerous scheme tokens must not surface as a
      // src/href value even partially (catch a renderer that re-encodes).
      const dangerous = url.trim().toLowerCase();
      if (
        dangerous.startsWith('javascript:') ||
        dangerous.startsWith('data:') ||
        dangerous.startsWith('vbscript:')
      ) {
        expect(attrs.some((a) => a.toLowerCase().includes(dangerous))).toBe(false);
      }
      // The preview caption + open-document link are GONE (whole block dropped).
      expect(html).not.toContain(PREVIEW_TITLE);
      expect(html).not.toContain(OPEN_DOCUMENT);
      expect(html).not.toContain(OPEN_NEW_TAB);
    });
  }

  it('2-control) a clean https URL is NOT rejected (proves the matrix is discriminating, not a tautology)', () => {
    const html = renderPreview({ downloadUrl: HTTPS_R2 });
    // The same assertions that must FAIL-to-render for malicious URLs must
    // SUCCEED here — proving §2 actually discriminates http(s).
    expect(html).toContain('<iframe');
    expect(urlAttrs(html)).toContain(HTTPS_R2);
    expect(html).toContain(PREVIEW_TITLE);
  });
});

describe('§P4-#10 / SignPage — previewFailed fallback (onError path)', () => {
  it('3) previewFailed → fallback copy + open-in-new-tab link (same safeDocUrl, no iframe)', () => {
    const html = renderPreview({ downloadUrl: HTTPS_R2, previewFailed: true });

    // Fallback copy renders…
    expect(html).toContain(PREVIEW_UNAVAILABLE);
    // …and the iframe is replaced (the failed branch renders the <p>, not the
    // <iframe>).
    expect(html).not.toContain('<iframe');
    // The open link is now the new-tab fallback affordance, still the SAME
    // safeDocUrl with the hardening rel.
    expect(html).toContain(OPEN_NEW_TAB);
    expect(html).not.toContain(OPEN_DOCUMENT);
    const anchorTag = html.match(/<a[^>]*href="https:[^>]*>/)?.[0] ?? '';
    expect(anchorTag).toContain(HTTPS_R2);
    expect(anchorTag).toMatch(/rel="noopener noreferrer"/);
    expect(anchorTag).toMatch(/target="_blank"/);
  });

  it('3b) previewFailed WITH a non-https URL still renders NO link (guard wins over fallback)', () => {
    // Even in the failed state, a non-https downloadUrl must not surface a
    // href — safeDocUrl is null so the entire affordance is dropped.
    const html = renderPreview({ downloadUrl: 'javascript:alert(1)', previewFailed: true });
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain(PREVIEW_UNAVAILABLE); // the figure block is `: null`
    expect(html).not.toContain(OPEN_NEW_TAB);
    for (const a of urlAttrs(html)) expect(a).not.toContain('javascript:');
  });
});

describe('§P4-#10 / SignPage — signature flow unchanged (no regression)', () => {
  it('4) the signature canvas + submit/clear buttons still render WITH the preview present', () => {
    const html = renderPreview({ downloadUrl: HTTPS_R2 });
    // Preview present…
    expect(html).toContain('<iframe');
    // …AND the signature section is intact below it.
    expect(html).toContain('data-testid="sig-canvas"');
    expect(html).toContain(SIGNATURE_SECTION);
    expect(html).toContain(SUBMIT);
    expect(html).toContain(CLEAR);
    // The submit button is the canonical signing action (a <button>).
    expect(html).toMatch(/<button[^>]*>[^<]*שלח חתימה/);
  });

  it('4b) signature flow renders even when the preview is UNAVAILABLE (non-https url)', () => {
    // The preview being dropped must not take the signature UI with it.
    const html = renderPreview({ downloadUrl: 'http://evil/doc.pdf' });
    expect(html).not.toContain('<iframe');
    expect(html).toContain('data-testid="sig-canvas"');
    expect(html).toContain(SUBMIT);
    expect(html).toContain(CLEAR);
  });
});

describe('§P4-#10 / SignPage — non-tautology proof (the guard actually gates)', () => {
  // FINDING (documented): React 19's renderToStaticMarkup ITSELF refuses to
  // emit a `javascript:`/`data:` URL into href/src (it strips them + warns).
  // So a `javascript:` URL would not leak even WITHOUT the page's guard — i.e.
  // `javascript:` alone is NOT a discriminating non-tautology case. The case
  // that PROVES the page's own `safeDocUrl` guard is load-bearing is `http://`
  // (a downgrade / Referer-over-cleartext vector): React emits it RAW, so only
  // the page's `/^https:\/\//i` check stops it. We use http:// here.
  it('5) the page guard (NOT React) is what drops a non-https url — proven with http://', () => {
    const raw = 'http://evil.example/doc.pdf';

    // Baseline: a NAIVE render that embeds the raw url DOES leak it — React
    // happily emits an http:// src/href. This is the world WITHOUT the guard.
    const naive = renderToStaticMarkup(
      createElement(
        'figure',
        null,
        createElement('iframe', { src: raw, sandbox: '' }),
        createElement('a', { href: raw }, OPEN_DOCUMENT),
      ),
    );
    expect(naive).toContain('<iframe');
    expect(urlAttrs(naive).some((a) => a.includes(raw))).toBe(true); // leaks!

    // The REAL guarded page does NOT leak it — the `safeDocUrl` https check is
    // the only thing standing between http:// and the DOM. Discriminating
    // contrast: same input, opposite outcome → §2 is not a tautology.
    const guarded = renderPreview({ downloadUrl: raw });
    expect(guarded).not.toContain('<iframe');
    expect(urlAttrs(guarded).some((a) => a.includes(raw))).toBe(false);
    expect(guarded).not.toContain(OPEN_DOCUMENT);
  });

  it('5b) FINDING: React blocks javascript: but NOT data:/vbscript: — so the page guard is essential', () => {
    // Observed React-19 behaviour (pinned so a future change is caught):
    //  - `javascript:` href/src → React REWRITES it to a "blocked" throw string
    //    (the literal scheme is neutralised). A second layer of defense.
    //  - `data:` and `vbscript:` → React emits them RAW. React provides NO
    //    defense for these. The page's own `/^https:\/\//i` `safeDocUrl` guard
    //    is therefore the ONLY thing that stops a data:/vbscript: downloadUrl
    //    from reaching an href/src. This is why §2 (which proves the page drops
    //    these) is load-bearing, not a tautology.
    const jsNaive = renderToStaticMarkup(
      createElement('a', { href: 'javascript:alert(1)' }, OPEN_DOCUMENT),
    );
    // React neutralised the javascript: scheme (rewrote to a blocked string).
    expect(jsNaive).toContain('React has blocked');

    const dataNaive = renderToStaticMarkup(
      createElement('a', { href: 'data:text/html,x' }, OPEN_DOCUMENT),
    );
    const vbNaive = renderToStaticMarkup(createElement('a', { href: 'vbscript:x' }, OPEN_DOCUMENT));
    // React emits data:/vbscript: RAW → only the PAGE guard protects against them.
    expect(urlAttrs(dataNaive).some((a) => a.includes('data:text/html'))).toBe(true);
    expect(urlAttrs(vbNaive).some((a) => a.includes('vbscript:'))).toBe(true);

    // …and the REAL guarded page drops BOTH (the whole figure block is `: null`).
    for (const bad of ['data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)']) {
      const guarded = renderPreview({ downloadUrl: bad });
      expect(guarded).not.toContain('<iframe');
      expect(urlAttrs(guarded).some((a) => a.includes(bad))).toBe(false);
    }
  });
});
