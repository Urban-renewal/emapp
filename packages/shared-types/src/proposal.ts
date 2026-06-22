import { z } from 'zod';

// Autonomous Master Plan, Phase 1 — the Approval-Inbox `proposals` contract
// (Doc 11 SoT). One row per autonomous DRAFT awaiting a human's one-click
// confirm. The FE inbox (a LATER slice) renders `ProposalView`s; this slice
// ships the BE read + approve/reject.
//
// VOICE LAW (owner-mandated): user-facing strings frame work as the USER's
// pending decision ("ממתין להחלטתך"), NEVER system-hero ("טיפלתי"). The wire
// shape is neutral data; the FE composes the calm copy from it. No PII is ever
// carried in `evidence` (ids/counts/timestamps only — the PII-free contract).

/** Lifecycle states. `pending` is the only actionable one. Mirrors the DB CHECK
 *  (migration 0080) and the schema `PROPOSAL_STATUSES`. */
export const ProposalStatusEnum = z.enum(['pending', 'approved', 'rejected', 'expired', 'applied']);
export type ProposalStatus = z.infer<typeof ProposalStatusEnum>;

/** Manager-side wire shape. `evidence` is the snapshot taken at emit (never
 *  recomputed), and is PII-free by contract. `kind` is the AutonomyPolicy action
 *  kind the proposal carries. */
export const ProposalSchema = z.object({
  id: z.string().uuid(),
  orgId: z.string().uuid(),
  kind: z.string(),
  status: ProposalStatusEnum,
  scopeType: z.string(),
  scopeId: z.string().uuid(),
  evidence: z.record(z.string(), z.unknown()),
  expiresAt: z.coerce.date().nullable(),
  actorType: z.literal('system'),
  createdAt: z.coerce.date(),
  appliedAt: z.coerce.date().nullable(),
});
export type ProposalView = z.infer<typeof ProposalSchema>;

/** GET /api/v1/proposals query — pending, ranked, keyset-paginated. `kind`
 *  optionally filters to one action kind (e.g. show only reissue proposals). */
export const ListProposalsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
  kind: z.string().min(1).max(120).optional(),
});
export type ListProposalsQueryDto = z.infer<typeof ListProposalsQuery>;
