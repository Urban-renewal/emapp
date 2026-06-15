import {
  apartments,
  buildings,
  canDownloadDocuments,
  documents,
  projects,
  signatureProgressByProject,
  signatureScopeForShare,
  withTenant,
  type IStorageProvider,
} from '@emapp/db';
import type {
  ContractorDocument,
  ContractorDownload,
  ContractorProgress,
  ContractorProjectView,
} from '@emapp/shared-types';
import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';

import { STORAGE_PROVIDER, safeDownloadFilename } from '../documents/storage';

import type { ContractorContext } from './contractor-auth.guard';

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });
const FORBIDDEN = new ForbiddenException({ error: { code: 'forbidden' } });
const DOWNLOAD_URL_TTL_SECONDS = 300;

/**
 * D2-DEF-1 / D.46 — the contractor read-view service.
 *
 * Every method is scoped to the share's project under `withTenant(ctx.orgId)`
 * RLS, and gated by the share's JSONB permissions via the shared
 * `resolve-share` helpers (perms-driven, NOT role-hardcoded). The surface is
 * structurally narrow:
 *   - NO owner data anywhere (no owners table is ever queried) → owners-PII
 *     OFF is structural, not a runtime flag.
 *   - signature progress is AGGREGATE-only (`signatureScopeForShare` returns
 *     'aggregate' | 'none' — 'individual' is unrepresentable).
 *   - documents are PROJECT-LEVEL only (`project_id = P AND apartment_id IS
 *     NULL`) → per-owner agreements (apartment-linked) are excluded, exactly
 *     D.46 "only shared docs, NOT per-owner agreements".
 */
@Injectable()
export class ContractorReadService {
  private readonly logger = new Logger(ContractorReadService.name);

  constructor(@Inject(STORAGE_PROVIDER) private readonly storage: IStorageProvider) {}

  /** `GET /contractor/project` — project + buildings + apartments (structural). */
  async getProject(ctx: ContractorContext): Promise<ContractorProjectView> {
    if (!ctx.permissions.overview.on) throw FORBIDDEN;
    return withTenant(ctx.orgId, async (tx) => {
      const [project] = await tx
        .select({
          id: projects.id,
          name: projects.name,
          status: projects.status,
          type: projects.type,
        })
        .from(projects)
        .where(and(eq(projects.id, ctx.projectId), isNull(projects.archivedAt)))
        .limit(1);
      // Project gone/archived (or not in this org under RLS) → 404 no-oracle.
      if (!project) throw NOT_FOUND;

      const bldRows = await tx
        .select({
          id: buildings.id,
          address: buildings.address,
          city: buildings.city,
          block: buildings.block,
          parcel: buildings.parcel,
        })
        .from(buildings)
        .where(and(eq(buildings.projectId, ctx.projectId), isNull(buildings.archivedAt)))
        .orderBy(asc(buildings.address));

      // Apartments for all of the project's buildings — STRUCTURAL columns
      // only (no ownership join, no owner link).
      const aptRows = await tx
        .select({
          id: apartments.id,
          buildingId: apartments.buildingId,
          number: apartments.number,
          floor: apartments.floor,
          rooms: apartments.rooms,
          sizeSqm: apartments.sizeSqm,
          unitType: apartments.unitType,
          entrance: apartments.entrance,
        })
        .from(apartments)
        .innerJoin(buildings, eq(buildings.id, apartments.buildingId))
        .where(and(eq(buildings.projectId, ctx.projectId), isNull(apartments.archivedAt)))
        // Natural (numeric-aware) order: extracted numeral first (digitless
        // labels last), raw label as the lexical tie-break. ::numeric (not
        // ::bigint) so a pathologically long digit-run cannot overflow.
        .orderBy(
          sql`NULLIF(regexp_replace(${apartments.number}, '\\D', '', 'g'), '')::numeric ASC NULLS LAST`,
          asc(apartments.number),
        );

      const aptsByBuilding = new Map<
        string,
        ContractorProjectView['buildings'][number]['apartments']
      >();
      for (const a of aptRows) {
        const list = aptsByBuilding.get(a.buildingId) ?? [];
        list.push({
          id: a.id,
          number: a.number,
          floor: a.floor,
          rooms: a.rooms === null ? null : Number(a.rooms),
          sizeSqm: a.sizeSqm === null ? null : Number(a.sizeSqm),
          unitType: a.unitType,
          entrance: a.entrance,
        });
        aptsByBuilding.set(a.buildingId, list);
      }

      return {
        project: { id: project.id, name: project.name, status: project.status, type: project.type },
        buildings: bldRows.map((b) => ({
          id: b.id,
          address: b.address,
          city: b.city,
          block: b.block,
          parcel: b.parcel,
          apartments: aptsByBuilding.get(b.id) ?? [],
        })),
        permissions: {
          overview: ctx.permissions.overview.on,
          documents: ctx.permissions.documents.on,
          signatures: ctx.permissions.signatures.on,
        },
      };
    });
  }

  /** `GET /contractor/progress` — AGGREGATE signature counts (no who/individual). */
  async getProgress(ctx: ContractorContext): Promise<ContractorProgress> {
    // Structural aggregate-only gate: 'none' → not granted; 'aggregate' → ok.
    if (signatureScopeForShare(ctx.permissions) !== 'aggregate') throw FORBIDDEN;
    const row = await withTenant(ctx.orgId, async (tx) => {
      // PERF (D.51) + CONSENT (D.57): `signatureProgressByProject` counts only
      // signatures on ACTIVE documents (archived excluded — valid consent;
      // consistent with getDocuments/getProject here). That `archived_at IS
      // NULL` predicate also makes the partial doc indexes usable, replacing
      // the prior `(d.project_id = P OR b.project_id = P)` form which had NO
      // index path. The count resolves via idx_signature_requests_doc_status;
      // the path is structural (proven under enable_seqscan=off). Shared with
      // the tenant portal so the two tiers report identical consent semantics.
      return signatureProgressByProject(tx, ctx.projectId);
    });
    return {
      signaturesSigned: row.signed,
      signaturesPending: row.pending,
      signaturesTotal: row.signed + row.pending,
    };
  }

  /** `GET /contractor/documents` — PROJECT-LEVEL documents (manager-shared;
   *  per-owner agreements excluded). */
  async getDocuments(ctx: ContractorContext): Promise<{ data: ContractorDocument[] }> {
    if (!ctx.permissions.documents.on) throw FORBIDDEN;
    const rows = await withTenant(ctx.orgId, async (tx) =>
      tx
        .select({
          id: documents.id,
          name: documents.name,
          type: documents.type,
          mimeType: documents.mimeType,
          sizeBytes: documents.sizeBytes,
          createdAt: documents.createdAt,
        })
        .from(documents)
        .where(
          and(
            eq(documents.projectId, ctx.projectId),
            // Project-level only — per-owner (apartment-linked) agreements
            // are NEVER exposed to a contractor (D.46).
            isNull(documents.apartmentId),
            isNull(documents.archivedAt),
            // 0049 — never list/serve a ghost doc to an external contractor.
            isNotNull(documents.uploadedAt),
            // P0.B1 — FAIL-CLOSED malware gate: never list a doc to an external
            // contractor unless it scanned `clean` (download is gated too).
            eq(documents.scanStatus, 'clean'),
            // D-P5.7 — SENSITIVE docs (id_document/financial/נסח/explicit) are
            // NEVER exposed to an external contractor: this tier has no OTP
            // step-up session, so the only fail-closed posture is exclusion.
            eq(documents.sensitive, false),
          ),
        )
        .orderBy(asc(documents.name)),
    );
    return {
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        mimeType: r.mimeType,
        sizeBytes: r.sizeBytes,
        createdAt: r.createdAt,
      })),
    };
  }

  /** `GET /contractor/documents/:id/download` — presigned URL, IDOR-checked. */
  async getDownloadUrl(ctx: ContractorContext, docId: string): Promise<ContractorDownload> {
    if (!canDownloadDocuments(ctx.permissions)) throw FORBIDDEN;
    const doc = await withTenant(ctx.orgId, async (tx) => {
      const [row] = await tx
        .select({ r2Key: documents.r2Key, name: documents.name })
        .from(documents)
        .where(
          and(
            eq(documents.id, docId),
            // IDOR: the doc MUST be a project-level doc of THIS share's
            // project — any other id → 404 (no-oracle), never a minted URL.
            eq(documents.projectId, ctx.projectId),
            isNull(documents.apartmentId),
            isNull(documents.archivedAt),
            // 0049 — never list/serve a ghost doc to an external contractor.
            isNotNull(documents.uploadedAt),
            // P0.B1 — FAIL-CLOSED malware gate: an external contractor may
            // download ONLY a scan-`clean` doc; any other status → 404
            // (no-oracle), never a minted presigned URL.
            eq(documents.scanStatus, 'clean'),
            // D-P5.7 — a SENSITIVE doc is never served to a contractor (no OTP
            // step-up exists for this external tier) → 404, no-oracle.
            eq(documents.sensitive, false),
          ),
        )
        .limit(1);
      return row ?? null;
    });
    if (!doc) throw NOT_FOUND;

    try {
      const url = await this.storage.getDownloadUrl(doc.r2Key, {
        ttlSeconds: DOWNLOAD_URL_TTL_SECONDS,
        responseFilename: safeDownloadFilename(doc.name),
        responseFilenameUtf8: doc.name,
      });
      return { url, expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS };
    } catch (e) {
      this.logger.error(
        `presign(contractor download) failed (doc=${docId}): ${e instanceof Error ? e.message : 'unknown'}`,
      );
      throw new ServiceUnavailableException({ error: { code: 'storage_unavailable' } });
    }
  }
}
