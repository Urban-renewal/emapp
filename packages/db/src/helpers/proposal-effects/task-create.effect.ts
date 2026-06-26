/**
 * `applyTaskCreateEffect` — the DI-free EFFECT for a `task.create` (G1 TaskWatcher)
 * proposal (Autonomous Master Plan, wave 1.2).
 *
 * This is the ONE implementation of "create the SYSTEM-OWNED task for a detected
 * missing-required-doc condition." It is called BOTH by the API approve path
 * (through `applyProposalEffect`, with the approving manager as actor) AND by the
 * worker producer's auto-execute path (with a NULL system actor). There is no
 * second implementation — the domain mutation cannot drift between the two.
 *
 * WHAT IT DOES (the mutation, identical for both callers):
 *   1. Parse the PII-FREE evidence snapshot (project + missing doc-type taxonomy).
 *   2. Compose the PII-free, user-framed Hebrew title/body via the ONE composer.
 *   3. INSERT the SYSTEM-OWNED task through the shared `insertSystemTask` — idempotent
 *      on the `tasks_system_origin_open_unique` partial-unique (a producer↔approve
 *      race or a re-detect is a dedup no-op, not a duplicate) — and audit the create.
 *
 * WHAT DIFFERS (actor-context, via `deps` — NOT the mutation):
 *   - `createdBy`: the approving manager, or NULL for an autonomous (no-author) task.
 *   - `audit`: a human actor + request forensics, or a null system actor.
 *   - `onRowCreated`: an optional in-tx post-insert hook (unused by the auto path).
 *
 * NO PII: only project/doc-type ids + a taxonomy label reach the row + audit. RLS:
 * runs inside the caller's `withTenant(orgId)` tx. NON-OUTBOUND + REVERSIBLE
 * (archive) + INTERNAL — the autoExecute envelope; the only effect the producer is
 * allowed to auto-run today.
 */
import type { Proposal } from '../../schema/proposals';
import type { TenantTx } from '../../wrappers/with-tenant';

import { insertSystemTask } from './insert-system-task';
import { composeMissingDocTask, MissingDocTaskEvidence } from './task-create-copy';
import type { ProposalEffectDeps } from './types';

/**
 * Apply a `task.create` proposal's effect inside an open tenant tx. Returns the
 * created task id, or null when the insert was a dedup no-op (an open system task
 * for this condition already existed — a successful, idempotent outcome).
 */
export async function applyTaskCreateEffect(
  tx: TenantTx,
  proposal: Proposal,
  deps: ProposalEffectDeps,
): Promise<{ taskId: string | null }> {
  // (1) Parse the PII-free evidence — fail-closed on a malformed blob.
  const ev = MissingDocTaskEvidence.parse(proposal.evidence);

  // (2) Compose the PII-free, user-framed copy (the ONE composer).
  const { title, description } = composeMissingDocTask(ev.missingDocType);

  // (3) Insert (idempotent) + audit through the shared system-task path.
  const { taskId } = await insertSystemTask(
    tx,
    {
      orgId: proposal.orgId,
      projectId: ev.projectId,
      title,
      description,
      type: 'document_followup',
      originRef: proposal.dedupKey,
      createdBy: deps.createdBy,
    },
    deps.audit,
  );

  // Optional post-insert hook (only when a row was actually created).
  if (taskId && deps.onRowCreated) await deps.onRowCreated(tx, taskId);

  return { taskId };
}
