/**
 * D.37 / Phase 6.5 — AccessReason header parsing unit tests.
 *
 * The decorator is the FIRST defense between the public HTTP surface
 * and `withProvider`. If this layer accepts a bad value, withProvider's
 * own validation (defense-in-depth, also tested in
 * `packages/db/test/with-provider-d37-audit.spec.ts`) catches it — but
 * with a 500 instead of a 400. We want clean 400s for invalid headers,
 * so EVERY input-validation branch needs a unit test.
 *
 * The decorator delegates to `parseAccessReasonHeader` (exported plain
 * function); we test that directly — `createParamDecorator`'s factory
 * is not callable as a function (it returns a decorator), so testing
 * it requires a real Nest controller fixture. The plain-function
 * pattern keeps the test pure: no Nest, no Fastify, no I/O.
 */
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { parseAccessReasonHeader } from './access-reason.decorator';

describe('parseAccessReasonHeader (P6.5-1 hardening)', () => {
  it('U1) valid reason → returns the trimmed cleaned value', () => {
    expect(parseAccessReasonHeader('investigating ticket #42')).toBe('investigating ticket #42');
  });

  it('U2) missing header (undefined) → 400 reason_required', () => {
    expect(() => parseAccessReasonHeader(undefined)).toThrow(BadRequestException);
    try {
      parseAccessReasonHeader(undefined);
    } catch (e) {
      const resp = (e as BadRequestException).getResponse() as { error?: { code?: string } };
      expect(resp.error?.code).toBe('reason_required');
    }
  });

  it('U3) empty string header → 400 reason_required', () => {
    expect(() => parseAccessReasonHeader('')).toThrow(BadRequestException);
  });

  it('U4) whitespace-only header → 400 (cleans to "")', () => {
    expect(() => parseAccessReasonHeader('   ')).toThrow(BadRequestException);
  });

  it('U5a) shorter than 5 chars (1 char) after strip → 400', () => {
    expect(() => parseAccessReasonHeader('a')).toThrow(BadRequestException);
  });

  it('U5b) shorter than 5 chars (4 chars) after strip → 400', () => {
    expect(() => parseAccessReasonHeader('abcd')).toThrow(BadRequestException);
  });

  it('U6) longer than 512 chars → 400', () => {
    expect(() => parseAccessReasonHeader('a'.repeat(513))).toThrow(BadRequestException);
  });

  it('U7) CRLF injection attempt — strips control chars, returns clean value', () => {
    // CC-2 closure raised MIN_LEN 5 → 10 and added quality rules (≥3
    // tokens, ≥4 distinct chars, or ticket-prefix). Use a substantive
    // reason that survives the strip AND passes the quality bar.
    const out = parseAccessReasonHeader('INC-1234\r\n investigating tenant failure');
    expect(out).toBe('INC-1234 investigating tenant failure');
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\r\n]/);
  });

  it('U8) null-byte injection — stripped', () => {
    const out = parseAccessReasonHeader('INC-1234\0 investigating tenant failure');
    expect(out).toBe('INC-1234 investigating tenant failure');
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/\x00/);
  });

  it('U9) all control chars → strips to empty → 400 reason_required', () => {
    expect(() => parseAccessReasonHeader('\r\n\r\n\r\n\t\t\t')).toThrow(BadRequestException);
  });

  it('U10) array (duplicate header) → 400 — refuse ambiguity rather than guess', () => {
    expect(() => parseAccessReasonHeader(['first reason value', 'second reason value'])).toThrow(
      BadRequestException,
    );
  });

  it('U11) Hebrew reason accepted — UTF-8 round-trip', () => {
    const reason = 'בדיקת תקלה — צריך לאמת PII של בעל ת.ז. 1234';
    expect(parseAccessReasonHeader(reason)).toBe(reason);
  });

  it('U12) ticket-prefix short reason (boundary) — accepted (CC-2)', () => {
    // Post-CC-2: a recognised ticket reference bypasses the MIN_LEN
    // floor. "INC-1234" (8 chars) is shorter than MIN_LEN=10 yet
    // accepted because it carries forensic-traceable meaning on its
    // own.
    expect(parseAccessReasonHeader('INC-1234')).toBe('INC-1234');
  });

  it('U13) exactly 512 chars (boundary) — accepted when substantive', () => {
    // Substantive content (≥3 tokens, ≥4 distinct chars) at length 512.
    const reason = ('investigating tenant ' + 'INC-1234 ').repeat(20).slice(0, 512);
    expect(parseAccessReasonHeader(reason).length).toBe(512);
  });

  // ─────────────────────────────────────────────────────────────────
  // Percent-decode regression (fix/provider-access-reason-decode).
  //
  // The FE (`apps/web/src/lib/api/provider.ts` `withReason`) percent-
  // encodes any non-ASCII reason because `fetch` `Headers` reject code
  // points > 0xFF (ByteString constraint). The BE MUST decodeURIComponent
  // the header BEFORE validating/auditing — otherwise a Hebrew reason
  // arrives as one "%20"-joined token and is wrongly rejected as
  // `reason_low_quality`, breaking every provider page for a Hebrew-UI
  // operator. ASCII reasons are sent verbatim (decode is a no-op) except
  // a literal '%' which throws → fall back to the raw value.
  // ─────────────────────────────────────────────────────────────────

  it('U15) encoded-Hebrew reason → returns the DECODED Hebrew text (THE BUG REPRO)', () => {
    // This is the load-bearing, mutation-proof test. If the
    // `decodeURIComponent` step is removed from parseAccessReasonHeader,
    // the encoded blob arrives as a single "%XX"-joined token and the
    // assertions below fail (either a throw on reason_low_quality, or a
    // returned value that is NOT the decoded Hebrew).
    const reason = 'בדיקת לקוח — חקירת תקלה מקיפה';
    const encoded = encodeURIComponent(reason);
    // Sanity: the wire value really is percent-encoded (non-vacuous) —
    // every Hebrew char + the em-dash is > 0x7F, so encoding inserts '%'.
    expect(encoded).toContain('%');
    expect(encoded).not.toBe(reason);

    const out = parseAccessReasonHeader(encoded);
    // The decoded, human-readable text is what gets validated + audited.
    expect(out).toBe(reason);
    // And it is NOT the %-encoded blob (guards against "decode removed").
    expect(out).not.toBe(encoded);
    expect(out).not.toContain('%');
  });

  it('U16) the audited value is the decoded human-readable text, not the %-blob', () => {
    // The return value of parseAccessReasonHeader IS what lands on the
    // provider_audit_log row (via withProvider). A %-encoded blob there
    // would make the audit forensically useless for a Hebrew operator.
    const reason = 'חקירת תקלת התחברות של דייר ספציפי';
    const out = parseAccessReasonHeader(encodeURIComponent(reason));
    expect(out).toBe(reason);
  });

  it('U17) plain ASCII reason → returned verbatim, decode is a no-op', () => {
    const reason = 'investigating ticket #4729 timeout';
    expect(parseAccessReasonHeader(reason)).toBe(reason);
  });

  it('U18) raw ASCII reason with a literal "%" (not valid %-encoding) → no throw, validates (fallback)', () => {
    // "checking 50% cpu spike now": "50%" is NOT valid percent-encoding,
    // so decodeURIComponent throws URIError. The decorator must catch and
    // fall back to the raw value, then validate it normally (≥3 tokens,
    // ≥4 distinct chars, ≥20 chars) — NOT crash with a 500.
    const reason = 'checking 50% cpu spike now';
    expect(() => parseAccessReasonHeader(reason)).not.toThrow();
    expect(parseAccessReasonHeader(reason)).toBe(reason);
  });

  it('U19) undefined still → 400 reason_required (decode did not turn undefined into "undefined")', () => {
    // Guard the decode wiring: a naive `decodeURIComponent(String(raw))`
    // would turn undefined into the literal string "undefined" (valid-ish
    // and 9 chars) and mask the missing-header error. Must still reject.
    expect(() => parseAccessReasonHeader(undefined)).toThrow(BadRequestException);
    try {
      parseAccessReasonHeader(undefined);
    } catch (e) {
      const resp = (e as BadRequestException).getResponse() as { error?: { code?: string } };
      expect(resp.error?.code).toBe('reason_required');
    }
  });

  it('U20) duplicate header (string[]) still → 400 reason_required (decode did not break array guard)', () => {
    expect(() =>
      parseAccessReasonHeader([
        encodeURIComponent('בדיקה ראשונה מפורטת'),
        encodeURIComponent('בדיקה שנייה מפורטת'),
      ]),
    ).toThrow(BadRequestException);
    try {
      parseAccessReasonHeader(['first reason value here', 'second reason value here']);
    } catch (e) {
      const resp = (e as BadRequestException).getResponse() as { error?: { code?: string } };
      expect(resp.error?.code).toBe('reason_required');
    }
  });

  it('U14) error code is STABLE across all rejection paths (FE switches on code, not message)', () => {
    // FE error handling pattern (D.16): switch on error.code, never
    // on error.message. Post-CC-2 the stable code set is:
    //   - reason_required   (missing / empty / too short / array)
    //   - reason_too_long   (> MAX_LEN)
    //   - reason_low_quality (passes length floor but fails quality)
    const stableCodes = new Set(['reason_required', 'reason_too_long', 'reason_low_quality']);
    const samples: Array<string | string[] | undefined> = [
      undefined,
      '',
      '   ',
      'a',
      'aaaaa',
      'aaaa bbbb cccc', // 3 tokens but only 3 distinct chars
      'a'.repeat(513),
      '\r\n\r\n\r\n',
      ['x', 'y'],
    ];
    for (const s of samples) {
      try {
        parseAccessReasonHeader(s);
        throw new Error(`expected throw for ${JSON.stringify(s)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(BadRequestException);
        const resp = (e as BadRequestException).getResponse() as { error?: { code?: string } };
        expect(stableCodes.has(resp.error?.code ?? '')).toBe(true);
      }
    }
  });
});
