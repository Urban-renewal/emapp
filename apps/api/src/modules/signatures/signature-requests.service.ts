import { randomUUID } from 'node:crypto';

import { serverEnv } from '@emapp/config';
import {
  AuditService,
  DEFAULT_EMAIL_FROM,
  apartments,
  buildEmailFrom,
  buildings,
  documents,
  governOutboundSend,
  owners,
  ownerships,
  projectAssignments,
  projects,
  signatureRequests,
  withTenant,
  type GovernedSendOutcome,
  type IEmailProvider,
  type ISMSProvider,
  type TenantTx,
} from '@emapp/db';
import { DEFAULT_OUTBOUND_GATES, QuietHoursGate, type OutboundGate } from '@emapp/jobs';
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
  RemindPendingResponse,
  ListSignatureRequestsQueryDto,
  ProposalApplyDelivery,
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
import { notificationLink } from '../notifications/notification-links';
import { resolveNotificationRecipients } from '../notifications/notification-recipients';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';
import { StatsCacheService } from '../projects/stats-cache.service';

import { deliverSignatureLink } from './signature-link-delivery';
import { SignatureTokenService } from './signature-token.service';

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });

/** Manager-side list page envelope (D.16 + keyset pagination). */
export interface SignatureRequestListPage {
  data: SignatureRequest[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

/** Everything the post-tx delivery step needs for ONE re-minted request. The
 *  `signUrl` carries the fresh token (the only place it appears); the owner PII
 *  (name/email/phone) is held in-memory only for the immediate send and never
 *  logged. Produced inside the tenant tx by `resendOneInTx`, consumed outside it
 *  by `deliverResendPayload`. */
interface ResendDeliveryPayload {
  row: typeof signatureRequests.$inferSelect;
  signUrl: string;
  documentName: string;
  ownerName: string;
  ownerEmail: string | null;
  ownerPhone: string | null;
  from: string;
}

/** Did at least one delivery channel actually go out? email/sms sent|queued, or
 *  a whatsapp deep-link became ready. Drives the HB-1 `reminded` tally — a
 *  request whose every channel was unavailable (no email + no phone) is re-minted
 *  but NOT counted as reminded. */
function didAnyChannelDeliver(d: SignatureDeliveryReport): boolean {
  const went = (c: { available: boolean; status?: string }): boolean =>
    c.available && (c.status === 'sent' || c.status === 'queued' || c.status === 'ready');
  return went(d.email) || went(d.sms) || went(d.whatsapp);
}

/**
 * The `cadenceStep` for a REISSUE-on-approve send (must be >= 0 — the
 * `outbound_ledger_cadence_step_nonneg` CHECK). The OutboundGovernor's M1
 * idempotency key is `recipientRef:cadenceStep`.
 *
 * EXACTLY-ONCE FOR REISSUE: the uniqueness comes ENTIRELY from `recipientRef`,
 * which we set to the PROPOSAL id (NOT the signature_request id). Two consequences:
 *   - NO COLLISION WITH CADENCE: a `reminder.send` keys on
 *     `recipientRef = signatureRequestId`; a proposalId is a DIFFERENT UUID, so the
 *     two namespaces never share a key — the cadenceStep value here is irrelevant
 *     to cadence dedup, and `0` is the safe CHECK-satisfying constant.
 *   - PER-APPROVAL UNIT: each reissue approval is its own proposal → its own key →
 *     it delivers; a retried in-flight approve re-enters with the SAME proposalId →
 *     the UNIQUE claim collides → `already_sent` (NO second send). A re-approve of
 *     the same proposal is impossible (the state machine flips it to `applied`).
 * (Contrast the cadence case, where proposalId is DELIBERATELY OUT of the key so a
 * re-proposal of the SAME recipient+step collides — there the exactly-once unit is
 * recipient+step; here it is the approval, so the proposal id IS the discriminator.)
 */
const REISSUE_SEND_CADENCE_STEP = 0;

/**
 * The gate pipeline for a REISSUE-on-approve send: the DEFAULT outbound gates
 * (kill-switch · consent · breaker · rate-ceiling) MINUS QuietHoursGate.
 *
 * WHY quiet-hours-EXEMPT: a reissue is an EXPLICIT, on-demand human re-contact
 * (the manager just approved "re-send this owner their renewed link"), exactly
 * like the manual `resend` — which has NO outbound gating at all. Deferring it to
 * 08:00 would silently re-create the very "owner doesn't get the link" gap this
 * fix closes (nothing re-drives a quiet-hours-parked reissue), so the human's
 * approve sends NOW. The hard protections (kill-switch off, consent withdrawn,
 * breaker tripped, per-recipient/org ceilings) STILL apply. Derived by FILTERING
 * the default list by reference (not re-listing it), so any future gate added to
 * DEFAULT is automatically included here too — only quiet-hours is dropped.
 */
const REISSUE_SEND_GATES: readonly OutboundGate[] = DEFAULT_OUTBOUND_GATES.filter(
  (g) => g !== QuietHoursGate,
);

/**
 * Reason strings that denote a channel was simply NOT ATTEMPTED (no recipient on
 * file / phone unparseable). Nothing went out on such a channel, so on its own it
 * is a DEFINITE non-send. Kept as an explicit set so the classifier is an
 * ALLOWLIST, not a fall-through (re-red-team #509).
 */
const NOT_ATTEMPTED_REASONS = new Set([
  'no_email_on_file',
  'no_phone_on_file',
  'no_phone_on_file_or_unparseable',
  'no_channel_available',
]);

/**
 * Is this channel reason a KNOWN-STRUCTURAL decline? — the gateway received the
 * call and explicitly refused the message (invalid number / bad creds). A true
 * non-send → contributes to DEFINITE. Reserved ENDINGS: `_rejected` / `_declined`.
 */
function isStructuralDecline(reason: string): boolean {
  return reason.endsWith('_rejected') || reason.endsWith('_declined');
}

/**
 * Classify a NON-delivery for the OutboundGovernor's definite-vs-ambiguous axis
 * (#506 H1, re-hardened by the #509 re-red-team). Called ONLY when
 * `didAnyChannelDeliver` is false.
 *
 * THE EXACTLY-ONCE INVARIANT: this maps to `failed` (RE-CLAIMABLE → re-sent on the
 * next approve) ONLY for a provably-did-not-send case. Anything that MIGHT have
 * dispatched maps to `ambiguous` (parked, never auto-resent). A real SMS is money;
 * a false `definite` is a DOUBLE-SEND.
 *
 * The delivery layer encodes each channel's outcome in its `reason`:
 *   - `*_rejected` / `*_declined` → STRUCTURAL decline (gateway refused the
 *                        message on a successful HTTP call / a 4xx client error).
 *                        Provably did NOT go out → DEFINITE.
 *   - `*_send_failed` / `*_ambiguous` → TRANSPORT failure (throw / 5xx / timeout /
 *                        unparseable body). MAY have gone out → AMBIGUOUS.
 *   - not-attempted (`no_*_on_file`, …) → nothing went out on that channel.
 *
 * FAIL-SAFE ALLOWLIST (the #509 fix): the whole attempt is `definite` ONLY when
 * EVERY non-delivering channel is EITHER a known-structural decline OR a
 * not-attempted channel — and there was nothing transport-ambiguous. ANY
 * transport-ambiguous channel, OR ANY reason we do NOT positively recognize as
 * structural/not-attempted, forces `ambiguous`. We never *infer* definite from the
 * absence of a known-ambiguous marker; we require positive proof of a non-send.
 */
export function classifyNonDelivery(d: SignatureDeliveryReport): {
  failureKind: 'definite' | 'ambiguous';
  failureCode: string;
} {
  const channels = [d.email, d.sms, d.whatsapp];
  // Only channels that actually failed to deliver carry a `reason` here (a
  // delivered channel is excluded by the `didAnyChannelDeliver` precondition).
  const reasons = channels.map((c) => c.reason ?? '').filter((r) => r.length > 0);

  // (1) ANY transport-ambiguous channel → the whole attempt is AMBIGUOUS. This is
  // the SAFE short-circuit: something may have gone out, so never auto-resend.
  const anyAmbiguous = reasons.some((r) => r.endsWith('_send_failed') || r.endsWith('_ambiguous'));
  if (anyAmbiguous) {
    return { failureKind: 'ambiguous', failureCode: 'provider_send_failed' };
  }

  // (2) DEFINITE requires POSITIVE proof for EVERY non-delivering channel: each
  // must be a known-structural decline OR a recognized not-attempted reason. If a
  // single reason is unrecognized, we cannot prove it was a non-send → AMBIGUOUS
  // (the contract's mandated SAFE default — never *infer* a clean retry).
  const everyReasonProvable = reasons.every(
    (r) => isStructuralDecline(r) || NOT_ATTEMPTED_REASONS.has(r),
  );
  if (!everyReasonProvable) {
    return { failureKind: 'ambiguous', failureCode: 'provider_unknown' };
  }

  const anyStructural = reasons.some((r) => isStructuralDecline(r));
  if (anyStructural) {
    return { failureKind: 'definite', failureCode: 'provider_rejected' };
  }
  // Every channel was simply not-on-file / unavailable — nothing was attempted, so
  // nothing went out: a DEFINITE non-send, re-claimable once a channel resolves.
  return { failureKind: 'definite', failureCode: 'no_channel_available' };
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
    // In-app notification PRODUCER — the LEGIBILITY signal for autonomy acts that
    // contact someone (reissue re-delivers a renewed signing link, so the manager
    // must see "owner re-notified", not a vanished card). OPTIONAL so specs that
    // `new SignatureRequestsService(...)` without it still construct (the emit is
    // best-effort and self-guards; a missing producer is a silent no-op).
    @Optional() private readonly notifications?: NotificationsProducerService,
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

        // (1c) Global campaign-send kill-switch (E2 Wave-0 N15). Authorization
        // resolves FIRST (above) so an unauthorized caller still gets 403 and
        // never learns the switch state. OPT-OUT: enabled unless explicitly
        // '0'/'false'. This is the LAST gate before the actual fan-out send.
        const sendFlag = serverEnv.CAMPAIGN_SEND_ENABLED;
        if (sendFlag === '0' || sendFlag === 'false') {
          throw new ServiceUnavailableException({ error: { code: 'campaign_send_disabled' } });
        }

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
        // Single-request resend MUST surface a lost-race as a 409 (the caller
        // targeted ONE id; "nothing to do" is an error). The project-scoped
        // remind path passes `throwIfNotPending: false` so a concurrently-signed
        // row is silently skipped instead of failing the whole fan-out.
        const payload = await this.resendOneInTx(tx, user, req, { throwIfNotPending: true });
        if (!payload)
          throw new ConflictException({ error: { code: 'signature_request_not_pending' } });
        return payload;
      },
      { userId: user.sub },
    );

    const delivery = await this.deliverResendPayload(txOut);
    return { request: this.toWire(txOut.row), signUrl: txOut.signUrl, delivery };
  }

  /** HB-1 — one-tap project-scoped "chase the stuck pending signers". DERIVES
   *  every LIVE PENDING signature request of the project (status='pending' AND
   *  expires_at > now(), joined ownership → apartment → building → project = :id),
   *  re-mints a fresh token + 7-day expiry for each (REUSING `resendOneInTx`), and
   *  re-delivers it. The client supplies NO ownerIds and NO documentId — the
   *  recipient scope is computed SERVER-SIDE and is PENDING-ONLY: a signed owner
   *  is never re-spammed, and an expired request is excluded (the manager
   *  re-issues those via the normal create/campaign path).
   *
   *  AUTHZ then KILL-SWITCH (no oracle): project-visibility (RLS + agent active
   *  assignment → no-oracle 404), then `manage_signatures` (403), then — only
   *  AFTER authorization resolves — the N15 send kill-switch (503
   *  `campaign_send_disabled`). An unauthorized caller is rejected before it can
   *  learn the switch state. Delivery I/O runs OUTSIDE the tx; a per-request
   *  delivery failure is logged (no PII) and counted out of `reminded`, never
   *  aborting the rest. */
  async remindProjectPending(
    user: AccessTokenPayload,
    projectId: string,
  ): Promise<RemindPendingResponse> {
    const txOut = await withTenant(
      user.orgId,
      async (tx) => {
        // (1) Project-visibility gate — mirrors createCampaign / projects.get():
        // RLS org-isolation for everyone, PLUS an active-assignment join for
        // agents. Not visible → no row → no-oracle 404 (cross-org and
        // unassigned-agent are indistinguishable).
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

        // (1b) Agent-capability gate — a remind is a signature WRITE (re-mint +
        // re-deliver), so an agent needs `manage_signatures` (Manager passes).
        // The explicit defense-in-depth the D.54 fail-open guard requires for an
        // agent-loosened write endpoint.
        await requireAgentCapability(tx, user, 'manage_signatures');

        // (1c) Global send kill-switch (E2 Wave-0 N15) — LAST gate, strictly
        // AFTER authorization so an unauthorized caller never learns the switch
        // state (no oracle). OPT-OUT: enabled unless explicitly '0'/'false'.
        const sendFlag = serverEnv.CAMPAIGN_SEND_ENABLED;
        if (sendFlag === '0' || sendFlag === 'false') {
          throw new ServiceUnavailableException({ error: { code: 'campaign_send_disabled' } });
        }

        // (2) Derive every LIVE PENDING request of THIS project: pending request
        // → its owner's active ownership → non-archived apartment → building →
        // project = :id. status='pending' AND expires_at > now() is the LIVE
        // filter (a row past expiry — even if not yet swept to 'expired' — is
        // excluded: chasing it would re-mint a fresh link the resident already
        // can't trust; that's a create/campaign decision, not a remind). DISTINCT
        // on the request id so an owner who happens to hold two ownership rows in
        // the project isn't double-counted. RLS scopes every table to the org.
        const livePending = await tx
          .selectDistinct({
            id: signatureRequests.id,
            documentId: signatureRequests.documentId,
            ownerId: signatureRequests.ownerId,
            status: signatureRequests.status,
          })
          .from(signatureRequests)
          .innerJoin(ownerships, eq(ownerships.ownerId, signatureRequests.ownerId))
          .innerJoin(apartments, eq(apartments.id, ownerships.apartmentId))
          .innerJoin(buildings, eq(buildings.id, apartments.buildingId))
          .where(
            and(
              eq(buildings.projectId, projectId),
              eq(signatureRequests.status, 'pending'),
              gt(signatureRequests.expiresAt, sql`now()`),
              isNull(ownerships.endedAt),
              eq(ownerships.relationship, 'owner'),
              isNull(apartments.archivedAt),
            ),
          );

        // (3) Re-mint + swap + audit + load PII for each, INSIDE the same tx, via
        // the SAME per-request resend core. A row that lost the pending race
        // between the SELECT and the swap is skipped (payload === null) — it
        // signed/cancelled concurrently and must NOT be re-chased.
        const payloads: ResendDeliveryPayload[] = [];
        for (const req of livePending) {
          const payload = await this.resendOneInTx(tx, user, req, { throwIfNotPending: false });
          if (payload) payloads.push(payload);
        }
        return { total: livePending.length, payloads };
      },
      { userId: user.sub },
    );

    // (4) Deliver OUTSIDE the tx — a slow/failing email or SMS must never hold a
    // DB transaction open. A per-request failure is logged (NO PII) and counted
    // out of `reminded`; the rest still go out.
    let reminded = 0;
    for (const payload of txOut.payloads) {
      try {
        const delivery = await this.deliverResendPayload(payload);
        // A request counts as "reminded" when at least one channel actually went
        // out: email sent/queued, sms sent/queued, or a whatsapp deep-link
        // returned for the manager to tap (mirrors the bulk path's outcome
        // semantics). The token is ALREADY re-minted regardless — this only
        // tallies the delivery attempt.
        if (didAnyChannelDeliver(delivery)) reminded += 1;
      } catch {
        // Delivery threw — the row was already re-minted (link refreshed); the
        // manager can retry the single request. Never log the owner's PII.
        this.logger.error(`remindProjectPending: delivery failed for request ${payload.row.id}`);
      }
    }

    return { reminded, total: txOut.total };
  }

  /**
   * GOVERNED reminder send — the autonomy Phase-2 executor's gated target
   * (Autonomous Master Plan, Phase 2; the first GOVERNED-OUTBOUND exemplar).
   *
   * The proposals `reminder.send` executor calls this on APPROVE. It sends ONE
   * reminder for ONE signature request THROUGH the OutboundGovernor:
   *   - the pure GATE PIPELINE (kill-switch · consent · circuit-breaker ·
   *     quiet-hours · rate-ceiling) decides allow/deny/defer;
   *   - the M1 outbound_ledger CLAIMS the deterministic idempotency key
   *     (proposalId + signatureRequestId + cadenceStep) BEFORE sending, so a
   *     double-approve / retry can NEVER double-send (a prior terminal `sent` →
   *     exactly-once no-op replay);
   *   - on `allow` + a fresh claim, the ACTUAL send REUSES the existing gated
   *     `resend(user, id)` verbatim (re-mint fresh link + deliver email/SMS) — the
   *     Governor adds governance + exactly-once AROUND it, never duplicating the
   *     send logic.
   *
   * The kill-switch is resolved here from `CAMPAIGN_SEND_ENABLED` (OPT-OUT:
   * enabled unless '0'/'false') and handed to the gate — the gate is the single
   * authoritative kill-switch check on this path (`resend` itself does not gate on
   * it). Consent defaults to TRUE (there is no per-owner outbound opt-out registry
   * yet — that is a documented seam the ConsentGate already accepts via the
   * resolved snapshot; when the registry lands, resolve it here). The breaker is
   * not yet wired to a live trip-source in Phase 2, so it defaults to NOT tripped;
   * the gate is in the pipeline ready for the breach-loop (Phase 5).
   *
   * Returns the governed outcome; the executor maps a non-`sent` outcome to an
   * exception so the proposal stays pending/actionable (per-item independence,
   * design correction M2 — a bulk approve is never one atomic tx).
   *
   * NOTE on RLS/visibility: `resend(user, id)` runs under ITS OWN
   * withTenant/RLS + agent capability checks, so a stale or out-of-scope proposal
   * cannot drive a send the manager couldn't perform by hand (RE-EVALUATE at
   * execute). The Governor's ledger writes are org-scoped (withTenant). */
  async sendGovernedReminder(
    user: AccessTokenPayload,
    input: { proposalId: string; signatureRequestId: string; cadenceStep: number },
  ): Promise<GovernedSendOutcome> {
    // Resolve the kill-switch (OPT-OUT: enabled unless explicitly disabled).
    const sendFlag = serverEnv.CAMPAIGN_SEND_ENABLED;
    const killSwitchEnabled = sendFlag !== '0' && sendFlag !== 'false';

    return governOutboundSend({
      orgId: user.orgId,
      proposalId: input.proposalId,
      // Email is the primary reminder channel; the ledger key + rate bucket use
      // it. The actual fan-out (email AND/OR sms) happens inside `resend`.
      channel: 'email',
      recipientRef: input.signatureRequestId,
      cadenceStep: input.cadenceStep,
      // Consent default — the documented seam for a future per-owner opt-out
      // registry. ConsentGate denies when this is false.
      recipientConsented: true,
      killSwitchEnabled,
      // No live breaker trip-source in Phase 2 — the gate is wired, ready.
      breakerTripped: false,
      now: new Date(),
      // The ACTUAL send REUSES the existing gated resend verbatim. A non-pending
      // request (signed/cancelled concurrently) throws ConflictException out of
      // `resend`, which the Governor catches → settles the ledger AMBIGUOUS
      // (parked `pending_send`, never auto-resent). On a returned non-delivery we
      // CLASSIFY (definite vs ambiguous) so the Governor knows whether the failed
      // ledger row is re-claimable (#506 H1). A delivered send is `sent`.
      send: async () => {
        const res = await this.resend(user, input.signatureRequestId);
        if (didAnyChannelDeliver(res.delivery)) {
          return { delivered: true, providerMessageId: res.request.id };
        }
        const { failureKind, failureCode } = classifyNonDelivery(res.delivery);
        return { delivered: false, failureKind, failureCode };
      },
    });
  }

  /** Per-request resend CORE (HB-1 factor of `resend`). Inside an open tenant tx:
   *  re-mint a fresh token (new jti + 7-day expiry), atomically swap the row's
   *  jti/expiresAt WHERE STILL pending (race-safe), write the resend audit row
   *  (NO PII — only the request id), and load the owner PII + doc name + from
   *  needed for delivery. Returns the delivery payload, or `null` when the row
   *  lost the pending race (concurrently signed/cancelled) and the caller asked
   *  NOT to throw (`throwIfNotPending: false` — the fan-out remind path skips it).
   *  Assumes the caller has ALREADY enforced visibility + capability. */
  private async resendOneInTx(
    tx: TenantTx,
    user: AccessTokenPayload,
    req: { id: string; documentId: string; ownerId: string },
    opts: { throwIfNotPending: boolean },
  ): Promise<ResendDeliveryPayload | null> {
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
      .where(and(eq(signatureRequests.id, req.id), eq(signatureRequests.status, 'pending')))
      .returning();
    if (!row) {
      if (opts.throwIfNotPending) {
        throw new ConflictException({ error: { code: 'signature_request_not_pending' } });
      }
      return null;
    }

    await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
      orgId: user.orgId,
      actorId: user.sub,
      actorType: 'user',
      action: 'signature_request.resend',
      targetTable: 'signature_requests',
      targetId: req.id,
      sessionId: user.sid,
    });

    const own = await this.loadOwnerWithPii(tx, req.ownerId);
    const doc = await this.loadVisibleDocument(tx, req.documentId);
    const from = await this.resolveFromForOrg(tx, user.orgId);
    return {
      row,
      signUrl: `${PUBLIC_APP_URL}/sign/${token}`,
      documentName: doc.name,
      ownerName: own.name,
      ownerEmail: own.email,
      ownerPhone: own.phonePlain,
      from,
    };
  }

  /** Per-request resend DELIVERY (HB-1 factor of `resend`). Runs OUTSIDE the tx —
   *  the email/SMS/WhatsApp I/O must never hold a DB transaction open. The signUrl
   *  is the only place the fresh token appears; it is NEVER logged. */
  private deliverResendPayload(payload: ResendDeliveryPayload): Promise<SignatureDeliveryReport> {
    return deliverSignatureLink(
      this.email,
      this.sms,
      {
        signUrl: payload.signUrl,
        ownerName: payload.ownerName,
        ownerEmail: payload.ownerEmail,
        ownerPhone: payload.ownerPhone,
        documentName: payload.documentName,
      },
      { error: (m): void => this.logger.error(m) },
      payload.from,
    );
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

  /** Reissue an EXPIRED signature request — the autonomy Phase-1 executor's
   *  gated target (Autonomous Master Plan: expiry → re-issue). Re-mint a fresh
   *  token (new jti + new 7-day expiry) and flip the row `expired` → `pending`,
   *  WITHOUT any email/SMS send. This is the INTERNAL, REVERSIBLE half of the
   *  reissue (the outbound send is Phase 2's cadence loop) — exactly the
   *  `signature_request.reissue` AutonomyPolicy kind (internal + reversible +
   *  non-PII). The prior dead link's jti is overwritten; the new jti is the one
   *  live credential. NO token is returned (no out-of-band delivery here — the
   *  manager re-sends via the existing resend/getLink paths if/when they choose).
   *
   *  AUTHZ — mirrors the send/getLink path: agent document-visibility (404) +
   *  manage_signatures capability (403); manager passes both. The executor only
   *  calls this AFTER re-asserting `classify(kind)` at execute time (the boundary
   *  is re-checked), and the human has APPROVED the proposal — so this is never an
   *  unattended send.
   *
   *  STATE: only an `expired` request is reissuable. A pending/signed/cancelled
   *  request 409s (`signature_request_not_reissuable`) — there is nothing lapsed
   *  to revive (the proposal that targeted it is stale; the executor cleans up). */
  async reissueExpired(user: AccessTokenPayload, id: string): Promise<SignatureRequest> {
    const row = await withTenant(
      user.orgId,
      async (tx) => {
        const [existing] = await tx
          .select({
            id: signatureRequests.id,
            documentId: signatureRequests.documentId,
            ownerId: signatureRequests.ownerId,
            status: signatureRequests.status,
          })
          .from(signatureRequests)
          .where(eq(signatureRequests.id, id))
          .limit(1);
        if (!existing) throw NOT_FOUND;
        // D.46 — agent: document must be in an assigned project (404), then the
        // manage_signatures capability (403). Gate BEFORE minting.
        if (user.role === 'agent')
          await this.assertDocVisibleForAgent(tx, user, existing.documentId);
        await requireAgentCapability(tx, user, 'manage_signatures');

        if (existing.status !== 'expired') {
          throw new ConflictException({
            error: { code: 'signature_request_not_reissuable' },
          });
        }

        // Re-mint a fresh token for the SAME request (new jti + new expiry).
        const { jti, expiresAt } = this.tokenService.sign({
          sub: existing.id,
          orgId: user.orgId,
          documentId: existing.documentId,
          ownerId: existing.ownerId,
        });
        // Atomic refresh — only if STILL expired (race vs a concurrent reissue).
        const [updated] = await tx
          .update(signatureRequests)
          .set({ jti, expiresAt, status: 'pending' })
          .where(and(eq(signatureRequests.id, id), eq(signatureRequests.status, 'expired')))
          .returning();
        if (!updated) {
          throw new ConflictException({
            error: { code: 'signature_request_not_reissuable' },
          });
        }

        // Audit the reissue distinctly. actorType stays 'user' — the human
        // APPROVED it; the proposal id + system origin are recorded in the
        // proposal row + the proposals executor's own audit. NO PII, no token.
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'signature_request.reissue',
          targetTable: 'signature_requests',
          targetId: updated.id,
          sessionId: user.sid,
        });
        return updated;
      },
      { userId: user.sub },
    );
    // Reissue revives a request into the pending pool — invalidate stats.
    await this.invalidateStats(user.orgId);
    return this.toWire(row);
  }

  /**
   * Reissue an EXPIRED request AND re-deliver the renewed signing link to the
   * apartment owner — the autonomy `signature_request.reissue` proposal's APPROVE
   * action (the gap fix). The prior `reissueExpired` ONLY re-minted + flipped
   * expired→pending with NO send, so the owner who must sign received a fresh link
   * they NEVER GOT and the manager saw only a vanished inbox card. This method
   * closes that loop: the owner is ACTUALLY re-contacted, and the OUTCOME is
   * returned (masked channel + recipient) so the inbox shows "renewed + owner
   * re-notified" instead of nothing.
   *
   * TWO BOUNDARY-HONEST HALVES (the autonomy classification keeps them distinct):
   *   1. `reissueExpired(user, signatureRequestId)` — the INTERNAL re-mint
   *      (`signature_request.reissue`: internal · reversible · non-PII · NO send).
   *      Flips expired→pending + audits. Unchanged; reused VERBATIM.
   *   2. A GOVERNED-OUTBOUND send (the `link.reissue.send` class: outbound +
   *      consent) THROUGH `governOutboundSend` — the SAME M1 exactly-once ledger +
   *      gate pipeline the `reminder.send` executor uses. The actual send REUSES
   *      the existing gated `resend(user, id)` (re-mint fresh link + deliver
   *      email/SMS) as the thunk; the Governor adds governance + exactly-once
   *      AROUND it, never duplicating the send. PII (owner name/email/phone) is
   *      held in-memory only inside `resend`'s delivery step and never logged.
   *
   * WHY IMMEDIATE (not deferred-to-cadence): an explicit human APPROVE of a
   * reissue is exactly the `resend` precedent — the manager pressed a button to
   * re-contact this owner NOW. The reminder-cadence producer (#506) only operates
   * on ALREADY-pending requests via SEPARATE `reminder.send` proposals; deferring
   * the reissue's send to it would leave the owner uncontacted until a SECOND,
   * unrelated human approval lands. So delivery happens here, on approve.
   *
   * EXACTLY-ONCE: the Governor's ledger key is `recipientRef:cadenceStep`. We use
   * `recipientRef = proposalId` (each reissue approval is its own send-unit) and a
   * dedicated `REISSUE_SEND_CADENCE_STEP` sentinel that can NEVER collide with a
   * cadence reminder's step. A retried in-flight approve re-enters with the SAME
   * proposalId → the UNIQUE claim collides → `already_sent` (NO second send). A
   * LATER reissue of the same request is a NEW proposal → a new key → it delivers.
   * A re-approve of the same proposal is impossible (the state machine flips it to
   * `applied`). So no double-send from any retry/double-approve path.
   *
   * KILL-SWITCH / CONSENT: resolved here from `CAMPAIGN_SEND_ENABLED` (OPT-OUT)
   * and handed to the gate — the same posture as `sendGovernedReminder`. A
   * kill-switch-off / consent-withdrawn org gets `blocked` (NO send, NO ledger
   * row); the re-mint already happened (reversible) and the manager retries when
   * the condition lifts.
   *
   * NOTIFICATION (legibility): after the send result is known, a best-effort
   * in-app notification fans out to the org's managers + the request's project
   * agents — "owner re-notified" — deep-linked to the document. It NEVER fails the
   * apply (self-guarded producer); a notify failure is logged (no PII) only.
   */
  async reissueAndDeliver(
    user: AccessTokenPayload,
    input: { signatureRequestId: string; proposalId: string },
  ): Promise<{ request: SignatureRequest; delivery: ProposalApplyDelivery }> {
    // (1) INTERNAL re-mint — reuse the existing gated path VERBATIM. It enforces
    // its own withTenant/RLS + agent visibility/capability + the expired-only
    // state guard, audits `signature_request.reissue`, and flips expired→pending.
    // A non-expired request 409s out of here (the proposal stays pending).
    const request = await this.reissueExpired(user, input.signatureRequestId);

    // (2) GOVERNED-OUTBOUND send of the renewed link (the `link.reissue.send`
    // class). The Governor claims the M1 key, runs the gates, and on allow+claim
    // calls the thunk — which REUSES the gated `resend` (re-mint + deliver). A
    // non-pending request (raced sign/cancel) throws out of `resend` → the
    // Governor parks the ledger row AMBIGUOUS (never auto-resent).
    const sendFlag = serverEnv.CAMPAIGN_SEND_ENABLED;
    const killSwitchEnabled = sendFlag !== '0' && sendFlag !== 'false';

    let lastReport: SignatureDeliveryReport | null = null;
    const outcome = await governOutboundSend({
      orgId: user.orgId,
      proposalId: input.proposalId,
      // Email is the primary channel for the ledger key + rate bucket; the actual
      // fan-out (email AND/OR sms) happens inside `resend`.
      channel: 'email',
      // The reissue APPROVAL is the exactly-once unit (see header) — key on the
      // proposal id, NOT the request id, so distinct reissues each deliver while a
      // retried same-approve collides → already_sent.
      recipientRef: input.proposalId,
      cadenceStep: REISSUE_SEND_CADENCE_STEP,
      // Consent defaults TRUE — same documented seam as sendGovernedReminder (no
      // per-owner outbound opt-out registry yet; ConsentGate denies when false).
      recipientConsented: true,
      killSwitchEnabled,
      breakerTripped: false,
      now: new Date(),
      // Quiet-hours-EXEMPT (see REISSUE_SEND_GATES): an explicit human approve is
      // an on-demand re-contact, not a cadence reminder. All other gates apply.
      gates: REISSUE_SEND_GATES,
      send: async () => {
        const res = await this.resend(user, input.signatureRequestId);
        lastReport = res.delivery;
        if (didAnyChannelDeliver(res.delivery)) {
          return { delivered: true, providerMessageId: res.request.id };
        }
        const { failureKind, failureCode } = classifyNonDelivery(res.delivery);
        return { delivered: false, failureKind, failureCode };
      },
    });

    const delivery = this.summarizeReissueDelivery(outcome, lastReport);

    // (3) LEGIBILITY — best-effort in-app notification "owner re-notified". Fully
    // isolated: a notify failure NEVER fails the apply (the owner was already
    // contacted). Only fired when a channel actually carried the link.
    if (delivery.delivered) {
      await this.notifyReissueDelivered(user, input.signatureRequestId, request.documentId);
    }

    return { request, delivery };
  }

  /** Map a governed-outbound outcome + the per-channel report into the MINIMAL,
   *  PII-bounded `ProposalApplyDelivery` wire shape the inbox renders.
   *
   *  PII BOUNDARY (security review fix): the per-channel `report` is consumed HERE
   *  only — to pick which channel carried it + the MASKED email recipient — and is
   *  DELIBERATELY NOT placed on the returned shape. The report's
   *  `whatsapp.deepLink` embeds the RAW phone + the LIVE signing token; surfacing
   *  it on the proposal-approve response would leak a bearer credential onto the
   *  inbox surface. Only `delivered/state/channel/recipient` (recipient masked for
   *  email, `null` for sms/whatsapp) leave this method. */
  private summarizeReissueDelivery(
    outcome: GovernedSendOutcome,
    report: SignatureDeliveryReport | null,
  ): ProposalApplyDelivery {
    switch (outcome.result) {
      case 'sent': {
        // Pick the channel that actually carried it (email first, then sms, then
        // the manager-driven whatsapp deep-link). `report` is present on a `sent`.
        // Email is the ONLY channel that echoes a recipient — and ONLY the
        // already-`maskEmail`'d form (`report.email.to`). sms/whatsapp → null
        // (the phone is PII and the whatsapp deepLink carries the live token).
        if (report?.email.available && report.email.status) {
          return {
            delivered: true,
            state: 'sent',
            channel: 'email',
            recipient: report.email.to ?? null,
          };
        }
        if (report?.sms.available && report.sms.status) {
          return { delivered: true, state: 'sent', channel: 'sms', recipient: null };
        }
        if (report?.whatsapp.available) {
          return { delivered: true, state: 'sent', channel: 'whatsapp', recipient: null };
        }
        return { delivered: true, state: 'sent', channel: null, recipient: null };
      }
      // The M1 no-op replay (a prior terminal `sent` for this proposal's key): the
      // owner was ALREADY contacted by the original attempt — surface it as such,
      // not a failure.
      case 'already_sent':
        return { delivered: false, state: 'already_sent', channel: null, recipient: null };
      // A gate denied/deferred (kill-switch off / consent withdrawn / breaker /
      // ceiling): NO send happened. The re-mint stands; retry later.
      case 'blocked':
        return { delivered: false, state: 'blocked', channel: null, recipient: null };
      // A DEFINITE non-send (no channel on file / provider rejection).
      case 'failed':
        return { delivered: false, state: 'failed', channel: null, recipient: null };
      // AMBIGUOUS — provider threw/timed out; the send MAY have gone out. Surface
      // a DISTINCT "needs manual check" state, never a false success.
      case 'ambiguous':
        return { delivered: false, state: 'ambiguous', channel: null, recipient: null };
      default:
        return { delivered: false, state: 'no_channel', channel: null, recipient: null };
    }
  }

  /** Best-effort "owner re-notified" in-app notification for a delivered reissue.
   *  Recipients resolved via the single D-O7 source (managers + project agents),
   *  the actor (the approver) excluded. Self-guarded: never throws into the apply.
   *  NO PII — the document name is same-org already-visible; no owner identity. */
  private async notifyReissueDelivered(
    user: AccessTokenPayload,
    signatureRequestId: string,
    documentId: string,
  ): Promise<void> {
    if (!this.notifications) return;
    try {
      // Resolve the doc's project (for the agent fan-out) + recipients in ONE
      // org-scoped tx; resolveNotificationRecipients enforces recipient∈org.
      const recipients = await withTenant(
        user.orgId,
        async (tx) => {
          const doc = await this.loadVisibleDocument(tx, documentId);
          return resolveNotificationRecipients(tx, user.orgId, {
            projectId: doc.projectId,
            actorUserId: user.sub,
          });
        },
        { userId: user.sub },
      );
      if (recipients.length === 0) return;
      await this.notifications.emitMany(recipients, {
        orgId: user.orgId,
        type: 'signature_received',
        title: 'קישור החתימה חודש ונשלח מחדש',
        body: 'בעל/ת הדירה קיבל/ה מחדש את קישור החתימה לאחר שפג תוקפו.',
        link: notificationLink.document(documentId),
        metadata: { signatureRequestId },
      });
    } catch (e: unknown) {
      // A notification must NEVER fail the apply — the owner was already
      // contacted. Log the failure TYPE only (no PII, no ids of value).
      this.logger.warn(
        `reissue notify failed (req=${signatureRequestId}): ${e instanceof Error ? e.message : 'unknown'}`,
      );
    }
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
