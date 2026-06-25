/**
 * D.39 apartment unit-type WRITE-boundary contract suite (fast, no DB).
 *
 * Independent TEST-AUTHOR suite — does NOT trust the builder. Pins the
 * closed `unitType` enum (apt|shop|office|mixed) on BOTH write DTOs:
 *
 *   - CreateApartmentInput  (POST body, `number` required)
 *   - UpdateApartmentInput  (PATCH body, every field optional)
 *
 * Load-bearing mutation proof (the reason this file exists):
 *   • Each of the 4 valid members is ACCEPTED.
 *   • An out-of-enum value ('penthouse') is REJECTED with a ZodError whose
 *     issue is an `invalid_enum_value` on the `unitType` path — this FAILS
 *     if the field is widened to `z.string()` (a string would accept
 *     'penthouse'), which is exactly the regression we guard.
 *   • Omission is ACCEPTED (the field is `.optional()`, persistence layer
 *     supplies the 'apt' fallback — NOT a Zod default here, on purpose).
 *   • `.strict()` still rejects unknown keys (fail-closed FE-security DoD).
 *
 * Concrete leaf assertions only; no tautologies.
 */
import { describe, expect, it } from 'vitest';

import { CreateApartmentInput, ListApartmentsQuery, UpdateApartmentInput } from './apartment';

const VALID_UNIT_TYPES = ['apt', 'shop', 'office', 'mixed'] as const;

// A minimal valid CREATE body (number is the only required field).
const baseCreate = { number: '12' };

describe('D.39 unitType WRITE contract — CreateApartmentInput', () => {
  it('ACCEPTS each of the 4 valid unit types and round-trips the value', () => {
    for (const u of VALID_UNIT_TYPES) {
      const r = CreateApartmentInput.safeParse({ ...baseCreate, unitType: u });
      expect(r.success, `valid unitType '${u}' was rejected`).toBe(true);
      // The parsed output must carry the EXACT value (not coerced/dropped).
      if (r.success) expect(r.data.unitType).toBe(u);
    }
  });

  it('REJECTS an out-of-enum value with a ZodError on the unitType path (MUTATION GUARD vs z.string())', () => {
    const r = CreateApartmentInput.safeParse({ ...baseCreate, unitType: 'penthouse' });
    expect(r.success, "'penthouse' was accepted — enum widened to z.string()?").toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.join('.') === 'unitType');
      expect(issue, 'no ZodError issue scoped to the unitType path').toBeDefined();
      expect(issue?.code).toBe('invalid_enum_value');
    }
  });

  it('REJECTS other non-member values too (empty string, near-miss, wrong case, number)', () => {
    for (const bad of ['', 'Apt', 'APT', 'residential', 'apt ', 'flat', 1 as unknown]) {
      const r = CreateApartmentInput.safeParse({ ...baseCreate, unitType: bad });
      expect(r.success, `non-member unitType ${JSON.stringify(bad)} was accepted`).toBe(false);
    }
  });

  it('ACCEPTS omission of unitType (optional — persistence supplies the apt fallback)', () => {
    const r = CreateApartmentInput.safeParse({ ...baseCreate });
    expect(r.success).toBe(true);
    if (r.success) {
      // Optional with NO Zod default → omitted stays undefined on the DTO; the
      // 'apt' fallback is the service/DB-column concern, NOT the schema's.
      expect(r.data.unitType).toBeUndefined();
    }
  });

  it('.strict() rejects unknown keys (fail-closed)', () => {
    const r = CreateApartmentInput.safeParse({ ...baseCreate, unitType: 'shop', injected: true });
    expect(r.success, 'unknown key not rejected — .strict() lost').toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    }
  });
});

describe('D.39 unitType WRITE contract — UpdateApartmentInput (PATCH, all optional)', () => {
  it('ACCEPTS each of the 4 valid unit types on a unitType-only PATCH', () => {
    for (const u of VALID_UNIT_TYPES) {
      const r = UpdateApartmentInput.safeParse({ unitType: u });
      expect(r.success, `valid unitType '${u}' was rejected on PATCH`).toBe(true);
      if (r.success) expect(r.data.unitType).toBe(u);
    }
  });

  it('REJECTS an out-of-enum value with a ZodError on the unitType path (MUTATION GUARD vs z.string())', () => {
    const r = UpdateApartmentInput.safeParse({ unitType: 'penthouse' });
    expect(r.success, "'penthouse' accepted on PATCH — enum widened?").toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.join('.') === 'unitType');
      expect(issue?.code).toBe('invalid_enum_value');
    }
  });

  it('ACCEPTS an empty PATCH and a PATCH omitting unitType (optional → undefined, left as-is)', () => {
    const empty = UpdateApartmentInput.safeParse({});
    expect(empty.success).toBe(true);

    const otherFieldOnly = UpdateApartmentInput.safeParse({ status: 'contacted' });
    expect(otherFieldOnly.success).toBe(true);
    if (otherFieldOnly.success) {
      // unitType MUST stay undefined so the service's `!== undefined` no-op
      // guard leaves the existing column value untouched.
      expect(otherFieldOnly.data.unitType).toBeUndefined();
    }
  });

  it('.strict() rejects unknown keys on PATCH', () => {
    const r = UpdateApartmentInput.safeParse({ unitType: 'office', bogus: 1 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    }
  });
});

describe('ListApartmentsQuery — additive status filter (keyset list query)', () => {
  it('is OPTIONAL — an empty query parses, default limit applied, status undefined', () => {
    const r = ListApartmentsQuery.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.limit).toBe(25);
      expect(r.data.status).toBeUndefined();
    }
  });

  it('ACCEPTS each of the 6 apartment_status values and round-trips it', () => {
    for (const s of ['pending', 'contacted', 'meeting', 'signed', 'refused', 'unreachable']) {
      const r = ListApartmentsQuery.safeParse({ status: s });
      expect(r.success, `valid status '${s}' was rejected`).toBe(true);
      if (r.success) expect(r.data.status).toBe(s);
    }
  });

  it('REJECTS an out-of-enum status (no silent match-all; → validation error at the edge)', () => {
    const r = ListApartmentsQuery.safeParse({ status: 'sold' });
    expect(r.success, "'sold' was accepted — status widened to z.string()?").toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.join('.') === 'status');
      expect(issue?.code).toBe('invalid_enum_value');
    }
  });

  it('coerces limit + keeps cursor alongside the status filter', () => {
    const r = ListApartmentsQuery.safeParse({ limit: '10', cursor: 'abc', status: 'pending' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.limit).toBe(10);
      expect(r.data.cursor).toBe('abc');
      expect(r.data.status).toBe('pending');
    }
  });
});
