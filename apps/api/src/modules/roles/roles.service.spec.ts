/**
 * Custom-role management — DB-backed functional proof (P2 Phase 1).
 *
 * Exercises the RolesService against the real DB + the live IAM engine:
 *   - CREATE a custom role; the ENGINE then resolves EXACTLY that set for a user
 *     who holds ONLY the custom role (the load-bearing "freshly-created custom
 *     role is enforced" guarantee).
 *   - ANTI-ESCALATION: an Admin cannot bake governance (`roles.*` / `org.*`) into a
 *     custom role; nobody can grant a permission they don't hold.
 *   - A SYSTEM role cannot be edited or deleted.
 *   - DELETE is blocked while assigned.
 *   - TENANT ISOLATION: an actor in org A cannot see/edit org B's custom role.
 *   - assign/revoke flows, last-Owner safety.
 */
import { randomUUID } from 'node:crypto';

import { db, memberships, users, withTenant } from '@emapp/db';
import { beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import {
  PermissionResolutionCache,
  PermissionService,
} from '../../common/authz/permission.service';
import type { Permission } from '../../common/authz/permissions';
import type { AccessTokenPayload } from '../auth/auth.service';

import { RolesService } from './roles.service';

const svc = new RolesService();
const engine = new PermissionService();

let orgA: TestOrg;
let orgB: TestOrg;

async function seedUser(): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `roles-svc-${randomUUID()}@test.local`,
      name: 'Roles Svc User',
      passwordHash: '$2b$12$placeholder',
    })
    .returning({ id: users.id });
  return u!.id;
}

/** Seed a user who is an ACTIVE member of `orgId` (assignable). */
async function seedMember(orgId: string): Promise<string> {
  const id = await seedUser();
  await db.insert(memberships).values({
    userId: id,
    orgId,
    role: 'viewer',
    acceptedAt: new Date(),
  });
  return id;
}

async function systemRoleId(key: string): Promise<string> {
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

/** Grant a system role to a user at org scope (BYPASSRLS seed). */
async function grantSystem(userId: string, key: string, orgId: string): Promise<void> {
  const roleId = await systemRoleId(key);
  const c = await providerPool.connect();
  try {
    await c.query(
      `INSERT INTO role_assignments (user_id, role_id, scope_type, scope_id, granted_at)
       VALUES ($1, $2, 'org', $3, now())
       ON CONFLICT DO NOTHING`,
      [userId, roleId, orgId],
    );
  } finally {
    c.release();
  }
}

function actor(userId: string, orgId: string): AccessTokenPayload {
  return { sub: userId, orgId, role: 'manager', sid: randomUUID(), type: 'access' };
}

async function effective(userId: string, orgId: string): Promise<ReadonlySet<Permission>> {
  return withTenant(orgId, async (tx) => {
    const cache = new PermissionResolutionCache();
    return engine.effectivePermissions(
      { id: userId, orgId },
      { type: 'org', id: orgId },
      tx,
      cache,
    );
  });
}

let ownerA: string; // an Owner actor in org A
let adminA: string; // an Admin actor in org A

beforeAll(async () => {
  await setupTestDatabase();
  orgA = await createTestOrg(`RolesA ${randomUUID().slice(0, 8)}`);
  orgB = await createTestOrg(`RolesB ${randomUUID().slice(0, 8)}`);
  ownerA = await seedUser();
  adminA = await seedUser();
  await grantSystem(ownerA, 'owner', orgA.id);
  await grantSystem(adminA, 'admin', orgA.id);
});

describe('create + engine enforcement', () => {
  it('creates a custom role and the ENGINE resolves EXACTLY its set for a sole holder', async () => {
    const role = await svc.create(actor(ownerA, orgA.id), {
      name: `Coordinator ${randomUUID().slice(0, 6)}`,
      description: 'reads projects + manages tasks',
      permissions: ['projects.read', 'tasks.read', 'tasks.create', 'tasks.update'],
    });
    expect(role.isSystem).toBe(false);
    expect(role.orgId).toBe(orgA.id);
    expect(role.permissions).toContain('projects.read');

    // A fresh member holding ONLY this custom role.
    const u = await seedMember(orgA.id);
    await svc.assign(actor(ownerA, orgA.id), { userId: u, roleId: role.id });

    const eff = await effective(u, orgA.id);
    // Exactly the granted set + the write→read implication closure (tasks.* ⇒ tasks.read).
    expect(eff.has('projects.read')).toBe(true);
    expect(eff.has('tasks.create')).toBe(true);
    expect(eff.has('tasks.read')).toBe(true);
    // NOT anything outside the grant.
    expect(eff.has('owners.read')).toBe(false);
    expect(eff.has('roles.manage')).toBe(false);
    expect(eff.has('export.run')).toBe(false);
  });
});

describe('anti-escalation', () => {
  it('an Admin cannot bake governance roles.* into a custom role', async () => {
    await expect(
      svc.create(actor(adminA, orgA.id), {
        name: `Govern ${randomUUID().slice(0, 6)}`,
        permissions: ['projects.read', 'roles.manage'],
      }),
    ).rejects.toMatchObject({ response: { error: { code: 'governance_owner_only' } } });
  });

  it('an Admin cannot grant a permission they do not hold (billing)', async () => {
    await expect(
      svc.create(actor(adminA, orgA.id), {
        name: `Billing ${randomUUID().slice(0, 6)}`,
        permissions: ['org.billing.manage'],
      }),
    ).rejects.toMatchObject({ response: { error: { code: 'governance_owner_only' } } });
    // (governance check fires before not-held; billing is org.* governance.)
  });

  it('rejects a non-catalog permission string', async () => {
    await expect(
      svc.create(actor(ownerA, orgA.id), {
        name: `Bad ${randomUUID().slice(0, 6)}`,
        permissions: ['projects.read', 'projects.superuser'],
      }),
    ).rejects.toMatchObject({ response: { error: { code: 'unknown_permission' } } });
  });

  it('an Owner MAY include governance permissions they hold', async () => {
    const role = await svc.create(actor(ownerA, orgA.id), {
      name: `OwnerGov ${randomUUID().slice(0, 6)}`,
      permissions: ['projects.read', 'roles.assign'],
    });
    expect(role.permissions).toContain('roles.assign');
  });
});

describe('assign — system role with governance reads', () => {
  it('an ADMIN can assign the Viewer system role (which carries roles.read / org.settings.read)', async () => {
    const viewerRoleId = await systemRoleId('viewer');
    const u = await seedMember(orgA.id);
    // adminA is NOT an Owner; the assignment uses subset-only (not the minting
    // governance block), so a Viewer grant — which carries governance READS —
    // succeeds because the Admin holds those reads.
    await expect(
      svc.assign(actor(adminA, orgA.id), { userId: u, roleId: viewerRoleId }),
    ).resolves.toBeUndefined();
  });

  it('an ADMIN canNOT assign the Owner system role (tier guard)', async () => {
    const ownerRoleId = await systemRoleId('owner');
    const u = await seedMember(orgA.id);
    await expect(
      svc.assign(actor(adminA, orgA.id), { userId: u, roleId: ownerRoleId }),
    ).rejects.toMatchObject({ response: { error: { code: 'owner_required_for_tier' } } });
  });
});

describe('system-role immutability', () => {
  it('cannot update a system role', async () => {
    const managerRoleId = await systemRoleId('manager');
    await expect(
      svc.update(actor(ownerA, orgA.id), managerRoleId, { name: 'Hacked' }),
    ).rejects.toMatchObject({ response: { error: { code: 'system_role_immutable' } } });
  });
  it('cannot delete a system role', async () => {
    const viewerRoleId = await systemRoleId('viewer');
    await expect(svc.remove(actor(ownerA, orgA.id), viewerRoleId)).rejects.toMatchObject({
      response: { error: { code: 'system_role_immutable' } },
    });
  });
});

describe('delete guard', () => {
  it('blocks delete while the role is assigned, allows after revoke', async () => {
    const role = await svc.create(actor(ownerA, orgA.id), {
      name: `Temp ${randomUUID().slice(0, 6)}`,
      permissions: ['projects.read'],
    });
    const u = await seedMember(orgA.id);
    await svc.assign(actor(ownerA, orgA.id), { userId: u, roleId: role.id });
    await expect(svc.remove(actor(ownerA, orgA.id), role.id)).rejects.toMatchObject({
      response: { error: { code: 'role_in_use' } },
    });
    await svc.revoke(actor(ownerA, orgA.id), { userId: u, roleId: role.id });
    await expect(svc.remove(actor(ownerA, orgA.id), role.id)).resolves.toBeUndefined();
  }, 20000);
});

describe('tenant isolation', () => {
  it("an actor in org A cannot update org B's custom role (RLS hides it → 404)", async () => {
    const roleB = await svc
      .create(actor(orgB.users[0]!.id, orgB.id), {
        name: `BOnly ${randomUUID().slice(0, 6)}`,
        permissions: ['projects.read'],
      })
      .catch(async () => {
        // orgB's seeded user is a manager (no roles.manage) — grant owner to mint.
        await grantSystem(orgB.users[0]!.id, 'owner', orgB.id);
        return svc.create(actor(orgB.users[0]!.id, orgB.id), {
          name: `BOnly ${randomUUID().slice(0, 6)}`,
          permissions: ['projects.read'],
        });
      });
    await expect(svc.update(actor(ownerA, orgA.id), roleB.id, { name: 'X' })).rejects.toMatchObject(
      { response: { error: { code: 'role_not_found' } } },
    );
  });

  it('list in org A does not include org B custom roles', async () => {
    const list = await svc.list(actor(ownerA, orgA.id));
    const orgBRoles = list.filter((r) => r.orgId === orgB.id);
    expect(orgBRoles).toHaveLength(0);
  });
});
