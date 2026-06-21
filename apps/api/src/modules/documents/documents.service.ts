import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  AuditService,
  apartments,
  authSessions,
  buildings,
  documents,
  env,
  projectAssignments,
  projects,
  withTenant,
  type Document as DocumentRow,
  type IFileScanProvider,
  type IStorageProvider,
  type TenantTx,
} from '@emapp/db';
import {
  CLASSIFY_SAMPLE_MAX_BYTES,
  DOCUMENT_MAX_SIZE_BYTES,
  DOCUMENT_SCAN_REJECTED_CODE,
  DOCUMENT_TYPE_MISMATCH_CODE,
  DOCUMENT_UPLOAD_INCOMPLETE_CODE,
  REMEDIATION_SAMPLE_MAX,
  type ClassifyDocument,
  type ClassifyResult,
  type CreateDocument,
  type DedupCandidate,
  type DedupCheckResponse,
  type Document,
  type DocumentDownloadResponse,
  type DocumentUploadResponse,
  type FinalizeDocument,
  type RemediationItem,
  type RemediationSweepInputDto,
  type RemediationSweepResult,
  type UpdateDocument,
} from '@emapp/shared-types';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, eq, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';

import { requireAgentCapability } from '../../common/authz/agent-capabilities';
import {
  decodeCursor,
  encodeCursor,
  keysetCondition,
  keysetOrderBy,
} from '../../common/keyset-cursor';
import { getOrgSettings } from '../../common/org-settings.resolver';
import type { AccessTokenPayload } from '../auth/auth.service';
import { notificationLink } from '../notifications/notification-links';
import { resolveNotificationRecipients } from '../notifications/notification-recipients';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';

import { classifyDocument, remediationLandRegistryMatch } from './document-classifier';
import { verifyMagicBytes } from './magic-bytes';
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
 * DH4 — hard cap on dedup link candidates returned. A genuine duplicate is one
 * row; this only bounds a pathological hash collision / spam so the probe can't
 * be turned into a large enumeration. Newest-first means the most recent
 * identical doc is always the primary suggestion within the cap.
 */
const DEDUP_CANDIDATE_LIMIT = 20;

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
 * SECURITY-UPLOAD-AUDIT.md threat #3 — the uploaded object's REAL leading
 * bytes do not match its declared `mimeType` (type spoofing, or an accident
 * like a `.docx` declared as `application/pdf`). FAIL-CLOSED, same posture as
 * SCAN_REJECTED: the object is archived + purged and never servable. 409 (the
 * object exists but is in a state that conflicts with serving it); only ever
 * reachable AFTER the per-record visibility check (see loadVisible), so it is
 * never an existence oracle. The file bytes are NEVER logged.
 */
const TYPE_MISMATCH = new ConflictException({
  error: { code: DOCUMENT_TYPE_MISMATCH_CODE },
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
const SENSITIVE_DOC_TYPES: ReadonlySet<string> = new Set([
  'id_document',
  'financial',
  // נסח טאבו — a land-registry extract lists EVERY owner's national_id, so it
  // is PII-dense by definition and must derive sensitive=true (turn-ON only):
  // encrypted at rest, OTP step-up on download, and STRUCTURALLY EXCLUDED from
  // the non-sensitive contractor share tier (contractor-read.service.ts).
  'land_registry',
]);

// ── 7d (D-P5.4 second half) — app-envelope encryption for SENSITIVE bytes ───
// At-rest layout (self-describing — no migration needed for the format):
//   'EMAPPENC'(8B ascii) | version(1B=0x01) | keyId(2B) | iv(12B) |
//   tag(16B) | ciphertext (AES-256-GCM ⇒ same length as plaintext).
// Key = base64-decode(env.DOC_ENCRYPTION_KEY) — Infisical-delivered, never in
// R2, NEVER logged. NO AAD (pinned by doc-encryption-7d.spec.ts G1 — a future
// AAD addition must update that spec first). iv is random PER OBJECT.
const ENVELOPE_MAGIC = Buffer.from('EMAPPENC', 'ascii');
const ENVELOPE_VERSION = 0x01;
/** Key-slot id for future rotation. 0x0001 = the current DOC_ENCRYPTION_KEY. */
const ENVELOPE_KEY_ID = Buffer.from([0x00, 0x01]);
const ENVELOPE_IV_LEN = 12;
const ENVELOPE_TAG_LEN = 16;
/** magic(8) + version(1) + keyId(2) + iv(12) + tag(16) */
const ENVELOPE_HEADER_LEN = ENVELOPE_MAGIC.length + 1 + 2 + ENVELOPE_IV_LEN + ENVELOPE_TAG_LEN;

/**
 * 7d — the content-path integrity gate failed: the RAW bytes the client
 * POSTed do not match the size/hash it declared at create. 400 (a client
 * error — resend the right bytes), DISTINCT from finalize's 409 because the
 * row is left intact for a retry (nothing was stored, nothing archived).
 * `details.field` names the offending check ('size' | 'hash') so the FE can
 * render an actionable message — same shape as the finalize mismatch.
 */
function integrityMismatch(field: 'size' | 'hash'): BadRequestException {
  return new BadRequestException({
    error: { code: 'document_integrity_mismatch', details: { field } },
  });
}

/** base64-decode the doc-envelope key, fail-closed on misconfig. The error
 *  carries NO key material — only the remedy. */
function docEncryptionKey(): Buffer {
  const b64 = env.DOC_ENCRYPTION_KEY;
  const key = b64 ? Buffer.from(b64, 'base64') : Buffer.alloc(0);
  if (key.length !== 32) {
    // 503 (ops misconfig — not a client error). Never logs/echoes the value.
    throw new ServiceUnavailableException({ error: { code: 'doc_encryption_unavailable' } });
  }
  return key;
}

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

/**
 * DH4 — the columns a dedup candidate is shaped from (the SELECT projection in
 * dedupCheck). PII-free + r2Key-free by construction: only the doc id, type,
 * the DH1 canonical scope/scopeId, the filename (name) and createdAt.
 */
export interface DedupCandidateRow {
  documentId: string;
  type: string;
  scope: DedupCandidate['scope'];
  scopeId: string | null;
  filename: string;
  createdAt: Date;
}

/**
 * DH4 — pure row→candidate mapper. Kept tiny + exported so the shaping is unit-
 * testable without a DB (the SQL `ORDER BY createdAt DESC` does the ranking;
 * this only projects the fields onto the wire shape). r2Key is structurally
 * absent here (it is never selected), so it can never leak.
 */
export function toDedupCandidate(r: DedupCandidateRow): DedupCandidate {
  return {
    documentId: r.documentId,
    type: r.type,
    scope: r.scope,
    scopeId: r.scopeId,
    filename: r.filename,
    createdAt: r.createdAt,
  };
}

/**
 * DH4 — pure response builder. `hasDuplicate` is derived strictly from the
 * candidate count (no separate flag to drift). Exported for unit testing.
 */
export function buildDedupResponse(rows: DedupCandidateRow[]): DedupCheckResponse {
  const duplicates = rows.map(toDedupCandidate);
  return { duplicates, hasDuplicate: duplicates.length > 0 };
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
    // 7b-OTP (D-P5.7) — server-derived, TURN-ON ONLY: PII-bearing types are
    // sensitive regardless of the client flag; the client may explicitly opt
    // IN for any other type but can NEVER force a sensitive-by-type doc off
    // the gate (sensitive:false on an id_document is IGNORED).
    // 7d — this derivation now ALSO selects the upload channel (see below).
    const sensitive = SENSITIVE_DOC_TYPES.has(input.type) || input.sensitive === true;
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
              // 7b-OTP (D-P5.7) — derived above (turn-ON only).
              sensitive,
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
    //
    // 7d — SENSITIVE docs get NO presigned PUT, ever (not even minted-and-
    // discarded): their bytes must flow through POST /documents/:id/content
    // so the server verifies + scans the PLAINTEXT and stores only the
    // app-envelope ciphertext. Plain docs keep the presign byte-identically.
    let uploadUrl: string | null = null;
    if (!sensitive)
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
          link: notificationLink.document(row.id),
          metadata: { documentId: row.id },
        });
      } catch (e) {
        this.logger.error(
          `document_uploaded notify failed (doc=${row.id}): ${e instanceof Error ? e.message : 'unknown'}`,
        );
      }
    }

    // 7d — sensitive create answers with the API content path INSTEAD of a
    // presigned PUT (uploadUrl: null). The relative API path is enough for
    // the FE's same-origin apiClient; it carries no secret (the route is
    // auth-guarded), unlike a presigned URL.
    if (sensitive) {
      return {
        document: toDocument(row),
        uploadUrl: null,
        uploadExpiresInSeconds: null,
        contentUploadPath: `/api/v1/documents/${row.id}/content`,
      };
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
    // SECURITY-UPLOAD-AUDIT.md threat #3 — magic-byte (real-content-type)
    // verification before the AV scan. A MEMOIZED loader reads the object
    // bytes AT MOST ONCE and serves them to BOTH the type check below AND the
    // scanner's lazy `bytes()` callback — zero extra I/O versus the prior
    // inline-scan read (a provider that fetches out-of-band, e.g. an R2-event
    // scanner, never triggers the read at all).
    let cachedBytes: Buffer | null = null;
    const loadBytes = async (): Promise<Buffer> => {
      if (cachedBytes === null) {
        cachedBytes = await readObjectBytes(this.storage, row.r2Key, DOCUMENT_MAX_SIZE_BYTES);
      }
      return cachedBytes;
    };

    // Type-spoof gate (defense-in-depth; NOT the boundary). A declared MIME
    // whose real bytes don't match is rejected with the SAME fail-closed
    // archive+purge posture as an infected file — never stored/served.
    //
    // BEST-EFFORT on the READ itself: if the object can't be read here, we do
    // NOT manufacture a type-mismatch (no bytes ⇒ no spoof evidence) — we let
    // the scanner own its own fail-closed read posture. This is a layer, not
    // the boundary; a read failure must not change the existing scan outcome.
    try {
      const bytes = await loadBytes();
      if (!verifyMagicBytes(bytes, row.mimeType).ok) {
        await this.recordScanReject(user, row, 'error', 'type_mismatch');
        await this.storage.delete(row.r2Key).catch((e: unknown) => {
          this.logger.error(
            `purge after type-mismatch failed (doc=${row.id}): ${
              e instanceof Error ? e.message : 'unknown'
            }`,
          );
        });
        throw TYPE_MISMATCH;
      }
    } catch (e) {
      // Re-throw OUR rejection; swallow only a read failure (logged, then the
      // scanner runs and applies its own fail-closed verdict on the same read).
      if (e === TYPE_MISMATCH) throw e;
      this.logger.error(
        `magic-byte read skipped (doc=${row.id}): ${e instanceof Error ? e.message : 'unknown'}`,
      );
    }

    let verdict: 'clean' | 'infected' | 'error' = 'error';
    let signature: string | undefined;
    try {
      const result = await this.scanner.scan({
        key: row.r2Key,
        // Reuse the memoized buffer (read above for the type check) — the
        // ClamAV provider consumes it without a second R2 round-trip; a lazy
        // out-of-band provider that never calls this triggers no read.
        bytes: loadBytes,
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
    await this.recordScanReject(user, row, verdict, signature);
    await this.storage.delete(row.r2Key).catch((e: unknown) => {
      this.logger.error(
        `purge after scan reject failed (doc=${row.id}): ${e instanceof Error ? e.message : 'unknown'}`,
      );
    });
    throw SCAN_REJECTED;
  }

  /**
   * Shared fail-closed posture for a non-clean scan verdict (P0.B1 / 7d):
   * archive the row, persist the verdict + content-free signature label, and
   * audit `document.scan_reject` (ids + verdict only — never file content).
   * The caller decides whether a storage purge is also needed (finalize path:
   * yes, the object was already PUT; 7d content path: no — the plaintext was
   * never stored, so there is nothing at rest to purge).
   */
  private async recordScanReject(
    user: AccessTokenPayload,
    row: DocumentRow,
    verdict: 'infected' | 'error',
    signature: string | undefined,
  ): Promise<void> {
    await withTenant(
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
      },
      { userId: user.sub },
    );
  }

  async get(user: AccessTokenPayload, id: string): Promise<Document> {
    const row = await withTenant(user.orgId, async (tx) => this.loadVisible(tx, user, id), {
      userId: user.sub,
    });
    return toDocument(row);
  }

  /**
   * DH3 (MASTER-PLAN-V13 Wave B) — heuristic document-type CLASSIFIER.
   * SUGGEST-ONLY: returns a RANKED list of suggested `doc_type` values for a
   * to-be-uploaded file from its cheap signals (filename, declared mimeType,
   * and an OPTIONAL leading-bytes sample). This method:
   *   - does NO DB read/write (no withTenant — it touches no customer data; the
   *     org context only authorizes the caller via the controller guard),
   *   - NEVER mutates a document's type (the human confirms separately — the
   *     same "mandatory human confirm" doctrine as D.18 / the tabu auto-parse).
   *
   * SECURITY: `filename`/`sampleBase64` are external input. The sample is
   * base64-decoded and HARD-CAPPED to CLASSIFY_SAMPLE_MAX_BYTES (leading bytes
   * are all the heuristics need); the raw bytes are NEVER logged or echoed (the
   * suggestion `reason` keys are content-free constants). A malformed base64
   * sample is treated as "no sample" — the classifier still runs on the
   * filename + mime signals (advisory; never throws on a bad optional sample).
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- async to keep
  // the controller call-site uniform (await) and allow a future content-fetch
  // variant without a signature change; the body is intentionally pure today.
  async classify(_user: AccessTokenPayload, input: ClassifyDocument): Promise<ClassifyResult> {
    let sample: Buffer | undefined;
    if (input.sampleBase64) {
      try {
        // Decode and immediately cap to the leading-bytes ceiling. base64 from
        // a trusted-shape (Zod-bounded length) string; a bad-encoding result is
        // simply shorter/garbage and harmless to the substring/magic checks.
        const decoded = Buffer.from(input.sampleBase64, 'base64');
        sample = decoded.subarray(0, CLASSIFY_SAMPLE_MAX_BYTES);
      } catch {
        // Defensive — Buffer.from(base64) does not throw, but never let a
        // sample-decode hiccup fail an advisory suggestion.
        sample = undefined;
      }
    }
    return classifyDocument({ filename: input.filename, mimeType: input.mimeType, sample });
  }

  /**
   * FL-5 (MASTER-PLAN-V13 Wave A) — נסח/tabu BACKFILL REMEDIATION SWEEP. Closes
   * the #450 HIGH follow-up: pre-existing documents whose CONTENT is נסח/tabu
   * (land_registry) but were uploaded BEFORE the DH3 classifier existed were
   * never typed `land_registry` and — the security hole — never derived
   * `sensitive = true`, so a PII-dense tabu doc (every owner's national_id) was
   * stored WITHOUT the step-up gate. This sweep re-runs the SAME DH3 classifier
   * over each doc's STORED metadata (filename + declared mime — NO content
   * fetch, no PII read) and re-types the unambiguous tabu docs to
   * `land_registry`, deriving `sensitive = true` (TURN-ON ONLY, exactly like
   * create/PATCH — sensitivity is NEVER weakened by the sweep).
   *
   * ORG-SCOPED, NO new auth path: it runs inside the caller's own `withTenant`
   * (RLS tenant_isolation) — it NEVER reaches another org's documents. The
   * controller gates it on `documents.update` + the same `manage_documents`
   * agent fine-gate as PATCH (re-typing IS a document update).
   *
   * DRY-RUN BY DEFAULT (`input.dryRun` defaults true at the Zod boundary): the
   * default invocation REPORTS the proposed transitions and COMMITS NOTHING —
   * the SELECT runs but no UPDATE is issued. A commit happens ONLY when the
   * caller passes `dryRun: false`.
   *
   * IDEMPOTENT: the candidate filter excludes docs already typed
   * `land_registry`, so a doc the sweep already fixed is never re-selected;
   * applying twice is a no-op. Archived docs are skipped (a fixed-population
   * sweep over live docs).
   */
  async remediationSweep(
    user: AccessTokenPayload,
    input: RemediationSweepInputDto,
  ): Promise<RemediationSweepResult> {
    return withTenant(
      user.orgId,
      async (tx) => {
        // The same fine agent-gate PATCH uses — re-typing a doc IS an update.
        // (Manager passes; a loosened agent cell can never fall open.)
        await requireAgentCapability(tx, user, 'manage_documents');

        // CANDIDATE FILTER (idempotency + scope): non-archived docs in the org
        // that are NOT ALREADY land_registry. An already-correctly-classified
        // tabu doc (type='land_registry') is structurally EXCLUDED here, so a
        // re-run never re-touches it. We project metadata ONLY (id, name, type,
        // mimeType, sensitive) — no r2Key, no content. Agent record-scoping
        // applies (the sweep never widens what an agent can see/touch).
        const rows = await tx
          .select({
            id: documents.id,
            name: documents.name,
            type: documents.type,
            mimeType: documents.mimeType,
            sensitive: documents.sensitive,
          })
          .from(documents)
          .where(
            and(
              isNull(documents.archivedAt),
              sql`${documents.type} <> 'land_registry'`,
              this.agentDocScope(user),
            ),
          )
          .orderBy(...keysetOrderBy(documents.createdAt, documents.id))
          .limit(input.limit);

        // Classify each from STORED metadata; keep only the unambiguous
        // land_registry (tabu/נסח) matches above the confidence floor.
        const items: RemediationItem[] = [];
        for (const row of rows) {
          const match = remediationLandRegistryMatch({
            filename: row.name,
            mimeType: row.mimeType,
          });
          if (!match) continue;
          items.push({
            documentId: row.id,
            fromType: row.type,
            toType: 'land_registry',
            wasSensitive: row.sensitive,
            // TURN-ON ONLY: land_registry is sensitive-by-type → always true.
            // The sweep never sets this false (sensitivity is never weakened).
            willBeSensitive: true,
            confidence: match.confidence,
            reason: match.reason,
          });
        }

        // APPLY only when explicitly asked (dryRun=false). The default path is
        // strictly side-effect-free: the SELECT above ran, but NO UPDATE and NO
        // audit row is written — a true dry run.
        if (!input.dryRun && items.length > 0) {
          for (const item of items) {
            // Idempotent UPDATE: the WHERE re-asserts the pre-state
            // (type <> 'land_registry') so a concurrent second sweep that
            // already fixed this row updates 0 rows (no double-apply). We set
            // type='land_registry' and sensitive=true (turn-ON only — we never
            // pass sensitive=false here). archived_at unchanged.
            await tx
              .update(documents)
              .set({ type: 'land_registry', sensitive: true, updatedAt: new Date() })
              .where(
                and(
                  eq(documents.id, item.documentId),
                  sql`${documents.type} <> 'land_registry'`,
                ),
              );
            await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
              orgId: user.orgId,
              actorId: user.sub,
              actorType: 'user',
              action: 'document.remediation_reclassify',
              targetTable: 'documents',
              targetId: item.documentId,
              // METADATA ONLY — the type/sensitive transition + the content-free
              // classifier reason key. NEVER the filename or any content/PII.
              beforeState: { type: item.fromType, sensitive: item.wasSensitive },
              afterState: { type: 'land_registry', sensitive: true },
              metadata: { reason: item.reason, confidence: item.confidence },
              sessionId: user.sid,
            });
          }
        }

        return {
          // TRUE only when this was a real commit AND there was something to
          // commit — a dry-run, or an apply that found zero candidates, both
          // wrote nothing, so `applied` reflects "changes were written".
          applied: !input.dryRun && items.length > 0,
          scanned: rows.length,
          candidates: items.length,
          // Bounded sample — ids + transitions only (no PII), capped so the
          // report stays small even for a large remediation population.
          sample: items.slice(0, REMEDIATION_SAMPLE_MAX),
        };
      },
      { userId: user.sub },
    );
  }

  async getDownloadUrl(
    user: AccessTokenPayload,
    id: string,
    disposition: 'attachment' | 'inline' = 'attachment',
  ): Promise<DocumentDownloadResponse> {
    const { r2Key, name, mimeType } = await withTenant(
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
        if (row.sensitive) await this.assertPiiUnlocked(tx, user);
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'document.download',
          targetTable: 'documents',
          targetId: row.id,
          sessionId: user.sid,
        });
        return { r2Key: row.r2Key, name: row.name, mimeType: row.mimeType };
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
        // SECURITY-UPLOAD-AUDIT.md (secondary) — pin the R2 response
        // content-type to the declared (allow-listed) MIME. The object is
        // served from a separate R2 origin our helmet `nosniff` can't reach;
        // forcing the content-type narrows browser MIME-sniffing of a spoofed
        // object, defense-in-depth alongside the magic-byte gate.
        responseContentType: mimeType,
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

  /**
   * 7b-OTP (D-P5.5/7/8) — the SENSITIVE-document gate, shared by the presign
   * download path and the 7d decrypt-stream path. A sensitive doc is served
   * ONLY when the CALLER'S CURRENT session (user.sid) holds a VALID unlock:
   * pii_unlocked_at NOT NULL and younger than the org's
   * security.piiUnlockTtlMinutes (default 60). MUST be called only AFTER the
   * per-record visibility checks (never an existence oracle).
   */
  private async assertPiiUnlocked(tx: TenantTx, user: AccessTokenPayload): Promise<void> {
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

  /**
   * 7d (D-P5.4 second half) — SENSITIVE content upload through the API.
   * POST /documents/:id/content (raw bytes). Flow, in order:
   *   1. visibility + capability (same no-oracle posture as everywhere);
   *   2. SENSITIVE-only (plain docs keep the presign path → 400) and not
   *      already uploaded (409);
   *   3. integrity attestation on the PLAINTEXT — size first, then sha256
   *      against the create-declared values (mismatch → 400
   *      document_integrity_mismatch + details.field; NOTHING stored, row
   *      left intact for a corrected retry). Stronger than finalize's
   *      layer-2: the server hashed the actual bytes itself.
   *   4. scan the PLAINTEXT (P0.B1 preserved — never the ciphertext);
   *      non-clean → the same fail-closed archive+reject posture as the
   *      presign path (no purge needed: nothing was ever stored);
   *   5. encrypt AES-256-GCM into the EMAPPENC envelope (random iv per
   *      object; key from env, never logged) → storage.putObject;
   *   6. stamp uploaded_at + scan_status='clean' + bytes_encrypted=true
   *      and audit (ids only).
   */
  async uploadContent(
    user: AccessTokenPayload,
    id: string,
    body: Buffer,
  ): Promise<{ uploaded: true }> {
    const check = await withTenant(
      user.orgId,
      async (tx) => {
        const row = await this.loadVisible(tx, user, id, false);
        await requireAgentCapability(tx, user, 'manage_documents');
        if (!row.sensitive) {
          // The content route is SENSITIVE-ONLY; a plain doc's only upload
          // path is the presigned PUT it received at create.
          throw new BadRequestException({ error: { code: 'document_not_sensitive' } });
        }
        if (row.uploadedAt) {
          // Already finalised — content is immutable post-upload.
          throw new ConflictException({ error: { code: 'document_already_uploaded' } });
        }
        // Integrity: size FIRST (cheap + names the actionable field), then
        // the server-computed sha256 of the actual raw bytes.
        const mismatchField: 'size' | 'hash' | null =
          body.length !== row.sizeBytes
            ? 'size'
            : createHash('sha256').update(body).digest('hex') !== row.contentHash
              ? 'hash'
              : null;
        if (mismatchField !== null) {
          await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: 'document.integrity_reject',
            targetTable: 'documents',
            targetId: row.id,
            sessionId: user.sid,
          });
        }
        return { row, mismatchField };
      },
      { userId: user.sub },
    );
    // Thrown OUTSIDE the tx so the integrity_reject audit row commits.
    if (check.mismatchField !== null) throw integrityMismatch(check.mismatchField);
    const { row } = check;

    // SECURITY-UPLOAD-AUDIT.md threat #3 — magic-byte (real-content-type)
    // verification on the PLAINTEXT before the scan and before anything is
    // stored. The server already holds `body` (zero extra I/O). A declared
    // MIME whose real bytes don't match is rejected fail-closed with the same
    // archive posture as a non-clean scan; NO purge — nothing was ever stored.
    if (!verifyMagicBytes(body, row.mimeType).ok) {
      await this.recordScanReject(user, row, 'error', 'type_mismatch');
      throw TYPE_MISMATCH;
    }

    // P0.B1 — scan the PLAINTEXT before anything is stored. Fail-closed at
    // every branch, mirroring scanGate (a thrown scanner = 'error').
    let verdict: 'clean' | 'infected' | 'error' = 'error';
    let signature: string | undefined;
    try {
      const result = await this.scanner.scan({
        key: row.r2Key,
        bytes: async () => body,
      });
      verdict = result.verdict;
      signature = result.signature;
    } catch (e) {
      this.logger.error(
        `file scan threw (doc=${row.id}): ${e instanceof Error ? e.message : 'unknown'}`,
      );
      verdict = 'error';
      signature = 'scan_threw';
    }
    if (verdict !== 'clean') {
      // Same archive+reject posture as the presign path; NO purge — the
      // plaintext was never stored, nothing exists at rest.
      await this.recordScanReject(user, row, verdict, signature);
      throw SCAN_REJECTED;
    }

    // Encrypt → store. Only the opaque envelope ever reaches storage.
    const envelope = this.encryptEnvelope(body);
    try {
      await this.storage.putObject(row.r2Key, envelope, {
        contentType: 'application/octet-stream',
      });
    } catch (e) {
      this.logger.error(
        `putObject failed (doc=${row.id}): ${e instanceof Error ? e.message : 'unknown'}`,
      );
      // Infra outage — same governed 503 as the presign failures. The row
      // stays un-uploaded (still retryable); nothing was persisted.
      throw new ServiceUnavailableException({ error: { code: 'storage_unavailable' } });
    }

    await withTenant(
      user.orgId,
      async (tx) => {
        await tx
          .update(documents)
          .set({
            uploadedAt: new Date(),
            scanStatus: 'clean',
            scanSignature: null,
            bytesEncrypted: true,
            updatedAt: new Date(),
          })
          .where(eq(documents.id, row.id));
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'document.content_upload',
          targetTable: 'documents',
          targetId: row.id,
          sessionId: user.sid,
        });
      },
      { userId: user.sub },
    );
    return { uploaded: true };
  }

  /** Build the at-rest envelope: EMAPPENC|v1|keyId|iv|tag|ciphertext.
   *  iv is RANDOM PER OBJECT (GCM requirement — an iv reuse under the same
   *  key would be catastrophic); NO AAD (pinned, see constants above). */
  private encryptEnvelope(plain: Buffer): Buffer {
    const iv = randomBytes(ENVELOPE_IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', docEncryptionKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([
      ENVELOPE_MAGIC,
      Buffer.from([ENVELOPE_VERSION]),
      ENVELOPE_KEY_ID,
      iv,
      tag,
      ciphertext,
    ]);
  }

  /** Parse + decrypt the at-rest envelope. Any malformed/garbled object is a
   *  500 with a stable code and NO detail (corruption or key mismatch — an
   *  ops incident, never a client-actionable state; bytes never logged). */
  private decryptEnvelope(envelope: Buffer, docId: string): Buffer {
    const fail = (): never => {
      this.logger.error(`envelope decrypt failed (doc=${docId})`);
      throw new InternalServerErrorException({ error: { code: 'document_decrypt_failed' } });
    };
    if (
      envelope.length < ENVELOPE_HEADER_LEN ||
      !envelope.subarray(0, ENVELOPE_MAGIC.length).equals(ENVELOPE_MAGIC) ||
      envelope[ENVELOPE_MAGIC.length] !== ENVELOPE_VERSION
    ) {
      return fail();
    }
    const ivStart = ENVELOPE_MAGIC.length + 1 + 2; // magic | version | keyId
    const iv = envelope.subarray(ivStart, ivStart + ENVELOPE_IV_LEN);
    const tag = envelope.subarray(ivStart + ENVELOPE_IV_LEN, ENVELOPE_HEADER_LEN);
    const ciphertext = envelope.subarray(ENVELOPE_HEADER_LEN);
    // Key fetch OUTSIDE the try: a key MISCONFIG must surface as the ops 503
    // (doc_encryption_unavailable), not be swallowed into the generic 500
    // corruption code (review LOW-1).
    const key = docEncryptionKey();
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      return fail();
    }
  }

  /**
   * 7d — sensitive download: the API decrypt-streams the bytes itself (a
   * presigned URL would hand the client ciphertext). For bytes_encrypted
   * docs ONLY. Runs the EXACT same gate chain as getDownloadUrl: visibility
   * → ghost → scan (loadVisible requireUploaded=true) → PII step-up unlock
   * (403 pii_step_up_required without a valid session unlock) → audit.
   */
  async getDecryptedStream(
    user: AccessTokenPayload,
    id: string,
    disposition: 'attachment' | 'inline' = 'attachment',
  ): Promise<{
    stream: Readable;
    mimeType: string;
    name: string;
    sizeBytes: number;
    disposition: 'attachment' | 'inline';
  }> {
    const row = await withTenant(
      user.orgId,
      async (tx) => {
        const r = await this.loadVisible(tx, user, id, true);
        // The OTP unlock gate stays exactly where it is in the presign path:
        // after visibility/ghost/scan, before the audit + serve.
        if (r.sensitive) await this.assertPiiUnlocked(tx, user);
        if (!r.bytesEncrypted) {
          // Decrypt-stream is only for app-envelope objects; a plain object
          // here means the caller routed wrongly (resolveDownload prevents
          // this) — refuse rather than stream raw storage bytes.
          throw new ConflictException({ error: { code: 'document_conflict' } });
        }
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'document.download',
          targetTable: 'documents',
          targetId: r.id,
          sessionId: user.sid,
        });
        return r;
      },
      { userId: user.sub },
    );
    let envelope: Buffer;
    try {
      envelope = await readObjectBytes(
        this.storage,
        row.r2Key,
        DOCUMENT_MAX_SIZE_BYTES + ENVELOPE_HEADER_LEN,
      );
    } catch (e) {
      this.logger.error(
        `envelope read failed (doc=${row.id}): ${e instanceof Error ? e.message : 'unknown'}`,
      );
      throw new ServiceUnavailableException({ error: { code: 'storage_unavailable' } });
    }
    const plaintext = this.decryptEnvelope(envelope, row.id);
    return {
      stream: Readable.from(plaintext),
      mimeType: row.mimeType,
      name: row.name,
      sizeBytes: plaintext.length,
      disposition,
    };
  }

  /**
   * 7d — download dispatch for the controller: bytes_encrypted docs are
   * decrypt-streamed by the API; everything else keeps the byte-identical
   * presign path. The peek is NOT an oracle: an unknown/foreign id reads as
   * "not encrypted" and falls through to getDownloadUrl, which performs the
   * full visibility chain and throws the same generic 404 as before.
   */
  async resolveDownload(
    user: AccessTokenPayload,
    id: string,
    disposition: 'attachment' | 'inline' = 'attachment',
  ): Promise<
    | { kind: 'presign'; data: DocumentDownloadResponse }
    | {
        kind: 'stream';
        stream: Readable;
        mimeType: string;
        name: string;
        sizeBytes: number;
        disposition: 'attachment' | 'inline';
      }
  > {
    const encrypted = await withTenant(
      user.orgId,
      async (tx) => {
        const [r] = await tx
          .select({ bytesEncrypted: documents.bytesEncrypted })
          .from(documents)
          .where(eq(documents.id, id))
          .limit(1);
        return r?.bytesEncrypted ?? false;
      },
      { userId: user.sub },
    );
    if (!encrypted) {
      return { kind: 'presign', data: await this.getDownloadUrl(user, id, disposition) };
    }
    return { kind: 'stream', ...(await this.getDecryptedStream(user, id, disposition)) };
  }

  /**
   * Agent record-scoping predicate for the documents tables, shared by `list`
   * and `searchDocuments`. Restricts to docs whose parent project is an ACTIVE
   * assignment — directly (project_id) OR via apartment→building→project. Two
   * correlated EXISTS (D.28 R5): constant memory, index-bounded, no IN-list.
   * Returns `undefined` for non-agents (managers/viewers are RLS-org-bound). An
   * org-level doc (no project, no apartment) matches NEITHER EXISTS, so it is
   * invisible to agents — the same least-priv rule as assertDocVisibleForAgent.
   */
  private agentDocScope(user: AccessTokenPayload): SQL | undefined {
    if (user.role !== 'agent') return undefined;
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
    return or(directProjectAssigned, viaApartment);
  }

  /**
   * DH4 (MASTER-PLAN-V13 Wave B) — document DEDUP probe ("link to existing, not
   * duplicate"). The client hashes the file it is about to upload (the SAME
   * sha256 hex `content_hash` everywhere else) and asks whether the caller's
   * scope ALREADY holds an identical, non-archived document, so the FE can
   * offer "קשר לקיים" instead of creating a duplicate.
   *
   * SUGGEST/READ-ONLY: a metadata-only SELECT — it creates NO link and mutates
   * NOTHING (the actual link action is a separate, human-confirmed slice).
   *
   * ZERO-LEAK (the security crux — a content-hash probe must NOT become a
   * cross-tenant existence oracle):
   *   - withTenant → RLS tenant_isolation (org_id) FORCE: only the caller's
   *     org rows are ever visible. A hash that exists ONLY in another org
   *     returns the SAME empty result as a never-seen hash.
   *   - the SAME agentDocScope record-scoping as list/search: an agent sees a
   *     candidate only for a doc whose parent project is an ACTIVE assignment;
   *     org-level docs are invisible to agents. So the probe never widens what
   *     the caller can already see.
   *   - archived docs are excluded (a duplicate of a deleted doc is not a live
   *     link candidate).
   *   - METADATA only (no r2Key, no presigned URL, no PII) — same posture as
   *     toDocument. The contentHash is NEVER logged.
   * Index-served by idx_documents_content_hash (no new migration). Newest-first
   * so the most recent identical doc is the primary suggestion; a small hard cap
   * bounds the response (a pathological hash-collision/spam can't return a huge
   * list).
   */
  async dedupCheck(
    user: AccessTokenPayload,
    input: { contentHash: string },
  ): Promise<DedupCheckResponse> {
    const rows = await withTenant(
      user.orgId,
      async (tx) => {
        const filters: (SQL | undefined)[] = [
          eq(documents.contentHash, input.contentHash),
          isNull(documents.archivedAt),
          // SAME agent record-scoping as list/search — never widens visibility.
          this.agentDocScope(user),
        ];
        return tx
          .select({
            documentId: documents.id,
            type: documents.type,
            scope: documents.docScope,
            scopeId: documents.docScopeId,
            filename: documents.name,
            createdAt: documents.createdAt,
          })
          .from(documents)
          .where(and(...filters))
          .orderBy(sql`${documents.createdAt} DESC`, sql`${documents.id} DESC`)
          .limit(DEDUP_CANDIDATE_LIMIT);
      },
      { userId: user.sub },
    );

    // Pure shaping (exported + unit-tested): r2Key is structurally absent (never
    // selected); hasDuplicate is derived from the count (no drift).
    return buildDedupResponse(rows);
  }

  /**
   * NS1 (server-side search, MASTER-PLAN-V13 Wave B) — document NAME substring
   * search + type/scope filters, keyset-paginated. This is `list` with a
   * required `q` (name ILIKE, trigram-index served) plus the optional `type`
   * (exact) and `scope` (parent linkage) filters.
   *
   * VISIBILITY IS UNCHANGED (never widened): the SAME archived-exclusion (unless
   * `archived:true`), the SAME agent record-scoping (agentDocScope) and the SAME
   * org RLS apply. The download-time gates (uploaded/scan-clean/sensitive
   * step-up) are unaffected — search returns METADATA only (toDocument never
   * carries r2Key), so a row appearing here grants no extra content access. `q`
   * is bound as a PARAMETER with LIKE metacharacters escaped (no injection,
   * literal substring). The `scope` filter is pure SQL on project_id/
   * apartment_id NULL-ness — it can only NARROW the result, never widen it.
   */
  async searchDocuments(
    user: AccessTokenPayload,
    query: {
      q: string;
      limit: number;
      cursor?: string;
      type?: string;
      scope?: 'project' | 'apartment' | 'org';
      archived?: boolean;
    },
  ): Promise<DocumentListPage> {
    const { limit } = query;
    const cur = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cur) {
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }
    const escaped = query.q.replace(/[\\%_]/g, (c) => `\\${c}`);
    const pattern = `%${escaped}%`;

    const rows = await withTenant(
      user.orgId,
      async (tx) => {
        const filters: (SQL | undefined)[] = [
          query.archived ? isNotNull(documents.archivedAt) : isNull(documents.archivedAt),
          sql`${documents.name} ILIKE ${pattern}`,
        ];
        if (query.type) filters.push(eq(documents.type, query.type));
        // `scope` NARROWS by parent linkage (never widens — it only adds an AND).
        if (query.scope === 'project') filters.push(isNotNull(documents.projectId));
        else if (query.scope === 'apartment') filters.push(isNotNull(documents.apartmentId));
        else if (query.scope === 'org')
          filters.push(and(isNull(documents.projectId), isNull(documents.apartmentId)));

        // SAME agent record-scoping as list (org-level docs invisible to agents).
        filters.push(this.agentDocScope(user));

        const keyset: SQL | undefined = cur
          ? keysetCondition(documents.createdAt, documents.id, cur)
          : undefined;

        return tx
          .select()
          .from(documents)
          .where(and(...filters, keyset))
          .orderBy(...keysetOrderBy(documents.createdAt, documents.id))
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

  async list(
    user: AccessTokenPayload,
    query: {
      limit: number;
      cursor?: string;
      projectId?: string;
      apartmentId?: string;
      archived?: boolean;
    },
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

        // Default view = ACTIVE docs; `archived: true` returns the archived ones
        // (otherwise soft-archived docs are unreachable from the cockpit).
        const filters: (SQL | undefined)[] = [
          query.archived ? isNotNull(documents.archivedAt) : isNull(documents.archivedAt),
        ];
        if (query.projectId) filters.push(eq(documents.projectId, query.projectId));
        if (query.apartmentId) filters.push(eq(documents.apartmentId, query.apartmentId));

        // Agent record-scoping: restrict to docs whose parent project is an
        // active assignment (directly OR via apartment→building→project). The
        // two-EXISTS predicate (D.28 R5: constant memory, index-bounded, no
        // IN-list) is the shared `agentDocScope` helper, reused by
        // searchDocuments so the two surfaces can never drift.
        filters.push(this.agentDocScope(user));

        const keyset: SQL | undefined = cur
          ? keysetCondition(documents.createdAt, documents.id, cur)
          : undefined;

        return tx
          .select()
          .from(documents)
          .where(and(...filters, keyset))
          .orderBy(...keysetOrderBy(documents.createdAt, documents.id))
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
        if (input.type !== undefined) {
          patch.type = input.type;
          // D-P5.7 turn-ON-only: retyping TO a sensitive type re-derives
          // sensitive=true (else upload-as-other → PATCH-to-id_document would
          // bypass the step-up gate). Never turns sensitive OFF.
          if (SENSITIVE_DOC_TYPES.has(input.type)) patch.sensitive = true;
        }
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
