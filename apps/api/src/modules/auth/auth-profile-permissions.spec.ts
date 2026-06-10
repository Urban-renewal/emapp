/**
 * IAM slice 4 — `GET /me` exposes the actor's EFFECTIVE permission-set.
 *
 * ADDITIVE / non-gating: `/me` now returns `permissions: string[]` resolved
 * live through the slice-2 `PermissionService` engine (covering
 * `role_assignments` ⋈ `role_permissions`, implication closure expanded).
 * NOTHING gates on it yet — the FE cutover is slice 5; `policy.ts` + the
 * guards remain the live enforcer.
 *
 * Mechanism (a plaster can't pass): drives `AuthService.getMe` directly
 * against real DB rows seeded with a membership (so a profile resolves) AND
 * an org-scoped `role_assignments` row (so the engine resolves), then asserts
 * the returned `permissions` equals the ENGINE's effective set for that role
 * — built from the SAME catalog the engine expands (`system-roles.ts` +
 * `PERMISSION_IMPLICATIONS`). A drift in the engine, the seed, or the wiring
 * goes red.
 *
 * Coverage:
 *   - manager → permissions == manager's effective set (incl. implications),
 *     SORTED, and the existing fields (role, view_owner_pii) are unchanged.
 *   - viewer  → permissions == viewer's (read-only) effective set — proves the
 *     field is role-specific, not a constant.
 *   - no assignment → empty array (default-deny; the field still present).
 */
import { randomUUID } from 'node:crypto';

import { serverEnv } from '@emapp/config';
import { FakeEmailProvider } from '@emapp/db';
import { JwtService } from '@nestjs/jwt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import { PermissionService } from '../../common/authz/permission.service';
import { PERMISSION_IMPLICATIONS, type Permission } from '../../common/authz/permissions';
import { SYSTEM_ROLES, type SystemRoleKey } from '../../common/authz/system-roles';
import { noopBreachForTest, noopMetricsForTest } from '../observability/test-doubles';

import { AuthService } from './auth.service';
import { PasswordResetRepository } from './password-reset.repository';

let svc: AuthService;
let org: TestOrg;

/**
 * The EXPECTED effective set for a system role = its declared permissions
 * (system-roles.ts) with the §2 implication closure expanded. Independent
 * oracle — the SAME catalog the engine expands, so any drift goes red.
 * Returned SORTED to match the `/me` payload's deterministic ordering.
 */
function expectedEffectiveSorted(key: SystemRoleKey): string[] {
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
  return [...out].sort();
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

/**
 * Seed a user + an accepted membership (legacy role, so `loadProfile`
 * resolves a profile) and OPTIONALLY an org-scoped `role_assignments` row
 * (so the slice-2 engine resolves the same role's permissions). Returns the
 * new userId. BYPASSRLS provider pool.
 */
async function seedMemberWithAssignment(
  orgId: string,
  role: 'manager' | 'viewer',
  assignKey: SystemRoleKey | null,
): Promise<string> {
  const c = await providerPool.connect();
  try {
    const email = `iam-s4-${role}-${randomUUID()}@test.local`;
    const u = await c.query<{ id: string }>(
      `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
      [email, `${role} user`],
    );
    const userId = u.rows[0]!.id;
    await c.query(
      `INSERT INTO memberships (user_id, org_id, role, accepted_at)
       VALUES ($1, $2, $3, now())`,
      [userId, orgId, role],
    );
    if (assignKey) {
      const roleId = await systemRoleId(assignKey);
      await c.query(
        `INSERT INTO role_assignments (user_id, role_id, scope_type, scope_id, granted_at)
         VALUES ($1, $2, 'org', $3, now())
         ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING`,
        [userId, roleId, orgId],
      );
    }
    return userId;
  } finally {
    c.release();
  }
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new AuthService(
    new JwtService({ secret: serverEnv.JWT_SECRET }),
    new PermissionService(),
    noopMetricsForTest(),
    noopBreachForTest(),
    new FakeEmailProvider(),
    new PasswordResetRepository(),
  );
  org = await createTestOrg(`iam-s4-${Date.now()}`, `iam-s4-${Date.now()}`);
}, 90_000);

afterAll(() => {
  /* shared pools closed by global teardown */
});

describe('IAM slice 4 — getMe effective permissions', () => {
  it("manager → permissions == the engine's manager effective set (sorted)", async () => {
    const id = await seedMemberWithAssignment(org.id, 'manager', 'manager');
    const me = await svc.getMe(id);

    // Existing fields are unchanged (purely additive).
    expect(me?.role).toBe('manager');
    expect(me?.view_owner_pii).toBe(true);

    // The new field equals the engine's effective set for the manager role.
    expect(me?.permissions).toEqual(expectedEffectiveSorted('manager'));
    // Sanity: a manager holds the read + reveal_pii closure.
    expect(me?.permissions).toContain('owners.read');
    expect(me?.permissions).toContain('owners.reveal_pii');
  });

  it("viewer → permissions == the engine's viewer (read-only) set", async () => {
    const id = await seedMemberWithAssignment(org.id, 'viewer', 'viewer');
    const me = await svc.getMe(id);

    expect(me?.role).toBe('viewer');
    expect(me?.permissions).toEqual(expectedEffectiveSorted('viewer'));
    // A viewer is read-only — it must NOT hold a write/reveal permission.
    expect(me?.permissions).not.toContain('owners.reveal_pii');
    expect(me?.permissions).not.toContain('projects.update');
  });

  it('no role assignment → empty permissions (default-deny; field present)', async () => {
    const id = await seedMemberWithAssignment(org.id, 'viewer', null);
    const me = await svc.getMe(id);

    expect(me?.role).toBe('viewer');
    expect(me?.permissions).toEqual([]);
  });
});
