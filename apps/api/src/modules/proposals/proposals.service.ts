import {
  applyProposalEffect,
  AUTO_EXECUTE_SAFE_KINDS,
  AuditService,
  proposals,
  withTenant,
  type GovernedSendOutcome,
  type Proposal,
  type ProposalEffectDeps,
  type TenantTx,
} from '@emapp/db';
import { classify, type AutonomyActionKind } from '@emapp/jobs/autonomy-policy';
import type {
  ListProposalsQueryDto,
  ProposalApplyDelivery,
  ProposalApproveResponse,
  ProposalPendingCountQueryDto,
  ProposalView,
} from '@emapp/shared-types';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import {
  decodeCursor,
  encodeCursor,
  keysetCondition,
  keysetOrderBy,
} from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';
import { SignatureRequestsService } from '../signatures/signature-requests.service';

import { executeDocumentChase } from './document-chase-executor';

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
 * A per-kind OUTBOUND executor: APPROVE replays the EXISTING gated GOVERNED-SEND
 * domain method for the proposal's `kind`. These kinds are `proposeConfirm`
 * (outbound + consent) by THE ONE BOUNDARY — they can NEVER auto-execute, so they
 * stay API-resident (they need Nest-injected email/SMS providers + PII decrypt) and
 * run ONLY on a human's APPROVE. The internal AUTO-SAFE effects (`task.create`, …)
 * do NOT live here — they route through the DI-free `applyProposalEffect` shared by
 * the producer's auto-execute path (wave 1.2 extraction). A kind with NO registered
 * outbound executor AND no auto-safe effect cannot be approved (fail-closed).
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
  /** kind → gated GOVERNED-SEND replay for the OUTBOUND (proposeConfirm) kinds only.
   *  These can never auto-execute (the boundary forbids outbound auto), so they stay
   *  here and run only on APPROVE. The internal AUTO-SAFE effects route through the
   *  DI-free `applyProposalEffect` (shared with the producer) — NOT this map. */
  private readonly outboundExecutors: Partial<Record<AutonomyActionKind, KindExecutor>>;

  constructor(private readonly signatureRequests: SignatureRequestsService) {
    this.outboundExecutors = {
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
        // The governed-outcome → keep-pending/throw mapping is ONE canonical
        // implementation (`assertGovernedSent`), shared with the S5
        // `document.chase.send` executor — never re-implemented per kind.
        this.assertGovernedSent(outcome);
      },
      // S5 DocumentChase: APPROVE chases the responsible PARTY for a project's
      // MISSING required document, THROUGH the SAME canonical `governOutboundSend`
      // seam the reminder uses (gates + M1 exactly-once). The executor resolves the
      // REAL recipient consent FAIL-CLOSED (no opt-out registry / party-recipient
      // resolver merged yet → consent unconfirmable → the ConsentGate denies →
      // `blocked`, nothing is sent, the proposal stays pending). NEVER a hardcoded
      // `recipientConsented:true` (the #516 consent-bypass). The proposal's scopeId
      // is the project id; the missing type + party come from the PII-free evidence.
      'document.chase.send': async (_user, proposal) => {
        const outcome = await executeDocumentChase(proposal.orgId, proposal);
        // SAME canonical outcome mapping as the reminder executor.
        this.assertGovernedSent(outcome);
      },
      // NOTE: `task.create` (G1 TaskWatcher) is NO LONGER here. It is an INTERNAL
      // auto-safe effect — it routes through the DI-free `applyProposalEffect`
      // (wave 1.2), the SAME path the producer's auto-execute uses, so the manager-
      // approve mutation and the autonomous mutation are ONE implementation.
    };
  }

  /**
   * The ONE canonical governed-outbound outcome → keep-pending/throw mapping,
   * shared by EVERY governed-send executor (`reminder.send`, `document.chase.send`,
   * …) so the per-item-independence semantics (design correction M2) are NEVER
   * re-implemented per kind:
   *   - `sent` / `already_sent` → success (the proposal flips to `applied`).
   *   - `blocked` → a gate denied/deferred (kill-switch off, CONSENT withdrawn,
   *     breaker tripped, ceiling, quiet hours). Throw → proposal stays PENDING.
   *   - `failed` → a DEFINITE non-send (re-claimable next approve). Throw → pending.
   *   - `ambiguous` → the provider threw/timed out; the send MAY have gone out.
   *     NEVER auto-resend (parked `pending_send`). Throw a DISTINCT state → pending.
   */
  private assertGovernedSent(outcome: GovernedSendOutcome): void {
    if (outcome.result === 'sent' || outcome.result === 'already_sent') return;
    if (outcome.result === 'blocked') {
      throw new ConflictException({
        error: { code: 'outbound_blocked', details: { reason: outcome.decision.reason } },
      });
    }
    if (outcome.result === 'failed') {
      throw new ConflictException({
        error: { code: 'outbound_failed', details: { reason: outcome.failureCode } },
      });
    }
    // result === 'ambiguous' — parked, never auto-resent; surface a distinct state.
    throw new ConflictException({
      error: { code: 'outbound_ambiguous', details: { reason: outcome.failureCode } },
    });
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

  /**
   * Constant-time count of the org's PENDING proposals — the inbox's HONEST
   * lead line ("N החלטות ממתינות לך"). MIRRORS `NotificationsService.unreadCount`
   * exactly (the canonical pattern): a single `count(*)` under withTenant/RLS,
   * NOT a page payload counted client-side. The list header used to read
   * `items.length` over a ≤25-row page, so at 80 pending it lied "25"; this is
   * the single source of truth for the magnitude. Served by the partial index
   * `idx_proposals_org_pending` (WHERE status = 'pending') — no full scan, no
   * N+1. Manager-only (every proposals op is `requireManager`); RLS org-isolates.
   */
  async pendingCount(
    user: AccessTokenPayload,
    query: ProposalPendingCountQueryDto = {},
  ): Promise<{ count: number }> {
    this.requireManager(user);
    const result = await withTenant(
      user.orgId,
      async (tx) =>
        tx
          .select({ count: sql<number>`count(*)::int` })
          .from(proposals)
          // SAME predicate as `list` (kind narrows identically) so the count and
          // the feed derive from ONE kind-aware filter — no "X מתוך Y" drift.
          .where(
            and(
              eq(proposals.status, 'pending'),
              query.kind ? eq(proposals.kind, query.kind) : undefined,
            ),
          ),
      { userId: user.sub },
    );
    return { count: result[0]?.count ?? 0 };
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
   * APPROVE — re-assert the boundary, apply the ONE effect for the kind, flip →
   * applied. TWO dispatch arms, each single-sourced:
   *
   *   A) AUTO-SAFE INTERNAL kinds (`task.create`, …): route through the DI-free
   *      `applyProposalEffect` — the SAME path the producer's auto-execute uses. The
   *      effect + the `pending→applied` flip + the transition audit run in ONE tx
   *      (atomic: a lost flip rolls the effect back, so no half-apply). The effect's
   *      own idempotency (the system-task partial-unique) makes a producer↔approve
   *      race a no-op, not a double-apply.
   *   B) OUTBOUND (proposeConfirm) kinds (`reminder.send`, `signature_request.reissue`,
   *      `document.chase.send`): replay the EXISTING gated governed-send executor
   *      (it cannot run inside the flip tx — the send is its own withTenant + I/O),
   *      THEN flip → applied + audit. Unchanged from before this extraction (so the
   *      manager outbound-approve flow is behaviorally identical, including the
   *      `delivery` outcome surfaced for reissue).
   *
   * Flow:
   *   1. Load the proposal (must be pending; a non-pending one 409s).
   *   2. RE-ASSERT `classify(kind)` at execute time (boundary re-checked, fail-closed
   *      on an unknown kind). `applyProposalEffect` ALSO re-asserts internally — the
   *      non-bypassable backstop.
   *   3. Dispatch on the kind's arm (auto-safe effect vs outbound executor;
   *      fail-closed if the kind has neither).
   *   4. Flip → applied (race-safe `WHERE status='pending'`) + a `system`-attributed
   *      transition audit carrying the proposal id.
   */
  async approve(user: AccessTokenPayload, id: string): Promise<ProposalApproveResponse> {
    this.requireManager(user);

    // (1) Load + lock the pending proposal first (RLS-scoped).
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

    // (2) RE-ASSERT the boundary at execute time (fail-closed on unknown kind).
    const kind = proposal.kind as AutonomyActionKind;
    classify({ kind });

    // (3-A) AUTO-SAFE INTERNAL arm — the effect + flip + audit in ONE atomic tx.
    if ((AUTO_EXECUTE_SAFE_KINDS as readonly string[]).includes(kind)) {
      const updated = await this.applyAutoSafeEffectAndFlip(user, kind, proposal);
      return { ...this.toView(updated), delivery: undefined };
    }

    // (3-B) OUTBOUND arm — the gated governed-send executor (fail-closed if none).
    const executor = this.outboundExecutors[kind];
    if (!executor) {
      throw new BadRequestException({ error: { code: 'proposal_kind_not_executable' } });
    }
    // The gated method enforces its own RLS + capability + state checks. A failure
    // (e.g. signature_request_not_reissuable) propagates as its own status code; the
    // proposal stays pending. A contact-producing kind (signature_request.reissue)
    // returns the outbound delivery OUTCOME so the approve response can surface "owner
    // re-notified" (channel + masked recipient); an internal-only kind returns void.
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

  /**
   * The AUTO-SAFE arm of approve (arm A): run the DI-free `applyProposalEffect` for an
   * internal kind, flip `pending→applied`, and audit — ALL in ONE tx so the effect and
   * the flip are atomic (a lost flip rolls the effect back; the effect's own
   * idempotency makes a producer↔approve race a no-op). `deps` carries the
   * human actor-context (the approving manager as `createdBy` + audit forensics);
   * the producer supplies a NULL system actor-context for the SAME effect.
   */
  private async applyAutoSafeEffectAndFlip(
    user: AccessTokenPayload,
    kind: AutonomyActionKind,
    proposal: Proposal,
  ): Promise<Proposal> {
    const deps: ProposalEffectDeps = {
      createdBy: user.sub,
      audit: {
        actorId: user.sub,
        ip: user.ip,
        userAgent: user.userAgent,
        sessionId: user.sid,
      },
    };
    return withTenant(
      user.orgId,
      async (tx) => {
        // Re-read pending inside the tx so the effect + flip see one consistent state.
        const [current] = await tx
          .select({ status: proposals.status })
          .from(proposals)
          .where(eq(proposals.id, proposal.id))
          .limit(1);
        if (!current || current.status !== 'pending') {
          throw new ConflictException({ error: { code: 'proposal_not_pending' } });
        }
        // The effect (idempotent; re-asserts the boundary internally — fail-closed on
        // any non-autoExecute kind). Mutates inside THIS tx (RLS-scoped).
        await applyProposalEffect(tx, kind, proposal, deps);
        // Flip → applied (race-safe). If we lost the race, the whole tx rolls back
        // (including the effect) and we 409.
        const [row] = await tx
          .update(proposals)
          .set({ status: 'applied', appliedAt: new Date() })
          .where(and(eq(proposals.id, proposal.id), eq(proposals.status, 'pending')))
          .returning();
        if (!row) {
          throw new ConflictException({ error: { code: 'proposal_not_pending' } });
        }
        await this.audit(tx, user, 'proposal.approve', row.id, row.kind);
        return row;
      },
      { userId: user.sub },
    );
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
