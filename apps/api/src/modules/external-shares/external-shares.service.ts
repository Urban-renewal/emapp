import {
  apartments,
  AuditService,
  buildings,
  documents,
  encryptRecipientField,
  externalShares,
  isOrgSuspended,
  maskRecipientEmail,
  maskRecipientPhone,
  partyRequests,
  PARTY_PRESET_CEILINGS,
  projects,
  withTenant,
  type ExternalShare,
  type ExternalSharePartyType,
  type ExternalSharePermissions,
  type ExternalShareScopeType,
  type PartyPresetCeiling,
  type PartyRequest,
  type TenantTx,
} from '@emapp/db';
import {
  partyTypeForDocumentParty,
  type CreateExternalShare,
  type CreatePartyRequest,
  type ExtendExternalShare,
  type ExternalShareView,
  type ListPartyRequestsQueryDto,
  type PartyRequestView,
  type UpdateExternalShare,
} from '@emapp/shared-types';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';

import {
  decodeCursor,
  encodeCursor,
  keysetCondition,
  keysetOrderBy,
} from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';

import {
  decideExternalPartyAccess,
  isDocInShareScope,
  type ExternalPartyDecision,
} from './external-party-authz';

export interface ExternalShareListPage {
  data: ExternalShareView[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

export interface PartyRequestListPage {
  data: PartyRequestView[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

// No-oracle: a missing / cross-org / suspended grant is INDISTINGUISHABLE from
// a non-existent one (generic 404). FORBIDDEN is only the manager-gate (a known
// org member who simply lacks write rights) — never leaked for resource
// existence.
const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });
const FORBIDDEN = new ForbiddenException({ error: { code: 'forbidden' } });

const SCOPE_RANK: Record<ExternalShareScopeType, number> = {
  apartment: 0,
  building: 1,
  project: 2,
};

/** True iff `e` is a Postgres unique-violation (SQLSTATE 23505), reading the
 *  `code` off the error / its cause chain without an `any` cast. */
function isUniqueViolation(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur !== null && typeof cur === 'object'; i++) {
    const code = (cur as { code?: unknown }).code;
    if (code === '23505') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * W-4.1 — masked view projection. The recipient email/phone ciphertext is
 * DECRYPTED then MASKED (via the canonical recipient seam) so the wire NEVER
 * carries the plaintext OR the ciphertext — only `na***@domain` / `••••••12`.
 * `recipientName` (a contact LABEL, not legally PII) passes through. Async
 * because masking requires a pgcrypto decrypt round-trip per non-null value.
 */
async function toViewMasked(tx: TenantTx, r: ExternalShare): Promise<ExternalShareView> {
  const [recipientEmailMasked, recipientPhoneMasked] = await Promise.all([
    maskRecipientEmail(tx, r.recipientEmailEncrypted),
    maskRecipientPhone(tx, r.recipientPhoneEncrypted),
  ]);
  return {
    id: r.id,
    orgId: r.orgId,
    partyType: r.partyType,
    scopeType: r.scopeType,
    scopeIds: r.scopeIds,
    permissions: r.permissions,
    allowSensitive: r.allowSensitive,
    otpRequired: r.otpRequired,
    expiresAt: r.expiresAt,
    watermarkSubject: r.watermarkSubject,
    recipientName: r.recipientName,
    recipientEmailMasked,
    recipientPhoneMasked,
    deliveryChannel: r.deliveryChannel,
    lastDeliveredAt: r.lastDeliveredAt,
    revokedAt: r.revokedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** Map a party_request row to its PII-free view. */
function toPartyRequestView(r: PartyRequest): PartyRequestView {
  return {
    id: r.id,
    orgId: r.orgId,
    projectId: r.projectId,
    documentParty: r.documentParty as PartyRequestView['documentParty'],
    requestedDocType: r.requestedDocType,
    status: r.status as PartyRequestView['status'],
    externalShareId: r.externalShareId,
    fulfilledDocumentId: r.fulfilledDocumentId,
    fulfilledAt: r.fulfilledAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/**
 * X-S3 (V13) — external_share BE service.
 *
 * The generalized successor to SharesService: manager-only writes that mint /
 * narrow / revoke / extend party-typed external grants. The authorization spine
 * is the SERVER-SIDE preset CEILING per party_type (PARTY_PRESET_CEILINGS):
 *   - create re-validates the requested scope_type + permissions +
 *     allow_sensitive + TTL against the ceiling, FAIL-CLOSED — a request that
 *     asks for MORE than the ceiling is REJECTED (`exceeds_ceiling`), never
 *     silently clamped.
 *   - update can only NARROW — never widen — relative to BOTH the ceiling AND
 *     the grant's current footprint.
 *   - revoke sets revoked_at immediately (no physical delete; idempotent).
 *   - extend pushes expires_at forward only, capped at the ceiling TTL.
 *   - resend is an audited re-issue marker (the OTP/delivery channel is X-S4).
 *
 * D.49 SUSPENSION: a suspended org's external grants are INERT (404) for EVERY
 * op — gated via `isOrgSuspended` at the top of each tx (mirrors SharesService).
 * NO-ORACLE: not-found / cross-org / suspended all → generic 404.
 */
@Injectable()
export class ExternalSharesService {
  private requireManager(user: AccessTokenPayload): void {
    if (user.role !== 'manager') throw FORBIDDEN;
  }

  private ceilingFor(partyType: ExternalSharePartyType): PartyPresetCeiling {
    const ceiling = PARTY_PRESET_CEILINGS[partyType];
    if (!ceiling) {
      // Unreachable for a Zod-validated party_type, but fail-closed if a new
      // enum value ever ships without a ceiling entry.
      throw new InternalServerErrorException({ error: { code: 'missing_ceiling' } });
    }
    return ceiling;
  }

  /** Is `requested` permission set WITHIN `ceiling` (every flag ≤ ceiling)? */
  private permsWithinCeiling(
    requested: ExternalSharePermissions,
    ceiling: ExternalSharePermissions,
  ): boolean {
    return (
      (!requested.overview.on || ceiling.overview.on) &&
      (!requested.documents.on || ceiling.documents.on) &&
      (!requested.documents.actions.download || ceiling.documents.actions.download) &&
      (!requested.signatures.on || ceiling.signatures.on)
    );
  }

  /**
   * The full fail-closed gate applied at create AND (for the changed fields) at
   * update. Throws `exceeds_ceiling` (400) on any widening beyond the party
   * preset. Scope-narrowing (a tighter scope_type) is ALWAYS allowed; widening
   * the scope_type beyond `maxScopeType` is rejected.
   */
  private assertWithinCeiling(
    partyType: ExternalSharePartyType,
    scopeType: ExternalShareScopeType,
    permissions: ExternalSharePermissions,
    allowSensitive: boolean,
    expiresAt: Date | null | undefined,
  ): void {
    const ceiling = this.ceilingFor(partyType);
    const bad = (): never => {
      throw new BadRequestException({ error: { code: 'exceeds_ceiling' } });
    };
    // scope_type may be EQUAL or NARROWER than the ceiling (lower rank = tighter).
    if (SCOPE_RANK[scopeType] > SCOPE_RANK[ceiling.maxScopeType]) bad();
    if (!this.permsWithinCeiling(permissions, ceiling.permissions)) bad();
    if (allowSensitive && !ceiling.allowSensitive) bad();
    if (expiresAt && ceiling.maxTtlDays !== null) {
      const cap = new Date(Date.now() + ceiling.maxTtlDays * 24 * 60 * 60 * 1000);
      if (expiresAt.getTime() > cap.getTime()) bad();
    }
  }

  /** Every scope_id MUST resolve to a live row of the matching kind INSIDE the
   *  caller's org (RLS already scopes the read; this rejects cross-scope or
   *  unknown ids fail-closed). */
  private async assertScopeIdsValid(
    tx: TenantTx,
    scopeType: ExternalShareScopeType,
    scopeIds: string[],
  ): Promise<void> {
    const unique = [...new Set(scopeIds)];
    let found: { id: string }[];
    if (scopeType === 'project') {
      found = await tx
        .select({ id: projects.id })
        .from(projects)
        .where(and(inArray(projects.id, unique), isNull(projects.archivedAt)));
    } else if (scopeType === 'building') {
      found = await tx
        .select({ id: buildings.id })
        .from(buildings)
        .where(and(inArray(buildings.id, unique), isNull(buildings.archivedAt)));
    } else {
      found = await tx
        .select({ id: apartments.id })
        .from(apartments)
        .where(and(inArray(apartments.id, unique), isNull(apartments.archivedAt)));
    }
    if (found.length !== unique.length) {
      throw new BadRequestException({ error: { code: 'invalid_scope' } });
    }
  }

  async create(user: AccessTokenPayload, input: CreateExternalShare): Promise<ExternalShareView> {
    this.requireManager(user);
    const expiresAt = input.expiresAt ?? null;
    // SERVER-SIDE ceiling re-validation BEFORE any write (fail-closed).
    this.assertWithinCeiling(
      input.partyType,
      input.scopeType,
      input.permissions,
      input.allowSensitive,
      expiresAt,
    );
    return withTenant(
      user.orgId,
      async (tx) => {
        if (await isOrgSuspended(tx, user.orgId)) throw NOT_FOUND;
        await this.assertScopeIdsValid(tx, input.scopeType, input.scopeIds);
        // Encrypt recipient contact PII via the canonical pgcrypto seam BEFORE
        // insert (raw value never persisted, never logged). null/absent → NULL.
        const [recipientEmailEncrypted, recipientPhoneEncrypted] = await Promise.all([
          encryptRecipientField(tx, input.recipientEmail),
          encryptRecipientField(tx, input.recipientPhone),
        ]);
        const [row] = await tx
          .insert(externalShares)
          .values({
            orgId: user.orgId,
            partyType: input.partyType,
            scopeType: input.scopeType,
            scopeIds: input.scopeIds,
            permissions: input.permissions,
            allowSensitive: input.allowSensitive,
            otpRequired: input.otpRequired,
            expiresAt,
            watermarkSubject: input.watermarkSubject ?? null,
            recipientName: input.recipientName ?? null,
            recipientEmailEncrypted,
            recipientPhoneEncrypted,
            // 4.1 captures intent only; an actual send is the gated 4.3 path.
            deliveryChannel: input.deliveryChannel ?? 'manual_link',
            createdBy: user.sub,
          })
          .returning();
        if (!row) {
          throw new InternalServerErrorException({ error: { code: 'insert_no_row' } });
        }
        // Audit afterState carries the LABEL + partyType ONLY — NEVER the
        // recipient email/phone (the brief's masking-only invariant).
        await this.audit(tx, user, 'external_share.create', row.id, {
          partyType: row.partyType,
          scopeType: row.scopeType,
          recipientName: row.recipientName,
        });
        return toViewMasked(tx, row);
      },
      { userId: user.sub },
    );
  }

  async update(
    user: AccessTokenPayload,
    id: string,
    input: UpdateExternalShare,
  ): Promise<ExternalShareView> {
    this.requireManager(user);
    return withTenant(
      user.orgId,
      async (tx) => {
        if (await isOrgSuspended(tx, user.orgId)) throw NOT_FOUND;
        const [before] = await tx
          .select()
          .from(externalShares)
          .where(and(eq(externalShares.id, id), isNull(externalShares.revokedAt)))
          .limit(1);
        if (!before) throw NOT_FOUND;

        // Resolve the NEXT state field-by-field (only provided fields change).
        const nextScopeType = input.scopeType ?? before.scopeType;
        const nextScopeIds = input.scopeIds ?? before.scopeIds;
        const nextPerms = input.permissions ?? before.permissions;
        const nextSensitive = input.allowSensitive ?? before.allowSensitive;
        const nextOtp = input.otpRequired ?? before.otpRequired;

        // (1) Still within the party CEILING.
        this.assertWithinCeiling(
          before.partyType,
          nextScopeType,
          nextPerms,
          nextSensitive,
          before.expiresAt,
        );
        // (2) NARROWS-ONLY vs the current footprint: an update may tighten but
        // never widen relative to what the grant already had.
        this.assertNarrowsOnly(before, {
          scopeType: nextScopeType,
          permissions: nextPerms,
          allowSensitive: nextSensitive,
          otpRequired: nextOtp,
        });
        // scope_ids change → re-validate they resolve in-org for the (next) kind.
        if (input.scopeIds || input.scopeType) {
          await this.assertScopeIdsValid(tx, nextScopeType, nextScopeIds);
        }
        // scope_ids NARROWS-ONLY (security HIGH fix): when the scope_type is
        // unchanged, the id set may only SHRINK — adding a building/apartment/
        // project id would WIDEN the footprint the grant covers without tripping
        // the rank/perms checks above. (A scope_type change already lowers the
        // rank via assertNarrowsOnly + re-validates the ids in-org.)
        if (nextScopeType === before.scopeType) {
          const beforeIds = new Set(before.scopeIds);
          if (nextScopeIds.some((sid) => !beforeIds.has(sid))) {
            throw new BadRequestException({ error: { code: 'cannot_widen' } });
          }
        }

        // Recipient PII: `undefined` ⇒ leave the existing ciphertext untouched;
        // an explicit value (incl. null) ⇒ re-encrypt / clear. Encrypt via the
        // canonical seam; raw value never persisted/logged.
        const nextEmailEnc =
          input.recipientEmail === undefined
            ? before.recipientEmailEncrypted
            : await encryptRecipientField(tx, input.recipientEmail);
        const nextPhoneEnc =
          input.recipientPhone === undefined
            ? before.recipientPhoneEncrypted
            : await encryptRecipientField(tx, input.recipientPhone);

        const [row] = await tx
          .update(externalShares)
          .set({
            scopeType: nextScopeType,
            scopeIds: nextScopeIds,
            permissions: nextPerms,
            allowSensitive: nextSensitive,
            otpRequired: nextOtp,
            watermarkSubject:
              input.watermarkSubject === undefined
                ? before.watermarkSubject
                : input.watermarkSubject,
            recipientName:
              input.recipientName === undefined ? before.recipientName : input.recipientName,
            recipientEmailEncrypted: nextEmailEnc,
            recipientPhoneEncrypted: nextPhoneEnc,
            deliveryChannel: input.deliveryChannel ?? before.deliveryChannel,
            updatedAt: new Date(),
          })
          .where(eq(externalShares.id, id))
          .returning();
        if (!row) throw NOT_FOUND;
        await this.audit(tx, user, 'external_share.update', row.id);
        return toViewMasked(tx, row);
      },
      { userId: user.sub },
    );
  }

  /** Narrows-only invariant vs the current footprint. Widening any axis throws
   *  `cannot_widen` (400). Scope: a wider scope_type rank is widening. Perms:
   *  turning ON a flag that was OFF is widening. Sensitive: false→true is
   *  widening. OTP: true→false is widening (REMOVING the OTP gate weakens
   *  access; tightening it back ON is allowed). */
  private assertNarrowsOnly(
    before: {
      scopeType: ExternalShareScopeType;
      permissions: ExternalSharePermissions;
      allowSensitive: boolean;
      otpRequired: boolean;
    },
    next: {
      scopeType: ExternalShareScopeType;
      permissions: ExternalSharePermissions;
      allowSensitive: boolean;
      otpRequired: boolean;
    },
  ): void {
    const widen = (): never => {
      throw new BadRequestException({ error: { code: 'cannot_widen' } });
    };
    if (SCOPE_RANK[next.scopeType] > SCOPE_RANK[before.scopeType]) widen();
    const b = before.permissions;
    const n = next.permissions;
    if (n.overview.on && !b.overview.on) widen();
    if (n.documents.on && !b.documents.on) widen();
    if (n.documents.actions.download && !b.documents.actions.download) widen();
    if (n.signatures.on && !b.signatures.on) widen();
    if (next.allowSensitive && !before.allowSensitive) widen();
    if (!next.otpRequired && before.otpRequired) widen();
  }

  /** Revoke — revoked_at + revoked_by (immediate, no physical delete).
   *  Idempotent: revoking an already-revoked grant is a no-op success. */
  async revoke(user: AccessTokenPayload, id: string): Promise<void> {
    this.requireManager(user);
    await withTenant(
      user.orgId,
      async (tx) => {
        if (await isOrgSuspended(tx, user.orgId)) throw NOT_FOUND;
        const [before] = await tx
          .select({ id: externalShares.id, revokedAt: externalShares.revokedAt })
          .from(externalShares)
          .where(eq(externalShares.id, id))
          .limit(1);
        if (!before) throw NOT_FOUND;
        if (before.revokedAt) return; // idempotent no-op
        await tx
          .update(externalShares)
          .set({ revokedAt: new Date(), revokedBy: user.sub, updatedAt: new Date() })
          .where(eq(externalShares.id, id));
        await this.audit(tx, user, 'external_share.revoke', id);
      },
      { userId: user.sub },
    );
  }

  /** Extend — push expires_at FORWARD only, capped at the ceiling TTL. */
  async extend(
    user: AccessTokenPayload,
    id: string,
    input: ExtendExternalShare,
  ): Promise<ExternalShareView> {
    this.requireManager(user);
    return withTenant(
      user.orgId,
      async (tx) => {
        if (await isOrgSuspended(tx, user.orgId)) throw NOT_FOUND;
        const [before] = await tx
          .select()
          .from(externalShares)
          .where(and(eq(externalShares.id, id), isNull(externalShares.revokedAt)))
          .limit(1);
        if (!before) throw NOT_FOUND;
        // Forward-only: refuse to shorten via extend (use revoke to kill).
        if (before.expiresAt && input.expiresAt.getTime() <= before.expiresAt.getTime()) {
          throw new BadRequestException({ error: { code: 'not_forward' } });
        }
        // Cap at the party ceiling TTL from NOW.
        const ceiling = this.ceilingFor(before.partyType);
        if (ceiling.maxTtlDays !== null) {
          const cap = new Date(Date.now() + ceiling.maxTtlDays * 24 * 60 * 60 * 1000);
          if (input.expiresAt.getTime() > cap.getTime()) {
            throw new BadRequestException({ error: { code: 'exceeds_ceiling' } });
          }
        }
        const [row] = await tx
          .update(externalShares)
          .set({ expiresAt: input.expiresAt, updatedAt: new Date() })
          .where(eq(externalShares.id, id))
          .returning();
        if (!row) throw NOT_FOUND;
        await this.audit(tx, user, 'external_share.extend', id);
        return toViewMasked(tx, row);
      },
      { userId: user.sub },
    );
  }

  /** Resend — audited re-issue marker. The OTP-access + delivery channel is
   *  X-S4; here we only bump updated_at + log so the action is auditable and
   *  the slice carries the seam. Suspended/missing/revoked → 404. */
  async resend(user: AccessTokenPayload, id: string): Promise<ExternalShareView> {
    this.requireManager(user);
    return withTenant(
      user.orgId,
      async (tx) => {
        // Suspended-org inert: resend is a MUTATING re-delivery op, so it MUST
        // gate on suspension like create/update/revoke/extend (no re-issue for a
        // frozen org). Previously missing — a suspended org could still trigger a
        // resend marker. No-oracle: suspended → generic 404.
        if (await isOrgSuspended(tx, user.orgId)) throw NOT_FOUND;
        const [row] = await tx
          .update(externalShares)
          .set({ updatedAt: new Date() })
          .where(and(eq(externalShares.id, id), isNull(externalShares.revokedAt)))
          .returning();
        if (!row) throw NOT_FOUND;
        await this.audit(tx, user, 'external_share.resend', id);
        return toViewMasked(tx, row);
      },
      { userId: user.sub },
    );
  }

  /**
   * SEC-H1 — the party-share document RETRIEVAL authz path. Given an active
   * external-share grant + a candidate document id (+ whether the party has
   * completed the OTP step-up this session), FAIL-CLOSED resolves whether the
   * party may retrieve the doc and the serve constraints, by:
   *   1. re-reading the LIVE grant under the org's RLS (revocation + expiry are
   *      never stale — read at retrieval, not trusted from a mint-time token);
   *   2. resolving the doc's scope locator (project / building / apartment) +
   *      its sensitive / encrypted / servable facts in ONE set-based RLS read;
   *   3. handing both to the ONE shared pure resolver (`decideExternalPartyAccess`).
   *
   * RLS does TENANCY (a foreign-org doc is invisible → out-of-scope deny, never
   * an oracle); the resolver does POLICY (expiry / revocation / scope / sensitive
   * / OTP / download). Deny reasons are coarse + PII-free.
   *
   * NOTE (scope boundary): this is the PARTY (`external_shares`) retrieval path.
   * It does NOT touch the live contractor `shares` + JWT tier — that cutover onto
   * this resolver is a deliberate later step.
   */
  async resolveDocumentAccess(
    user: AccessTokenPayload,
    shareId: string,
    documentId: string,
    opts: { otpVerified: boolean } = { otpVerified: false },
  ): Promise<ExternalPartyDecision> {
    return withTenant(
      user.orgId,
      async (tx) => {
        // A suspended org's grants are INERT — fail-closed (treat as revoked).
        if (await isOrgSuspended(tx, user.orgId)) {
          return { allow: false, reason: 'share_revoked' };
        }

        // (1) LIVE grant re-read under RLS. A missing / cross-org grant is
        //     invisible (RLS) → fail-closed out-of-scope (no existence oracle).
        const [share] = await tx
          .select({
            scopeType: externalShares.scopeType,
            scopeIds: externalShares.scopeIds,
            permissions: externalShares.permissions,
            allowSensitive: externalShares.allowSensitive,
            otpRequired: externalShares.otpRequired,
            expiresAt: externalShares.expiresAt,
            revokedAt: externalShares.revokedAt,
            watermarkSubject: externalShares.watermarkSubject,
          })
          .from(externalShares)
          .where(eq(externalShares.id, shareId))
          .limit(1);
        if (!share) return { allow: false, reason: 'out_of_scope' };

        // (2) Doc facts + scope locator in ONE set-based read under RLS. The
        //     apartment→building chain resolves the building locator (documents
        //     hang off project_id / apartment_id only). A foreign-org or unknown
        //     doc is invisible under RLS → out-of-scope.
        //
        //     #5 (archived-project revocation): a doc whose owning project is
        //     ARCHIVED is treated as NON-servable here — archiving a project
        //     cuts external read access to its docs LIVE, even while the grant
        //     itself is unrevoked. The effective project is the doc's direct
        //     project_id OR, for an apartment doc, the apartment→building→
        //     project chain (COALESCE). A NULL effective project (org-level
        //     doc) is not project-gated. The project is joined on that
        //     coalesced id and its archived_at re-checked LIVE.
        const effectiveProjectId = sql`COALESCE(${documents.projectId}, ${buildings.projectId})`;
        const [doc] = await tx
          .select({
            sensitive: documents.sensitive,
            bytesEncrypted: documents.bytesEncrypted,
            docScope: documents.docScope,
            ownerId: documents.ownerId,
            projectId: documents.projectId,
            apartmentId: documents.apartmentId,
            buildingId: apartments.buildingId,
            // Servable iff finalized (uploaded) + scan-clean + not archived AND
            // its owning project is not archived (#5) — exactly the org/
            // contractor serve predicate, computed in-SQL so the resolver gets a
            // single boolean. `projects.archived_at IS NOT NULL` is false when
            // there is no effective project (LEFT JOIN miss → NULL), so an
            // org-level doc is never project-gated.
            servable: sql<boolean>`(
              ${documents.uploadedAt} IS NOT NULL
              AND ${documents.scanStatus} = 'clean'
              AND ${documents.archivedAt} IS NULL
              AND ${projects.archivedAt} IS NULL
            )`,
          })
          .from(documents)
          .leftJoin(apartments, eq(apartments.id, documents.apartmentId))
          .leftJoin(buildings, eq(buildings.id, apartments.buildingId))
          .leftJoin(projects, eq(projects.id, effectiveProjectId))
          .where(eq(documents.id, documentId))
          .limit(1);
        if (!doc) return { allow: false, reason: 'out_of_scope' };

        const inScope = isDocInShareScope(share.scopeType, share.scopeIds, {
          docScope: doc.docScope,
          ownerId: doc.ownerId,
          projectId: doc.projectId,
          buildingId: doc.buildingId,
          apartmentId: doc.apartmentId,
        });

        // (3) ONE shared pure resolver — the single decision point.
        return decideExternalPartyAccess(
          {
            permissions: share.permissions,
            allowSensitive: share.allowSensitive,
            otpRequired: share.otpRequired,
            expiresAt: share.expiresAt,
            revokedAt: share.revokedAt,
            watermarkSubject: share.watermarkSubject,
          },
          {
            sensitive: doc.sensitive,
            bytesEncrypted: doc.bytesEncrypted,
            inScope,
            servable: doc.servable,
          },
          { now: new Date(), otpVerified: opts.otpVerified },
        );
      },
      { userId: user.sub },
    );
  }

  async list(
    user: AccessTokenPayload,
    query: { limit: number; cursor?: string; partyType?: ExternalSharePartyType },
  ): Promise<ExternalShareListPage> {
    const { limit } = query;
    const cur = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cur) {
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }
    return withTenant(
      user.orgId,
      async (tx) => {
        // Suspended org → empty (inert), same no-oracle posture as the by-id
        // paths (they 404; a list simply yields nothing).
        if (await isOrgSuspended(tx, user.orgId)) {
          return { data: [], page: { limit, cursor: null, has_more: false } };
        }
        const keyset: SQL | undefined = cur
          ? keysetCondition(externalShares.createdAt, externalShares.id, cur)
          : undefined;
        const rows = await tx
          .select()
          .from(externalShares)
          .where(
            and(
              isNull(externalShares.revokedAt),
              query.partyType ? eq(externalShares.partyType, query.partyType) : undefined,
              keyset,
            ),
          )
          .orderBy(...keysetOrderBy(externalShares.createdAt, externalShares.id))
          .limit(limit + 1);
        const hasMore = rows.length > limit;
        const pageRows = hasMore ? rows.slice(0, limit) : rows;
        const last = pageRows[pageRows.length - 1];
        // Mask recipient PII INSIDE the tenant tx (decrypt round-trips need the
        // org context). Masked-only on the wire — never plaintext/ciphertext.
        const data = await Promise.all(pageRows.map((r) => toViewMasked(tx, r)));
        return {
          data,
          page: { limit, cursor: hasMore && last ? encodeCursor(last) : null, has_more: hasMore },
        };
      },
      { userId: user.sub },
    );
  }

  // ══════════════════════ party_request (who-owes-what) ═════════════════════
  //
  // The obligation ledger CRUD. NO delivery/fulfill here (that is 4.3) — a
  // request created here stays `open`; the linked grant's last_delivered_at
  // stays NULL. Every op is withTenant + isOrgSuspended-gated + no-oracle 404.

  /**
   * Create a who-owes-what obligation. Manager-only. The partial-unique index
   * enforces ONE live obligation per (org, project, party, doc-type) — a
   * duplicate open ask is rejected (`duplicate_obligation`, fail-closed via the
   * DB constraint, not a TOCTOU read). The bridge constraint is informational
   * here (4.1 never mints); it is the 4.2/4.3 auto-mint paths that hard-reject a
   * null-bridge party — we record the obligation regardless so who-owes is
   * complete.
   */
  async createPartyRequest(
    user: AccessTokenPayload,
    input: CreatePartyRequest,
  ): Promise<PartyRequestView> {
    this.requireManager(user);
    return withTenant(
      user.orgId,
      async (tx) => {
        if (await isOrgSuspended(tx, user.orgId)) throw NOT_FOUND;
        // The project must resolve live in-org (fail-closed; no cross-org oracle).
        const [proj] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, input.projectId), isNull(projects.archivedAt)))
          .limit(1);
        if (!proj) throw new BadRequestException({ error: { code: 'invalid_project' } });

        // If a grant is linked, it must resolve live in-org too (RLS + explicit).
        if (input.externalShareId) {
          const [grant] = await tx
            .select({ id: externalShares.id })
            .from(externalShares)
            .where(
              and(eq(externalShares.id, input.externalShareId), isNull(externalShares.revokedAt)),
            )
            .limit(1);
          if (!grant) throw new BadRequestException({ error: { code: 'invalid_share' } });
        }

        let row: PartyRequest | undefined;
        try {
          [row] = await tx
            .insert(partyRequests)
            .values({
              orgId: user.orgId,
              projectId: input.projectId,
              documentParty: input.documentParty,
              requestedDocType: input.requestedDocType ?? null,
              externalShareId: input.externalShareId ?? null,
              status: 'open',
              createdBy: user.sub,
            })
            .returning();
        } catch (e) {
          // Partial-unique violation ⇒ a live obligation already exists. Map to a
          // clean 400 (not a 500); never leak the constraint internals.
          if (isUniqueViolation(e)) {
            throw new BadRequestException({ error: { code: 'duplicate_obligation' } });
          }
          throw e;
        }
        if (!row) {
          throw new InternalServerErrorException({ error: { code: 'insert_no_row' } });
        }
        await this.auditTarget(tx, user, 'party_request.create', 'party_request', row.id, {
          projectId: row.projectId,
          documentParty: row.documentParty,
          requestedDocType: row.requestedDocType,
          // Whether the binder party is auto-mintable (bridge non-null) — a
          // PII-free hint the FE uses to gate the "invite" affordance.
          autoMintable:
            partyTypeForDocumentParty[
              row.documentParty as keyof typeof partyTypeForDocumentParty
            ] !== null,
        });
        return toPartyRequestView(row);
      },
      { userId: user.sub },
    );
  }

  /** List LIVE (open/delivered) obligations — the who-owes-what feed. Keyset
   *  paginated; optional project / party / status narrows. Suspended org →
   *  empty (inert). */
  async listOpenPartyRequests(
    user: AccessTokenPayload,
    query: ListPartyRequestsQueryDto,
  ): Promise<PartyRequestListPage> {
    const { limit } = query;
    const cur = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cur) {
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }
    return withTenant(
      user.orgId,
      async (tx) => {
        if (await isOrgSuspended(tx, user.orgId)) {
          return { data: [], page: { limit, cursor: null, has_more: false } };
        }
        const keyset: SQL | undefined = cur
          ? keysetCondition(partyRequests.createdAt, partyRequests.id, cur)
          : undefined;
        // Default feed = live obligations (open/delivered). An explicit status
        // narrows to exactly that status (incl. fulfilled/cancelled history).
        const statusCond = query.status
          ? eq(partyRequests.status, query.status)
          : inArray(partyRequests.status, ['open', 'delivered']);
        const rows = await tx
          .select()
          .from(partyRequests)
          .where(
            and(
              statusCond,
              query.projectId ? eq(partyRequests.projectId, query.projectId) : undefined,
              query.documentParty
                ? eq(partyRequests.documentParty, query.documentParty)
                : undefined,
              keyset,
            ),
          )
          .orderBy(...keysetOrderBy(partyRequests.createdAt, partyRequests.id))
          .limit(limit + 1);
        const hasMore = rows.length > limit;
        const pageRows = hasMore ? rows.slice(0, limit) : rows;
        const last = pageRows[pageRows.length - 1];
        return {
          data: pageRows.map(toPartyRequestView),
          page: { limit, cursor: hasMore && last ? encodeCursor(last) : null, has_more: hasMore },
        };
      },
      { userId: user.sub },
    );
  }

  /** Cancel an obligation — a STATUS transition to `cancelled` (DELETE is
   *  revoked at the DB layer). Idempotent: cancelling an already-terminal
   *  (cancelled/fulfilled) row is a no-op success. Suspended/missing → 404. */
  async cancelPartyRequest(user: AccessTokenPayload, id: string): Promise<PartyRequestView> {
    this.requireManager(user);
    return withTenant(
      user.orgId,
      async (tx) => {
        if (await isOrgSuspended(tx, user.orgId)) throw NOT_FOUND;
        const [before] = await tx
          .select()
          .from(partyRequests)
          .where(eq(partyRequests.id, id))
          .limit(1);
        if (!before) throw NOT_FOUND;
        if (before.status === 'cancelled' || before.status === 'fulfilled') {
          return toPartyRequestView(before); // idempotent no-op
        }
        const [row] = await tx
          .update(partyRequests)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(eq(partyRequests.id, id))
          .returning();
        if (!row) throw NOT_FOUND;
        await this.auditTarget(tx, user, 'party_request.cancel', 'party_request', row.id);
        return toPartyRequestView(row);
      },
      { userId: user.sub },
    );
  }

  private async audit(
    tx: TenantTx,
    user: AccessTokenPayload,
    action: string,
    targetId: string,
    afterState?: Record<string, unknown>,
  ): Promise<void> {
    await this.auditTarget(tx, user, action, 'external_share', targetId, afterState);
  }

  private async auditTarget(
    tx: TenantTx,
    user: AccessTokenPayload,
    action: string,
    targetTable: string,
    targetId: string,
    afterState?: Record<string, unknown>,
  ): Promise<void> {
    await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
      orgId: user.orgId,
      actorId: user.sub,
      actorType: 'user',
      action,
      targetTable,
      targetId,
      afterState,
      sessionId: user.sid,
    });
  }
}
