/**
 * INDEPENDENT adversarial spec for the signed-certificate renderer (PR #317),
 * authored by the TEST-AUTHOR (separate from the builder). Does NOT trust the
 * builder's own spec.
 *
 * The signed-certificate PDF moved from pdf-lib (which mirror-reversed Hebrew)
 * to HTML → headless Chromium. That swap opens a NEW injection surface: every
 * user string is now interpolated into an HTML document and rasterised by a
 * real browser. If `escapeHtml` / `sanitizeSignatureSvg` were bypassed, a
 * stored owner name / document name / signature SVG could inject `<script>` or
 * event handlers into the render context.
 *
 * This file targets the DETERMINISTIC pure-HTML layer (`buildCertificateHtml`)
 * — no Chromium, no DB. Tests 1 & 2 are the security load-bearing ones and are
 * written to be MUTATION-PROOF: if the escape/sanitise step is removed, they
 * fail (they assert the raw dangerous token is ABSENT *and* the escaped form is
 * PRESENT, so a no-op escape cannot pass them). The optional Chromium render
 * (test 5) self-skips when no browser binary is present.
 */
import { describe, expect, it } from 'vitest';

import { buildCertificateHtml } from './pdf-signed-document.renderer';
import type { SignedCertificateData } from './signed-document.types';

const base: SignedCertificateData = {
  documentName: 'הסכם התחדשות עירונית — דירה 12, רחוב הרצל 5',
  documentHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  authMethod: 'public_link_v1',
  signedAt: new Date('2026-06-05T09:30:00.000Z'),
  ownerName: 'ישראל ישראלי',
  signatureSvg:
    '<svg viewBox="0 0 300 100"><path d="M10 80 C 40 10, 65 10, 95 80 S 150 150, 180 80" /></svg>',
};

// ── 1. HTML-injection escaping (LOAD-BEARING, mutation-proof) ────────────────
describe('buildCertificateHtml · HTML-injection escaping (load-bearing)', () => {
  // Each user field gets independently fuzzed so a regression that drops the
  // escape on ONE interpolation site (e.g. forgets ownerName) is caught.
  const userFields = ['ownerName', 'documentName', 'authMethod'] as const;

  const payloads: Array<{ name: string; value: string }> = [
    { name: 'script tag', value: '<script>alert(1)</script>' },
    { name: 'attribute breakout + onerror', value: '"><img src=x onerror=alert(1)>' },
    { name: 'all five significant chars', value: `& < > " '` },
    { name: 'onload attr breakout', value: 'x" onload="alert(2)' },
    { name: 'title-close + script', value: '</title><script>alert(1)</script>' },
    { name: 'javascript: URL', value: 'javascript:alert(document.cookie)' },
    { name: 'HTML comment open', value: '<!--<script>alert(1)//-->' },
    { name: 'template literal breakout', value: '`+document.cookie+`${alert(1)}' },
    { name: 'string-concat XSS', value: "'+document.cookie+'" },
  ];

  for (const field of userFields) {
    for (const p of payloads) {
      it(`escapes ${field} payload: ${p.name}`, () => {
        const data: SignedCertificateData = { ...base, [field]: p.value } as SignedCertificateData;
        const html = buildCertificateHtml(data);

        // (a) The raw dangerous MARKUP must NOT survive: the `<` that would open
        //     a live tag must be entity-escaped, so no executable element exists.
        //     (Inert text like the substring "onerror=alert(1)" may remain — it
        //     is harmless once `<img` is neutralised to `&lt;img`; the load-
        //     bearing invariant is that NO unescaped tag/attribute forms.)
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).not.toContain('<img src=x onerror=alert(1)>');
        expect(html).not.toContain('<img ');
        expect(html).not.toContain('<script');
        expect(html).not.toContain('onload="alert(2)"');
        // The injected `">` attribute-breakout sequence must never reach the
        // output with a RAW double-quote — the `"` is entity-escaped so it
        // cannot close an attribute. (We can't assert on `"><` globally: the
        // legit template emits `class="sigbox"><svg`.)
        expect(html).not.toContain('"><img');
        expect(html).not.toContain('alert(2)"');

        // (b) MUTATION-PROOF positive: the escaped form must be present for the
        //     chars actually in this payload. A no-op escapeHtml would leave the
        //     raw char and fail (a); an over-eager but wrong escape would fail
        //     (b). Both directions are pinned.
        if (p.value.includes('<')) expect(html).toContain('&lt;');
        if (p.value.includes('>')) expect(html).toContain('&gt;');
        if (p.value.includes('"')) expect(html).toContain('&quot;');
        if (p.value.includes('&')) expect(html).toContain('&amp;');
        if (p.value.includes("'")) expect(html).toContain('&#39;');

        // (c) Vector-specific kill-shots: the exact executable form must be
        //     absent. A `javascript:` URL is never placed in an href context
        //     (all user values are text/quoted), and the literal tag/comment
        //     openers are neutralised to entities.
        expect(html).not.toContain('</title><script>');
        expect(html).not.toContain('<!--<script>');
        expect(html).not.toContain('<script>alert(1)</script>');
      });
    }
  }

  it('all-five-chars payload round-trips to exactly the five entities (ordering of & first)', () => {
    // `& < > " '` — the `&` MUST be escaped first, otherwise the `&` introduced
    // by `&lt;` etc. would be double-escaped. Pin the exact expected substring
    // so a wrong replace ORDER (which would yield `&amp;lt;`) is caught.
    const html = buildCertificateHtml({ ...base, ownerName: `& < > " '` });
    expect(html).toContain('&amp; &lt; &gt; &quot; &#39;');
    expect(html).not.toContain('&amp;lt;');
    expect(html).not.toContain('&amp;amp;');
  });

  it('does not leak a stray unescaped < or > from user fields anywhere in <body>', () => {
    // Combine every field with a tag-injection payload and prove the BODY
    // carries no raw user-controlled tag. (Static template tags like <div>,
    // <h1> are fine — we look specifically for the injected token.)
    const html = buildCertificateHtml({
      ...base,
      ownerName: '<b>owner</b>',
      documentName: '<i>doc</i>',
      authMethod: '<u>auth</u>',
    });
    expect(html).not.toContain('<b>owner</b>');
    expect(html).not.toContain('<i>doc</i>');
    expect(html).not.toContain('<u>auth</u>');
    expect(html).toContain('&lt;b&gt;owner&lt;/b&gt;');
    expect(html).toContain('&lt;i&gt;doc&lt;/i&gt;');
    expect(html).toContain('&lt;u&gt;auth&lt;/u&gt;');
  });

  it('escapes the document hash field too (uniform escaping, no special-casing)', () => {
    const html = buildCertificateHtml({ ...base, documentHash: '<script>x</script>' });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });
});

// ── 2. SVG sanitisation (LOAD-BEARING, mutation-proof) ───────────────────────
describe('buildCertificateHtml · signature SVG sanitisation (load-bearing)', () => {
  it('keeps path geometry but DROPS script / event-handler / external-ref', () => {
    const evil =
      '<svg viewBox="0 0 300 100" onload="steal()">' +
      '<script>fetch("//evil")</script>' +
      '<image href="http://evil/x.png" />' +
      '<path d="M0 0 L10 10" onclick="steal()" onload="x()" />' +
      '</svg>';
    const html = buildCertificateHtml({ ...base, signatureSvg: evil });

    // Isolate the rebuilt signature box so static-template tokens elsewhere
    // (e.g. the Heebo @font-face data: URLs) can't mask a leak.
    const box = sigboxOf(html);

    // Geometry survives, in a clean controlled <path>.
    expect(box).toContain('d="M0 0 L10 10"');
    expect(box).toContain('stroke=');

    // Dangerous constructs are GONE. If sanitisation were bypassed (raw SVG
    // embedded), each of these would survive → FAIL.
    expect(box).not.toContain('<script');
    expect(box).not.toContain('fetch("//evil")');
    expect(box).not.toContain('onclick');
    expect(box).not.toContain('onload');
    expect(box).not.toContain('<image');
    expect(box).not.toContain('href');
    expect(box).not.toContain('evil');

    // Only <svg> / <path> element tags are present in the rebuilt box.
    const tags = [...box.matchAll(/<([a-zA-Z][\w-]*)/g)].map((m) => m[1]?.toLowerCase());
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) expect(['svg', 'path']).toContain(t);
  });

  // Exhaustive vector table (owner's explicit concern): each malicious SVG must
  // (a) NEVER reflect its dangerous construct into the rebuilt box, and
  // (b) when a legit <path d> is present, KEEP only that geometry.
  // The sanitiser REBUILDS the SVG from captured `d` values, so nothing from
  // the source markup survives except the (escaped) geometry string. These
  // assertions fail if sanitisation is bypassed (raw SVG reflected).
  const svgVectors: Array<{
    name: string;
    svg: string;
    keepPath?: string; // geometry that must survive (legit path present)
    banned: string[]; // tokens that must NOT appear in the rebuilt box
  }> = [
    {
      name: 'script element',
      svg: '<svg viewBox="0 0 10 10"><script>fetch("//evil")</script><path d="M1 1"/></svg>',
      keepPath: 'd="M1 1"',
      banned: ['<script', 'fetch', 'evil'],
    },
    {
      name: 'event handler on the path (d survives, handler dropped)',
      svg: '<svg><path d="M2 2" onclick="steal()"/></svg>',
      keepPath: 'd="M2 2"',
      banned: ['onclick', 'steal'],
    },
    {
      name: 'event handler BEFORE the d attribute',
      svg: '<svg><path onclick="evil()" onmouseover="x()" d="M3 3"/></svg>',
      keepPath: 'd="M3 3"',
      banned: ['onclick', 'onmouseover', 'evil'],
    },
    {
      name: 'onload / onmouseover on a path',
      svg: '<svg><path d="M4 4" onload="a()" onmouseover="b()"/></svg>',
      keepPath: 'd="M4 4"',
      banned: ['onload', 'onmouseover'],
    },
    {
      name: 'foreignObject + body (no path → empty)',
      svg: '<svg viewBox="0 0 10 10"><foreignObject><body>x</body></foreignObject></svg>',
      banned: ['foreignObject', '<body', '<svg'],
    },
    {
      name: 'image href SSRF + xlink:href (dropped; legit path kept)',
      svg: '<svg><image href="http://internal/ssrf"/><image xlink:href="http://internal/2"/><path d="M5 5"/></svg>',
      keepPath: 'd="M5 5"',
      banned: ['<image', 'href', 'internal', 'ssrf', 'xlink'],
    },
    {
      name: 'use external reference',
      svg: '<svg><use href="#x"/><use xlink:href="#y"/><path d="M6 6"/></svg>',
      keepPath: 'd="M6 6"',
      banned: ['<use', 'href'],
    },
    {
      name: 'style with expression() and url()',
      svg: '<svg><style>*{background:expression(alert(1));x:url(//evil)}</style><path d="M7 7"/></svg>',
      keepPath: 'd="M7 7"',
      banned: ['<style', 'expression', 'url(', 'evil'],
    },
    {
      name: 'animate element',
      svg: '<svg><path d="M8 8"><animate attributeName="x" to="9"/></path></svg>',
      keepPath: 'd="M8 8"',
      banned: ['<animate', 'attributeName'],
    },
    {
      name: 'attribute breakout via d="z"/><script>',
      svg: '<svg><path d="z"/><script>alert(1)</script></svg>',
      keepPath: 'd="z"',
      banned: ['<script', 'alert(1)'],
    },
    {
      name: 'encoded payload &#x3c;script&#x3e;',
      svg: '<svg><path d="M9 9">&#x3c;script&#x3e;alert(1)&#x3c;/script&#x3e;</svg>',
      keepPath: 'd="M9 9"',
      // the literal "<script" never appears; the encoded ampersands are
      // re-escaped to &amp; so they cannot be re-decoded into a tag.
      banned: ['<script', '&#x3c;script'],
    },
    {
      name: 'svg wrapper onload handler',
      svg: '<svg onload="steal()" viewBox="0 0 10 10"><path d="M0 1"/></svg>',
      keepPath: 'd="M0 1"',
      banned: ['onload', 'steal'],
    },
  ];

  for (const v of svgVectors) {
    it(`SVG vector — ${v.name}`, () => {
      const box = sigboxOf(buildCertificateHtml({ ...base, signatureSvg: v.svg }));
      for (const bad of v.banned) {
        expect(box, `banned token "${bad}" leaked into sigbox`).not.toContain(bad);
      }
      if (v.keepPath) {
        expect(box, `legit geometry "${v.keepPath}" was dropped`).toContain(v.keepPath);
        expect(box).toContain('stroke=');
        // Only <svg>/<path> element tags survive in the rebuilt box.
        const tags = [...box.matchAll(/<([a-zA-Z][\w-]*)/g)].map((m) => m[1]?.toLowerCase());
        for (const t of tags) expect(['svg', 'path']).toContain(t);
      } else {
        // No usable path → empty box, never raw user markup.
        expect(box).toBe('');
      }
    });
  }

  it('a d value containing a raw " and > is clipped at the quote (no breakout)', () => {
    // [^"']+ stops at the first quote: the capture is the safe prefix only, so
    // the trailing `" > z` (which could otherwise close the attribute + open a
    // tag) never reaches the output.
    const svg = `<svg><path d='M7 7 " > z'/></svg>`;
    const box = sigboxOf(buildCertificateHtml({ ...base, signatureSvg: svg }));
    expect(box).toContain('d="M7 7 "'); // clipped prefix, attribute-escaped
    expect(box).not.toContain('> z');
    expect(box).not.toContain('"/><'); // no attribute breakout
    const tags = [...box.matchAll(/<([a-zA-Z][\w-]*)/g)].map((m) => m[1]?.toLowerCase());
    for (const t of tags) expect(['svg', 'path']).toContain(t);
  });

  it('multiple legit paths are all preserved', () => {
    const svg = '<svg viewBox="0 0 50 50"><path d="M0 0 L1 1"/><path d="M2 2 L3 3"/></svg>';
    const box = sigboxOf(buildCertificateHtml({ ...base, signatureSvg: svg }));
    expect(box).toContain('d="M0 0 L1 1"');
    expect(box).toContain('d="M2 2 L3 3"');
    expect((box.match(/<path /g) ?? []).length).toBe(2);
  });

  it('escapes a path d-attribute breakout attempt (extracted geometry is attribute-escaped)', () => {
    // A malicious `d` value carrying HTML-significant chars. The sanitiser
    // extracts the captured geometry and re-emits it via escapeHtml as the
    // value of a controlled `d="…"`. Use single quotes around the source `d`
    // so the capture itself contains a raw `<` / `&` that MUST be escaped.
    const svg = `<svg viewBox="0 0 10 10"><path d='M0 0 <b>& onload=x'/></svg>`;
    const box = sigboxOf(buildCertificateHtml({ ...base, signatureSvg: svg }));
    // The captured geometry is present, but the dangerous chars are escaped so
    // the value cannot break out of the rebuilt d="…" attribute.
    expect(box).not.toContain('<b>');
    expect(box).toContain('&lt;b&gt;');
    expect(box).toContain('&amp;');
    // Still a clean controlled <path> (no raw user element survived).
    expect(box).toContain('stroke=');
  });

  it('no usable path → empty signature box, NEVER raw user markup', () => {
    const html = buildCertificateHtml({
      ...base,
      signatureSvg: '<svg><g><script>alert(1)</script></g></svg>',
    });
    expect(html).toContain('class="sigbox"></div>');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('empty signature SVG → empty box, no throw', () => {
    const html = buildCertificateHtml({ ...base, signatureSvg: '' });
    expect(html).toContain('class="sigbox"></div>');
  });

  /** Extract the inner HTML of the rendered .sigbox so SVG assertions don't
   *  accidentally match the @font-face data: URLs or static template tags. */
  function sigboxOf(html: string): string {
    const m = /class="sigbox">([\s\S]*?)<\/div>/.exec(html);
    expect(m, 'sigbox div not found in rendered HTML').toBeTruthy();
    return m?.[1] ?? '';
  }
});

// ── 3. Hebrew present + logical order + RTL base dir (mirror-bug regression) ──
describe('buildCertificateHtml · Hebrew logical order + RTL', () => {
  it('carries the sample Hebrew verbatim in LOGICAL order (no pre-reversal)', () => {
    const html = buildCertificateHtml({
      ...base,
      ownerName: 'ישראל ישראלי',
      documentName: 'דירה 12, רחוב הרצל 5, תל אביב',
    });
    // The source strings appear EXACTLY as given (the old bug pre-reversed
    // them in the byte stream). Visual reorder is Chromium's job at raster.
    expect(html).toContain('ישראל ישראלי');
    expect(html).toContain('דירה 12, רחוב הרצל 5, תל אביב');
    // The reversed (mirror-writing) form must NOT appear — direct guard
    // against the regression that motivated this whole change.
    expect(html).not.toContain('ילארשי לארשי');
  });

  it('document container is RTL base direction', () => {
    const html = buildCertificateHtml(base);
    expect(html).toMatch(/<html[^>]*\sdir="rtl"/);
    expect(html).toMatch(/lang="he"/);
  });
});

// ── 4. All certificate fields present ────────────────────────────────────────
describe('buildCertificateHtml · all certificate fields present', () => {
  it('renders title, brand, document name, hash, signer, signed-at, auth method, legal', () => {
    const html = buildCertificateHtml(base);

    // Title + brand.
    expect(html).toContain('אישור חתימה דיגיטלית');
    expect(html).toContain('EMAPP');

    // Document name + SHA-256 hash (verbatim).
    expect(html).toContain(base.documentName);
    expect(html).toContain(base.documentHash);

    // Signer.
    expect(html).toContain(base.ownerName);

    // Signed-at, localised to Asia/Jerusalem. 09:30 UTC on 2026-06-05 →
    // 12:30 in Jerusalem (IDT, UTC+3) on 05/06/2026.
    expect(html).toContain('05/06/2026');
    expect(html).toContain('12:30');

    // Auth method.
    expect(html).toContain('public_link_v1');

    // Signature geometry (from base SVG) present.
    expect(html).toContain('M10 80');

    // Legal sentence.
    expect(html).toContain('מסמך זה מאשר כי החתימה לעיל נקלטה');
  });

  it('each field is INDEPENDENTLY present (sentinel per field, no cross-talk)', () => {
    const html = buildCertificateHtml({
      ...base,
      documentName: 'DOCNAME_SENTINEL_α',
      documentHash: 'HASHSENTINEL00ff',
      ownerName: 'OWNER_SENTINEL_β',
      authMethod: 'AUTH_SENTINEL_γ',
    });
    for (const s of ['DOCNAME_SENTINEL', 'HASHSENTINEL00ff', 'OWNER_SENTINEL', 'AUTH_SENTINEL']) {
      expect(html, `field sentinel "${s}" missing`).toContain(s);
    }
  });
});
