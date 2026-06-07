import { randomUUID } from 'node:crypto';

import { serverEnv } from '@emapp/config';
import {
  AuditService,
  documents,
  owners,
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
  SignatureRequest,
  SignatureRequestCreateResponse,
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
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, desc, eq, inArray, lt, or, sql, type SQL } from 'drizzle-orm';

import { requireAgentCapability } from '../../common/authz/agent-capabilities';
import { decodeCursor, encodeCursor } from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';
import { SMS_PROVIDER } from '../auth/tenant/otp.service';
import { EMAIL_PROVIDER } from '../members/invite-email';

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
  ) {}

  /** Validate the document is visible in the manager's org and not
   *  archived. Returns the row or throws no-oracle 404. */
  private async loadVisibleDocument(
    tx: TenantTx,
    documentId: string,
  ): Promise<{ id: string; name: string; archivedAt: Date | null }> {
    const [row] = await tx
      .select({
        id: documents.id,
        name: documents.name,
        archivedAt: documents.archivedAt,
        uploadedAt: documents.uploadedAt,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    // 0049 — a signature request may only target a FINALISED document. Else a
    // resident could be sent a link whose document was never stored (the
    // preview 404s, yet the signature would record against absent bytes — the
    // audit's worst ghost finding). uploaded_at IS NULL → 404.
    if (!row || row.archivedAt || !row.uploadedAt) throw NOT_FOUND;
    return { id: row.id, name: row.name, archivedAt: row.archivedAt };
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
        const own = await this.loadOwnerWithPii(tx, input.ownerId);

        // Block a duplicate pending request for the same (doc, owner).
        // Cancelled/signed requests don't block (the manager may need
        // to re-issue after cancellation).
        const [existingPending] = await tx
          .select({ id: signatureRequests.id })
          .from(signatureRequests)
          .where(
            and(
              eq(signatureRequests.documentId, input.documentId),
              eq(signatureRequests.ownerId, input.ownerId),
              eq(signatureRequests.status, 'pending'),
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
        return {
          row: inserted,
          documentName: doc.name,
          ownerName: own.name,
          ownerEmail: own.email,
          ownerPhone: own.phonePlain,
        };
      },
      { userId: user.sub },
    );

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

        // Owners that already have a PENDING request for this doc → skip (1 query).
        const existing = await tx
          .select({ ownerId: signatureRequests.ownerId })
          .from(signatureRequests)
          .where(
            and(
              eq(signatureRequests.documentId, input.documentId),
              inArray(signatureRequests.ownerId, ownerIds),
              eq(signatureRequests.status, 'pending'),
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
        return { documentName: doc.name, bundles };
      },
      { userId: user.sub },
    );

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
        return {
          row,
          token,
          documentName: doc.name,
          ownerName: own.name,
          ownerEmail: own.email,
          ownerPhone: own.phonePlain,
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
    );

    return { request: this.toWire(txOut.row), signUrl, delivery };
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
      return {
        token,
        documentName: doc.name,
        ownerName: own.name,
        ownerEmail: own.email,
        ownerPhone: own.phonePlain,
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
          ? or(
              lt(signatureRequests.createdAt, new Date(cur.c)),
              and(
                eq(signatureRequests.createdAt, new Date(cur.c)),
                lt(signatureRequests.id, cur.i),
              ),
            )
          : undefined;

        return tx
          .select()
          .from(signatureRequests)
          .where(and(...filters, keyset))
          .orderBy(desc(signatureRequests.createdAt), desc(signatureRequests.id))
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
