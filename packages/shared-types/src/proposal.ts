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

/** The outbound OUTCOME of approving a proposal whose apply CONTACTS someone
 *  (e.g. `signature_request.reissue`, which re-mints AND re-delivers the renewed
 *  signing link to the apartment owner). The FE renders this so the manager sees
 *  "renewed + owner re-notified" rather than a vanished card. When the apply is
 *  purely internal (or the governed send was a no-op/blocked/parked), `delivered`
 *  is false and `state` explains why.
 *
 *  PII CONTRACT (deliberately MINIMAL): this carries ONLY a `delivered` flag, the
 *  governed-outcome `state`, the `channel`, and a MASKED `recipient`
 *  (`na***@domain` for email; `null` for sms/whatsapp). It does NOT carry the
 *  per-channel delivery report — that report's `whatsapp.deepLink` embeds the RAW
 *  phone + the LIVE signing token, which has no place on the inbox surface (the
 *  manager tap-sends from the resend screen, not the proposal card). Keeping the
 *  token-bearing deepLink OFF this wire shape is a hard PII boundary, not an
 *  oversight. */
export const ProposalApplyDeliverySchema = z.object({
  /** Did a channel actually carry the renewed link out (email/SMS sent|queued)? */
  delivered: z.boolean(),
  /** Governed-outbound outcome bucket — mirrors the OutboundGovernor verdict so a
   *  non-`sent` outcome surfaces a DISTINCT state, never a false success. */
  state: z.enum(['sent', 'already_sent', 'blocked', 'failed', 'ambiguous', 'no_channel']),
  /** The channel that carried it (when delivered). */
  channel: z.enum(['email', 'sms', 'whatsapp']).nullable(),
  /** MASKED recipient (`na***@domain`) for email — never the raw address. `null`
   *  for sms/whatsapp (no recipient echoed; the phone is PII). */
  recipient: z.string().nullable(),
});
export type ProposalApplyDelivery = z.infer<typeof ProposalApplyDeliverySchema>;

/** POST /api/v1/proposals/:id/approve response. The applied proposal view PLUS,
 *  for contact-producing kinds, the `delivery` outcome (so the inbox can show
 *  the owner was re-contacted). `delivery` is omitted for internal-only kinds. */
export const ProposalApproveResponseSchema = ProposalSchema.extend({
  delivery: ProposalApplyDeliverySchema.optional(),
});
export type ProposalApproveResponse = z.infer<typeof ProposalApproveResponseSchema>;

/** GET /api/v1/proposals query — pending, ranked, keyset-paginated. `kind`
 *  optionally filters to one action kind (e.g. show only reissue proposals). */
export const ListProposalsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
  kind: z.string().min(1).max(120).optional(),
});
export type ListProposalsQueryDto = z.infer<typeof ListProposalsQuery>;

/** GET /api/v1/proposals/pending-count query. Reuses the list's `kind` field
 *  (`.pick`) so the count and the feed narrow through the IDENTICAL filter —
 *  one kind-aware source, so the lead-line + honesty-line + feed can never drift
 *  ("X מתוך Y" stays consistent when a kind facet is active). */
export const ProposalPendingCountQuery = ListProposalsQuery.pick({ kind: true });
export type ProposalPendingCountQueryDto = z.infer<typeof ProposalPendingCountQuery>;
