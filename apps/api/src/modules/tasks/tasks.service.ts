import {
  AuditService,
  memberships,
  taskAssignees,
  tasks,
  withTenant,
  type TenantTx,
} from '@emapp/db';
import type { AssignTask, CreateTask, Task, TaskAssignee, UpdateTask } from '@emapp/shared-types';
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

export interface TaskListPage {
  data: Task[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });
const FORBIDDEN = new ForbiddenException({ error: { code: 'forbidden' } });

function toTask(r: typeof tasks.$inferSelect): Task {
  return {
    id: r.id,
    organizationId: r.orgId,
    projectId: r.projectId,
    apartmentId: r.apartmentId,
    title: r.title,
    description: r.description,
    type: r.type,
    status: r.status,
    priority: r.priority,
    dueAt: r.dueAt,
    durationMinutes: r.durationMinutes,
    completedAt: r.completedAt,
    completedBy: r.completedBy,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    archivedAt: r.archivedAt,
  };
}

/**
 * Tasks domain service (Phase 3 Slice 7). Tasks are ORG-scoped (tasks
 * .org_id → direct RLS in withTenant). D.17:
 *  - manager → full CRUD, sees all org tasks.
 *  - viewer  → read-only, all org tasks.
 *  - agent   → sees ONLY tasks assigned to them (T3.T.1, service-layer
 *              JOIN on task_assignees); may update status/description of
 *              their own assigned tasks; no create/delete.
 * Notification generation on assignment + SSE is Phase 5 (T3.N.1) — the
 * locked notifications RLS (user_id = app.user_id) forbids an actor
 * inserting another user's notification anyway. Deferred & recorded.
 */
@Injectable()
export class TasksService {
  private requireManager(user: AccessTokenPayload): void {
    if (user.role !== 'manager') throw FORBIDDEN;
  }

  private async assertMember(tx: TenantTx, orgId: string, userId: string): Promise<void> {
    const [m] = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.userId, userId),
          eq(memberships.orgId, orgId),
          isNull(memberships.revokedAt),
        ),
      )
      .limit(1);
    if (!m) throw new BadRequestException({ error: { code: 'invalid_assignee' } });
  }

  async list(
    user: AccessTokenPayload,
    query: { limit: number; cursor?: string },
  ): Promise<TaskListPage> {
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
              lt(tasks.createdAt, new Date(cur.c)),
              and(eq(tasks.createdAt, new Date(cur.c)), lt(tasks.id, cur.i)),
            )
          : undefined;
        if (user.role === 'agent') {
          return tx
            .select({ t: tasks })
            .from(tasks)
            .innerJoin(
              taskAssignees,
              and(eq(taskAssignees.taskId, tasks.id), eq(taskAssignees.userId, user.sub)),
            )
            .where(and(isNull(tasks.archivedAt), keyset))
            .orderBy(desc(tasks.createdAt), desc(tasks.id))
            .limit(limit + 1)
            .then((res) => res.map((x) => x.t));
        }
        return tx
          .select()
          .from(tasks)
          .where(and(isNull(tasks.archivedAt), keyset))
          .orderBy(desc(tasks.createdAt), desc(tasks.id))
          .limit(limit + 1);
      },
      { userId: user.sub },
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map(toTask),
      page: { limit, cursor: hasMore && last ? encodeCursor(last) : null, has_more: hasMore },
    };
  }

  private async loadVisible(
    tx: TenantTx,
    user: AccessTokenPayload,
    id: string,
  ): Promise<typeof tasks.$inferSelect> {
    if (user.role === 'agent') {
      const [r] = await tx
        .select({ t: tasks })
        .from(tasks)
        .innerJoin(
          taskAssignees,
          and(eq(taskAssignees.taskId, tasks.id), eq(taskAssignees.userId, user.sub)),
        )
        .where(eq(tasks.id, id))
        .limit(1);
      if (!r) throw NOT_FOUND;
      return r.t;
    }
    const [r] = await tx.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!r) throw NOT_FOUND;
    return r;
  }

  async get(user: AccessTokenPayload, id: string): Promise<Task> {
    const row = await withTenant(user.orgId, async (tx) => this.loadVisible(tx, user, id), {
      userId: user.sub,
    });
    return toTask(row);
  }

  async create(user: AccessTokenPayload, input: CreateTask): Promise<Task> {
    this.requireManager(user);
    return withTenant(
      user.orgId,
      async (tx) => {
        const [row] = await tx
          .insert(tasks)
          .values({
            orgId: user.orgId,
            projectId: input.projectId ?? null,
            apartmentId: input.apartmentId ?? null,
            title: input.title,
            description: input.description ?? null,
            type: input.type ?? 'general',
            priority: input.priority ?? 2,
            dueAt: input.dueAt ?? null,
            durationMinutes: input.durationMinutes ?? null,
            createdBy: user.sub,
          })
          .returning();
        if (!row) throw new Error('task insert returned no row');
        const assigneeIds = [...new Set(input.assigneeIds ?? [])];
        if (assigneeIds.length > 0) {
          for (const uid of assigneeIds) await this.assertMember(tx, user.orgId, uid);
          await tx
            .insert(taskAssignees)
            .values(
              assigneeIds.map((uid) => ({ taskId: row.id, userId: uid, assignedBy: user.sub })),
            );
        }
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'task.create',
          targetTable: 'tasks',
          targetId: row.id,
          afterState: { title: row.title, assignees: assigneeIds.length },
          sessionId: user.sid,
        });
        return toTask(row);
      },
      { userId: user.sub },
    );
  }

  async update(user: AccessTokenPayload, id: string, input: UpdateTask): Promise<Task> {
    return withTenant(
      user.orgId,
      async (tx) => {
        const before = await this.loadVisible(tx, user, id); // 404/scope first

        // Agents may only touch status/description on their assigned tasks.
        if (user.role !== 'manager') {
          const touched = Object.keys(input);
          const allowed = new Set(['status', 'description']);
          if (user.role === 'viewer' || touched.some((k) => !allowed.has(k))) {
            throw FORBIDDEN;
          }
        }

        const patch: Partial<typeof tasks.$inferInsert> = { updatedAt: new Date() };
        if (input.title !== undefined) patch.title = input.title;
        if (input.description !== undefined) patch.description = input.description;
        if (input.type !== undefined) patch.type = input.type;
        if (input.priority !== undefined) patch.priority = input.priority;
        if (input.dueAt !== undefined) patch.dueAt = input.dueAt;
        if (input.durationMinutes !== undefined) patch.durationMinutes = input.durationMinutes;
        if (input.projectId !== undefined) patch.projectId = input.projectId;
        if (input.apartmentId !== undefined) patch.apartmentId = input.apartmentId;
        if (input.status !== undefined) {
          patch.status = input.status;
          if (input.status === 'completed' && before.status !== 'completed') {
            patch.completedAt = new Date();
            patch.completedBy = user.sub;
          } else if (input.status !== 'completed') {
            patch.completedAt = null;
            patch.completedBy = null;
          }
        }

        const [row] = await tx.update(tasks).set(patch).where(eq(tasks.id, id)).returning();
        if (!row) throw NOT_FOUND;
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'task.update',
          targetTable: 'tasks',
          targetId: row.id,
          afterState: { status: row.status },
          sessionId: user.sid,
        });
        return toTask(row);
      },
      { userId: user.sub },
    );
  }

  async archive(user: AccessTokenPayload, id: string): Promise<void> {
    this.requireManager(user);
    await withTenant(
      user.orgId,
      async (tx) => {
        const [before] = await tx
          .select({ id: tasks.id, archivedAt: tasks.archivedAt })
          .from(tasks)
          .where(eq(tasks.id, id))
          .limit(1);
        if (!before) throw NOT_FOUND;
        if (before.archivedAt) return;
        await tx
          .update(tasks)
          .set({ archivedAt: new Date(), updatedAt: new Date() })
          .where(eq(tasks.id, id));
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'task.archive',
          targetTable: 'tasks',
          targetId: id,
          sessionId: user.sid,
        });
      },
      { userId: user.sub },
    );
  }

  async listAssignees(user: AccessTokenPayload, taskId: string): Promise<TaskAssignee[]> {
    return withTenant(
      user.orgId,
      async (tx) => {
        await this.loadVisible(tx, user, taskId);
        const rows = await tx
          .select()
          .from(taskAssignees)
          .where(eq(taskAssignees.taskId, taskId))
          .orderBy(desc(taskAssignees.assignedAt));
        return rows.map((r) => ({
          id: r.id,
          taskId: r.taskId,
          userId: r.userId,
          assignedAt: r.assignedAt,
        }));
      },
      { userId: user.sub },
    );
  }

  async addAssignee(
    user: AccessTokenPayload,
    taskId: string,
    input: AssignTask,
  ): Promise<TaskAssignee> {
    this.requireManager(user);
    try {
      return await withTenant(
        user.orgId,
        async (tx) => {
          await this.loadVisible(tx, user, taskId);
          await this.assertMember(tx, user.orgId, input.userId);
          const [row] = await tx
            .insert(taskAssignees)
            .values({ taskId, userId: input.userId, assignedBy: user.sub })
            .returning();
          if (!row) throw new Error('assignee insert returned no row');
          await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: 'task.assign',
            targetTable: 'task_assignees',
            targetId: row.id,
            afterState: { taskId, userId: input.userId },
            sessionId: user.sid,
          });
          return { id: row.id, taskId: row.taskId, userId: row.userId, assignedAt: row.assignedAt };
        },
        { userId: user.sub },
      );
    } catch (e) {
      if (isUniqueViolation(e, 'task_assignees_task_user_unique')) {
        throw new ConflictException({ error: { code: 'assignee_exists' } });
      }
      throw e;
    }
  }

  async removeAssignee(user: AccessTokenPayload, taskId: string, userId: string): Promise<void> {
    this.requireManager(user);
    await withTenant(
      user.orgId,
      async (tx) => {
        await this.loadVisible(tx, user, taskId);
        const deleted = await tx
          .delete(taskAssignees)
          .where(and(eq(taskAssignees.taskId, taskId), eq(taskAssignees.userId, userId)))
          .returning({ id: taskAssignees.id });
        if (deleted.length === 0) throw NOT_FOUND;
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'task.unassign',
          targetTable: 'task_assignees',
          targetId: deleted[0]?.id ?? taskId,
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
