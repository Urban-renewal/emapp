/**
 * Pure-unit tests for the Provider `access_reason` sanitiser —
 * specifically the bidi-control HARDENING (fix/provider-access-reason-decode,
 * HIGH-2 in the security review).
 *
 * Threat model: a provider operator (or an attacker who controls the
 * `access_reason` header value) embeds a Unicode bidi override —
 * U+202E (RIGHT-TO-LEFT OVERRIDE) and friends — in the audit reason.
 * The marks arrive percent-encoded, survive the decorator's
 * `decodeURIComponent`, and then VISUALLY SPOOF the rendered audit row:
 * an investigator reading the provider_audit_log sees reversed /
 * disguised text and draws the wrong conclusion. The fix adds the bidi
 * ranges (U+202A-202E, U+2066-2069) to `PROVIDER_STRIP_RANGES` so the
 * marks are stripped BEFORE the reason is validated + audited.
 *
 * These tests import the module DIRECTLY (not via the `@emapp/db`
 * barrel) so the suite stays pure — no pool, no `pg`, no DB. Run with:
 *   pnpm --filter @emapp/db exec vitest run --config vitest.pure.config.ts \
 *     src/helpers/provider-validators.spec.ts
 *
 * RULE (root CLAUDE.md + this branch): NEVER place a literal invisible
 * bidi char in source. Every override mark is built via
 * `String.fromCodePoint(...)` at runtime.
 */
import { describe, expect, it } from 'vitest';

import { PROVIDER_CONTROL_CHARS_REGEX, validateProviderReason } from './provider-validators';

// Built at runtime — NEVER a literal invisible char in source.
const RLO = String.fromCodePoint(0x202e); // RIGHT-TO-LEFT OVERRIDE
const LRO = String.fromCodePoint(0x202d); // LEFT-TO-RIGHT OVERRIDE
const RLI = String.fromCodePoint(0x2067); // RIGHT-TO-LEFT ISOLATE (U+2066-2069 range)

describe('validateProviderReason — bidi-override hardening (HIGH-2)', () => {
  it('B1) ACCEPTS a substantive reason carrying an embedded RTL override, but STRIPS the U+202E mark', () => {
    // A real, substantive reason (≥20 chars, ≥3 tokens, ≥4 distinct
    // chars) with an RTL-override spliced into the middle — the classic
    // audit-spoof payload.
    const raw = 'investigating tenant ' + RLO + 'signup failure now';

    // Non-vacuous precondition: the override mark really IS present on
    // the input (otherwise the strip assertion below would pass trivially).
    expect(raw).toContain(RLO);
    expect(raw.codePointAt(raw.indexOf(RLO))).toBe(0x202e);

    const result = validateProviderReason(raw);

    // Accepted — stripping the mark leaves substantive text.
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The load-bearing assertion: the U+202E codepoint is ABSENT from
      // the audited value. If the bidi range is removed from
      // PROVIDER_STRIP_RANGES, the mark survives here and this fails.
      expect(result.value).not.toContain(RLO);
      expect([...result.value].some((ch) => ch.codePointAt(0) === 0x202e)).toBe(false);
      // And the visible text is otherwise intact (no over-stripping of
      // the surrounding ASCII).
      expect(result.value).toBe('investigating tenant signup failure now');
    }
  });

  it('B2) strips the OTHER bidi marks too — LRO (U+202D) and an isolate (U+2067)', () => {
    const raw = 'manual onboarding ' + LRO + 'for customer Acme ' + RLI + 'per phone request';
    // Non-vacuous: both marks present on input.
    expect(raw).toContain(LRO);
    expect(raw).toContain(RLI);

    const result = validateProviderReason(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const codepoints = [...result.value].map((ch) => ch.codePointAt(0));
      expect(codepoints).not.toContain(0x202d);
      expect(codepoints).not.toContain(0x2067);
    }
  });

  it('B3) a normal Hebrew reason is PRESERVED intact — no over-stripping of legitimate RTL text', () => {
    // Hebrew letters live in U+05D0-U+05EA — WELL OUTSIDE the stripped
    // bidi-control ranges. A genuine Hebrew operator reason must survive
    // byte-for-byte (the whole point of the decode fix is to keep Hebrew
    // audit reasons readable).
    const hebrew = 'בדיקת תקלה של דייר מסוים בדחיפות';

    // Sanity: this reason contains NO control / bidi marks to begin with
    // (so B3 proves preservation, not accidental strip-then-restore).
    expect(PROVIDER_CONTROL_CHARS_REGEX.test(hebrew)).toBe(false);

    const result = validateProviderReason(hebrew);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(hebrew);
    }
  });

  it('B4) MUTATION-PROOF anchor: the strip regex matches U+202E (and the standard control range)', () => {
    // This pins the regex contract independently of validateProviderReason.
    // If the bidi range is removed from PROVIDER_STRIP_RANGES, this fails
    // even if the quality rules happen to mask the effect in B1.
    // (RegExp has the `g` flag — reset lastIndex between .test() calls.)
    PROVIDER_CONTROL_CHARS_REGEX.lastIndex = 0;
    expect(PROVIDER_CONTROL_CHARS_REGEX.test(RLO)).toBe(true);
    PROVIDER_CONTROL_CHARS_REGEX.lastIndex = 0;
    expect(PROVIDER_CONTROL_CHARS_REGEX.test(RLI)).toBe(true);
    PROVIDER_CONTROL_CHARS_REGEX.lastIndex = 0;
    expect(PROVIDER_CONTROL_CHARS_REGEX.test(String.fromCodePoint(0x00))).toBe(true);
    // Negative control: a normal Hebrew letter is NOT stripped.
    PROVIDER_CONTROL_CHARS_REGEX.lastIndex = 0;
    expect(PROVIDER_CONTROL_CHARS_REGEX.test(String.fromCodePoint(0x05d0))).toBe(false);
  });

  it('B5) an all-bidi-marks reason strips to empty → reason_required (no spoof slips through as valid)', () => {
    const raw = RLO + LRO + RLI + RLO;
    const result = validateProviderReason(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('reason_required');
    }
  });
});
