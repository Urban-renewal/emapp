import {
  apartments,
  AuditService,
  buildings,
  memberships,
  projectAssignments,
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
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

import { agentHasCapability, requireAgentCapability } from '../../common/authz/agent-capabilities';
import { decodeCursor, encodeCursor } from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';
import { CalendarEmailService } from '../calendar-email/calendar-email.service';
import { resolveNotificationRecipients } from '../notifications/notification-recipients';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';

export interface TaskListPage {
  data: Task[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });

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
    // V11 B.S5 F3 — D.38 calendar fields. Expose what migration 0036
    // wrote at the DB layer; otherwise the WeekCalendar A.S12 consumer
    // (and any direct curl GET) can't see what we wrote. Smoke caught
    // this on the same PR — same class as F1 (B.S1 column gap closed
    // by F1 fix-PR in #118).
    scheduledAt: r.scheduledAt,
    location: r.location,
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
 *  - agent   → READS only tasks assigned to them (T3.T.1, service-layer JOIN on
 *              task_assignees). WRITES (D.46 + D.54 close-out): with manage_tasks
 *              on an assigned-project task → full management (create/update/
 *              archive/assignees, destination-scoped); OR, as a plain ASSIGNEE of
 *              a task, the narrow update of status/description only.
 * Notification generation on assignment + SSE is Phase 5 (T3.N.1) — the
 * locked notifications RLS (user_id = app.user_id) forbids an actor
 * inserting another user's notification anyway. Deferred & recorded.
 */
@Injectable()
export class TasksService {
  // V11 B.S7 (D.38) — best-effort ICS dispatch after create/update/
  // archive. Injected lazily (constructor) so tests can override with
  // a stub provider; the service itself swallows failures so a broken
  // email path NEVER fails a task write.
  constructor(
    private readonly calendarEmail: CalendarEmailService,
    private readonly notifications: NotificationsProducerService,
  ) {}

  /**
   * D.46 — manage_tasks agent scope. A task is editable by an agent only if its
   * project (or its apartment's building's project) is an active assignment.
   * Org-level tasks (no project/apartment) → 404 (agent can't manage). No-op for
   * non-agents. Used by ALL task write methods after the org-existence load and
   * before requireAgentCapability('manage_tasks'). NOTE: READ scoping (list/get)
   * stays assignee-based (taskAssignees) — a separate concern from write.
   */
  private async assertTaskVisibleForAgent(
    tx: TenantTx,
    user: AccessTokenPayload,
    scope: { projectId: string | null; apartmentId: string | null },
  ): Promise<void> {
    if (!(await this.agentScopeOk(tx, user, scope))) throw NOT_FOUND;
  }

  /**
   * Non-throwing form of {@link assertTaskVisibleForAgent}: does the agent
   * actively manage the task's project (directly or via its apartment's
   * building's project)? Non-agents → always true. Org-level scope → false
   * (agents can't manage unparented tasks). Used by `update` to pick the FULL
   * (manage_tasks) path vs the narrow assignee path without a premature throw.
   */
  private async agentScopeOk(
    tx: TenantTx,
    user: AccessTokenPayload,
    scope: { projectId: string | null; apartmentId: string | null },
  ): Promise<boolean> {
    if (user.role !== 'agent') return true;
    if (scope.projectId) {
      const [r] = await tx
        .select({ x: sql`1` })
        .from(projectAssignments)
        .where(
          and(
            eq(projectAssignments.projectId, scope.projectId),
            eq(projectAssignments.userId, user.sub),
            isNull(projectAssignments.unassignedAt),
          ),
        )
        .limit(1);
      return Boolean(r);
    }
    if (scope.apartmentId) {
      const [r] = await tx
        .select({ x: sql`1` })
        .from(apartments)
        .innerJoin(buildings, eq(buildings.id, apartments.buildingId))
        .innerJoin(
          projectAssignments,
          and(
            eq(projectAssignments.projectId, buildings.projectId),
            eq(projectAssignments.userId, user.sub),
            isNull(projectAssignments.unassignedAt),
          ),
        )
        .where(eq(apartments.id, scope.apartmentId))
        .limit(1);
      return Boolean(r);
    }
    return false; // org-level task — not agent-manageable via the project path
  }

  /** Is this agent an assignee of the task (task_assignees row)? Agent-only. */
  private async agentIsAssignee(
    tx: TenantTx,
    user: AccessTokenPayload,
    taskId: string,
  ): Promise<boolean> {
    const [r] = await tx
      .select({ x: sql`1` })
      .from(taskAssignees)
      .where(and(eq(taskAssignees.taskId, taskId), eq(taskAssignees.userId, user.sub)))
      .limit(1);
    return Boolean(r);
  }

  /**
   * D.54 close-out — the NARROW assignee update path. An agent who is an
   * assignee of a task (but lacks the manage_tasks + project-scope FULL path)
   * may still update ONLY status / description (the "סטטוס / הערות / בוצע"
   * field-agent workflow). Any other field in the patch (project, apartment,
   * title, type, priority, due/duration, schedule, location) → 403: managing the
   * task itself requires manage_tasks. `assigneeId` cannot arrive here — there is
   * no assignee field on UpdateTask (assignment is a separate endpoint).
   */
  private assertNarrowAssigneeUpdate(input: UpdateTask): void {
    const ALLOWED = new Set<keyof UpdateTask>(['status', 'description']);
    const offending = (Object.keys(input) as (keyof UpdateTask)[]).filter(
      (k) => input[k] !== undefined && !ALLOWED.has(k),
    );
    if (offending.length > 0) {
      throw new ForbiddenException({
        error: {
          code: 'task_assignee_update_scope',
          message:
            'assignee may update only status and notes; managing the task needs manage_tasks',
        },
      });
    }
  }

  /**
   * V11 B.S7 (D.38) — fire-and-forget ICS dispatch. Runs OUTSIDE the
   * withTenant tx (the tx has already committed by the time we call
   * this from the post-write hooks below), so a slow Resend round-trip
   * doesn't hold the row-level lock and a failed send doesn't roll
   * back the task. Best-effort posture: the service logs its own
   * failures; we swallow any unexpected throw to keep the caller's
   * promise resolved.
   */
  private fireCalendarEmail(
    orgId: string,
    taskId: string,
    action: 'create' | 'update' | 'cancel',
  ): void {
    void this.calendarEmail.sendInviteForTask(orgId, taskId, action).catch(() => {
      // CalendarEmailService logs per-attendee failures internally; an
      // unexpected throw here (DB load failure, etc.) is also already
      // logged. Swallow to keep this hook truly fire-and-forget.
    });
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

  /**
   * Create a task. D-O6 — the creating user (`user.sub`) is auto-added to
   * the task's assignee set. Task READ visibility for agents is
   * assignee-based (see `loadVisible`/`list`), so without auto-assigning
   * the creator a freshly-created task would VANISH from its creator's
   * view. The assignee `Set` de-dups, so a creator who also appears in
   * `input.assigneeIds` still yields exactly ONE `task_assignees` row.
   */
  async create(user: AccessTokenPayload, input: CreateTask): Promise<Task> {
    // P5 slice 2 / D-O7 — recipients for the task_assigned notification, resolved
    // INSIDE the create tx (an org-scoped read, satisfying the producer's
    // recipient∈org invariant) but EMITTED after commit. Declared here to survive
    // the tx scope. A notification must NEVER fail the create, so resolution
    // self-guards to []. (Same pattern as document_uploaded's retrofit.)
    let notifyRecipientIds: string[] = [];

    const { created } = await withTenant(
      user.orgId,
      async (tx) => {
        // D.46 — agent: the new task must be scoped to a visible project/
        // apartment (org-level task create → 404), then manage_tasks (403).
        await this.assertTaskVisibleForAgent(tx, user, {
          projectId: input.projectId ?? null,
          apartmentId: input.apartmentId ?? null,
        });
        await requireAgentCapability(tx, user, 'manage_tasks');
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
            // V11 B.S5 F3 — D.38 calendar fields, optional on create.
            scheduledAt: input.scheduledAt ?? null,
            location: input.location ?? null,
            createdBy: user.sub,
          })
          .returning();
        if (!row)
          throw new InternalServerErrorException({
            error: { code: 'insert_no_row', message: 'unexpected db state' },
          });
        // D-O6 — auto-assign the creator. The Set de-dups, so a creator who
        // is also in input.assigneeIds yields exactly one task_assignees row.
        const assigneeIds = [...new Set([user.sub, ...(input.assigneeIds ?? [])])];
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
        // P5 slice 2 / D-O7 — resolve task_assigned recipients through the ONE
        // central engine (`resolveNotificationRecipients`), no inline recipient
        // logic. relevantUserIds = the task's assignees (creator INCLUDED here,
        // but the engine drops the actor below); actorUserId = user.sub (the
        // creator). We DELIBERATELY pass NO projectId: task_assigned is an
        // entity/action event — it must NOT fan out to ALL project-assigned
        // agents, only the assignees ∪ always-on managers (D-O7) − the actor.
        // The creator is thus EXCLUDED from "a task was assigned to you" for
        // their own task (closing the actor-exclusion deferred in D-O6).
        // Wrapped so a resolver hiccup never rolls back the create.
        try {
          notifyRecipientIds = await resolveNotificationRecipients(tx, user.orgId, {
            relevantUserIds: assigneeIds,
            actorUserId: user.sub,
          });
        } catch {
          notifyRecipientIds = [];
        }
        return { created: toTask(row) };
      },
      { userId: user.sub },
    );
    // In-app task_assigned notification for the resolved recipient set (the
    // OTHER assignees ∪ org managers − the creator). Best-effort, after commit,
    // self-guarded (a notify failure never fails create). Body carries only the
    // task title (org-visible, non-PII). emitMany dedupes + self-guards per id.
    if (notifyRecipientIds.length > 0) {
      try {
        await this.notifications.emitMany(notifyRecipientIds, {
          orgId: user.orgId,
          type: 'task_assigned',
          title: 'הוקצתה לך משימה',
          body: `המשימה "${created.title}" הוקצתה לך.`,
          link: null,
          metadata: { taskId: created.id },
        });
      } catch {
        // swallowed: task already committed; notification is best-effort.
      }
    }
    // V11 B.S7 (D.38) — after-tx ICS dispatch. Only if the task has
    // a scheduled time; CalendarEmailService also short-circuits on
    // no-attendees, but we avoid even the inner DB read for the common
    // case of a non-calendar to-do.
    if (created.scheduledAt) {
      this.fireCalendarEmail(user.orgId, created.id, 'create');
    }
    return created;
  }

  async update(user: AccessTokenPayload, id: string, input: UpdateTask): Promise<Task> {
    const { updated, hadScheduledBefore, calendarFieldChanged } = await withTenant(
      user.orgId,
      async (tx) => {
        const [before] = await tx.select().from(tasks).where(eq(tasks.id, id)).limit(1);
        if (!before) throw NOT_FOUND;
        // D.46 + D.54 close-out — agent has TWO ways to update a task:
        //
        //  (A) FULL management — the task's CURRENT project is an active
        //      assignment AND the agent holds manage_tasks. Then it is full-field
        //      management, including re-targeting project/apartment (subject to a
        //      DESTINATION scope check, #191 — the NEW scope must also be assigned,
        //      so a task can't be moved into an uncontrolled project or demoted to
        //      org-level).
        //
        //  (B) NARROW assignee path — the agent is an ASSIGNEE of this task
        //      (task_assignees) but lacks the FULL path. Then ONLY status /
        //      description may change (the field-agent "status / notes / done"
        //      workflow); any other field → 403. This restores the pre-D.46
        //      assignee-can-update-their-own-task behaviour WITHOUT re-opening
        //      full management to non-manage_tasks agents.
        //
        // An agent in NEITHER bucket → 404 (no task oracle). Manager skips both.
        if (user.role === 'agent') {
          const fullPath =
            (await this.agentScopeOk(tx, user, before)) &&
            (await agentHasCapability(tx, user, 'manage_tasks'));
          if (fullPath) {
            if (input.projectId !== undefined || input.apartmentId !== undefined) {
              await this.assertTaskVisibleForAgent(tx, user, {
                projectId: input.projectId !== undefined ? input.projectId : before.projectId,
                apartmentId:
                  input.apartmentId !== undefined ? input.apartmentId : before.apartmentId,
              });
            }
          } else {
            if (!(await this.agentIsAssignee(tx, user, id))) throw NOT_FOUND;
            this.assertNarrowAssigneeUpdate(input);
          }
        }
        const hadScheduledBeforeLocal = before.scheduledAt !== null;

        const patch: Partial<typeof tasks.$inferInsert> = { updatedAt: new Date() };
        if (input.title !== undefined) patch.title = input.title;
        if (input.description !== undefined) patch.description = input.description;
        if (input.type !== undefined) patch.type = input.type;
        if (input.priority !== undefined) patch.priority = input.priority;
        if (input.dueAt !== undefined) patch.dueAt = input.dueAt;
        if (input.durationMinutes !== undefined) patch.durationMinutes = input.durationMinutes;
        // V11 B.S5 F3 — D.38 calendar fields editable on PATCH. D.46: a manager
        // OR an agent with manage_tasks (gated above) edits ALL fields — full
        // management, no status/description-only restriction.
        if (input.scheduledAt !== undefined) patch.scheduledAt = input.scheduledAt;
        if (input.location !== undefined) patch.location = input.location;
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
        // H2 — did an edit actually change a CALENDAR-relevant field? Only these
        // affect the ICS payload (title/description/location/scheduledAt/duration).
        // Used below to suppress a spurious ICS UPDATE re-send when the edit
        // touched only non-calendar fields (status/priority/dueAt/type/assignees)
        // — otherwise every task edit re-mails every external attendee.
        const calendarFieldChanged =
          (input.title !== undefined && input.title !== before.title) ||
          (input.description !== undefined && input.description !== before.description) ||
          (input.location !== undefined && input.location !== before.location) ||
          (input.durationMinutes !== undefined &&
            input.durationMinutes !== before.durationMinutes) ||
          (input.scheduledAt !== undefined &&
            (input.scheduledAt?.getTime() ?? null) !== (before.scheduledAt?.getTime() ?? null));
        return {
          updated: toTask(row),
          hadScheduledBefore: hadScheduledBeforeLocal,
          calendarFieldChanged,
        };
      },
      { userId: user.sub },
    );
    // V11 B.S7 (D.38) — after-tx ICS dispatch:
    //   - was-scheduled AND is-scheduled  → UPDATE (clients refresh)
    //   - was-scheduled AND now-cleared   → CANCEL (clients remove)
    //   - was-not-scheduled AND now-set   → CREATE (clients add fresh)
    //   - was-not AND still-not           → no-op
    const hasScheduledNow = updated.scheduledAt !== null;
    if (hadScheduledBefore && hasScheduledNow) {
      // H2 — re-send the ICS UPDATE only when a calendar field actually changed.
      // A non-calendar edit (status/priority/assignee/etc.) must NOT re-mail
      // every external attendee. (CANCEL/CREATE below are themselves calendar
      // state transitions, so they always fire.)
      if (calendarFieldChanged) this.fireCalendarEmail(user.orgId, updated.id, 'update');
    } else if (hadScheduledBefore && !hasScheduledNow) {
      this.fireCalendarEmail(user.orgId, updated.id, 'cancel');
    } else if (!hadScheduledBefore && hasScheduledNow) {
      this.fireCalendarEmail(user.orgId, updated.id, 'create');
    }
    return updated;
  }

  async archive(user: AccessTokenPayload, id: string): Promise<void> {
    const cancelInfo = await withTenant(
      user.orgId,
      async (tx) => {
        const [before] = await tx
          .select({
            id: tasks.id,
            archivedAt: tasks.archivedAt,
            scheduledAt: tasks.scheduledAt,
            projectId: tasks.projectId,
            apartmentId: tasks.apartmentId,
          })
          .from(tasks)
          .where(eq(tasks.id, id))
          .limit(1);
        if (!before) throw NOT_FOUND;
        // D.46 — agent: project assignment (404) + manage_tasks (403) first.
        await this.assertTaskVisibleForAgent(tx, user, before);
        await requireAgentCapability(tx, user, 'manage_tasks');
        if (before.archivedAt) return { shouldCancel: false };
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
        // V11 B.S7 (D.38) — only fire CANCEL for tasks that actually
        // had a calendar event. Non-calendar to-dos don't need an ICS
        // METHOD:CANCEL (recipients never received a REQUEST).
        return { shouldCancel: before.scheduledAt !== null };
      },
      { userId: user.sub },
    );
    if (cancelInfo.shouldCancel) {
      this.fireCalendarEmail(user.orgId, id, 'cancel');
    }
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
    let result: { row: TaskAssignee; taskTitle: string; notifyRecipientIds: string[] };
    try {
      result = await withTenant(
        user.orgId,
        async (tx) => {
          // D.46 — agent: project assignment (404) + manage_tasks (403).
          const [task] = await tx
            .select({
              projectId: tasks.projectId,
              apartmentId: tasks.apartmentId,
              title: tasks.title,
            })
            .from(tasks)
            .where(eq(tasks.id, taskId))
            .limit(1);
          if (!task) throw NOT_FOUND;
          await this.assertTaskVisibleForAgent(tx, user, task);
          await requireAgentCapability(tx, user, 'manage_tasks');
          await this.assertMember(tx, user.orgId, input.userId);
          const [row] = await tx
            .insert(taskAssignees)
            .values({ taskId, userId: input.userId, assignedBy: user.sub })
            .returning();
          if (!row)
            throw new InternalServerErrorException({
              error: { code: 'insert_no_row', message: 'unexpected db state' },
            });
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
          // P5 slice 2 / D-O7 — resolve task_assigned recipients through the ONE
          // central engine, no inline recipient logic. relevantUserIds = the
          // newly-assigned user; actorUserId = user.sub (the assigner). NO
          // projectId (entity/action event — assignees ∪ always-on managers −
          // actor, NOT a project-wide fan-out). If the assigner assigns
          // themselves they're dropped as the actor; the other managers still
          // get it. Wrapped so a resolver hiccup never rolls back the assign.
          let notifyRecipientIds: string[] = [];
          try {
            notifyRecipientIds = await resolveNotificationRecipients(tx, user.orgId, {
              relevantUserIds: [input.userId],
              actorUserId: user.sub,
            });
          } catch {
            notifyRecipientIds = [];
          }
          return {
            row: { id: row.id, taskId: row.taskId, userId: row.userId, assignedAt: row.assignedAt },
            taskTitle: task.title,
            notifyRecipientIds,
          };
        },
        { userId: user.sub },
      );
    } catch (e) {
      if (isUniqueViolation(e, 'task_assignees_task_user_unique')) {
        throw new ConflictException({ error: { code: 'assignee_exists' } });
      }
      throw e;
    }
    // In-app task_assigned notification to the resolved recipient set (the
    // newly-assigned user ∪ org managers − the assigner). Fired AFTER the tx
    // commits. The producer self-guards, but we ALSO try/catch here (defense-in-
    // depth, same posture as the post-sign notify) so a notify failure can NEVER
    // fail the assignment. The task title is org-visible, non-PII; never pass
    // owner/national_id/phone. emitMany dedupes + self-guards per id.
    if (result.notifyRecipientIds.length > 0) {
      try {
        await this.notifications.emitMany(result.notifyRecipientIds, {
          orgId: user.orgId,
          type: 'task_assigned',
          title: 'הוקצתה לך משימה',
          body: `המשימה "${result.taskTitle}" הוקצתה לך.`,
          link: null,
          metadata: { taskId },
        });
      } catch {
        // swallowed: the assignment already committed; notification is best-effort.
      }
    }
    return result.row;
  }

  async removeAssignee(user: AccessTokenPayload, taskId: string, userId: string): Promise<void> {
    await withTenant(
      user.orgId,
      async (tx) => {
        // D.46 — agent: project assignment (404) + manage_tasks (403).
        const [task] = await tx
          .select({ projectId: tasks.projectId, apartmentId: tasks.apartmentId })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .limit(1);
        if (!task) throw NOT_FOUND;
        await this.assertTaskVisibleForAgent(tx, user, task);
        await requireAgentCapability(tx, user, 'manage_tasks');
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
