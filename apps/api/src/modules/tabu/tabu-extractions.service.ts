import {
  AuditService,
  apartments,
  buildings,
  documents,
  projectAssignments,
  projects,
  tabuExtractions,
  withTenant,
  type TabuExtraction as TabuExtractionRow,
  type TenantTx,
} from '@emapp/db';
import type {
  CreateTabuExtraction,
  TabuExtraction,
  TabuExtractionStatus,
} from '@emapp/shared-types';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull, lt, or, type SQL } from 'drizzle-orm';

import { requireAgentCapability } from '../../common/authz/agent-capabilities';
import { decodeCursor, encodeCursor } from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });

/** The source document is not in a state that can be extracted (not finalized
 * — upload never completed, or AV scan not clean). 409: the doc exists + is
 * visible to the caller, but conflicts with starting an extraction. Only ever
 * reached AFTER the apartment-visibility + apartment-scope checks pass, so it is
 * never an existence oracle for foreign/other-apartment documents. */
const DOC_NOT_FINALIZED = new BadRequestException({
  error: { code: 'tabu_source_not_finalized' },
});

export interface TabuExtractionListPage {
  data: TabuExtraction[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

function toWire(r: TabuExtractionRow): TabuExtraction {
  return {
    id: r.id,
    apartmentId: r.apartmentId,
    sourceDocumentId: r.sourceDocumentId,
    status: r.status as TabuExtractionStatus,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    confirmedAt: r.confirmedAt,
  };
}

/**
 * Tabu-extractions domain service (S7a — the extraction ENVELOPE + lifecycle).
 *
 * A tabu_extraction is the apartment-attached envelope around a single Tabu
 * (נסח טאבו) extraction run: it points at the FINALIZED source document the
 * parse will read and carries a draft→confirmed/discarded lifecycle. This slice
 * is the envelope ONLY — NO parse, NO owner/share PII rows, NO commit (those are
 * 7b/7c). The service holds no PII.
 *
 * Tenant isolation is direct org_id (documents-style) enforced by RLS inside
 * withTenant. Authz mirrors apartments (the apartment is the parent resource):
 * manager/viewer see all org rows; an agent only for apartments whose project is
 * an active assignment. The create WRITE additionally requires the fine agent
 * capability `edit_project_data` (D.54) — gated in the named create() method.
 *
 * NOTE: no constructor deps in 7a (envelope only — no storage/scan/notification
 * needed), so the test harness can `new TabuExtractionsService()`.
 */
@Injectable()
export class TabuExtractionsService {
  // 404 unless the apartment is visible (org via RLS +, for agents, an active
  // assignment on its parent project). Mirrors DocumentsService /
  // DiscoveryService via-parent scoping.
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

  async create(
    user: AccessTokenPayload,
    apartmentId: string,
    input: CreateTabuExtraction,
  ): Promise<TabuExtraction> {
    return withTenant(
      user.orgId,
      async (tx) => {
        // 1. The apartment must be visible to the caller (org via RLS +, for an
        //    agent, an active assignment). Foreign-org/foreign apartment → 404.
        await this.assertApartmentVisible(tx, user, apartmentId);
        // 2. D.54 — fine gate: an agent needs edit_project_data (manager passes).
        //    MUST be in this named create() method (the static D.54 guard does
        //    not cover named service methods).
        await requireAgentCapability(tx, user, 'edit_project_data');

        // 3. Load the source document (org-scoped by RLS). Unknown/foreign-org →
        //    no-oracle 404.
        const [doc] = await tx
          .select()
          .from(documents)
          .where(eq(documents.id, input.documentId))
          .limit(1);
        if (!doc || doc.archivedAt) throw NOT_FOUND;
        // 4. The doc must belong to THIS apartment. A finalized doc on a
        //    different apartment → 404 (it is not a valid source here; do not
        //    leak that it exists elsewhere).
        if (doc.apartmentId !== apartmentId) throw NOT_FOUND;
        // 5. The doc must be FINALIZED: uploaded_at NOT NULL AND scan_status =
        //    'clean'. A ghost / un-scanned doc cannot be extracted. Ordered AFTER
        //    the visibility + apartment-scope checks → never an existence oracle.
        if (!doc.uploadedAt || doc.scanStatus !== 'clean') throw DOC_NOT_FINALIZED;

        // 6. Insert the draft envelope.
        const [row] = await tx
          .insert(tabuExtractions)
          .values({
            orgId: user.orgId,
            apartmentId,
            sourceDocumentId: doc.id,
            status: 'draft',
            createdBy: user.sub,
          })
          .returning();
        if (!row) throw NOT_FOUND;

        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'tabu_extraction.create',
          targetTable: 'tabu_extractions',
          targetId: row.id,
          afterState: { apartmentId, sourceDocumentId: doc.id, status: row.status },
          sessionId: user.sid,
        });
        return toWire(row);
      },
      { userId: user.sub },
    );
  }

  async list(
    user: AccessTokenPayload,
    apartmentId: string,
    query?: { limit?: number; cursor?: string },
  ): Promise<TabuExtractionListPage> {
    const limit = query?.limit ?? 20;
    const cursor = query?.cursor;
    const cur = cursor ? decodeCursor(cursor) : null;
    if (cursor && !cur) {
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }
    const rows = await withTenant(
      user.orgId,
      async (tx) => {
        await this.assertApartmentVisible(tx, user, apartmentId);
        const keyset: SQL | undefined = cur
          ? or(
              lt(tabuExtractions.createdAt, new Date(cur.c)),
              and(eq(tabuExtractions.createdAt, new Date(cur.c)), lt(tabuExtractions.id, cur.i)),
            )
          : undefined;
        return tx
          .select()
          .from(tabuExtractions)
          .where(and(eq(tabuExtractions.apartmentId, apartmentId), keyset))
          .orderBy(desc(tabuExtractions.createdAt), desc(tabuExtractions.id))
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

  async getOne(user: AccessTokenPayload, id: string): Promise<TabuExtraction> {
    const row = await withTenant(
      user.orgId,
      async (tx) => {
        const [r] = await tx
          .select()
          .from(tabuExtractions)
          .where(eq(tabuExtractions.id, id))
          .limit(1);
        // Foreign / unknown / cross-org (RLS hides it) → no-oracle 404.
        if (!r) throw NOT_FOUND;
        // For an agent, the parent apartment must be in an assigned project.
        if (user.role === 'agent') {
          await this.assertApartmentVisible(tx, user, r.apartmentId);
        }
        return r;
      },
      { userId: user.sub },
    );
    return toWire(row);
  }
}
