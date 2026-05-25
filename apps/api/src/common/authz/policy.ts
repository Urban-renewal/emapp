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
  buildings: { read: ALL, create: MGR, update: MGR, delete: MGR },
  apartments: { read: ALL, create: MGR, update: MGR, delete: MGR },
  owners: { read: ALL, create: MGR, update: MGR, delete: MGR },
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
  // record-scoped in the service); writes are manager-only. The presigned
  // URL is minted ONLY after this gate + per-record visibility pass.
  documents: { read: ALL, create: MGR, update: MGR, delete: MGR },
  // Signature requests (Phase 5, docs/03 §9): manager creates and cancels
  // (status transition; never DELETE — forensic evidence per migration
  // 0021). Any org role may read the list/status (record-scoping via the
  // underlying document for agents lives in the service). The actual
  // signing endpoint /sign/:token is PUBLIC (no auth, JWT is the
  // credential) and therefore bypasses this matrix entirely.
  signature_requests: { read: ALL, create: MGR, update: MGR, delete: MGR },
  // Imports (Phase 6, docs/03 §10): any org role may read job status/stream
  // (record-scoping is org-direct via RLS — same shape as projects). Writes
  // (enqueue / cancel) are manager-only; the SSE stream is a read, gated by
  // verb→action mapping. The actual file content stays in R2 keyed
  // off the import_jobs row — never on the wire.
  imports: { read: ALL, create: MGR, update: MGR, delete: MGR },
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
// D.37 / Phase 6.5 — Provider-tier matrix.
//
// DELIBERATELY SEPARATE from the org-tier POLICY above. The Role
// type is org-only (`manager | agent | viewer`); the Provider tier
// has its OWN role enum (`provider_admin`) and its own JWT audience
// (`emapp-provider`, D.29). Mixing the two would let a future hand
// accidentally write a single rule that "applies to both tiers" —
// which is exactly the bug the tier separation was designed to make
// structurally impossible (docs/07 §8.1).
//
// Resources here mirror the new /provider/* endpoint surface. All
// actions are READ-ONLY because D.37 explicitly defers any write to
// a separate Gate-6 decision. If a future endpoint ever needs to
// accept a write action, do not silently add it here — open a D.NN
// entry first.
// ───────────────────────────────────────────────────────────────────
export type ProviderRole = 'provider_admin';
export type ProviderResource = 'provider';
/** Only READ — D.37 invariant. NEVER widen without a D.NN entry. */
export type ProviderAction = 'read';

type ProviderMatrix = Record<ProviderResource, Record<ProviderAction, readonly ProviderRole[]>>;

const PROV_ADMIN = ['provider_admin'] as const;

export const PROVIDER_POLICY: ProviderMatrix = {
  provider: { read: PROV_ADMIN },
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
