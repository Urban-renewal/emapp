import {
  AuditService,
  apartments,
  authSessions,
  buildings,
  documents,
  projectAssignments,
  projects,
  withTenant,
  type Document as DocumentRow,
  type IFileScanProvider,
  type IStorageProvider,
  type TenantTx,
} from '@emapp/db';
import {
  DOCUMENT_MAX_SIZE_BYTES,
  DOCUMENT_SCAN_REJECTED_CODE,
  DOCUMENT_UPLOAD_INCOMPLETE_CODE,
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
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, desc, eq, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

import { requireAgentCapability } from '../../common/authz/agent-capabilities';
import { decodeCursor, encodeCursor } from '../../common/keyset-cursor';
import { getOrgSettings } from '../../common/org-settings.resolver';
import type { AccessTokenPayload } from '../auth/auth.service';
import { resolveNotificationRecipients } from '../notifications/notification-recipients';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';

import { FILE_SCAN_PROVIDER } from './scan-provider.factory';
import {
  DOWNLOAD_URL_TTL_SECONDS,
  STORAGE_PROVIDER,
  UPLOAD_URL_TTL_SECONDS,
  newDocumentKey,
  safeDownloadFilename,
} from './storage';

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });

/**
 * P0.B1 — the anti-malware scan did not return `clean` (infected, or the scan
 * could not complete). FAIL-CLOSED: the document is archived + purged and is
 * never servable. 409 (the object genuinely exists but is in a state that
 * conflicts with serving it). Like UPLOAD_INCOMPLETE, only reachable AFTER the
 * per-record visibility check, so it is never an existence oracle.
 */
const SCAN_REJECTED = new ConflictException({
  error: { code: DOCUMENT_SCAN_REJECTED_CODE },
});

/**
 * 7b-OTP (D-P5.5/7/8) — the caller's session has NO valid PII unlock for a
 * SENSITIVE document. 403, DISTINCT + actionable (the FE opens the step-up
 * OTP dialog), NOT 404: this is only ever thrown AFTER the per-record
 * visibility check passed, so the caller is already authorized to know the
 * doc exists — it is never an existence oracle.
 */
const PII_STEP_UP_REQUIRED = new ForbiddenException({
  error: { code: 'pii_step_up_required', message: 'נדרש אימות נוסף לצפייה במסמך רגיש' },
});

/** PII-bearing document types — sensitive-by-type at create (D-P5.7). */
const SENSITIVE_DOC_TYPES: ReadonlySet<string> = new Set(['id_document', 'financial']);

/** P0.B1 — read an object's bytes (bounded) for scanning. The scanner takes a
 *  lazy loader so a provider that fetches out-of-band never triggers this. */
async function readObjectBytes(
  storage: IStorageProvider,
  key: string,
  maxBytes: number,
): Promise<Buffer> {
  const stream = await storage.getObjectStream(key);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      total += buf.length;
      // Defense-in-depth: never buffer past the declared ceiling even if the
      // object is unexpectedly larger (the presign already bounded the PUT).
      if (total > maxBytes) {
        throw new Error('object_exceeds_scan_ceiling');
      }
      chunks.push(buf);
    }
  } finally {
    // Half-open R2 streams leak a connection — ensure it is closed.
    stream.destroy();
  }
  return Buffer.concat(chunks);
}

/**
 * 0050 (ghost-doc UX) — the caller OWNS/can-see this document but its upload
 * never finalised (tab closed mid-upload, transient error, or the 5-min
 * presign expired). Distinct, actionable code so the FE can tell the owner
 * "your upload didn't finish — re-upload" instead of a confusing generic 404.
 *
 * 409 Conflict (not 404): the resource genuinely exists and is visible to the
 * caller; it is in a state (un-finalised) that conflicts with serving it. This
 * code can ONLY be reached AFTER the per-record visibility check passes
 * (see loadVisible) — a foreign/unknown id STILL returns the generic 404, so
 * this never becomes an existence oracle for documents the caller can't see.
 */
const UPLOAD_INCOMPLETE = new ConflictException({
  error: { code: DOCUMENT_UPLOAD_INCOMPLETE_CODE },
});

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

  constructor(
    @Inject(STORAGE_PROVIDER) private readonly storage: IStorageProvider,
    @Inject(FILE_SCAN_PROVIDER) private readonly scanner: IFileScanProvider,
    private readonly notifications: NotificationsProducerService,
  ) {}

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
    /** 0049 — the DOWNLOAD path passes true so a never-finalised "ghost" doc
     *  is never served (its presigned URL would 404 on R2 = NoSuchKey).
     *  Default false: get/patch/archive/finalize must still operate on a
     *  not-yet-uploaded doc (you can manage/cancel a failed upload). */
    requireUploaded = false,
  ): Promise<DocumentRow> {
    const [row] = await tx.select().from(documents).where(eq(documents.id, id)).limit(1);
    if (!row || row.archivedAt) throw NOT_FOUND;
    // CRITICAL ORDERING (zero-leak): the per-record visibility check MUST run
    // BEFORE the un-finalised ("ghost") check. A foreign/unknown id throws the
    // generic NOT_FOUND here and NEVER reaches UPLOAD_INCOMPLETE — so the
    // distinct, more-informative code is only ever emitted for the caller's
    // OWN document and can't be used as an existence oracle for foreign rows.
    await this.assertDocVisibleForAgent(tx, user, row);
    // 0050 — only NOW that the doc is confirmed visible to the caller do we
    // surface the actionable "your upload didn't finish" code (the download/
    // preview path passes requireUploaded=true). A ghost's presigned URL would
    // 404 on R2 (NoSuchKey); the owner needs to know to re-upload.
    if (requireUploaded && !row.uploadedAt) throw UPLOAD_INCOMPLETE;
    // P0.B1 — FAIL-CLOSED malware gate. The serving (download) path requires a
    // `clean` AV verdict; anything else ('pending' / 'infected' / 'error') is
    // never servable. Ordered AFTER the visibility + uploaded checks so it is
    // only ever surfaced for the caller's OWN finalised document (no oracle).
    if (requireUploaded && row.scanStatus !== 'clean') throw SCAN_REJECTED;
    return row;
  }

  async create(user: AccessTokenPayload, input: CreateDocument): Promise<DocumentUploadResponse> {
    const r2Key = newDocumentKey(user.orgId);
    // #6 — recipients for the document_uploaded notification. Resolved INSIDE the
    // tx (an org-scoped read, satisfying the producer's "recipient ∈ org"
    // invariant) but EMITTED after commit. Declared here to survive the tx scope.
    // A notification must NEVER fail the upload, so resolution self-guards to [].
    let notifyRecipientIds: string[] = [];

    const row = await withTenant(
      user.orgId,
      async (tx) => {
        if (input.projectId) await this.assertProjectVisible(tx, user, input.projectId);
        if (input.apartmentId) await this.assertApartmentVisible(tx, user, input.apartmentId);
        // D.46 — agents may NOT create org-level (unparented) docs, mirroring
        // assertDocVisibleForAgent (org-level docs are manager/viewer-only);
        // then the fine capability gate (manager passes).
        if (user.role === 'agent' && !input.projectId && !input.apartmentId) throw NOT_FOUND;
        await requireAgentCapability(tx, user, 'manage_documents');
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
              // 7b-OTP (D-P5.7) — server-derived, TURN-ON ONLY: PII-bearing
              // types are sensitive regardless of the client flag; the client
              // may explicitly opt IN for any other type but can NEVER force
              // a sensitive-by-type doc off the gate (sensitive:false on an
              // id_document is IGNORED).
              sensitive: SENSITIVE_DOC_TYPES.has(input.type) || input.sensitive === true,
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

        // #6 / D-O7 — best-effort recipient resolution through the ONE central
        // helper (`resolveNotificationRecipients`). Result per the D-O7 default:
        // all ACTIVE org managers + the project's ACTIVE assigned agents, MINUS
        // the uploader (actor-excluded). This RETROFIT (was assigned-agents-only)
        // makes managers receive document_uploaded per D-O7 while keeping agents.
        // Resolve the project from the doc's projectId, or via apartment →
        // building for a per-apartment agreement. Wrapped so a resolver hiccup
        // never rolls back the upload.
        // NEXT EMIT TO SWITCH OVER: task_assigned — retrofit it onto this same
        // helper in a follow-up slice (do NOT hand-roll its recipients).
        try {
          let notifyProjectId = r.projectId;
          if (!notifyProjectId && r.apartmentId) {
            const [apt] = await tx
              .select({ projectId: buildings.projectId })
              .from(apartments)
              .innerJoin(buildings, eq(buildings.id, apartments.buildingId))
              .where(eq(apartments.id, r.apartmentId))
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
      // 503, not 400: this is an infra outage (object-storage unreachable),
      // not a client error. Correct status matters for monitoring/alerting
      // and lets the client safely retry. (Audit finding 2026-05-20.)
      throw new ServiceUnavailableException({ error: { code: 'storage_unavailable' } });
    }

    // #6 — fire-and-forget AFTER a successful presign (a doc that failed presign
    // was archived above + threw, so it never reaches here). emitMany self-guards:
    // a notification failure never throws and never affects this response. Body
    // carries only the document NAME (a same-org visible label), never PII.
    if (notifyRecipientIds.length > 0) {
      // try/catch at the CALL SITE too (not only the producer's internal self-
      // guard): the "a notification never fails the upload" contract must hold
      // here even if a future producer change throws synchronously. The doc is
      // already committed + presigned; a notify failure must not 500 the upload.
      try {
        await this.notifications.emitMany(notifyRecipientIds, {
          orgId: user.orgId,
          type: 'document_uploaded',
          title: 'מסמך חדש בפרויקט',
          body: `המסמך "${row.name}" הועלה.`,
          link: null,
          metadata: { documentId: row.id },
        });
      } catch (e) {
        this.logger.error(
          `document_uploaded notify failed (doc=${row.id}): ${e instanceof Error ? e.message : 'unknown'}`,
        );
      }
    }

    return {
      document: toDocument(row),
      uploadUrl,
      uploadExpiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    };
  }

  // Integrity gate (TWO-LAYER):
  //   1) CLIENT consistency — the finalize-declared size/hash must match
  //      what was declared at create. Catches a confused/inconsistent
  //      client.
  //   2) STORAGE attestation (D.28 R1/R2, audit-pass V #4) — when the
  //      provider can attest (R2 → real values; Fake → null), the
  //      object's ACTUAL content-length (and sha256 when available) must
  //      match the create-declared values. This is the true tamper-
  //      evident check: a client could lie identically at create+finalize
  //      while uploading different bytes; layer-2 catches that.
  //   On any mismatch ⇒ archive + purge the object + 409.
  //   `head()` returning null (Fake, or object briefly absent) is NOT a
  //   pass — it just means there is no storage-attested fact; the
  //   layer-1 client check stands alone. (Documented in
  //   storage.interface.ts StorageObjectMeta.)
  async finalize(user: AccessTokenPayload, id: string, input: FinalizeDocument): Promise<Document> {
    const result = await withTenant(
      user.orgId,
      async (tx) => {
        // requireUploaded=false: finalize loads the not-yet-uploaded doc in
        // order to confirm + stamp uploaded_at below.
        const row = await this.loadVisible(tx, user, id, false);
        await requireAgentCapability(tx, user, 'manage_documents');
        // Layer 1: client-consistency. Size is checked FIRST so the thrown
        // error can name the offending field (Slice 5c — actionable
        // mismatch). A truncated re-upload surfaces 'size'; a tampered one
        // surfaces 'hash', so the FE can tell the owner exactly what to fix.
        let mismatchField: 'size' | 'hash' | null =
          input.sizeBytes !== row.sizeBytes
            ? 'size'
            : input.contentHash !== row.contentHash
              ? 'hash'
              : null;
        // Layer 2: storage-attestation (only when layer-1 already passed —
        // an inconsistent client is already a reject, no need to probe R2).
        // head() is best-effort: an infra failure here MUST NOT silently
        // weaken the gate, but it also MUST NOT block a legitimate
        // finalize on a transient R2 hiccup. We log + treat as "no
        // attestation" (layer-1 stands). Fake → null → no-op.
        if (mismatchField === null) {
          try {
            const head = await this.storage.head(row.r2Key);
            if (head !== null) {
              const sizeOk = head.contentLength === row.sizeBytes;
              const hashOk =
                head.checksumSha256 === undefined || head.checksumSha256 === row.contentHash;
              if (!sizeOk) mismatchField = 'size';
              else if (!hashOk) mismatchField = 'hash';
            }
          } catch (e: unknown) {
            this.logger.error(
              `storage.head() failed during finalize (doc=${row.id}): ${
                e instanceof Error ? e.message : 'unknown'
              }`,
            );
          }
        }
        if (mismatchField !== null) {
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
          return { row, mismatch: true as const, mismatchField };
        }
        const [updated] = await tx
          .update(documents)
          // 0049 — mark the upload confirmed. P0.B1 — scan_status stays
          // 'pending' here: the upload is confirmed but NOT yet servable. The
          // anti-malware scan runs AFTER commit (it reads the object bytes);
          // the download gate requires uploaded_at AND scan_status='clean', so
          // the doc is FAIL-CLOSED (un-servable) in this 'pending' window.
          .set({ updatedAt: new Date(), uploadedAt: new Date() })
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
        return { row: updated ?? row, mismatch: false as const, mismatchField: null };
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
      // Slice 5c — keep the top-level code (DOC8 + DD1 contracts assert it)
      // but ADD details naming the offending field so the FE can render an
      // actionable message ("size" → גודל / "hash" → תוכן).
      throw new ConflictException({
        error: {
          code: 'document_integrity_mismatch',
          details: { field: result.mismatchField ?? 'hash' },
        },
      });
    }

    // P0.B1 — anti-malware scan gate. The integrity-confirmed object is scanned
    // BEFORE it can ever be downloaded (the download path serves only
    // scan_status='clean'). FAIL-CLOSED: a 'clean' verdict flips the row to
    // servable; ANYTHING else (infected / scan error / unexpected) archives +
    // purges the object and rejects, so a malicious or unscannable file is
    // never retrievable. Mirrors the integrity-reject compensation above.
    return this.scanGate(user, result.row);
  }

  /**
   * P0.B1 — run the injected IFileScanProvider against the finalised object and
   * persist the verdict. Returns the now-`clean` document, or throws
   * SCAN_REJECTED (after archive + purge) for any non-clean outcome.
   *
   * SECURITY: fail-closed at every branch — a thrown scanner, an exceeded
   * byte ceiling, or an 'error' verdict all archive + reject. The file bytes
   * are NEVER logged; only the doc id + verdict + (content-free) signature
   * label are recorded.
   */
  private async scanGate(user: AccessTokenPayload, row: DocumentRow): Promise<Document> {
    let verdict: 'clean' | 'infected' | 'error' = 'error';
    let signature: string | undefined;
    try {
      const result = await this.scanner.scan({
        key: row.r2Key,
        // Lazy: a provider that fetches out-of-band (R2-event scanner) never
        // triggers this read; the ClamAV provider pulls the bytes here.
        bytes: () => readObjectBytes(this.storage, row.r2Key, DOCUMENT_MAX_SIZE_BYTES),
      });
      verdict = result.verdict;
      signature = result.signature;
    } catch (e) {
      // Any unexpected throw ⇒ treat as scan error (fail-closed). The interface
      // contract is "never throw", but defend against a misbehaving provider.
      this.logger.error(
        `file scan threw (doc=${row.id}): ${e instanceof Error ? e.message : 'unknown'}`,
      );
      verdict = 'error';
      signature = 'scan_threw';
    }

    if (verdict === 'clean') {
      const updated = await withTenant(
        user.orgId,
        async (tx) => {
          const [r] = await tx
            .update(documents)
            .set({ scanStatus: 'clean', scanSignature: null, updatedAt: new Date() })
            .where(eq(documents.id, row.id))
            .returning();
          await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: 'document.scan_clean',
            targetTable: 'documents',
            targetId: row.id,
            sessionId: user.sid,
          });
          return r ?? row;
        },
        { userId: user.sub },
      );
      return toDocument(updated);
    }

    // NON-CLEAN (infected | error) — archive the row, record the verdict, purge
    // the object, and reject. The file is now unreachable (fail-closed).
    const purgeKey = await withTenant(
      user.orgId,
      async (tx) => {
        await tx
          .update(documents)
          .set({
            scanStatus: verdict,
            scanSignature: signature ?? null,
            archivedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(documents.id, row.id));
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'document.scan_reject',
          targetTable: 'documents',
          targetId: row.id,
          // verdict + signature label only — never file content/PII.
          metadata: { verdict, signature: signature ?? null },
          sessionId: user.sid,
        });
        return row.r2Key;
      },
      { userId: user.sub },
    );
    await this.storage.delete(purgeKey).catch((e: unknown) => {
      this.logger.error(
        `purge after scan reject failed (doc=${row.id}): ${e instanceof Error ? e.message : 'unknown'}`,
      );
    });
    throw SCAN_REJECTED;
  }

  async get(user: AccessTokenPayload, id: string): Promise<Document> {
    const row = await withTenant(user.orgId, async (tx) => this.loadVisible(tx, user, id), {
      userId: user.sub,
    });
    return toDocument(row);
  }

  async getDownloadUrl(
    user: AccessTokenPayload,
    id: string,
    disposition: 'attachment' | 'inline' = 'attachment',
  ): Promise<DocumentDownloadResponse> {
    const { r2Key, name } = await withTenant(
      user.orgId,
      async (tx) => {
        // 0049 — require finalised: a ghost's presigned URL would 404 (NoSuchKey).
        const row = await this.loadVisible(tx, user, id, true);
        // 7b-OTP (D-P5.5/7/8) — the SENSITIVE-document gate. Ordered AFTER the
        // visibility + ghost + scan checks in loadVisible (never an existence
        // oracle) and BEFORE the download audit + presign. A sensitive doc is
        // served ONLY when the CALLER'S CURRENT session (user.sid) holds a
        // VALID unlock: pii_unlocked_at NOT NULL and younger than the org's
        // security.piiUnlockTtlMinutes (default 60). NON-sensitive docs skip
        // this block entirely — behavior byte-for-byte unchanged (D-P5.7).
        if (row.sensitive) {
          const { security } = await getOrgSettings(tx, user.orgId);
          const ttlMs = security.piiUnlockTtlMinutes * 60_000;
          // auth_sessions is auth-infra (no RLS; app_user has SELECT). An
          // unknown/ghost sid simply finds no row → locked (fail-closed).
          const [sess] = await tx
            .select({ piiUnlockedAt: authSessions.piiUnlockedAt })
            .from(authSessions)
            .where(eq(authSessions.id, user.sid))
            .limit(1);
          const unlockedAt = sess?.piiUnlockedAt ?? null;
          if (!unlockedAt || unlockedAt.getTime() + ttlMs <= Date.now()) {
            throw PII_STEP_UP_REQUIRED;
          }
        }
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
    // A3 audit-fix (2026-05-20): presign failure is an infra outage, not a
    // client error. Without try/catch the raw provider error leaks as a
    // generic 500 while the download audit row is already committed (an
    // append-only inconsistency). Map to 503 — same governed pattern as
    // create's presign failure.
    let url: string;
    try {
      url = await this.storage.getDownloadUrl(r2Key, {
        ttlSeconds: DOWNLOAD_URL_TTL_SECONDS,
        // Audit H-2 fix — both slots: ASCII fallback for legacy
        // clients (RFC 6266) + UTF-8 percent-encoded for Hebrew names
        // (RFC 5987). Modern clients prefer the latter and show the
        // original Hebrew filename to the user; legacy clients get
        // the safe ASCII slug.
        responseFilename: safeDownloadFilename(name),
        responseFilenameUtf8: name,
        // S2 #1 — inline view (PDF preview in a tab) vs the default
        // attachment (save dialog). The AV-scan gate above (loadVisible +
        // scan_status='clean') is UNCHANGED and applies to both: only a
        // clean, allow-listed object ever reaches this presign.
        disposition,
      });
    } catch (e) {
      this.logger.error(
        `presign(download) failed (doc=${id}): ${e instanceof Error ? e.message : 'unknown'}`,
      );
      throw new ServiceUnavailableException({ error: { code: 'storage_unavailable' } });
    }
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
        // active assignment (directly OR via apartment→building→project).
        //
        // D.28 R5 (audit-pass V #2 — 2026-05-20): refactored from
        // app-side IN-list materialisation to two correlated EXISTS
        // subqueries. The prior approach loaded EVERY apartment id under
        // EVERY assigned project into memory and emitted `IN (...)`
        // clauses with thousands of UUIDs — unbounded for large orgs and
        // wasteful for small ones. EXISTS pushes the filtering to SQL
        // where it is bounded by the indexes on (project_assignments,
        // buildings.project_id, apartments.building_id) — constant
        // memory, scales with org size, no IN-list overhead. Semantics
        // are identical: `OR(direct-project-match, via-apartment-chain)`.
        if (user.role === 'agent') {
          const directProjectAssigned = sql<boolean>`EXISTS (
            SELECT 1 FROM project_assignments pa
            WHERE pa.user_id = ${user.sub}::uuid
              AND pa.unassigned_at IS NULL
              AND pa.project_id = ${documents.projectId}
          )`;
          const viaApartment = sql<boolean>`EXISTS (
            SELECT 1 FROM apartments a
            JOIN buildings b ON b.id = a.building_id
            JOIN project_assignments pa ON pa.project_id = b.project_id
            WHERE pa.user_id = ${user.sub}::uuid
              AND pa.unassigned_at IS NULL
              AND a.id = ${documents.apartmentId}
          )`;
          filters.push(or(directProjectAssigned, viaApartment));
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
    return withTenant(
      user.orgId,
      async (tx) => {
        const before = await this.loadVisible(tx, user, id);
        await requireAgentCapability(tx, user, 'manage_documents');
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
    const key = await withTenant(
      user.orgId,
      async (tx) => {
        const [before] = await tx.select().from(documents).where(eq(documents.id, id)).limit(1);
        if (!before) throw NOT_FOUND;
        // D.46 — by-id path: agent doc visibility (404 if not in assigned
        // project) then the capability gate (manager passes both).
        await this.assertDocVisibleForAgent(tx, user, before);
        await requireAgentCapability(tx, user, 'manage_documents');
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
