/**
 * D.17 access-control policy — the SINGLE, declarative source of truth.
 *
 * ISO 27001 A.9.4 requires access rules to be documented, enforced and
 * verifiable. This module is the documented + enforced half; policy.spec
 * .ts is the verified half (an independent table pinned to D.17). Coarse
 * ROLE gating lives here (enforced centrally by AuthorizationGuard so it
 * cannot be forgotten in a new slice). RECORD-level scoping (agent →
 * assigned projects/tasks; note author; notification self) stays in the
 * service because it is data-shaped, not role-shaped — but a role that is
 * not even coarsely permitted never reaches that code.
 *
 * Roles (D.17 Tier-1 org users): manager / agent / viewer.
 */
export type Role = 'manager' | 'agent' | 'viewer';
export type Action = 'read' | 'create' | 'update' | 'delete';
export type Resource =
  | 'projects'
  | 'buildings'
  | 'apartments'
  | 'owners'
  | 'ownerships'
  | 'contractors'
  | 'shares'
  | 'tasks'
  | 'notifications'
  | 'notes'
  | 'audit'
  | 'project_assignments'
  | 'members'
  | 'documents'
  | 'signature_requests'
  | 'imports'
  | 'mapping_templates';

type Matrix = Record<Resource, Record<Action, readonly Role[]>>;

const M = 'manager' as const;
const A = 'agent' as const;
const V = 'viewer' as const;
const ALL = [M, A, V] as const; // any org role (record-scoping applied in service)
const MGR = [M] as const; // manager only
const MA = [M, A] as const; // manager + agent (viewer excluded)

/**
 * The locked D.17 matrix. Read = any org role (agent/contractor scoping is
 * applied per-record in the service). Writes = manager, EXCEPT where the
 * spec is finer: tasks.update (manager or assigned agent), notes write
 * (manager/agent; viewer excluded), notifications (any role, self only).
 */
export const POLICY: Matrix = {
  projects: { read: ALL, create: MGR, update: MGR, delete: MGR },
  // D.46 — buildings + apartments writes are coarsely opened to agents
  // (manager+agent); the FINE gate is enforced per-request in the service:
  // requireAgentCapability(tx, user, 'edit_project_data') AFTER the existing
  // assigned-project scoping. GUARDRAIL: every write endpoint on these cells
  // MUST call requireAgentCapability — else this loosening is a side door.
  // (owners stays manager-only until the owners-scoping follow-up.)
  buildings: { read: ALL, create: MA, update: MA, delete: MA },
  apartments: { read: ALL, create: MA, update: MA, delete: MA },
  // D.46 — owner EDIT (update/archive) opened to agents; the fine gate is
  // requireAgentCapability('edit_project_data') + PROJECT-scoping via the
  // ownership join (owner→ownerships→apartments→buildings→project ∈
  // assignments) in owners.service. CREATE stays manager-only: a bare new
  // owner is org-level with no ownership yet, so there is no project to
  // scope it to. GUARDRAIL: owners.update + owners.archive MUST call
  // requireAgentCapability + the owner project-scoping check.
  owners: { read: ALL, create: MGR, update: MA, delete: MA },
  // ownerships writes are an atomic PUT set-replace (D.25) → "update".
  ownerships: { read: ALL, create: MGR, update: MGR, delete: MGR },
  contractors: { read: ALL, create: MGR, update: MGR, delete: MGR },
  shares: { read: ALL, create: MGR, update: MGR, delete: MGR },
  // tasks.update: manager OR an assigned agent (the "assigned" half is
  // enforced per-record in the service).
  tasks: { read: ALL, create: MGR, update: MA, delete: MGR },
  // notifications are self-scoped by RLS — any role, only their own.
  notifications: { read: ALL, create: MGR, update: ALL, delete: MGR },
  // notes: manager/agent may author; manager-or-author may edit/delete
  // (author check per-record in service); viewer is read-only.
  notes: { read: ALL, create: MA, update: MA, delete: MA },
  audit: { read: MGR, create: MGR, update: MGR, delete: MGR },
  project_assignments: { read: ALL, create: MGR, update: MGR, delete: MGR },
  // Org membership administration — manager only, every action.
  members: { read: MGR, create: MGR, update: MGR, delete: MGR },
  // Documents: any org role may read (agent → assigned-project docs only,
  // record-scoped in the service). D.46 — WRITE (create/finalize/update/
  // archive) opened to agents; fine gate = requireAgentCapability(
  // 'manage_documents') AFTER the existing doc/project visibility scoping.
  // READ + DOWNLOAD stay `read: ALL` (download already agent-scoped to
  // assigned-project docs via loadVisible). GUARDRAIL: every documents write
  // method MUST call requireAgentCapability.
  documents: { read: ALL, create: MA, update: MA, delete: MA },
  // Signature requests (Phase 5, docs/03 §9): manager creates and cancels
  // (status transition; never DELETE — forensic evidence per migration
  // 0021). Any org role may read the list/status (record-scoping via the
  // underlying document for agents lives in the service). The actual
  // signing endpoint /sign/:token is PUBLIC (no auth, JWT is the
  // credential) and therefore bypasses this matrix entirely.
  signature_requests: { read: ALL, create: MGR, update: MGR, delete: MGR },
  // Imports (Phase 6, docs/03 §10): any org role may read job status/stream.
  // D.46 — WRITE (create / start / cancel / mapping) opened to agents; fine
  // gate = requireAgentCapability('run_imports') AFTER assertProjectVisible on
  // the job's projectId (NULLABLE — agent + null-project job = no-oracle 404).
  // create=POST, start+mapping=update (@AuthzAction),
  // cancel=delete. GUARDRAIL: all four import write methods MUST call
  // requireAgentCapability + the project-scope check. (The creator-only check
  // on start/cancel/mapping further scopes agents to their own jobs.)
  imports: { read: ALL, create: MA, update: MA, delete: MA },
  // D.34 mapping templates (saved column→canonical mappings). v6 audit
  // fix §9: declared as a FIRST-CLASS resource (was implicitly under
  // `imports` via the wizard endpoint). Forward-compat: when the
  // future Manager UI ships `GET /api/v1/mapping-templates` + archive,
  // it inherits this triple cleanly instead of hard-coding under
  // `imports`. Read = ALL (any org role can see the library — useful
  // for Viewer auditability of which template processed which import);
  // writes Manager-only (create/update/delete via wizard or future
  // dedicated UI). The actual mapping content is per-org via RLS on
  // mapping_templates (migration 0028 tenant_isolation FORCE).
  mapping_templates: { read: ALL, create: MGR, update: MGR, delete: MGR },
};

/** Pure decision: is this role coarsely permitted this action on this resource? */
export function can(role: Role, resource: Resource, action: Action): boolean {
  return POLICY[resource][action].includes(role);
}

// ───────────────────────────────────────────────────────────────────
// D.37 / D.49 — Provider-tier matrix.
//
// DELIBERATELY SEPARATE from the org-tier POLICY above. The Role
// type is org-only (`manager | agent | viewer`); the Provider tier
// has its OWN role enum (`provider_admin`) and its own JWT audience
// (`emapp-provider`, D.29). Mixing the two would let a future hand
// accidentally write a single rule that "applies to both tiers" —
// which is exactly the bug the tier separation was designed to make
// structurally impossible (docs/07 §8.1).
//
// D.49 (supersedes the D.37 read-only lock): Provider WRITE actions are
// now authorized — suspend/reactivate tenant, reset MFA, per-customer
// config — under hard controls (audit-first withProvider, access_reason
// required, distinct `write` action = least-privilege, NOT a widening of
// read). DESTRUCTIVE / irreversible actions (e.g. tenant data purge)
// remain OUT OF SCOPE pending a separate decision — do NOT add a third
// action here for them; open a new D.NN entry first.
// ───────────────────────────────────────────────────────────────────
export type ProviderRole = 'provider_admin';
export type ProviderResource = 'provider';
/**
 * `read` | `write` — D.49. `write` covers operational mutations
 * (suspend/reactivate, MFA reset, per-customer config). Do NOT add a
 * destructive/irreversible action (purge etc.) without a new D.NN entry
 * (D.49 authorizes operational writes only).
 */
export type ProviderAction = 'read' | 'write';

type ProviderMatrix = Record<ProviderResource, Record<ProviderAction, readonly ProviderRole[]>>;

const PROV_ADMIN = ['provider_admin'] as const;

export const PROVIDER_POLICY: ProviderMatrix = {
  // D.49 — provider_admin is the only Provider role today; it holds both
  // read and (operational) write. A future read-only role
  // (e.g. provider_billing_viewer) would get `read: PROV_ADMIN_AND_X,
  // write: PROV_ADMIN` — least-privilege stays expressible because the
  // two actions are distinct keys.
  provider: { read: PROV_ADMIN, write: PROV_ADMIN },
};

/** Pure decision for the Provider tier. Symmetric with `can()` but
 *  takes the tier-specific types — TypeScript prevents a caller from
 *  passing an org Role into a Provider check (and vice-versa). */
export function canProvider(
  role: ProviderRole,
  resource: ProviderResource,
  action: ProviderAction,
): boolean {
  return PROVIDER_POLICY[resource][action].includes(role);
}
