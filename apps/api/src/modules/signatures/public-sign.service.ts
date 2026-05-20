import { createHash } from 'node:crypto';

import { serverEnv } from '@emapp/config';
import {
  AuditService,
  documents,
  encryptField,
  owners,
  signatureRequests,
  signatures,
  users,
  withTenant,
  type IEmailProvider,
  type IStorageProvider,
} from '@emapp/db';
import type { PublicSignPreview, PublicSignSubmit } from '@emapp/shared-types';
import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { and, eq, gt, sql } from 'drizzle-orm';

import {
  DOWNLOAD_URL_TTL_SECONDS,
  STORAGE_PROVIDER,
  safeDownloadFilename,
} from '../documents/storage';
import { EMAIL_PROVIDER } from '../members/invite-email';

import { notifyAfterSign } from './signature-link-delivery';
import { SignatureTokenService } from './signature-token.service';

/** Generic 401 for the resident — no oracle distinguishes
 *  "wrong token" / "expired" / "consumed" / "cancelled". The internal
 *  fail reason stays on the audit row + server log for forensics. */
const INVALID_TOKEN = new UnauthorizedException({ error: { code: 'invalid_token' } });

/** S5 — public sign service. The resident-side half of Phase 5.
 *
 * Implements the 10 security layers we documented:
 *  1. JWT verify (HS256, separate SIGNATURE_TOKEN_SECRET, separate
 *     audience emapp-sign) — via SignatureTokenService.
 *  2. Atomic single-use blacklist — the UPDATE ... WHERE jti=? AND
 *     status='pending' AND expires_at>now() is THE guarantee that one
 *     token signs at most once. RETURNING 0 rows → reject. Concurrent
 *     POSTs race on the row lock; exactly one wins.
 *  3. Rate limit — declared at the controller (@Throttle 5/IP/h).
 *  4. No-oracle responses — every failure (wrong token / expired /
 *     consumed / cancelled / non-existent owner / non-existent doc) →
 *     same generic `invalid_token`.
 *  5. Token never in logs — pino redact path-segments (S7, this slice).
 *  6. Cross-org IDOR — withTenant(orgId-from-JWT-claim) ⇒ RLS enforces
 *     org_id match; a forged token claiming Org A but referring to Org
 *     B's document is invisible (the SELECT inside withTenant returns
 *     0 rows).
 *  7. Idempotency-Key — global interceptor; same key → cached response.
 *  8. TLS/HSTS/CSP — already in main.ts/Helmet.
 *  9. DKIM/SPF/DMARC — DNS-level, no code.
 *  10. Audit forensics — every attempt + every success writes
 *      audit_log with IP/UA/timestamp. actor_type='system' per the
 *      CHECK (migration 0014).
 */
@Injectable()
export class PublicSignService {
  private readonly logger = new Logger(PublicSignService.name);

  constructor(
    private readonly tokenService: SignatureTokenService,
    @Inject(STORAGE_PROVIDER) private readonly storage: IStorageProvider,
    @Inject(EMAIL_PROVIDER) private readonly email: IEmailProvider,
  ) {}

  /** GET /sign/:token — preview. Loads document + owner names + mints a
   *  short-lived presigned download URL for the resident to see what
   *  they're signing. The token is verified BEFORE any DB access — a
   *  forged token is rejected at JWT layer without touching the DB. */
  async preview(
    token: string,
    audit: { ip: string | undefined; userAgent: string | undefined },
  ): Promise<PublicSignPreview> {
    // Layer 1 — JWT verify. SignatureTokenVerifyError → 401 invalid_token.
    const claims = this.tokenService.verify(token);

    // Layer 6 — withTenant(orgId-from-claim) is the IDOR boundary.
    // A token forged to claim Org A but pointing to Org B's doc/owner
    // simply can't see them: RLS scopes by app.organization_id GUC.
    try {
      return await withTenant(claims.orgId, async (tx) => {
        // Re-verify the request exists, is pending, and not expired.
        // No-oracle: any miss → same generic 401.
        const [req] = await tx
          .select({
            id: signatureRequests.id,
            status: signatureRequests.status,
            expiresAt: signatureRequests.expiresAt,
            documentId: signatureRequests.documentId,
            ownerId: signatureRequests.ownerId,
          })
          .from(signatureRequests)
          .where(and(eq(signatureRequests.id, claims.sub), eq(signatureRequests.jti, claims.jti)))
          .limit(1);

        if (
          !req ||
          req.status !== 'pending' ||
          req.expiresAt.getTime() <= Date.now() ||
          req.documentId !== claims.documentId ||
          req.ownerId !== claims.ownerId
        ) {
          // Audit the failed preview attempt — forensic, generic surface.
          await new AuditService(tx, audit).log({
            orgId: claims.orgId,
            actorType: 'system',
            action: 'signature.preview_rejected',
            targetTable: 'signature_requests',
            targetId: claims.sub,
            metadata: { jti_hash: this.hashJti(claims.jti) },
          });
          throw INVALID_TOKEN;
        }

        // Load document + owner names (no PII beyond the owner's name,
        // which is mandatory for the resident to know what they're signing).
        const [doc] = await tx
          .select({
            id: documents.id,
            name: documents.name,
            r2Key: documents.r2Key,
            archivedAt: documents.archivedAt,
          })
          .from(documents)
          .where(eq(documents.id, req.documentId))
          .limit(1);
        if (!doc || doc.archivedAt) throw INVALID_TOKEN;

        const [own] = await tx
          .select({ id: owners.id, name: owners.name, archivedAt: owners.archivedAt })
          .from(owners)
          .where(eq(owners.id, req.ownerId))
          .limit(1);
        if (!own || own.archivedAt) throw INVALID_TOKEN;

        // Short-lived presigned GET for the document. Same pattern as
        // documents.getDownloadUrl — forced attachment + sanitized
        // filename. The download URL is itself a bearer credential and
        // expires in DOWNLOAD_URL_TTL_SECONDS.
        let downloadUrl: string;
        try {
          downloadUrl = await this.storage.getDownloadUrl(doc.r2Key, {
            ttlSeconds: DOWNLOAD_URL_TTL_SECONDS,
            responseFilename: safeDownloadFilename(doc.name),
          });
        } catch (e: unknown) {
          this.logger.error(
            `presign failed during sign preview (req=${req.id}): ${
              e instanceof Error ? e.message : 'unknown'
            }`,
          );
          // Infra outage — not a client error. Same governed pattern
          // as documents.getDownloadUrl (audit-pass II A3).
          throw new ServiceUnavailableException({
            error: { code: 'storage_unavailable' },
          });
        }

        await new AuditService(tx, audit).log({
          orgId: claims.orgId,
          actorType: 'system',
          action: 'signature.preview',
          targetTable: 'signature_requests',
          targetId: req.id,
          metadata: { jti_hash: this.hashJti(claims.jti) },
        });

        return {
          document: { name: doc.name, downloadUrl },
          owner: { name: own.name },
          expiresAt: req.expiresAt,
        };
      });
    } catch (e: unknown) {
      if (e instanceof UnauthorizedException) throw e;
      if (e instanceof ServiceUnavailableException) throw e;
      // Belt-and-suspenders: any unexpected error from the tx → generic
      // invalid_token (no oracle on internals). Logged server-side.
      this.logger.error(
        `preview failed (sub=${claims.sub}): ${e instanceof Error ? e.message : 'unknown'}`,
      );
      throw INVALID_TOKEN;
    }
  }

  /** POST /sign/:token — the actual sign. Atomic single-use guard is
   *  the row-level UPDATE; concurrent POSTs race on the same row and
   *  exactly one wins. */
  async sign(
    token: string,
    body: PublicSignSubmit,
    audit: { ip: string | undefined; userAgent: string | undefined },
  ): Promise<{ signedAt: Date }> {
    // Layer 1 — JWT verify.
    const claims = this.tokenService.verify(token);

    // Encryption key sanity. PII_ENCRYPTION_KEY drives the SVG
    // encryption (D.12 LAW — signature SVG is encrypted at rest).
    const encKey = serverEnv.PII_ENCRYPTION_KEY;
    if (!encKey || encKey.length < 32) {
      this.logger.error('PII_ENCRYPTION_KEY is not configured — refusing to sign (D.12 LAW)');
      throw new ServiceUnavailableException({
        error: { code: 'encryption_not_configured' },
      });
    }

    try {
      const result = await withTenant(claims.orgId, async (tx) => {
        // Layer 2 — ATOMIC single-use UPDATE. This is the heart of the
        // security model. The WHERE clause encodes ALL guards in one
        // statement so the DB itself is the source of truth on
        // "available to sign":
        //   - id matches the claim's `sub` (request exists in this org)
        //   - jti matches (defends against partial token alteration)
        //   - status is 'pending' (not signed, not cancelled)
        //   - expires_at > now() (DB clock, defends against client-side
        //     clock skew if the JWT verify clock allowed leeway)
        // RETURNING returns the row if and only if all four held AND the
        // UPDATE committed. Concurrent POSTs serialize on the row lock;
        // the second loses.
        const updated = await tx
          .update(signatureRequests)
          .set({ status: 'signed', signedAt: sql`now()` })
          .where(
            and(
              eq(signatureRequests.id, claims.sub),
              eq(signatureRequests.jti, claims.jti),
              eq(signatureRequests.status, 'pending'),
              gt(signatureRequests.expiresAt, sql`now()`),
            ),
          )
          .returning({
            id: signatureRequests.id,
            documentId: signatureRequests.documentId,
            ownerId: signatureRequests.ownerId,
            createdBy: signatureRequests.createdBy,
            signedAt: signatureRequests.signedAt,
          });

        if (updated.length === 0) {
          // No-oracle audit — single generic action for ALL failure modes
          // (consumed / cancelled / expired / forged / wrong-org).
          await new AuditService(tx, audit).log({
            orgId: claims.orgId,
            actorType: 'system',
            action: 'signature.rejected',
            targetTable: 'signature_requests',
            targetId: claims.sub,
            metadata: { jti_hash: this.hashJti(claims.jti) },
          });
          throw INVALID_TOKEN;
        }
        const req = updated[0]!;

        // Layer 6 reinforced — fetch the document_hash for forensic
        // immutability (the signature attests to THIS hash; if the doc
        // is ever replaced, the signature still pins what was signed).
        // We also load `name` for the post-sign notification emails
        // (T5.7 manager-notify + resident-confirm — DoD docs/03 §9).
        const [doc] = await tx
          .select({
            id: documents.id,
            contentHash: documents.contentHash,
            name: documents.name,
          })
          .from(documents)
          .where(eq(documents.id, req.documentId))
          .limit(1);
        if (!doc) {
          // Document went away between create and sign — extremely rare;
          // treat as reject (consistent surface).
          throw INVALID_TOKEN;
        }

        // Load owner (for resident confirmation) and manager (for the
        // T5.7 notification). Neither blocks the sign — if either lookup
        // returns nothing, the matching channel is skipped. RLS is in
        // effect (withTenant), so these reads are org-scoped.
        const [own] = await tx
          .select({ id: owners.id, name: owners.name, email: owners.email })
          .from(owners)
          .where(eq(owners.id, req.ownerId))
          .limit(1);
        const [mgr] = await tx
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(eq(users.id, req.createdBy))
          .limit(1);

        // D.12 LAW — encrypt the SVG at rest via pgcrypto.
        const signatureBlob = await encryptField(tx, body.signatureSvg, encKey);

        const [signatureRow] = await tx
          .insert(signatures)
          .values({
            orgId: claims.orgId,
            documentId: req.documentId,
            ownerId: req.ownerId,
            documentHash: doc.contentHash,
            signatureBlob,
            signatureFormat: 'svg',
            signerIp: audit.ip,
            signerUserAgent: audit.userAgent,
            sessionId: null, // public-link flow has no session
            authMethod: 'public_link_v1',
            signedAt: req.signedAt!,
          })
          .returning({ id: signatures.id, signedAt: signatures.signedAt });
        if (!signatureRow) throw INVALID_TOKEN;

        // Link the signature_requests row to the signatures row for
        // navigation. The atomic guard above prevents double-link.
        await tx
          .update(signatureRequests)
          .set({ signedSignatureId: signatureRow.id })
          .where(eq(signatureRequests.id, req.id));

        // Layer 10 — full forensic audit. actor_type='system' per the
        // audit_log_actor_type_valid CHECK (migration 0014 — same
        // pattern as the OTP tenant login audit per G1a).
        await new AuditService(tx, audit).log({
          orgId: claims.orgId,
          actorType: 'system',
          action: 'signature.signed',
          targetTable: 'signatures',
          targetId: signatureRow.id,
          metadata: {
            jti_hash: this.hashJti(claims.jti),
            owner_id: req.ownerId,
            document_id: req.documentId,
            auth_method: 'public_link_v1',
          },
        });

        // Bundle data needed for post-sign emails (T5.7). Fire AFTER
        // the tx commits so a slow Resend call never holds a DB
        // connection (same governed pattern as SignatureRequestsService.create).
        return {
          signedAt: signatureRow.signedAt,
          notify: {
            managerEmail: mgr?.email ?? null,
            residentEmail: own?.email ?? null,
            ownerName: own?.name ?? 'בעל דירה',
            documentName: doc.name,
          },
        };
      });

      // T5.7 — post-sign notifications. NEVER fails the resident's
      // sign call; individual failures are logged + swallowed.
      try {
        await notifyAfterSign(
          this.email,
          {
            managerEmail: result.notify.managerEmail,
            residentEmail: result.notify.residentEmail,
            ownerName: result.notify.ownerName,
            documentName: result.notify.documentName,
            signedAt: result.signedAt,
          },
          { error: (m): void => this.logger.error(m) },
        );
      } catch (e: unknown) {
        // notifyAfterSign already catches per-channel; this is a guard
        // for the unexpected.
        this.logger.error(
          `[sign] notifyAfterSign threw unexpectedly: ${e instanceof Error ? e.message : 'unknown'}`,
        );
      }

      return { signedAt: result.signedAt };
    } catch (e: unknown) {
      if (e instanceof UnauthorizedException) throw e;
      if (e instanceof ServiceUnavailableException) throw e;
      this.logger.error(
        `sign failed (sub=${claims.sub}): ${e instanceof Error ? e.message : 'unknown'}`,
      );
      throw INVALID_TOKEN;
    }
  }

  /** Audit-safe jti hash: we never log the raw jti (it's the
   *  single-use guard's key). For forensics, an HMAC-ish short prefix
   *  of a sha256 is enough to correlate audit rows for the same token
   *  attempt without ever exposing the token itself. */
  private hashJti(jti: string): string {
    // Forensic correlation only, not a security boundary. Short prefix
    // of sha256 is enough to correlate audit rows for the same token
    // attempt without ever exposing the raw jti.
    return createHash('sha256').update(jti, 'utf8').digest('hex').slice(0, 16);
  }
}
