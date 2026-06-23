import { AuditService, proposals, withTenant, type Proposal, type TenantTx } from '@emapp/db';
import { classify, type AutonomyActionKind } from '@emapp/jobs/autonomy-policy';
import type {
  ListProposalsQueryDto,
  ProposalApplyDelivery,
  ProposalApproveResponse,
  ProposalView,
} from '@emapp/shared-types';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import {
  decodeCursor,
  encodeCursor,
  keysetCondition,
  keysetOrderBy,
} from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';
import { SignatureRequestsService } from '../signatures/signature-requests.service';

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });
const FORBIDDEN = new ForbiddenException({ error: { code: 'forbidden' } });

/** The shape of a `reminder.send` proposal's evidence snapshot we depend on at
 *  execute time. Zod-parsed (no raw `unknown` access, per CLAUDE.md) — a malformed
 *  evidence blob fails closed rather than sending with a default step. */
const ReminderEvidence = z.object({ cadenceStep: z.number().int().min(0) });

export interface ProposalListPage {
  data: ProposalView[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

/**
 * A per-kind executor: APPROVE replays the EXISTING gated domain method for the
 * proposal's `kind`. The map is the structural form of "re-evaluate at execute"
 * (design correction): the executor is ONE method that (a) re-runs
 * `classify(kind)` to re-assert the boundary, then (b) dispatches to the
 * kind-registered replay. A kind with NO registered executor cannot be approved
 * (fail-closed) — so a proposal can never apply something the engine has no
 * gated path for.
 */
type KindExecutor = (
  user: AccessTokenPayload,
  proposal: Proposal,
) => Promise<ProposalApplyDelivery | void>;

/**
 * Approval-Inbox service (Autonomous Master Plan, Phase 1).
 *
 * Manager-only surface (every op `requireManager`, mirroring the external-shares
 * posture). Three responsibilities:
 *   - `list`   — pending proposals, keyset-paginated (D.16), scope/kind-filtered.
 *                The evidence is returned VERBATIM from the snapshot (never
 *                recomputed). This is the data the FE Approval Inbox will render.
 *   - `approve`— RE-ASSERT `classify(kind)` at execute time (the boundary is
 *                re-checked, not trusted from emit), then replay the EXISTING
 *                gated domain method via the kind executor. On success flip the
 *                row → `applied` + audit `actorType:'system'` with the proposal id.
 *   - `reject` — flip the row → `rejected` + audit. The dedup key releases so the
 *                same condition can be re-proposed later if it recurs.
 *
 * NO AUTO-APPLY in Phase 1: nothing here runs without a human's explicit
 * approve/reject. RLS isolates every read/write to the manager's org.
 */
@Injectable()
export class ProposalsService {
  /** kind → gated replay. Adding an autonomous behavior registers its executor
   *  here (drop-in), so the apply path is generic, not special-cased per kind. */
  private readonly executors: Partial<Record<AutonomyActionKind, KindExecutor>>;

  constructor(private readonly signatureRequests: SignatureRequestsService) {
    this.executors = {
      // Phase-1 first producer: reissue an EXPIRED signature request AND
      // re-deliver the renewed signing link to the apartment owner. The old
      // executor called `reissueExpired` (internal re-mint ONLY, NO send), so the
      // owner who must sign received a link they NEVER GOT and the manager saw a
      // vanished card — the renewal was dead-on-arrival. We now call
      // `reissueAndDeliver`, which re-mints (the same gated internal half) AND
      // governed-sends the renewed link (M1 exactly-once + gates, the SAME seam
      // `reminder.send` uses) + emits an "owner re-notified" notification. The
      // returned `delivery` is surfaced in the approve response so the inbox shows
      // the outcome. The proposal's scopeId is the signature_request id.
      'signature_request.reissue': async (user, proposal) => {
        const { delivery } = await this.signatureRequests.reissueAndDeliver(user, {
          signatureRequestId: proposal.scopeId,
          proposalId: proposal.id,
        });
        return delivery;
      },
      // Phase-2 first GOVERNED-OUTBOUND producer: send ONE reminder for a pending
      // signature request THROUGH the OutboundGovernor (gates + M1 exactly-once
      // ledger). Replays the EXISTING gated `resend` verbatim as the send thunk —
      // the governance + exactly-once wrap it, they don't duplicate the send. The
      // proposal's scopeId is the signature_request id; the cadence step is read
      // from the (Zod-validated) evidence snapshot taken at emit.
      'reminder.send': async (user, proposal) => {
        const { cadenceStep } = ReminderEvidence.parse(proposal.evidence);
        const outcome = await this.signatureRequests.sendGovernedReminder(user, {
          proposalId: proposal.id,
          signatureRequestId: proposal.scopeId,
          cadenceStep,
        });
        // Per-item independence (design correction M2): a non-`sent` outcome does
        // NOT silently "succeed". A gate denied/deferred it (kill-switch off,
        // consent withdrawn, breaker tripped, ceiling hit, quiet hours) or the
        // provider failed → throw so the apply path leaves the proposal PENDING
        // (it stays actionable; the manager retries when the condition lifts).
        // `already_sent` is the M1 exactly-once no-op: the send already happened
        // (a terminal `sent` row), so the proposal legitimately flips to `applied`.
        if (outcome.result === 'sent' || outcome.result === 'already_sent') return;
        if (outcome.result === 'blocked') {
          throw new ConflictException({
            error: { code: 'outbound_blocked', details: { reason: outcome.decision.reason } },
          });
        }
        // result === 'failed' — a DEFINITE non-send (provider rejection / nothing
        // attempted). The ledger row is `failed` (RE-CLAIMABLE): throwing leaves
        // the proposal PENDING so the manager retries; the next approve re-claims
        // the failed row + re-sends the SAME step (#506 H1 fix — a failed step is
        // no longer permanently dead + falsely "succeeded").
        if (outcome.result === 'failed') {
          throw new ConflictException({
            error: { code: 'outbound_failed', details: { reason: outcome.failureCode } },
          });
        }
        // result === 'ambiguous' — the provider threw / timed out; the SMS MAY
        // have gone out. NEVER auto-resend. The ledger row is PARKED (`pending_send`)
        // and is un-resendable by this path. Surface a DISTINCT state so the
        // manager sees "needs manual check at the provider", NOT a false success
        // and NOT a clean retry. The proposal stays PENDING (the throw leaves it
        // un-flipped) — a human resolves it out-of-band.
        throw new ConflictException({
          error: { code: 'outbound_ambiguous', details: { reason: outcome.failureCode } },
        });
      },
    };
  }

  private requireManager(user: AccessTokenPayload): void {
    if (user.role !== 'manager') throw FORBIDDEN;
  }

  private toView(r: Proposal): ProposalView {
    return {
      id: r.id,
      orgId: r.orgId,
      kind: r.kind,
      status: r.status as ProposalView['status'],
      scopeType: r.scopeType,
      scopeId: r.scopeId,
      evidence: r.evidence,
      expiresAt: r.expiresAt,
      actorType: 'system',
      createdAt: r.createdAt,
      appliedAt: r.appliedAt,
    };
  }

  /** Pending proposals, newest-first, keyset-paginated. The FE inbox renders
   *  these. `kind` optionally narrows to one action kind. */
  async list(user: AccessTokenPayload, query: ListProposalsQueryDto): Promise<ProposalListPage> {
    this.requireManager(user);
    const { limit } = query;
    const cur = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cur) {
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }
    const rows = await withTenant(
      user.orgId,
      async (tx) => {
        const keyset: SQL | undefined = cur
          ? keysetCondition(proposals.createdAt, proposals.id, cur)
          : undefined;
        return tx
          .select()
          .from(proposals)
          .where(
            and(
              eq(proposals.status, 'pending'),
              query.kind ? eq(proposals.kind, query.kind) : undefined,
              keyset,
            ),
          )
          .orderBy(...keysetOrderBy(proposals.createdAt, proposals.id))
          .limit(limit + 1);
      },
      { userId: user.sub },
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map((r) => this.toView(r)),
      page: { limit, cursor: hasMore && last ? encodeCursor(last) : null, has_more: hasMore },
    };
  }

  /**
   * APPROVE — re-assert the boundary, replay the gated method, flip → applied.
   *
   * Flow:
   *   1. Load the proposal (must be pending; a non-pending one 409s — it was
   *      already actioned/expired).
   *   2. RE-EVALUATE `classify(kind)` at execute time. A kind that became
   *      unclassifiable (taxonomy changed) throws — the boundary is re-checked,
   *      never trusted from emit.
   *   3. Dispatch to the kind executor (the EXISTING gated domain method). If no
   *      executor is registered for the kind, fail-closed (cannot apply).
   *   4. On success, flip → applied + appliedAt + a `system`-attributed audit row
   *      carrying the proposal id (every autonomous act is audited).
   *
   * The gated method runs under ITS OWN withTenant/RLS + capability checks, so a
   * stale or out-of-scope proposal cannot apply something the manager couldn't do
   * by hand. A gated-method failure (e.g. the request is no longer expired) leaves
   * the proposal pending (it surfaces a 409) so it can be retried or dismissed.
   */
  async approve(user: AccessTokenPayload, id: string): Promise<ProposalApproveResponse> {
    this.requireManager(user);

    // Load + lock the pending proposal first (RLS-scoped).
    const proposal = await withTenant(
      user.orgId,
      async (tx) => {
        const [row] = await tx.select().from(proposals).where(eq(proposals.id, id)).limit(1);
        if (!row) throw NOT_FOUND;
        if (row.status !== 'pending') {
          throw new ConflictException({ error: { code: 'proposal_not_pending' } });
        }
        return row;
      },
      { userId: user.sub },
    );

    // (2) RE-ASSERT the boundary at execute time. classify throws on an unknown
    // kind (fail-closed). We do not auto-execute here regardless of the decision
    // — the human already approved; we replay the gated path.
    classify({ kind: proposal.kind as AutonomyActionKind });

    // (3) Dispatch to the registered gated replay (fail-closed if none).
    const executor = this.executors[proposal.kind as AutonomyActionKind];
    if (!executor) {
      throw new BadRequestException({ error: { code: 'proposal_kind_not_executable' } });
    }
    // The gated method enforces its own RLS + capability + state checks. A
    // failure (e.g. signature_request_not_reissuable) propagates as its own
    // status code; the proposal stays pending. A contact-producing kind
    // (signature_request.reissue) returns the outbound delivery OUTCOME so the
    // approve response can surface "owner re-notified" (channel + masked
    // recipient); an internal-only kind returns void → no `delivery` on the wire.
    const delivery = (await executor(user, proposal)) ?? undefined;

    // (4) Flip → applied (only if STILL pending — race-safe) + system audit.
    const updated = await withTenant(
      user.orgId,
      async (tx) => {
        const [row] = await tx
          .update(proposals)
          .set({ status: 'applied', appliedAt: new Date() })
          .where(and(eq(proposals.id, id), eq(proposals.status, 'pending')))
          .returning();
        if (!row) {
          // Lost the race (concurrent approve/reject/expire). The gated method
          // already ran once; surface a conflict so the caller re-reads state.
          throw new ConflictException({ error: { code: 'proposal_not_pending' } });
        }
        await this.audit(tx, user, 'proposal.approve', row.id, row.kind);
        return row;
      },
      { userId: user.sub },
    );
    return { ...this.toView(updated), delivery };
  }

  /** REJECT — flip → rejected + audit. Idempotent-ish: a non-pending proposal
   *  409s. Rejecting releases the dedup key so the condition can re-propose. */
  async reject(user: AccessTokenPayload, id: string): Promise<ProposalView> {
    this.requireManager(user);
    const updated = await withTenant(
      user.orgId,
      async (tx) => {
        const [existing] = await tx
          .select({ id: proposals.id, status: proposals.status })
          .from(proposals)
          .where(eq(proposals.id, id))
          .limit(1);
        if (!existing) throw NOT_FOUND;
        if (existing.status !== 'pending') {
          throw new ConflictException({ error: { code: 'proposal_not_pending' } });
        }
        const [row] = await tx
          .update(proposals)
          .set({ status: 'rejected' })
          .where(and(eq(proposals.id, id), eq(proposals.status, 'pending')))
          .returning();
        if (!row) {
          throw new ConflictException({ error: { code: 'proposal_not_pending' } });
        }
        await this.audit(tx, user, 'proposal.reject', row.id, row.kind);
        return row;
      },
      { userId: user.sub },
    );
    return this.toView(updated);
  }

  /** Every proposal transition is audited as a `system`-origin act carrying the
   *  proposal id + kind in metadata (charter §3: audit-every-act). actorId is the
   *  human who confirmed; actorType 'system' marks the autonomous origin. */
  private async audit(
    tx: TenantTx,
    user: AccessTokenPayload,
    action: string,
    proposalId: string,
    kind: string,
  ): Promise<void> {
    await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
      orgId: user.orgId,
      actorId: user.sub,
      actorType: 'system',
      action,
      targetTable: 'proposals',
      targetId: proposalId,
      metadata: { kind },
      sessionId: user.sid,
    });
  }
}
