import { z } from 'zod';

// Canonical ProjectAssignment contract (Doc 11 SoT; Phase 3 Slice 9).
//
// project_assignments is the M:N agent↔project link that powers D.17
// Agent scoping (every domain slice JOINs it). Slice 9 makes it
// MANAGEABLE (assign/list/unassign) so Agent scoping is actually usable
// end-to-end — required by the docs/03 §7 Done list. via-parent
// isolation (project → org) by RLS. Lifecycle = unassignedAt (active ⇔
// unassignedAt IS NULL); unique(projectId,userId) WHERE active.

export const ProjectAssignmentSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  userId: z.string().uuid(),
  roleInProject: z.string().min(1).max(50),
  assignedAt: z.coerce.date(),
  unassignedAt: z.coerce.date().nullable(),
});
export type ProjectAssignment = z.infer<typeof ProjectAssignmentSchema>;

/** POST body — assign an org member to the project. */
export const CreateProjectAssignmentInput = z
  .object({
    userId: z.string().uuid(),
    roleInProject: z.string().min(1).max(50).optional(),
  })
  .strict();
export type CreateProjectAssignment = z.infer<typeof CreateProjectAssignmentInput>;

export const ListProjectAssignmentsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});
export type ListProjectAssignmentsQueryDto = z.infer<typeof ListProjectAssignmentsQuery>;
