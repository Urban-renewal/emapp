import {
  AuditService,
  MemberConflictError,
  acceptOrgInvite,
  authSessions,
  inviteOrgMember,
  memberships,
  roleAssignments,
  roles,
  users,
  withTenant,
  type IEmailProvider,
  type TenantTx,
} from '@emapp/db';
import { DEFAULT_AGENT_CAPABILITIES } from '@emapp/shared-types';
import type {
  AcceptInvite,
  AgentCapabilities,
  CreateMember,
  Member,
  UpdateAgentCapabilities,
  UpdateMember,
} from '@emapp/shared-types';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';

import { decodeCursor, encodeCursor } from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';
import { hashPassword } from '../auth/password';
import { flushSessionCache } from '../auth/session-validity';

import { EMAIL_PROVIDER, EXPOSE_INVITE_TOKEN, buildInviteEmail } from './invite-email';

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
 * manager never learns it (ISO A.9.2.1/A.9.4.3). D.27: the token is
 * delivered via IEmailProvider and is NOT returned in prod responses.
 */
@Injectable()
export class MembersService {
  private readonly logger = new Logger(MembersService.name);

  constructor(
    private readonly jwt: JwtService,
    @Inject(EMAIL_PROVIDER) private readonly email: IEmailProvider,
  ) {}

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

  // IAM slice 5 — the org-scope SYSTEM role-id catalog. Returns the id for the
  // requested role key plus the full set of system role-ids, so an org-scope
  // assignment can be retargeted to the new role while scoping the UPDATE/DELETE
  // to system-role assignments only (a custom-role grant, if any, is untouched).
  // System roles are cross-org (`org_id IS NULL`), readable under any tenant's
  // RLS (migration 0043), so this resolves inside the request's `withTenant` tx.
  private async loadSystemRoleIds(
    tx: TenantTx,
    key: 'manager' | 'agent' | 'viewer',
  ): Promise<{ targetRoleId: string; systemRoleIds: string[] }> {
    const rows = await tx
      .select({ id: roles.id, key: roles.key })
      .from(roles)
      .where(and(isNull(roles.orgId), eq(roles.isSystem, true)));
    const systemRoleIds = rows.map((r) => r.id);
    const targetRoleId = rows.find((r) => r.key === key)?.id;
    if (!targetRoleId) throw new Error(`members: system role '${key}' not found (seed missing)`);
    return { targetRoleId, systemRoleIds };
  }

  async create(
    user: AccessTokenPayload,
    input: CreateMember,
  ): Promise<{ member: Member; inviteToken?: string }> {
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
      // D.27: deliver the token via the email channel. Best-effort — the
      // membership is already committed; a transient mail failure must not
      // 500 the request (the manager can re-invite). The token is a
      // credential: never logged, never in an error message.
      try {
        const r = await this.email.send(
          buildInviteEmail({ to: input.email, name: input.name, token: inviteToken }),
        );
        if (r.status === 'rejected') {
          // Non-PII operability signal (ISO A.12.4): membership id + provider
          // error only. NEVER the token, the link, or the email body.
          this.logger.error(
            `invite email rejected (membership=${membershipId}): ${r.error ?? 'unknown'}`,
          );
        }
      } catch (mailErr) {
        // Best-effort: membership is committed; a transient send failure must
        // not 500 (the manager can re-invite). Record the FACT + cause (no
        // token/body) so undelivered invites are detectable in the field.
        this.logger.error(
          `invite email send failed (membership=${membershipId}): ${
            mailErr instanceof Error ? mailErr.message : 'unknown'
          }`,
        );
      }
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
        // New membership carries the column default (least-privilege).
        capabilities: DEFAULT_AGENT_CAPABILITIES,
      };
      // Token is returned ONLY outside production (dev/test convenience +
      // conformance/red-team). In prod the email is the sole delivery path.
      return EXPOSE_INVITE_TOKEN ? { member, inviteToken } : { member };
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
            capabilities: memberships.capabilities,
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
        capabilities: r.capabilities,
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
    const result = await withTenant(
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
        // Audit H-1 sec fix (2026-05-27 red-team): a role change must
        // kill the target's existing access tokens, otherwise an
        // ex-manager downgraded to viewer keeps full prior privileges
        // for up to 15 minutes (the access-token TTL). Same posture as
        // `auth.service.logout` — revoke all active auth_sessions for
        // this user, then flushSessionCache so the next access-token
        // check fails immediately. Target sees: "session expired —
        // please sign in again", which is the correct security signal.
        await tx
          .update(authSessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(authSessions.userId, targetUserId), isNull(authSessions.revokedAt)));
        // IAM slice 5 — keep the engine in sync with the role change. The guard
        // resolves permissions from `role_assignments`, so a `memberships.role`
        // change that doesn't retarget the assignment would leave the engine
        // resolving the STALE set. Retarget the target's org-scope SYSTEM-role
        // assignment to the new role (atomic, same tx). Defensive INSERT if no
        // such assignment existed (a pre-engine member never backfilled).
        const { targetRoleId, systemRoleIds } = await this.loadSystemRoleIds(tx, input.role);
        const updatedAssignments = await tx
          .update(roleAssignments)
          .set({ roleId: targetRoleId })
          .where(
            and(
              eq(roleAssignments.userId, targetUserId),
              eq(roleAssignments.scopeType, 'org'),
              eq(roleAssignments.scopeId, user.orgId),
              inArray(roleAssignments.roleId, systemRoleIds),
            ),
          )
          .returning({ id: roleAssignments.id });
        if (updatedAssignments.length === 0) {
          await tx
            .insert(roleAssignments)
            .values({
              userId: targetUserId,
              roleId: targetRoleId,
              scopeType: 'org',
              scopeId: user.orgId,
              grantedBy: user.sub,
            })
            .onConflictDoNothing();
        }
        const [u] = await tx
          .select({ email: users.email, name: users.name })
          .from(users)
          .where(eq(users.id, targetUserId))
          .limit(1);
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).logMany([
          {
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: 'member.role_change',
            targetTable: 'memberships',
            targetId: row.id,
            afterState: { role: input.role, sessionsRevoked: true },
            sessionId: user.sid,
          },
          {
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: 'role.change',
            targetTable: 'role_assignments',
            targetId: targetUserId,
            afterState: { role: input.role, scope: 'org' }, // no PII
            sessionId: user.sid,
          },
        ]);
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
          capabilities: row.capabilities,
        };
      },
      { userId: user.sub },
    );
    // flushSessionCache OUTSIDE the tx: the in-process cache eviction
    // must run after the rows are committed so other workers reading
    // from the DB don't re-cache the now-stale session ids.
    flushSessionCache();
    return result;
  }

  /**
   * D.46 — set an AGENT's capability flags (manager-only; the route is gated
   * by @AuthzResource('members') → manager). The body is a SUBSET, merged onto
   * the stored set. Only `role='agent'` memberships accept capabilities —
   * managers implicitly hold all, viewers none, so toggling theirs is a 400
   * (prevents a confusing no-op grant). Capabilities are NOT in the JWT, so
   * the change is effective on the agent's next request with NO session
   * revocation needed; we still audit the change.
   */
  async updateCapabilities(
    user: AccessTokenPayload,
    targetUserId: string,
    input: UpdateAgentCapabilities,
  ): Promise<Member> {
    return withTenant(
      user.orgId,
      async (tx) => {
        const [before] = await tx
          .select({
            id: memberships.id,
            role: memberships.role,
            capabilities: memberships.capabilities,
          })
          .from(memberships)
          .where(
            and(
              eq(memberships.userId, targetUserId),
              eq(memberships.orgId, user.orgId),
              isNull(memberships.revokedAt),
            ),
          )
          .limit(1);
        if (!before) throw NOT_FOUND;
        if (before.role !== 'agent') {
          throw new BadRequestException({ error: { code: 'capabilities_agent_only' } });
        }
        // Shallow-merge the provided subset onto the stored set.
        const merged: AgentCapabilities = { ...before.capabilities, ...input };
        // D.54 invariant — `view_owner_pii` (reveal cleartext) IMPLIES
        // `view_owners` (see owners at all). The contradictory
        // {view_owners:false, view_owner_pii:true} is forbidden at the source:
        // `revealPii` already treats it as inert (view_owners gates first), but
        // rejecting it here keeps the stored capability set coherent + auditable
        // and prevents a confusing "granted but does nothing" pii flag. Checked
        // on the MERGED result so it catches either field arriving in the patch.
        if (merged.view_owner_pii && !merged.view_owners) {
          throw new BadRequestException({
            error: { code: 'view_owner_pii_requires_view_owners' },
          });
        }
        const [row] = await tx
          .update(memberships)
          .set({ capabilities: merged, updatedAt: new Date() })
          .where(eq(memberships.id, before.id))
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
          action: 'member.capabilities_change',
          targetTable: 'memberships',
          targetId: row.id,
          beforeState: { capabilities: before.capabilities },
          afterState: { capabilities: merged },
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
          capabilities: row.capabilities,
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
        // Audit H-1 sec fix — revoking the membership without revoking
        // the user's auth_sessions leaves the access token valid for
        // up to 15 minutes. Kill all active sessions for this user so
        // the next request hits a 401 immediately.
        await tx
          .update(authSessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(authSessions.userId, targetUserId), isNull(authSessions.revokedAt)));
        // IAM slice 5 — remove the engine grant on revoke (defense in depth
        // beyond session revocation). The guard resolves permissions from
        // `role_assignments`; leaving the row would let a revoked member retain
        // engine-resolved permissions (e.g. a fresh login if the membership
        // were ever re-activated). DELETE the user's org-scope assignment(s) so
        // the post-revoke effective set is EMPTY (atomic, same tx).
        await tx
          .delete(roleAssignments)
          .where(
            and(
              eq(roleAssignments.userId, targetUserId),
              eq(roleAssignments.scopeType, 'org'),
              eq(roleAssignments.scopeId, user.orgId),
            ),
          );
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).logMany([
          {
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: 'member.revoke',
            targetTable: 'memberships',
            targetId: row.id,
            afterState: { sessionsRevoked: true },
            sessionId: user.sid,
          },
          {
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: 'role.revoke',
            targetTable: 'role_assignments',
            targetId: targetUserId,
            afterState: { scope: 'org' }, // no PII
            sessionId: user.sid,
          },
        ]);
      },
      { userId: user.sub },
    );
    // flush AFTER commit so other workers don't re-cache stale sids.
    flushSessionCache();
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
