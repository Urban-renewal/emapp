import { AuditService, contractors, withTenant } from '@emapp/db';
import type { Contractor, CreateContractor, UpdateContractor } from '@emapp/shared-types';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';

import { decodeCursor, encodeCursor } from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';

export interface ContractorListPage {
  data: Contractor[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });
const FORBIDDEN = new ForbiddenException({ error: { code: 'forbidden' } });

function toContractor(r: typeof contractors.$inferSelect): Contractor {
  return {
    id: r.id,
    organizationId: r.orgId,
    name: r.name,
    contactEmail: r.contactEmail,
    contactPhone: r.contactPhone,
    companyId: r.companyId,
    specialty: r.specialty,
    notes: r.notes,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    archivedAt: r.archivedAt,
  };
}

/**
 * Contractors domain service (Phase 3 Slice 6). Org-scoped (contractors
 * .org_id → direct RLS in withTenant). D.17: read = any org role; write =
 * manager. Unique contactEmail per org (active) → 409 contractor_exists.
 */
@Injectable()
export class ContractorsService {
  private requireManager(user: AccessTokenPayload): void {
    if (user.role !== 'manager') throw FORBIDDEN;
  }

  async list(
    user: AccessTokenPayload,
    query: { limit: number; cursor?: string },
  ): Promise<ContractorListPage> {
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
          .from(contractors)
          .where(
            and(
              isNull(contractors.archivedAt),
              cur
                ? or(
                    lt(contractors.createdAt, new Date(cur.c)),
                    and(eq(contractors.createdAt, new Date(cur.c)), lt(contractors.id, cur.i)),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(contractors.createdAt), desc(contractors.id))
          .limit(limit + 1),
      { userId: user.sub },
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map(toContractor),
      page: { limit, cursor: hasMore && last ? encodeCursor(last) : null, has_more: hasMore },
    };
  }

  async get(user: AccessTokenPayload, id: string): Promise<Contractor> {
    const [row] = await withTenant(
      user.orgId,
      async (tx) => tx.select().from(contractors).where(eq(contractors.id, id)).limit(1),
      { userId: user.sub },
    );
    if (!row) throw NOT_FOUND;
    return toContractor(row);
  }

  async create(user: AccessTokenPayload, input: CreateContractor): Promise<Contractor> {
    this.requireManager(user);
    try {
      return await withTenant(
        user.orgId,
        async (tx) => {
          const [row] = await tx
            .insert(contractors)
            .values({
              orgId: user.orgId,
              name: input.name,
              contactEmail: input.contactEmail,
              contactPhone: input.contactPhone ?? null,
              companyId: input.companyId ?? null,
              specialty: input.specialty ?? null,
              notes: input.notes ?? null,
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
            action: 'contractor.create',
            targetTable: 'contractors',
            targetId: row.id,
            afterState: { name: row.name },
            sessionId: user.sid,
          });
          return toContractor(row);
        },
        { userId: user.sub },
      );
    } catch (e) {
      if (isUniqueViolation(e, 'contractors_org_email_active')) {
        throw new ConflictException({ error: { code: 'contractor_exists' } });
      }
      throw e;
    }
  }

  async update(user: AccessTokenPayload, id: string, input: UpdateContractor): Promise<Contractor> {
    this.requireManager(user);
    try {
      return await withTenant(
        user.orgId,
        async (tx) => {
          const [before] = await tx
            .select({ id: contractors.id })
            .from(contractors)
            .where(eq(contractors.id, id))
            .limit(1);
          if (!before) throw NOT_FOUND;
          const patch: Partial<typeof contractors.$inferInsert> = { updatedAt: new Date() };
          if (input.name !== undefined) patch.name = input.name;
          if (input.contactEmail !== undefined) patch.contactEmail = input.contactEmail;
          if (input.contactPhone !== undefined) patch.contactPhone = input.contactPhone;
          if (input.companyId !== undefined) patch.companyId = input.companyId;
          if (input.specialty !== undefined) patch.specialty = input.specialty;
          if (input.notes !== undefined) patch.notes = input.notes;
          const [row] = await tx
            .update(contractors)
            .set(patch)
            .where(eq(contractors.id, id))
            .returning();
          if (!row) throw NOT_FOUND;
          await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: 'contractor.update',
            targetTable: 'contractors',
            targetId: row.id,
            afterState: { name: row.name },
            sessionId: user.sid,
          });
          return toContractor(row);
        },
        { userId: user.sub },
      );
    } catch (e) {
      if (isUniqueViolation(e, 'contractors_org_email_active')) {
        throw new ConflictException({ error: { code: 'contractor_exists' } });
      }
      throw e;
    }
  }

  async archive(user: AccessTokenPayload, id: string): Promise<void> {
    this.requireManager(user);
    await withTenant(
      user.orgId,
      async (tx) => {
        const [before] = await tx
          .select({ id: contractors.id, archivedAt: contractors.archivedAt })
          .from(contractors)
          .where(eq(contractors.id, id))
          .limit(1);
        if (!before) throw NOT_FOUND;
        if (before.archivedAt) return;
        await tx
          .update(contractors)
          .set({ archivedAt: new Date(), updatedAt: new Date() })
          .where(eq(contractors.id, id));
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'contractor.archive',
          targetTable: 'contractors',
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
