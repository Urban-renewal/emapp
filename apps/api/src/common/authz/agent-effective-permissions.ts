import type { AgentCapabilities } from '@emapp/shared-types';

/**
 * B-AGENT-1 fix — the agent authorization "split-brain" closer.
 *
 * The engine ROLE layer grants the Agent role nearly every operational WRITE
 * permission (ALL_OPERATIONAL). But the services additionally enforce per-
 * membership CAPABILITY flags (default all-OFF) via `requireAgentCapability`,
 * and a few writes are `requireManager`-only with NO agent path at all. The FE
 * gates its write controls on `/me.permissions` (the role layer) → a normal
 * agent saw every write button ENABLED and got a 403 mid-flow on essentially
 * everything.
 *
 * The fix keeps the BE the single source of truth: `/me` emits the agent's
 * EFFECTIVE permissions (role ∧ capabilities, minus manager-only), so the FE's
 * existing `useHasPermission` gating matches the server's real enforcement.
 *
 * The two tables below MUST mirror the service gates. `agent-effective-
 * permissions.spec.ts` pins them against the live POLICY write-cells (a new
 * agent-write permission that isn't accounted for here fails the build).
 */

/**
 * Capability-gated WRITE permissions → the AgentCapability that unlocks them.
 * Mirrors the `requireAgentCapability(tx, user, '<cap>')` call in each service.
 */
export const AGENT_CAPABILITY_PERMISSIONS: Readonly<Record<string, keyof AgentCapabilities>> = {
  'buildings.create': 'edit_project_data',
  'buildings.update': 'edit_project_data',
  'buildings.archive': 'edit_project_data',
  'apartments.create': 'edit_project_data',
  'apartments.update': 'edit_project_data',
  'apartments.archive': 'edit_project_data',
  'owners.read': 'view_owners',
  'owners.update': 'edit_project_data',
  'owners.archive': 'edit_project_data',
  'documents.create': 'manage_documents',
  'documents.update': 'manage_documents',
  'documents.archive': 'manage_documents',
  'signature_requests.send': 'manage_signatures',
  'signature_requests.cancel': 'manage_signatures',
  'tasks.create': 'manage_tasks',
  'tasks.update': 'manage_tasks',
  'tasks.archive': 'manage_tasks',
  'imports.run': 'run_imports',
  'imports.cancel': 'run_imports',
  'imports.map': 'run_imports',
  'mapping_templates.manage': 'run_imports',
};

/**
 * Permissions the Agent ROLE grants but EVERY service blocks with
 * `requireManager` — there is no agent path (H1). Stripped unconditionally from
 * an agent's effective set so the FE never renders a permanently-dead button.
 */
export const AGENT_MANAGER_ONLY_PERMISSIONS: ReadonlySet<string> = new Set([
  'projects.update',
  'projects.archive',
  'ownerships.set',
  'contractors.create',
  'contractors.update',
  'contractors.archive',
  'shares.create',
  'shares.revoke',
]);

/**
 * Agent WRITE permissions that are intentionally NOT capability- or manager-
 * gated (a different scoping governs them) — so the drift test knows they're
 * deliberately effective for an agent. `notes.*` = D.17 AUTHORSHIP scoping.
 */
export const AGENT_NON_CAPABILITY_WRITES: ReadonlySet<string> = new Set([
  'notes.create',
  'notes.update',
  'notes.archive',
]);

/**
 * Compute an AGENT's effective permissions: their resolved ROLE permissions,
 * keeping a capability-gated write only if the matching flag is ON, and
 * dropping the manager-only writes entirely. Reads + non-gated writes pass
 * through. (Managers/viewers are not filtered — their role set IS effective.)
 */
export function effectiveAgentPermissions(
  rolePermissions: readonly string[],
  capabilities: AgentCapabilities | null,
): string[] {
  return rolePermissions.filter((p) => {
    if (AGENT_MANAGER_ONLY_PERMISSIONS.has(p)) return false;
    const cap = AGENT_CAPABILITY_PERMISSIONS[p];
    if (cap) return Boolean(capabilities?.[cap]);
    return true;
  });
}
