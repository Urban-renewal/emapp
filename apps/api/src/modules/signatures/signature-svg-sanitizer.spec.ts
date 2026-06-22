/**
 * Signature-flow H2 — adversarial spec for the INGEST sanitiser
 * (`sanitizeSignatureSvg`), the shared allowlist rebuild applied BEFORE the
 * resident's signature SVG is encrypted + stored by `PublicSignService.sign`.
 *
 * The wire validation (`PublicSignSubmitInput`) only checks an outer-tag regex
 * + a byte cap, so it ACCEPTS arbitrary inner markup. This spec proves that
 * whatever that regex lets through, the sanitiser turns into a clean controlled
 * SVG carrying ONLY drawing geometry — so no active content can ever PERSIST.
 *
 * The function is the EXACT value that reaches `encryptField(...)` in `sign()`
 * (the service does `const safeSvg = sanitizeSignatureSvg(body.signatureSvg)`),
 * so asserting on its return value === asserting on the STORED blob.
 *
 * Mutation-proof: each vector pins both (a) the dangerous token is ABSENT from
 * the output and (b) for legit inputs the path geometry SURVIVES — a no-op
 * sanitiser (return input) fails (a); an over-eager one that drops paths fails
 * (b).
 */
import { describe, expect, it } from 'vitest';

import { sanitizeSignatureSvg } from './signature-svg-sanitizer';

/** Only <svg> and <path> element tags may appear in a sanitised output. */
function elementTags(svg: string): string[] {
  return [...svg.matchAll(/<([a-zA-Z][\w-]*)/g)].map((m) => (m[1] ?? '').toLowerCase());
}

// ── 1. Real signatures round-trip faithfully ─────────────────────────────────
describe('sanitizeSignatureSvg · real signature preserved', () => {
  it('keeps the path geometry of a normal Canvas signature (round-trip)', () => {
    const real =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100">' +
      '<path d="M10 80 C 40 10, 65 10, 95 80 S 150 150, 180 80" stroke="black" fill="none"/></svg>';
    const out = sanitizeSignatureSvg(real);
    // Geometry survives verbatim (path data has no HTML-significant chars).
    expect(out).toContain('d="M10 80 C 40 10, 65 10, 95 80 S 150 150, 180 80"');
    // viewBox preserved from the source.
    expect(out).toContain('viewBox="0 0 300 100"');
    expect(out).toContain('stroke=');
    for (const t of elementTags(out)) expect(['svg', 'path']).toContain(t);
  });

  it('preserves MULTIPLE strokes (multi-segment signature)', () => {
    const real =
      '<svg viewBox="0 0 50 50"><path d="M0 0 L1 1"/><path d="M2 2 L3 3"/></svg>';
    const out = sanitizeSignatureSvg(real);
    expect(out).toContain('d="M0 0 L1 1"');
    expect(out).toContain('d="M2 2 L3 3"');
    expect((out.match(/<path /g) ?? []).length).toBe(2);
  });

  it('is IDEMPOTENT — re-sanitising a stored blob reproduces it (no double-escape)', () => {
    const real =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 100">' +
      '<path d="M10 80 L 90 20" stroke="black" fill="none"/></svg>';
    const once = sanitizeSignatureSvg(real);
    const twice = sanitizeSignatureSvg(once);
    expect(twice).toBe(once);
  });
});

// ── 2. Active content is STRIPPED (allowlist, not blocklist) ──────────────────
describe('sanitizeSignatureSvg · active content stripped (defense-in-depth)', () => {
  const vectors: Array<{
    name: string;
    svg: string;
    keepPath?: string;
    banned: string[];
  }> = [
    {
      name: 'script element',
      svg: '<svg viewBox="0 0 10 10"><script>fetch("//evil")</script><path d="M1 1"/></svg>',
      keepPath: 'd="M1 1"',
      banned: ['<script', 'fetch', 'evil'],
    },
    {
      name: 'svg wrapper onload',
      svg: '<svg onload="steal()" viewBox="0 0 10 10"><path d="M0 1"/></svg>',
      keepPath: 'd="M0 1"',
      banned: ['onload', 'steal'],
    },
    {
      name: 'event handler on the path',
      svg: '<svg><path d="M2 2" onclick="steal()" onmouseover="x()"/></svg>',
      keepPath: 'd="M2 2"',
      banned: ['onclick', 'onmouseover', 'steal'],
    },
    {
      name: 'event handler BEFORE the d attribute',
      svg: '<svg><path onclick="evil()" d="M3 3"/></svg>',
      keepPath: 'd="M3 3"',
      banned: ['onclick', 'evil'],
    },
    {
      name: 'foreignObject + body (no path → empty)',
      svg: '<svg viewBox="0 0 10 10"><foreignObject><body>x</body></foreignObject></svg>',
      banned: ['foreignObject', '<body'],
    },
    {
      name: 'image href SSRF + xlink:href',
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
      name: 'style with expression() + url()',
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
      name: 'img onerror inside svg',
      svg: '<svg><path d="M1 2"/><img src=x onerror="alert(1)"></svg>',
      keepPath: 'd="M1 2"',
      banned: ['<img', 'onerror', 'alert(1)'],
    },
  ];

  for (const v of vectors) {
    it(`vector — ${v.name}`, () => {
      const out = sanitizeSignatureSvg(v.svg);
      for (const bad of v.banned) {
        expect(out, `banned token "${bad}" PERSISTED in stored blob`).not.toContain(bad);
      }
      if (v.keepPath) {
        expect(out, `legit geometry "${v.keepPath}" was dropped`).toContain(v.keepPath);
        expect(out).toContain('stroke=');
        for (const t of elementTags(out)) expect(['svg', 'path']).toContain(t);
      } else {
        // Pure payload → nothing drawable → empty string (sign() rejects this).
        expect(out).toBe('');
      }
    });
  }

  it('a d value with a raw " and > is clipped at the quote (no breakout)', () => {
    const out = sanitizeSignatureSvg(`<svg><path d='M7 7 " > z'/></svg>`);
    expect(out).toContain('d="M7 7 "');
    expect(out).not.toContain('> z');
    expect(out).not.toContain('"/><');
    for (const t of elementTags(out)) expect(['svg', 'path']).toContain(t);
  });

  it('d-attribute geometry carrying HTML chars is attribute-escaped', () => {
    const out = sanitizeSignatureSvg(`<svg viewBox="0 0 10 10"><path d='M0 0 <b>& onload=x'/></svg>`);
    expect(out).not.toContain('<b>');
    expect(out).toContain('&lt;b&gt;');
    expect(out).toContain('&amp;');
    expect(out).toContain('stroke=');
  });
});

// ── 3. Empty / pure-payload → empty (sign() turns this into a 400) ────────────
describe('sanitizeSignatureSvg · pure payload / empty → reject signal', () => {
  it('script-only SVG (no path) → empty string', () => {
    expect(sanitizeSignatureSvg('<svg><g><script>alert(1)</script></g></svg>')).toBe('');
  });
  it('empty input → empty string (no throw)', () => {
    expect(sanitizeSignatureSvg('')).toBe('');
  });
  it('a viewBox-only SVG with no path → empty string', () => {
    expect(sanitizeSignatureSvg('<svg viewBox="0 0 10 10"></svg>')).toBe('');
  });
});
