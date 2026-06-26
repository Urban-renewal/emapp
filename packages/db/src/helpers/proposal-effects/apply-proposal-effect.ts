/**
 * `applyProposalEffect` — the ONE DI-free dispatcher for the AUTO-SAFE INTERNAL
 * proposal effects (Autonomous Master Plan, wave 1.2).
 *
 * THE LAYER-BOUNDARY FIX: a proposal's domain effect used to live only inside the
 * NestJS `ProposalsService.executors` map (closures over injected services), so the
 * worker producer could not run it. This dispatcher lives in `@emapp/db`, is
 * DI-free, and is called by BOTH:
 *   - the API approve path (the manager clicked APPROVE — the human actor-context), and
 *   - the producer auto-execute path (a system actor-context, NULL author).
 * One implementation per kind, two legitimate actor-contexts via `deps`.
 *
 * ── THE PARTITION IS THE LAW, NOT A HAND-PICK ────────────────────────────────────
 * Only kinds that `classify()` decides are `autoExecute` (internal ∧ reversible ∧
 * ¬PII ∧ ¬outbound) have an effect here. Outbound kinds (`reminder.send`,
 * `signature_request.reissue` → `reissueAndDeliver`, `document.chase.send`) require
 * a governed send through Nest-injected providers + PII decrypt; they can NEVER
 * `autoExecute` (the boundary forbids it), so they stay API-resident, approve-only
 * executors — extracting them would buy nothing and drag the email/SMS graph into
 * `@emapp/db`. This dispatcher is therefore "the ONE path for auto-safe internal
 * effects," and the approve path dispatches outbound kinds to its own executors.
 *
 * ── DEFENSE-IN-DEPTH: THE BOUNDARY IS RE-ASSERTED HERE, INSIDE THE FUNCTION THAT
 *    DOES THE WORK ─────────────────────────────────────────────────────────────────
 * Whoever calls this — the API, the producer, or any future caller — the boundary
 * is re-checked at the point of mutation, not only at the call site:
 *   1. `classify({kind})` fails closed on an unknown kind (Zod `.strict()`).
 *   2. The decision MUST be `autoExecute`. A kind that is `proposeConfirm`/`humanOnly`
 *      (anything outbound/PII/floor) is REFUSED here regardless of any caller flag —
 *      so no crafted producer flag, no mis-registration, can push an outbound/PII/floor
 *      kind through this path. (The producer ALSO pre-checks the flag + an allowlist;
 *      this inner re-assert is the non-bypassable backstop.)
 *   3. A registered effect must exist for the kind (fail-closed if none).
 */
import { classify, type AutonomyActionKind } from '@emapp/jobs/autonomy-policy';

import type { Proposal } from '../../schema/proposals';
import type { TenantTx } from '../../wrappers/with-tenant';

import { applyTaskCreateEffect } from './task-create.effect';
import type { ProposalEffectDeps } from './types';

/** Thrown when a caller asks to apply an effect for a kind that is NOT
 *  `autoExecute` by the boundary — the non-bypassable security backstop. */
export class ProposalEffectBoundaryError extends Error {
  constructor(
    readonly kind: string,
    readonly decision: string,
  ) {
    super(`proposal effect refused: kind '${kind}' is '${decision}', not autoExecute`);
    this.name = 'ProposalEffectBoundaryError';
  }
}

/** Thrown when no auto-safe effect is registered for an (otherwise autoExecute) kind. */
export class ProposalEffectNotRegisteredError extends Error {
  constructor(readonly kind: string) {
    super(`proposal effect refused: no auto-safe effect registered for kind '${kind}'`);
    this.name = 'ProposalEffectNotRegisteredError';
  }
}

/** A DI-free per-kind effect: mutate inside the caller's tenant tx, given the
 *  actor-context `deps`. Returns nothing observable to the dispatcher (the caller
 *  flips the proposal state + audits the transition). */
type ProposalEffectFn = (
  tx: TenantTx,
  proposal: Proposal,
  deps: ProposalEffectDeps,
) => Promise<unknown>;

/**
 * The registry of AUTO-SAFE INTERNAL effects. EVERY key here MUST classify as
 * `autoExecute` — asserted exhaustively in `apply-proposal-effect.spec.ts` so adding
 * an outbound/PII/floor kind to this map is a CI failure, never a prod escape.
 *
 * Today the only such kind is `task.create` (internal · reversible · non-PII ·
 * non-outbound). Future auto-safe kinds (`document.autofile`, `project.flagAtRisk`)
 * register here.
 */
const AUTO_SAFE_EFFECTS: Partial<Record<AutonomyActionKind, ProposalEffectFn>> = {
  'task.create': applyTaskCreateEffect,
};

/**
 * The hard allowlist of kinds the producer may AUTO-EXECUTE — the outermost gate,
 * exactly the keys of `AUTO_SAFE_EFFECTS`. Exposed (a) so the producer can pre-check
 * cheaply before touching the DB, and (b) so a test can assert every member is
 * `autoExecute` AND has a registered effect (no drift between the allowlist, the
 * registry, and the boundary).
 */
export const AUTO_EXECUTE_SAFE_KINDS: readonly AutonomyActionKind[] = Object.keys(
  AUTO_SAFE_EFFECTS,
) as AutonomyActionKind[];

/**
 * Apply a proposal's auto-safe internal effect inside an open tenant tx.
 *
 * Re-asserts the boundary (unknown kind → throw; non-autoExecute kind → throw;
 * unregistered kind → throw) BEFORE dispatching, so the mutation can only run for a
 * genuinely auto-safe kind regardless of caller. The caller owns the proposal
 * state-flip + transition audit AROUND this call (so the effect + flip are one tx).
 */
export async function applyProposalEffect(
  tx: TenantTx,
  kind: AutonomyActionKind,
  proposal: Proposal,
  deps: ProposalEffectDeps,
): Promise<void> {
  // (1) + (2) Re-assert the boundary — fail-closed on unknown kind, and REFUSE any
  // kind that is not autoExecute (outbound/PII/floor can never reach a mutation here).
  const { decision } = classify({ kind });
  if (decision !== 'autoExecute') {
    throw new ProposalEffectBoundaryError(kind, decision);
  }

  // (3) Dispatch to the registered auto-safe effect (fail-closed if none).
  const effect = AUTO_SAFE_EFFECTS[kind];
  if (!effect) {
    throw new ProposalEffectNotRegisteredError(kind);
  }

  await effect(tx, proposal, deps);
}
