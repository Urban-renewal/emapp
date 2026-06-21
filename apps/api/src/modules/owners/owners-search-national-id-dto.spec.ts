/**
 * NS2 (MASTER-PLAN-V13 Wave B) — PURE-UNIT coverage for the national_id lookup
 * DETECTION + DTO shaping (no DB; runs in the default `pnpm test` lane).
 *
 * Detection decision (documented): the national_id lookup branch is keyed off
 * the EXPLICIT `national_id` field on the existing `OwnerSearchDto` (the POST
 * /owners/search body) — NOT a heuristic "the query looks like a 9-digit ID".
 * Rationale: the field is already structurally validated (9 digits) AND
 * semantically validated (Israeli MOD-10 checksum, via the BE DTO refine), so a
 * malformed ID fails at the API boundary as a D.16 validation_error before any
 * PII gate or HMAC runs — and there is zero ambiguity between "search by ID" and
 * "search by phone" (a separate field). A sniffing heuristic would conflate the
 * two and could misfire on a 9-digit phone fragment.
 *
 * These assertions pin the boundary contract the service relies on:
 *  - a well-formed national_id parses (→ the PII branch is reachable),
 *  - a wrong-length / non-numeric / bad-checksum national_id is REJECTED at the
 *    DTO (→ the PII branch is never reached with junk),
 *  - phone-only and national_id-only inputs are both valid (the two branches are
 *    independent fields),
 *  - the empty body is rejected (the existing OWN3b contract).
 */
import { describe, expect, it } from 'vitest';

import { OwnerSearchDto } from './owner.dto';

// A real Israeli-ID-checksum-valid 9-digit ID (MOD-10). '123456782' passes Luhn.
const VALID_NID = '123456782';

describe('NS2 — OwnerSearchDto (national_id lookup detection boundary)', () => {
  it('accepts a well-formed, checksum-valid national_id (PII branch reachable)', () => {
    const r = OwnerSearchDto.safeParse({ national_id: VALID_NID });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.national_id).toBe(VALID_NID);
  });

  it('REJECTS a national_id that is not exactly 9 digits (structural)', () => {
    expect(OwnerSearchDto.safeParse({ national_id: '12345' }).success).toBe(false);
    expect(OwnerSearchDto.safeParse({ national_id: '1234567890' }).success).toBe(false);
    expect(OwnerSearchDto.safeParse({ national_id: '12345678a' }).success).toBe(false);
  });

  it('REJECTS a 9-digit national_id that fails the Israeli MOD-10 checksum (semantic)', () => {
    // 9 digits, wrong checksum → blocked at the DTO refine, never reaches the gate.
    const r = OwnerSearchDto.safeParse({ national_id: '123456789' });
    expect(r.success).toBe(false);
  });

  it('accepts a national_id-ONLY body and a phone-ONLY body (independent branches)', () => {
    expect(OwnerSearchDto.safeParse({ national_id: VALID_NID }).success).toBe(true);
    expect(OwnerSearchDto.safeParse({ phone: '0541112233' }).success).toBe(true);
  });

  it('REJECTS an empty body (neither field) — OWN3b contract', () => {
    expect(OwnerSearchDto.safeParse({}).success).toBe(false);
  });

  it('REJECTS unknown keys (strict) — no smuggled fields into the PII path', () => {
    const r = OwnerSearchDto.safeParse({ national_id: VALID_NID, injected: true });
    expect(r.success).toBe(false);
  });
});
