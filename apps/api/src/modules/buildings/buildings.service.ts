import {
  AuditService,
  buildings,
  projectAssignments,
  projects,
  withTenant,
  type Building as BuildingRow,
  type TenantTx,
} from '@emapp/db';
import type { CreateBuilding, Building, UpdateBuilding } from '@emapp/shared-types';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, lt, or, type SQL } from 'drizzle-orm';

import { decodeCursor, encodeCursor } from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';

export interface BuildingListPage {
  data: Building[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

function toBuilding(r: BuildingRow): Building {
  return {
    id: r.id,
    projectId: r.projectId,
    address: r.address,
    city: r.city,
    block: r.block,
    parcel: r.parcel,
    subparcel: r.subparcel,
    aptCount: r.aptCount,
    notes: r.notes,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    archivedAt: r.archivedAt,
  };
}

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });
const FORBIDDEN = new ForbiddenException({ error: { code: 'forbidden' } });

/**
 * Buildings domain service (Phase 3 Slice 2).
 *
 * Buildings have NO org_id — tenant isolation is "via-parent": RLS inside
 * withTenant only exposes buildings whose project belongs to the caller's
 * org. D.17 authz is owned HERE:
 *  - manager → full CRUD; viewer → read-only; both see all org buildings.
 *  - agent   → read-only, ONLY buildings whose parent project is in an
 *              active project_assignments row (service-layer JOIN; not an
 *              extra RLS policy — keeps RLS = org isolation, no N+1).
 * A building/project outside the caller's scope is indistinguishable from a
 * non-existent one → 404 (no oracle).
 */
@Injectable()
export class BuildingsService {
  private requireManager(user: AccessTokenPayload): void {
    if (user.role !== 'manager') throw FORBIDDEN;
  }

  // Throws 404 unless the project is visible to this user (org via RLS +,
  // for agents, an active assignment). Returns nothing — visibility only.
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
  ): Promise<BuildingListPage> {
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
              lt(buildings.createdAt, new Date(cur.c)),
              and(eq(buildings.createdAt, new Date(cur.c)), lt(buildings.id, cur.i)),
            )
          : undefined;
        return tx
          .select()
          .from(buildings)
          .where(and(eq(buildings.projectId, projectId), isNull(buildings.archivedAt), keyset))
          .orderBy(desc(buildings.createdAt), desc(buildings.id))
          .limit(limit + 1);
      },
      { userId: user.sub },
    );

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map(toBuilding),
      page: { limit, cursor: hasMore && last ? encodeCursor(last) : null, has_more: hasMore },
    };
  }

  async get(user: AccessTokenPayload, id: string): Promise<Building> {
    const row = await withTenant(
      user.orgId,
      async (tx) => {
        const [b] = await tx.select().from(buildings).where(eq(buildings.id, id)).limit(1);
        if (!b) throw NOT_FOUND;
        // via-parent agent scoping: the parent project must be assigned.
        if (user.role === 'agent') await this.assertProjectVisible(tx, user, b.projectId);
        return b;
      },
      { userId: user.sub },
    );
    return toBuilding(row);
  }

  async create(
    user: AccessTokenPayload,
    projectId: string,
    input: CreateBuilding,
  ): Promise<Building> {
    this.requireManager(user);
    return withTenant(
      user.orgId,
      async (tx) => {
        await this.assertProjectVisible(tx, user, projectId);
        const [row] = await tx
          .insert(buildings)
          .values({
            projectId,
            address: input.address,
            city: input.city,
            block: input.block ?? null,
            parcel: input.parcel ?? null,
            subparcel: input.subparcel ?? null,
            aptCount: input.aptCount ?? 0,
            notes: input.notes ?? null,
          })
          .returning();
        if (!row) throw new Error('building insert returned no row');
        await new AuditService(tx).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'building.create',
          targetTable: 'buildings',
          targetId: row.id,
          afterState: { projectId, address: row.address, city: row.city },
          sessionId: user.sid,
        });
        return toBuilding(row);
      },
      { userId: user.sub },
    );
  }

  async update(user: AccessTokenPayload, id: string, input: UpdateBuilding): Promise<Building> {
    this.requireManager(user);
    return withTenant(
      user.orgId,
      async (tx) => {
        const [before] = await tx.select().from(buildings).where(eq(buildings.id, id)).limit(1);
        if (!before) throw NOT_FOUND;

        const patch: Partial<typeof buildings.$inferInsert> = { updatedAt: new Date() };
        if (input.address !== undefined) patch.address = input.address;
        if (input.city !== undefined) patch.city = input.city;
        if (input.block !== undefined) patch.block = input.block;
        if (input.parcel !== undefined) patch.parcel = input.parcel;
        if (input.subparcel !== undefined) patch.subparcel = input.subparcel;
        if (input.aptCount !== undefined) patch.aptCount = input.aptCount;
        if (input.notes !== undefined) patch.notes = input.notes;

        const [row] = await tx.update(buildings).set(patch).where(eq(buildings.id, id)).returning();
        if (!row) throw NOT_FOUND;
        await new AuditService(tx).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'building.update',
          targetTable: 'buildings',
          targetId: row.id,
          beforeState: { address: before.address, city: before.city },
          afterState: { address: row.address, city: row.city },
          sessionId: user.sid,
        });
        return toBuilding(row);
      },
      { userId: user.sub },
    );
  }

  // Soft delete = archivedAt (CLAUDE.md hard rule). Idempotent.
  async archive(user: AccessTokenPayload, id: string): Promise<void> {
    this.requireManager(user);
    await withTenant(
      user.orgId,
      async (tx) => {
        const [before] = await tx.select().from(buildings).where(eq(buildings.id, id)).limit(1);
        if (!before) throw NOT_FOUND;
        if (before.archivedAt) return;
        await tx
          .update(buildings)
          .set({ archivedAt: new Date(), updatedAt: new Date() })
          .where(eq(buildings.id, id));
        await new AuditService(tx).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'building.archive',
          targetTable: 'buildings',
          targetId: id,
          sessionId: user.sid,
        });
      },
      { userId: user.sub },
    );
  }
}
