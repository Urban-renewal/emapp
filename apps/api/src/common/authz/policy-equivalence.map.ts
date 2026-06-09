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
 *   - `project_assignments.{create,update,delete}` → `project_assignments.manage`
 *     and `.read` → `project_assignments.read` (project-staffing is an OPERATIONAL
 *     act held by Manager+, NOT org-role governance — distinct from `roles.*`).
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

  // ── project_assignments → dedicated operational perms (Manager+ staffing) ──
  // read = ALL in-org (project_assignments.read); create/update/delete = MGR
  // (project_assignments.manage). NOT roles.* governance — staffing a project is
  // operational, distinct from org-role assignment.
  'project_assignments.read': 'project_assignments.read',
  'project_assignments.create': 'project_assignments.manage',
  'project_assignments.update': 'project_assignments.manage',
  'project_assignments.delete': 'project_assignments.manage',

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
 *       NOTE: project-assignment staffing is NOT in (A). It is an OPERATIONAL
 *       Manager act mapped to the dedicated `project_assignments.manage` (Manager
 *       holds it, Agent does NOT) — so Manager staffing and Agent reading both
 *       stay EQUAL to legacy, not divergent.
 *
 *   (B) MEMBER ADMINISTRATION stays with Manager (NO divergence). The
 *       owner-approved Gate-2/Gate-6 grant (migration 0053 + the system-roles
 *       MANAGER set) gives Manager members.invite/update/remove — the same cells
 *       legacy `policy.ts` gave Manager (`members: create/update/delete = MGR`).
 *       Engine === legacy on every member cell (write via the role permissions,
 *       read via the `export.run ⇒ members.read` §2 closure), so member admin
 *       contributes NO entries below. (Earlier this model removed member-write
 *       from Manager; that removal is reverted by this grant.)
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

  // ── (B) Member administration: Manager === legacy (NO divergence) ──────────
  // As of the owner-approved Gate-2/Gate-6 grant (migration 0053 + system-roles
  // MANAGER set), the Manager role holds members.invite/update/remove — exactly
  // as legacy `policy.ts` gave Manager (`members: { create/update/delete: MGR }`).
  // So these member-write cells now resolve engine === legacy and are NO LONGER
  // divergent; they are intentionally absent from this list. (ROLE administration
  // — roles.* — and org governance — org.* — remain Owner/Admin-only, but legacy
  // had no Manager-level grant there either, so they stay equal as well.)
  // Member READ also stays equal: Manager reaches members.read via the
  // `export.run ⇒ members.read` §2 closure.

  // NOTE: project_assignments create/update/delete (Manager) and read (Agent) are
  // NO LONGER divergent. They now resolve via the dedicated operational permissions
  // (project_assignments.manage / .read) which Manager and Agent respectively hold,
  // so engine === legacy EXACTLY (Manager staffs projects = legacy MGR; Agent reads
  // assignments = legacy read: ALL). They are intentionally absent from this list.

  // ── (C) GOVERNANCE READS stay Manager+ — Viewer/Agent do NOT widen ─────────
  // The earlier model widened Viewer (= every `*.read`) and Agent to hold the
  // GOVERNANCE reads `members.read` + `audit.read`, recorded here as a (C)
  // divergence. That was a least-privilege OVER-REACH (a read-only Viewer / a
  // scoped Agent could read the org's member roster + audit log) — caught by the
  // members contract + sidebar e2e tests. The Viewer/Agent roles now EXCLUDE the
  // governance reads (members/roles/audit/org), re-aligning with the legacy
  // `audit:MGR` / `members:MGR` matrix — so these cells are EQUAL, not divergent,
  // and are intentionally absent from this list. (Manager/Admin/Owner still reach
  // `members.read`/`audit.read` via the `export.run ⇒ <r>.read` closure.)
];
