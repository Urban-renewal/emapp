/**
 * AUDIT v1.1 — CC-2: access_reason quality is a checkbox.
 *
 * **Cross-confirmed by Security agents #1 (SEC-S7) + #2 (SEC-M1).**
 * **Severity: HIGH (ISO 27001 A.9.4.1 — reviewability of access decisions).**
 *
 * Current behaviour: 5-char minimum, 512-char maximum, control-char
 * strip. `"aaaaa"` passes today. ISO 27001 A.9.4.1 expects the field
 * to be **reviewable** by an auditor — "aaaaa" defeats that.
 *
 * Closure:
 *   Require a ticket-id pattern (e.g. `^(INC|REQ|SUP|TKT)-\d{4,}: .{10,}$`)
 *   OR free text with ≥20 chars and ≥3 whitespace-separated tokens.
 *
 * Ref: AUDIT-V1-1-PHASE6.5-FINDINGS.md §1 CC-2.
 */
import { describe, expect, it } from 'vitest';

import { parseAccessReasonHeader } from './access-reason.decorator';

describe('AUDIT v1.1 / CC-2 — access_reason quality (HIGH, ISO A.9.4.1)', () => {
  // ── Tests pinning the CURRENT (weak) behaviour ─────────────────────
  // These demonstrate what is accepted today. Each `it` shows a reason
  // string that an auditor would reject but the decorator accepts.

  // The decorator throws BadRequestException on rejection; "pass"
  // means it returns the cleaned string without throwing.
  it('CURRENT-STATE: "aaaaa" passes (5 identical chars — review-noise)', () => {
    expect(parseAccessReasonHeader('aaaaa')).toBe('aaaaa');
  });

  it('CURRENT-STATE: "test1" passes (no ticket reference, no real reason)', () => {
    expect(parseAccessReasonHeader('test1')).toBe('test1');
  });

  it('CURRENT-STATE: "....." passes (5 dots, zero information)', () => {
    expect(parseAccessReasonHeader('.....')).toBe('.....');
  });

  it('CURRENT-STATE: "12345" passes (5 digits, no ticket pattern)', () => {
    expect(parseAccessReasonHeader('12345')).toBe('12345');
  });

  // ── Tests for the CORRECTED behaviour (to enable after fix) ────────
  // Remove `.todo` once CC-2 closure lands.

  it.todo('POST-FIX: "aaaaa" is rejected (quality floor: distinct-character entropy)');
  it.todo('POST-FIX: "INC-1234: investigating tenant signup failure" is accepted');
  it.todo('POST-FIX: "supporting customer X with import error per ticket SUP-9912" is accepted');
  it.todo('POST-FIX: weekly ops report query "low-quality reasons last 7 days" returns row count');
});
