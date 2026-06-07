import { memberships, projectAssignments, type TenantTx } from '@emapp/db';
import { and, eq, isNull } from 'drizzle-orm';

import { getOrgSettings } from '../../common/org-settings.resolver';

// ─────────────────────────────────────────────────────────────────────────
// resolveNotificationRecipients — THE single source of truth for WHO receives
// a notification (D-O7, the per-org-configurable-policy "Instance 1").
//
// Every emit site MUST resolve recipients through THIS helper — never hand-roll
// per-type recipient logic. The D-O7 OWNER POLICY (the shipped DEFAULT) is:
//
//   recipients =
//       (all ACTIVE org managers)               ← a manager always receives all
//     ∪ (ACTIVE project-assigned agents)        ← only when ctx.projectId given
//     ∪ (ctx.relevantUserIds ∩ ACTIVE members)  ← entity/action-relevant users,
//                                                 intersected with org membership
//     − ctx.actorUserId                         ← you aren't notified of your
//                                                 own action (managers too)
//   …deduped.
//
// MEMBERSHIP INVARIANT (recipient ∈ org) IS ENFORCED HERE. Caller-supplied
// `ctx.relevantUserIds` are NOT trusted: each is kept only if it is an ACTIVE
// member of `orgId` (any role) — a foreign-org or non-member id is DROPPED and
// can never become a recipient. This is the documented single source of truth
// for the producer's recipient∈org invariant; emit sites need not pre-validate.
//
// PER-ORG SEAM (open/closed): `getOrgSettings(tx, orgId).notifications` is read
// HERE so a future per-org override of the routing rule can change the resolved
// recipient set WITHOUT touching any emit site. For THIS slice no override key
// exists yet (the namespace only carries `defaultChannels`), so the resolved
// rule is exactly the D-O7 DEFAULT above. The read is wired now so the seam is
// real; we deliberately do NOT build a general rules engine — the default plus
// the read-seam IS the slice.
//
// ALL reads run inside the caller's org-scoped `tx` (RLS-pinned to `orgId`), so
// this never reaches across orgs. The helper returns ids only; the CALLER keeps
// the existing best-effort "a notification never throws / never affects the
// business response" wrapper around the subsequent emitMany. No PII is read or
// returned here (user ids only).
// ─────────────────────────────────────────────────────────────────────────

/** Context for a single notification's recipient resolution. */
export interface NotificationRecipientContext {
  /** Project-scoped events (document_uploaded, apartment_status_changed,
   *  note_added) pass the project id → its ACTIVE assigned agents are added. */
  projectId?: string | null;
  /** Entity/action events (share_revoked, import-complete) pass the users the
   *  action is relevant to. Caller-supplied and NOT trusted: each id is kept
   *  only if it is an ACTIVE member of `orgId` (intersected here); managers are
   *  still added on top by the rule. */
  relevantUserIds?: readonly string[];
  /** The user who performed the action — excluded from their OWN notification. */
  actorUserId: string;
}

/**
 * Active memberships of `orgId` (revoked excluded), read ONCE and reused for
 * BOTH the always-on manager set (Rule 3) AND the `relevantUserIds` org-
 * membership intersection (Rule 2). Single source / one query (DRY).
 *
 * Returns:
 *  - `managerIds` — active members whose role is 'manager' (the only oversight
 *    role; enum is manager|agent|viewer).
 *  - `memberIds`  — every active member id (any role), the org-membership set
 *    used to drop foreign / non-member `relevantUserIds`.
 */
async function activeMembers(
  tx: TenantTx,
  orgId: string,
): Promise<{ managerIds: string[]; memberIds: Set<string> }> {
  const rows = await tx
    .select({ userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), isNull(memberships.revokedAt)));

  const managerIds: string[] = [];
  const memberIds = new Set<string>();
  for (const r of rows) {
    memberIds.add(r.userId);
    if (r.role === 'manager') managerIds.push(r.userId);
  }
  return { managerIds, memberIds };
}

/** Active assignees of a project (project_assignments with unassigned_at NULL). */
async function activeProjectAssigneeIds(tx: TenantTx, projectId: string): Promise<string[]> {
  const rows = await tx
    .select({ userId: projectAssignments.userId })
    .from(projectAssignments)
    .where(
      and(eq(projectAssignments.projectId, projectId), isNull(projectAssignments.unassignedAt)),
    );
  return rows.map((r) => r.userId);
}

/**
 * Resolve the deduped recipient user-id list for a notification, per the D-O7
 * default rule (with the per-org config seam read for forward-compat). Returns
 * a `string[]` ready to pass to `NotificationsProducerService.emitMany`.
 *
 * Every emit site calls THIS — there is no per-type recipient code anywhere
 * else.
 */
export async function resolveNotificationRecipients(
  tx: TenantTx,
  orgId: string,
  ctx: NotificationRecipientContext,
): Promise<string[]> {
  // Read the per-org notifications config. For this slice the namespace carries
  // only `defaultChannels` (no routing-rule override yet), so resolution always
  // applies the D-O7 default below. Reading it now keeps the seam live: a future
  // per-org routing override changes recipients HERE, not at any emit site.
  await getOrgSettings(tx, orgId);

  const recipients = new Set<string>();

  // One active-membership read, reused for the manager set (Rule 3) AND the
  // relevantUserIds org-membership intersection (Rule 2).
  const { managerIds, memberIds } = await activeMembers(tx, orgId);

  // Rule 3: a manager ALWAYS receives every notification (org-wide oversight).
  for (const id of managerIds) recipients.add(id);

  // Rule 1: project-scoped events fan out to the project's active assignees.
  if (ctx.projectId) {
    for (const id of await activeProjectAssigneeIds(tx, ctx.projectId)) recipients.add(id);
  }

  // Rule 2: entity/action events add the users the action is relevant to —
  // but caller-supplied ids are intersected with active org membership, so a
  // foreign-org or non-member id is DROPPED (recipient∈org enforced here).
  for (const id of ctx.relevantUserIds ?? []) if (id && memberIds.has(id)) recipients.add(id);

  // Rule 4: the actor is excluded from their OWN action (managers included).
  recipients.delete(ctx.actorUserId);

  return [...recipients];
}
