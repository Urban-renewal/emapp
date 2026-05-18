import { z } from 'zod';

// Canonical Note contract (Doc 11 SoT; Phase 3 Slice 8). Org-scoped
// (notes.org_id → direct RLS). Optionally attached to a project or
// apartment. Locked column `is_pinned` is text — exposed as a boolean
// `pinned` in the contract (stored 'true' | null).

export const NoteSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  projectId: z.string().uuid().nullable(),
  apartmentId: z.string().uuid().nullable(),
  body: z.string().min(1).max(5000),
  pinned: z.boolean(),
  createdBy: z.string().uuid(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  archivedAt: z.coerce.date().nullable(),
});
export type Note = z.infer<typeof NoteSchema>;

export const CreateNoteInput = z
  .object({
    body: z.string().min(1).max(5000),
    projectId: z.string().uuid().nullable().optional(),
    apartmentId: z.string().uuid().nullable().optional(),
    pinned: z.boolean().optional(),
  })
  .strict();
export type CreateNote = z.infer<typeof CreateNoteInput>;

export const UpdateNoteInput = z
  .object({ body: z.string().min(1).max(5000).optional(), pinned: z.boolean().optional() })
  .strict();
export type UpdateNote = z.infer<typeof UpdateNoteInput>;

export const ListNotesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});
export type ListNotesQueryDto = z.infer<typeof ListNotesQuery>;
