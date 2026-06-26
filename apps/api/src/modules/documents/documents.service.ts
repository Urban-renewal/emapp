import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  AuditService,
  apartments,
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
  DOCUMENT_PARTIES,
  DOCUMENT_SCAN_REJECTED_CODE,
  DOCUMENT_TYPE_MISMATCH_CODE,
  DOCUMENT_UPLOAD_INCOMPLETE_CODE,
  PROJECTS_BEHIND_CAP,
  PROJECT_TERMINAL_STATUSES,
  REMEDIATION_SAMPLE_MAX,
  REQUIRED_DOC_TYPES_BY_TRACK,
  SENSITIVE_DOC_TYPES,
  docTypesForParty,
  providerPartyForDocType,
  trackForProjectType,
  type BoardCompleteness,
  type ClassifyDocument,
  type ClassifyResult,
  type CreateDocument,
  type DedupCandidate,
  type DedupCheckResponse,
  type Document,
  type DocumentDownloadResponse,
  type DocumentParty,
  type DocumentType,
  type DocumentUploadResponse,
  type FinalizeDocument,
  type PartyCompleteness,
  type RemediationItem,
  type RemediationSweepInputDto,
  type RemediationSweepResult,
  type UpdateDocument,
} from '@emapp/shared-types';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';

import { requireAgentCapability } from '../../common/authz/agent-capabilities';
import {
  PermissionResolutionCache,
  PermissionService,
} from '../../common/authz/permission.service';
import { assertSessionPiiUnlocked, PII_STEP_UP_REQUIRED } from '../../common/authz/pii-step-up';
import {
  decodeCursor,
  encodeCursor,
  keysetCondition,
  keysetOrderBy,
} from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';
import { notificationLink } from '../notifications/notification-links';
import { resolveNotificationRecipients } from '../notifications/notification-recipients';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';

import { DocEncryptionConfigError, DocKeyRegistry } from './doc-encryption-registry';
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

// PII-bearing document types — sensitive-by-type at create (D-P5.7). The set is
// the SINGLE source of truth in `@emapp/shared-types` (re-imported above) so the
// FE upload dropzone and this create-time derivation can NEVER drift to two
// different lists. Membership means: derive sensitive=true (turn-ON only),
// encrypted at rest, OTP step-up on download, and STRUCTURALLY EXCLUDED from the
// non-sensitive contractor share tier (contractor-read.service.ts).

// ── 7d (D-P5.4 second half) — app-envelope encryption for SENSITIVE bytes ───
// At-rest layout (self-describing — no migration needed for the format):
//   'EMAPPENC'(8B ascii) | version(1B=0x01) | keyId(2B) | iv(12B) |
//   tag(16B) | ciphertext (AES-256-GCM ⇒ same length as plaintext).
// Key = base64-decode(env.DOC_ENCRYPTION_KEY) — Infisical-delivered, never in
// R2, NEVER logged. NO AAD (pinned by doc-encryption-7d.spec.ts G1 — a future
// AAD addition must update that spec first). iv is random PER OBJECT.
const ENVELOPE_MAGIC = Buffer.from('EMAPPENC', 'ascii');
const ENVELOPE_VERSION = 0x01;
/** keyId is a uint16 BE in the header (2 bytes). FL-3: it now selects a key from
 *  the DOC_ENCRYPTION_KEY registry (see doc-encryption-registry.ts). keyId 1 is
 *  the reserved LEGACY default — what every pre-FL-3 envelope was stamped with
 *  and what a single bare key still resolves to (byte-for-byte back-compat). */
const ENVELOPE_KEY_ID_LEN = 2;
const ENVELOPE_IV_LEN = 12;
const ENVELOPE_TAG_LEN = 16;
/** magic(8) + version(1) + keyId(2) + iv(12) + tag(16) */
const ENVELOPE_HEADER_LEN =
  ENVELOPE_MAGIC.length + 1 + ENVELOPE_KEY_ID_LEN + ENVELOPE_IV_LEN + ENVELOPE_TAG_LEN;

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

/**
 * B7 (DOCUMENT-SECURITY-AUDIT.md) — normalise a storage-attested sha256
 * checksum to lowercase hex for comparison against the app's hex
 * `content_hash`.
 *
 * R2/S3 attest the object checksum via `x-amz-checksum-sha256` as base64 of
 * the RAW 32-byte digest. The rest of the app stores `content_hash` as the
 * 64-char hex digest. This converts the base64 attestation to hex.
 *
 * FAIL-CLOSED: returns `null` for ANY input that is not a real sha256
 * attestation —
 *   • `undefined` (the provider attested NO checksum even though it returned
 *     an object): the finalize gate treats `null` as a mismatch, NOT a pass.
 *     Because the presigned PUT now binds a checksum, a real object that
 *     carries none was written outside our bound PUT (tamper) ⇒ reject.
 *   • a value that doesn't base64-decode to exactly 32 bytes (garbage / a
 *     truncated header) ⇒ reject.
 * The caller already accepts a HEX value too (R2 returns base64, but a
 * defensive 64-char hex input is passed through), so both encodings the
 * provider could plausibly emit normalise correctly.
 */
function decodeStorageChecksumToHex(attested: string | undefined): string | null {
  if (typeof attested !== 'string' || attested.length === 0) return null;
  // Already hex (64 lowercase/uppercase hex chars) — pass through normalised.
  if (/^[0-9a-fA-F]{64}$/.test(attested)) return attested.toLowerCase();
  // Otherwise expect base64 of the raw 32-byte digest.
  let buf: Buffer;
  try {
    buf = Buffer.from(attested, 'base64');
  } catch {
    return null;
  }
  // Reject anything that isn't exactly a 32-byte sha256 digest. (Buffer.from
  // is lenient on non-base64 input, so the length check is the real gate.)
  if (buf.length !== 32) return null;
  // Round-trip guard: re-encoding must reproduce the input (modulo padding),
  // otherwise the input wasn't a clean base64 digest.
  if (buf.toString('base64').replace(/=+$/, '') !== attested.replace(/=+$/, '')) return null;
  return buf.toString('hex');
}

/** Memoized registry, keyed on the raw env value so a SIGHUP `reloadEnv()` key
 *  rotation (or a test that mutates `process.env.DOC_ENCRYPTION_KEY` +
 *  `reloadEnv()`) transparently rebuilds it on next access — WITHOUT re-parsing
 *  on every encrypt/decrypt. Holds only the parsed registry, never the raw bytes
 *  beyond the cache key (which is already in `env`). */
let docKeyRegistryCache: { rawKey: string | undefined; registry: DocKeyRegistry } | undefined;

/** Build (or reuse the memoized) keyId→key registry from env, fail-closed on
 *  misconfig. A DocEncryptionConfigError (missing / malformed config, or an
 *  unknown keyId at decrypt time) maps to the existing ops-facing 503. The error
 *  carries NO key material — only the ops remedy. */
function docKeyRegistry(): DocKeyRegistry {
  const rawKey = env.DOC_ENCRYPTION_KEY;
  if (docKeyRegistryCache && docKeyRegistryCache.rawKey === rawKey) {
    return docKeyRegistryCache.registry;
  }
  try {
    const registry = DocKeyRegistry.fromEnv(rawKey);
    docKeyRegistryCache = { rawKey, registry };
    return registry;
  } catch (e) {
    // Do NOT cache a failure — a corrected env on the next reloadEnv must retry.
    if (e instanceof DocEncryptionConfigError) {
      // 503 (ops misconfig — not a client error). Never logs/echoes the value.
      throw new ServiceUnavailableException({ error: { code: 'doc_encryption_unavailable' } });
    }
    throw e;
  }
}

/**
 * FL-3 boot-time fail-closed assertion. Call once at API bootstrap so a
 * malformed DOC_ENCRYPTION_KEY (e.g. a bad rotation registry) crashes the
 * process at DEPLOY rather than surfacing as a 503 on the first document
 * download. Returns void; throws the raw DocEncryptionConfigError (NO key
 * material — only the structural reason) so the boot log is actionable.
 * Idempotent and side-effect-free beyond warming the memo.
 */
export function assertDocEncryptionConfig(): void {
  // Builds + memoizes; rethrows the structural reason as-is for the boot log.
  DocKeyRegistry.fromEnv(env.DOC_ENCRYPTION_KEY);
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

/**
 * The RESOLVED parent labels a doc-read mapper may carry (Phase 1). NON-PII:
 * a project NAME and an apartment NUMBER are org-internal labels, never owner
 * PII (national_id/phone/owner name). LEFT-joined (nullable) — an org-level doc
 * has no parent; a producer that does not join passes neither.
 */
interface ResolvedParentNames {
  projectName?: string | null;
  apartmentName?: string | null;
}

/** Map a row → wire shape. r2Key is DELIBERATELY omitted (never on the
 * wire — confidentiality: the storage pointer must not leak).
 *
 * Phase 1: `sensitive` + `scanStatus` are projected straight from the row
 * (non-PII processing flags). `parents` carries the OPTIONAL LEFT-joined parent
 * labels (project name / apartment number) — present only on the get/list/search
 * mappers that join; create/finalize/update omit them (the field is absent, NOT
 * a falsy "no parent"). `scanStatus` is parsed tolerantly on the wire, but the
 * row value is one of the four BE-written states. */
function toDocument(r: DocumentRow, parents: ResolvedParentNames = {}): Document {
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
    // Phase 1 — non-PII processing flags straight off the row.
    sensitive: r.sensitive,
    scanStatus: r.scanStatus as Document['scanStatus'],
    // Phase 1 — resolved parent labels (only when the mapper joined them).
    ...(parents.projectName !== undefined ? { projectName: parents.projectName } : {}),
    ...(parents.apartmentName !== undefined ? { apartmentName: parents.apartmentName } : {}),
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

  // B5 (red-team blocker) — engine-backed permission resolution for the
  // sensitive-doc gate's defence-in-depth reveal-PII re-assertion. The engine is
  // dependency-free (it takes the request tx + a per-call cache), so we own one
  // instance here exactly like AuthorizationGuard does — no DI/constructor churn
  // (the test harness constructs this service with three positional providers).
  private readonly permissions = new PermissionService();

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

    // PARENT EXCLUSIVITY (defense-in-depth — the CreateDocumentInput refine is the
    // single source, this guards any internal caller that bypasses the DTO). A doc
    // hangs off AT MOST one parent; both-parent makes it reachable from two
    // projects (project_id AND the apartment's building's project) and breaks the
    // home-KPI ↔ per-project-board reconciliation (single-source invariant).
    if (input.projectId && input.apartmentId) {
      throw new BadRequestException({
        error: { code: 'document_parent_exclusive' },
      });
    }
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
          // B7 (DOCUMENT-SECURITY-AUDIT.md) — anti-overwrite hardening of the
          // presigned PUT. The key is server-random and used for exactly ONE
          // upload, so:
          //   • createOnly: storage rejects a PUT to an already-stored key
          //     (412) — closes scan-then-swap TOCTOU (a leaked/re-used URL
          //     can't overwrite the scanned object).
          //   • contentSha256Hex: bind the PUT to the create-declared hash so
          //     storage rejects (BadDigest) any other bytes — the stored
          //     object's checksum becomes STORAGE-attested for finalize.
          createOnly: true,
          contentSha256Hex: input.contentHash,
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

  /**
   * B7 re-finalize idempotency rule (shared by the fast-path guard and the
   * atomic-UPDATE race-loser). The doc is ALREADY finalised (`uploaded_at`
   * set). Compare the incoming declared {sizeBytes, contentHash} to the STORED
   * values:
   *   • MATCH  → idempotent no-op. Return the already-finalised doc so the
   *     caller resolves to HTTP 200. NOTHING is re-stamped, NO bytes move, and
   *     NO integrity/scan/purge runs — it's a pure retry (a client whose first
   *     finalize response was lost to a network blip). Safe because the
   *     create-only + checksum-bound presigned PUT already makes a
   *     post-finalize byte swap impossible, so a same-value re-call cannot
   *     launder anything.
   *   • DIFFER → 409 `document_already_uploaded`. This is the actual
   *     laundering/conflict attempt the B7 guard blocks: a second finalize
   *     trying to re-declare different size/hash over an immutable doc.
   */
  private reFinalizeIdempotency(
    row: DocumentRow,
    input: FinalizeDocument,
  ): { row: DocumentRow; mismatch: false; mismatchField: null; idempotent: true } {
    const sameValues = input.sizeBytes === row.sizeBytes && input.contentHash === row.contentHash;
    if (!sameValues) {
      throw new ConflictException({ error: { code: 'document_already_uploaded' } });
    }
    return { row, mismatch: false, mismatchField: null, idempotent: true };
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
        // B7 (DOCUMENT-SECURITY-AUDIT.md) — FINALIZE-ONCE guard, IDEMPOTENT-FOR-
        // SAME / REJECT-FOR-DIFFERENT. A doc with `uploaded_at` already set is
        // finalised + immutable; mirrors the sensitive content-upload path's
        // `document_already_uploaded` guard.
        //
        // Retry-safety (idempotency contract — documents-deep.contract DD4): a
        // client whose first finalize response was lost to a network blip MUST
        // be able to retry with the SAME declared {sizeBytes, contentHash} and
        // get the already-finalised doc back (HTTP 200) — a pure no-op that
        // re-stamps nothing and moves no bytes.
        //
        // B7 laundering-protection: a re-finalize with DIFFERENT declared values
        // is the actual conflict the guard blocks — it gets 409. Because the
        // presign is create-only + binds x-amz-checksum-sha256, a post-finalize
        // byte swap is already impossible; so returning 200 on an IDENTICAL
        // re-call cannot launder anything (no bytes change, nothing re-stamps).
        // Only a CONFLICTING (different-value) re-finalize is rejected.
        if (row.uploadedAt) {
          return this.reFinalizeIdempotency(row, input);
        }
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
        //
        // B7 — FAIL-CLOSED integrity. Because the presigned PUT now BINDS
        // x-amz-checksum-sha256 + is create-only, by the time we reach here the
        // stored bytes PROVABLY hash to content_hash (upload-time enforcement).
        // Layer-2 RE-VERIFIES that fact at finalize so a byte-swap written
        // outside our bound PUT can never be laundered into a finalised doc.
        //
        // HIGH-1 (round-2 red-team): R2 is S3-COMPATIBLE, not S3 — it may NOT
        // echo `x-amz-checksum-sha256` on HEAD for a presigned-PUT-supplied
        // checksum. Treating an absent HEAD-checksum as a REJECT would false-
        // reject EVERY legitimate upload on such a deployment (safe direction,
        // but a launch blocker). FIX (Option A — R2-independent re-verify):
        //   • head() attests a checksum  → verify it (defense-in-depth, no I/O).
        //   • head() present but NO checksum → FALL BACK to streaming the
        //     object bytes and recomputing sha256 SERVER-SIDE, then compare to
        //     content_hash. This re-verifies integrity WITHOUT depending on R2
        //     echoing the checksum. Match → accept; mismatch → reject + purge.
        //   • head() === null (provider can't attest, e.g. the in-memory Fake)
        //     → no storage-attested fact; layer-1 legitimately stands alone.
        // Every branch stays FAIL-CLOSED: a mismatch (attested OR recomputed)
        // rejects; only a positively-verified match (or "no attestation at
        // all") proceeds.
        if (mismatchField === null) {
          try {
            const head = await this.storage.head(row.r2Key);
            if (head !== null) {
              const sizeOk = head.contentLength === row.sizeBytes;
              // R2 attests the checksum as base64 of the raw digest; the app
              // stores content_hash as hex. Normalise the attestation to hex
              // before comparing. A non-base64 value normalises to null and
              // triggers the byte-recompute fallback below (fail-closed).
              const attestedHashHex = decodeStorageChecksumToHex(head.checksumSha256);
              let hashOk: boolean;
              if (attestedHashHex !== null) {
                // Storage attested a checksum — verify it directly (no extra I/O).
                hashOk = attestedHashHex === row.contentHash.toLowerCase();
              } else {
                // HIGH-1 — no HEAD checksum (R2 omitted it). Re-verify by
                // streaming the bytes and recomputing sha256 ourselves. Bounded
                // by DOCUMENT_MAX_SIZE_BYTES (the presign already capped the
                // PUT). Only reached on the absent-checksum path.
                const bytes = await readObjectBytes(
                  this.storage,
                  row.r2Key,
                  DOCUMENT_MAX_SIZE_BYTES,
                );
                const recomputedHex = createHash('sha256').update(bytes).digest('hex');
                hashOk = recomputedHex === row.contentHash.toLowerCase();
              }
              if (!sizeOk) mismatchField = 'size';
              else if (!hashOk) mismatchField = 'hash';
            }
          } catch (e: unknown) {
            // A storage failure here (head() OR the recompute read) MUST NOT
            // silently weaken the gate, but also MUST NOT block a legitimate
            // finalize on a transient R2 hiccup. We log + treat as "no
            // storage-attested fact" — layer-1 (client-consistency) stands
            // alone, exactly as for head()===null. (The create-only +
            // checksum-bound PUT already guarantees the stored bytes match;
            // this re-verify is defense-in-depth, not the sole boundary.)
            this.logger.error(
              `storage integrity re-verify failed during finalize (doc=${row.id}): ${
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
          return { row, mismatch: true as const, mismatchField, idempotent: false as const };
        }
        // B7 — finalize-once is now ATOMIC, not check-then-act. The early
        // `if (row.uploadedAt)` above is only a cheap fast-path; under READ
        // COMMITTED (withTenant's default isolation) two concurrent finalizes
        // could BOTH read uploaded_at=null and BOTH pass that guard, then both
        // stamp — a TOCTOU that lets a second finalize re-launder a post-finalize
        // byte swap. The guarantee lives in the WHERE: only the row that is
        // still `uploaded_at IS NULL` is updated; the loser's UPDATE matches 0
        // rows and we reject 409. (Mirrors the sensitive content path's guard.)
        const [updated] = await tx
          .update(documents)
          // 0049 — mark the upload confirmed. P0.B1 — scan_status stays
          // 'pending' here: the upload is confirmed but NOT yet servable. The
          // anti-malware scan runs AFTER commit (it reads the object bytes);
          // the download gate requires uploaded_at AND scan_status='clean', so
          // the doc is FAIL-CLOSED (un-servable) in this 'pending' window.
          .set({ updatedAt: new Date(), uploadedAt: new Date() })
          .where(and(eq(documents.id, row.id), isNull(documents.uploadedAt)))
          .returning();
        if (!updated) {
          // The conditional UPDATE matched 0 rows ⇒ another concurrent finalize
          // won the race between our read and this update and already stamped
          // uploaded_at. RE-LOAD the now-finalised row and apply the SAME
          // idempotency rule as the fast-path: a same-value retry is a 200
          // no-op, a different-value (laundering) re-call is a 409. This makes
          // the race-LOSER idempotent-safe too — not a blanket 409 that would
          // break a legitimate client whose first response was lost mid-race.
          const current = await this.loadVisible(tx, user, id, false);
          return this.reFinalizeIdempotency(current, input);
        }
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'document.finalize',
          targetTable: 'documents',
          targetId: row.id,
          sessionId: user.sid,
        });
        return {
          row: updated,
          mismatch: false as const,
          mismatchField: null,
          idempotent: false as const,
        };
      },
      { userId: user.sub },
    );

    // Idempotent same-value re-finalize (fast-path or race-loser): the doc was
    // ALREADY finalised with these exact declared values. Return it verbatim —
    // a pure no-op. Do NOT re-run integrity/scan/purge: no bytes changed and
    // nothing re-stamps, and the create-only + checksum-bound PUT already makes
    // a post-finalize byte swap impossible, so re-verifying would be redundant
    // I/O with no security benefit. (Only a DIFFERENT-value re-call — the real
    // laundering attempt — reaches reFinalizeIdempotency's 409 throw instead.)
    if (result.idempotent) {
      return toDocument(result.row);
    }

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
    return withTenant(
      user.orgId,
      async (tx) => {
        const row = await this.loadVisible(tx, user, id);
        // Phase 1 — resolve the parent LABELS (project name / apartment number)
        // so the detail card can show + link the parent instead of a bare uuid.
        // ONE small read each, inside the SAME tenant tx (RLS-scoped). NON-PII.
        const [names] = await this.resolveParentNames(tx, [row]);
        return toDocument(row, names ?? {});
      },
      { userId: user.sub },
    );
  }

  /**
   * Phase 1 — batch-resolve the parent LABELS (project NAME / apartment NUMBER)
   * for a page of document rows, returning ONE {@link ResolvedParentNames} per
   * input row IN ORDER. Two index-bounded IN-list reads (projects, apartments)
   * over the DISTINCT parent ids on the page — NOT an N+1 per row. Runs inside
   * the caller's tenant tx, so RLS org-isolation applies: a parent the caller
   * cannot see resolves to `null` (never another org's label). NON-PII: a
   * project name and an apartment number are org-internal labels, never owner
   * national_id/phone/name.
   *
   * `projectName` resolves from the doc's `projectId` (the legacy column the
   * board + visibility checks already use). `apartmentName` resolves from
   * `apartmentId` → the apartment `number`. A doc with neither parent (org-level)
   * gets `{ projectName: null, apartmentName: null }`.
   */
  private async resolveParentNames(
    tx: TenantTx,
    rows: Pick<DocumentRow, 'projectId' | 'apartmentId'>[],
  ): Promise<ResolvedParentNames[]> {
    const projectIds = [...new Set(rows.map((r) => r.projectId).filter((v): v is string => !!v))];
    const apartmentIds = [
      ...new Set(rows.map((r) => r.apartmentId).filter((v): v is string => !!v)),
    ];

    const projectNameById = new Map<string, string>();
    if (projectIds.length > 0) {
      const pr = await tx
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(inArray(projects.id, projectIds));
      for (const p of pr) projectNameById.set(p.id, p.name);
    }

    const apartmentNameById = new Map<string, string>();
    if (apartmentIds.length > 0) {
      const ar = await tx
        .select({ id: apartments.id, number: apartments.number })
        .from(apartments)
        .where(inArray(apartments.id, apartmentIds));
      for (const a of ar) apartmentNameById.set(a.id, a.number);
    }

    return rows.map((r) => ({
      // null (not undefined) when the doc HAS a parent we resolved no name for
      // (RLS-hidden / deleted) OR when there is no such parent — the wire field
      // is then explicitly null. A doc with no projectId at all also yields null
      // here, which the mapper still emits (present-but-null), distinguishing
      // "resolved, none" from "producer didn't join" (field absent).
      projectName: r.projectId ? (projectNameById.get(r.projectId) ?? null) : null,
      apartmentName: r.apartmentId ? (apartmentNameById.get(r.apartmentId) ?? null) : null,
    }));
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
                and(eq(documents.id, item.documentId), sql`${documents.type} <> 'land_registry'`),
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
   * 7b-OTP (D-P5.5/7/8) — the SENSITIVE-document step-up ACCESS gate, shared by
   * the presign download path and the 7d decrypt-stream path. Delegates to the
   * SHARED `assertSessionPiiUnlocked` (the single source of truth for the
   * freshness/TTL check), so this path and the tabu review path can never
   * silently drift apart. MUST be called only AFTER the per-record visibility
   * checks (never an existence oracle).
   *
   * CLEARTEXT CONTRACT (why the document path DIFFERS from tabu review): a
   * sensitive-document download serves a WHOLE FILE — all-or-nothing cleartext,
   * with NO per-field mask. So if a stricter cleartext entitlement is ever
   * layered on top of the access gate (e.g. `owners.reveal_pii`), it belongs
   * HERE at this call site, NOT inside the shared helper — because the tabu
   * path deliberately allows masked-role review through the same access gate
   * and masks `national_id` per-field via `resolveOwnerPiiFidelity` instead.
   */
  private async assertPiiUnlocked(tx: TenantTx, user: AccessTokenPayload): Promise<void> {
    // B5 (red-team blocker, 2026-06-22) — DEFENCE IN DEPTH. The step-up
    // unlock IS the cleartext-PII gate (a sensitive doc is national_id-dense),
    // so honoring an unlock requires the caller to ACTUALLY hold the
    // reveal-PII capability NOW — re-resolved from the live engine, not trusted
    // from the token. The controller already gates the unlock endpoints on
    // `owners.reveal_pii`, but this re-assertion closes the residual window: a
    // pre-existing / forged `pii_unlocked_at` (e.g. stamped before a role lost
    // the permission, or planted) can NEVER be leveraged by a role that does
    // not currently hold reveal-PII. A Viewer (documents.read+download but NOT
    // owners.reveal_pii) is rejected here even with a valid unlock row.
    const cache = new PermissionResolutionCache();
    const effective = await this.permissions.effectivePermissions(
      { id: user.sub, orgId: user.orgId },
      { type: 'org', id: user.orgId },
      tx,
      cache,
    );
    if (!effective.has('owners.reveal_pii')) {
      throw PII_STEP_UP_REQUIRED;
    }

    // Access gate (session pii_unlock freshness/TTL) via the shared helper
    // (B5b/#497) — the SAME fail-closed check the tabu path uses; the
    // `owners.reveal_pii` entitlement above is the documents-specific layer
    // (whole-file cleartext), per this method's doc-comment.
    await assertSessionPiiUnlocked(tx, user);
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

    const stamped = await withTenant(
      user.orgId,
      async (tx) => {
        // INFO-2 (round-2 red-team) — this stamp is the "mirror" of finalize's
        // FINALIZE-ONCE guard, so make it ATOMIC too (not check-then-act). The
        // earlier `if (row.uploadedAt)` read is a cheap fast-path; under READ
        // COMMITTED two concurrent content-uploads could BOTH read
        // uploaded_at=null, both pass that guard, and both re-stamp — letting a
        // second upload re-launder a post-finalize byte swap. The guarantee
        // lives in the WHERE: only the row still `uploaded_at IS NULL` is
        // updated; the loser matches 0 rows and we reject 409 (same code as the
        // fast-path + finalize guard).
        const [updated] = await tx
          .update(documents)
          .set({
            uploadedAt: new Date(),
            scanStatus: 'clean',
            scanSignature: null,
            bytesEncrypted: true,
            updatedAt: new Date(),
          })
          .where(and(eq(documents.id, row.id), isNull(documents.uploadedAt)))
          .returning();
        if (!updated) return { won: false as const };
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'document.content_upload',
          targetTable: 'documents',
          targetId: row.id,
          sessionId: user.sid,
        });
        return { won: true as const };
      },
      { userId: user.sub },
    );
    if (!stamped.won) {
      // A concurrent content-upload won the race and already stamped
      // uploaded_at. The envelope we PUT either lost the create-only race at
      // storage or harmlessly overwrote an identical-checksum object; either
      // way this caller did not finalise the doc.
      throw new ConflictException({ error: { code: 'document_already_uploaded' } });
    }
    return { uploaded: true };
  }

  /** Build the at-rest envelope: EMAPPENC|v1|keyId|iv|tag|ciphertext.
   *  iv is RANDOM PER OBJECT (GCM requirement — an iv reuse under the same
   *  key would be catastrophic); NO AAD (pinned, see constants above). */
  private encryptEnvelope(plain: Buffer): Buffer {
    // FL-3: stamp the ACTIVE keyId into the header and encrypt with its key.
    // With a single bare DOC_ENCRYPTION_KEY the active keyId is the reserved
    // legacy default (1) — byte-identical to the pre-FL-3 0x0001 stamp.
    const { keyId, key } = docKeyRegistry().forEncrypt();
    const keyIdBytes = Buffer.alloc(ENVELOPE_KEY_ID_LEN);
    keyIdBytes.writeUInt16BE(keyId, 0);
    const iv = randomBytes(ENVELOPE_IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([
      ENVELOPE_MAGIC,
      Buffer.from([ENVELOPE_VERSION]),
      keyIdBytes,
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
    const keyIdStart = ENVELOPE_MAGIC.length + 1; // after magic | version
    const keyId = envelope.readUInt16BE(keyIdStart);
    const ivStart = keyIdStart + ENVELOPE_KEY_ID_LEN; // magic | version | keyId
    const iv = envelope.subarray(ivStart, ivStart + ENVELOPE_IV_LEN);
    const tag = envelope.subarray(ivStart + ENVELOPE_IV_LEN, ENVELOPE_HEADER_LEN);
    const ciphertext = envelope.subarray(ENVELOPE_HEADER_LEN);
    // Key fetch OUTSIDE the try: a key MISCONFIG — env unset/malformed OR the
    // stamped keyId is not in the registry (rotation gap) — must FAIL CLOSED as
    // the ops 503 (doc_encryption_unavailable), never be swallowed into the
    // generic 500 corruption code and never fall back to another key. FL-3:
    // keyId 1 (legacy / single bare key) resolves to the legacy default key, so
    // every pre-FL-3 envelope still decrypts.
    let key: Buffer;
    try {
      key = docKeyRegistry().forDecrypt(keyId);
    } catch (e) {
      if (e instanceof DocEncryptionConfigError) {
        // Unknown keyId (no key for this rotation slot) — ops 503, not corruption.
        throw new ServiceUnavailableException({ error: { code: 'doc_encryption_unavailable' } });
      }
      throw e;
    }
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
   * Agent record-scoping for the board-completeness `total` rollup. IDENTICAL in
   * intent to {@link agentDocScope} but the project leg resolves via the SAME
   * CANONICAL scope as the board's `received`/`required` pass: a doc is in an
   * agent's scope when its CANONICAL project — COALESCE(doc_scope='project' →
   * doc_scope_id, project_id) — is an active assignment, OR (the apartment leg,
   * unchanged) it hangs off an apartment in an assigned project.
   *
   * WHY a dedicated helper (the S1 bug): `agentDocScope` keys the project leg on
   * the LEGACY `documents.project_id` column ONLY. The `received` pass resolves
   * the canonical doc_scope. So a doc filed canonically with project_id=NULL
   * satisfied a `received` slot yet was INVISIBLE to the `total` rollup — the
   * two numbers behind one party card measured two different populations. This
   * predicate makes `total` use the canonical resolver too, so the two passes can
   * never diverge on scope. Returns `undefined` for non-agents (managers/viewers
   * are RLS-org-bound on both passes, so they were never divergent).
   */
  private agentBoardScope(user: AccessTokenPayload): SQL | undefined {
    if (user.role !== 'agent') return undefined;
    // Canonical resolved project id — the SAME COALESCE the received pass uses.
    const resolvedProjectId = sql`COALESCE(
      CASE WHEN ${documents.docScope} = 'project' THEN ${documents.docScopeId} END,
      ${documents.projectId}
    )`;
    const directProjectAssigned = sql<boolean>`EXISTS (
      SELECT 1 FROM project_assignments pa
      WHERE pa.user_id = ${user.sub}::uuid
        AND pa.unassigned_at IS NULL
        AND pa.project_id = ${resolvedProjectId}
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
   * Phase 1 — translate a binder `party` filter into a SQL predicate over the
   * doc `type`. A named party expands to an exact `type IN (<its curated types>)`
   * (via the shared {@link docTypesForParty}); a party with NO curated types
   * (e.g. supervisor) becomes `FALSE` (an empty result — never a missing AND that
   * would silently widen). The `other` party additionally matches any UNMAPPED /
   * unknown free-text type — `type NOT IN (<every mapped type>)` OR `type IN
   * (<other's own types>)` — exactly mirroring providerPartyForDocType's
   * fall-through so the board's catch-all bucket and the search filter agree.
   * Pure SQL on the indexed `type` column; can only NARROW (always an added AND).
   */
  private partyTypeFilter(party: DocumentParty): SQL {
    const { types, includesUnmapped } = docTypesForParty(party);
    if (includesUnmapped) {
      // `other` = its own explicit types OR anything not mapped to a NAMED party.
      const allMapped = new Set<string>();
      for (const p of DOCUMENT_PARTIES) {
        if (p === 'other') continue;
        for (const t of docTypesForParty(p).types) allMapped.add(t);
      }
      const mappedList = [...allMapped];
      const notMapped: SQL =
        mappedList.length > 0 ? notInArray(documents.type, mappedList) : sql`TRUE`;
      if (types.length > 0) {
        const either = or(inArray(documents.type, types), notMapped);
        // `or` over two defined predicates is always defined; assert for the type.
        return either ?? notMapped;
      }
      return notMapped;
    }
    // A named party with no curated types → match nothing (fail-closed narrow).
    if (types.length === 0) return sql`FALSE`;
    return inArray(documents.type, types);
  }

  /**
   * NS1 (server-side search, MASTER-PLAN-V13 Wave B) — document NAME substring
   * search + type/party/scope filters, keyset-paginated. This is `list` with a
   * required `q` (name ILIKE, trigram-index served) plus the optional `type`
   * (exact), `party` (Phase 1 board zoom-in — expands to the party's doc types)
   * and `scope` (parent linkage) filters.
   *
   * VISIBILITY IS UNCHANGED (never widened): the SAME archived-exclusion (unless
   * `archived:true`), the SAME agent record-scoping (agentDocScope) and the SAME
   * org RLS apply. The download-time gates (uploaded/scan-clean/sensitive
   * step-up) are unaffected — search returns METADATA only (toDocument never
   * carries r2Key), so a row appearing here grants no extra content access. `q`
   * is bound as a PARAMETER with LIKE metacharacters escaped (no injection,
   * literal substring). The `scope`/`party`/`type` filters are pure SQL — each
   * can only NARROW the result (an added AND), never widen it.
   *
   * Phase 1: the returned docs carry the resolved parent LABELS (project name /
   * apartment number), batch-resolved INSIDE the same tenant tx (RLS-scoped).
   */
  async searchDocuments(
    user: AccessTokenPayload,
    query: {
      q: string;
      limit: number;
      cursor?: string;
      type?: string;
      party?: DocumentParty;
      projectId?: string;
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

    return withTenant(
      user.orgId,
      async (tx) => {
        const filters: (SQL | undefined)[] = [
          query.archived ? isNotNull(documents.archivedAt) : isNull(documents.archivedAt),
          sql`${documents.name} ILIKE ${pattern}`,
        ];
        if (query.type) filters.push(eq(documents.type, query.type));
        // Phase 1 — `party` narrows to that party's doc types (AND with `type`
        // if both given). Pure type-set predicate; never widens.
        if (query.party) filters.push(this.partyTypeFilter(query.party));
        // S2 (faceted shell) — `projectId` narrows to ONE project, resolved via the
        // CANONICAL scope (doc_scope='project' → doc_scope_id, else legacy
        // project_id) — the SAME resolver the board's received/required pass uses,
        // so a canonically-filed doc is found and the facet count agrees with the
        // board. NARROWING only (an extra AND; RLS + agent-scoping still bound it).
        if (query.projectId) {
          const pid = query.projectId;
          filters.push(
            or(
              and(eq(documents.docScope, 'project'), eq(documents.docScopeId, pid)),
              eq(documents.projectId, pid),
            ),
          );
        }
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

        const rows = await tx
          .select()
          .from(documents)
          .where(and(...filters, keyset))
          .orderBy(...keysetOrderBy(documents.createdAt, documents.id))
          .limit(limit + 1);

        const hasMore = rows.length > limit;
        const pageRows = hasMore ? rows.slice(0, limit) : rows;
        const last = pageRows[pageRows.length - 1];
        const names = await this.resolveParentNames(tx, pageRows);
        return {
          data: pageRows.map((r, i) => toDocument(r, names[i])),
          page: { limit, cursor: hasMore && last ? encodeCursor(last) : null, has_more: hasMore },
        };
      },
      { userId: user.sub },
    );
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

    return withTenant(
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

        const rows = await tx
          .select()
          .from(documents)
          .where(and(...filters, keyset))
          .orderBy(...keysetOrderBy(documents.createdAt, documents.id))
          .limit(limit + 1);

        const hasMore = rows.length > limit;
        const pageRows = hasMore ? rows.slice(0, limit) : rows;
        const last = pageRows[pageRows.length - 1];
        // Phase 1 — batch-resolve parent LABELS inside the SAME tenant tx (RLS).
        const names = await this.resolveParentNames(tx, pageRows);
        return {
          data: pageRows.map((r, i) => toDocument(r, names[i])),
          page: { limit, cursor: hasMore && last ? encodeCursor(last) : null, has_more: hasMore },
        };
      },
      { userId: user.sub },
    );
  }

  /**
   * PARTY-BINDER board completeness (binder slice 2) — per-PARTY REQUIRED-vs-
   * RECEIVED across the WHOLE board scope, computed SERVER-SIDE.
   *
   * WHY server-side (the bug this closes): the documents board is ORG-WIDE and
   * keyset-paginated. The FE previously derived completeness client-side from a
   * single 25-doc page while counting requirements across ALL projects — so the
   * ~20 projects whose docs were never loaded were auto-counted "missing"
   * (bogus "owners 0/21"). Completeness over a partial page is unsound; only the
   * server sees ALL the scope's documents. This method computes it over EVERY
   * visible project + EVERY non-archived doc in ONE aggregate pass (two index-
   * bounded queries, no N+1) → accurate + sub-second.
   *
   * MODEL (identical to the DH2 checklist + the FE slice-2 math, ONE shared
   * REQUIRED_DOC_TYPES_BY_TRACK + providerPartyForDocType): a "required slot" is
   * a (projectId, requiredType) pair per the project's track; a slot is RECEIVED
   * when a non-archived doc of that type exists FOR THAT PROJECT (DH1 canonical
   * doc_scope='project'+doc_scope_id, OR legacy project_id). Slots roll up to a
   * party via providerPartyForDocType.
   *
   * SCOPE / RLS (no-leak): withTenant → RLS tenant_isolation (org_id) FORCE on
   * EVERY table. For an AGENT the project set is further restricted to ACTIVE
   * assignments (the same predicate assertProjectVisible/list use), and received
   * docs are matched ONLY for those projects — an agent's completeness reflects
   * exactly their assigned deals, never the whole org.
   *
   * PRIVACY: counts + doc-type KEYS only. NO document id/name, NO owner PII. The
   * received probe selects DISTINCT (project_id-resolved, type) pairs — never a
   * row's content, name, or owner. Structural fact about the file set, not people.
   */
  async boardCompleteness(user: AccessTokenPayload): Promise<BoardCompleteness> {
    return withTenant(
      user.orgId,
      async (tx) => {
        // 1) The projects IN SCOPE (id + raw type → track). Manager/viewer = all
        //    org projects (RLS-scoped); agent = active assignments only. Archived
        //    projects still carry a checklist (a paused deal still "needs" its
        //    docs), matching the DH2 per-project checklist which does not filter
        //    on project archive state.
        //    EXCLUDE TERMINAL projects (`completed`/`cancelled`): a dead/finished
        //    deal needs no further doc collection, so it must NOT inflate the
        //    cockpit "needs attention" rollup (it surfaced cancelled projects with
        //    an "upload contract" CTA — noise that grows with scale). The set is
        //    DERIVED from the canonical PROJECT_STATUS_TRANSITIONS map (one source
        //    of truth), and stays consistent with the autonomy detector, which is
        //    even narrower (gathering_signatures ⊂ non-terminal).
        const projBase = tx
          .select({ id: projects.id, type: projects.type, name: projects.name })
          .from(projects)
          .where(notInArray(projects.status, [...PROJECT_TERMINAL_STATUSES]))
          .$dynamic();
        const projectRows =
          user.role === 'agent'
            ? await projBase.innerJoin(
                projectAssignments,
                and(
                  eq(projectAssignments.projectId, projects.id),
                  eq(projectAssignments.userId, user.sub),
                  isNull(projectAssignments.unassignedAt),
                ),
              )
            : await projBase;

        // Accumulate per-party required/received slot counts + missing-type sets.
        interface Acc {
          required: number;
          received: number;
          missing: Set<DocumentType>;
        }
        const acc = new Map<DocumentParty, Acc>();
        const bump = (party: DocumentParty): Acc => {
          let a = acc.get(party);
          if (!a) {
            a = { required: 0, received: 0, missing: new Set<DocumentType>() };
            acc.set(party, a);
          }
          return a;
        };

        // S2 (org cockpit) — per-PROJECT core-required rollup, populated in the
        // SAME loop as the per-party slots (no extra query). A project's `missing`
        // carries each missing required TYPE + its derived responsible PARTY so the
        // cockpit can name the party + deep-link the one-click upload. Counts +
        // type/party keys + the project NAME only — no owner PII.
        interface ProjAcc {
          name: string;
          coreRequired: number;
          coreReceived: number;
          missing: { type: DocumentType; party: DocumentParty }[];
        }
        const projAcc = new Map<string, ProjAcc>();

        if (projectRows.length > 0) {
          const projectIds = projectRows.map((p) => p.id);
          // The union of required types across the in-scope tracks — the only
          // types worth probing for "received" (we never count non-required docs).
          const requiredUnion = new Set<DocumentType>();
          for (const p of projectRows) {
            for (const t of REQUIRED_DOC_TYPES_BY_TRACK[trackForProjectType(p.type)]) {
              requiredUnion.add(t);
            }
          }

          // 2) RECEIVED: distinct (resolved project, type) pairs for non-archived
          //    docs whose type is in the required union AND whose project is in
          //    scope. Resolution mirrors the CANONICAL doc→project resolution
          //    (signature-progress.ts): the project leg (DH2 canonical
          //    doc_scope='project' id, else legacy project_id) UNION the APARTMENT
          //    leg (apartment → building → project). The apartment leg is
          //    load-bearing: an apartment-scoped required-type doc (e.g. a per-
          //    apartment agreement, project_id NULL under parent-exclusivity) must
          //    still roll up to its project — without it the cockpit would diverge
          //    from the signaturePulse/KPI which DO resolve the apartment leg
          //    (the "0 מתוך X" single-source class). RLS org-scopes; the IN-lists
          //    bound to the visible projects (no cross-project/agent leak).
          const receivedByProject = new Map<string, Set<string>>();
          if (requiredUnion.size > 0) {
            const reqTypesList = sql.join(
              [...requiredUnion].map((t) => sql`${t}`),
              sql`, `,
            );
            const projectIdsList = sql.join(
              projectIds.map((p) => sql`${p}`),
              sql`, `,
            );
            const recvResult = await tx.execute<{ project_id: string; type: string }>(sql`
              SELECT DISTINCT project_id, type FROM (
                -- project leg: canonical doc_scope='project' id, else legacy project_id
                SELECT
                  COALESCE(
                    CASE WHEN d.doc_scope = 'project' THEN d.doc_scope_id END,
                    d.project_id
                  ) AS project_id,
                  d.type AS type
                FROM documents d
                WHERE d.archived_at IS NULL
                  AND d.type IN (${reqTypesList})
                  AND (
                    (d.doc_scope = 'project' AND d.doc_scope_id IN (${projectIdsList}))
                    OR d.project_id IN (${projectIdsList})
                  )
                UNION
                -- apartment leg: apartment → building → project
                SELECT bc_b.project_id AS project_id, d.type AS type
                FROM documents d
                  INNER JOIN apartments bc_a ON bc_a.id = d.apartment_id
                  INNER JOIN buildings bc_b ON bc_b.id = bc_a.building_id
                WHERE d.archived_at IS NULL
                  AND d.type IN (${reqTypesList})
                  AND bc_b.project_id IN (${projectIdsList})
              ) resolved
            `);
            for (const r of recvResult.rows) {
              if (!r.project_id) continue;
              let set = receivedByProject.get(r.project_id);
              if (!set) {
                set = new Set<string>();
                receivedByProject.set(r.project_id, set);
              }
              set.add(r.type);
            }
          }

          // 3) Roll up: every project contributes its track's required types as
          //    slots; a slot is satisfied iff that project received that type.
          for (const project of projectRows) {
            const requiredTypes = REQUIRED_DOC_TYPES_BY_TRACK[trackForProjectType(project.type)];
            const received = receivedByProject.get(project.id);
            // S2 — start this project's per-project core rollup (every required
            // type is one core slot for the project, mapped to its responsible party).
            const pa: ProjAcc = {
              name: project.name,
              coreRequired: 0,
              coreReceived: 0,
              missing: [],
            };
            for (const reqType of requiredTypes) {
              const party = providerPartyForDocType(reqType);
              const a = bump(party);
              a.required += 1;
              pa.coreRequired += 1;
              if (received?.has(reqType)) {
                a.received += 1;
                pa.coreReceived += 1;
              } else {
                a.missing.add(reqType);
                pa.missing.push({ type: reqType, party });
              }
            }
            if (pa.coreRequired > 0) projAcc.set(project.id, pa);
          }
        }

        // ── Phase 1 (board-summary) — the WHOLE-BOARD per-party document rollup.
        // ONE aggregate pass over EVERY non-archived doc the caller can SEE,
        // grouped by the doc's ACTUAL type → party (providerPartyForDocType),
        // carrying the per-type count + the most-recent createdAt so we can derive
        // each party's `total` (docs filed), `latestType`, `latestCreatedAt`.
        // COUNTS + TYPE KEYS only — no id, no name, no owner PII. Fixes the
        // "counts lie" board bug (the FE counted a single 25-doc keyset page; a
        // party with >25 docs was truncated). Sub-second: a GROUP BY type over the
        // indexed, org-scoped, non-archived rows — no N+1, no per-doc fetch.
        //
        // SCOPE-ALIGNMENT (the S1 fix — the two passes must NOT diverge on which
        // docs are "in scope"): the `received`/`required` slot pass above resolves
        // a doc's project via the CANONICAL COALESCE(doc_scope='project' →
        // doc_scope_id, project_id) resolver, bounded to the in-scope project set.
        // The earlier `total` pass keyed an AGENT's visibility on the LEGACY
        // `documents.project_id` column alone (`agentDocScope`), so a doc filed
        // canonically (doc_scope='project'/doc_scope_id=X, legacy project_id NULL)
        // counted toward `received` but NOT toward `total` — two unaligned
        // populations behind ONE card. `agentBoardScope` resolves the agent's
        // project leg via the SAME canonical COALESCE (plus the apartment leg,
        // unchanged), so an agent's `total` and `received` now cover ONE
        // population. A manager is RLS-only on both passes (all org docs).
        interface PartyRollup {
          total: number;
          latestType: string | null;
          latestCreatedAt: Date | null;
        }
        const rollup = new Map<DocumentParty, PartyRollup>();
        const typeAgg = await tx
          .select({
            type: documents.type,
            count: sql<number>`COUNT(*)::int`,
            latest: sql<Date>`MAX(${documents.createdAt})`,
          })
          .from(documents)
          .where(and(isNull(documents.archivedAt), this.agentBoardScope(user)))
          .groupBy(documents.type);
        for (const row of typeAgg) {
          const party = providerPartyForDocType(row.type);
          const cur2 = rollup.get(party) ?? { total: 0, latestType: null, latestCreatedAt: null };
          cur2.total += row.count;
          // The party's latestType is the type of its most-recent doc. `latest`
          // is a Date (MAX over a timestamptz column); compare and keep the newest.
          const latest = row.latest instanceof Date ? row.latest : new Date(row.latest);
          if (cur2.latestCreatedAt === null || latest > cur2.latestCreatedAt) {
            cur2.latestCreatedAt = latest;
            cur2.latestType = row.type;
          }
          rollup.set(party, cur2);
        }

        // Emit ONE entry per canonical party (stable order) so the FE renders a
        // deterministic board; a party with no requirement is required:0.
        const byParty: PartyCompleteness[] = DOCUMENT_PARTIES.map((party) => {
          const a = acc.get(party);
          const required = a?.required ?? 0;
          const received = a?.received ?? 0;
          const hasRequirement = required > 0;
          const r = rollup.get(party);
          return {
            party,
            required,
            received,
            hasRequirement,
            isComplete: hasRequirement && received >= required,
            missingTypes: a ? [...a.missing].map((type) => ({ type })) : [],
            // Phase 1 board-summary fields (whole-board; counts + type key only).
            total: r?.total ?? 0,
            latestType: r?.latestType ?? null,
            latestCreatedAt: r?.latestCreatedAt ?? null,
          };
        });

        const unmetParties = byParty
          .filter((c) => c.hasRequirement && c.received < c.required)
          .map((c) => c.party);
        const hasAnyRequirement = byParty.some((c) => c.hasRequirement);

        // S2 (org cockpit) — the PROJECT-attention axis. From the per-project core
        // rollup: every project WITH a requirement is the denominator; those whose
        // core set is UNMET (coreReceived < coreRequired) are ranked WORST-FIRST
        // (fewest filled first, then most missing), capped so the cockpit stays a
        // calm situation-picture rather than a wall. Counts + type/party keys + the
        // project name only — no owner PII.
        const projectsWithRequirement = projAcc.size;
        const behindAll = [...projAcc.entries()]
          .filter(([, p]) => p.coreReceived < p.coreRequired)
          .sort(([, a], [, b]) => {
            // Worst-first: fewer core slots filled ranks higher; tie-break on more
            // missing types, then a stable name sort for determinism.
            if (a.coreReceived !== b.coreReceived) return a.coreReceived - b.coreReceived;
            if (a.missing.length !== b.missing.length) return b.missing.length - a.missing.length;
            return a.name.localeCompare(b.name);
          });
        const projectsBehind = behindAll.slice(0, PROJECTS_BEHIND_CAP).map(([projectId, p]) => ({
          projectId,
          projectName: p.name,
          coreRequired: p.coreRequired,
          coreReceived: p.coreReceived,
          missing: p.missing,
        }));

        return {
          byParty,
          unmetParties,
          hasAnyRequirement,
          allRequirementsMet: hasAnyRequirement && unmetParties.length === 0,
          // S2 — project-attention axis.
          projectsBehind,
          projectsWithRequirement,
          // The TRUE behind count (pre-cap) — the cockpit derives "behind" + "met"
          // from THIS, never from the capped `projectsBehind` length (which would
          // over-state "completed" at scale). Same `behindAll` that produced the
          // capped display list — one source of truth.
          projectsBehindTotal: behindAll.length,
          projectsBehindCapped: behindAll.length > PROJECTS_BEHIND_CAP,
        };
      },
      { userId: user.sub },
    );
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
