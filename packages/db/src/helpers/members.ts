import { and, eq, isNull } from 'drizzle-orm';

import { AuditService } from '../audit/audit.service';
import { roleAssignments, roles } from '../schema/iam';
import { memberships, users } from '../schema/tenancy';
import { withBootstrap } from '../wrappers/with-bootstrap';

// Member provisioning data-ops. A new user row + its first membership is
// the same chicken-and-egg as signup (users RLS needs a membership to
// already exist), so it uses the SOLE sanctioned RLS-bypass
// `withBootstrap` — scoped IN CODE to the inviting manager's org (never
// a client-supplied org), every id server-generated, audit written
// inside the same tx (the documented withBootstrap safety contract).
// Password HASHING stays in the app (argon2id, D.21) — this layer only
// stores a pre-computed hash.

export class MemberConflictError extends Error {
  constructor(public readonly code: 'member_exists' | 'invalid_invite') {
    super(code);
  }
}

export interface InviteParams {
  orgId: string;
  email: string;
  name: string;
  role: 'manager' | 'agent' | 'viewer';
  invitedBy: string;
  ip?: string;
  userAgent?: string;
}

export async function inviteOrgMember(
  p: InviteParams,
): Promise<{ userId: string; membershipId: string; isExistingUser: boolean }> {
  return withBootstrap(async (tx) => {
    const [existing] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, p.email))
      .limit(1);

    let userId: string;
    let isExistingUser: boolean;
    if (existing) {
      userId = existing.id;
      isExistingUser = true;
      const [dup] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, userId),
            eq(memberships.orgId, p.orgId),
            isNull(memberships.revokedAt),
          ),
        )
        .limit(1);
      if (dup) throw new MemberConflictError('member_exists');
    } else {
      const [u] = await tx
        .insert(users)
        .values({ email: p.email, name: p.name, passwordHash: null })
        .returning({ id: users.id });
      if (!u) throw new Error('member: user insert returned no row');
      userId = u.id;
      isExistingUser = false;
    }

    const [m] = await tx
      .insert(memberships)
      .values({
        userId,
        orgId: p.orgId,
        role: p.role,
        isPrimary: false,
        invitedBy: p.invitedBy,
        acceptedAt: null, // pending until the invitee accepts
      })
      .returning({ id: memberships.id });
    if (!m) throw new Error('member: membership insert returned no row');

    // IAM slice 5 — provision the invited member's authorization. The engine
    // resolves permissions from `role_assignments`; without a row the invited
    // member resolves to ZERO permissions (403 everywhere) even after they
    // accept. Map the legacy `memberships.role` to the same-named system role
    // and grant an org-scope assignment, atomic with the membership (same
    // withBootstrap tx). Granting at INVITE time is safe: the pending member
    // can't authenticate until accept, so an early grant is inert until then.
    const [systemRole] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(and(isNull(roles.orgId), eq(roles.isSystem, true), eq(roles.key, p.role)))
      .limit(1);
    if (!systemRole) throw new Error(`member: system role '${p.role}' not found (seed missing)`);
    await tx
      .insert(roleAssignments)
      .values({
        userId,
        roleId: systemRole.id,
        scopeType: 'org',
        scopeId: p.orgId,
        grantedBy: p.invitedBy,
      })
      // Idempotent: an existing user re-invited to the same org+role keeps one
      // canonical org assignment (the unique index is (user,role,scope)).
      .onConflictDoNothing();

    await new AuditService(tx, { ip: p.ip, userAgent: p.userAgent }).logMany([
      {
        orgId: p.orgId,
        actorId: p.invitedBy,
        actorType: 'user',
        action: 'member.invite',
        targetTable: 'memberships',
        targetId: m.id,
        afterState: { role: p.role }, // no PII in audit
      },
      {
        orgId: p.orgId,
        actorId: p.invitedBy,
        actorType: 'user',
        action: 'role.grant',
        targetTable: 'role_assignments',
        targetId: userId,
        afterState: { role: p.role, scope: 'org' }, // no PII
      },
    ]);

    return { userId, membershipId: m.id, isExistingUser };
  });
}

export interface AcceptParams {
  userId: string;
  orgId: string;
  membershipId: string;
  /** argon2id hash; applied ONLY if the user has no password yet. */
  passwordHash?: string;
}

export async function acceptOrgInvite(p: AcceptParams): Promise<void> {
  await withBootstrap(async (tx) => {
    const [m] = await tx
      .select({ id: memberships.id, acceptedAt: memberships.acceptedAt })
      .from(memberships)
      .where(
        and(
          eq(memberships.id, p.membershipId),
          eq(memberships.userId, p.userId),
          eq(memberships.orgId, p.orgId),
          isNull(memberships.revokedAt),
        ),
      )
      .limit(1);
    // Single-use: a pending, un-revoked, matching membership only.
    if (!m || m.acceptedAt) throw new MemberConflictError('invalid_invite');

    const [u] = await tx
      .select({ id: users.id, passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, p.userId))
      .limit(1);
    if (!u) throw new MemberConflictError('invalid_invite');

    // Brand-new user MUST set a password; an existing user (joining an
    // additional org) keeps their current password — never reset it.
    if (!u.passwordHash) {
      if (!p.passwordHash) throw new MemberConflictError('invalid_invite');
      await tx
        .update(users)
        .set({ passwordHash: p.passwordHash, updatedAt: new Date() })
        .where(eq(users.id, p.userId));
    }

    await tx
      .update(memberships)
      .set({ acceptedAt: new Date(), updatedAt: new Date() })
      .where(eq(memberships.id, p.membershipId));

    await new AuditService(tx).log({
      orgId: p.orgId,
      actorId: p.userId,
      actorType: 'user',
      action: 'member.accept',
      targetTable: 'memberships',
      targetId: p.membershipId,
    });
  });
}
