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

/** POST body — `name` + `type` required (Doc 09 §3.10). */
export const CreateProjectInput = z.object(projectWriteShape).strict();
export type CreateProject = z.infer<typeof CreateProjectInput>;

/** PATCH body — every field optional (Doc 09 §3.11). */
export const UpdateProjectInput = z.object(projectWriteShape).partial().strict();
export type UpdateProject = z.infer<typeof UpdateProjectInput>;

/** GET list query — cursor pagination only (D.16; never offset). */
export const ListProjectsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});
export type ListProjectsQueryDto = z.infer<typeof ListProjectsQuery>;
