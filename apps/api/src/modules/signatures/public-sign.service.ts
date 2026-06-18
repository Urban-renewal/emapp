import { createHash } from 'node:crypto';

import { serverEnv } from '@emapp/config';
import {
  AuditService,
  DEFAULT_EMAIL_FROM,
  buildEmailFrom,
  decryptOwnerName,
  documents,
  encryptField,
  owners,
  piiProcessingConsents,
  signatureRequests,
  signatures,
  users,
  withTenant,
  type IEmailProvider,
  type IStorageProvider,
} from '@emapp/db';
import type { PublicSignPreview, PublicSignSubmit } from '@emapp/shared-types';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { and, eq, gt, sql } from 'drizzle-orm';

import { getOrgSettings } from '../../common/org-settings.resolver';
import {
  DOWNLOAD_URL_TTL_SECONDS,
  STORAGE_PROVIDER,
  safeDownloadFilename,
} from '../documents/storage';
import { EMAIL_PROVIDER } from '../members/invite-email';
import { notificationLink } from '../notifications/notification-links';
import { NotificationsProducerService } from '../notifications/notifications-producer.service';
import { StatsCacheService } from '../projects/stats-cache.service';

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
    private readonly notifications: NotificationsProducerService,
    // E2 Wave-0 PERF — OPTIONAL stats cache. A resident sign flips a request to
    // 'signed' and may flip an apartment to consented, so it invalidates the
    // org's stats. Optional so signing specs that `new PublicSignService(...)`
    // without it still work (no-op invalidation).
    @Optional() private readonly statsCache?: StatsCacheService,
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
            uploadedAt: documents.uploadedAt,
            scanStatus: documents.scanStatus,
          })
          .from(documents)
          .where(eq(documents.id, req.documentId))
          .limit(1);
        // 0049 — defence-in-depth: never show a resident a preview of a doc
        // whose bytes were never stored (generic INVALID_TOKEN, no oracle).
        // P0.B1 — FAIL-CLOSED malware gate: a resident is served the document
        // ONLY when its anti-malware scan returned `clean`; any other status
        // → generic INVALID_TOKEN (no-oracle), never a minted presigned URL.
        if (!doc || doc.archivedAt || !doc.uploadedAt || doc.scanStatus !== 'clean')
          throw INVALID_TOKEN;

        // v8 §v8-S3 — name now pgcrypto-encrypted; decrypt inside
        // the same tx (app.encryption_key GUC is set by withTenant).
        const [own] = await tx
          .select({
            id: owners.id,
            nameEncrypted: owners.nameEncrypted,
            archivedAt: owners.archivedAt,
          })
          .from(owners)
          .where(eq(owners.id, req.ownerId))
          .limit(1);
        if (!own || own.archivedAt) throw INVALID_TOKEN;
        // S3a — decryptOwnerName returns null for an owner SHELL (no name).
        // A signing flow targets a real (named) owner, but coalesce to '' so a
        // missing name renders blank rather than violating the preview shape.
        const ownerName = (await decryptOwnerName(tx, own.nameEncrypted)) ?? '';

        // P0.C2 — resolve the org's CONFIGURABLE PII-processing privacy notice
        // so the resident SEES it before signing. Fail-soft: getOrgSettings
        // degrades to defaults (a generic notice), so a missing/malformed
        // settings row never blocks the preview. Resolved INSIDE this
        // withTenant tx so organizations.settings is RLS-scoped.
        const settings = await getOrgSettings(tx, claims.orgId);

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
          owner: { name: ownerName },
          expiresAt: req.expiresAt,
          consentNotice: {
            text: settings.privacy.noticeText,
            version: settings.privacy.noticeVersion,
            requireExplicitConsent: settings.privacy.requireExplicitConsent,
          },
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

        // P0.C2 — resolve the org's configurable PII-processing privacy notice.
        // Fail-soft (getOrgSettings degrades to defaults). Resolved INSIDE this
        // withTenant tx so organizations.settings is RLS-scoped; reused below
        // for the post-sign email From display-name (single read).
        const settings = await getOrgSettings(tx, claims.orgId);
        const privacy = settings.privacy;

        // If the org REQUIRES explicit consent, the resident must have ticked
        // the acknowledgment box. This is reachable ONLY after the token
        // validated and the row flipped to 'signed' — it is NOT an enumeration
        // oracle (a forged/expired/consumed token never gets here; it hits the
        // generic invalid_token above). Throwing here rolls back the whole tx
        // (the status-flip + any inserts), so a consent-less sign leaves NO
        // state. `consent_required` is a legitimate client-correctable 400.
        if (privacy.requireExplicitConsent && body.acknowledgeConsent !== true) {
          throw new BadRequestException({ error: { code: 'consent_required' } });
        }

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
        //
        // v8 §v8-S3 — owner.name is encrypted; we read the ciphertext
        // and decrypt below (best-effort, since this is a notification
        // path that already tolerates a missing owner).
        const [own] = await tx
          .select({
            id: owners.id,
            nameEncrypted: owners.nameEncrypted,
            email: owners.email,
          })
          .from(owners)
          .where(eq(owners.id, req.ownerId))
          .limit(1);
        let ownerNameSign: string | null = null;
        if (own) {
          try {
            ownerNameSign = await decryptOwnerName(tx, own.nameEncrypted);
          } catch (e: unknown) {
            // Notification name is best-effort; fall back to the
            // default below if decryption fails (logged for SRE).
            this.logger.error(
              `failed to decrypt owner.name for post-sign notify (owner=${own.id}): ${
                e instanceof Error ? e.message : 'unknown'
              }`,
            );
          }
        }
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

        // P0.C2 — record the PII-processing consent ATOMICALLY with the
        // signature (same tx; rolls back together on any later throw). The
        // record pins the notice VERSION the resident saw AND a SHA-256 of the
        // exact notice TEXT, so it self-verifies even if the org later edits
        // its configurable copy. Carries NO new PII — only the owner ref +
        // request provenance (IP/UA), mirroring `signatures`. Append-only table
        // (migration 0059 REVOKEs UPDATE/DELETE). `method` records the surface;
        // implicit-by-signing (no checkbox required) is still a recorded
        // acknowledgment per the privacy-notice shown on the sign page.
        const noticeHash = createHash('sha256').update(privacy.noticeText, 'utf8').digest('hex');
        await tx.insert(piiProcessingConsents).values({
          orgId: claims.orgId,
          ownerId: req.ownerId,
          noticeVersion: privacy.noticeVersion,
          noticeHash,
          method: 'public_sign_v1',
          consentIp: audit.ip,
          consentUserAgent: audit.userAgent,
          acknowledgedAt: req.signedAt!,
        });

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

        // P0.C2 — forensic audit of the consent capture (privacy-law trail).
        // No PII in metadata — only refs + the notice version/method. Same tx,
        // actor_type='system' (public-link flow has no user actor).
        await new AuditService(tx, audit).log({
          orgId: claims.orgId,
          actorType: 'system',
          action: 'pii_consent.recorded',
          targetTable: 'pii_processing_consents',
          targetId: signatureRow.id,
          metadata: {
            owner_id: req.ownerId,
            notice_version: privacy.noticeVersion,
            method: 'public_sign_v1',
            explicit: privacy.requireExplicitConsent,
          },
        });

        // P6 — resolve the org's branding.senderName into the From DISPLAY
        // name (the address stays the verified system From). Built ONLY via
        // buildEmailFrom (single source — header safety). Reuses the `settings`
        // already resolved above for the consent notice (single RLS-scoped
        // read). buildEmailFrom is itself defensive; the try/catch is
        // belt-and-suspenders, matching #306.
        let emailFrom = DEFAULT_EMAIL_FROM;
        try {
          emailFrom = buildEmailFrom(settings.branding.senderName, DEFAULT_EMAIL_FROM);
        } catch (e: unknown) {
          this.logger.warn(
            `org-settings read failed for post-sign From display-name (org=${claims.orgId}); ` +
              `using default From: ${e instanceof Error ? e.message : 'unknown'}`,
          );
        }

        // Bundle data needed for post-sign emails (T5.7). Fire AFTER
        // the tx commits so a slow Resend call never holds a DB
        // connection (same governed pattern as SignatureRequestsService.create).
        return {
          signedAt: signatureRow.signedAt,
          orgId: claims.orgId,
          documentId: req.documentId,
          ownerId: req.ownerId,
          emailFrom,
          notify: {
            managerUserId: mgr?.id ?? null,
            managerEmail: mgr?.email ?? null,
            residentEmail: own?.email ?? null,
            ownerName: ownerNameSign ?? 'בעל דירה',
            documentName: doc.name,
          },
        };
      });

      // E2 Wave-0 PERF — the sign just changed consent (a request flipped to
      // 'signed', possibly tipping an apartment to consented). Invalidate the
      // org's stats epoch so the board/KPIs recompute. Best-effort: a cache
      // blip must never fail the resident's committed sign.
      if (this.statsCache) {
        try {
          await this.statsCache.invalidateOrg(result.orgId);
        } catch (e: unknown) {
          this.logger.warn(
            `[sign] stats-cache invalidate failed (org=${result.orgId}): ` +
              `${e instanceof Error ? e.message : 'unknown'}`,
          );
        }
      }

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
          result.emailFrom,
        );
      } catch (e: unknown) {
        // notifyAfterSign already catches per-channel; this is a guard
        // for the unexpected.
        this.logger.error(
          `[sign] notifyAfterSign threw unexpectedly: ${e instanceof Error ? e.message : 'unknown'}`,
        );
      }

      // In-app notification (the generation half — was Phase 5 deferred).
      // Delivered to the SR creator (manager/agent) ALONGSIDE the email so
      // the org sees the signature land in real time, not only over email.
      // Self-guarded + best-effort: a notify failure NEVER fails the sign.
      // PII rule: only the document name (already org-visible) — no owner
      // name / national_id / phone in the unencrypted notification row.
      if (result.notify.managerUserId) {
        await this.notifications.emit({
          orgId: result.orgId,
          recipientId: result.notify.managerUserId,
          type: 'signature_received',
          title: 'התקבלה חתימה',
          body: `המסמך "${result.notify.documentName}" נחתם.`,
          link: notificationLink.document(result.documentId),
          metadata: { documentId: result.documentId, ownerId: result.ownerId },
        });
      }

      return { signedAt: result.signedAt };
    } catch (e: unknown) {
      if (e instanceof UnauthorizedException) throw e;
      if (e instanceof ServiceUnavailableException) throw e;
      // P0.C2 — `consent_required` is a legitimate client-correctable 400, NOT
      // an enumeration oracle: it is reachable only AFTER the token validated
      // (a forged/expired/consumed token already hit the generic 401 above).
      // Surface it so the resident can tick the box and retry; the failed
      // attempt rolled back the whole tx (no partial sign / no consent row).
      if (e instanceof BadRequestException) throw e;
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
