import {
  AuditService,
  contractors,
  isOrgSuspended,
  projectAssignments,
  projects,
  shares,
  withTenant,
  type TenantTx,
} from '@emapp/db';
import type { CreateShare, Share, ShareLink, UpdateShare } from '@emapp/shared-types';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, isNull, type SQL } from 'drizzle-orm';

import {
  decodeCursor,
  encodeCursor,
  keysetCondition,
  keysetOrderBy,
} from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';
import { ShareTokenService } from '../contractor-portal/share-token.service';
import { resolveNotificationRecipients } from '../notifications/notification-recipients';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';

export interface ShareListPage {
  data: Share[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });
const FORBIDDEN = new ForbiddenException({ error: { code: 'forbidden' } });

function toShare(r: typeof shares.$inferSelect): Share {
  return {
    id: r.id,
    projectId: r.projectId,
    contractorId: r.contractorId,
    permissions: r.permissions,
    revokedAt: r.revokedAt,
    lastAccessedAt: r.lastAccessedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * Shares domain service (Phase 3 Slice 6) — a grant from org → contractor
 * → project (JSONB permissions, fail-closed strict Zod, T3.S.1).
 *
 * via-parent isolation (share → project → org) by RLS. D.17: read = any
 * org role (agent only for assigned projects); write (grant/update/revoke)
 * = manager. Lifecycle = revokedAt (no physical delete). The
 * contractor-FACING consumption endpoint (docs/09 §3.14
 * GET /contractor/projects/:id) needs the Contractor auth tier which is
 * NOT yet built — deferred & recorded (PROGRESS); this slice is the
 * manager-side grant management only.
 *
 * D.49 SUSPENSION: a suspended org's shares are inert (404) for EVERY op.
 * The read-resolution paths (list/create) gate via `assertProjectVisible`;
 * the by-id write paths (update/revoke) call `isOrgSuspended(tx, user.orgId)`
 * directly at the top of their tx. When the contractor-facing consumption
 * endpoint is built it MUST also resolve through `isOrgSuspended`
 * (share → project → org) before exposing ANY share data — otherwise a
 * suspended org would leak through the contractor tier (which is NOT blocked
 * by the org-login gate).
 */
@Injectable()
export class SharesService {
  private readonly logger = new Logger(SharesService.name);

  constructor(
    private readonly shareToken: ShareTokenService,
    private readonly notifications: NotificationsProducerService,
  ) {}

  private requireManager(user: AccessTokenPayload): void {
    if (user.role !== 'manager') throw FORBIDDEN;
  }

  /**
   * D2-DEF-1 — mint a share-access link for an existing (active) share.
   * Manager-only. The token (audience `emapp-share`) is the contractor
   * credential, delivered out-of-band; revocation is immediate via
   * `shares.revoked_at`. Suspended org / revoked / missing share → 404
   * (no-oracle, same posture as the other by-id share paths).
   */
  async getShareLink(user: AccessTokenPayload, shareId: string): Promise<ShareLink> {
    this.requireManager(user);
    const bound = await withTenant(
      user.orgId,
      async (tx) => {
        if (await isOrgSuspended(tx, user.orgId)) throw NOT_FOUND;
        const [row] = await tx
          .select({ projectId: shares.projectId, contractorId: shares.contractorId })
          .from(shares)
          .where(and(eq(shares.id, shareId), isNull(shares.revokedAt)))
          .limit(1);
        if (!row) throw NOT_FOUND;
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'share.link_minted',
          targetTable: 'shares',
          targetId: shareId,
          sessionId: user.sid,
        });
        return row;
      },
      { userId: user.sub },
    );
    const { token, expiresAt } = this.shareToken.sign({
      sub: bound.contractorId,
      projectId: bound.projectId,
      shareId,
      orgId: user.orgId,
    });
    return { token, expiresAt };
  }

  private async assertProjectVisible(
    tx: TenantTx,
    user: AccessTokenPayload,
    projectId: string,
  ): Promise<void> {
    // D.49 — a suspended org's data is frozen: the share read-resolution paths
    // (list/create) become inert → 404, indistinguishable from a non-existent
    // project. (update/revoke gate directly — they don't pass through here.)
    // org-side managers are already blocked at login (slice 2); this closes the
    // share-resolution seam itself so the property holds regardless of caller.
    if (await isOrgSuspended(tx, user.orgId)) throw NOT_FOUND;

    if (user.role === 'agent') {
      const [row] = await tx
        .select({ id: projects.id })
        .from(projects)
        .innerJoin(
          projectAssignments,
          and(
            eq(projectAssignments.projectId, projects.id),
            eq(projectAssignments.userId, user.sub),
            isNull(projectAssignments.unassignedAt),
          ),
        )
        .where(eq(projects.id, projectId))
        .limit(1);
      if (!row) throw NOT_FOUND;
      return;
    }
    const [row] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!row) throw NOT_FOUND;
  }

  async list(
    user: AccessTokenPayload,
    projectId: string,
    query: { limit: number; cursor?: string },
  ): Promise<ShareListPage> {
    const { limit } = query;
    const cur = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cur) {
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }
    const rows = await withTenant(
      user.orgId,
      async (tx) => {
        await this.assertProjectVisible(tx, user, projectId);
        const keyset: SQL | undefined = cur
          ? keysetCondition(shares.createdAt, shares.id, cur)
          : undefined;
        return tx
          .select()
          .from(shares)
          .where(and(eq(shares.projectId, projectId), isNull(shares.revokedAt), keyset))
          .orderBy(...keysetOrderBy(shares.createdAt, shares.id))
          .limit(limit + 1);
      },
      { userId: user.sub },
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map(toShare),
      page: { limit, cursor: hasMore && last ? encodeCursor(last) : null, has_more: hasMore },
    };
  }

  async create(user: AccessTokenPayload, projectId: string, input: CreateShare): Promise<Share> {
    this.requireManager(user);
    try {
      return await withTenant(
        user.orgId,
        async (tx) => {
          await this.assertProjectVisible(tx, user, projectId);
          const [c] = await tx
            .select({ id: contractors.id })
            .from(contractors)
            .where(and(eq(contractors.id, input.contractorId), isNull(contractors.archivedAt)))
            .limit(1);
          if (!c) throw new BadRequestException({ error: { code: 'contractor_invalid' } });

          const [row] = await tx
            .insert(shares)
            .values({
              projectId,
              contractorId: input.contractorId,
              permissions: input.permissions,
              createdBy: user.sub,
            })
            .returning();
          if (!row)
            throw new InternalServerErrorException({
              error: { code: 'insert_no_row', message: 'unexpected db state' },
            });
          await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: 'share.create',
            targetTable: 'shares',
            targetId: row.id,
            afterState: { projectId, contractorId: input.contractorId },
            sessionId: user.sid,
          });
          return toShare(row);
        },
        { userId: user.sub },
      );
    } catch (e) {
      if (isUniqueViolation(e, 'shares_project_contractor_active')) {
        throw new ConflictException({ error: { code: 'share_exists' } });
      }
      throw e;
    }
  }

  async update(user: AccessTokenPayload, id: string, input: UpdateShare): Promise<Share> {
    this.requireManager(user);
    return withTenant(
      user.orgId,
      async (tx) => {
        // D.49 — suspended org: shares are inert (404), same as the read paths.
        // update/revoke address the share by id (no assertProjectVisible), so
        // the gate is applied directly here.
        if (await isOrgSuspended(tx, user.orgId)) throw NOT_FOUND;
        const [before] = await tx
          .select({ id: shares.id })
          .from(shares)
          .where(and(eq(shares.id, id), isNull(shares.revokedAt)))
          .limit(1);
        if (!before) throw NOT_FOUND;
        const [row] = await tx
          .update(shares)
          .set({ permissions: input.permissions, updatedAt: new Date() })
          .where(eq(shares.id, id))
          .returning();
        if (!row) throw NOT_FOUND;
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'share.update',
          targetTable: 'shares',
          targetId: row.id,
          sessionId: user.sid,
        });
        return toShare(row);
      },
      { userId: user.sub },
    );
  }

  // Revoke = revokedAt + revokedBy (lifecycle, not physical delete).
  // Idempotent: revoking an already-revoked share is a no-op success.
  async revoke(user: AccessTokenPayload, id: string): Promise<void> {
    this.requireManager(user);
    // P5.S4 — share_revoked notification. A revoke is a security-relevant admin
    // action on a project: the project team (assigned agents + managers-always,
    // minus the actor) should know a contractor lost access. Recipients are
    // resolved INSIDE the tx (org-scoped read → satisfies the producer's
    // recipient∈org invariant) but EMITTED post-commit. Declared here to survive
    // the tx scope; a null payload (share missing / already-revoked) → no emit.
    // A notification must NEVER fail the revoke, so resolution self-guards to [].
    let notifyRecipientIds: string[] = [];
    let notifyProjectId = '';
    let notifyContractorName = '';

    await withTenant(
      user.orgId,
      async (tx) => {
        // D.49 — suspended org: shares are inert (404), same as the read paths.
        if (await isOrgSuspended(tx, user.orgId)) throw NOT_FOUND;
        const [before] = await tx
          .select({
            id: shares.id,
            revokedAt: shares.revokedAt,
            projectId: shares.projectId,
            // contractors.name is the contractor's BUSINESS/company name — org-
            // internal business data, NOT personal PII. contactEmail/contactPhone
            // ARE personal data and are deliberately NOT read here (kept out of
            // the notification body per the PII rule).
            contractorName: contractors.name,
          })
          .from(shares)
          .innerJoin(contractors, eq(contractors.id, shares.contractorId))
          .where(eq(shares.id, id))
          .limit(1);
        if (!before) throw NOT_FOUND;
        if (before.revokedAt) return; // already revoked → idempotent no-op, no emit
        await tx
          .update(shares)
          .set({ revokedAt: new Date(), revokedBy: user.sub, updatedAt: new Date() })
          .where(eq(shares.id, id));
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'share.revoke',
          targetTable: 'shares',
          targetId: id,
          sessionId: user.sid,
        });

        // Best-effort recipient resolution through the ONE central helper
        // (single source of truth — no inline recipient logic). Wrapped so a
        // resolver hiccup never rolls back the revoke.
        try {
          notifyRecipientIds = await resolveNotificationRecipients(tx, user.orgId, {
            projectId: before.projectId,
            actorUserId: user.sub,
          });
          notifyProjectId = before.projectId;
          notifyContractorName = before.contractorName;
        } catch {
          notifyRecipientIds = [];
        }
      },
      { userId: user.sub },
    );

    // Fire-and-forget AFTER commit. The revoke (revoked_at write + response) is
    // already durable; emitMany self-guards, and the call site try/catch upholds
    // the "a notification never fails the revoke" contract even if a future
    // producer change throws synchronously. Body carries only the contractor
    // COMPANY name (org-internal business label) — never personal PII.
    if (notifyRecipientIds.length > 0) {
      try {
        await this.notifications.emitMany(notifyRecipientIds, {
          orgId: user.orgId,
          type: 'share_revoked',
          title: 'גישת קבלן בוטלה',
          body: `הרשאת ${notifyContractorName} בוטלה.`,
          link: null,
          metadata: { shareId: id, projectId: notifyProjectId },
        });
      } catch (e) {
        this.logger.error(
          `share_revoked notify failed (share=${id}): ${e instanceof Error ? e.message : 'unknown'}`,
        );
      }
    }
  }
}

function isUniqueViolation(e: unknown, constraint: string): boolean {
  let cur: unknown = e;
  let depth = 0;
  while (cur && depth < 6) {
    const pg = cur as { code?: string; constraint?: string; message?: string };
    if (pg.code === '23505' && (pg.constraint === constraint || pg.message?.includes(constraint))) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
    depth += 1;
  }
  return false;
}
