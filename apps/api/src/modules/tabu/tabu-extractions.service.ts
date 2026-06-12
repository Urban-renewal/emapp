import {
  AuditService,
  apartments,
  buildings,
  documents,
  encryptField,
  env as dbEnv,
  projectAssignments,
  projects,
  tabuExtractionRows,
  tabuExtractions,
  withTenant,
  type IExtractionProvider,
  type IStorageProvider,
  type TabuExtraction as TabuExtractionRow,
  type TenantTx,
} from '@emapp/db';
import type {
  CreateTabuExtraction,
  TabuExtraction,
  TabuExtractionStatus,
} from '@emapp/shared-types';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull, lt, or, type SQL } from 'drizzle-orm';

import { requireAgentCapability } from '../../common/authz/agent-capabilities';
import { decodeCursor, encodeCursor } from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';
import { STORAGE_PROVIDER } from '../documents/storage';

import { EXTRACTION_PROVIDER } from './extraction-provider.factory';

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
 * 7b-extract adds the parse RUN: runExtraction() reads the FINALIZED source-doc
 * bytes via the storage provider, hands them to a PLUGGABLE IExtractionProvider
 * (default Stub — no external call, no PII leaves), then ENCRYPTS the parsed
 * owner PII (name + national_id, pgcrypto) and stores one tabu_extraction_rows
 * row per owner. A re-run on a draft REPLACES the prior rows. The provider seam
 * (storage + extractionProvider) is constructor-injected — mirrors
 * DocumentsService(storage, scanner, …) — so the 7b deps are added WITHOUT
 * breaking the 7a envelope tests (they construct without args is no longer
 * possible, but Nest provides both tokens; the run-spec injects stubs).
 */
@Injectable()
export class TabuExtractionsService {
  constructor(
    @Inject(STORAGE_PROVIDER) private readonly storage: IStorageProvider,
    @Inject(EXTRACTION_PROVIDER) private readonly extractionProvider: IExtractionProvider,
  ) {}

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

        // 5b. 7b-OTP (D-P5.7) — a נסח holds owner PII (names + national_id),
        //     so the SOURCE document becomes SENSITIVE the moment an
        //     extraction is attached to it (turn-ON only, never off). Its
        //     download now requires the per-session PII step-up unlock.
        if (!doc.sensitive) {
          await tx
            .update(documents)
            .set({ sensitive: true, updatedAt: new Date() })
            .where(eq(documents.id, doc.id));
        }

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

  /** Read a source object's full bytes via the storage provider. The source נסח
   *  is a small document; we buffer it whole (the worker's streaming cap is for
   *  the 50MB import path, not single-doc reads). Always closes the stream. */
  private async readObjectBytes(key: string): Promise<Buffer> {
    const stream = await this.storage.getObjectStream(key);
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of stream) {
        chunks.push(chunk as Buffer);
      }
    } finally {
      // Half-open R2 streams leak a connection — ensure it is closed.
      stream.destroy();
    }
    return Buffer.concat(chunks);
  }

  /**
   * 7b-extract — RUN the pluggable extraction engine on a DRAFT extraction and
   * store the parsed owner/share rows ENCRYPTED.
   *
   * Flow (all inside one withTenant → RLS org-isolation):
   *   1. Load the extraction; foreign/unknown (RLS-hidden) OR non-draft → 404.
   *      For an agent, the parent apartment must be in an assigned project.
   *   2. D.54 — requireAgentCapability('edit_project_data') in THIS named method
   *      (the static guard does not cover named service methods). An assigned
   *      agent WITHOUT the capability → 403, NO rows written.
   *   3. Load the FINALIZED source document (org-scoped by RLS) + read its bytes.
   *   4. extractionProvider.extract({bytes, mimeType, text}) — DEFAULT Stub makes
   *      NO external call; NO PII leaves the process.
   *   5. DELETE any prior rows for this extraction (a re-run REPLACES them).
   *   6. For each parsed row: ENCRYPT name + national_id (pgcrypto,
   *      PII_ENCRYPTION_KEY) and INSERT a tabu_extraction_rows row (ciphertext +
   *      share + confidence + position).
   *   7. ENCRYPT + store raw_text on the extraction; stamp extraction_engine +
   *      extracted_at.
   *   8. Audit (ids + rowCount + engineId ONLY — NEVER any PII value).
   *
   * Returns { rowCount, engineId }. NEVER logs PII.
   */
  async runExtraction(
    user: AccessTokenPayload,
    extractionId: string,
  ): Promise<{ rowCount: number; engineId: string }> {
    const encKey = dbEnv.PII_ENCRYPTION_KEY;
    if (!encKey) {
      throw new Error('PII_ENCRYPTION_KEY is required for tabu extraction');
    }

    return withTenant(
      user.orgId,
      async (tx) => {
        // 1. Load the extraction (RLS org-scoped). Foreign/unknown → no-oracle 404.
        const [extraction] = await tx
          .select()
          .from(tabuExtractions)
          .where(eq(tabuExtractions.id, extractionId))
          .limit(1);
        if (!extraction) throw NOT_FOUND;
        // Only a DRAFT can be (re-)run — a confirmed/discarded extraction is
        // terminal. Same no-oracle 404 (don't reveal the lifecycle state).
        if (extraction.status !== 'draft') throw NOT_FOUND;
        // For an agent, the parent apartment must be in an assigned project.
        await this.assertApartmentVisible(tx, user, extraction.apartmentId);

        // 2. D.54 — fine gate in this named method (manager passes; an assigned
        //    agent needs edit_project_data). Ordered AFTER visibility so it is
        //    never an existence oracle.
        await requireAgentCapability(tx, user, 'edit_project_data');

        // 3. Load the source document (org-scoped by RLS) + RE-ASSERT it is
        //    finalized — uploaded AND scan-clean — before reading its bytes.
        //    Mirrors create()'s finalized gate (P0.B1 AV gate): a doc that has
        //    since been quarantined (scan_status != 'clean') must never have its
        //    bytes read + parsed here, even though it was finalized at create-time.
        const [doc] = await tx
          .select()
          .from(documents)
          .where(eq(documents.id, extraction.sourceDocumentId))
          .limit(1);
        if (!doc || doc.archivedAt) throw NOT_FOUND;
        if (!doc.uploadedAt || doc.scanStatus !== 'clean') throw DOC_NOT_FINALIZED;

        const bytes = await this.readObjectBytes(doc.r2Key);

        // 4. Pluggable engine — default Stub makes NO external call.
        const result = await this.extractionProvider.extract({
          bytes,
          mimeType: doc.mimeType,
          text: bytes.toString('utf8'),
        });

        // 5. A re-run REPLACES prior rows for this draft (DELETE-then-INSERT).
        await tx
          .delete(tabuExtractionRows)
          .where(eq(tabuExtractionRows.extractionId, extractionId));

        // 6. Encrypt PII + insert one row per parsed owner. NEVER log the values.
        let position = 0;
        for (const row of result.rows) {
          const nameEncrypted =
            row.name != null && row.name !== '' ? await encryptField(tx, row.name, encKey) : null;
          const nationalIdEncrypted =
            row.nationalId != null && row.nationalId !== ''
              ? await encryptField(tx, row.nationalId, encKey)
              : null;
          await tx.insert(tabuExtractionRows).values({
            extractionId,
            orgId: user.orgId,
            nameEncrypted,
            nationalIdEncrypted,
            shareNumerator: row.shareNumerator ?? null,
            shareDenominator: row.shareDenominator ?? null,
            confidence: row.confidence ?? null,
            position,
          });
          position += 1;
        }

        // 7. Encrypt + store raw_text on the extraction; stamp engine + time.
        const rawTextEncrypted =
          result.rawText != null && result.rawText !== ''
            ? await encryptField(tx, result.rawText, encKey)
            : null;
        await tx
          .update(tabuExtractions)
          .set({
            rawTextEncrypted,
            extractionEngine: result.engineId,
            extractedAt: new Date(),
          })
          .where(eq(tabuExtractions.id, extractionId));

        // 8. Audit — ids + rowCount + engineId ONLY. NEVER any PII value.
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'tabu_extraction.run',
          targetTable: 'tabu_extractions',
          targetId: extractionId,
          metadata: {
            rowCount: result.rows.length,
            engineId: result.engineId,
            sourceDocumentId: doc.id,
          },
          sessionId: user.sid,
        });

        return { rowCount: result.rows.length, engineId: result.engineId };
      },
      { userId: user.sub },
    );
  }
}
