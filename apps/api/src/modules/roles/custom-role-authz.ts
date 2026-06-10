/**
 * Custom-role anti-escalation boundary — the SECURITY CORE of P2 Phase 1.
 *
 * Org-custom roles let an Owner/Admin define their own named permission groups.
 * Without guardrails this is a direct privilege-escalation surface: an actor
 * could mint a role granting a permission they don't hold (vertical escalation)
 * or a role that can mint MORE roles / transfer the org (governance capture).
 * These pure functions are the airtight boundary the controller/service call on
 * EVERY create and EVERY permission-changing update. Pure (no I/O) so they are
 * exhaustively unit-testable and impossible to bypass with a stubbed DB.
 *
 * THE EXACT RULES (documented boundary — the reviewer's attack surface):
 *
 *  R1. CATALOG. Every requested permission MUST be a real catalog permission
 *      (`PERMISSION_SET`). A non-catalog string is rejected (no inventing a
 *      future-open-door permission, no typo that silently grants nothing).
 *
 *  R2. SUBSET (no vertical escalation). The requested set MUST be a subset of
 *      the CREATING ACTOR's IMPLICATION-EXPANDED effective permissions on the
 *      org scope. You can never grant a permission you do not yourself hold.
 *      We compare against the expanded set so an actor who holds a child
 *      (e.g. `owners.reveal_pii` ⇒ `owners.read`) may grant the parent.
 *
 *  R3. GOVERNANCE BOUNDARY (no governance capture). `roles.*` and `org.*`
 *      permissions are GOVERNANCE — the ability to mint/assign roles or to
 *      administer/transfer/delete the org. A custom role may include them ONLY
 *      when the actor is an Owner. So:
 *        - An ADMIN (who holds `roles.manage`/`roles.assign` themselves) still
 *          CANNOT bake `roles.*` or `org.*` into a custom role — preventing an
 *          Admin from minting a "super-role" that hands governance to anyone it
 *          is assigned to.
 *        - Even an OWNER is still bound by R1+R2; the governance carve-out only
 *          LIFTS R3 for them, it does not bypass the subset rule.
 *
 * Note R3 is intentionally STRICTER than R2 alone: governance permissions are
 * gated by actor-tier (Owner), not merely by "do you hold it". This is the
 * difference between "I can assign roles" (an operational act, audited) and "I
 * can manufacture a role that assigns roles" (a standing escalation primitive).
 */
import { PERMISSION_SET, type Permission } from '../../common/authz/permissions';

/** Permission prefixes that constitute org GOVERNANCE (Owner-only in a custom role). */
export const GOVERNANCE_PREFIXES = ['roles.', 'org.'] as const;

/** Owner-exclusive permissions — only the Owner system role holds BOTH. */
const OWNER_MARKERS: readonly Permission[] = ['org.transfer_ownership', 'org.delete'];

/** Is a permission a governance permission (roles.* / org.*)? */
export function isGovernancePermission(perm: string): boolean {
  return GOVERNANCE_PREFIXES.some((p) => perm.startsWith(p));
}

/**
 * Is the actor an Owner? Tested by the Owner-exclusive marker permissions
 * (`org.transfer_ownership` AND `org.delete`) — only the Owner role holds both,
 * so this is a precise tier check that does not depend on role-name lookup.
 * (Same technique as `PermissionService.canAssignRole`.)
 */
export function actorIsOwner(effective: ReadonlySet<Permission>): boolean {
  return OWNER_MARKERS.every((m) => effective.has(m));
}

/** A boundary violation — carries the offending permissions + the reason code. */
export type RolePermissionViolation =
  | { code: 'unknown_permission'; permissions: string[] }
  | { code: 'permission_not_held'; permissions: string[] }
  | { code: 'governance_owner_only'; permissions: string[] };

/**
 * The full boundary check for a requested permission set. Returns `null` when
 * the set is allowed for this actor, or the FIRST violation otherwise (the
 * caller maps it to a 422 with the offending permissions — never silently
 * trims, so the operator learns exactly what was rejected and why).
 *
 * Order matters: catalog (R1) before subset (R2) before governance (R3), so a
 * non-catalog string is reported as `unknown_permission` rather than masquerad-
 * ing as "not held".
 *
 * @param requested  the permissions the actor wants the custom role to grant.
 * @param actorEffective  the actor's implication-expanded effective set on the
 *   org scope (from `PermissionService.effectivePermissions`).
 */
export function checkCustomRolePermissions(
  requested: readonly string[],
  actorEffective: ReadonlySet<Permission>,
): RolePermissionViolation | null {
  // Dedupe defensively; the wire shape allows repeats.
  const unique = [...new Set(requested)];

  // R1 — catalog membership.
  const unknown = unique.filter((p) => !PERMISSION_SET.has(p as Permission));
  if (unknown.length > 0) return { code: 'unknown_permission', permissions: unknown.sort() };

  // R3 — governance boundary (Owner-only). Checked before the generic subset
  // rule so an Admin who DOES hold `roles.manage` gets the precise
  // `governance_owner_only` signal (not a misleading "not held").
  if (!actorIsOwner(actorEffective)) {
    const governance = unique.filter(isGovernancePermission);
    if (governance.length > 0) {
      return { code: 'governance_owner_only', permissions: governance.sort() };
    }
  }

  // R2 — subset: every requested permission must be one the actor holds.
  const notHeld = unique.filter((p) => !actorEffective.has(p as Permission));
  if (notHeld.length > 0) return { code: 'permission_not_held', permissions: notHeld.sort() };

  return null;
}

/**
 * The boundary for ASSIGNING an existing role (system or custom) to a member —
 * R1 (catalog) + R2 (subset) ONLY. It deliberately OMITS the R3 governance
 * Owner-only block, because R3 governs MINTING a role (don't let an Admin bake
 * governance into a NEW custom role); for assignment, the subset rule alone is
 * the correct anti-escalation guard (you can't grant a role carrying a
 * permission you lack), and system roles legitimately contain governance reads
 * (Viewer holds `roles.read` / `org.settings.read`) that an Admin must be able
 * to assign. The Owner/Admin TIER guard (only an Owner may grant Owner/Admin) is
 * applied SEPARATELY by the caller. Returns `null` if assignable, else the first
 * violation.
 */
export function checkRoleAssignable(
  rolePermissions: readonly string[],
  actorEffective: ReadonlySet<Permission>,
): RolePermissionViolation | null {
  const unique = [...new Set(rolePermissions)];
  const unknown = unique.filter((p) => !PERMISSION_SET.has(p as Permission));
  if (unknown.length > 0) return { code: 'unknown_permission', permissions: unknown.sort() };
  const notHeld = unique.filter((p) => !actorEffective.has(p as Permission));
  if (notHeld.length > 0) return { code: 'permission_not_held', permissions: notHeld.sort() };
  return null;
}
