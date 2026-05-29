import { z } from 'zod';

// Canonical Project contract (Doc 11 source of truth; Phase 3 Slice 1).
// FE/BE both import this. Pure Zod — no @emapp/* imports (no circular deps).
//
// NOTE (locked-schema alignment): the `projects` table (Phase 1, Gate-2
// locked) has NO address/city/metadata columns — address/city live on
// `buildings`. The docs/06 §4.3 "(template)" and docs/09 §3.8 enriched
// list (stats/contractor/last_activity_at) are doc-drift / later
// enrichment (stats depend on Phase 5 signatures). This schema reflects
// the REAL locked columns; no schema deviation (PROGRESS / doc-debt).

/** Project type (urban-renewal track). Matches `project_type` pg enum. */
export const ProjectTypeEnum = z.enum(['tama38_1', 'tama38_2', 'pinui_binui']);
export type ProjectType = z.infer<typeof ProjectTypeEnum>;

/** D.18 (LAW): locked project status set. Matches `project_status` pg enum. */
export const ProjectStatusEnum = z.enum([
  'planning',
  'gathering_signatures',
  'approved',
  'in_construction',
  'completed',
  'cancelled',
]);
export type ProjectStatus = z.infer<typeof ProjectStatusEnum>;

/** Full project resource — exactly what the API returns on read (D.16 `data`). */
export const ProjectSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  name: z.string().min(1).max(200),
  type: ProjectTypeEnum,
  status: ProjectStatusEnum,
  description: z.string().max(2000).nullable(),
  targetSignaturePct: z.number().min(0).max(100).nullable(),
  startedAt: z.coerce.date().nullable(),
  createdBy: z.string().uuid(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  archivedAt: z.coerce.date().nullable(),
});
export type Project = z.infer<typeof ProjectSchema>;

/**
 * Aggregate counts attached to project list/detail rows so the dashboard
 * cards can show real numbers instead of "—" placeholders. Resolves the
 * "stats depend on Phase 5 signatures" doc-debt noted above.
 *
 * Computed server-side via correlated subqueries — single round-trip per
 * row, each subquery backed by an index. All counts are >= 0.
 */
export const ProjectStatsSchema = z.object({
  buildingsCount: z.number().int().nonnegative(),
  unitsCount: z.number().int().nonnegative(),
  signaturesPendingCount: z.number().int().nonnegative(),
  signaturesSignedCount: z.number().int().nonnegative(),
  agentsCount: z.number().int().nonnegative(),
});
export type ProjectStats = z.infer<typeof ProjectStatsSchema>;

export const ProjectListItemSchema = ProjectSchema.merge(ProjectStatsSchema);
export type ProjectListItem = z.infer<typeof ProjectListItemSchema>;

/**
 * Org-wide aggregates for the home dashboard KPI cards. Returned by
 * `GET /api/v1/org/stats`. Distinct from project-level stats above.
 */
export const OrgStatsSchema = z.object({
  activeProjects: z.number().int().nonnegative(),
  residents: z.number().int().nonnegative(),
  signaturesReceived: z.number().int().nonnegative(),
  signaturesPending: z.number().int().nonnegative(),
});
export type OrgStats = z.infer<typeof OrgStatsSchema>;

// Write shape: only client-supplied columns. org/createdBy/timestamps are
// injected server-side from the JWT, never from the body. `.strict()` is
// fail-closed (FE-security DoD): unknown fields are rejected, not ignored.
const projectWriteShape = {
  name: z.string().min(1).max(200),
  type: ProjectTypeEnum,
  status: ProjectStatusEnum.optional(),
  description: z.string().max(2000).nullable().optional(),
  targetSignaturePct: z.number().min(0).max(100).nullable().optional(),
  startedAt: z.coerce.date().nullable().optional(),
} as const;

// ──────────────────────────────────────────────────────────────────────
// V11 B.S2 — nested write shapes used by the AddProjectModal 3-step
// wizard (D.39). The wizard sends ONE atomic request that creates the
// project plus its initial building/section/apartment structure; the
// BE expands it inside a single withTenant tx so partial state is
// impossible (Track A.S6 consumer).
//
// All sub-objects `.strict()` — unknown fields rejected at the boundary
// (mass-assignment defence; mirrors the parent CreateProjectInput
// posture). Bounded array lengths cap the request shape (anti-bomb).
// ──────────────────────────────────────────────────────────────────────

/** D.39 closed enum — `building_sections.kind`. */
export const SectionKindEnum = z.enum(['residential', 'office', 'retail', 'mixed']);
export type SectionKind = z.infer<typeof SectionKindEnum>;

/** D.39 closed enum — `apartments.unit_type`. */
export const ApartmentUnitTypeEnum = z.enum(['apt', 'shop', 'office', 'mixed']);
export type ApartmentUnitType = z.infer<typeof ApartmentUnitTypeEnum>;

/** Nested section spec inside CreateProjectInput. */
export const CreateProjectSectionInput = z
  .object({
    entrance: z.string().max(40).nullable().optional(),
    kind: SectionKindEnum,
    floors: z.number().int().min(0).max(200).nullable().optional(),
    unitCount: z.number().int().min(0).max(2000).nullable().optional(),
    gush: z.string().max(40).nullable().optional(),
    helka: z.string().max(40).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();
export type CreateProjectSection = z.infer<typeof CreateProjectSectionInput>;

/** Nested apartment spec inside CreateProjectInput. */
export const CreateProjectApartmentInput = z
  .object({
    number: z.string().min(1).max(40),
    floor: z.number().int().min(-5).max(200).nullable().optional(),
    sizeSqm: z.number().min(0).max(10000).nullable().optional(),
    areaSqm: z.number().min(0).max(10000).nullable().optional(),
    rooms: z.number().min(0).max(50).nullable().optional(),
    unitType: ApartmentUnitTypeEnum.optional(),
    entrance: z.string().max(40).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();
export type CreateProjectApartment = z.infer<typeof CreateProjectApartmentInput>;

/** Nested building spec inside CreateProjectInput. Note: `aptCount` is
 *  intentionally NOT in this shape — the column is maintained by a
 *  per-row trigger (`trg_apartments_count_maintenance`, migration 0002)
 *  that increments/decrements on apartment insert/archive/delete.
 *  Letting clients write it would corrupt the invariant. */
export const CreateProjectBuildingInput = z
  .object({
    address: z.string().min(1).max(200),
    city: z.string().min(1).max(120),
    block: z.string().max(40).nullable().optional(),
    parcel: z.string().max(40).nullable().optional(),
    subparcel: z.string().max(40).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    sections: z.array(CreateProjectSectionInput).max(20).optional(),
    apartments: z.array(CreateProjectApartmentInput).max(500).optional(),
  })
  .strict();
export type CreateProjectBuilding = z.infer<typeof CreateProjectBuildingInput>;

/** POST body — `name` + `type` required; optional nested wizard structure. */
export const CreateProjectInput = z
  .object({
    ...projectWriteShape,
    buildings: z.array(CreateProjectBuildingInput).max(20).optional(),
  })
  .strict();
export type CreateProject = z.infer<typeof CreateProjectInput>;

/** PATCH body — every project-level field optional. The wizard-only nested
 *  `buildings` is NOT updatable here (use the dedicated buildings/apartments
 *  endpoints); excluding it keeps PATCH bounded and avoids ambiguous semantics
 *  (replace vs merge of nested arrays). */
export const UpdateProjectInput = z.object(projectWriteShape).partial().strict();
export type UpdateProject = z.infer<typeof UpdateProjectInput>;

/** GET list query — cursor pagination only (D.16; never offset). */
export const ListProjectsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});
export type ListProjectsQueryDto = z.infer<typeof ListProjectsQuery>;
