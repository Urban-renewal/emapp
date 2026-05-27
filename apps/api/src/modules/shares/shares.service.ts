import {
  AuditService,
  contractors,
  projectAssignments,
  projects,
  shares,
  withTenant,
  type TenantTx,
} from '@emapp/db';
import type { CreateShare, Share, UpdateShare } from '@emapp/shared-types';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, lt, or, type SQL } from 'drizzle-orm';

import { decodeCursor, encodeCursor } from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';

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
 */
@Injectable()
export class SharesService {
  private requireManager(user: AccessTokenPayload): void {
    if (user.role !== 'manager') throw FORBIDDEN;
  }

  private async assertProjectVisible(
    tx: TenantTx,
    user: AccessTokenPayload,
    projectId: string,
  ): Promise<void> {
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
          ? or(
              lt(shares.createdAt, new Date(cur.c)),
              and(eq(shares.createdAt, new Date(cur.c)), lt(shares.id, cur.i)),
            )
          : undefined;
        return tx
          .select()
          .from(shares)
          .where(and(eq(shares.projectId, projectId), isNull(shares.revokedAt), keyset))
          .orderBy(desc(shares.createdAt), desc(shares.id))
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
    await withTenant(
      user.orgId,
      async (tx) => {
        const [before] = await tx
          .select({ id: shares.id, revokedAt: shares.revokedAt })
          .from(shares)
          .where(eq(shares.id, id))
          .limit(1);
        if (!before) throw NOT_FOUND;
        if (before.revokedAt) return;
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
      },
      { userId: user.sub },
    );
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
