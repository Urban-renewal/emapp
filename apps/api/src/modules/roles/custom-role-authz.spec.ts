/**
 * Custom-role anti-escalation boundary — UNIT PROOF (the security core).
 *
 * These tests attack the exact surface the security reviewer will: catalog (R1),
 * subset / no-vertical-escalation (R2), and the governance Owner-only boundary
 * (R3). Pure functions, no I/O — every branch is exercised directly.
 */
import { describe, expect, it } from 'vitest';

import type { Permission } from '../../common/authz/permissions';

import {
  actorIsOwner,
  checkCustomRolePermissions,
  checkRoleAssignable,
  isGovernancePermission,
} from './custom-role-authz';

const set = (...p: Permission[]): ReadonlySet<Permission> => new Set(p);

// A realistic Admin effective set: holds roles.* governance + operational, but
// NOT the Owner markers (org.transfer_ownership / org.delete).
const ADMIN_EFFECTIVE = set(
  'projects.read',
  'projects.create',
  'owners.read',
  'owners.reveal_pii',
  'members.read',
  'members.invite',
  'roles.read',
  'roles.assign',
  'roles.revoke',
  'roles.manage',
  'org.settings.read',
  'org.settings.update',
  'org.security_policy.manage',
);

// An Owner additionally holds the two Owner-exclusive markers.
const OWNER_EFFECTIVE = set(
  ...[...ADMIN_EFFECTIVE],
  'org.billing.manage',
  'org.transfer_ownership',
  'org.delete',
);

describe('isGovernancePermission', () => {
  it('flags roles.* and org.* as governance', () => {
    expect(isGovernancePermission('roles.manage')).toBe(true);
    expect(isGovernancePermission('roles.assign')).toBe(true);
    expect(isGovernancePermission('org.delete')).toBe(true);
    expect(isGovernancePermission('org.settings.read')).toBe(true);
  });
  it('does NOT flag operational permissions', () => {
    expect(isGovernancePermission('projects.read')).toBe(false);
    expect(isGovernancePermission('owners.reveal_pii')).toBe(false);
    expect(isGovernancePermission('members.invite')).toBe(false); // members.* is NOT governance-gated
  });
});

describe('actorIsOwner', () => {
  it('is true only with BOTH owner markers', () => {
    expect(actorIsOwner(OWNER_EFFECTIVE)).toBe(true);
    expect(actorIsOwner(ADMIN_EFFECTIVE)).toBe(false);
    expect(actorIsOwner(set('org.transfer_ownership'))).toBe(false); // only one marker
    expect(actorIsOwner(set('org.delete'))).toBe(false);
  });
});

describe('checkCustomRolePermissions — R1 catalog', () => {
  it('rejects a non-catalog permission string', () => {
    const v = checkCustomRolePermissions(['projects.read', 'projects.superuser'], ADMIN_EFFECTIVE);
    expect(v).toEqual({ code: 'unknown_permission', permissions: ['projects.superuser'] });
  });
  it('reports unknown BEFORE subset/governance', () => {
    // A string that is both non-catalog AND would be governance-shaped: catalog wins.
    const v = checkCustomRolePermissions(['org.make_me_god'], ADMIN_EFFECTIVE);
    expect(v?.code).toBe('unknown_permission');
  });
});

describe('checkCustomRolePermissions — R2 subset (no vertical escalation)', () => {
  it('allows a subset of the actor effective set', () => {
    const v = checkCustomRolePermissions(['projects.read', 'owners.read'], ADMIN_EFFECTIVE);
    expect(v).toBeNull();
  });
  it('rejects a catalog permission the actor does NOT hold', () => {
    // export.run is a real permission but not in ADMIN_EFFECTIVE here.
    const v = checkCustomRolePermissions(['projects.read', 'export.run'], ADMIN_EFFECTIVE);
    expect(v).toEqual({ code: 'permission_not_held', permissions: ['export.run'] });
  });
  it('an Owner still cannot grant a permission not in their set', () => {
    const v = checkCustomRolePermissions(['imports.run'], OWNER_EFFECTIVE);
    expect(v).toEqual({ code: 'permission_not_held', permissions: ['imports.run'] });
  });
});

describe('checkCustomRolePermissions — R3 governance boundary (Owner-only)', () => {
  it('an ADMIN cannot bake roles.* into a custom role even though they hold it', () => {
    const v = checkCustomRolePermissions(['projects.read', 'roles.manage'], ADMIN_EFFECTIVE);
    expect(v).toEqual({ code: 'governance_owner_only', permissions: ['roles.manage'] });
  });
  it('an ADMIN cannot bake org.* into a custom role', () => {
    const v = checkCustomRolePermissions(['org.settings.update'], ADMIN_EFFECTIVE);
    expect(v).toEqual({ code: 'governance_owner_only', permissions: ['org.settings.update'] });
  });
  it('reports governance BEFORE not-held (Admin holds roles.manage → precise signal)', () => {
    const v = checkCustomRolePermissions(['roles.manage'], ADMIN_EFFECTIVE);
    expect(v?.code).toBe('governance_owner_only');
  });
  it('an OWNER MAY include governance permissions they hold', () => {
    const v = checkCustomRolePermissions(
      ['projects.read', 'roles.assign', 'org.settings.update'],
      OWNER_EFFECTIVE,
    );
    expect(v).toBeNull();
  });
  it('an OWNER still cannot include a governance permission they do NOT hold', () => {
    // Construct an "owner-tier" actor (has markers) but WITHOUT org.billing.manage.
    const ownerNoBilling = set('projects.read', 'org.transfer_ownership', 'org.delete');
    const v = checkCustomRolePermissions(['org.billing.manage'], ownerNoBilling);
    expect(v).toEqual({ code: 'permission_not_held', permissions: ['org.billing.manage'] });
  });
});

describe('checkRoleAssignable — subset-only (assignment boundary)', () => {
  it('an Admin CAN assign a role carrying governance READS (Viewer-shaped)', () => {
    // Viewer holds roles.read + org.settings.read — governance prefixes — but
    // assignment uses subset-only, so an Admin who holds them may assign.
    const v = checkRoleAssignable(
      ['projects.read', 'roles.read', 'org.settings.read'],
      ADMIN_EFFECTIVE,
    );
    expect(v).toBeNull();
  });
  it('still rejects assigning a role with a permission the actor lacks', () => {
    const v = checkRoleAssignable(['projects.read', 'export.run'], ADMIN_EFFECTIVE);
    expect(v).toEqual({ code: 'permission_not_held', permissions: ['export.run'] });
  });
  it('still rejects a non-catalog permission', () => {
    const v = checkRoleAssignable(['projects.superuser'], ADMIN_EFFECTIVE);
    expect(v?.code).toBe('unknown_permission');
  });
  it('does NOT apply the governance Owner-only block (that is a minting rule)', () => {
    // roles.assign is governance, but ADMIN holds it → assignable under subset.
    const v = checkRoleAssignable(['roles.assign'], ADMIN_EFFECTIVE);
    expect(v).toBeNull();
  });
});

describe('checkCustomRolePermissions — hygiene', () => {
  it('dedupes repeated permissions in the request', () => {
    const v = checkCustomRolePermissions(['projects.read', 'projects.read'], ADMIN_EFFECTIVE);
    expect(v).toBeNull();
  });
  it('an empty request set is allowed by the boundary (min-size is a DTO concern)', () => {
    expect(checkCustomRolePermissions([], ADMIN_EFFECTIVE)).toBeNull();
  });
});
