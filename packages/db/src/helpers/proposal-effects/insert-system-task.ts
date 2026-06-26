/**
 * `insertSystemTask` — the ONE shared insert for a SYSTEM-OWNED task row
 * (Autonomous Master Plan, wave 1.2). DI-free; lives in `@emapp/db` so BOTH the
 * API approve path (`TasksService.create`, the system branch) AND the worker
 * producer's auto-execute path insert the system task through the SAME code — the
 * row + its dedup + its audit cannot drift between the two callers (single source).
 *
 * IDEMPOTENT by the partial-unique `tasks_system_origin_open_unique`
 * (org_id, origin_ref WHERE source='system' AND origin_ref IS NOT NULL AND
 * archived_at IS NULL): a duplicate open system task for the SAME condition — a
 * producer↔approve race, or a re-detect — is `ON CONFLICT DO NOTHING`, a no-op
 * returning null, NOT an error. The caller treats null as idempotent success.
 *
 * Writes the `task.create` audit row with `actorType:'system'` (the autonomous-act
 * convention) carrying the actor-context's `actorId` (the approving manager, or
 * null for a pure auto-execute) — mirroring the audit the gated create wrote inline
 * before this was factored out. NO PII (project/doc-type ids + a taxonomy title only).
 */
import { sql } from 'drizzle-orm';

import { AuditService } from '../../audit/audit.service';
import { tasks } from '../../schema/collaboration';
import type { TenantTx } from '../../wrappers/with-tenant';

import type { EffectAuditContext } from './types';

export interface SystemTaskInput {
  orgId: string;
  projectId: string | null;
  apartmentId?: string | null;
  title: string;
  description: string | null;
  type: string;
  /** The deterministic dedup key → `origin_ref` (the auto-create/auto-close anchor). */
  originRef: string;
  /** The approving manager, or NULL for an autonomous (no-author) system task. */
  createdBy: string | null;
}

/**
 * Insert a system-owned task (idempotent on the open-origin partial-unique) and
 * audit the create. Returns the new task id, or null on a dedup no-op (an open
 * system task for this condition already exists — idempotent success). Runs inside
 * the caller's open tenant tx (RLS-scoped).
 */
export async function insertSystemTask(
  tx: TenantTx,
  input: SystemTaskInput,
  audit: EffectAuditContext,
): Promise<{ taskId: string | null }> {
  const [row] = await tx
    .insert(tasks)
    .values({
      orgId: input.orgId,
      projectId: input.projectId,
      apartmentId: input.apartmentId ?? null,
      title: input.title,
      description: input.description,
      type: input.type,
      source: 'system',
      originRef: input.originRef,
      createdBy: input.createdBy,
    })
    .onConflictDoNothing({
      target: [tasks.orgId, tasks.originRef],
      // Match the PARTIAL unique index `tasks_system_origin_open_unique`
      // (WHERE source='system' AND origin_ref IS NOT NULL AND archived_at IS NULL).
      // Drizzle needs the predicate to infer the partial arbiter index (same pattern
      // as emitProposal's partial-unique). Without it Postgres throws 42P10.
      where: sql`source = 'system' AND origin_ref IS NOT NULL AND archived_at IS NULL`,
    })
    .returning({ id: tasks.id });

  // Dedup no-op: don't audit a create that didn't happen.
  if (!row) return { taskId: null };

  await new AuditService(tx, {
    ip: audit.ip,
    userAgent: audit.userAgent,
  }).log({
    orgId: input.orgId,
    actorId: audit.actorId ?? undefined,
    actorType: 'system',
    action: 'task.create',
    targetTable: 'tasks',
    targetId: row.id,
    afterState: { title: input.title, source: 'system' },
    sessionId: audit.sessionId,
  });

  return { taskId: row.id };
}
