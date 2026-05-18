import {
  AuditService,
  MemberConflictError,
  acceptOrgInvite,
  inviteOrgMember,
  memberships,
  users,
  withTenant,
  type TenantTx,
} from '@emapp/db';
import type { AcceptInvite, CreateMember, Member, UpdateMember } from '@emapp/shared-types';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, desc, eq, isNotNull, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';

import { decodeCursor, encodeCursor } from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';
import { hashPassword } from '../auth/password';

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });
const SELF = new BadRequestException({ error: { code: 'cannot_modify_self' } });
const LAST_MGR = new BadRequestException({ error: { code: 'cannot_remove_last_manager' } });
const INVALID_INVITE = new BadRequestException({ error: { code: 'invalid_invite' } });

const INVITE_TTL = '7d';
const JWT_ISS = 'emapp';
const INVITE_AUD = 'emapp-invite';

interface InviteClaims {
  sub: string;
  orgId: string;
  mid: string;
  typ: 'invite';
}

export interface MemberListPage {
  data: Member[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

/**
 * Members (org membership) admin — Manager-only (enforced centrally by
 * AuthorizationGuard via @AuthzResource('members'), D.26). Provisioning
 * is an invite: create user(no pw)+membership(pending) atomically
 * (sanctioned withBootstrap, scoped to the manager's org), return a
 * one-time signed invite token (HS256, iss/aud pinned, 7d). The invitee
 * sets their OWN password at the PUBLIC /auth/accept-invite — the
 * manager never learns it (ISO A.9.2.1/A.9.4.3). Email delivery deferred.
 */
@Injectable()
export class MembersService {
  constructor(private readonly jwt: JwtService) {}

  // Availability/ISO guard: an org must never be left with ZERO usable
  // managers. If `targetUserId` is currently a usable manager (accepted,
  // not revoked) and this op removes their manager-ness, require at least
  // one OTHER usable manager to remain — else 400 cannot_remove_last_manager.
  private async assertNotLastManager(
    tx: TenantTx,
    orgId: string,
    targetUserId: string,
  ): Promise<void> {
    const [target] = await tx
      .select({ role: memberships.role, acceptedAt: memberships.acceptedAt })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, targetUserId),
          eq(memberships.orgId, orgId),
          isNull(memberships.revokedAt),
        ),
      )
      .limit(1);
    if (!target || target.role !== 'manager' || !target.acceptedAt) return; // not a usable manager → no lockout risk
    const [c] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(memberships)
      .where(
        and(
          eq(memberships.orgId, orgId),
          eq(memberships.role, 'manager'),
          isNull(memberships.revokedAt),
          isNotNull(memberships.acceptedAt),
          ne(memberships.userId, targetUserId),
        ),
      );
    if ((c?.n ?? 0) < 1) throw LAST_MGR;
  }

  async create(
    user: AccessTokenPayload,
    input: CreateMember,
  ): Promise<{ member: Member; inviteToken: string }> {
    try {
      const { userId, membershipId } = await inviteOrgMember({
        orgId: user.orgId,
        email: input.email,
        name: input.name,
        role: input.role,
        invitedBy: user.sub,
        ip: user.ip,
        userAgent: user.userAgent,
      });
      // No email/role in the token — minimal surface; binding is by the
      // (membershipId,userId,orgId) tuple the manager already fixed.
      const inviteToken = this.jwt.sign(
        { sub: userId, orgId: user.orgId, mid: membershipId, typ: 'invite' },
        { expiresIn: INVITE_TTL, issuer: JWT_ISS, audience: INVITE_AUD, algorithm: 'HS256' },
      );
      const member: Member = {
        userId,
        email: input.email,
        name: input.name,
        role: input.role,
        isPrimary: false,
        invitedBy: user.sub,
        acceptedAt: null,
        revokedAt: null,
        createdAt: new Date(),
      };
      return { member, inviteToken };
    } catch (e) {
      if (e instanceof MemberConflictError && e.code === 'member_exists') {
        throw new ConflictException({ error: { code: 'member_exists' } });
      }
      throw e;
    }
  }

  async list(
    user: AccessTokenPayload,
    query: { limit: number; cursor?: string },
  ): Promise<MemberListPage> {
    const { limit } = query;
    const cur = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cur) {
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }
    const rows = await withTenant(
      user.orgId,
      async (tx) => {
        const keyset: SQL | undefined = cur
          ? or(
              lt(memberships.createdAt, new Date(cur.c)),
              and(eq(memberships.createdAt, new Date(cur.c)), lt(memberships.id, cur.i)),
            )
          : undefined;
        return tx
          .select({
            userId: users.id,
            email: users.email,
            name: users.name,
            role: memberships.role,
            isPrimary: memberships.isPrimary,
            invitedBy: memberships.invitedBy,
            acceptedAt: memberships.acceptedAt,
            revokedAt: memberships.revokedAt,
            createdAt: memberships.createdAt,
            mid: memberships.id,
          })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(keyset)
          .orderBy(desc(memberships.createdAt), desc(memberships.id))
          .limit(limit + 1);
      },
      { userId: user.sub },
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map((r) => ({
        userId: r.userId,
        email: r.email,
        name: r.name,
        role: r.role,
        isPrimary: r.isPrimary,
        invitedBy: r.invitedBy,
        acceptedAt: r.acceptedAt,
        revokedAt: r.revokedAt,
        createdAt: r.createdAt,
      })),
      page: {
        limit,
        cursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.mid }) : null,
        has_more: hasMore,
      },
    };
  }

  async updateRole(
    user: AccessTokenPayload,
    targetUserId: string,
    input: UpdateMember,
  ): Promise<Member> {
    if (targetUserId === user.sub) throw SELF; // no self role-change (lockout guard)
    return withTenant(
      user.orgId,
      async (tx) => {
        if (input.role !== 'manager') {
          await this.assertNotLastManager(tx, user.orgId, targetUserId);
        }
        const [row] = await tx
          .update(memberships)
          .set({ role: input.role, updatedAt: new Date() })
          .where(
            and(
              eq(memberships.userId, targetUserId),
              eq(memberships.orgId, user.orgId),
              isNull(memberships.revokedAt),
            ),
          )
          .returning();
        if (!row) throw NOT_FOUND;
        const [u] = await tx
          .select({ email: users.email, name: users.name })
          .from(users)
          .where(eq(users.id, targetUserId))
          .limit(1);
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'member.role_change',
          targetTable: 'memberships',
          targetId: row.id,
          afterState: { role: input.role },
          sessionId: user.sid,
        });
        return {
          userId: targetUserId,
          email: u?.email ?? '',
          name: u?.name ?? '',
          role: row.role,
          isPrimary: row.isPrimary,
          invitedBy: row.invitedBy,
          acceptedAt: row.acceptedAt,
          revokedAt: row.revokedAt,
          createdAt: row.createdAt,
        };
      },
      { userId: user.sub },
    );
  }

  async revoke(user: AccessTokenPayload, targetUserId: string): Promise<void> {
    if (targetUserId === user.sub) throw SELF; // can't revoke yourself (lockout guard)
    await withTenant(
      user.orgId,
      async (tx) => {
        await this.assertNotLastManager(tx, user.orgId, targetUserId);
        const [row] = await tx
          .update(memberships)
          .set({ revokedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(memberships.userId, targetUserId),
              eq(memberships.orgId, user.orgId),
              isNull(memberships.revokedAt),
            ),
          )
          .returning({ id: memberships.id });
        if (!row) throw NOT_FOUND;
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'member.revoke',
          targetTable: 'memberships',
          targetId: row.id,
          sessionId: user.sid,
        });
      },
      { userId: user.sub },
    );
  }

  // PUBLIC — the invitee sets their own password. Generic errors only
  // (no oracle on token validity / membership existence).
  async acceptInvite(input: AcceptInvite): Promise<void> {
    let claims: InviteClaims;
    try {
      claims = this.jwt.verify<InviteClaims>(input.token, {
        issuer: JWT_ISS,
        audience: INVITE_AUD,
        algorithms: ['HS256'],
      });
    } catch {
      throw INVALID_INVITE;
    }
    if (claims.typ !== 'invite' || !claims.sub || !claims.orgId || !claims.mid) {
      throw INVALID_INVITE;
    }
    const passwordHash = await hashPassword(input.password);
    try {
      await acceptOrgInvite({
        userId: claims.sub,
        orgId: claims.orgId,
        membershipId: claims.mid,
        passwordHash,
      });
    } catch (e) {
      if (e instanceof MemberConflictError) throw INVALID_INVITE;
      throw e;
    }
  }
}
