/**
 * P4 #10 — ADVERSARIAL spec for the CSP `frame-src` directive added for the
 * resident /sign inline document preview.
 *
 * #10 embeds the document being signed in an <iframe> over a token-scoped
 * presigned R2 GET. Without `frame-src` the iframe falls back to
 * `default-src 'self'` and the browser SILENTLY blocks the R2 origin — the
 * preview never renders. The fix adds `CSP_FRAME_SRC` = the R2 host ONLY.
 *
 * middleware.spec.ts M10b already asserts `CSP_FRAME_SRC` appears in the
 * assembled header and contains the R2 host. THIS spec is the negative/
 * containment surface: frame-src must NOT be widened to `*`, must NOT add any
 * NEW origin beyond the R2 host already trusted in connect-src, and must keep
 * `frame-ancestors 'none'` (we embed others; nobody embeds US — clickjacking
 * defense). These are the assertions that catch a too-permissive widening.
 */
import { describe, expect, it } from 'vitest';

import { buildCspHeader, CSP_CONNECT_SRC, CSP_FRAME_SRC } from './csp';

const R2_HOST = 'https://*.r2.cloudflarestorage.com';

/** Parse the `frame-src` directive token list out of an assembled CSP header. */
function frameSrcTokens(csp: string): string[] {
  const directive = csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith('frame-src '));
  if (!directive) return [];
  return directive
    .replace(/^frame-src\s+/, '')
    .split(/\s+/)
    .filter(Boolean);
}

describe('§P4-#10 / CSP frame-src — exact, minimal, contained', () => {
  it('1) CSP_FRAME_SRC is exactly `self` + the R2 host — no more, no less', () => {
    expect(CSP_FRAME_SRC).toBe("frame-src 'self' https://*.r2.cloudflarestorage.com");
  });

  it('2) frame-src tokens are precisely { self, R2 } — no widening to * or extra origins', () => {
    const csp = buildCspHeader('NONCE', false);
    const tokens = frameSrcTokens(csp);
    expect(tokens).toEqual(["'self'", R2_HOST]);
  });

  it('3) frame-src must NEVER contain a bare wildcard `*` (would allow ANY framed origin)', () => {
    const csp = buildCspHeader('NONCE', false);
    const tokens = frameSrcTokens(csp);
    expect(tokens).not.toContain('*');
    // Also no scheme-only wildcards that effectively open the surface.
    expect(tokens).not.toContain('https:');
    expect(tokens).not.toContain('http:');
    expect(tokens).not.toContain('data:');
    expect(tokens).not.toContain("'unsafe-inline'");
  });

  it('4) the ONLY non-self origin in frame-src is the R2 host already trusted in connect-src', () => {
    // No NEW trust surface: the frame host must be a host already present in
    // connect-src (the presigned upload/download allowance). This is the
    // "adds no new origin" invariant the builder claimed.
    const frameOrigins = frameSrcTokens(buildCspHeader('NONCE', false)).filter(
      (t) => t !== "'self'",
    );
    expect(frameOrigins).toEqual([R2_HOST]);
    expect(CSP_CONNECT_SRC).toContain(R2_HOST);
  });

  it('5) R2 host is scoped to the cloudflarestorage.com suffix (not an open wildcard origin)', () => {
    // `https://*.r2.cloudflarestorage.com` wildcards ONLY the sub-label; it
    // cannot match an attacker domain. Guard against a regression to
    // `https://*` or `https://*.com`.
    expect(R2_HOST).toMatch(/^https:\/\/\*\.r2\.cloudflarestorage\.com$/);
    const frameOrigins = frameSrcTokens(buildCspHeader('NONCE', false)).filter(
      (t) => t !== "'self'",
    );
    for (const o of frameOrigins) {
      expect(o).toMatch(/\.cloudflarestorage\.com$/);
      expect(o).not.toMatch(/^https:\/\/\*$/);
      expect(o).not.toMatch(/^https:\/\/\*\.com$/);
    }
  });

  it("6) clickjacking defense intact — frame-ancestors stays 'none' (we frame R2; nobody frames us)", () => {
    // Adding frame-src (what WE may embed) must not relax frame-ancestors
    // (who may embed US). They are orthogonal directives; a careless edit
    // could conflate them.
    const csp = buildCspHeader('NONCE', false);
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('7) frame-src is present in BOTH dev and prod headers (preview must render in dev too)', () => {
    for (const isDev of [true, false]) {
      const csp = buildCspHeader('NONCE', isDev);
      expect(frameSrcTokens(csp), `isDev=${isDev}`).toEqual(["'self'", R2_HOST]);
    }
  });
});
