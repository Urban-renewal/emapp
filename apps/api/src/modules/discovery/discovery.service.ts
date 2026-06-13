import {
  AuditService,
  apartments,
  buildings,
  discoveryRecords,
  projectAssignments,
  projects,
  withTenant,
  type DiscoveryRecord as DiscoveryRecordRow,
  type TenantTx,
} from '@emapp/db';
import type {
  CreateDiscoveryRecord,
  DiscoveryRecord,
  DiscoveryStatus,
  UpdateDiscoveryRecord,
} from '@emapp/shared-types';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNull, type SQL } from 'drizzle-orm';

import { requireAgentCapability } from '../../common/authz/agent-capabilities';
import {
  decodeCursor,
  encodeCursor,
  keysetCondition,
  keysetOrderBy,
} from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';

export interface DiscoveryRecordListPage {
  data: DiscoveryRecord[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });

function toWire(r: DiscoveryRecordRow): DiscoveryRecord {
  return {
    id: r.id,
    organizationId: r.orgId,
    apartmentId: r.apartmentId,
    status: r.status as DiscoveryStatus,
    notes: r.notes,
    // §6 DEFERRED slots — always null this slice.
    recordingRef: r.recordingRef,
    transcript: r.transcript,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    archivedAt: r.archivedAt,
  };
}

/**
 * Discovery-records domain service (S3c — "renter → discovery-source").
 *
 * A discovery record is an apartment-attached DISCOVERY SOURCE: a field worker
 * spoke to whoever lives in the apartment to learn who the owner is. This is the
 * model that REPLACES the retired ownerships.relationship='renter' overload — an
 * occupant is never an owner/signer, so a discovery record carries no owner_id
 * and creates no ownership row (it can never become a signature recipient).
 *
 * Tenant isolation is via-parent (discovery_record → apartment → building →
 * project → org) enforced by RLS inside withTenant. Authz mirrors apartments
 * (the apartment is the parent resource): manager/viewer see all org records;
 * agent only for apartments whose project is an active assignment. Writes reuse
 * the apartments permission gate (`apartments.update`) at the controller + the
 * fine agent capability `edit_project_data` here.
 */
@Injectable()
export class DiscoveryService {
  // 404 unless the apartment is visible (org via RLS +, for agents, an active
  // assignment on its parent project). Mirrors OwnershipsService /
  // ApartmentsService via-parent scoping.
  private async assertApartmentVisible(
    tx: TenantTx,
    user: AccessTokenPayload,
    apartmentId: string,
  ): Promise<void> {
    if (user.role === 'agent') {
      const [row] = await tx
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
      if (!row) throw NOT_FOUND;
      return;
    }
    const [row] = await tx
      .select({ id: apartments.id })
      .from(apartments)
      .where(eq(apartments.id, apartmentId))
      .limit(1);
    if (!row) throw NOT_FOUND;
  }

  async list(
    user: AccessTokenPayload,
    apartmentId: string,
    query: { limit: number; cursor?: string },
  ): Promise<DiscoveryRecordListPage> {
    const { limit } = query;
    const cur = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cur) {
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }
    const rows = await withTenant(
      user.orgId,
      async (tx) => {
        await this.assertApartmentVisible(tx, user, apartmentId);
        const keyset: SQL | undefined = cur
          ? keysetCondition(discoveryRecords.createdAt, discoveryRecords.id, cur)
          : undefined;
        return tx
          .select()
          .from(discoveryRecords)
          .where(
            and(
              eq(discoveryRecords.apartmentId, apartmentId),
              isNull(discoveryRecords.archivedAt),
              keyset,
            ),
          )
          .orderBy(...keysetOrderBy(discoveryRecords.createdAt, discoveryRecords.id))
          .limit(limit + 1);
      },
      { userId: user.sub },
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map(toWire),
      page: { limit, cursor: hasMore && last ? encodeCursor(last) : null, has_more: hasMore },
    };
  }

  async create(
    user: AccessTokenPayload,
    apartmentId: string,
    input: CreateDiscoveryRecord,
  ): Promise<DiscoveryRecord> {
    return withTenant(
      user.orgId,
      async (tx) => {
        await this.assertApartmentVisible(tx, user, apartmentId);
        // D.46 — fine gate: an agent needs edit_project_data (manager passes).
        await requireAgentCapability(tx, user, 'edit_project_data');

        const [row] = await tx
          .insert(discoveryRecords)
          .values({
            orgId: user.orgId,
            apartmentId,
            status: input.status,
            notes: input.notes ?? null,
            createdBy: user.sub,
          })
          .returning();
        if (!row) throw NOT_FOUND;

        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'discovery_record.create',
          targetTable: 'discovery_records',
          targetId: row.id,
          afterState: { apartmentId, status: row.status },
          sessionId: user.sid,
        });
        return toWire(row);
      },
      { userId: user.sub },
    );
  }

  async update(
    user: AccessTokenPayload,
    id: string,
    input: UpdateDiscoveryRecord,
  ): Promise<DiscoveryRecord> {
    return withTenant(
      user.orgId,
      async (tx) => {
        const [before] = await tx
          .select()
          .from(discoveryRecords)
          .where(eq(discoveryRecords.id, id))
          .limit(1);
        // Foreign / unknown / cross-org (RLS hides it) → no-oracle 404.
        if (!before) throw NOT_FOUND;
        // Agent: the parent apartment must be in an assigned project (404), then
        // the fine edit gate (manager passes both).
        if (user.role === 'agent') {
          await this.assertApartmentVisible(tx, user, before.apartmentId);
        }
        await requireAgentCapability(tx, user, 'edit_project_data');

        const patch: Partial<typeof discoveryRecords.$inferInsert> = { updatedAt: new Date() };
        if (input.status !== undefined) patch.status = input.status;
        if (input.notes !== undefined) patch.notes = input.notes;

        const [row] = await tx
          .update(discoveryRecords)
          .set(patch)
          .where(eq(discoveryRecords.id, id))
          .returning();
        if (!row) throw NOT_FOUND;

        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'discovery_record.update',
          targetTable: 'discovery_records',
          targetId: row.id,
          beforeState: { status: before.status },
          afterState: { status: row.status },
          sessionId: user.sid,
        });
        return toWire(row);
      },
      { userId: user.sub },
    );
  }
}
