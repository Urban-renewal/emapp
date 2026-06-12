/**
 * P3c — parcel-setup BUILDER payload seam (pure logic).
 *
 * Maps the builder-screen form rows to the EXACT strict server payload
 * (`ParcelSetupPayload`, packages/shared-types/src/parcel-setup.ts). The
 * jsonb column the payload lands in is a PUBLIC RECORD (no pgcrypto), so the
 * client must be structurally incapable of sending any key beyond the strict
 * shape — every object below is built FRESH, key-by-key (never spread from
 * form state), so adversarial extras (ownerName / nationalId / phone) can
 * never ride along.
 *
 * §7.1-2 "ask, no silent heuristic": apartments come from EXACTLY ONE
 * explicit user decision per building — the קומות×דירות-לקומה generator OR
 * an explicit apartment list. A row with neither (or both) is an ERROR, not
 * a default. `floorsCount` alone is a draft-only HINT, never a decision.
 *
 * Contract pinned by apps/web/src/lib/parcel-payload.spec.ts (independent
 * acceptance test — do not change shapes/codes/phrasing without it).
 */
import type { ParcelSetupPayloadDto } from '@emapp/shared-types';

export type ParcelApartmentDraft = { number: string; floor?: number };

export type ParcelFormRow = {
  /** Required (trimmed before validation/emission). */
  address: string;
  /** ''/whitespace → the key is OMITTED from the payload. */
  city?: string;
  /** ''/whitespace → the key is OMITTED from the payload. */
  number?: string;
  /** Absent → the key is OMITTED (draft-only hint; not a decision). */
  floorsCount?: number;
  // EXACTLY ONE of the next two — the user's explicit decision (§7.1-2):
  generate?: { floors: number; perFloor: number };
  apartments?: ParcelApartmentDraft[];
};

export type BuildParcelPayloadError =
  | 'no_rows'
  | 'address_required'
  | 'no_apartments_decision'
  | 'ambiguous_apartments'
  | 'invalid_generator'
  | 'too_many_apartments'
  | 'empty_apartments'
  | 'apartment_number_required';

export type BuildParcelPayloadResult =
  | { ok: true; payload: ParcelSetupPayloadDto }
  | { ok: false; errors: Array<{ index: number; code: BuildParcelPayloadError }> };

/** Server cap — ParcelSetupPayload `.max(1000)` apartments per building. */
const MAX_APARTMENTS_PER_BUILDING = 1000;

type PayloadBuilding = ParcelSetupPayloadDto['buildings'][number];
type PayloadApartment = PayloadBuilding['apartments'][number];

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Build the strict PATCH payload from the builder rows, or report every
 * invalid row with its own index. Fresh objects at every level — the no-PII
 * structural defense (spec S1/S4).
 */
export function buildParcelPayload(rows: ParcelFormRow[]): BuildParcelPayloadResult {
  if (rows.length === 0) {
    return { ok: false, errors: [{ index: -1, code: 'no_rows' }] };
  }

  const errors: Array<{ index: number; code: BuildParcelPayloadError }> = [];
  const buildings: PayloadBuilding[] = [];

  rows.forEach((row, index) => {
    let rowOk = true;
    const address = trimmed(row.address);
    if (address === '') {
      errors.push({ index, code: 'address_required' });
      rowOk = false;
    }

    const hasGenerator = row.generate !== undefined && row.generate !== null;
    const hasExplicit = Array.isArray(row.apartments);
    const apartments: PayloadApartment[] = [];

    if (!hasGenerator && !hasExplicit) {
      // §7.1-2 — floorsCount alone is NOT a decision; never a silent default.
      errors.push({ index, code: 'no_apartments_decision' });
      rowOk = false;
    } else if (hasGenerator && hasExplicit) {
      errors.push({ index, code: 'ambiguous_apartments' });
      rowOk = false;
    } else if (hasGenerator) {
      const { floors, perFloor } = row.generate as { floors: number; perFloor: number };
      if (!Number.isInteger(floors) || !Number.isInteger(perFloor) || floors < 1 || perFloor < 1) {
        errors.push({ index, code: 'invalid_generator' });
        rowOk = false;
      } else if (floors * perFloor > MAX_APARTMENTS_PER_BUILDING) {
        errors.push({ index, code: 'too_many_apartments' });
        rowOk = false;
      } else {
        // Pinned numbering: sequential strings '1'..'N' CONTINUOUS across
        // floors; floor(i) = ceil(i / perFloor), 1-based.
        const total = floors * perFloor;
        for (let i = 1; i <= total; i += 1) {
          apartments.push({ number: String(i), floor: Math.ceil(i / perFloor) });
        }
      }
    } else {
      const drafts = row.apartments as ParcelApartmentDraft[];
      if (drafts.length === 0) {
        errors.push({ index, code: 'empty_apartments' });
        rowOk = false;
      } else {
        for (const draft of drafts) {
          const number = trimmed(draft.number);
          if (number === '') {
            errors.push({ index, code: 'apartment_number_required' });
            rowOk = false;
            break;
          }
        }
        if (rowOk) {
          for (const draft of drafts) {
            // Fresh object; `floor` key only when actually provided (an
            // explicit `floor: undefined` would still be an own key).
            const apt: PayloadApartment = { number: trimmed(draft.number) };
            if (typeof draft.floor === 'number') apt.floor = draft.floor;
            apartments.push(apt);
          }
        }
      }
    }

    if (!rowOk) return;

    const building: PayloadBuilding = { address, apartments };
    const city = trimmed(row.city);
    if (city !== '') building.city = city;
    const number = trimmed(row.number);
    if (number !== '') building.number = number;
    if (typeof row.floorsCount === 'number' && Number.isInteger(row.floorsCount)) {
      building.floorsCount = row.floorsCount;
    }
    buildings.push(building);
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, payload: { buildings } };
}

/**
 * Pinned summary phrasing — the e2e asserts the SAME string on screen.
 * Deterministic (no singular/plural inflection); B/A are plain integers.
 */
export function parcelSummary(payload: ParcelSetupPayloadDto): string {
  const buildingsCount = payload.buildings.length;
  const apartmentsCount = payload.buildings.reduce(
    (sum, building) => sum + building.apartments.length,
    0,
  );
  return `ייווצרו ${buildingsCount} בניינים ו-${apartmentsCount} דירות`;
}
