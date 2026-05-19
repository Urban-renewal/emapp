import {
  AuditService,
  apartments,
  buildings,
  documents,
  projectAssignments,
  projects,
  withTenant,
  type Document as DocumentRow,
  type IStorageProvider,
  type TenantTx,
} from '@emapp/db';
import {
  DOCUMENT_MAX_SIZE_BYTES,
  type CreateDocument,
  type Document,
  type DocumentDownloadResponse,
  type DocumentUploadResponse,
  type FinalizeDocument,
  type UpdateDocument,
} from '@emapp/shared-types';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt, or, type SQL } from 'drizzle-orm';

import { decodeCursor, encodeCursor } from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';

import {
  DOWNLOAD_URL_TTL_SECONDS,
  STORAGE_PROVIDER,
  UPLOAD_URL_TTL_SECONDS,
  newDocumentKey,
  safeDownloadFilename,
} from './storage';

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });
const FORBIDDEN = new ForbiddenException({ error: { code: 'forbidden' } });

export interface DocumentListPage {
  data: Document[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

/** Map a row → wire shape. r2Key is DELIBERATELY omitted (never on the
 * wire — confidentiality: the storage pointer must not leak). */
function toDocument(r: DocumentRow): Document {
  return {
    id: r.id,
    organizationId: r.orgId,
    projectId: r.projectId,
    apartmentId: r.apartmentId,
    name: r.name,
    type: r.type as Document['type'],
    mimeType: r.mimeType as Document['mimeType'],
    sizeBytes: r.sizeBytes,
    contentHash: r.contentHash,
    uploadedBy: r.uploadedBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    archivedAt: r.archivedAt,
  };
}

/**
 * Documents domain service (Phase 4).
 *
 * Confidentiality model (user-mandated, zero-leak):
 *  - Every read is via withTenant → RLS `tenant_isolation` (org_id) FORCE.
 *  - The presigned URL is the only leak surface. It is minted ONLY after
 *    the row is authorised for the caller (org + role + per-record
 *    visibility). A foreign/unknown id → 404 and NO url is ever created.
 *  - r2Key is server-generated, unguessable, never returned.
 *  - Agent is record-scoped: only documents whose parent project is an
 *    active assignment (org-level/unparented docs are manager/viewer only).
 */
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(@Inject(STORAGE_PROVIDER) private readonly storage: IStorageProvider) {}

  private requireManager(user: AccessTokenPayload): void {
    if (user.role !== 'manager') throw FORBIDDEN;
  }

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

  // A document row is visible to an agent only if its parent project is an
  // active assignment (directly, or via its apartment's building→project).
  // Unparented (org-level) docs are NOT visible to agents (least-priv).
  private async assertDocVisibleForAgent(
    tx: TenantTx,
    user: AccessTokenPayload,
    row: DocumentRow,
  ): Promise<void> {
    if (user.role !== 'agent') return;
    if (row.projectId) {
      await this.assertProjectVisible(tx, user, row.projectId);
      return;
    }
    if (row.apartmentId) {
      await this.assertApartmentVisible(tx, user, row.apartmentId);
      return;
    }
    throw NOT_FOUND; // org-level doc, agent → indistinguishable from absent
  }

  private async loadVisible(
    tx: TenantTx,
    user: AccessTokenPayload,
    id: string,
  ): Promise<DocumentRow> {
    const [row] = await tx.select().from(documents).where(eq(documents.id, id)).limit(1);
    if (!row || row.archivedAt) throw NOT_FOUND;
    await this.assertDocVisibleForAgent(tx, user, row);
    return row;
  }

  async create(user: AccessTokenPayload, input: CreateDocument): Promise<DocumentUploadResponse> {
    this.requireManager(user);
    const r2Key = newDocumentKey(user.orgId);

    const row = await withTenant(
      user.orgId,
      async (tx) => {
        if (input.projectId) await this.assertProjectVisible(tx, user, input.projectId);
        if (input.apartmentId) await this.assertApartmentVisible(tx, user, input.apartmentId);
        let r: DocumentRow | undefined;
        try {
          [r] = await tx
            .insert(documents)
            .values({
              orgId: user.orgId,
              projectId: input.projectId ?? null,
              apartmentId: input.apartmentId ?? null,
              name: input.name,
              type: input.type,
              mimeType: input.mimeType,
              sizeBytes: input.sizeBytes,
              r2Key,
              contentHash: input.contentHash,
              uploadedBy: user.sub,
            })
            .returning();
        } catch {
          // SECURITY (review HIGH-1): a pg constraint error's `detail`
          // embeds the literal r2_key (`Key (r2_key)=(org/.../doc/...)`).
          // The global filter logs/echoes the cause chain — so NEVER let
          // the pg error propagate. Swallow it and raise a generic,
          // cause-free conflict (the server-random key makes a real
          // collision astronomically unlikely anyway).
          throw new ConflictException({ error: { code: 'document_conflict' } });
        }
        if (!r) throw new ConflictException({ error: { code: 'document_conflict' } });
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'document.create',
          targetTable: 'documents',
          targetId: r.id,
          afterState: { name: r.name, type: r.type, sizeBytes: r.sizeBytes },
          sessionId: user.sid,
        });
        return r;
      },
      { userId: user.sub },
    );

    // Presign AFTER commit (not a DB op). Bound the PUT to the declared
    // content-type and a hard size ceiling (defense-in-depth + DoS bound).
    let uploadUrl: string;
    try {
      uploadUrl = await this.storage.getUploadUrl(r2Key, {
        contentType: input.mimeType,
        maxSizeBytes: Math.min(input.sizeBytes, DOCUMENT_MAX_SIZE_BYTES),
        ttlSeconds: UPLOAD_URL_TTL_SECONDS,
      });
    } catch (e) {
      // Compensate: a row with no usable upload URL is useless — archive
      // it so it can't dangle. Never surface storage internals.
      await withTenant(
        user.orgId,
        async (tx) => {
          await tx
            .update(documents)
            .set({ archivedAt: new Date(), updatedAt: new Date() })
            .where(eq(documents.id, row.id));
        },
        { userId: user.sub },
      ).catch(() => undefined);
      this.logger.error(
        `presign(upload) failed (doc=${row.id}): ${e instanceof Error ? e.message : 'unknown'}`,
      );
      throw new BadRequestException({ error: { code: 'storage_unavailable' } });
    }

    return {
      document: toDocument(row),
      uploadUrl,
      uploadExpiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    };
  }

  // Integrity gate: the finalize-declared size/hash must match what was
  // declared at create (the presigned PUT already bound size+type). A
  // mismatch ⇒ inconsistent/confused client ⇒ archive + purge the object.
  // (True server-side recompute needs an IStorageProvider.head extension —
  // recorded as the D.28 follow-up; out of the locked interface for MVP.)
  async finalize(user: AccessTokenPayload, id: string, input: FinalizeDocument): Promise<Document> {
    this.requireManager(user);
    const result = await withTenant(
      user.orgId,
      async (tx) => {
        const row = await this.loadVisible(tx, user, id);
        const mismatch = input.sizeBytes !== row.sizeBytes || input.contentHash !== row.contentHash;
        if (mismatch) {
          await tx
            .update(documents)
            .set({ archivedAt: new Date(), updatedAt: new Date() })
            .where(eq(documents.id, row.id));
          await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: 'document.integrity_reject',
            targetTable: 'documents',
            targetId: row.id,
            sessionId: user.sid,
          });
          return { row, mismatch: true as const };
        }
        const [updated] = await tx
          .update(documents)
          .set({ updatedAt: new Date() })
          .where(eq(documents.id, row.id))
          .returning();
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'document.finalize',
          targetTable: 'documents',
          targetId: row.id,
          sessionId: user.sid,
        });
        return { row: updated ?? row, mismatch: false as const };
      },
      { userId: user.sub },
    );

    if (result.mismatch) {
      await this.storage.delete(result.row.r2Key).catch((e: unknown) => {
        this.logger.error(
          `purge after integrity reject failed (doc=${result.row.id}): ${
            e instanceof Error ? e.message : 'unknown'
          }`,
        );
      });
      throw new ConflictException({ error: { code: 'document_integrity_mismatch' } });
    }
    return toDocument(result.row);
  }

  async get(user: AccessTokenPayload, id: string): Promise<Document> {
    const row = await withTenant(user.orgId, async (tx) => this.loadVisible(tx, user, id), {
      userId: user.sub,
    });
    return toDocument(row);
  }

  async getDownloadUrl(user: AccessTokenPayload, id: string): Promise<DocumentDownloadResponse> {
    const { r2Key, name } = await withTenant(
      user.orgId,
      async (tx) => {
        const row = await this.loadVisible(tx, user, id);
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'document.download',
          targetTable: 'documents',
          targetId: row.id,
          sessionId: user.sid,
        });
        return { r2Key: row.r2Key, name: row.name };
      },
      { userId: user.sub },
    );
    // Only NOW (authorised) is a short-lived signed GET minted. Forced to
    // attachment with a sanitised filename (no header-injection / no
    // in-browser active-content execution).
    const url = await this.storage.getDownloadUrl(r2Key, {
      ttlSeconds: DOWNLOAD_URL_TTL_SECONDS,
      responseFilename: safeDownloadFilename(name),
    });
    return { url, expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS };
  }

  async list(
    user: AccessTokenPayload,
    query: { limit: number; cursor?: string; projectId?: string; apartmentId?: string },
  ): Promise<DocumentListPage> {
    const { limit } = query;
    const cur = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cur) {
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }

    const rows = await withTenant(
      user.orgId,
      async (tx) => {
        if (query.projectId) await this.assertProjectVisible(tx, user, query.projectId);
        if (query.apartmentId) await this.assertApartmentVisible(tx, user, query.apartmentId);

        const filters: (SQL | undefined)[] = [isNull(documents.archivedAt)];
        if (query.projectId) filters.push(eq(documents.projectId, query.projectId));
        if (query.apartmentId) filters.push(eq(documents.apartmentId, query.apartmentId));

        // Agent record-scoping: restrict to docs whose parent project is an
        // active assignment (directly or via apartment→building→project).
        if (user.role === 'agent') {
          const assigned = await tx
            .select({ pid: projectAssignments.projectId })
            .from(projectAssignments)
            .where(
              and(eq(projectAssignments.userId, user.sub), isNull(projectAssignments.unassignedAt)),
            );
          const pids = assigned.map((a) => a.pid);
          if (pids.length === 0) return [];
          const aptRows = await tx
            .select({ aid: apartments.id })
            .from(apartments)
            .innerJoin(buildings, eq(buildings.id, apartments.buildingId))
            .where(inArray(buildings.projectId, pids));
          const aids = aptRows.map((a) => a.aid);
          const scope = or(
            inArray(documents.projectId, pids),
            aids.length > 0 ? inArray(documents.apartmentId, aids) : undefined,
          );
          filters.push(scope);
        }

        const keyset: SQL | undefined = cur
          ? or(
              lt(documents.createdAt, new Date(cur.c)),
              and(eq(documents.createdAt, new Date(cur.c)), lt(documents.id, cur.i)),
            )
          : undefined;

        return tx
          .select()
          .from(documents)
          .where(and(...filters, keyset))
          .orderBy(desc(documents.createdAt), desc(documents.id))
          .limit(limit + 1);
      },
      { userId: user.sub },
    );

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map(toDocument),
      page: { limit, cursor: hasMore && last ? encodeCursor(last) : null, has_more: hasMore },
    };
  }

  async update(user: AccessTokenPayload, id: string, input: UpdateDocument): Promise<Document> {
    this.requireManager(user);
    return withTenant(
      user.orgId,
      async (tx) => {
        const before = await this.loadVisible(tx, user, id);
        const patch: Partial<typeof documents.$inferInsert> = { updatedAt: new Date() };
        if (input.name !== undefined) patch.name = input.name;
        if (input.type !== undefined) patch.type = input.type;
        const [row] = await tx.update(documents).set(patch).where(eq(documents.id, id)).returning();
        if (!row) throw NOT_FOUND;
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'document.update',
          targetTable: 'documents',
          targetId: row.id,
          beforeState: { name: before.name, type: before.type },
          afterState: { name: row.name, type: row.type },
          sessionId: user.sid,
        });
        return toDocument(row);
      },
      { userId: user.sub },
    );
  }

  // Soft delete = archivedAt; the storage object is best-effort purged
  // (confidentiality: don't leave the blob retrievable). Idempotent.
  async archive(user: AccessTokenPayload, id: string): Promise<void> {
    this.requireManager(user);
    const key = await withTenant(
      user.orgId,
      async (tx) => {
        const [before] = await tx.select().from(documents).where(eq(documents.id, id)).limit(1);
        if (!before) throw NOT_FOUND;
        if (before.archivedAt) return null;
        await tx
          .update(documents)
          .set({ archivedAt: new Date(), updatedAt: new Date() })
          .where(eq(documents.id, id));
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'document.archive',
          targetTable: 'documents',
          targetId: id,
          sessionId: user.sid,
        });
        return before.r2Key;
      },
      { userId: user.sub },
    );
    if (key) {
      await this.storage.delete(key).catch((e: unknown) => {
        this.logger.error(
          `purge on archive failed (doc=${id}): ${e instanceof Error ? e.message : 'unknown'}`,
        );
      });
    }
  }
}
