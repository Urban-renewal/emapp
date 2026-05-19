import {
  AuditService,
  memberships,
  projectAssignments,
  projects,
  withTenant,
  type TenantTx,
} from '@emapp/db';
import type { CreateProjectAssignment, ProjectAssignment } from '@emapp/shared-types';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, lt, or, type SQL } from 'drizzle-orm';

import { decodeCursor, encodeCursor } from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';

export interface ProjectAssignmentListPage {
  data: ProjectAssignment[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });
const FORBIDDEN = new ForbiddenException({ error: { code: 'forbidden' } });

function toAssignment(r: typeof projectAssignments.$inferSelect): ProjectAssignment {
  return {
    id: r.id,
    projectId: r.projectId,
    userId: r.userId,
    roleInProject: r.roleInProject,
    assignedAt: r.assignedAt,
    unassignedAt: r.unassignedAt,
  };
}

/**
 * ProjectAssignments service (Phase 3 Slice 9) — the D.17 Agent-scoping
 * linchpin made manageable. via-parent isolation (project → org) by RLS.
 *  - manager → assign/unassign + see all assignments of a project.
 *  - viewer  → read-only, all.
 *  - agent   → read-only, ONLY their own assignment rows (consistent
 *              with how every other slice scopes agents).
 */
@Injectable()
export class ProjectAssignmentsService {
  private requireManager(user: AccessTokenPayload): void {
    if (user.role !== 'manager') throw FORBIDDEN;
  }

  private async assertProjectVisible(
    tx: TenantTx,
    user: AccessTokenPayload,
    projectId: string,
  ): Promise<void> {
    // Project visibility here is org-only (RLS). Agents may still LIST a
    // project's assignments but the row filter below restricts to self.
    const [r] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!r) throw NOT_FOUND;
  }

  async list(
    user: AccessTokenPayload,
    projectId: string,
    query: { limit: number; cursor?: string },
  ): Promise<ProjectAssignmentListPage> {
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
              lt(projectAssignments.assignedAt, new Date(cur.c)),
              and(
                eq(projectAssignments.assignedAt, new Date(cur.c)),
                lt(projectAssignments.id, cur.i),
              ),
            )
          : undefined;
        return tx
          .select()
          .from(projectAssignments)
          .where(
            and(
              eq(projectAssignments.projectId, projectId),
              isNull(projectAssignments.unassignedAt),
              user.role === 'agent' ? eq(projectAssignments.userId, user.sub) : undefined,
              keyset,
            ),
          )
          .orderBy(desc(projectAssignments.assignedAt), desc(projectAssignments.id))
          .limit(limit + 1);
      },
      { userId: user.sub },
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map(toAssignment),
      page: {
        limit,
        cursor: hasMore && last ? encodeCursor({ createdAt: last.assignedAt, id: last.id }) : null,
        has_more: hasMore,
      },
    };
  }

  async create(
    user: AccessTokenPayload,
    projectId: string,
    input: CreateProjectAssignment,
  ): Promise<ProjectAssignment> {
    this.requireManager(user);
    try {
      return await withTenant(
        user.orgId,
        async (tx) => {
          await this.assertProjectVisible(tx, user, projectId);
          const [m] = await tx
            .select({ id: memberships.id })
            .from(memberships)
            .where(
              and(
                eq(memberships.userId, input.userId),
                eq(memberships.orgId, user.orgId),
                isNull(memberships.revokedAt),
              ),
            )
            .limit(1);
          if (!m) throw new BadRequestException({ error: { code: 'invalid_assignee' } });

          const [row] = await tx
            .insert(projectAssignments)
            .values({
              projectId,
              userId: input.userId,
              roleInProject: input.roleInProject ?? 'agent',
              assignedBy: user.sub,
            })
            .returning();
          if (!row) throw new Error('assignment insert returned no row');
          await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: 'project_assignment.create',
            targetTable: 'project_assignments',
            targetId: row.id,
            afterState: { projectId, userId: input.userId },
            sessionId: user.sid,
          });
          return toAssignment(row);
        },
        { userId: user.sub },
      );
    } catch (e) {
      if (isUniqueViolation(e, 'project_assignments_project_user_active')) {
        throw new ConflictException({ error: { code: 'assignment_exists' } });
      }
      throw e;
    }
  }

  // Unassign = unassignedAt (lifecycle, not physical delete). Idempotent.
  async unassign(user: AccessTokenPayload, id: string): Promise<void> {
    this.requireManager(user);
    await withTenant(
      user.orgId,
      async (tx) => {
        const [before] = await tx
          .select({ id: projectAssignments.id, unassignedAt: projectAssignments.unassignedAt })
          .from(projectAssignments)
          .where(eq(projectAssignments.id, id))
          .limit(1);
        if (!before) throw NOT_FOUND;
        if (before.unassignedAt) return;
        await tx
          .update(projectAssignments)
          .set({ unassignedAt: new Date() })
          .where(eq(projectAssignments.id, id));
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'project_assignment.unassign',
          targetTable: 'project_assignments',
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
