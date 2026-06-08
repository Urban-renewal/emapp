import {
  AuditService,
  apartments,
  buildings,
  projectAssignments,
  projects,
  withTenant,
  type Apartment as ApartmentRow,
  type TenantTx,
} from '@emapp/db';
import type { CreateApartment, Apartment, UpdateApartment } from '@emapp/shared-types';
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, lt, or, type SQL } from 'drizzle-orm';

import { requireAgentCapability } from '../../common/authz/agent-capabilities';
import { decodeCursor, encodeCursor } from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';
import { resolveNotificationRecipients } from '../notifications/notification-recipients';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';

export interface ApartmentListPage {
  data: Apartment[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

function toApartment(r: ApartmentRow): Apartment {
  return {
    id: r.id,
    buildingId: r.buildingId,
    number: r.number,
    floor: r.floor,
    // pg numeric → string from the driver; normalise to number.
    sizeSqm: num(r.sizeSqm),
    rooms: num(r.rooms),
    status: r.status,
    statusChangedAt: r.statusChangedAt,
    lastContactAt: r.lastContactAt,
    notes: r.notes,
    // V11 F1 — these 3 came in via migration 0035 (D.39) but the wire
    // shape was never extended. The smoke-discipline backfill against
    // PR #107 surfaced the gap: wizard wrote `unit_type='shop'`,
    // `area_sqm=40.00` to DB, GET returned neither. Now exposed.
    unitType: r.unitType,
    areaSqm: num(r.areaSqm),
    entrance: r.entrance,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    archivedAt: r.archivedAt,
  };
}

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });

/**
 * Apartments domain service (Phase 3 Slice 3).
 *
 * Apartments have NO org_id — tenant isolation is via-parent
 * (apartment → building → project → org) enforced by RLS inside
 * withTenant. D.17 authz owned HERE:
 *  - manager → full CRUD; viewer → read-only; both see all org apartments.
 *  - agent   → read-only, ONLY apartments whose building's project is in
 *              an active project_assignments row (service-layer JOIN; not
 *              an extra RLS policy — RLS stays = org isolation, no N+1).
 * Anything outside scope is indistinguishable from non-existent → 404.
 */
@Injectable()
export class ApartmentsService {
  private readonly logger = new Logger(ApartmentsService.name);

  constructor(private readonly notifications: NotificationsProducerService) {}

  // 404 unless the building is visible (org via RLS +, for agents, an
  // active assignment on its parent project).
  private async assertBuildingVisible(
    tx: TenantTx,
    user: AccessTokenPayload,
    buildingId: string,
  ): Promise<void> {
    if (user.role === 'agent') {
      const [row] = await tx
        .select({ id: buildings.id })
        .from(buildings)
        .innerJoin(projects, eq(projects.id, buildings.projectId))
        .innerJoin(
          projectAssignments,
          and(
            eq(projectAssignments.projectId, projects.id),
            eq(projectAssignments.userId, user.sub),
            isNull(projectAssignments.unassignedAt),
          ),
        )
        .where(eq(buildings.id, buildingId))
        .limit(1);
      if (!row) throw NOT_FOUND;
      return;
    }
    const [row] = await tx
      .select({ id: buildings.id })
      .from(buildings)
      .where(eq(buildings.id, buildingId))
      .limit(1);
    if (!row) throw NOT_FOUND;
  }

  async list(
    user: AccessTokenPayload,
    buildingId: string,
    query: { limit: number; cursor?: string },
  ): Promise<ApartmentListPage> {
    const { limit } = query;
    const cur = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cur) {
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }

    const rows = await withTenant(
      user.orgId,
      async (tx) => {
        await this.assertBuildingVisible(tx, user, buildingId);
        const keyset: SQL | undefined = cur
          ? or(
              lt(apartments.createdAt, new Date(cur.c)),
              and(eq(apartments.createdAt, new Date(cur.c)), lt(apartments.id, cur.i)),
            )
          : undefined;
        return tx
          .select()
          .from(apartments)
          .where(and(eq(apartments.buildingId, buildingId), isNull(apartments.archivedAt), keyset))
          .orderBy(desc(apartments.createdAt), desc(apartments.id))
          .limit(limit + 1);
      },
      { userId: user.sub },
    );

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map(toApartment),
      page: { limit, cursor: hasMore && last ? encodeCursor(last) : null, has_more: hasMore },
    };
  }

  async get(user: AccessTokenPayload, id: string): Promise<Apartment> {
    const row = await withTenant(
      user.orgId,
      async (tx) => {
        const [a] = await tx.select().from(apartments).where(eq(apartments.id, id)).limit(1);
        if (!a) throw NOT_FOUND;
        if (user.role === 'agent') await this.assertBuildingVisible(tx, user, a.buildingId);
        return a;
      },
      { userId: user.sub },
    );
    return toApartment(row);
  }

  async create(
    user: AccessTokenPayload,
    buildingId: string,
    input: CreateApartment,
  ): Promise<Apartment> {
    return withTenant(
      user.orgId,
      async (tx) => {
        await this.assertBuildingVisible(tx, user, buildingId);
        // D.46 — fine gate: agent needs edit_project_data (manager passes).
        await requireAgentCapability(tx, user, 'edit_project_data');
        const [row] = await tx
          .insert(apartments)
          .values({
            buildingId,
            number: input.number,
            floor: input.floor ?? null,
            sizeSqm:
              input.sizeSqm === undefined || input.sizeSqm === null ? null : String(input.sizeSqm),
            rooms: input.rooms === undefined || input.rooms === null ? null : String(input.rooms),
            status: input.status ?? 'pending',
            notes: input.notes ?? null,
            // D.39 — persist the unit_type. CreateApartmentInput defaults it
            // to 'apt' (the column's own NOT NULL DEFAULT), so it is always a
            // concrete value here; the fallback keeps the non-null invariant.
            unitType: input.unitType ?? 'apt',
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
          action: 'apartment.create',
          targetTable: 'apartments',
          targetId: row.id,
          afterState: {
            buildingId,
            number: row.number,
            status: row.status,
            unitType: row.unitType,
          },
          sessionId: user.sid,
        });
        return toApartment(row);
      },
      { userId: user.sub },
    );
  }

  async update(user: AccessTokenPayload, id: string, input: UpdateApartment): Promise<Apartment> {
    // P5.S3 / D-O7 — apartment_status_changed recipients, resolved INSIDE the
    // tx but EMITTED after commit. ONLY populated when the status ACTUALLY
    // changes (a no-op status update emits nothing). A notification must NEVER
    // fail the update, so resolution self-guards to []. Declared here to
    // survive the tx scope; the status transition is captured alongside.
    let notifyRecipientIds: string[] = [];
    let fromStatus: string | null = null;
    let toStatus: string | null = null;

    const apartment = await withTenant(
      user.orgId,
      async (tx) => {
        const [before] = await tx.select().from(apartments).where(eq(apartments.id, id)).limit(1);
        if (!before) throw NOT_FOUND;
        // D.46 — agent must be assigned to the parent building's project AND
        // hold edit_project_data (manager passes both; by-id path needs the
        // assignment check added explicitly).
        if (user.role === 'agent') await this.assertBuildingVisible(tx, user, before.buildingId);
        await requireAgentCapability(tx, user, 'edit_project_data');

        const patch: Partial<typeof apartments.$inferInsert> = { updatedAt: new Date() };
        if (input.number !== undefined) patch.number = input.number;
        if (input.floor !== undefined) patch.floor = input.floor;
        if (input.sizeSqm !== undefined) {
          patch.sizeSqm = input.sizeSqm === null ? null : String(input.sizeSqm);
        }
        if (input.rooms !== undefined) {
          patch.rooms = input.rooms === null ? null : String(input.rooms);
        }
        // D.39 — only touch unit_type when the PATCH actually sends it; an
        // omitted field leaves the existing value (UpdateApartmentInput keeps
        // unitType `.optional()` with no default for exactly this reason).
        if (input.unitType !== undefined) patch.unitType = input.unitType;
        if (input.notes !== undefined) patch.notes = input.notes;
        // statusChangedAt tracks ONLY real status transitions (used for
        // stale-lead reporting later); unchanged status must not reset it.
        if (input.status !== undefined && input.status !== before.status) {
          patch.status = input.status;
          patch.statusChangedAt = new Date();
          fromStatus = before.status;
          toStatus = input.status;

          // D-O7 — resolve recipients ONLY on a REAL status change, through the
          // ONE central helper (no inline recipient logic). The apartment's
          // project comes from apartment → building → project. Wrapped so a
          // resolver hiccup never rolls back the apartment update.
          try {
            const [bldg] = await tx
              .select({ projectId: buildings.projectId })
              .from(buildings)
              .where(eq(buildings.id, before.buildingId))
              .limit(1);
            notifyRecipientIds = await resolveNotificationRecipients(tx, user.orgId, {
              projectId: bldg?.projectId ?? null,
              actorUserId: user.sub,
            });
          } catch {
            notifyRecipientIds = [];
          }
        }

        const [row] = await tx
          .update(apartments)
          .set(patch)
          .where(eq(apartments.id, id))
          .returning();
        if (!row) throw NOT_FOUND;
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'apartment.update',
          targetTable: 'apartments',
          targetId: row.id,
          beforeState: { number: before.number, status: before.status },
          afterState: { number: row.number, status: row.status },
          sessionId: user.sid,
        });
        return toApartment(row);
      },
      { userId: user.sub },
    );

    // Fire-and-forget AFTER commit, ONLY when the status actually changed (a
    // no-op status update leaves notifyRecipientIds empty → no emit). Apartment
    // number + status are NOT PII (same-org visible labels), so they may sit in
    // the body. emitMany self-guards, and we also try/catch at the call site: a
    // notify failure must never 500 the update.
    // `toStatus` is non-null IFF the status actually changed (set together with
    // recipients inside the changed-guard). A no-op status update leaves both
    // null/empty → no emit.
    if (toStatus !== null && notifyRecipientIds.length > 0) {
      try {
        await this.notifications.emitMany(notifyRecipientIds, {
          orgId: user.orgId,
          type: 'apartment_status_changed',
          title: 'סטטוס דירה עודכן',
          body: `דירה ${apartment.number} → ${toStatus}`,
          link: null,
          metadata: {
            apartmentId: apartment.id,
            fromStatus,
            toStatus,
          },
        });
      } catch (e) {
        this.logger.error(
          `apartment_status_changed notify failed (apartment=${apartment.id}): ${
            e instanceof Error ? e.message : 'unknown'
          }`,
        );
      }
    }

    return apartment;
  }

  // Soft delete = archivedAt (CLAUDE.md hard rule). Idempotent. Preserves
  // the audit trail (T3.A.1).
  async archive(user: AccessTokenPayload, id: string): Promise<void> {
    await withTenant(
      user.orgId,
      async (tx) => {
        const [before] = await tx.select().from(apartments).where(eq(apartments.id, id)).limit(1);
        if (!before) throw NOT_FOUND;
        if (user.role === 'agent') await this.assertBuildingVisible(tx, user, before.buildingId);
        await requireAgentCapability(tx, user, 'edit_project_data');
        if (before.archivedAt) return;
        await tx
          .update(apartments)
          .set({ archivedAt: new Date(), updatedAt: new Date() })
          .where(eq(apartments.id, id));
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'apartment.archive',
          targetTable: 'apartments',
          targetId: id,
          sessionId: user.sid,
        });
      },
      { userId: user.sub },
    );
  }
}
