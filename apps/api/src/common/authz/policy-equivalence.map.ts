/**
 * Enterprise IAM — the legacy↔engine EQUIVALENCE map (IAM-DESIGN §6 / §10).
 * Slice 3 — PURELY ADDITIVE. A mapping const + the shadow-equivalence test
 * (`policy-equivalence.spec.ts`) are the ONLY things this slice adds. No
 * behaviour changes: `policy.ts` is still the live enforcer, the engine is
 * still unwired (cutover is slice 5). This file is the safety net that lets
 * the cutover be safe — it proves the new `PermissionService` returns the
 * SAME decision as the old `policy.ts` matrix for EVERY (role, resource,
 * action) cell, and pins every place the two INTENTIONALLY diverge.
 *
 * Three structures live here:
 *
 *   1. `LEGACY_TO_PERMISSION` — for each legacy `(resource, action)` POLICY
 *      cell, the new permission key the engine checks (`projects.create →
 *      'projects.create'`, `signature_requests.create → 'signature_requests
 *      .send'`, `ownerships.update → 'ownerships.set'`, …). EVERY POLICY cell
 *      is covered; a missing cell fails the test (no silent gap).
 *
 *   2. `NO_ENGINE_EQUIVALENT` — legacy cells that have NO new-model permission
 *      by design (the new catalog deliberately dropped them). The test asserts
 *      these are exactly the cells with no mapping — an UNLISTED unmapped cell
 *      fails (so you cannot silently forget to map a real cell).
 *
 *   3. `KNOWN_DIVERGENCES` — the cells where `policy.can(role,…)` and
 *      `engine.can(user@role,…)` INTENTIONALLY disagree, each with a direction
 *      (`legacy` / `new`) and a documented reason. The test asserts these — and
 *      ONLY these — diverge, in the stated direction. Any UNLISTED divergence is
 *      a real regression and fails CI.
 */
import type { Permission } from './permissions';
import type { Action, Resource } from './policy';

/** A legacy POLICY cell — the unit the shadow proof iterates over. */
export interface LegacyCell {
  resource: Resource;
  action: Action;
}

/** `"resource.action"` — the stable string key for a legacy cell. */
export type LegacyCellKey = `${Resource}.${Action}`;

export function cellKey(resource: Resource, action: Action): LegacyCellKey {
  return `${resource}.${action}` as LegacyCellKey;
}

/**
 * Legacy `(resource, action)` → new permission key.
 *
 * EVERY cell of POLICY (17 resources × 4 actions = 68 cells) is either here or
 * in `NO_ENGINE_EQUIVALENT`. The verb mapping follows the new catalog
 * (`permissions.ts`):
 *   - `delete` (legacy soft-delete = archive, D.16) → `<r>.archive`.
 *   - `signature_requests.create` → `.send`; `.update` (cancel transition) +
 *     `.delete` → `.cancel` (the only mutate-after-send the catalog models).
 *   - `ownerships.{create,update,delete}` → the single atomic `ownerships.set`
 *     (D.25 100% set-replace — one permission, not a CRUD quad).
 *   - `members.{create,update,delete}` → `members.{invite,update,remove}`.
 *   - `project_assignments.*` → `roles.*` (a project assignment IS a
 *     project-scoped role assignment in the new model, §3/§7).
 *   - `imports.{create,update,delete}` → `imports.{run,map,cancel}`.
 *   - `mapping_templates` writes → the single `mapping_templates.manage`.
 */
export const LEGACY_TO_PERMISSION: Readonly<Partial<Record<LegacyCellKey, Permission>>> = {
  // ── projects · buildings · apartments (CRUD → read/create/update/archive) ──
  'projects.read': 'projects.read',
  'projects.create': 'projects.create',
  'projects.update': 'projects.update',
  'projects.delete': 'projects.archive',
  'buildings.read': 'buildings.read',
  'buildings.create': 'buildings.create',
  'buildings.update': 'buildings.update',
  'buildings.delete': 'buildings.archive',
  'apartments.read': 'apartments.read',
  'apartments.create': 'apartments.create',
  'apartments.update': 'apartments.update',
  'apartments.delete': 'apartments.archive',

  // ── owners ────────────────────────────────────────────────────────────────
  'owners.read': 'owners.read',
  'owners.create': 'owners.create',
  'owners.update': 'owners.update',
  'owners.delete': 'owners.archive',

  // ── ownerships — atomic 100% set-replace (D.25): one permission ────────────
  'ownerships.read': 'ownerships.read',
  'ownerships.create': 'ownerships.set',
  'ownerships.update': 'ownerships.set',
  'ownerships.delete': 'ownerships.set',

  // ── contractors ────────────────────────────────────────────────────────────
  'contractors.read': 'contractors.read',
  'contractors.create': 'contractors.create',
  'contractors.update': 'contractors.update',
  'contractors.delete': 'contractors.archive',

  // ── shares — create + revoke only (no read/update permission in catalog) ───
  'shares.create': 'shares.create',
  'shares.delete': 'shares.revoke',

  // ── tasks ───────────────────────────────────────────────────────────────────
  'tasks.read': 'tasks.read',
  'tasks.create': 'tasks.create',
  'tasks.update': 'tasks.update',
  'tasks.delete': 'tasks.archive',

  // ── notes ───────────────────────────────────────────────────────────────────
  'notes.read': 'notes.read',
  'notes.create': 'notes.create',
  'notes.update': 'notes.update',
  'notes.delete': 'notes.archive',

  // ── audit — read only in the catalog (append-only; no user write perms) ────
  'audit.read': 'audit.read',

  // ── project_assignments → roles.* (project assignment = scoped role grant) ─
  'project_assignments.read': 'roles.read',
  'project_assignments.create': 'roles.assign',
  'project_assignments.update': 'roles.assign',
  'project_assignments.delete': 'roles.revoke',

  // ── members → invite/update/remove ─────────────────────────────────────────
  'members.read': 'members.read',
  'members.create': 'members.invite',
  'members.update': 'members.update',
  'members.delete': 'members.remove',

  // ── documents ───────────────────────────────────────────────────────────────
  'documents.read': 'documents.read',
  'documents.create': 'documents.create',
  'documents.update': 'documents.update',
  'documents.delete': 'documents.archive',

  // ── signature_requests — send / cancel ─────────────────────────────────────
  'signature_requests.read': 'signature_requests.read',
  'signature_requests.create': 'signature_requests.send',
  'signature_requests.update': 'signature_requests.cancel',
  'signature_requests.delete': 'signature_requests.cancel',

  // ── imports — run / map / cancel ───────────────────────────────────────────
  'imports.read': 'imports.read',
  'imports.create': 'imports.run',
  'imports.update': 'imports.map',
  'imports.delete': 'imports.cancel',

  // ── mapping_templates — read + the single manage write ─────────────────────
  'mapping_templates.read': 'mapping_templates.read',
  'mapping_templates.create': 'mapping_templates.manage',
  'mapping_templates.update': 'mapping_templates.manage',
  'mapping_templates.delete': 'mapping_templates.manage',
};

/**
 * Legacy cells with NO new-model permission BY DESIGN (the new catalog
 * deliberately dropped them). These are EXCLUDED from the equality proof — but
 * the test asserts the unmapped set equals EXACTLY this list, so a real cell
 * that merely got forgotten cannot hide here.
 */
export const NO_ENGINE_EQUIVALENT: ReadonlyArray<{
  key: LegacyCellKey;
  reason: string;
}> = [
  {
    key: 'shares.read',
    reason:
      'No `shares.read` in the catalog — share visibility folds under contractor/project read in the new model (a share is a contractor delivery channel, not a separately-listed resource).',
  },
  {
    key: 'shares.update',
    reason:
      'Shares are create + revoke only (catalog has `shares.create` / `shares.revoke`). There is no in-place share edit — you revoke and re-issue.',
  },
  {
    key: 'notifications.read',
    reason:
      'Notifications are self-scoped by RLS (own rows only) — NOT an authz-role surface. The new catalog deliberately has no `notifications.*` permission (self-service, not role-gated).',
  },
  {
    key: 'notifications.create',
    reason:
      'See notifications.read — notifications are not a role-permission surface (RLS self-scope).',
  },
  {
    key: 'notifications.update',
    reason: 'See notifications.read — mark-as-read is self-service, not a role permission.',
  },
  {
    key: 'notifications.delete',
    reason:
      'See notifications.read — notifications are not a role-permission surface (RLS self-scope).',
  },
  {
    key: 'audit.create',
    reason:
      'The audit log is append-only and written by the SYSTEM, never by a user action. The catalog has `audit.read` only — there is no user-grantable audit-write permission.',
  },
  {
    key: 'audit.update',
    reason: 'Audit is append-only/immutable — no update permission exists or should exist.',
  },
  {
    key: 'audit.delete',
    reason: 'Audit is append-only/immutable — no delete permission exists or should exist.',
  },
];

/** The direction a documented divergence points. */
export type DivergenceDirection =
  | 'legacy' // legacy ALLOWS, new model DENIES (privilege the new model removes)
  | 'new'; // legacy DENIES, new model ALLOWS (privilege the new model adds)

export interface KnownDivergence {
  role: 'manager' | 'agent' | 'viewer';
  resource: Resource;
  action: Action;
  /** The new permission the engine checks for this cell. */
  permission: Permission;
  /** Who decides this cell after cutover: 'legacy'=old wins, 'new'=engine wins. */
  direction: DivergenceDirection;
  reason: string;
}

/**
 * The EXACT set of cells where the new engine intentionally disagrees with the
 * legacy `policy.ts` matrix. The test asserts these — and ONLY these — diverge,
 * in the stated direction; an unlisted divergence is a real regression and
 * fails CI. Three model changes produce every entry below:
 *
 *   (A) AGENT operational writes: capabilities → role permissions.
 *       Legacy agent writes were a COARSE `manager+agent` gate further gated by
 *       a RUNTIME capability that is OFF by default (D.46 `edit_project_data`,
 *       `manage_tasks`, … — or the resource was manager-only entirely). So the
 *       legacy *coarse* answer for an agent on these writes is `false` (no
 *       capability). The new AGENT ROLE holds these operational permissions
 *       outright (capabilities collapse into role permissions, IAM §4). Hence
 *       legacy=false → new=true. This is the EXPECTED model change the slice
 *       exists to certify. Every such cell is listed below (direction 'new').
 *
 *   (B) GOVERNANCE WRITE moves Manager → Admin/Owner. In the new taxonomy (§4)
 *       member + role ADMINISTRATION (invite/update/remove, assign/revoke) is an
 *       Admin/Owner surface; the MANAGER role holds no governance WRITE. Legacy
 *       `policy.ts` gave Manager those write cells. So they go legacy=true →
 *       new=false (direction 'legacy'). Governance READ does NOT diverge for
 *       Manager: it holds `export.run`, which `⇒ members.read` + `⇒ roles.read`
 *       via the §2 closure, so the read decisions stay equivalent — only the
 *       writes move. (Agent's `project_assignments.read → roles.read` DOES
 *       diverge: Agent lacks `export.run`, so it loses the implied roles.read.)
 *
 *   (C) READ surface widens to "all reads". The new Viewer = every `*.read`
 *       (PII masked). Legacy restricted `members.read` + `audit.read` to
 *       Manager only. So Viewer/Agent GAIN those reads under the new model
 *       (legacy=false → new=true, direction 'new').
 */
export const KNOWN_DIVERGENCES: readonly KnownDivergence[] = [
  // ── (A) Agent operational writes: capability → role permission ─────────────
  {
    role: 'agent',
    resource: 'projects',
    action: 'update',
    permission: 'projects.update',
    direction: 'new',
    reason:
      '(A) Legacy: project writes were manager-only; an agent never coarsely held projects.update. New: the Agent role holds projects.update (operational write on assigned scope). Agent still LACKS projects.create (excluded in system-roles).',
  },
  {
    role: 'agent',
    resource: 'projects',
    action: 'delete',
    permission: 'projects.archive',
    direction: 'new',
    reason:
      '(A) Legacy: project archive was manager-only. New: the Agent role holds projects.archive (scoped operational write).',
  },
  {
    role: 'agent',
    resource: 'ownerships',
    action: 'create',
    permission: 'ownerships.set',
    direction: 'new',
    reason:
      '(A) Legacy: ownerships set-replace was manager-only. New: the Agent role holds ownerships.set (scoped operational write).',
  },
  {
    role: 'agent',
    resource: 'ownerships',
    action: 'update',
    permission: 'ownerships.set',
    direction: 'new',
    reason:
      '(A) Legacy: ownerships set-replace was manager-only. New: the Agent role holds ownerships.set.',
  },
  {
    role: 'agent',
    resource: 'ownerships',
    action: 'delete',
    permission: 'ownerships.set',
    direction: 'new',
    reason:
      '(A) Legacy: ownerships set-replace was manager-only. New: the Agent role holds ownerships.set.',
  },
  {
    role: 'agent',
    resource: 'contractors',
    action: 'create',
    permission: 'contractors.create',
    direction: 'new',
    reason:
      '(A) Legacy: contractor writes were manager-only. New: the Agent role holds contractors.create (scoped operational write).',
  },
  {
    role: 'agent',
    resource: 'contractors',
    action: 'update',
    permission: 'contractors.update',
    direction: 'new',
    reason:
      '(A) Legacy: contractor writes were manager-only. New: the Agent role holds contractors.update.',
  },
  {
    role: 'agent',
    resource: 'contractors',
    action: 'delete',
    permission: 'contractors.archive',
    direction: 'new',
    reason:
      '(A) Legacy: contractor writes were manager-only. New: the Agent role holds contractors.archive.',
  },
  {
    role: 'agent',
    resource: 'shares',
    action: 'create',
    permission: 'shares.create',
    direction: 'new',
    reason:
      '(A) Legacy: share issuance was manager-only. New: the Agent role holds shares.create (scoped operational write).',
  },
  {
    role: 'agent',
    resource: 'shares',
    action: 'delete',
    permission: 'shares.revoke',
    direction: 'new',
    reason: '(A) Legacy: share revoke was manager-only. New: the Agent role holds shares.revoke.',
  },
  {
    role: 'agent',
    resource: 'signature_requests',
    action: 'delete',
    permission: 'signature_requests.cancel',
    direction: 'new',
    reason:
      '(A) Legacy: signature DELETE (cancel) was manager-only. New: the Agent role holds signature_requests.cancel (it already coarsely held create/update via D.46; the new role makes cancel symmetric).',
  },
  {
    role: 'agent',
    resource: 'mapping_templates',
    action: 'create',
    permission: 'mapping_templates.manage',
    direction: 'new',
    reason:
      '(A) Legacy: mapping-template writes were manager-only. New: the Agent role holds mapping_templates.manage (it runs imports, so it manages the templates they use).',
  },
  {
    role: 'agent',
    resource: 'mapping_templates',
    action: 'update',
    permission: 'mapping_templates.manage',
    direction: 'new',
    reason:
      '(A) Legacy: mapping-template writes were manager-only. New: the Agent role holds mapping_templates.manage.',
  },
  {
    role: 'agent',
    resource: 'mapping_templates',
    action: 'delete',
    permission: 'mapping_templates.manage',
    direction: 'new',
    reason:
      '(A) Legacy: mapping-template writes were manager-only. New: the Agent role holds mapping_templates.manage.',
  },

  // ── (B) Governance WRITE moves Manager → Admin/Owner ───────────────────────
  // NOTE the asymmetry: Manager still *reads* members + project_assignments
  // (those are EQUAL, not divergent) — the Manager role holds `export.run`,
  // which `⇒ members.read` + `⇒ roles.read` via the §2 implication closure
  // (`permissions.ts` READABLE_RESOURCES). So only the WRITE governance cells
  // diverge for Manager; the read cells stay equivalent. This is exactly the
  // kind of subtlety the equivalence proof exists to surface.
  {
    role: 'manager',
    resource: 'members',
    action: 'create',
    permission: 'members.invite',
    direction: 'legacy',
    reason:
      '(B) Legacy: Manager could invite members. New: members.invite is Admin/Owner only (§4).',
  },
  {
    role: 'manager',
    resource: 'members',
    action: 'update',
    permission: 'members.update',
    direction: 'legacy',
    reason:
      '(B) Legacy: Manager could update members. New: members.update is Admin/Owner only (§4).',
  },
  {
    role: 'manager',
    resource: 'members',
    action: 'delete',
    permission: 'members.remove',
    direction: 'legacy',
    reason:
      '(B) Legacy: Manager could remove members. New: members.remove is Admin/Owner only (§4).',
  },
  {
    role: 'manager',
    resource: 'project_assignments',
    action: 'create',
    permission: 'roles.assign',
    direction: 'legacy',
    reason:
      '(B) Legacy: Manager could assign agents to projects. New: roles.assign is Admin/Owner only (§4).',
  },
  {
    role: 'manager',
    resource: 'project_assignments',
    action: 'update',
    permission: 'roles.assign',
    direction: 'legacy',
    reason:
      '(B) Legacy: Manager could update project assignments. New: roles.assign is Admin/Owner only (§4).',
  },
  {
    role: 'manager',
    resource: 'project_assignments',
    action: 'delete',
    permission: 'roles.revoke',
    direction: 'legacy',
    reason:
      '(B) Legacy: Manager could remove project assignments. New: roles.revoke is Admin/Owner only (§4).',
  },
  {
    role: 'agent',
    resource: 'project_assignments',
    action: 'read',
    permission: 'roles.read',
    direction: 'legacy',
    reason:
      '(B) Legacy: an agent could read project assignments (it was `read: ALL`). New: roles.read is an Admin/Owner governance permission — the Agent role lacks it (§4).',
  },

  // ── (C) Read surface widens to "all reads" (Viewer / Agent gain) ───────────
  {
    role: 'viewer',
    resource: 'members',
    action: 'read',
    permission: 'members.read',
    direction: 'new',
    reason:
      '(C) Legacy: members.read was Manager-only. New: Viewer = every `*.read` (PII masked), so Viewer gains members.read (org roster visibility; no PII). NOTE this is the read-widen change, distinct from (B) which removes Manager WRITE governance.',
  },
  {
    role: 'agent',
    resource: 'audit',
    action: 'read',
    permission: 'audit.read',
    direction: 'new',
    reason:
      '(C) Legacy: audit.read was Manager-only. New: audit.read is part of the all-reads surface the Agent role holds. (Row-level audit scope is enforced separately; this is the coarse permission only.)',
  },
  {
    role: 'viewer',
    resource: 'audit',
    action: 'read',
    permission: 'audit.read',
    direction: 'new',
    reason:
      '(C) Legacy: audit.read was Manager-only. New: Viewer = every `*.read`, so the Viewer role holds audit.read.',
  },
];
