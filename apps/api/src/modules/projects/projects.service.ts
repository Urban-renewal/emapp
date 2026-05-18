import {
  AuditService,
  projectAssignments,
  projects,
  withTenant,
  type Project as ProjectRow,
} from '@emapp/db';
import type { CreateProject, Project, UpdateProject } from '@emapp/shared-types';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';

import { decodeCursor, encodeCursor } from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';

export interface ProjectListPage {
  data: Project[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    organizationId: r.orgId,
    name: r.name,
    type: r.type,
    status: r.status,
    description: r.description,
    // pg `numeric` is returned as string by the driver — normalise to number.
    targetSignaturePct: r.targetSignaturePct === null ? null : Number(r.targetSignaturePct),
    startedAt: r.startedAt,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    archivedAt: r.archivedAt,
  };
}

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });
const FORBIDDEN = new ForbiddenException({ error: { code: 'forbidden' } });

/**
 * Projects domain service (Phase 3 Slice 1).
 *
 * Authorization (D.17) is owned HERE, not in a god-guard:
 *  - manager → full CRUD + reads all org projects.
 *  - viewer  → read-only, all org projects.
 *  - agent   → read-only, ONLY projects in an active project_assignments row
 *              (scoped in the SERVICE per the approved plan, not via an extra
 *              RLS policy — avoids via-parent N+1 and keeps RLS = org isolation).
 * Tenant org-isolation itself is enforced by RLS inside withTenant; a
 * cross-org id therefore returns zero rows → 404 (no oracle).
 */
@Injectable()
export class ProjectsService {
  private requireManager(user: AccessTokenPayload): void {
    if (user.role !== 'manager') throw FORBIDDEN;
  }

  async list(
    user: AccessTokenPayload,
    query: { limit: number; cursor?: string },
  ): Promise<ProjectListPage> {
    const { limit } = query;
    const cur = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cur) {
      // Tampered/garbage cursor is a client error, never a 500.
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }

    const rows = await withTenant(
      user.orgId,
      async (tx) => {
        const keyset = cur
          ? or(
              lt(projects.createdAt, new Date(cur.c)),
              and(eq(projects.createdAt, new Date(cur.c)), lt(projects.id, cur.i)),
            )
          : undefined;

        // Agent: inner-join the active assignment so only assigned projects
        // are visible. The idx_project_assignments_user_active partial index
        // backs this — no N+1, single round-trip.
        if (user.role === 'agent') {
          return tx
            .select({ p: projects })
            .from(projects)
            .innerJoin(
              projectAssignments,
              and(
                eq(projectAssignments.projectId, projects.id),
                eq(projectAssignments.userId, user.sub),
                isNull(projectAssignments.unassignedAt),
              ),
            )
            .where(and(isNull(projects.archivedAt), keyset))
            .orderBy(desc(projects.createdAt), desc(projects.id))
            .limit(limit + 1)
            .then((res) => res.map((x) => x.p));
        }

        return tx
          .select()
          .from(projects)
          .where(and(isNull(projects.archivedAt), keyset))
          .orderBy(desc(projects.createdAt), desc(projects.id))
          .limit(limit + 1);
      },
      { userId: user.sub },
    );

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map(toProject),
      page: {
        limit,
        cursor: hasMore && last ? encodeCursor(last) : null,
        has_more: hasMore,
      },
    };
  }

  async get(user: AccessTokenPayload, id: string): Promise<Project> {
    const row = await withTenant(
      user.orgId,
      async (tx) => {
        if (user.role === 'agent') {
          const [r] = await tx
            .select({ p: projects })
            .from(projects)
            .innerJoin(
              projectAssignments,
              and(
                eq(projectAssignments.projectId, projects.id),
                eq(projectAssignments.userId, user.sub),
                isNull(projectAssignments.unassignedAt),
              ),
            )
            .where(eq(projects.id, id))
            .limit(1);
          return r?.p;
        }
        const [r] = await tx.select().from(projects).where(eq(projects.id, id)).limit(1);
        return r;
      },
      { userId: user.sub },
    );
    if (!row) throw NOT_FOUND;
    return toProject(row);
  }

  async create(user: AccessTokenPayload, input: CreateProject): Promise<Project> {
    this.requireManager(user);
    return withTenant(
      user.orgId,
      async (tx) => {
        const [row] = await tx
          .insert(projects)
          .values({
            orgId: user.orgId,
            name: input.name,
            type: input.type,
            status: input.status ?? 'planning',
            description: input.description ?? null,
            targetSignaturePct:
              input.targetSignaturePct === undefined || input.targetSignaturePct === null
                ? null
                : String(input.targetSignaturePct),
            startedAt: input.startedAt ?? null,
            createdBy: user.sub,
          })
          .returning();
        if (!row) throw new Error('project insert returned no row');
        await new AuditService(tx).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'project.create',
          targetTable: 'projects',
          targetId: row.id,
          afterState: { name: row.name, type: row.type, status: row.status },
          sessionId: user.sid,
        });
        return toProject(row);
      },
      { userId: user.sub },
    );
  }

  async update(user: AccessTokenPayload, id: string, input: UpdateProject): Promise<Project> {
    this.requireManager(user);
    return withTenant(
      user.orgId,
      async (tx) => {
        const [before] = await tx.select().from(projects).where(eq(projects.id, id)).limit(1);
        if (!before) throw NOT_FOUND;

        const patch: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };
        if (input.name !== undefined) patch.name = input.name;
        if (input.type !== undefined) patch.type = input.type;
        if (input.status !== undefined) patch.status = input.status;
        if (input.description !== undefined) patch.description = input.description;
        if (input.targetSignaturePct !== undefined) {
          patch.targetSignaturePct =
            input.targetSignaturePct === null ? null : String(input.targetSignaturePct);
        }
        if (input.startedAt !== undefined) patch.startedAt = input.startedAt;

        const [row] = await tx.update(projects).set(patch).where(eq(projects.id, id)).returning();
        if (!row) throw NOT_FOUND;
        await new AuditService(tx).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'project.update',
          targetTable: 'projects',
          targetId: row.id,
          beforeState: { name: before.name, status: before.status },
          afterState: { name: row.name, status: row.status },
          sessionId: user.sid,
        });
        return toProject(row);
      },
      { userId: user.sub },
    );
  }

  // Soft delete = archivedAt (CLAUDE.md hard rule; UI verb "ארכוב").
  // Idempotent: archiving an already-archived project still succeeds.
  async archive(user: AccessTokenPayload, id: string): Promise<void> {
    this.requireManager(user);
    await withTenant(
      user.orgId,
      async (tx) => {
        const [before] = await tx.select().from(projects).where(eq(projects.id, id)).limit(1);
        if (!before) throw NOT_FOUND;
        if (before.archivedAt) return;
        await tx
          .update(projects)
          .set({ archivedAt: sql`now()`, updatedAt: new Date() })
          .where(eq(projects.id, id));
        await new AuditService(tx).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'project.archive',
          targetTable: 'projects',
          targetId: id,
          sessionId: user.sid,
        });
      },
      { userId: user.sub },
    );
  }
}
