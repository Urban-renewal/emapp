/**
 * Enterprise IAM — the engine safety net (IAM-DESIGN §6 / G6). Slice 2.
 *
 * Real-DB tests (the 6 system roles are seeded by migration 0043; we seed
 * users + `role_assignments` and resolve through `PermissionService`). The
 * engine is ADDITIVE this slice — these tests are its only consumer; `policy.ts`
 * is still live and untouched.
 *
 * Coverage:
 *   - MATRIX  : each system role resolves EXACTLY its §4 set (incl. implication
 *     closure) and denies everything else — pinned.
 *   - SCOPE   : org-assignment grants project access; a project-assignment does
 *     NOT grant another project; no assignment ⇒ default-deny (§7).
 *   - ESCALATION [G2]: Admin cannot assign Owner; an assigner cannot grant a
 *     permission it lacks.
 *   - IMPLICATIONS [G3]: holding `owners.reveal_pii` ⇒ `owners.read` resolves
 *     true; no child without its parent.
 *   - PERF [G5]: `can()` called N times in one request issues ≤1 resolve query.
 */
import { randomUUID } from 'node:crypto';

import { db, users, withTenant } from '@emapp/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';

import {
  PermissionResolutionCache,
  PermissionService,
  type AuthzUser,
  type Scope,
} from './permission.service';
import { PERMISSIONS, PERMISSION_IMPLICATIONS, type Permission } from './permissions';
import { SYSTEM_ROLES, SYSTEM_ROLE_KEYS, type SystemRoleKey } from './system-roles';

let svc: PermissionService;
let org: TestOrg;
let other: TestOrg;
let orgScope: Scope;
let projectAId: string;
let projectBId: string;

/** A fresh user id (no membership/assignment yet — the engine resolves purely
 *  from `role_assignments`, so no membership row is needed). */
async function seedUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `iam-eng-${randomUUID()}@test.local`,
      name: 'IAM Engine User',
      passwordHash: '$2b$12$placeholder',
    })
    .returning({ id: users.id });
  return u!.id;
}

/** Resolve a seeded system role's id by key (org_id IS NULL). */
async function systemRoleId(key: SystemRoleKey): Promise<string> {
  const c = await providerPool.connect();
  try {
    const r = await c.query<{ id: string }>(
      `SELECT id FROM roles WHERE org_id IS NULL AND is_system = true AND key = $1`,
      [key],
    );
    if (!r.rows[0]) throw new Error(`system role not seeded: ${key}`);
    return r.rows[0].id;
  } finally {
    c.release();
  }
}

/** Assign a system role to a user at a scope (BYPASSRLS seed). */
async function assign(
  userId: string,
  key: SystemRoleKey,
  scopeType: 'org' | 'project',
  scopeId: string,
): Promise<void> {
  const roleId = await systemRoleId(key);
  const c = await providerPool.connect();
  try {
    await c.query(
      `INSERT INTO role_assignments (user_id, role_id, scope_type, scope_id, granted_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING`,
      [userId, roleId, scopeType, scopeId],
    );
  } finally {
    c.release();
  }
}

function actor(id: string): AuthzUser {
  return { id, orgId: org.id };
}

/**
 * The EXPECTED effective set for a system role = its declared permissions
 * (system-roles.ts) with the §2 implication closure expanded. This is the
 * independent oracle the matrix test pins against — built from the SAME catalog
 * the engine expands, so a drift in either the catalog or the engine goes red.
 */
function expectedEffective(key: SystemRoleKey): Set<Permission> {
  const def = SYSTEM_ROLES.find((r) => r.key === key)!;
  const out = new Set<Permission>(def.permissions);
  const stack = [...def.permissions];
  while (stack.length > 0) {
    const perm = stack.pop()!;
    for (const parent of PERMISSION_IMPLICATIONS.get(perm) ?? []) {
      if (!out.has(parent)) {
        out.add(parent);
        stack.push(parent);
      }
    }
  }
  return out;
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new PermissionService();
  const tag = `iam-eng-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  other = await createTestOrg(`${tag}-x`, `${tag}-x`);
  orgScope = { type: 'org', id: org.id };
  projectAId = org.projects[0]!.id;
  projectBId = org.projects[1]!.id;
}, 120_000);

afterAll(() => {
  /* shared pools; global teardown closes them */
});

describe('PermissionService — authz matrix (§6 / G6)', () => {
  // For each system role, an org-scoped assignment must resolve to EXACTLY the
  // expected effective set (incl. implications) and deny everything else.
  for (const key of SYSTEM_ROLE_KEYS) {
    it(`role "${key}" resolves EXACTLY its §4 permission-set (org scope)`, async () => {
      const userId = await seedUser();
      await assign(userId, key, 'org', org.id);

      const expected = expectedEffective(key);

      await withTenant(org.id, async (tx) => {
        const cache = new PermissionResolutionCache();
        const effective = await svc.effectivePermissions(actor(userId), orgScope, tx, cache);

        // Granted set is EXACTLY the expected closure.
        expect(new Set(effective)).toEqual(expected);

        // can() agrees with the set for EVERY catalog permission — granted true,
        // ungranted false (default-deny on the complement). Pinned per-permission.
        for (const perm of PERMISSIONS) {
          const got = await svc.can(actor(userId), perm, orgScope, tx, cache);
          expect(got, `${key} can ${perm}`).toBe(expected.has(perm));
        }
      });
    });
  }

  it('unknown / non-catalog permission is denied (fail-closed)', async () => {
    const userId = await seedUser();
    await assign(userId, 'owner', 'org', org.id); // owner holds everything real
    await withTenant(org.id, async (tx) => {
      const cache = new PermissionResolutionCache();
      const got = await svc.can(
        actor(userId),
        'owners.delete_universe' as unknown as Permission,
        orgScope,
        tx,
        cache,
      );
      expect(got).toBe(false);
    });
  });
});

describe('PermissionService — scope resolution (§7 / G4)', () => {
  it('org-scope assignment GRANTS project-scope access (org ⊇ project)', async () => {
    const userId = await seedUser();
    await assign(userId, 'manager', 'org', org.id);
    await withTenant(org.id, async (tx) => {
      const cache = new PermissionResolutionCache();
      const onProject = await svc.can(
        actor(userId),
        'projects.update',
        { type: 'project', id: projectAId },
        tx,
        cache,
      );
      expect(onProject).toBe(true);
    });
  });

  it('project-scope assignment does NOT grant ANOTHER project', async () => {
    const userId = await seedUser();
    await assign(userId, 'agent', 'project', projectAId);
    await withTenant(org.id, async (tx) => {
      const cache = new PermissionResolutionCache();
      const onA = await svc.can(
        actor(userId),
        'apartments.update',
        { type: 'project', id: projectAId },
        tx,
        cache,
      );
      const onB = await svc.can(
        actor(userId),
        'apartments.update',
        { type: 'project', id: projectBId },
        tx,
        cache,
      );
      expect(onA).toBe(true);
      expect(onB).toBe(false);
    });
  });

  it('project-scope assignment does NOT grant the ORG scope', async () => {
    const userId = await seedUser();
    await assign(userId, 'agent', 'project', projectAId);
    await withTenant(org.id, async (tx) => {
      const cache = new PermissionResolutionCache();
      const onOrg = await svc.can(actor(userId), 'apartments.update', orgScope, tx, cache);
      expect(onOrg).toBe(false);
    });
  });

  it('NO assignment ⇒ default-deny (empty effective set)', async () => {
    const userId = await seedUser(); // no assignment at all
    await withTenant(org.id, async (tx) => {
      const cache = new PermissionResolutionCache();
      const effective = await svc.effectivePermissions(actor(userId), orgScope, tx, cache);
      expect(effective.size).toBe(0);
      expect(await svc.can(actor(userId), 'projects.read', orgScope, tx, cache)).toBe(false);
    });
  });

  it('an assignment in ANOTHER org never leaks (RLS scoping)', async () => {
    const userId = await seedUser();
    // Assign in the OTHER org at org scope; resolving inside `org` must see nothing.
    await assign(userId, 'owner', 'org', other.id);
    await withTenant(org.id, async (tx) => {
      const cache = new PermissionResolutionCache();
      const effective = await svc.effectivePermissions(actor(userId), orgScope, tx, cache);
      expect(effective.size).toBe(0);
    });
  });
});

describe('PermissionService — implication closure (§2 / G3)', () => {
  it('owners.reveal_pii ⇒ owners.read resolves true (child implies parent)', async () => {
    const userId = await seedUser();
    await assign(userId, 'manager', 'org', org.id); // manager holds reveal_pii
    await withTenant(org.id, async (tx) => {
      const cache = new PermissionResolutionCache();
      expect(await svc.can(actor(userId), 'owners.reveal_pii', orgScope, tx, cache)).toBe(true);
      expect(await svc.can(actor(userId), 'owners.read', orgScope, tx, cache)).toBe(true);
    });
  });

  it('a write permission implies its read (e.g. projects.update ⇒ projects.read)', async () => {
    const userId = await seedUser();
    await assign(userId, 'agent', 'project', projectAId); // agent holds projects.update
    await withTenant(org.id, async (tx) => {
      const cache = new PermissionResolutionCache();
      const projScope: Scope = { type: 'project', id: projectAId };
      expect(await svc.can(actor(userId), 'projects.update', projScope, tx, cache)).toBe(true);
      expect(await svc.can(actor(userId), 'projects.read', projScope, tx, cache)).toBe(true);
    });
  });

  it('you cannot hold a child without its parent (closure is enforced for every role)', async () => {
    // For every system role, every held permission's declared parents are also held.
    for (const key of SYSTEM_ROLE_KEYS) {
      const eff = expectedEffective(key);
      for (const perm of eff) {
        for (const parent of PERMISSION_IMPLICATIONS.get(perm) ?? []) {
          expect(eff.has(parent), `${key}: ${perm} ⇒ ${parent}`).toBe(true);
        }
      }
    }
  });
});

describe('PermissionService — anti-escalation (§5 / G2)', () => {
  it('an Admin CANNOT assign Owner (only an Owner may grant Owner/Admin)', async () => {
    const adminId = await seedUser();
    await assign(adminId, 'admin', 'org', org.id);
    await withTenant(org.id, async (tx) => {
      const cache = new PermissionResolutionCache();
      expect(await svc.canAssignRole(actor(adminId), 'owner', orgScope, tx, cache)).toBe(false);
      expect(await svc.canAssignRole(actor(adminId), 'admin', orgScope, tx, cache)).toBe(false);
    });
  });

  it('an Owner CAN assign Owner and Admin', async () => {
    const ownerId = await seedUser();
    await assign(ownerId, 'owner', 'org', org.id);
    await withTenant(org.id, async (tx) => {
      const cache = new PermissionResolutionCache();
      expect(await svc.canAssignRole(actor(ownerId), 'owner', orgScope, tx, cache)).toBe(true);
      expect(await svc.canAssignRole(actor(ownerId), 'admin', orgScope, tx, cache)).toBe(true);
    });
  });

  it('an assigner CANNOT grant a role holding a permission it lacks (no self-escalation)', async () => {
    // A Viewer (read-only) tries to assign Manager (writes + reveal_pii + export).
    const viewerId = await seedUser();
    await assign(viewerId, 'viewer', 'org', org.id);
    await withTenant(org.id, async (tx) => {
      const cache = new PermissionResolutionCache();
      expect(await svc.canAssignRole(actor(viewerId), 'manager', orgScope, tx, cache)).toBe(false);
    });
  });

  it('an Admin CAN assign Manager/Agent/Viewer (subset of its own perms)', async () => {
    const adminId = await seedUser();
    await assign(adminId, 'admin', 'org', org.id);
    await withTenant(org.id, async (tx) => {
      const cache = new PermissionResolutionCache();
      expect(await svc.canAssignRole(actor(adminId), 'manager', orgScope, tx, cache)).toBe(true);
      expect(await svc.canAssignRole(actor(adminId), 'agent', orgScope, tx, cache)).toBe(true);
      expect(await svc.canAssignRole(actor(adminId), 'viewer', orgScope, tx, cache)).toBe(true);
    });
  });

  it('a project-scoped assigner cannot grant on a scope it does not cover', async () => {
    // Agent on project A tries to assign Agent on the ORG scope (which it does
    // not hold) → its effective perms on org scope are empty → deny.
    const agentId = await seedUser();
    await assign(agentId, 'agent', 'project', projectAId);
    await withTenant(org.id, async (tx) => {
      const cache = new PermissionResolutionCache();
      expect(await svc.canAssignRole(actor(agentId), 'agent', orgScope, tx, cache)).toBe(false);
    });
  });
});

describe('PermissionService — perf / round-trips (§5 / G5)', () => {
  it('can() called N times in one request issues ≤1 resolve query', async () => {
    const userId = await seedUser();
    await assign(userId, 'manager', 'org', org.id);

    // Spy on the (protected) resolveAssignments — the only method that touches
    // the DB. N checks across mixed scopes must trigger exactly ONE resolution.
    const resolveSpy = vi.spyOn(
      svc as unknown as { resolveAssignments: (...args: unknown[]) => Promise<unknown> },
      'resolveAssignments',
    );

    await withTenant(org.id, async (tx) => {
      const cache = new PermissionResolutionCache();
      const projScope: Scope = { type: 'project', id: projectAId };
      const checks: Array<Promise<boolean>> = [];
      for (const perm of PERMISSIONS.slice(0, 20)) {
        checks.push(svc.can(actor(userId), perm, orgScope, tx, cache));
        checks.push(svc.can(actor(userId), perm, projScope, tx, cache));
      }
      // also effectivePermissions, which shares the same resolution
      await svc.effectivePermissions(actor(userId), orgScope, tx, cache);
      await Promise.all(checks);
    });

    expect(resolveSpy).toHaveBeenCalledTimes(1);
    resolveSpy.mockRestore();
  });
});
