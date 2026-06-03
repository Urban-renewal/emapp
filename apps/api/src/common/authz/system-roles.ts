/**
 * Enterprise IAM — the 6 SYSTEM roles + their permission sets (CODE).
 *
 * IAM-DESIGN §4. System roles are seeded, un-deletable, and have
 * `org_id IS NULL` (cross-org). This module is the SINGLE source of truth for
 * which permissions each system role holds — the seed (migration) inserts from
 * here, and the pinning test (`system-roles.spec.ts`) asserts each set EXACTLY
 * (red on drift).
 *
 * SLICE 1 — ADDITIVE. These sets are seeded into `roles` + `role_permissions`.
 * They do NOT yet drive enforcement (`policy.ts` is still live). The §4 table:
 *
 *   Owner          everything incl. billing, transfer, delete-org
 *   Admin          members, roles, settings, security_policy, ALL operational,
 *                  reveal_pii, export — NOT billing / transfer / delete-org
 *   Manager        ALL operational on scope, reveal_pii, export —
 *                  NOT members, roles, billing, security_policy
 *   Agent          read + scoped writes; reveal_pii iff granted (default OFF);
 *                  NOT project.create, owner.create, members, export
 *   Viewer         read only, PII masked — NOT every write, NOT reveal_pii
 *   External-Read  read of the shared subset, NO owner PII — nothing else
 *
 * §4 note: `reveal_pii` + `export.run` are DISCRETE, removable permissions —
 * seeded ON for Manager/Admin by default (MVP usability), removable per-org
 * later. They are NOT a hardcoded blanket.
 */
import { PERMISSIONS, type Permission } from './permissions';

export const SYSTEM_ROLE_KEYS = [
  'owner',
  'admin',
  'manager',
  'agent',
  'viewer',
  'external_read',
] as const;

export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export interface SystemRoleDef {
  key: SystemRoleKey;
  name: string;
  description: string;
  /** The exact permission set (resolved below). */
  permissions: readonly Permission[];
}

/** Every permission that ends in `.read` — the read surface. */
const ALL_READS: readonly Permission[] = PERMISSIONS.filter((p) => p.endsWith('.read'));

/**
 * "ALL operational" = everything EXCEPT the org-admin governance permissions
 * (members, roles, org.*). This is the Manager surface before reveal_pii/export
 * are layered back on. We derive it so it can never drift from the catalog.
 */
const GOVERNANCE_PREFIXES = ['members.', 'roles.', 'org.'] as const;
const ALL_OPERATIONAL: readonly Permission[] = PERMISSIONS.filter(
  (p) => !GOVERNANCE_PREFIXES.some((g) => p.startsWith(g)),
);

// ── Owner: everything ──────────────────────────────────────────────────────
const OWNER: readonly Permission[] = [...PERMISSIONS];

// ── Admin: ALL operational + members + roles + settings + security_policy +
//    reveal_pii + export. NOT billing / transfer / delete-org. ──────────────
const ADMIN: readonly Permission[] = [
  ...ALL_OPERATIONAL, // includes owners.reveal_pii + export.run (operational, non-governance)
  'members.read',
  'members.invite',
  'members.update',
  'members.remove',
  'roles.read',
  'roles.assign',
  'roles.revoke',
  'roles.manage',
  'org.settings.read',
  'org.settings.update',
  'org.security_policy.manage',
  // explicitly NOT: org.billing.manage, org.transfer_ownership, org.delete
];

// ── Manager: ALL operational on scope, incl. reveal_pii + export.
//    NOT members, roles, billing, security_policy (i.e. no governance). ──────
const MANAGER: readonly Permission[] = [...ALL_OPERATIONAL];

// ── Agent: read + scoped writes; reveal_pii iff granted (DEFAULT OFF → not in
//    the seeded set); NOT projects.create, owners.create, members, export. ──
const AGENT_EXCLUDE = new Set<Permission>([
  'projects.create',
  'owners.create',
  'owners.reveal_pii', // granted per-assignment later, not by default (§4)
  'export.run',
  'project_assignments.manage', // staffing projects is a Manager act, not Agent (legacy MGR)
]);
const AGENT: readonly Permission[] = ALL_OPERATIONAL.filter(
  (p) => !AGENT_EXCLUDE.has(p) && !p.startsWith('org.'),
);

// ── Viewer: read only, every resource, PII masked (no reveal_pii). ─────────
const VIEWER: readonly Permission[] = ALL_READS.filter((p) => p !== 'owners.reveal_pii');

// ── External-Read: read of the shared subset, NO owner PII. The shared subset
//    is the project-facing read surface a stakeholder (contractor/lawyer/bank)
//    sees — projects/buildings/apartments/documents/signature status — but
//    NEVER owners (PII) and never org/members/roles/audit/stats internals. ──
const EXTERNAL_READ_ALLOW = new Set<Permission>([
  'projects.read',
  'buildings.read',
  'apartments.read',
  'documents.read',
  'documents.download',
  'signature_requests.read',
]);
const EXTERNAL_READ: readonly Permission[] = PERMISSIONS.filter((p) => EXTERNAL_READ_ALLOW.has(p));

export const SYSTEM_ROLES: readonly SystemRoleDef[] = [
  {
    key: 'owner',
    name: 'Owner',
    description: 'Full control including billing, ownership transfer, and org deletion.',
    permissions: OWNER,
  },
  {
    key: 'admin',
    name: 'Admin',
    description:
      'Members, roles, settings, security policy, and all operational actions (incl. reveal PII + export). No billing/transfer/delete-org.',
    permissions: ADMIN,
  },
  {
    key: 'manager',
    name: 'Manager',
    description:
      'All operational actions on scope, including reveal PII and export. No member/role administration.',
    permissions: MANAGER,
  },
  {
    key: 'agent',
    name: 'Agent',
    description:
      'Read plus scoped writes on assigned projects. No project/owner creation, no export; reveal PII only if granted per assignment.',
    permissions: AGENT,
  },
  {
    key: 'viewer',
    name: 'Viewer',
    description: 'Read-only across the org. PII masked (no reveal).',
    permissions: VIEWER,
  },
  {
    key: 'external_read',
    name: 'External-Read',
    description:
      'Project-scoped read of the shared subset for external stakeholders. No owner PII, no internals.',
    permissions: EXTERNAL_READ,
  },
];

/** Lookup by key. */
export const SYSTEM_ROLE_BY_KEY: ReadonlyMap<SystemRoleKey, SystemRoleDef> = new Map(
  SYSTEM_ROLES.map((r) => [r.key, r]),
);

/**
 * Maps the legacy `memberships.role` (D.17 enum: manager|agent|viewer) → the
 * system role key the backfill assigns at org scope. (Owner/Admin/External-Read
 * have no legacy equivalent — they are introduced by this model.)
 */
export const LEGACY_ROLE_TO_SYSTEM_KEY: Readonly<
  Record<'manager' | 'agent' | 'viewer', SystemRoleKey>
> = {
  manager: 'manager',
  agent: 'agent',
  viewer: 'viewer',
};
