import { z } from 'zod';

// Canonical Building contract (Doc 11 SoT; Phase 3 Slice 2).
//
// Locked-schema alignment: the `buildings` table (Phase 1, Gate-2) has
// columns address/city/block/parcel/subparcel/aptCount/notes. The docs/09
// §3.13 `label`/`floors` fields are doc-drift (no such columns) — this
// schema reflects the REAL locked columns (PROGRESS doc-debt note).
// Buildings have NO org_id: tenant isolation is enforced "via-parent"
// (project → org) by RLS inside withTenant.

export const BuildingSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  address: z.string().min(1).max(500),
  city: z.string().min(1).max(100),
  block: z.string().max(50).nullable(),
  parcel: z.string().max(50).nullable(),
  subparcel: z.string().max(50).nullable(),
  aptCount: z.number().int().min(0),
  notes: z.string().max(2000).nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  archivedAt: z.coerce.date().nullable(),
});
export type Building = z.infer<typeof BuildingSchema>;

// projectId comes from the URL (/projects/:projectId/buildings), never the
// body. `.strict()` is fail-closed (FE-security DoD).
const buildingWriteShape = {
  address: z.string().min(1).max(500),
  city: z.string().min(1).max(100),
  block: z.string().max(50).nullable().optional(),
  parcel: z.string().max(50).nullable().optional(),
  subparcel: z.string().max(50).nullable().optional(),
  aptCount: z.number().int().min(0).optional(),
  notes: z.string().max(2000).nullable().optional(),
} as const;

/** POST body — address + city required (Doc 09 §3.13). */
export const CreateBuildingInput = z.object(buildingWriteShape).strict();
export type CreateBuilding = z.infer<typeof CreateBuildingInput>;

/** PATCH body — every field optional. */
export const UpdateBuildingInput = z.object(buildingWriteShape).partial().strict();
export type UpdateBuilding = z.infer<typeof UpdateBuildingInput>;

/** GET list query — cursor pagination only (D.16; never offset). */
export const ListBuildingsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});
export type ListBuildingsQueryDto = z.infer<typeof ListBuildingsQuery>;
