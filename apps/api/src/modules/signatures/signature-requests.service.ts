import { randomUUID } from 'node:crypto';

import { serverEnv } from '@emapp/config';
import {
  AuditService,
  DEFAULT_EMAIL_FROM,
  apartments,
  buildEmailFrom,
  buildings,
  documents,
  owners,
  ownerships,
  projectAssignments,
  projects,
  signatureRequests,
  withTenant,
  type IEmailProvider,
  type ISMSProvider,
  type TenantTx,
} from '@emapp/db';
import type {
  CreateSignatureRequest,
  BulkCreateSignatureRequest,
  BulkSignatureRequestResponse,
  BulkSignatureResult,
  SignatureCampaignInput,
  SignatureCampaignResponse,
  SignatureRequest,
  SignatureRequestCreateResponse,
  SignatureRequestLinkResponse,
  SignatureDeliveryReport,
  ListSignatureRequestsQueryDto,
} from '@emapp/shared-types';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, eq, gt, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';

import { requireAgentCapability } from '../../common/authz/agent-capabilities';
import {
  decodeCursor,
  encodeCursor,
  keysetCondition,
  keysetOrderBy,
} from '../../common/keyset-cursor';
import { getOrgSettings } from '../../common/org-settings.resolver';
import type { AccessTokenPayload } from '../auth/auth.service';
import { SMS_PROVIDER } from '../auth/tenant/otp.service';
import { EMAIL_PROVIDER } from '../members/invite-email';
import { StatsCacheService } from '../projects/stats-cache.service';

import { deliverSignatureLink } from './signature-link-delivery';
import { SignatureTokenService } from './signature-token.service';

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });

/** Manager-side list page envelope (D.16 + keyset pagination). */
export interface SignatureRequestListPage {
  data: SignatureRequest[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

/** Public-facing FE base for `/sign/:token` URLs. Falls back to a sane
 *  dev default; in prod set explicitly to the deployed FE origin. */
const PUBLIC_APP_URL = process.env['PUBLIC_APP_URL'] ?? 'http://localhost:3001';

/** Manager-side signature_requests CRUD (Phase 5 S4-min).
 *
 * Scope of this MINIMAL slice: just `create`. List/get/cancel land in a
 * follow-up commit after the security E2E test proves the public-link
 * flow. The CRITICAL security paths (token mint, atomic single-use,
 * resident POST) are exercised end-to-end by S5 + the E2E test.
 *
 * Cross-org IDOR defense (layer 6 of the 10 we documented): every read
 * goes through withTenant(user.orgId) → RLS forces org_id match on
 * documents + owners + signature_requests. A manager forging another
 * org's documentId/ownerId hits a 404 here (no oracle).
 */
@Injectable()
export class SignatureRequestsService {
  private readonly logger = new Logger(SignatureRequestsService.name);

  constructor(
    private readonly tokenService: SignatureTokenService,
    @Inject(EMAIL_PROVIDER) private readonly email: IEmailProvider,
    @Inject(SMS_PROVIDER) private readonly sms: ISMSProvider,
    // E2 Wave-0 PERF — OPTIONAL stats cache. Creating/cancelling/bulk-sending
    // signature requests changes pending/signed counts that feed orgStats +
    // signatureProgress, so these writes invalidate the org's stats epoch.
    // Optional so specs that `new SignatureRequestsService(...)` without it
    // still construct (no-op invalidation).
    @Optional() private readonly statsCache?: StatsCacheService,
  ) {}

  /** Best-effort org-stats invalidation after a request write. Never throws
   *  into the write path; no-op when the cache isn't wired. */
  private async invalidateStats(orgId: string): Promise<void> {
    if (!this.statsCache) return;
    try {
      await this.statsCache.invalidateOrg(orgId);
    } catch (e: unknown) {
      this.logger.warn(
        `stats-cache invalidate failed (org=${orgId}): ${e instanceof Error ? e.message : 'unknown'}`,
      );
    }
  }

  /** Validate the document is visible in the manager's org and not
   *  archived. Returns the row or throws no-oracle 404. */
  private async loadVisibleDocument(
    tx: TenantTx,
    documentId: string,
  ): Promise<{
    id: string;
    name: string;
    archivedAt: Date | null;
    apartmentId: string | null;
    projectId: string | null;
  }> {
    const [row] = await tx
      .select({
        id: documents.id,
        name: documents.name,
        archivedAt: documents.archivedAt,
        uploadedAt: documents.uploadedAt,
        apartmentId: documents.apartmentId,
        projectId: documents.projectId,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    // 0049 — a signature request may only target a FINALISED document. Else a
    // resident could be sent a link whose document was never stored (the
    // preview 404s, yet the signature would record against absent bytes — the
    // audit's worst ghost finding). uploaded_at IS NULL → 404.
    if (!row || row.archivedAt || !row.uploadedAt) throw NOT_FOUND;
    return {
      id: row.id,
      name: row.name,
      archivedAt: row.archivedAt,
      apartmentId: row.apartmentId,
      projectId: row.projectId,
    };
  }

  /** Validate the owner exists in the manager's org. Returns the row or
   *  throws no-oracle 404.
   *
   *  v8 §v8-S3: dropped `name` from the SELECT — this presence-only
   *  helper has no caller that needs the name; `loadOwnerWithPii`
   *  is the path that fetches PII (name + phone) for delivery. */
  private async loadOwner(
    tx: TenantTx,
    ownerId: string,
  ): Promise<{ id: string; archivedAt: Date | null }> {
    const [row] = await tx
      .select({
        id: owners.id,
        archivedAt: owners.archivedAt,
      })
      .from(owners)
      .where(eq(owners.id, ownerId))
      .limit(1);
    if (!row || row.archivedAt) throw NOT_FOUND;
    return row;
  }

  /** S3c ("renter → discovery-source") — the renter SIGNATURE GATE is now a
   *  DEFENSIVE NO-OP (always returns ∅).
   *
   *  The renter concept moved OUT of `ownerships` into `discovery_records`
   *  (migration 0066): an occupant is a DISCOVERY SOURCE attached to an
   *  apartment, NOT an owner/signer. `ownerships.relationship` is now pinned by a
   *  DB CHECK to ('owner') — no renter ownership row can exist, so there is
   *  nothing for this gate to exclude. A discovery record carries no owner_id and
   *  creates no ownership row, so it can never be selected by the recipient path
   *  (which resolves owner_id → owners/ownerships) in the first place.
   *
   *  Kept as a no-op chokepoint (rather than deleted) so the call sites below
   *  stay structurally identical and a future re-introduction of a non-owner
   *  ownership relationship has an obvious place to live. It does NOT weaken the
   *  recipient gate: who may be a recipient is governed ENTIRELY by
   *  `resolveAssociatedOwners` (Slice-1 #2), which is unchanged.
   */
  private async resolveRenterOnly(_tx: TenantTx, _ownerIds: string[]): Promise<Set<string>> {
    // No active renter ownership rows exist post-0066 → empty exclusion set.
    return new Set();
  }

  /** Slice-1 #2 — RECIPIENT-ASSOCIATION GATE.
   *
   *  A signing link may only be minted for an owner who is actually tied to the
   *  DOCUMENT's scope — otherwise a manager could send "sign this apartment's
   *  document" to a person who has no ownership in it at all (a correctness +
   *  consent defect: the resulting signature would attribute consent to someone
   *  unconnected to the property). The bond is the active `ownerships` row
   *  (`ended_at IS NULL`):
   *    - apartment-scoped document (`apartment_id` set) → the owner must have an
   *      active ownership of THAT apartment.
   *    - else project-scoped document (`project_id` set) → the owner must have an
   *      active ownership in SOME apartment belonging to that project
   *      (ownership → apartment → building → project).
   *    - neither scope → a signature request is meaningless; reject.
   *  RLS-scoped to the org via the caller's withTenant tx. Returns the subset of
   *  `ownerIds` that ARE associated (the complement is rejected/failed).
   */
  private async resolveAssociatedOwners(
    tx: TenantTx,
    doc: { apartmentId: string | null; projectId: string | null },
    ownerIds: string[],
  ): Promise<Set<string>> {
    if (ownerIds.length === 0) return new Set();
    // A document with NEITHER scope can never have an associated owner.
    if (!doc.apartmentId && !doc.projectId) return new Set();

    if (doc.apartmentId) {
      // Apartment-scoped: active ownership of THIS apartment.
      const rows = await tx
        .select({ ownerId: ownerships.ownerId })
        .from(ownerships)
        .where(
          and(
            inArray(ownerships.ownerId, ownerIds),
            eq(ownerships.apartmentId, doc.apartmentId),
            sql`${ownerships.endedAt} IS NULL`,
          ),
        );
      return new Set(rows.map((r) => r.ownerId));
    }

    // Project-scoped: active ownership in any apartment under this project
    // (ownership → apartment → building → project).
    const rows = await tx
      .select({ ownerId: ownerships.ownerId })
      .from(ownerships)
      .innerJoin(apartments, eq(apartments.id, ownerships.apartmentId))
      .innerJoin(buildings, eq(buildings.id, apartments.buildingId))
      .where(
        and(
          inArray(ownerships.ownerId, ownerIds),
          eq(buildings.projectId, doc.projectId as string),
          sql`${ownerships.endedAt} IS NULL`,
        ),
      );
    return new Set(rows.map((r) => r.ownerId));
  }

  /** Create a signature request and mint its JWT token.
   *
   *  Flow:
   *    1. Pre-generate the request ID (UUID).
   *    2. Mint the JWT signed with SIGNATURE_TOKEN_SECRET. The token's
   *       `sub` is the request ID; jti is a server-CSPRNG UUID.
   *    3. INSERT signature_requests inside withTenant — RLS enforces
   *       org_id match for documentId/ownerId (via the loadVisible*
   *       reads earlier in the same tx).
   *    4. Audit `signature_request.create`.
   *  Idempotency: if the manager retries with the same Idempotency-Key,
   *  the global interceptor returns the cached response. We rely on it;
   *  no per-resource dedup here. */
  async create(
    user: AccessTokenPayload,
    input: CreateSignatureRequest,
  ): Promise<SignatureRequestCreateResponse> {
    const requestId = randomUUID();

    // Mint OUTSIDE the tx: the JWT mint is in-process and idempotent.
    // Doing it before the INSERT avoids holding a DB connection during
    // crypto work. The token's `sub` is the pre-generated request ID;
    // jti is server-CSPRNG.
    const { token, jti, expiresAt } = this.tokenService.sign({
      sub: requestId,
      orgId: user.orgId,
      documentId: input.documentId,
      ownerId: input.ownerId,
    });

    const txOut = await withTenant(
      user.orgId,
      async (tx) => {
        // Layer-6 IDOR defense: verify document + owner are in this org.
        // The two reads are scoped by withTenant RLS — a foreign id is
        // simply invisible and the SELECT returns 0 rows → 404 (no
        // oracle distinguishes "wrong org" from "never existed").
        const doc = await this.loadVisibleDocument(tx, input.documentId);
        // D.46 — gate BEFORE decrypting owner PII (defense-in-depth: a rejected
        // agent must never trigger owner national_id/phone decryption). Agent:
        // the underlying document must be in an assigned project (404), then the
        // manage_signatures capability (403). Manager passes both; the signature
        // inherits the document's project scope.
        if (user.role === 'agent') await this.assertDocVisibleForAgent(tx, user, input.documentId);
        await requireAgentCapability(tx, user, 'manage_signatures');

        // Feature A (D.25) RENTER GATE — a renter can NEVER be issued a signing
        // link. No-oracle 404 (same shape as a foreign/archived owner): a
        // forged/stale client-supplied renter id is indistinguishable from
        // "never existed". Runs BEFORE PII decrypt (defense-in-depth: an
        // ineligible owner must not trigger national_id/phone decryption).
        if ((await this.resolveRenterOnly(tx, [input.ownerId])).has(input.ownerId)) {
          throw NOT_FOUND;
        }

        // Slice-1 #2 — RECIPIENT-ASSOCIATION GATE. The owner MUST be tied to the
        // document's scope (active ownership of the document's apartment, or —
        // for a project-scoped document — of some apartment under that project).
        // A document with no scope cannot have an associated owner → reject.
        // Runs BEFORE PII decrypt (defense-in-depth: an unassociated owner must
        // not trigger national_id/phone decryption).
        if (!(await this.resolveAssociatedOwners(tx, doc, [input.ownerId])).has(input.ownerId)) {
          throw new ConflictException({ error: { code: 'recipient_not_associated' } });
        }

        const own = await this.loadOwnerWithPii(tx, input.ownerId);

        // Block a duplicate pending request for the same (doc, owner).
        // Cancelled/signed/expired requests don't block: cancelled/signed are
        // terminal-by-action, and an EXPIRED pending link is dead — the manager
        // must be able to re-issue. So the guard requires status='pending' AND a
        // still-live deadline (expires_at > now()); a lapsed-but-still-'pending'
        // row (pre-sweep) no longer blocks (Slice-1 #3).
        const [existingPending] = await tx
          .select({ id: signatureRequests.id })
          .from(signatureRequests)
          .where(
            and(
              eq(signatureRequests.documentId, input.documentId),
              eq(signatureRequests.ownerId, input.ownerId),
              eq(signatureRequests.status, 'pending'),
              gt(signatureRequests.expiresAt, sql`now()`),
            ),
          )
          .limit(1);
        if (existingPending) {
          throw new ConflictException({
            error: { code: 'signature_request_pending_exists' },
          });
        }

        const [inserted] = await tx
          .insert(signatureRequests)
          .values({
            id: requestId,
            orgId: user.orgId,
            documentId: input.documentId,
            ownerId: input.ownerId,
            jti,
            status: 'pending',
            expiresAt,
            createdBy: user.sub,
          })
          .returning();
        if (!inserted) {
          throw new ConflictException({ error: { code: 'signature_request_conflict' } });
        }

        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'signature_request.create',
          targetTable: 'signature_requests',
          targetId: inserted.id,
          sessionId: user.sid,
        });

        // Bundle the data delivery needs while we still have the tx
        // open (decryption uses pgcrypto + the app.encryption_key GUC).
        // P6 — resolve the per-org From display name here too (RLS-scoped read).
        const from = await this.resolveFromForOrg(tx, user.orgId);
        return {
          row: inserted,
          documentName: doc.name,
          ownerName: own.name,
          ownerEmail: own.email,
          ownerPhone: own.phonePlain,
          from,
        };
      },
      { userId: user.sub },
    );

    // A new pending request bumps signaturesPending (orgStats +
    // signatureProgress). Invalidate after the insert committed.
    await this.invalidateStats(user.orgId);

    const signUrl = `${PUBLIC_APP_URL}/sign/${token}`;

    // S6 delivery — fires AFTER the tx commits so a slow Resend call
    // never holds a DB connection. Failures are logged + reported in
    // the per-channel report; the create endpoint itself stays 2xx
    // (the signUrl is the primary deliverable).
    const delivery: SignatureDeliveryReport = await deliverSignatureLink(
      this.email,
      this.sms,
      {
        signUrl,
        ownerName: txOut.ownerName,
        ownerEmail: txOut.ownerEmail,
        ownerPhone: txOut.ownerPhone,
        documentName: txOut.documentName,
      },
      { error: (m): void => this.logger.error(m) },
      txOut.from,
    );

    return {
      request: this.toWire(txOut.row),
      signUrl,
      delivery,
    };
  }

  /** Bulk send — ONE document to MANY owners in a single action (the manager's
   *  most-repeated task: a whole building's owners). Per-owner outcome:
   *   - created          → a new pending request + a delivery attempt
   *   - skipped_existing → owner already had a pending request for this doc
   *   - failed           → owner not visible/in-org (or a per-owner insert race)
   *  A bad/duplicate owner NEVER aborts the batch. The signing token is sent
   *  via the delivery channels only — it is NEVER returned in the response.
   *
   *  Shape mirrors create(): all DB work in ONE tenant tx (gate once, batch the
   *  already-pending lookup), then deliver OUTSIDE the tx with bounded
   *  concurrency so no DB connection is held across the external SMS/email I/O. */
  async createBulk(
    user: AccessTokenPayload,
    input: BulkCreateSignatureRequest,
  ): Promise<BulkSignatureRequestResponse> {
    const ownerIds = [...new Set(input.ownerIds)];

    // Mint a token per owner OUTSIDE the tx (in-process, idempotent).
    const minted = ownerIds.map((ownerId) => {
      const requestId = randomUUID();
      const { token, jti, expiresAt } = this.tokenService.sign({
        sub: requestId,
        orgId: user.orgId,
        documentId: input.documentId,
        ownerId,
      });
      return { ownerId, requestId, token, jti, expiresAt };
    });

    const prepared = await withTenant(
      user.orgId,
      async (tx) => {
        // Gate ONCE for the whole bulk (document visibility + agent capability).
        const doc = await this.loadVisibleDocument(tx, input.documentId);
        if (user.role === 'agent') await this.assertDocVisibleForAgent(tx, user, input.documentId);
        await requireAgentCapability(tx, user, 'manage_signatures');

        // Owners that already have a LIVE pending request for this doc → skip
        // (1 query). Slice-1 #3: an EXPIRED-but-still-'pending' row (pre-sweep)
        // must NOT count as blocking, so the predicate also requires a live
        // deadline (expires_at > now()) — mirroring the single-create guard.
        const existing = await tx
          .select({ ownerId: signatureRequests.ownerId })
          .from(signatureRequests)
          .where(
            and(
              eq(signatureRequests.documentId, input.documentId),
              inArray(signatureRequests.ownerId, ownerIds),
              eq(signatureRequests.status, 'pending'),
              gt(signatureRequests.expiresAt, sql`now()`),
            ),
          );
        const pendingSet = new Set(existing.map((r) => r.ownerId));

        // Visibility via a CHEAP id-only SELECT (RLS-scoped). It does NO pgcrypto
        // decrypt, so — unlike loadOwnerWithPii — it cannot RAISE on a corrupt-
        // ciphertext owner and abort the whole batch tx (sec-review HIGH). PII is
        // decrypted later, per-owner, in ISOLATED txs during delivery, so a bad
        // owner only fails ITS delivery, never the committed batch.
        const visibleRows = await tx
          .select({ id: owners.id })
          .from(owners)
          .where(inArray(owners.id, ownerIds));
        const visibleSet = new Set(visibleRows.map((r) => r.id));

        // Feature A (D.25) RENTER GATE — one batched query identifies owners who
        // are renter-only (renter somewhere active, owner nowhere) so they are
        // NEVER minted a signing link. A renter is a per-owner `failed`
        // (reason 'owner_is_renter'), never aborting the batch — same posture as
        // an owner_not_found. This is the load-bearing exclusion (the ownerIds
        // are client-supplied; this is the server's resolution chokepoint).
        const renterOnlySet = await this.resolveRenterOnly(tx, ownerIds);

        // Slice-1 #2 — RECIPIENT-ASSOCIATION GATE (bulk). One batched query
        // resolves which target owners are tied to the document's scope (active
        // ownership of the document's apartment, or — for a project-scoped
        // document — of some apartment under that project). An UNASSOCIATED owner
        // is a per-owner `failed` (reason 'recipient_not_associated'), never
        // aborting the batch — same posture as owner_not_found / owner_is_renter.
        // A scope-less document yields an empty set → every target fails here.
        const associatedSet = await this.resolveAssociatedOwners(tx, doc, ownerIds);

        const audit = new AuditService(tx, { ip: user.ip, userAgent: user.userAgent });
        const bundles: Array<{
          ownerId: string;
          requestId: string;
          token: string;
          outcome: 'created' | 'skipped_existing' | 'failed';
          reason?: string;
        }> = [];

        for (const m of minted) {
          if (pendingSet.has(m.ownerId)) {
            bundles.push({ ...m, outcome: 'skipped_existing' });
            continue;
          }
          if (!visibleSet.has(m.ownerId)) {
            // Foreign/archived/non-existent id — no-oracle, no row. Batch continues.
            bundles.push({ ...m, outcome: 'failed', reason: 'owner_not_found' });
            continue;
          }
          if (renterOnlySet.has(m.ownerId)) {
            // Feature A (D.25): a renter cannot sign. Skip minting/inserting for
            // this owner; the rest of the batch is unaffected.
            bundles.push({ ...m, outcome: 'failed', reason: 'owner_is_renter' });
            continue;
          }
          if (!associatedSet.has(m.ownerId)) {
            // Slice-1 #2: the owner isn't tied to this document's scope. Per-owner
            // failure; the batch continues for the associated owners.
            bundles.push({ ...m, outcome: 'failed', reason: 'recipient_not_associated' });
            continue;
          }
          const [inserted] = await tx
            .insert(signatureRequests)
            .values({
              id: m.requestId,
              orgId: user.orgId,
              documentId: input.documentId,
              ownerId: m.ownerId,
              jti: m.jti,
              status: 'pending',
              expiresAt: m.expiresAt,
              createdBy: user.sub,
            })
            .returning({ id: signatureRequests.id });
          if (!inserted) {
            bundles.push({ ...m, outcome: 'failed', reason: 'insert_conflict' });
            continue;
          }
          await audit.log({
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: 'signature_request.create',
            targetTable: 'signature_requests',
            targetId: m.requestId,
            sessionId: user.sid,
          });
          bundles.push({ ...m, outcome: 'created' });
        }
        // P6 — resolve the per-org From ONCE for the whole batch (RLS-scoped).
        const from = await this.resolveFromForOrg(tx, user.orgId);
        return { documentName: doc.name, bundles, from };
      },
      { userId: user.sub },
    );

    // Any 'created' bundle inserted a pending request → bump the org's stats.
    // (createCampaign fans out through here, so campaigns are covered too.)
    if (prepared.bundles.some((b) => b.outcome === 'created')) {
      await this.invalidateStats(user.orgId);
    }

    // Deliver OUTSIDE the gate/insert tx, bounded-concurrency. Each created
    // owner's PII is decrypted in its OWN short withTenant tx, so a corrupt-
    // ciphertext / key-drift owner only fails ITS delivery — the committed
    // request row and every other owner are unaffected (sec-review HIGH).
    const DELIVERY_CONCURRENCY = 8;
    const results: BulkSignatureResult[] = [];
    for (let i = 0; i < prepared.bundles.length; i += DELIVERY_CONCURRENCY) {
      const chunk = prepared.bundles.slice(i, i + DELIVERY_CONCURRENCY);
      const chunkResults = await Promise.all(
        chunk.map(async (b): Promise<BulkSignatureResult> => {
          if (b.outcome !== 'created') {
            return { ownerId: b.ownerId, outcome: b.outcome, reason: b.reason };
          }
          let pii: { name: string; email: string | null; phonePlain: string | null };
          try {
            pii = await withTenant(user.orgId, (tx) => this.loadOwnerWithPii(tx, b.ownerId), {
              userId: user.sub,
            });
          } catch {
            // The request IS created; only its delivery PII failed to decrypt
            // (corrupt ciphertext / key drift). Report created, no delivery.
            // PII-free warn (ownerId is a UUID) so a GLOBAL key/config outage —
            // which would make every owner here silently undeliverable — is
            // observable to ops, not masked as a per-owner success (sec-review LOW).
            this.logger.warn(
              `bulk delivery: owner PII decrypt failed for owner=${b.ownerId} ` +
                `(request created, delivery skipped)`,
            );
            return { ownerId: b.ownerId, outcome: 'created', requestId: b.requestId };
          }
          const delivery = await deliverSignatureLink(
            this.email,
            this.sms,
            {
              signUrl: `${PUBLIC_APP_URL}/sign/${b.token}`,
              ownerName: pii.name,
              ownerEmail: pii.email,
              ownerPhone: pii.phonePlain,
              documentName: prepared.documentName,
            },
            { error: (msg): void => this.logger.error(msg) },
            prepared.from,
          );
          return { ownerId: b.ownerId, outcome: 'created', requestId: b.requestId, delivery };
        }),
      );
      results.push(...chunkResults);
    }

    return {
      results,
      summary: {
        created: results.filter((r) => r.outcome === 'created').length,
        skipped: results.filter((r) => r.outcome === 'skipped_existing').length,
        failed: results.filter((r) => r.outcome === 'failed').length,
      },
    };
  }

  /** S5b — SIGNATURE CAMPAIGN fan-out. Send ONE project document to EVERY active
   *  owner across the project's apartments in a single action (the manager's
   *  "send to all owners" button). The recipient list is DERIVED server-side
   *  (the client never supplies ownerIds — it only picks the project + doc), then
   *  the existing `createBulk` path is REUSED so every per-owner guarantee holds:
   *  the Slice-1 #2 association gate, the #3 expired-dedup (skip a LIVE pending),
   *  the renter gate, and the bounded-concurrency delivery — all unchanged.
   *
   *  Steps:
   *   1. Visibility gate — the project must be visible to the caller. We replicate
   *      the SAME withTenant existence+scope check projects.get() uses: RLS scopes
   *      the org (a cross-org id is invisible → no row → no-oracle 404), and for an
   *      agent the project must be an ACTIVE assignment (an unassigned project is
   *      likewise invisible → 404). No oracle distinguishes the cases.
   *   2. Document-belongs-to-project gate — the document must be PROJECT-scoped
   *      with project_id === projectId. A doc scoped to a DIFFERENT project, or an
   *      apartment-scoped doc whose apartment is NOT under this project, is rejected
   *      (BadRequest 400). (loadVisibleDocument already 404s a foreign/archived/
   *      non-finalised doc.)
   *   3. Owner derivation — DISTINCT active owners: ownerships.ended_at IS NULL,
   *      relationship='owner' → apartments (archived_at IS NULL) → buildings →
   *      projects.id = projectId. (Post-3c, ownerships are owner-only.)
   *   4. Fan out via createBulk. createBulk caps ownerIds at 200, so for a project
   *      with >200 owners we CHUNK the derived list into <=200 batches, call
   *      createBulk per chunk, and SUM the summaries. An empty list short-circuits
   *      (createBulk's min-1 cap would otherwise reject it).
   *
   *  `total` is the count of DISTINCT derived owners; `created`/`skipped` are the
   *  summed bulk tallies. (`expiresInDays` is accepted for forward-compat but the
   *  token TTL default applies — createBulk owns the deadline today.) */
  async createCampaign(
    user: AccessTokenPayload,
    projectId: string,
    input: SignatureCampaignInput,
  ): Promise<SignatureCampaignResponse> {
    // Steps 1-3 in ONE tenant tx: visibility gate, doc-belongs-to-project gate,
    // owner derivation. RLS scopes every table to the caller's org.
    const ownerIds = await withTenant(
      user.orgId,
      async (tx): Promise<string[]> => {
        // (1) Project-visibility gate — mirrors projects.get(): RLS org-isolation
        // for everyone, PLUS an active-assignment join for agents. Not visible →
        // no row → no-oracle 404 (cross-org and unassigned-agent are identical).
        const [proj] =
          user.role === 'agent'
            ? await tx
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
                .limit(1)
            : await tx
                .select({ id: projects.id })
                .from(projects)
                .where(eq(projects.id, projectId))
                .limit(1);
        if (!proj) throw NOT_FOUND;

        // (1b) Agent-capability gate — a campaign is a signature WRITE, so an
        // agent needs `manage_signatures` (Manager passes). createBulk re-checks
        // it per chunk, but gating here (before deriving owners) is the explicit
        // defense-in-depth the D.54 fail-open guard requires for an agent-loosened
        // write endpoint.
        await requireAgentCapability(tx, user, 'manage_signatures');

        // (2) Document-belongs-to-project gate. loadVisibleDocument 404s a
        // foreign/archived/non-finalised doc (RLS-scoped). Then the doc's scope
        // MUST resolve to THIS project: a project-scoped doc must carry this
        // project_id; an apartment-scoped doc's apartment must sit under this
        // project (apartment → building → project). Anything else → 400.
        const doc = await this.loadVisibleDocument(tx, input.documentId);
        // A campaign requires a PROJECT-scoped document (it fans out to every
        // owner in the project). An apartment-scoped or foreign doc → 400.
        if (!this.documentBelongsToProject(doc, projectId)) {
          throw new BadRequestException({ error: { code: 'document_not_in_project' } });
        }

        // (3) Derive DISTINCT active owners of THIS project: active owner
        // ownership → non-archived apartment → building → project = :id.
        const rows = await tx
          .selectDistinct({ ownerId: ownerships.ownerId })
          .from(ownerships)
          .innerJoin(apartments, eq(apartments.id, ownerships.apartmentId))
          .innerJoin(buildings, eq(buildings.id, apartments.buildingId))
          .where(
            and(
              eq(buildings.projectId, projectId),
              isNull(ownerships.endedAt),
              eq(ownerships.relationship, 'owner'),
              isNull(apartments.archivedAt),
            ),
          );
        return rows.map((r) => r.ownerId);
      },
      { userId: user.sub },
    );

    const total = ownerIds.length;
    // No active owners → nothing to fan out (and createBulk's min-1 cap would
    // reject an empty list). Return the zeroed tally without calling createBulk.
    if (total === 0) return { created: 0, skipped: 0, total: 0 };

    // (4) Fan out via createBulk, REUSING its #2 gate / #3 dedup / delivery.
    // createBulk caps ownerIds at 200, so chunk the derived list into <=200
    // batches and SUM the per-chunk summaries.
    const CHUNK = 200;
    let created = 0;
    let skipped = 0;
    for (let i = 0; i < ownerIds.length; i += CHUNK) {
      const chunk = ownerIds.slice(i, i + CHUNK);
      const res = await this.createBulk(user, { documentId: input.documentId, ownerIds: chunk });
      created += res.summary.created;
      skipped += res.summary.skipped;
    }

    return { created, skipped, total };
  }

  /** Is `doc` a PROJECT-scoped document of `projectId`? A campaign fans out to
   *  EVERY owner in the project, so it requires a project-scoped doc (project_id
   *  directly = this project). An APARTMENT-scoped doc is rejected even when its
   *  apartment is in the project: the #2 association gate would associate only
   *  that apartment's owners, so the rest would land in `failed` and be dropped
   *  silently (a code-review honesty gap). A per-apartment send is the bulk path,
   *  not a campaign. A scope-less doc never qualifies. RLS-scoped via the tx.
   *  (tx unused now that only the project_id is checked — kept for signature
   *  symmetry with the other doc helpers.) */
  private documentBelongsToProject(
    doc: { apartmentId: string | null; projectId: string | null },
    projectId: string,
  ): boolean {
    return doc.projectId !== null && doc.projectId === projectId;
  }

  /** Resend / remind — refresh an existing PENDING request's link and re-deliver.
   *  Re-mints a NEW token (fresh jti + a new 7-day expiry), atomically swaps the
   *  pending row's jti/expiresAt (the OLD link dies, the clock restarts), then
   *  re-delivers via email/SMS/WhatsApp. Only a `pending` request can be resent —
   *  a signed/cancelled one 409s. Same coarse + fine gate as create. */
  async resend(user: AccessTokenPayload, id: string): Promise<SignatureRequestCreateResponse> {
    const txOut = await withTenant(
      user.orgId,
      async (tx) => {
        const [req] = await tx
          .select({
            id: signatureRequests.id,
            documentId: signatureRequests.documentId,
            ownerId: signatureRequests.ownerId,
            status: signatureRequests.status,
          })
          .from(signatureRequests)
          .where(eq(signatureRequests.id, id))
          .limit(1);
        if (!req) throw NOT_FOUND;
        // D.46 — agent: the signature's document must be in an assigned project
        // (404), then the manage_signatures capability (403). Manager passes.
        if (user.role === 'agent') await this.assertDocVisibleForAgent(tx, user, req.documentId);
        await requireAgentCapability(tx, user, 'manage_signatures');
        if (req.status !== 'pending') {
          throw new ConflictException({ error: { code: 'signature_request_not_pending' } });
        }

        // Re-mint a fresh token for the SAME request (new jti + new expiry).
        const { token, jti, expiresAt } = this.tokenService.sign({
          sub: req.id,
          orgId: user.orgId,
          documentId: req.documentId,
          ownerId: req.ownerId,
        });
        // Atomic refresh — only if STILL pending (race vs a concurrent sign/cancel).
        const [row] = await tx
          .update(signatureRequests)
          .set({ jti, expiresAt })
          .where(and(eq(signatureRequests.id, id), eq(signatureRequests.status, 'pending')))
          .returning();
        if (!row) {
          throw new ConflictException({ error: { code: 'signature_request_not_pending' } });
        }

        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'signature_request.resend',
          targetTable: 'signature_requests',
          targetId: id,
          sessionId: user.sid,
        });

        const own = await this.loadOwnerWithPii(tx, req.ownerId);
        const doc = await this.loadVisibleDocument(tx, req.documentId);
        const from = await this.resolveFromForOrg(tx, user.orgId);
        return {
          row,
          token,
          documentName: doc.name,
          ownerName: own.name,
          ownerEmail: own.email,
          ownerPhone: own.phonePlain,
          from,
        };
      },
      { userId: user.sub },
    );

    const signUrl = `${PUBLIC_APP_URL}/sign/${txOut.token}`;
    const delivery = await deliverSignatureLink(
      this.email,
      this.sms,
      {
        signUrl,
        ownerName: txOut.ownerName,
        ownerEmail: txOut.ownerEmail,
        ownerPhone: txOut.ownerPhone,
        documentName: txOut.documentName,
      },
      { error: (m): void => this.logger.error(m) },
      txOut.from,
    );

    return { request: this.toWire(txOut.row), signUrl, delivery };
  }

  /** Retrieve the signing link for a PENDING request — the phone-less-owner
   *  path (P4). An owner with NO phone can't be SMS'd the link and can't
   *  self-serve the SMS-OTP portal, so the manager copies this link and
   *  delivers it OUT-OF-BAND (WhatsApp / email / paper). Returns ONLY
   *  { request, signUrl } — NO delivery I/O (this is a read-with-side-effect,
   *  not a send).
   *
   *  Single-source-of-truth: the original JWT is never stored (only its `jti`),
   *  so it can't be reconstructed. We re-mint a fresh token + new 7-day expiry
   *  and atomically swap the row's jti/expiresAt WHERE still pending — exactly
   *  like resend(), minus the email/SMS send. The prior link dies; the DB row's
   *  jti remains the one live credential. Only a `pending` request yields a
   *  link (a signed/cancelled one 409s — there's nothing to deliver).
   *
   *  AUTHZ — the signUrl is a BEARER credential, so this MUST match the send
   *  path: coarse `signature_requests.send` (controller) + fine
   *  manage_signatures capability + agent document-visibility (here). A Viewer
   *  / unprivileged Agent is rejected before the token is minted. Returning the
   *  link to an authorized manager does not widen exposure — that same manager
   *  can already resend() it via SMS/email. The token is NEVER logged. */
  async getLink(user: AccessTokenPayload, id: string): Promise<SignatureRequestLinkResponse> {
    const txOut = await withTenant(
      user.orgId,
      async (tx) => {
        const [req] = await tx
          .select({
            id: signatureRequests.id,
            documentId: signatureRequests.documentId,
            ownerId: signatureRequests.ownerId,
            status: signatureRequests.status,
          })
          .from(signatureRequests)
          .where(eq(signatureRequests.id, id))
          .limit(1);
        if (!req) throw NOT_FOUND;
        // D.46 — agent: the signature's document must be in an assigned project
        // (404), then the manage_signatures capability (403). Manager passes
        // both. Gate BEFORE minting so a rejected actor never receives a token.
        if (user.role === 'agent') await this.assertDocVisibleForAgent(tx, user, req.documentId);
        await requireAgentCapability(tx, user, 'manage_signatures');
        if (req.status !== 'pending') {
          throw new ConflictException({ error: { code: 'signature_request_not_pending' } });
        }

        // Re-mint a fresh token for the SAME request (new jti + new expiry).
        const { token, jti, expiresAt } = this.tokenService.sign({
          sub: req.id,
          orgId: user.orgId,
          documentId: req.documentId,
          ownerId: req.ownerId,
        });
        // Atomic refresh — only if STILL pending (race vs concurrent sign/cancel).
        const [row] = await tx
          .update(signatureRequests)
          .set({ jti, expiresAt })
          .where(and(eq(signatureRequests.id, id), eq(signatureRequests.status, 'pending')))
          .returning();
        if (!row) {
          throw new ConflictException({ error: { code: 'signature_request_not_pending' } });
        }

        // Audit the link RETRIEVAL distinctly from resend — a manager copying
        // the bearer link for out-of-band delivery is a security-relevant event
        // (who pulled the credential, when) even though no SMS/email was sent.
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'signature_request.link_retrieve',
          targetTable: 'signature_requests',
          targetId: id,
          sessionId: user.sid,
        });

        return { row, token };
      },
      { userId: user.sub },
    );

    // signUrl embeds the freshly-minted JWT — the manager's out-of-band payload.
    // NEVER logged (no logger call references it).
    return {
      request: this.toWire(txOut.row),
      signUrl: `${PUBLIC_APP_URL}/sign/${txOut.token}`,
    };
  }

  /** Resident self-resend (B-RESIDENT-1) — a logged-in apartment owner (tenant
   *  tier) re-sends THEIR OWN pending signing link to their on-file phone/email
   *  when they lost or expired it (the portal's only write path). OWN-RECORD
   *  scoped: the request must belong to this owner AND be pending, else a
   *  no-oracle 404. Re-mints a fresh token + a new 7-day expiry (old link dies,
   *  clock restarts) and delivers. Returns ONLY the per-channel delivery STATUS —
   *  the token/link is delivered out-of-band (SMS/email) and is NEVER in the
   *  response, so the token-bearing WhatsApp deep-link is stripped. */
  async resendForOwner(
    orgId: string,
    ownerId: string,
    requestId: string,
    ctx?: { ip?: string; userAgent?: string },
  ): Promise<SignatureDeliveryReport> {
    const txOut = await withTenant(orgId, async (tx) => {
      const [req] = await tx
        .select({
          id: signatureRequests.id,
          documentId: signatureRequests.documentId,
          status: signatureRequests.status,
        })
        .from(signatureRequests)
        .where(and(eq(signatureRequests.id, requestId), eq(signatureRequests.ownerId, ownerId)))
        .limit(1);
      // No-oracle: not-found / not-this-owner's / not-pending all → 404.
      if (!req || req.status !== 'pending') throw NOT_FOUND;

      const { token, jti, expiresAt } = this.tokenService.sign({
        sub: req.id,
        orgId,
        documentId: req.documentId,
        ownerId,
      });
      const [row] = await tx
        .update(signatureRequests)
        .set({ jti, expiresAt })
        .where(
          and(
            eq(signatureRequests.id, requestId),
            eq(signatureRequests.ownerId, ownerId),
            eq(signatureRequests.status, 'pending'),
          ),
        )
        .returning({ id: signatureRequests.id });
      if (!row) throw NOT_FOUND;

      await new AuditService(tx, { ip: ctx?.ip, userAgent: ctx?.userAgent }).log({
        orgId,
        actorType: 'system',
        action: 'signature_request.resend_by_owner',
        targetTable: 'signature_requests',
        targetId: requestId,
        // No 'tenant' ActorType exists (a new one is Gate-6), so attribute the
        // authenticated owner here so an abusive resend is traceable to them
        // (sec-review LOW). ownerId is a UUID — not PII.
        afterState: { resent_by_owner: ownerId },
      });

      const own = await this.loadOwnerWithPii(tx, ownerId);
      const doc = await this.loadVisibleDocument(tx, req.documentId);
      const from = await this.resolveFromForOrg(tx, orgId);
      return {
        token,
        documentName: doc.name,
        ownerName: own.name,
        ownerEmail: own.email,
        ownerPhone: own.phonePlain,
        from,
      };
    });

    const delivery = await deliverSignatureLink(
      this.email,
      this.sms,
      {
        signUrl: `${PUBLIC_APP_URL}/sign/${txOut.token}`,
        ownerName: txOut.ownerName,
        ownerEmail: txOut.ownerEmail,
        ownerPhone: txOut.ownerPhone,
        documentName: txOut.documentName,
      },
      { error: (m): void => this.logger.error(m) },
      txOut.from,
    );
    // Strip the token-bearing WhatsApp deep-link — the resident receives the
    // link out-of-band (SMS/email), never as a credential in the HTTP response.
    return { ...delivery, whatsapp: { available: false, reason: 'delivered_out_of_band' } };
  }

  /** Load owner + decrypt phone for delivery. Email is plaintext citext;
   *  phone is pgcrypto-encrypted (D.19) and must be decrypted via
   *  pgp_sym_decrypt while the app.encryption_key GUC is set (i.e.
   *  INSIDE withTenant). Returns plain phone string the delivery layer
   *  will format into the wa.me URL.
   *
   *  v8.5 P0 FIX (Audit Perf F1+F2 — concrete bug, single-agent):
   *    Pre-v8.5 this did 3 sequential round-trips per signature-request
   *    create:
   *      1. SELECT … FROM owners
   *      2. SELECT pgp_sym_decrypt(name_encrypted, $key)
   *      3. SELECT pgp_sym_decrypt(phone_encrypted, $key)
   *    Each round-trip is ~30–50ms against Neon's pooler from the same
   *    region → 90–150ms of pure pgcrypto latency on the critical-path
   *    Manager UX (signature send). Multiplied by bulk sends (FE will
   *    fan-out from a list view) this is the dominant tail.
   *
   *  v8.5 fix: collapse all three into ONE round-trip using a single
   *    SELECT that returns the already-decrypted plaintext columns,
   *    using CASE WHEN for the optional phone. Net latency: ~30–50ms.
   *
   *  Failure semantics: if pgcrypto throws (key drift, ciphertext
   *    corruption) the whole query throws — same as the pre-v8.5
   *    name-decrypt path (which already failed loud). The pre-v8.5
   *    "silently swallow phone decrypt error" was a UX nicety that's
   *    deliberately retired: if phone bytes are unreadable we have a
   *    real data-corruption incident and crashing the create lets
   *    SRE see it (Sentry) — beats a wa.me link that silently never
   *    sends. */
  private async loadOwnerWithPii(
    tx: TenantTx,
    ownerId: string,
  ): Promise<{
    id: string;
    name: string;
    email: string | null;
    phonePlain: string | null;
    archivedAt: Date | null;
  }> {
    const encKey = serverEnv.PII_ENCRYPTION_KEY;
    if (!encKey) {
      // Audit C-1 fix — was: raw Error → 500 with code:"500", indistinguishable
      // from a genuine internal bug. Now: 503 with stable D.16 code so the FE
      // can render an actionable "service unavailable" banner and ops monitoring
      // can alert on encryption-config drift specifically. Pattern mirrors
      // public-sign.service.ts:218 (encryption_not_configured).
      throw new ServiceUnavailableException({
        error: { code: 'encryption_not_configured' },
      });
    }

    // One round-trip: SELECT + name decrypt + (optional) phone decrypt.
    // `archived_at`/`email` come back as-is. Decrypts happen server-
    // side; we never ship ciphertext to Node when we can decrypt in-SQL.
    const result = await tx.execute<{
      id: string;
      name: string;
      email: string | null;
      phone_plain: string | null;
      archived_at: Date | null;
    }>(sql`
      SELECT
        ${owners.id} AS id,
        pgp_sym_decrypt(${owners.nameEncrypted}, ${encKey}) AS name,
        ${owners.email} AS email,
        CASE
          WHEN ${owners.phoneEncrypted} IS NOT NULL
          THEN pgp_sym_decrypt(${owners.phoneEncrypted}, ${encKey})
          ELSE NULL
        END AS phone_plain,
        ${owners.archivedAt} AS archived_at
      FROM ${owners}
      WHERE ${owners.id} = ${ownerId}
      LIMIT 1
    `);
    const row = result.rows[0];
    if (!row || row.archived_at) throw NOT_FOUND;

    return {
      id: row.id,
      name: row.name,
      email: row.email,
      phonePlain: row.phone_plain,
      archivedAt: row.archived_at,
    };
  }

  /** P6 — resolve this org's outbound From: the verified system address with
   *  the org's `branding.senderName` as the display name (or the system default
   *  From when the org keeps the default / on a settings-read failure). Built
   *  ONLY via `buildEmailFrom` — single source for header-safe From assembly;
   *  this service never hand-rolls a From string. Resolved INSIDE the caller's
   *  tenant tx (so `organizations.settings` is RLS-scoped). Best-effort: a read
   *  failure must NOT break delivery / the manager's request — fall back to
   *  `DEFAULT_EMAIL_FROM`. (`getOrgSettings` is itself fail-soft; the try/catch
   *  is belt-and-suspenders, matching the #306 calendar-email pattern.) */
  private async resolveFromForOrg(tx: TenantTx, orgId: string): Promise<string> {
    try {
      const settings = await getOrgSettings(tx, orgId);
      return buildEmailFrom(settings.branding.senderName, DEFAULT_EMAIL_FROM);
    } catch (err) {
      this.logger.warn(
        `org-settings read failed for From display-name (org=${orgId}); using default From: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return DEFAULT_EMAIL_FROM;
    }
  }

  /** GET /signature-requests — Manager+Viewer see all in org; Agent sees
   *  only requests on documents whose parent project is an active
   *  assignment (record-scoping mirrors documents.list per audit-pass V
   *  #2). Keyset pagination, optional status/document/owner filters. */
  async list(
    user: AccessTokenPayload,
    query: ListSignatureRequestsQueryDto,
  ): Promise<SignatureRequestListPage> {
    const { limit } = query;
    const cur = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cur) {
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }

    const rows = await withTenant(
      user.orgId,
      async (tx) => {
        const filters: (SQL | undefined)[] = [];
        if (query.status) filters.push(eq(signatureRequests.status, query.status));
        if (query.documentId) filters.push(eq(signatureRequests.documentId, query.documentId));
        if (query.ownerId) filters.push(eq(signatureRequests.ownerId, query.ownerId));

        // Agent record-scoping via the underlying document. Same shape
        // as documents.service.list (audit-pass V #2): two EXISTS
        // subqueries bound to SQL, no app-side materialisation.
        if (user.role === 'agent') {
          const directProjectAssigned = sql<boolean>`EXISTS (
            SELECT 1
            FROM documents d
            JOIN project_assignments pa ON pa.project_id = d.project_id
            WHERE d.id = ${signatureRequests.documentId}
              AND pa.user_id = ${user.sub}::uuid
              AND pa.unassigned_at IS NULL
          )`;
          const viaApartment = sql<boolean>`EXISTS (
            SELECT 1
            FROM documents d
            JOIN apartments a ON a.id = d.apartment_id
            JOIN buildings b ON b.id = a.building_id
            JOIN project_assignments pa ON pa.project_id = b.project_id
            WHERE d.id = ${signatureRequests.documentId}
              AND pa.user_id = ${user.sub}::uuid
              AND pa.unassigned_at IS NULL
          )`;
          filters.push(or(directProjectAssigned, viaApartment));
        }

        const keyset: SQL | undefined = cur
          ? keysetCondition(signatureRequests.createdAt, signatureRequests.id, cur)
          : undefined;

        return tx
          .select()
          .from(signatureRequests)
          .where(and(...filters, keyset))
          .orderBy(...keysetOrderBy(signatureRequests.createdAt, signatureRequests.id))
          .limit(limit + 1);
      },
      { userId: user.sub },
    );

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map((r) => this.toWire(r)),
      page: {
        limit,
        cursor: hasMore && last ? encodeCursor(last) : null,
        has_more: hasMore,
      },
    };
  }

  /** GET /signature-requests/:id — single row.
   *  Agent record-scoping enforced via the underlying document
   *  (same as list). Foreign / unknown id → no-oracle 404. */
  async get(user: AccessTokenPayload, id: string): Promise<SignatureRequest> {
    const row = await withTenant(
      user.orgId,
      async (tx) => {
        const [r] = await tx
          .select()
          .from(signatureRequests)
          .where(eq(signatureRequests.id, id))
          .limit(1);
        if (!r) throw NOT_FOUND;
        // For agents, validate document visibility (same shape as
        // documents.service.assertDocVisibleForAgent — copied here to
        // avoid an import cycle).
        if (user.role === 'agent') {
          await this.assertDocVisibleForAgent(tx, user, r.documentId);
        }
        return r;
      },
      { userId: user.sub },
    );
    return this.toWire(row);
  }

  /** POST /signature-requests/:id/cancel — Manager-only state transition
   *  pending → cancelled. Idempotent on a cancelled row (returns the
   *  current state). Signed rows return 409 (cannot un-sign forensic
   *  evidence). */
  async cancel(user: AccessTokenPayload, id: string): Promise<SignatureRequest> {
    const row = await withTenant(
      user.orgId,
      async (tx) => {
        const [existing] = await tx
          .select()
          .from(signatureRequests)
          .where(eq(signatureRequests.id, id))
          .limit(1);
        if (!existing) throw NOT_FOUND;
        // D.46 — agent: the signature's document must be in an assigned project
        // (404), then the manage_signatures capability (403). Manager passes.
        if (user.role === 'agent')
          await this.assertDocVisibleForAgent(tx, user, existing.documentId);
        await requireAgentCapability(tx, user, 'manage_signatures');

        if (existing.status === 'cancelled') {
          // Idempotent cancel — return the existing row, no new audit
          // (the original cancel already recorded who/when).
          return existing;
        }
        if (existing.status === 'signed') {
          throw new ConflictException({
            error: { code: 'signature_request_already_signed' },
          });
        }

        // Atomic guard: only cancel if still pending. Defends against
        // a race where a resident signs between our SELECT and UPDATE.
        const [updated] = await tx
          .update(signatureRequests)
          .set({
            status: 'cancelled',
            cancelledAt: sql`now()`,
            cancelledBy: user.sub,
          })
          .where(and(eq(signatureRequests.id, id), eq(signatureRequests.status, 'pending')))
          .returning();
        if (!updated) {
          // Race lost — someone signed it. Same 409 as above.
          throw new ConflictException({
            error: { code: 'signature_request_already_signed' },
          });
        }

        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'signature_request.cancel',
          targetTable: 'signature_requests',
          targetId: updated.id,
          sessionId: user.sid,
        });
        return updated;
      },
      { userId: user.sub },
    );
    // A cancel drops a pending request from the counts (idempotent re-cancel is
    // a harmless extra bump). Invalidate the org's stats.
    await this.invalidateStats(user.orgId);
    return this.toWire(row);
  }

  /** Agent-only visibility helper for `get()`. Same shape as
   *  documents.service.assertDocVisibleForAgent — local copy to avoid
   *  cross-module coupling. */
  private async assertDocVisibleForAgent(
    tx: TenantTx,
    user: AccessTokenPayload,
    documentId: string,
  ): Promise<void> {
    const [row] = await tx
      .select({
        id: documents.id,
        projectId: documents.projectId,
        apartmentId: documents.apartmentId,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    if (!row) throw NOT_FOUND;

    const directProjectAssigned = sql<boolean>`EXISTS (
      SELECT 1 FROM project_assignments pa
      WHERE pa.user_id = ${user.sub}::uuid
        AND pa.unassigned_at IS NULL
        AND pa.project_id = ${row.projectId}
    )`;
    const viaApartment = sql<boolean>`EXISTS (
      SELECT 1 FROM apartments a
      JOIN buildings b ON b.id = a.building_id
      JOIN project_assignments pa ON pa.project_id = b.project_id
      WHERE pa.user_id = ${user.sub}::uuid
        AND pa.unassigned_at IS NULL
        AND a.id = ${row.apartmentId}
    )`;
    const [visible] = await tx
      .select({ ok: sql<boolean>`(${or(directProjectAssigned, viaApartment)})` })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    if (!visible?.ok) throw NOT_FOUND;
  }

  /** DB row → wire shape. `jti` is the atomic single-use key — NEVER
   *  exposed. */
  private toWire(r: typeof signatureRequests.$inferSelect): SignatureRequest {
    return {
      id: r.id,
      organizationId: r.orgId,
      documentId: r.documentId,
      ownerId: r.ownerId,
      status: r.status as SignatureRequest['status'],
      expiresAt: r.expiresAt,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      signedAt: r.signedAt,
      signedSignatureId: r.signedSignatureId,
      cancelledAt: r.cancelledAt,
      cancelledBy: r.cancelledBy,
    };
  }
}
