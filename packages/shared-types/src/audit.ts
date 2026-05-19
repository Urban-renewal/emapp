import { z } from 'zod';

// Canonical Audit-Read contract (Doc 11 SoT; Phase 3 Slice 8).
//
// APPEND-ONLY: there is NO create/update/delete endpoint — audit_log is
// written only by the internal AuditService inside domain transactions.
// Manager-facing read exposes WHO did WHAT to WHICH target WHEN. The
// before/after diffs, ip and user_agent are intentionally NOT exposed in
// the org Manager view (they can carry sensitive context); a future
// Provider-Admin cross-tenant view may surface more (recorded). Org RLS
// scopes rows to the caller's org.

export const AuditActorTypeEnum = z.enum(['user', 'system', 'provider']);
export type AuditActorType = z.infer<typeof AuditActorTypeEnum>;

export const AuditEntrySchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  actorId: z.string().uuid().nullable(),
  actorType: AuditActorTypeEnum,
  actorEmail: z.string().nullable(),
  action: z.string(),
  targetTable: z.string().nullable(),
  targetId: z.string().uuid().nullable(),
  createdAt: z.coerce.date(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const ListAuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
});
export type ListAuditQueryDto = z.infer<typeof ListAuditQuery>;
