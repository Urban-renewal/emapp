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

/**
 * Default owner-CONSENT threshold (%) per urban-renewal track — the legal
 * majority each track requires. This is what makes `type` FUNCTIONAL (not just a
 * label): a project's `targetSignaturePct` defaults to this from its type at
 * create time, and a manager may override it per project.
 *
 * Values reflect the POST-2023 statute. The 2023 Arrangements Law
 * (חוק ההסדרים תשפ"ג) harmonised the special-majority thresholds for the
 * demolish-rebuild tracks DOWN from 80% to two-thirds (~66%), aligning them
 * with the strengthening track:
 *  - tama38_1 (חיזוק / strengthening): 66% (two-thirds) — unchanged.
 *  - tama38_2 (הריסה ובנייה / demolition-rebuild): 66% — lowered from 80% by the
 *    2023 amendment to חוק החיזוק (in force 1 Jul 2023; pre-existing 80%
 *    agreements grandfather the old regime).
 *  - pinui_binui (evacuation-rebuild): 66% — lowered from 80% by the 2023
 *    amendment to חוק פינוי ובינוי (two-thirds of the owners + a majority of
 *    the attached common property).
 *
 * These are the legal GATE (compel-holdouts / proceed) thresholds and the
 * default signature-collection target; a manager may override per project, and
 * 100% execution-signing is a separate, later milestone. NOTE FOR LEGAL: sources
 * vary between 66% and 67% for "two-thirds" post-2023 — confirm the exact value
 * to store; either is a major correction from the pre-2023 80%.
 */
export const PROJECT_TYPE_DEFAULT_CONSENT_PCT: Record<ProjectType, number> = {
  tama38_1: 66,
  tama38_2: 66,
  pinui_binui: 66,
};

/**
 * Owner-approved (Gate-6, Option A) — a single intermediate signature target.
 * Beyond the legal consent gate (`targetSignaturePct`), a project may carry an
 * ORDERED list of these to track signature-collection progress in stages
 * (e.g. 25% → 50% → 66%). Per-PROJECT, not per-building. `.strict()` is
 * fail-closed: unknown fields are rejected at the boundary (mass-assignment
 * defence; mirrors the rest of the project write shapes).
 */
export const SignatureMilestoneSchema = z
  .object({
    pct: z.number().int().min(1).max(100),
    label: z.string().max(80).optional(),
  })
  .strict();
export type SignatureMilestone = z.infer<typeof SignatureMilestoneSchema>;

/**
 * The full ordered milestone list for a project (max 10). Enforces, beyond the
 * per-row schema:
 *  - strictly ASCENDING `pct` (also guarantees uniqueness);
 *  - every `pct <= targetSignaturePct` WHEN a target is supplied alongside the
 *    list — the staged overlay must never exceed the legal gate.
 *
 * The `targetSignaturePct` cross-check can only run when the target is in the
 * SAME object being parsed (the create/update body), so it is applied by the
 * project-level refinement below — not here, where the array stands alone.
 * This bare validator still enforces ascending + unique + max-10 so it can be
 * unit-tested and reused independently.
 */
export const SignatureMilestonesSchema = z
  .array(SignatureMilestoneSchema)
  .max(10)
  .superRefine((milestones, ctx) => {
    for (let i = 1; i < milestones.length; i += 1) {
      const prev = milestones[i - 1];
      const cur = milestones[i];
      // Defensive narrowing for noUncheckedIndexedAccess — both indices are
      // in-bounds by the loop condition, so this never actually throws.
      if (prev === undefined || cur === undefined) continue;
      if (cur.pct <= prev.pct) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'signature_milestones_must_be_strictly_ascending',
          path: [i, 'pct'],
        });
      }
    }
  });
export type SignatureMilestones = z.infer<typeof SignatureMilestonesSchema>;

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
  // Owner-approved staged overlay (Gate-6, Option A). Nullable: the column is
  // additive jsonb with no default, so pre-feature rows read back as null. Also
  // tolerant of OMISSION (write-response shape / a BE that drops null keys) —
  // normalised to null so consumers always get `null | SignatureMilestone[]`.
  signatureMilestones: SignatureMilestonesSchema.nullish().transform((v) => v ?? null),
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
  // Owner-approved staged overlay (Gate-6, Option A) — optional + nullable so a
  // create/update can set, clear (null), or omit it. The cross-field rule
  // "every pct <= targetSignaturePct" is enforced by `refineMilestonesVsTarget`
  // on the assembled body below (it needs both fields in scope).
  signatureMilestones: SignatureMilestonesSchema.nullable().optional(),
  startedAt: z.coerce.date().nullable().optional(),
} as const;

/**
 * Cross-field guard shared by the create + update bodies: when BOTH a milestone
 * list and a `targetSignaturePct` are present, every milestone `pct` must be
 * `<= targetSignaturePct` — the staged overlay can never exceed the legal gate.
 * When `targetSignaturePct` is absent/null the BE later defaults it from the
 * project type, but at the boundary we only have what the client sent, so we
 * only cross-check against an explicitly-supplied target.
 */
function refineMilestonesVsTarget(
  body: { signatureMilestones?: SignatureMilestone[] | null; targetSignaturePct?: number | null },
  ctx: z.RefinementCtx,
): void {
  const { signatureMilestones, targetSignaturePct } = body;
  if (!signatureMilestones || targetSignaturePct === undefined || targetSignaturePct === null) {
    return;
  }
  signatureMilestones.forEach((m, i) => {
    if (m.pct > targetSignaturePct) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'signature_milestone_exceeds_target',
        path: ['signatureMilestones', i, 'pct'],
      });
    }
  });
}

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
  .strict()
  .superRefine(refineMilestonesVsTarget);
export type CreateProject = z.infer<typeof CreateProjectInput>;

/** PATCH body — every project-level field optional. The wizard-only nested
 *  `buildings` is NOT updatable here (use the dedicated buildings/apartments
 *  endpoints); excluding it keeps PATCH bounded and avoids ambiguous semantics
 *  (replace vs merge of nested arrays). */
export const UpdateProjectInput = z
  .object(projectWriteShape)
  .partial()
  .strict()
  .superRefine(refineMilestonesVsTarget);
export type UpdateProject = z.infer<typeof UpdateProjectInput>;

/** GET list query — cursor pagination only (D.16; never offset). */
export const ListProjectsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});
export type ListProjectsQueryDto = z.infer<typeof ListProjectsQuery>;
