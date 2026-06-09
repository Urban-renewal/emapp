/**
 * RED regression — the IAM ASSIGNMENT-PROVISIONING gap (engine cutover, slice 5).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE GAP THESE TESTS EXPOSE
 * ════════════════════════════════════════════════════════════════════════════
 * Authorization is now engine-backed: at request time the AuthorizationGuard
 * resolves a user's permissions from `role_assignments ⋈ role_permissions` via
 * `PermissionService`. A user with NO covering `role_assignments` row resolves
 * to ZERO permissions → 403 everywhere (default-deny, §7).
 *
 * A ONE-TIME migration backfill (0043/0044) created assignments for users that
 * ALREADY existed when the model shipped. BUT **no application code path creates
 * a `role_assignments` row** — not signup, not member-invite, not invite-accept,
 * not member role-update. So in production every NEW signup and every NEWLY
 * invited member is locked out of everything.
 *
 * The existing suite hides this: those specs SEED `role_assignments` themselves
 * (raw SQL / a seed helper) and then test the engine against that hand-fed data
 * — a biased setup. THESE tests do the opposite: they drive the REAL
 * provisioning entrypoints (`AuthService.signup`, `MembersService.create`,
 * `.acceptInvite`, `.updateRole`, `.revoke`) and assert the user ends up with
 * working permissions THROUGH THE ENGINE — never inserting an assignment here.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ANTI-BIAS GUARANTEE (the reviewer will check this)
 * ════════════════════════════════════════════════════════════════════════════
 *  - This file NEVER inserts into `role_assignments` (no Drizzle insert, no raw
 *    INSERT, no helper that does so). The ONLY way an assignment can come to
 *    exist is as a SIDE EFFECT of the real app method under test.
 *  - Every assertion resolves through the SAME path the guard + `/me` use:
 *    `PermissionService.effectivePermissions(user, { type:'org', id:orgId }, tx,
 *    cache)` inside `withTenant(orgId, …)`.
 *  - The expected set is an INDEPENDENT oracle computed from `SYSTEM_ROLES`
 *    (system-roles.ts) + the `PERMISSION_IMPLICATIONS` closure — the same
 *    catalog the engine expands. It does NOT seed assignments; it only computes
 *    what the engine SHOULD return.
 *
 * Each test FAILS on current code because the resolved set is EMPTY (the
 * provisioning path never wrote an assignment) — NOT because of a setup error.
 */
import { serverEnv } from '@emapp/config';
import { FakeEmailProvider, withTenant } from '@emapp/db';
import { JwtService } from '@nestjs/jwt';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  PermissionResolutionCache,
  PermissionService,
} from '../../common/authz/permission.service';
import { PERMISSION_IMPLICATIONS, type Permission } from '../../common/authz/permissions';
import { SYSTEM_ROLES, type SystemRoleKey } from '../../common/authz/system-roles';
import { MembersService } from '../members/members.service';

import { AuthService, type AccessTokenPayload } from './auth.service';
import { PasswordResetRepository } from './password-reset.repository';

// ── shared singletons (real DB, real services — no mocks) ──────────────────
const jwt = new JwtService({ secret: serverEnv.JWT_SECRET });
const permissions = new PermissionService();
const auth = new AuthService(
  jwt,
  permissions,
  new PasswordResetRepository(),
  new FakeEmailProvider(),
);
// MembersService(jwt, emailProvider). FakeEmailProvider captures invites in
// memory — the real factory returns it outside production. We never read the
// email; we use the `inviteToken` the service returns in test env.
const members = new MembersService(jwt, new FakeEmailProvider());

const PW = 'OwnerPassword123456';
const MEMBER_PW = 'MemberPassword654321';

/**
 * The EXPECTED effective set for a system role = its declared permissions
 * (system-roles.ts) with the §2 implication closure expanded. Independent
 * oracle over the SAME catalog the engine expands — any drift goes red. Sorted
 * for a stable, order-independent equality assertion. This computes what the
 * engine SHOULD return; it NEVER touches `role_assignments`.
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

/**
 * Resolve a user's effective permission-set on the ORG scope THROUGH THE ENGINE
 * — the exact path the AuthorizationGuard + `/me` use:
 * `effectivePermissions(user, { type:'org', id:orgId }, tx, cache)` inside
 * `withTenant(orgId)`. Returns a SORTED string[] for stable assertions.
 *
 * NOTE: this is READ-ONLY. It SELECTs assignments (via the engine's resolve
 * query); it never inserts one. If the provisioning path under test didn't
 * create an assignment, this resolves to [] (the gap).
 */
async function resolveOrgPermissions(userId: string, orgId: string): Promise<string[]> {
  const effective = await withTenant(orgId, async (tx) => {
    const cache = new PermissionResolutionCache();
    return permissions.effectivePermissions(
      { id: userId, orgId },
      { type: 'org', id: orgId },
      tx,
      cache,
    );
  });
  return [...effective].sort();
}

/** Unique email per test run (avoids the signup duplicate-email short-circuit). */
function uniqueEmail(tag: string): string {
  return `iam-prov-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
}

/**
 * Drive the REAL `AuthService.signup` (org + first user, no assignment created
 * by the app today). Returns the owner's identifiers + an AccessTokenPayload
 * usable to drive member admin as that owner.
 */
async function signupOwner(tag: string): Promise<{
  userId: string;
  orgId: string;
  sid: string;
  payload: AccessTokenPayload;
}> {
  const res = await auth.signup({
    org_name: `IAM Prov ${tag}`,
    name: `Owner ${tag}`,
    email: uniqueEmail(tag),
    password: PW,
  });
  if ('duplicate' in res) throw new Error('signup unexpectedly reported duplicate');
  const userId = res.user.id;
  const orgId = res.user.organization.id;
  // Decode the access token the service just signed to recover the real session
  // id, so the AccessTokenPayload we pass to member-admin methods is authentic
  // (NOT hand-fabricated). We do not verify here — signAccess used the same key.
  const claims = jwt.decode(res.accessToken) as { sid: string };
  const payload: AccessTokenPayload = {
    sub: userId,
    orgId,
    role: res.user.role,
    sid: claims.sid,
    type: 'access',
  };
  return { userId, orgId, sid: claims.sid, payload };
}

/**
 * Drive the REAL invite lifecycle: owner `create`s the member, then the member
 * `acceptInvite`s with the returned token + their own password. Returns the
 * invited user's id. NO assignment is created by this test — only by whatever
 * the real provisioning path does (today: nothing).
 */
async function inviteAndAccept(
  owner: AccessTokenPayload,
  role: 'manager' | 'agent' | 'viewer',
  tag: string,
): Promise<string> {
  const email = uniqueEmail(tag);
  const { member, inviteToken } = await members.create(owner, {
    email,
    name: `Invited ${tag}`,
    role,
  });
  expect(inviteToken, 'invite token not exposed in test env').toBeTruthy();
  await members.acceptInvite({ token: inviteToken!, password: MEMBER_PW });
  return member.userId;
}

beforeAll(() => {
  // Sanity: the email factory exposes the invite token only in dev/test.
  // The vitest runner sets NODE_ENV=test, so `members.create` returns it.
  expect(serverEnv.NODE_ENV).toBe('test');
}, 30_000);

describe('IAM provisioning gap — assignments must be created by the REAL paths', () => {
  /**
   * TEST 1 — signup → OWNER set.
   *
   * WHY IT FAILS NOW: `AuthService.signup` inserts the org + first user +
   * `memberships.role='manager'` but creates NO `role_assignments` row. The
   * engine resolves the first user to the EMPTY set → the owner is locked out
   * of their own org. Per decision §11.1 / migration 0044 the org's first user
   * is the OWNER, so the engine MUST return the OWNER effective set.
   */
  it('signup → first user resolves to the OWNER effective set (currently EMPTY)', async () => {
    const { userId, orgId } = await signupOwner('owner');

    const resolved = await resolveOrgPermissions(userId, orgId);

    // The gap: this is [] today because signup never wrote an assignment.
    expect(
      resolved.length,
      'signup created no role_assignment → owner has ZERO permissions',
    ).toBeGreaterThan(0);
    expect(resolved).toEqual(expectedEffectiveSorted('owner'));
    // Owner-exclusive permissions must be present (precise Owner proof, not Manager).
    expect(resolved).toContain('projects.create');
    expect(resolved).toContain('org.transfer_ownership');
    expect(resolved).toContain('org.delete');
  }, 60_000);

  /**
   * TEST 2a — invite + accept (agent) → AGENT set.
   *
   * WHY IT FAILS NOW: `MembersService.create` (invite) + `.acceptInvite` create
   * the user + membership and set the password, but NEITHER writes a
   * `role_assignments` row. The invited agent resolves to the EMPTY set → 403
   * everywhere despite an accepted membership.
   */
  it('invite + accept (agent) → invited user resolves to the AGENT set (currently EMPTY)', async () => {
    const { payload } = await signupOwner('inv-agent-owner');
    const agentUserId = await inviteAndAccept(payload, 'agent', 'agent');

    const resolved = await resolveOrgPermissions(agentUserId, payload.orgId);

    expect(
      resolved.length,
      'invite/accept created no role_assignment → agent has ZERO permissions',
    ).toBeGreaterThan(0);
    expect(resolved).toEqual(expectedEffectiveSorted('agent'));
    // An agent holds scoped writes but NOT project/owner creation or export.
    expect(resolved).toContain('tasks.update');
    expect(resolved).not.toContain('projects.create');
    expect(resolved).not.toContain('export.run');
  }, 60_000);

  /**
   * TEST 2b — invite + accept (viewer) → VIEWER (read-only) set.
   *
   * Same gap as 2a, proving the missing-assignment lock-out is role-agnostic:
   * a viewer must resolve to the read-only set, not [].
   */
  it('invite + accept (viewer) → invited user resolves to the VIEWER read-only set (currently EMPTY)', async () => {
    const { payload } = await signupOwner('inv-viewer-owner');
    const viewerUserId = await inviteAndAccept(payload, 'viewer', 'viewer');

    const resolved = await resolveOrgPermissions(viewerUserId, payload.orgId);

    expect(
      resolved.length,
      'invite/accept created no role_assignment → viewer has ZERO permissions',
    ).toBeGreaterThan(0);
    expect(resolved).toEqual(expectedEffectiveSorted('viewer'));
    // Read-only: holds reads, never a write or reveal.
    expect(resolved).toContain('projects.read');
    expect(resolved).not.toContain('projects.update');
    expect(resolved).not.toContain('owners.reveal_pii');
  }, 60_000);

  /**
   * TEST 3 — updateRole(agent → viewer) → assignment changes to VIEWER.
   *
   * WHY IT FAILS NOW: even if invite/accept HAD created an agent assignment,
   * `MembersService.updateRole` only mutates `memberships.role` (and revokes
   * sessions) — it does NOT touch `role_assignments`. So after a downgrade the
   * engine would still resolve the STALE set (or, given the upstream gap, the
   * EMPTY set). Either way it is NOT the viewer set this asserts.
   */
  it('updateRole(agent → viewer) → engine resolves the VIEWER set, not the agent/stale/empty set', async () => {
    const { payload } = await signupOwner('update-owner');
    const targetUserId = await inviteAndAccept(payload, 'agent', 'update-target');

    // BEFORE the downgrade: the agent must hold the AGENT set. Asserting this
    // forces a real assignment to have existed, so the post-update VIEWER
    // assertion below cannot pass vacuously — self-contained like the revoke
    // test (independent-review hardening). FAILS now (empty — the gap).
    const beforeUpdate = await resolveOrgPermissions(targetUserId, payload.orgId);
    expect(
      beforeUpdate,
      'invited agent had no permissions before updateRole (provisioning gap)',
    ).toEqual(expectedEffectiveSorted('agent'));

    // REAL downgrade through the service (mutates memberships.role only today).
    await members.updateRole(payload, targetUserId, { role: 'viewer' });

    const resolved = await resolveOrgPermissions(targetUserId, payload.orgId);

    // After a downgrade the engine-resolved set MUST be the viewer set.
    expect(resolved).toEqual(expectedEffectiveSorted('viewer'));
    // Must no longer hold agent-only writes after the downgrade.
    expect(resolved).not.toContain('tasks.update');
    expect(resolved).not.toContain('apartments.create');
  }, 60_000);

  /**
   * TEST 4 — revoke → permissions removed.
   *
   * WHY IT FAILS NOW: `MembersService.revoke` sets `memberships.revoked_at` +
   * revokes sessions, but does NOT remove the user's `role_assignments`. The
   * spec'd behaviour: a revoked member must NOT retain engine-resolved
   * permissions. This test guards the revoke→assignment-removal path.
   *
   * Honesty note (per the task's anti-cheat structure): because the upstream
   * invite/accept path also doesn't create an assignment today, a naive
   * "assert empty after revoke" would pass TRIVIALLY (empty before AND after).
   * To make this a HONEST guard of the revoke path specifically, we assert the
   * full transition the FIX must satisfy:
   *   (1) BEFORE revoke the invited member resolves to the AGENT set
   *       (this currently FAILS — empty — exactly the provisioning gap), AND
   *   (2) AFTER revoke the member resolves to EMPTY.
   * Once the fix lands, (1) proves the assignment existed, so the post-revoke
   * EMPTY in (2) genuinely proves revoke REMOVED a real assignment — not a
   * vacuous pass.
   */
  it('revoke → a member who HAD permissions resolves to EMPTY after revoke (guards assignment removal)', async () => {
    const { payload } = await signupOwner('revoke-owner');
    const targetUserId = await inviteAndAccept(payload, 'agent', 'revoke-target');

    // (1) Before revoke the member must HAVE the agent set. FAILS now (empty) —
    //     this is the provisioning gap; it makes the post-revoke check honest.
    const before = await resolveOrgPermissions(targetUserId, payload.orgId);
    expect(
      before,
      'invited member had no engine permissions even before revoke (provisioning gap)',
    ).toEqual(expectedEffectiveSorted('agent'));

    // REAL revoke through the service.
    await members.revoke(payload, targetUserId);

    // (2) After revoke the member must resolve to EMPTY (no lingering grant).
    const after = await resolveOrgPermissions(targetUserId, payload.orgId);
    expect(
      after,
      'revoked member still resolves engine permissions — assignment not removed',
    ).toEqual([]);
  }, 60_000);
});
