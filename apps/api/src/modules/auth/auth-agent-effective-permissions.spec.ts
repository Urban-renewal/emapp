/**
 * B-AGENT-1 — `/me` (loadProfile) emits an AGENT's EFFECTIVE permissions.
 *
 * THE BUG (dead/403 buttons): the engine ROLE layer grants the Agent role
 * nearly every operational WRITE (ALL_OPERATIONAL minus a handful). But the
 * services additionally gate those writes on per-membership CAPABILITY flags
 * (default all-OFF) and a few are `requireManager`-only with no agent path.
 * The FE gates its write controls on `/me.permissions` (the role layer), so a
 * normal agent saw write buttons ENABLED that 403'd mid-flow.
 *
 * THE FIX (auth.service.ts loadProfile): for `role === 'agent'` the resolved
 * role permissions are passed through `effectiveAgentPermissions(role, caps)`
 * (agent-effective-permissions.ts) — dropping the manager-only writes always
 * and keeping a capability-gated write only when its flag is ON. Managers and
 * viewers are UNCHANGED (their resolved role set IS already effective).
 *
 * Mechanism (a plaster can't pass): drives `AuthService.getMe` (→ loadProfile)
 * directly against real DB rows — a seeded agent membership with an org-scoped
 * `role_assignments` row (so the slice-2 engine resolves the Agent role), a
 * `project_assignments` row, and the membership `capabilities` jsonb toggled
 * via the BYPASSRLS provider pool. Assertions are CONCRETE membership /
 * non-membership of specific permission strings — NOT a re-run of the SUT
 * filter — so the test is an independent adversarial oracle.
 *
 * Coverage:
 *   - DEFAULT agent (ALL caps OFF, incl. view_owners): /me.permissions has the
 *     READS (tasks.read, documents.read) but NOT the capability-gated writes
 *     (tasks.create, documents.create, signature_requests.send, imports.run,
 *     buildings/apartments/owners writes) and NOT owners.read (view_owners OFF)
 *     and NOT the manager-only writes (projects.update/archive, ownerships.set,
 *     contractors.*, shares.create/revoke). ← the dead-button regression guard.
 *   - agent manage_tasks=true (rest OFF): NOW has tasks.create/update/archive,
 *     still NOT documents.create or signature_requests.send.
 *   - agent view_owners=false → no owners.read; view_owners=true → owners.read.
 *   - MANAGER: UNFILTERED — keeps projects.update, tasks.create, etc. (proves
 *     only agents are filtered).
 *   - VIEWER: unchanged — read-only set, no write leaked by the agent filter.
 */
import { randomUUID } from 'node:crypto';

import { serverEnv } from '@emapp/config';
import { db, memberships, projectAssignments, users } from '@emapp/db';
import type { AgentCapabilities } from '@emapp/shared-types';
import { JwtService } from '@nestjs/jwt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { createTestOrg, type TestOrg } from '../../../../../packages/db/test/factories';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';
import {
  AGENT_CAPABILITY_PERMISSIONS,
  AGENT_MANAGER_ONLY_PERMISSIONS,
} from '../../common/authz/agent-effective-permissions';
import { PermissionService } from '../../common/authz/permission.service';
import { type SystemRoleKey } from '../../common/authz/system-roles';

import { AuthService } from './auth.service';

let svc: AuthService;
let org: TestOrg;
let managerId: string;

const ALL_CAPS_OFF: AgentCapabilities = {
  edit_project_data: false,
  manage_documents: false,
  manage_signatures: false,
  manage_tasks: false,
  run_imports: false,
  view_owners: false,
  view_owner_pii: false,
};

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
 * Seed a user + accepted membership (so loadProfile resolves a profile) + an
 * org-scoped `role_assignments` row (so the slice-2 engine resolves the role's
 * permissions). For agents, sets the `capabilities` jsonb to exactly `caps`
 * and assigns the agent to a project. BYPASSRLS provider pool / app pool.
 */
async function seedMember(
  role: 'agent' | 'manager' | 'viewer',
  caps: AgentCapabilities | null,
): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({
      email: `b-agent1-${role}-${randomUUID()}@test.local`,
      name: `${role} user`,
      passwordHash: '$2b$12$x',
    })
    .returning({ id: users.id });
  const userId = u!.id;

  await db.insert(memberships).values({ userId, orgId: org.id, role, acceptedAt: new Date() });

  // Engine resolution requires an org-scoped assignment to the system role.
  const roleId = await systemRoleId(role);
  const c = await providerPool.connect();
  try {
    await c.query(
      `INSERT INTO role_assignments (user_id, role_id, scope_type, scope_id, granted_at)
       VALUES ($1, $2, 'org', $3, now())
       ON CONFLICT (user_id, role_id, scope_type, scope_id) DO NOTHING`,
      [userId, roleId, org.id],
    );
    if (caps) {
      await c.query(`UPDATE memberships SET capabilities = $1::jsonb WHERE user_id = $2`, [
        JSON.stringify(caps),
        userId,
      ]);
    }
  } finally {
    c.release();
  }

  if (role === 'agent') {
    await db
      .insert(projectAssignments)
      .values({ projectId: org.projects[0]!.id, userId, assignedBy: managerId });
  }
  return userId;
}

beforeAll(async () => {
  await setupTestDatabase();
  svc = new AuthService(new JwtService({ secret: serverEnv.JWT_SECRET }), new PermissionService());
  const tag = `b-agent1-${Date.now()}`;
  org = await createTestOrg(tag, tag);
  managerId = org.users[0]!.id;
}, 90_000);

afterAll(() => {
  /* shared pools closed by global teardown */
});

describe('B-AGENT-1 — agent /me effective permissions (role ∧ capabilities)', () => {
  it('DEFAULT agent (all caps OFF) → reads present; capability-gated writes + manager-only + owners.read ABSENT', async () => {
    const id = await seedMember('agent', ALL_CAPS_OFF);
    const me = await svc.getMe(id);
    const perms = new Set(me!.permissions);

    expect(me!.role).toBe('agent');

    // Reads that are NOT capability-gated pass through.
    expect(perms.has('tasks.read')).toBe(true);
    expect(perms.has('documents.read')).toBe(true);
    expect(perms.has('projects.read')).toBe(true);

    // ── The dead-button regression guard: NO capability-gated write may be
    //    advertised when its flag is OFF. ─────────────────────────────────
    expect(perms.has('tasks.create')).toBe(false);
    expect(perms.has('tasks.update')).toBe(false);
    expect(perms.has('tasks.archive')).toBe(false);
    expect(perms.has('documents.create')).toBe(false);
    expect(perms.has('signature_requests.send')).toBe(false);
    expect(perms.has('imports.run')).toBe(false);
    expect(perms.has('buildings.update')).toBe(false);
    expect(perms.has('apartments.update')).toBe(false);
    expect(perms.has('owners.update')).toBe(false);

    // view_owners OFF → owners.read (the read it gates) is stripped too.
    expect(perms.has('owners.read')).toBe(false);

    // Manager-only writes are stripped unconditionally (no agent path at all).
    expect(perms.has('projects.update')).toBe(false);
    expect(perms.has('projects.archive')).toBe(false);
    expect(perms.has('ownerships.set')).toBe(false);
    expect(perms.has('contractors.create')).toBe(false);
    expect(perms.has('shares.create')).toBe(false);
    expect(perms.has('shares.revoke')).toBe(false);

    // Exhaustive adversarial sweep: EVERY entry in the two gate tables must be
    // absent for a default agent — catches any new write the maps add later.
    for (const gatedWrite of Object.keys(AGENT_CAPABILITY_PERMISSIONS)) {
      expect(perms.has(gatedWrite), `gated write leaked while flag OFF: ${gatedWrite}`).toBe(false);
    }
    for (const mgrOnly of AGENT_MANAGER_ONLY_PERMISSIONS) {
      expect(perms.has(mgrOnly), `manager-only write leaked to agent: ${mgrOnly}`).toBe(false);
    }
  });

  it('agent manage_tasks=ON (rest OFF) → tasks.* writes present; documents/signatures still ABSENT', async () => {
    const id = await seedMember('agent', { ...ALL_CAPS_OFF, manage_tasks: true });
    const me = await svc.getMe(id);
    const perms = new Set(me!.permissions);

    // The flag flips ON exactly the manage_tasks-gated writes.
    expect(perms.has('tasks.create')).toBe(true);
    expect(perms.has('tasks.update')).toBe(true);
    expect(perms.has('tasks.archive')).toBe(true);

    // ...and nothing else: other capability gates remain OFF.
    expect(perms.has('documents.create')).toBe(false);
    expect(perms.has('signature_requests.send')).toBe(false);
    expect(perms.has('imports.run')).toBe(false);
    expect(perms.has('buildings.update')).toBe(false);

    // Manager-only writes still stripped even with a capability ON.
    expect(perms.has('projects.update')).toBe(false);
  });

  it('agent view_owners=false → NO owners.read', async () => {
    const id = await seedMember('agent', { ...ALL_CAPS_OFF, view_owners: false });
    const me = await svc.getMe(id);
    expect(new Set(me!.permissions).has('owners.read')).toBe(false);
  });

  it('agent view_owners=true → owners.read PRESENT', async () => {
    const id = await seedMember('agent', { ...ALL_CAPS_OFF, view_owners: true });
    const me = await svc.getMe(id);
    expect(new Set(me!.permissions).has('owners.read')).toBe(true);
  });

  it('agent edit_project_data=ON → buildings/apartments/owners writes present', async () => {
    const id = await seedMember('agent', { ...ALL_CAPS_OFF, edit_project_data: true });
    const me = await svc.getMe(id);
    const perms = new Set(me!.permissions);
    expect(perms.has('buildings.update')).toBe(true);
    expect(perms.has('apartments.update')).toBe(true);
    expect(perms.has('owners.update')).toBe(true);
    // edit_project_data does NOT unlock other gates.
    expect(perms.has('tasks.create')).toBe(false);
    expect(perms.has('documents.create')).toBe(false);
    // ...and still no manager-only write.
    expect(perms.has('ownerships.set')).toBe(false);
  });

  it('MANAGER → UNFILTERED: keeps projects.update + tasks.create (proves only agents are filtered)', async () => {
    const id = await seedMember('manager', null);
    const me = await svc.getMe(id);
    const perms = new Set(me!.permissions);

    expect(me!.role).toBe('manager');
    // The agent filter must NOT touch a manager: every write the agent loses
    // is still present for a manager.
    expect(perms.has('projects.update')).toBe(true);
    expect(perms.has('projects.archive')).toBe(true);
    expect(perms.has('ownerships.set')).toBe(true);
    expect(perms.has('tasks.create')).toBe(true);
    expect(perms.has('documents.create')).toBe(true);
    expect(perms.has('signature_requests.send')).toBe(true);
    expect(perms.has('owners.read')).toBe(true);
  });

  it('VIEWER → unchanged read-only set: no write leaked by the agent filter', async () => {
    const id = await seedMember('viewer', null);
    const me = await svc.getMe(id);
    const perms = new Set(me!.permissions);

    expect(me!.role).toBe('viewer');
    // A viewer is read-only and is NOT routed through the agent filter; its set
    // must contain a read and no operational write.
    expect(perms.has('projects.read')).toBe(true);
    expect(perms.has('projects.update')).toBe(false);
    expect(perms.has('tasks.create')).toBe(false);
  });
});
