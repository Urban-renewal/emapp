import {
  AuditService,
  apartments,
  buildings,
  notes,
  projectAssignments,
  projects,
  withTenant,
  type TenantTx,
} from '@emapp/db';
import type { CreateNote, Note, UpdateNote } from '@emapp/shared-types';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

import { decodeCursor, encodeCursor } from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';
import { resolveNotificationRecipients } from '../notifications/notification-recipients';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';

export interface NoteListPage {
  data: Note[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });
const FORBIDDEN = new ForbiddenException({ error: { code: 'forbidden' } });

function toNote(r: typeof notes.$inferSelect): Note {
  return {
    id: r.id,
    organizationId: r.orgId,
    projectId: r.projectId,
    apartmentId: r.apartmentId,
    body: r.body,
    pinned: r.isPinned === 'true',
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    archivedAt: r.archivedAt,
  };
}

/**
 * Notes domain service (Phase 3 Slice 8). Org-scoped (notes.org_id →
 * direct RLS). D.17:
 *  - manager/viewer → see all org notes; manager writes any.
 *  - agent → may create; sees only notes they authored OR notes on a
 *    project in their active assignments OR org-level (no project/apt);
 *    may update/archive only their OWN notes.
 *  - viewer → read-only.
 * Notes are not PII; org RLS is the hard isolation boundary.
 */
@Injectable()
export class NotesService {
  private readonly logger = new Logger(NotesService.name);

  constructor(private readonly notifications: NotificationsProducerService) {}

  private agentVisibility(user: AccessTokenPayload): SQL | undefined {
    if (user.role !== 'agent') return undefined;
    // own OR org-level OR project in an active assignment.
    return or(
      eq(notes.createdBy, user.sub),
      and(isNull(notes.projectId), isNull(notes.apartmentId)),
      sql`${notes.projectId} IN (
        SELECT project_id FROM project_assignments
        WHERE user_id = ${user.sub} AND unassigned_at IS NULL
      )`,
    );
  }

  private async assertProjectVisible(
    tx: TenantTx,
    user: AccessTokenPayload,
    projectId: string,
  ): Promise<void> {
    if (user.role === 'agent') {
      const [r] = await tx
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
      if (!r) throw NOT_FOUND;
      return;
    }
    const [r] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!r) throw NOT_FOUND;
  }

  private async assertApartmentVisible(
    tx: TenantTx,
    user: AccessTokenPayload,
    apartmentId: string,
  ): Promise<void> {
    if (user.role === 'agent') {
      const [r] = await tx
        .select({ id: apartments.id })
        .from(apartments)
        .innerJoin(buildings, eq(buildings.id, apartments.buildingId))
        .innerJoin(projects, eq(projects.id, buildings.projectId))
        .innerJoin(
          projectAssignments,
          and(
            eq(projectAssignments.projectId, projects.id),
            eq(projectAssignments.userId, user.sub),
            isNull(projectAssignments.unassignedAt),
          ),
        )
        .where(eq(apartments.id, apartmentId))
        .limit(1);
      if (!r) throw NOT_FOUND;
      return;
    }
    const [r] = await tx
      .select({ id: apartments.id })
      .from(apartments)
      .where(eq(apartments.id, apartmentId))
      .limit(1);
    if (!r) throw NOT_FOUND;
  }

  async list(
    user: AccessTokenPayload,
    query: { limit: number; cursor?: string },
  ): Promise<NoteListPage> {
    const { limit } = query;
    const cur = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cur) {
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }
    const rows = await withTenant(
      user.orgId,
      async (tx) =>
        tx
          .select()
          .from(notes)
          .where(
            and(
              isNull(notes.archivedAt),
              this.agentVisibility(user),
              cur
                ? or(
                    lt(notes.createdAt, new Date(cur.c)),
                    and(eq(notes.createdAt, new Date(cur.c)), lt(notes.id, cur.i)),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(notes.createdAt), desc(notes.id))
          .limit(limit + 1),
      { userId: user.sub },
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map(toNote),
      page: { limit, cursor: hasMore && last ? encodeCursor(last) : null, has_more: hasMore },
    };
  }

  async get(user: AccessTokenPayload, id: string): Promise<Note> {
    const [row] = await withTenant(
      user.orgId,
      async (tx) =>
        tx
          .select()
          .from(notes)
          .where(and(eq(notes.id, id), this.agentVisibility(user)))
          .limit(1),
      { userId: user.sub },
    );
    if (!row) throw NOT_FOUND;
    return toNote(row);
  }

  async create(user: AccessTokenPayload, input: CreateNote): Promise<Note> {
    if (user.role === 'viewer') throw FORBIDDEN;
    // P5.S3 / D-O7 — note_added recipients, resolved INSIDE the tx (an org-
    // scoped read satisfying the producer's recipient∈org invariant) but
    // EMITTED after commit. A notification must NEVER fail the note create, so
    // resolution self-guards to []. Declared here to survive the tx scope.
    let notifyRecipientIds: string[] = [];

    const note = await withTenant(
      user.orgId,
      async (tx) => {
        if (input.projectId) await this.assertProjectVisible(tx, user, input.projectId);
        if (input.apartmentId) await this.assertApartmentVisible(tx, user, input.apartmentId);
        const [row] = await tx
          .insert(notes)
          .values({
            orgId: user.orgId,
            projectId: input.projectId ?? null,
            apartmentId: input.apartmentId ?? null,
            body: input.body,
            isPinned: input.pinned ? 'true' : null,
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
          action: 'note.create',
          targetTable: 'notes',
          targetId: row.id,
          sessionId: user.sid,
        });

        // D-O7 — resolve recipients through the ONE central helper (no inline
        // recipient logic). Project context: a note may be attached directly to
        // a project, or to an apartment (apartment → building → project), or to
        // neither (org-level). When there is NO project context we pass
        // projectId=undefined and the engine still notifies managers-always.
        // Wrapped so a resolver hiccup never rolls back the note create.
        try {
          let notifyProjectId = row.projectId;
          if (!notifyProjectId && row.apartmentId) {
            const [apt] = await tx
              .select({ projectId: buildings.projectId })
              .from(apartments)
              .innerJoin(buildings, eq(buildings.id, apartments.buildingId))
              .where(eq(apartments.id, row.apartmentId))
              .limit(1);
            notifyProjectId = apt?.projectId ?? null;
          }
          notifyRecipientIds = await resolveNotificationRecipients(tx, user.orgId, {
            projectId: notifyProjectId,
            actorUserId: user.sub,
          });
        } catch {
          notifyRecipientIds = [];
        }
        return toNote(row);
      },
      { userId: user.sub },
    );

    // Fire-and-forget AFTER commit. PII DECISION: a note's free-text `body` may
    // be sensitive (it can mention residents, money, disputes), so it is NEVER
    // placed in the notification body. The notification carries only a generic
    // static label; the noteId in metadata lets a recipient open the real note
    // through the normal RLS-scoped read. emitMany self-guards, and we also
    // try/catch at the call site: a notify failure must never 500 the create.
    if (notifyRecipientIds.length > 0) {
      try {
        await this.notifications.emitMany(notifyRecipientIds, {
          orgId: user.orgId,
          type: 'note_added',
          title: 'הערה חדשה נוספה',
          body: 'נוספה הערה חדשה.',
          link: null,
          metadata: { noteId: note.id },
        });
      } catch (e) {
        this.logger.error(
          `note_added notify failed (note=${note.id}): ${e instanceof Error ? e.message : 'unknown'}`,
        );
      }
    }

    return note;
  }

  async update(user: AccessTokenPayload, id: string, input: UpdateNote): Promise<Note> {
    // Audit H-5 fix — viewer must be rejected BEFORE the author-equality
    // check (an ex-agent demoted to viewer kept their old notes editable
    // because the role check was `!== 'manager'`).
    if (user.role === 'viewer') throw FORBIDDEN;
    return withTenant(
      user.orgId,
      async (tx) => {
        const [before] = await tx.select().from(notes).where(eq(notes.id, id)).limit(1);
        // Audit M-3 fix — collapse "exists but not yours" 403 into 404
        // so agents can't enumerate other users' note IDs (no oracle).
        // Matches the docs/tasks loadVisible pattern.
        if (!before) throw NOT_FOUND;
        if (user.role !== 'manager' && before.createdBy !== user.sub) throw NOT_FOUND;
        const patch: Partial<typeof notes.$inferInsert> = { updatedAt: new Date() };
        if (input.body !== undefined) patch.body = input.body;
        if (input.pinned !== undefined) patch.isPinned = input.pinned ? 'true' : null;
        const [row] = await tx.update(notes).set(patch).where(eq(notes.id, id)).returning();
        if (!row) throw NOT_FOUND;
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'note.update',
          targetTable: 'notes',
          targetId: row.id,
          sessionId: user.sid,
        });
        return toNote(row);
      },
      { userId: user.sub },
    );
  }

  async archive(user: AccessTokenPayload, id: string): Promise<void> {
    // Audit H-5 fix — viewer rejected before author check (see update).
    if (user.role === 'viewer') throw FORBIDDEN;
    await withTenant(
      user.orgId,
      async (tx) => {
        const [before] = await tx.select().from(notes).where(eq(notes.id, id)).limit(1);
        // Audit M-3 fix — 403→404 to remove existence oracle.
        if (!before) throw NOT_FOUND;
        if (user.role !== 'manager' && before.createdBy !== user.sub) throw NOT_FOUND;
        if (before.archivedAt) return;
        await tx
          .update(notes)
          .set({ archivedAt: new Date(), updatedAt: new Date() })
          .where(eq(notes.id, id));
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'note.archive',
          targetTable: 'notes',
          targetId: id,
          sessionId: user.sid,
        });
      },
      { userId: user.sub },
    );
  }
}
