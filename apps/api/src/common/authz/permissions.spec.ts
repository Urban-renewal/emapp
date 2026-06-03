/**
 * IAM Slice 1 — permission catalog + system-role permission-set PINS.
 *
 * IAM-DESIGN §2 (catalog + implications) and §4 (the 6 system roles). The
 * EXPECTED values below are written INDEPENDENTLY from the production code
 * (NOT derived from PERMISSIONS / SYSTEM_ROLES) so this is a genuine drift
 * alarm: any change to the catalog or a role's set fails here AND must be a
 * conscious edit to both sides.
 *
 * ADDITIVE slice: this proves the contract the seed + the future
 * PermissionService draw from. It does NOT touch policy.ts.
 */
import { describe, expect, it } from 'vitest';

import {
  PERMISSIONS,
  PERMISSION_IMPLICATIONS,
  PERMISSION_SET,
  isPermission,
  type Permission,
} from './permissions';
import { SYSTEM_ROLES, SYSTEM_ROLE_KEYS, SYSTEM_ROLE_BY_KEY } from './system-roles';

// ── §2 catalog — the full, independently-written list ──────────────────────
const EXPECTED_CATALOG = [
  'projects.read',
  'projects.create',
  'projects.update',
  'projects.archive',
  'buildings.read',
  'buildings.create',
  'buildings.update',
  'buildings.archive',
  'apartments.read',
  'apartments.create',
  'apartments.update',
  'apartments.archive',
  'owners.read',
  'owners.create',
  'owners.update',
  'owners.archive',
  'owners.reveal_pii',
  'ownerships.read',
  'ownerships.set',
  'documents.read',
  'documents.create',
  'documents.update',
  'documents.archive',
  'documents.download',
  'signature_requests.read',
  'signature_requests.send',
  'signature_requests.cancel',
  'tasks.read',
  'tasks.create',
  'tasks.update',
  'tasks.archive',
  'notes.read',
  'notes.create',
  'notes.update',
  'notes.archive',
  'contractors.read',
  'contractors.create',
  'contractors.update',
  'contractors.archive',
  'shares.create',
  'shares.revoke',
  'imports.read',
  'imports.run',
  'imports.cancel',
  'imports.map',
  'mapping_templates.read',
  'mapping_templates.manage',
  'export.run',
  'stats.read',
  'audit.read',
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
  'org.billing.manage',
  'org.transfer_ownership',
  'org.delete',
];

describe('IAM · permission catalog (§2)', () => {
  it('is exactly the catalog (no drift, no dupes)', () => {
    expect([...PERMISSIONS].sort()).toEqual([...EXPECTED_CATALOG].sort());
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    expect(PERMISSION_SET.size).toBe(EXPECTED_CATALOG.length);
  });

  it('isPermission is the membership guard', () => {
    expect(isPermission('owners.reveal_pii')).toBe(true);
    expect(isPermission('owners.nuke')).toBe(false);
  });
});

describe('IAM · permission implications (§2)', () => {
  it('reveal_pii ⇒ owners.read', () => {
    expect(PERMISSION_IMPLICATIONS.get('owners.reveal_pii')).toContain('owners.read');
  });

  it('every write (create/update/archive) implies its .read', () => {
    for (const p of PERMISSIONS) {
      const m = /^(.+)\.(create|update|archive)$/.exec(p);
      if (!m) continue;
      const read = `${m[1]}.read` as Permission;
      if (!PERMISSION_SET.has(read)) continue;
      expect(PERMISSION_IMPLICATIONS.get(p), `${p} should imply ${read}`).toContain(read);
    }
  });

  it('export.run implies every readable resource', () => {
    const implied = PERMISSION_IMPLICATIONS.get('export.run') ?? [];
    for (const r of implied) expect(r.endsWith('.read')).toBe(true);
    // export must imply at least the core data resources.
    expect(implied).toContain('owners.read');
    expect(implied).toContain('projects.read');
    expect(implied).toContain('documents.read');
  });

  it('no implication points at a non-existent permission', () => {
    for (const [child, parents] of PERMISSION_IMPLICATIONS) {
      expect(PERMISSION_SET.has(child), child).toBe(true);
      for (const p of parents) expect(PERMISSION_SET.has(p), p).toBe(true);
    }
  });
});

// ── §4 — the 6 system roles, each pinned to its EXACT set ───────────────────
const reads = EXPECTED_CATALOG.filter((p) => p.endsWith('.read'));
const isGov = (p: string) =>
  p.startsWith('members.') || p.startsWith('roles.') || p.startsWith('org.');
const operational = EXPECTED_CATALOG.filter((p) => !isGov(p));

const EXPECTED_ROLE_PERMS: Record<string, string[]> = {
  owner: [...EXPECTED_CATALOG],
  admin: [
    ...operational,
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
  ],
  manager: [...operational],
  agent: operational.filter(
    (p) => !['projects.create', 'owners.create', 'owners.reveal_pii', 'export.run'].includes(p),
  ),
  viewer: reads.filter((p) => p !== 'owners.reveal_pii'),
  external_read: [
    'projects.read',
    'buildings.read',
    'apartments.read',
    'documents.read',
    'documents.download',
    'signature_requests.read',
  ],
};

describe('IAM · system roles (§4)', () => {
  it('exactly the 6 system role keys', () => {
    expect([...SYSTEM_ROLE_KEYS].sort()).toEqual([
      'admin',
      'agent',
      'external_read',
      'manager',
      'owner',
      'viewer',
    ]);
    expect(SYSTEM_ROLES).toHaveLength(6);
  });

  for (const key of Object.keys(EXPECTED_ROLE_PERMS)) {
    it(`'${key}' holds exactly its §4 set (${EXPECTED_ROLE_PERMS[key]!.length})`, () => {
      const def = SYSTEM_ROLE_BY_KEY.get(key as never)!;
      expect([...def.permissions].sort()).toEqual([...EXPECTED_ROLE_PERMS[key]!].sort());
      // no dupes
      expect(new Set(def.permissions).size).toBe(def.permissions.length);
    });
  }

  it('Owner ⊇ Admin ⊇ Manager (containment §4)', () => {
    const owner = new Set(SYSTEM_ROLE_BY_KEY.get('owner')!.permissions);
    const admin = SYSTEM_ROLE_BY_KEY.get('admin')!.permissions;
    const manager = SYSTEM_ROLE_BY_KEY.get('manager')!.permissions;
    for (const p of admin) expect(owner.has(p), `owner missing ${p}`).toBe(true);
    const adminSet = new Set(admin);
    for (const p of manager) expect(adminSet.has(p), `admin missing ${p}`).toBe(true);
  });

  it('Owner has billing/transfer/delete-org; Admin + Manager do NOT (§4)', () => {
    const ownerOnly = ['org.billing.manage', 'org.transfer_ownership', 'org.delete'];
    const owner = new Set(SYSTEM_ROLE_BY_KEY.get('owner')!.permissions);
    const admin = new Set(SYSTEM_ROLE_BY_KEY.get('admin')!.permissions);
    const manager = new Set(SYSTEM_ROLE_BY_KEY.get('manager')!.permissions);
    for (const p of ownerOnly) {
      expect(owner.has(p as never)).toBe(true);
      expect(admin.has(p as never)).toBe(false);
      expect(manager.has(p as never)).toBe(false);
    }
  });

  it('Viewer + External-Read are read-only (only .read / .download permissions)', () => {
    const WRITE_VERB =
      /\.(create|update|archive|set|send|cancel|revoke|run|manage|invite|remove|reveal_pii)$/;
    for (const key of ['viewer', 'external_read']) {
      for (const p of SYSTEM_ROLE_BY_KEY.get(key as never)!.permissions) {
        expect(WRITE_VERB.test(p), `${key} should not hold write ${p}`).toBe(false);
      }
    }
  });

  it('Agent lacks projects.create, owners.create, reveal_pii, export by default (§4)', () => {
    const agent = new Set(SYSTEM_ROLE_BY_KEY.get('agent')!.permissions);
    for (const p of ['projects.create', 'owners.create', 'owners.reveal_pii', 'export.run']) {
      expect(agent.has(p as never), p).toBe(false);
    }
  });

  it('every role permission is a real catalog permission', () => {
    for (const def of SYSTEM_ROLES) {
      for (const p of def.permissions) expect(PERMISSION_SET.has(p), p).toBe(true);
    }
  });
});
