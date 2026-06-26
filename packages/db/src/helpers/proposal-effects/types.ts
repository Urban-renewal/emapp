/**
 * Shared types for the DI-free proposal EFFECT layer (Autonomous Master Plan,
 * wave 1.2 — executor extraction + auto-execute graduation).
 *
 * THE LAYER-BOUNDARY FIX: a proposal's domain EFFECT (the mutation it applies) used
 * to live ONLY inside the NestJS `ProposalsService.executors` map, whose closures
 * capture constructor-injected services — so the worker-layer producer (no Nest DI)
 * could not run the SAME effect. These pure, DI-free effect functions are the ONE
 * implementation both the API approve path and the producer auto-execute path call,
 * so the manager-approve mutation and the autonomous mutation can never drift.
 *
 * `deps` carries the ACTOR-CONTEXT (who triggered the effect) as plain values/
 * functions — NOT Nest classes. The EFFECT (the task row + its dedup) is identical
 * across callers; only the actor-context differs: the manager-approve path supplies
 * a human `createdBy` + a real audit context + (optionally) auto-assign/notify hooks;
 * the producer path supplies a NULL author (system task, no human) + a system audit
 * context + no notify. This keeps single-source-of-truth at the right granularity:
 * one mutation, two legitimate actor-contexts.
 */
import type { TenantTx } from '../../wrappers/with-tenant';

/**
 * Forensic context for the audit row an effect writes. Mirrors the optional fields
 * the API approve path carries (`ip`/`userAgent`/`sessionId`/`actorId`); on the
 * producer auto-execute path they are all absent (a pure-system act has no request
 * context) and `actorId` is null — `AuditService` already treats a null/absent
 * actor as a system action.
 */
export interface EffectAuditContext {
  /** The human who triggered the effect, or null for a pure-system auto-execute. */
  actorId: string | null;
  ip?: string;
  userAgent?: string;
  sessionId?: string;
}

/**
 * The actor-context + side-effect hooks an effect needs, supplied by the caller.
 * Everything here is a plain value or a plain function — NO Nest DI — so the effect
 * runs identically from the API and from the worker producer.
 */
export interface ProposalEffectDeps {
  /** The audit context (human actor + request forensics, or a null system actor). */
  audit: EffectAuditContext;
  /**
   * Who authored the resulting domain row. On manager-approve this is the approving
   * user; on the producer auto-execute it is NULL (a system-authored row, paired
   * with `source='system'`).
   */
  createdBy: string | null;
  /**
   * Optional post-insert hook, run INSIDE the same tx, given the new row id — the
   * manager-approve path uses it to auto-assign the creator (so a human sees the
   * task he approved); the producer passes none (a system task has no human to
   * assign, and the autonomy ledger — not a task-assigned alert — surfaces it).
   */
  onRowCreated?: (tx: TenantTx, rowId: string) => Promise<void>;
}
