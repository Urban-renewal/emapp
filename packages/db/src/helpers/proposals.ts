/**
 * `emitProposal` — the SINGLE insert path into the Approval-Inbox `proposals`
 * table (Autonomous Master Plan, Phase 1). Every producer routes through here;
 * nothing else inserts a proposal.
 *
 * Responsibilities (all in one chokepoint so no producer re-implements them):
 *
 *  1. CLASSIFY the kind through `AutonomyPolicy.classify(kind)`. A kind that is
 *     not in the taxonomy THROWS (`classify` Zod-parses `.strict()`), so a
 *     producer can never emit a proposal for an unclassifiable action — the
 *     boundary is asserted at emit, then RE-asserted at execute. A `humanOnly`
 *     floor (status→approved, RTBF erase, …) is still emittable as DRAFT
 *     EVIDENCE — the executor is what refuses to auto-apply it; the proposal
 *     itself is advisory. We therefore do NOT reject on decision here; we reject
 *     only on an UNKNOWN kind (fail-closed taxonomy).
 *
 *  2. SNAPSHOT evidence AT EMIT (design correction): the evidence the caller
 *     passes is stored verbatim and is NEVER recomputed on read. The manager
 *     confirms against what the system saw. PII MUST NOT be in `evidence` —
 *     that contract is the producer's (template-only, ids/counts), mirroring the
 *     PII-free notification-title rule; this helper does not decrypt or inspect.
 *
 *  3. IDEMPOTENCY: insert with ON CONFLICT DO NOTHING on the partial unique
 *     `(org_id, dedup_key) WHERE status='pending'`. A second live emit for the
 *     same condition is a NO-OP (returns the existing-or-nothing result), never
 *     an error — so overlapping ticks / retries can't duplicate or nag.
 *
 * Runs inside the caller's `withTenant(orgId, …)` tx (RLS-scoped). The producer
 * is the only system writer and it still scopes per-org — there is no BYPASSRLS
 * proposal write.
 */
import { classify, type AutonomyActionKind } from '@emapp/jobs/autonomy-policy';
import { and, eq, sql } from 'drizzle-orm';

import { proposals, type Proposal } from '../schema/proposals';
import type { TenantTx } from '../wrappers/with-tenant';

export interface EmitProposalInput {
  /** The org the proposal belongs to. MUST match the withTenant context. */
  orgId: string;
  /** AutonomyPolicy action kind. An unknown kind throws (fail-closed taxonomy). */
  kind: AutonomyActionKind;
  /** What the proposal is about ('signature_request' | 'project' | …). */
  scopeType: string;
  /** The concrete in-org entity id the proposal targets. */
  scopeId: string;
  /** Evidence SNAPSHOT — ids/counts only, NEVER PII. Stored verbatim. */
  evidence: Record<string, unknown>;
  /** Deterministic idempotency key (the partial-unique dedup key). */
  dedupKey: string;
  /** Optional retirement time for a stale pending proposal. */
  expiresAt?: Date | null;
}

export interface EmitProposalResult {
  /** The inserted row, or null when the emit was a dedup no-op (already live). */
  proposal: Proposal | null;
  /** true when a row was actually inserted; false on the idempotent no-op. */
  inserted: boolean;
}

/**
 * Emit (or idempotently no-op) a proposal. Throws ONLY on an unclassifiable
 * `kind` (the taxonomy is the chokepoint). The dedup conflict is swallowed.
 */
export async function emitProposal(
  tx: TenantTx,
  input: EmitProposalInput,
): Promise<EmitProposalResult> {
  // (1) Assert the kind is classifiable — fail-closed. We don't gate on the
  // decision here (a humanOnly floor is still a valid DRAFT); we only refuse an
  // UNKNOWN kind, which `classify` does by throwing on the Zod parse.
  classify({ kind: input.kind });

  // (3) Idempotent insert. ON CONFLICT targets the PARTIAL unique index — the
  // same predicate (status='pending') must be supplied via `where` so Drizzle
  // matches the partial index, not a (nonexistent) full one.
  const inserted = await tx
    .insert(proposals)
    .values({
      orgId: input.orgId,
      kind: input.kind,
      status: 'pending',
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      evidence: input.evidence, // (2) snapshot stored verbatim
      dedupKey: input.dedupKey,
      expiresAt: input.expiresAt ?? null,
      actorType: 'system',
    })
    .onConflictDoNothing({
      target: [proposals.orgId, proposals.dedupKey],
      // The partial-index predicate (`WHERE status='pending'`) so Drizzle matches
      // the partial unique index `proposals_org_dedup_pending_unique`, not a
      // (nonexistent) full one. This drizzle version names it `where`.
      where: sql`status = 'pending'`,
    })
    .returning();

  if (inserted.length > 0) {
    return { proposal: inserted[0] ?? null, inserted: true };
  }

  // No-op path: a live pending proposal for this (org, dedup_key) already
  // exists. Return it (best-effort) so callers can surface it without erroring.
  const [existing] = await tx
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.orgId, input.orgId),
        eq(proposals.dedupKey, input.dedupKey),
        eq(proposals.status, 'pending'),
      ),
    )
    .limit(1);

  return { proposal: existing ?? null, inserted: false };
}
