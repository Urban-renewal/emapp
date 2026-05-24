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
  | 'imports';

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
};

/** Pure decision: is this role coarsely permitted this action on this resource? */
export function can(role: Role, resource: Resource, action: Action): boolean {
  return POLICY[resource][action].includes(role);
}
