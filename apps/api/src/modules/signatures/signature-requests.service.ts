import { randomUUID } from 'node:crypto';

import {
  AuditService,
  documents,
  owners,
  signatureRequests,
  withTenant,
  type TenantTx,
} from '@emapp/db';
import type {
  CreateSignatureRequest,
  SignatureRequest,
  SignatureRequestCreateResponse,
  SignatureDeliveryReport,
} from '@emapp/shared-types';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import type { AccessTokenPayload } from '../auth/auth.service';

import { SignatureTokenService } from './signature-token.service';

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });
const FORBIDDEN = new ForbiddenException({ error: { code: 'forbidden' } });

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

  constructor(private readonly tokenService: SignatureTokenService) {}

  private requireManager(user: AccessTokenPayload): void {
    if (user.role !== 'manager') throw FORBIDDEN;
  }

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
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    if (!row || row.archivedAt) throw NOT_FOUND;
    return row;
  }

  /** Validate the owner exists in the manager's org. Returns the row or
   *  throws no-oracle 404. */
  private async loadOwner(
    tx: TenantTx,
    ownerId: string,
  ): Promise<{ id: string; name: string; archivedAt: Date | null }> {
    const [row] = await tx
      .select({
        id: owners.id,
        name: owners.name,
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
    this.requireManager(user);

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

    const row = await withTenant(
      user.orgId,
      async (tx) => {
        // Layer-6 IDOR defense: verify document + owner are in this org.
        // The two reads are scoped by withTenant RLS — a foreign id is
        // simply invisible and the SELECT returns 0 rows → 404 (no
        // oracle distinguishes "wrong org" from "never existed").
        await this.loadVisibleDocument(tx, input.documentId);
        await this.loadOwner(tx, input.ownerId);

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

        return inserted;
      },
      { userId: user.sub },
    );

    // S6 (Email/WhatsApp/SMS delivery) lands in a follow-up commit. For
    // S4-min we return an honest "deferred" delivery report so the FE
    // knows which channels are not yet wired. The signUrl IS the
    // primary deliverable; the Manager can copy/paste it for now.
    const delivery: SignatureDeliveryReport = {
      email: { available: false, reason: 'delivery_not_wired_yet' },
      whatsapp: { available: false, reason: 'delivery_not_wired_yet' },
      sms: { available: false, reason: 'sms_provider_not_configured' },
    };

    return {
      request: this.toWire(row),
      signUrl: `${PUBLIC_APP_URL}/sign/${token}`,
      delivery,
    };
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
