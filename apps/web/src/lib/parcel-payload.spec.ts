/**
 * P3c FE — parcel-setup BUILDER payload seam: PRE-SCOPING contract.
 *
 * INDEPENDENT acceptance test, authored from the SPEC before the builder
 * (docs/DESIGN-phase3-parcel-autosetup.md §3 flow + §6 P3c + §7.1-2
 * "ask, no silent heuristic").
 *
 * WHY a pure-logic test (repo convention): this package ships NO
 * `@testing-library/react` — every web `*.spec.ts` is pure-logic only and the
 * rendered flow is covered by the Playwright e2e
 * (apps/web/e2e/p3c-parcel-setup.spec.ts). What IS cleanly unit-testable —
 * and what carries the slice's load-bearing security contract — is the PURE
 * function that maps the builder-screen form rows to the EXACT strict
 * server payload (`ParcelSetupPayload`, packages/shared-types/src/
 * parcel-setup.ts). The jsonb column it lands in is a PUBLIC RECORD (no
 * pgcrypto), so the client must be structurally incapable of sending any key
 * beyond the strict shape — `buildings:[{address,city?,number?,floorsCount?,
 * apartments:[{number,floor?}]}]`, nothing else possible.
 *
 * BUILDER CONTRACT — implement and EXPORT from `apps/web/src/lib/
 * parcel-payload.ts` (a NEW lib seam; the builder component imports it):
 *
 *   export type ParcelApartmentDraft = { number: string; floor?: number };
 *   export type ParcelFormRow = {
 *     address: string;                       // required (trimmed)
 *     city?: string;                         // ''/whitespace → OMITTED key
 *     number?: string;                       // ''/whitespace → OMITTED key
 *     floorsCount?: number;                  // absent → OMITTED key
 *     // EXACTLY ONE of the next two — the user's explicit decision
 *     // (§7.1-2: NO silent default like קומות×4):
 *     generate?: { floors: number; perFloor: number };
 *     apartments?: ParcelApartmentDraft[];
 *   };
 *   export type BuildParcelPayloadError =
 *     | 'no_rows'                 // rows array empty (index -1)
 *     | 'address_required'        // blank/whitespace address
 *     | 'no_apartments_decision'  // NEITHER generate NOR apartments
 *     | 'ambiguous_apartments'    // BOTH generate AND apartments
 *     | 'invalid_generator'       // floors/perFloor not integers >= 1
 *     | 'too_many_apartments'     // floors*perFloor > 1000 (server cap)
 *     | 'empty_apartments'        // explicit mode with 0 rows
 *     | 'apartment_number_required'; // explicit apartment with blank number
 *   export type BuildParcelPayloadResult =
 *     | { ok: true; payload: ParcelSetupPayloadDto }
 *     | { ok: false; errors: Array<{ index: number; code: BuildParcelPayloadError }> };
 *   export function buildParcelPayload(rows: ParcelFormRow[]): BuildParcelPayloadResult;
 *   export function parcelSummary(payload: ParcelSetupPayloadDto): string;
 *
 * PINNED NUMBERING SCHEME (the קומות×דירות-לקומה generator):
 *   N = floors × perFloor apartments; numbers are the SEQUENTIAL STRINGS
 *   '1'..'N' (continuous across floors — they do NOT reset per floor);
 *   floor(i) = ceil(i / perFloor), i = 1..N (1-based).
 *   e.g. 3 floors × 2/floor → [('1',1),('2',1),('3',2),('4',2),('5',3),('6',3)].
 *
 * PINNED SUMMARY PHRASING (the e2e asserts the SAME string on screen):
 *   parcelSummary → `ייווצרו {B} בניינים ו-{A} דירות`
 *   (deterministic — no singular/plural inflection; B/A are plain integers).
 *
 * RED today: `./parcel-payload` does not exist → the import fails and every
 * assertion below errors. GREEN once the builder adds the seam.
 */
import { ParcelSetupPayload, UpdateParcelSetupPayloadInput } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import { buildParcelPayload, parcelSummary } from './parcel-payload';

type Rows = Parameters<typeof buildParcelPayload>[0];
type Result = ReturnType<typeof buildParcelPayload>;

function expectOk(res: Result): Extract<Result, { ok: true }> {
  expect(res.ok, `expected ok result, got ${JSON.stringify(res)}`).toBe(true);
  if (!res.ok) throw new Error('unreachable');
  return res;
}

function expectErr(res: Result): Extract<Result, { ok: false }> {
  expect(res.ok, 'expected error result, got ok').toBe(false);
  if (res.ok) throw new Error('unreachable');
  return res;
}

describe('P3c — buildParcelPayload: the קומות×דירות generator (pinned numbering)', () => {
  it('G1) 3 floors × 2/floor → apartments "1".."6", floor = ceil(i/2)', () => {
    const res = expectOk(
      buildParcelPayload([
        { address: 'הרצל 10', city: 'תל אביב', generate: { floors: 3, perFloor: 2 } },
      ]),
    );
    expect(res.payload).toEqual({
      buildings: [
        {
          address: 'הרצל 10',
          city: 'תל אביב',
          apartments: [
            { number: '1', floor: 1 },
            { number: '2', floor: 1 },
            { number: '3', floor: 2 },
            { number: '4', floor: 2 },
            { number: '5', floor: 3 },
            { number: '6', floor: 3 },
          ],
        },
      ],
    });
  });

  it('G2) 1 floor × 3/floor → "1","2","3" all on floor 1 (the e2e walk shape)', () => {
    const res = expectOk(
      buildParcelPayload([
        { address: 'הרצל 10', city: 'תל אביב', generate: { floors: 1, perFloor: 3 } },
      ]),
    );
    const building = res.payload.buildings[0];
    expect(building?.apartments).toEqual([
      { number: '1', floor: 1 },
      { number: '2', floor: 1 },
      { number: '3', floor: 1 },
    ]);
  });

  it('G3) numbering is CONTINUOUS across floors (2×3 → "4" opens floor 2; never resets)', () => {
    const res = expectOk(
      buildParcelPayload([{ address: 'א', generate: { floors: 2, perFloor: 3 } }]),
    );
    const apts: Array<{ number: string; floor?: number }> =
      res.payload.buildings[0]?.apartments ?? [];
    expect(apts.map((a) => a.number)).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(apts.map((a) => a.floor)).toEqual([1, 1, 1, 2, 2, 2]);
  });

  it('G4) generated numbers are STRINGS (the server schema requires z.string())', () => {
    const res = expectOk(
      buildParcelPayload([{ address: 'א', generate: { floors: 1, perFloor: 1 } }]),
    );
    const first = res.payload.buildings[0]?.apartments[0];
    expect(typeof first?.number).toBe('string');
    expect(typeof first?.floor).toBe('number');
  });
});

describe('P3c — buildParcelPayload: STRICT server-shape mirror (no-PII defense)', () => {
  it('S1) Object.keys are EXACTLY the strict shape at every level — full row', () => {
    const res = expectOk(
      buildParcelPayload([
        {
          address: 'הרצל 10',
          city: 'תל אביב',
          number: '10א',
          floorsCount: 3,
          generate: { floors: 3, perFloor: 2 },
        },
      ]),
    );
    expect(Object.keys(res.payload).sort()).toEqual(['buildings']);
    const building = res.payload.buildings[0];
    if (!building) throw new Error('expected one building');
    expect(Object.keys(building).sort()).toEqual([
      'address',
      'apartments',
      'city',
      'floorsCount',
      'number',
    ]);
    for (const apt of building.apartments) {
      expect(Object.keys(apt).sort()).toEqual(['floor', 'number']);
    }
  });

  it('S2) optional fields left blank are OMITTED keys (never ""/undefined values)', () => {
    const res = expectOk(
      buildParcelPayload([
        { address: 'הרצל 10', city: '', number: '   ', generate: { floors: 1, perFloor: 2 } },
      ]),
    );
    const building = res.payload.buildings[0];
    if (!building) throw new Error('expected one building');
    // city ''/number whitespace → the keys must NOT exist at all (a present
    // key with '' would fail the server's z.string().min(1) strict parse).
    expect(Object.keys(building).sort()).toEqual(['address', 'apartments']);
  });

  it('S3) the result parses the REAL server schemas: ParcelSetupPayload + the PATCH body', () => {
    const res = expectOk(
      buildParcelPayload([
        { address: 'הרצל 10', city: 'תל אביב', generate: { floors: 2, perFloor: 2 } },
        { address: 'הרצל 12', apartments: [{ number: '1' }, { number: '2', floor: 1 }] },
      ]),
    );
    // Strict parse — throws on ANY extra key. This is the wire mirror.
    expect(() => ParcelSetupPayload.parse(res.payload)).not.toThrow();
    expect(() => UpdateParcelSetupPayloadInput.parse({ payload: res.payload })).not.toThrow();
  });

  it('S4) ADVERSARIAL — PII-ish keys riding on a row are NEVER forwarded (fresh objects, no spread)', () => {
    const dirty = [
      {
        address: 'הרצל 10',
        generate: { floors: 1, perFloor: 1 },
        // Hostile extras a buggy form-state spread could carry. The payload
        // column is a PUBLIC RECORD — these must be structurally impossible.
        ownerName: 'דנה כהן',
        nationalId: '012345678',
        phone: '0501234567',
      },
    ] as unknown as Rows;
    const res = expectOk(buildParcelPayload(dirty));
    const json = JSON.stringify(res.payload);
    expect(json).not.toContain('ownerName');
    expect(json).not.toContain('nationalId');
    expect(json).not.toContain('phone');
    expect(json).not.toContain('012345678');
    // And the strict server parse stays green (no unknown key survived).
    expect(() => ParcelSetupPayload.parse(res.payload)).not.toThrow();
  });

  it('S5) explicit apartments pass through EXACTLY — floor omitted stays omitted', () => {
    const res = expectOk(
      buildParcelPayload([
        { address: 'א', apartments: [{ number: '7' }, { number: '8', floor: 2 }] },
      ]),
    );
    const apts = res.payload.buildings[0]?.apartments ?? [];
    expect(apts).toEqual([{ number: '7' }, { number: '8', floor: 2 }]);
    expect(Object.keys(apts[0] ?? {}).sort()).toEqual(['number']);
    expect(Object.keys(apts[1] ?? {}).sort()).toEqual(['floor', 'number']);
  });

  it('S6) address/city are trimmed (server max/min are on the trimmed value)', () => {
    const res = expectOk(
      buildParcelPayload([
        { address: '  הרצל 10  ', city: ' תל אביב ', generate: { floors: 1, perFloor: 1 } },
      ]),
    );
    expect(res.payload.buildings[0]?.address).toBe('הרצל 10');
    expect(res.payload.buildings[0]?.city).toBe('תל אביב');
  });
});

describe('P3c — buildParcelPayload: rejection paths (§7.1-2 — ask, NO silent heuristic)', () => {
  it('E1) empty rows → no_rows (nothing to confirm)', () => {
    const res = expectErr(buildParcelPayload([]));
    expect(res.errors).toEqual([{ index: -1, code: 'no_rows' }]);
  });

  it('E2) blank/whitespace address → address_required with the row index', () => {
    const res = expectErr(
      buildParcelPayload([
        { address: 'הרצל 10', generate: { floors: 1, perFloor: 1 } },
        { address: '   ', generate: { floors: 1, perFloor: 1 } },
      ]),
    );
    expect(res.errors).toContainEqual({ index: 1, code: 'address_required' });
  });

  it('E3) THE §7.1-2 PIN — neither generator nor explicit apartments → no_apartments_decision (NEVER a silent default)', () => {
    // The design decision (§7.1-2): the user DECIDES apartments — either
    // קומות×דירות-לקומה or one-by-one. A row with no decision is an ERROR,
    // not a heuristic (no "floors×4", no empty-apartments building).
    const res = expectErr(buildParcelPayload([{ address: 'הרצל 10', floorsCount: 4 }]));
    expect(res.errors).toEqual([{ index: 0, code: 'no_apartments_decision' }]);
  });

  it('E4) BOTH generator AND explicit apartments → ambiguous_apartments (one decision only)', () => {
    const res = expectErr(
      buildParcelPayload([
        { address: 'א', generate: { floors: 1, perFloor: 2 }, apartments: [{ number: '1' }] },
      ]),
    );
    expect(res.errors).toEqual([{ index: 0, code: 'ambiguous_apartments' }]);
  });

  it('E5) generator with floors/perFloor < 1 or non-integers → invalid_generator', () => {
    for (const generate of [
      { floors: 0, perFloor: 2 },
      { floors: 2, perFloor: 0 },
      { floors: -1, perFloor: 2 },
      { floors: 1.5, perFloor: 2 },
      { floors: 2, perFloor: 2.5 },
    ]) {
      const res = expectErr(buildParcelPayload([{ address: 'א', generate }]));
      expect(res.errors, `generate=${JSON.stringify(generate)}`).toEqual([
        { index: 0, code: 'invalid_generator' },
      ]);
    }
  });

  it('E6) generator product over the server cap (1000/building) → too_many_apartments', () => {
    const res = expectErr(
      buildParcelPayload([{ address: 'א', generate: { floors: 200, perFloor: 6 } }]),
    );
    expect(res.errors).toEqual([{ index: 0, code: 'too_many_apartments' }]);
    // Boundary: exactly 1000 is allowed (the server max).
    const ok = expectOk(
      buildParcelPayload([{ address: 'א', generate: { floors: 200, perFloor: 5 } }]),
    );
    expect(ok.payload.buildings[0]?.apartments).toHaveLength(1000);
    expect(() => ParcelSetupPayload.parse(ok.payload)).not.toThrow();
  });

  it('E7) explicit mode with an EMPTY list → empty_apartments (an empty decision is no decision)', () => {
    const res = expectErr(buildParcelPayload([{ address: 'א', apartments: [] }]));
    expect(res.errors).toEqual([{ index: 0, code: 'empty_apartments' }]);
  });

  it('E8) explicit apartment with a blank number → apartment_number_required', () => {
    const res = expectErr(buildParcelPayload([{ address: 'א', apartments: [{ number: '  ' }] }]));
    expect(res.errors).toEqual([{ index: 0, code: 'apartment_number_required' }]);
  });

  it('E9) multiple bad rows → every error reported with its OWN index; no payload', () => {
    const res = expectErr(
      buildParcelPayload([
        { address: '', generate: { floors: 1, perFloor: 1 } },
        { address: 'ב' }, // no decision
        { address: 'ג', generate: { floors: 1, perFloor: 2 } }, // valid
      ]),
    );
    const codesByIndex = new Map(
      res.errors.map((e: { index: number; code: string }) => [e.index, e.code]),
    );
    expect(codesByIndex.get(0)).toBe('address_required');
    expect(codesByIndex.get(1)).toBe('no_apartments_decision');
    expect(codesByIndex.has(2)).toBe(false);
  });
});

describe('P3c — parcelSummary (pinned phrasing; the e2e asserts the same string on screen)', () => {
  it('SUM1) 2 buildings · 5 apartments → "ייווצרו 2 בניינים ו-5 דירות"', () => {
    const res = expectOk(
      buildParcelPayload([
        { address: 'א', generate: { floors: 2, perFloor: 2 } },
        { address: 'ב', apartments: [{ number: '1' }] },
      ]),
    );
    expect(parcelSummary(res.payload)).toBe('ייווצרו 2 בניינים ו-5 דירות');
  });

  it('SUM2) 1 building · 3 apartments → "ייווצרו 1 בניינים ו-3 דירות" (deterministic — no inflection)', () => {
    const res = expectOk(
      buildParcelPayload([
        { address: 'הרצל 10', city: 'תל אביב', generate: { floors: 1, perFloor: 3 } },
      ]),
    );
    expect(parcelSummary(res.payload)).toBe('ייווצרו 1 בניינים ו-3 דירות');
  });

  it('SUM3) counts come from the PAYLOAD (mixed generator + explicit rows)', () => {
    const res = expectOk(
      buildParcelPayload([
        { address: 'א', generate: { floors: 3, perFloor: 4 } }, // 12
        { address: 'ב', apartments: [{ number: '1' }, { number: '2' }] }, // 2
        { address: 'ג', generate: { floors: 1, perFloor: 1 } }, // 1
      ]),
    );
    expect(parcelSummary(res.payload)).toBe('ייווצרו 3 בניינים ו-15 דירות');
  });
});
