/**
 * B-AGENT-1 — pins the agent effective-permissions filter against the live
 * POLICY so the "split-brain" (FE shows a write button the BE 403s) can never
 * silently return: if a NEW agent-write permission is added but not accounted
 * for in the filter, the DRIFT GUARD below fails the build.
 */
import { AGENT_CAPABILITY_KEYS, type AgentCapabilities } from '@emapp/shared-types';
import { describe, expect, it } from 'vitest';

import {
  AGENT_CAPABILITY_PERMISSIONS,
  AGENT_MANAGER_ONLY_PERMISSIONS,
  AGENT_NON_CAPABILITY_WRITES,
  effectiveAgentPermissions,
} from './agent-effective-permissions';
import { PERMISSIONS } from './permissions';
import { SYSTEM_ROLES } from './system-roles';

const PERM_SET = new Set<string>(PERMISSIONS);
const CAP_SET = new Set<string>(AGENT_CAPABILITY_KEYS);
const AGENT_PERMS = SYSTEM_ROLES.find((r) => r.key === 'agent')!.permissions as readonly string[];

const WRITE_ACTIONS = new Set([
  'create',
  'update',
  'archive',
  'set',
  'send',
  'cancel',
  'run',
  'map',
  'revoke',
  'delete',
  'manage',
]);
const isWrite = (p: string): boolean => WRITE_ACTIONS.has(p.slice(p.lastIndexOf('.') + 1));

const allOff: AgentCapabilities = {
  edit_project_data: false,
  manage_documents: false,
  manage_signatures: false,
  manage_tasks: false,
  run_imports: false,
  view_owners: false,
  view_owner_pii: false,
};

describe('agent effective-permissions map — validity', () => {
  it('every capability-gated permission is a real Permission', () => {
    for (const p of Object.keys(AGENT_CAPABILITY_PERMISSIONS))
      expect(PERM_SET.has(p), p).toBe(true);
  });
  it('every capability value is a real AgentCapability key', () => {
    for (const c of Object.values(AGENT_CAPABILITY_PERMISSIONS))
      expect(CAP_SET.has(c), c).toBe(true);
  });
  it('every manager-only / non-capability-write entry is a real Permission', () => {
    for (const p of AGENT_MANAGER_ONLY_PERMISSIONS) expect(PERM_SET.has(p), p).toBe(true);
    for (const p of AGENT_NON_CAPABILITY_WRITES) expect(PERM_SET.has(p), p).toBe(true);
  });
});

describe('agent effective-permissions — DRIFT GUARD', () => {
  it('every WRITE permission the agent role grants is accounted for in the filter', () => {
    const accounted = new Set<string>([
      ...Object.keys(AGENT_CAPABILITY_PERMISSIONS),
      ...AGENT_MANAGER_ONLY_PERMISSIONS,
      ...AGENT_NON_CAPABILITY_WRITES,
    ]);
    const unaccounted = AGENT_PERMS.filter((p) => isWrite(p) && !accounted.has(p));
    expect(
      unaccounted,
      `Agent-role WRITE permissions NOT handled by the effective-permissions filter — each ` +
        `would render a dead/403 button on the FE (the exact B-AGENT-1 split-brain bug). Add ` +
        `each to AGENT_CAPABILITY_PERMISSIONS (if a requireAgentCapability gates it), ` +
        `AGENT_MANAGER_ONLY_PERMISSIONS (if requireManager), or AGENT_NON_CAPABILITY_WRITES ` +
        `(if authorship/other scoping):\n  ${unaccounted.join('\n  ')}`,
    ).toEqual([]);
  });
});

describe('effectiveAgentPermissions — behavior', () => {
  it('default agent (all caps off) → capability-gated writes + manager-only stripped, reads kept', () => {
    const eff = effectiveAgentPermissions(
      ['tasks.read', 'tasks.create', 'buildings.update', 'projects.archive', 'owners.read'],
      allOff,
    );
    expect(eff).toContain('tasks.read');
    expect(eff).not.toContain('tasks.create'); // manage_tasks off
    expect(eff).not.toContain('buildings.update'); // edit_project_data off
    expect(eff).not.toContain('projects.archive'); // manager-only
    expect(eff).not.toContain('owners.read'); // view_owners off
  });
  it('agent with manage_tasks → tasks writes kept, others still stripped', () => {
    const eff = effectiveAgentPermissions(['tasks.create', 'documents.create'], {
      ...allOff,
      manage_tasks: true,
    });
    expect(eff).toContain('tasks.create');
    expect(eff).not.toContain('documents.create');
  });
  it('null capabilities → all capability-gated writes stripped', () => {
    expect(effectiveAgentPermissions(['tasks.create', 'tasks.read'], null)).toEqual(['tasks.read']);
  });
  it('notes writes (authorship-scoped) pass through regardless of capabilities', () => {
    expect(effectiveAgentPermissions(['notes.create'], allOff)).toContain('notes.create');
  });
});
