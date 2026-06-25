import { z } from 'zod';

// D.39 unit-type enum (apt|shop|office|mixed) is owned in ./project — the
// nested wizard write path defined it first. Re-use that ONE source here
// for the standalone apartment write boundary instead of redefining it
// (a second `export const ApartmentUnitTypeEnum` would collide under the
// `export *` barrel and drift over time). Same-package import only.
import { ApartmentUnitTypeEnum } from './project';

// Canonical Apartment contract (Doc 11 SoT; Phase 3 Slice 3).
// Entity is "apartment" (NEVER "unit"); Hebrew UI "דירה" (CLAUDE.md).
//
// Locked-schema alignment: the `apartments` table (Phase 1, Gate-2) has
// number/floor/sizeSqm/rooms/status/notes. docs/09 §3.13
// `apartment_no`/`area_sqm`/`owners_count`/`sign_status` are doc-drift /
// enrichment (owners_count needs ownerships = Slice 5, sign_status needs
// Phase-5 signatures). This schema reflects the REAL locked columns
// (PROGRESS doc-debt note). Apartments have NO org_id — tenant isolation
// is via-parent (building → project → org) by RLS inside withTenant.

/** Matches the `apartment_status` pg enum. */
export const ApartmentStatusEnum = z.enum([
  'pending',
  'contacted',
  'meeting',
  'signed',
  'refused',
  'unreachable',
]);
export type ApartmentStatus = z.infer<typeof ApartmentStatusEnum>;

export const ApartmentSchema = z.object({
  id: z.string().uuid(),
  buildingId: z.string().uuid(),
  number: z.string().min(1).max(50),
  floor: z.number().int().nullable(),
  sizeSqm: z.number().min(0).nullable(),
  rooms: z.number().min(0).nullable(),
  status: ApartmentStatusEnum,
  statusChangedAt: z.coerce.date(),
  lastContactAt: z.coerce.date().nullable(),
  notes: z.string().max(2000).nullable(),
  // V11 B.S1 added these columns at the DB layer (migration 0035, D.39).
  // They were missing from the read wire-shape until F1 was caught by
  // the smoke-discipline backfill against PR #107 (see PR #107 comment
  // /pull/107#issuecomment-4552245759 for the proof: wizard wrote
  // unit_type='shop' / area_sqm=40.00 to DB, GET endpoints returned
  // neither). FE consumers (A.S5 ProjectPage, A.S6 AddProject wizard
  // result page, A.S7 TenantPanel) require these fields.
  //
  // `unitType` is text on the wire (DB has NOT NULL DEFAULT 'apt'); the
  // closed enum (apt|shop|office|mixed) is enforced on the WRITE boundary
  // via `CreateProjectApartmentInput` in project.ts. Reads from a trusted
  // DB don't need to re-validate.
  unitType: z.string(),
  areaSqm: z.number().min(0).nullable(),
  entrance: z.string().max(40).nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  archivedAt: z.coerce.date().nullable(),
});
export type Apartment = z.infer<typeof ApartmentSchema>;

// buildingId comes from the URL, never the body. statusChangedAt is
// managed server-side (set when `status` actually changes). `.strict()`
// fail-closed (FE-security DoD).
const apartmentWriteShape = {
  number: z.string().min(1).max(50),
  floor: z.number().int().nullable().optional(),
  sizeSqm: z.number().min(0).nullable().optional(),
  rooms: z.number().min(0).nullable().optional(),
  status: ApartmentStatusEnum.optional(),
  notes: z.string().max(2000).nullable().optional(),
  // D.39 closed enum (apt|shop|office|mixed). Kept `.optional()` (NOT
  // `.default('apt')`) on purpose:
  //  - a `.default()` makes the Zod OUTPUT type non-optional while the
  //    INPUT stays optional, which splits the inferred type and breaks
  //    react-hook-form (one type for input+output) and every existing
  //    caller that omits the field;
  //  - under `.partial()` (PATCH) a default would silently reset an
  //    existing shop/office back to 'apt' on any unrelated update.
  // Backward-compat + the 'apt' fallback are enforced at the persistence
  // layer instead (apartments.service `input.unitType ?? 'apt'`), which
  // also mirrors the DB column's own NOT NULL DEFAULT 'apt'. The READ
  // `ApartmentSchema.unitType` stays `z.string()` to tolerate any legacy
  // free-text rows; this WRITE side is fail-closed to the 4 values.
  unitType: ApartmentUnitTypeEnum.optional(),
} as const;

/** POST body — `number` required (Doc 09 §3.13). `unitType` optional → 'apt'. */
export const CreateApartmentInput = z.object(apartmentWriteShape).strict();
export type CreateApartment = z.infer<typeof CreateApartmentInput>;

/** PATCH body — every field optional; omitting `unitType` leaves it as-is. */
export const UpdateApartmentInput = z.object(apartmentWriteShape).partial().strict();
export type UpdateApartment = z.infer<typeof UpdateApartmentInput>;

/**
 * GET list query — cursor pagination only (D.16; never offset).
 *
 * Additive server-side `status` filter (mirrors the NS1 `ListProjectsQuery`
 * idiom in ./project): OPTIONAL + a pure PREDICATE — when absent the endpoint
 * behaves EXACTLY as before (same rows, same keyset order). When present it is
 * ANDed into the existing WHERE (`apartments.status = $status`), so the keyset
 * cursor/order are untouched; the FE resets the cursor on a filter change. At a
 * תמ"א-38 building's real scale (100-200 apartments) this lets the manager ask
 * "which apartments are still PENDING" server-side, without paging the whole
 * building. `status` is the locked `apartment_status` enum, Zod-validated at the
 * edge (an out-of-enum value → 400, never a silent match-all).
 */
export const ListApartmentsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
  status: ApartmentStatusEnum.optional(),
});
export type ListApartmentsQueryDto = z.infer<typeof ListApartmentsQuery>;
