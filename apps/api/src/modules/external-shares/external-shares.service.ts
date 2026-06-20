import {
  apartments,
  AuditService,
  buildings,
  externalShares,
  isOrgSuspended,
  PARTY_PRESET_CEILINGS,
  projects,
  withTenant,
  type ExternalShare,
  type ExternalSharePartyType,
  type ExternalSharePermissions,
  type ExternalShareScopeType,
  type PartyPresetCeiling,
  type TenantTx,
} from '@emapp/db';
import type {
  CreateExternalShare,
  ExtendExternalShare,
  ExternalShareView,
  UpdateExternalShare,
} from '@emapp/shared-types';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';

import {
  decodeCursor,
  encodeCursor,
  keysetCondition,
  keysetOrderBy,
} from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';

export interface ExternalShareListPage {
  data: ExternalShareView[];
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

function toView(r: ExternalShare): ExternalShareView {
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
    revokedAt: r.revokedAt,
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
            createdBy: user.sub,
          })
          .returning();
        if (!row) {
          throw new InternalServerErrorException({ error: { code: 'insert_no_row' } });
        }
        await this.audit(tx, user, 'external_share.create', row.id, {
          partyType: row.partyType,
          scopeType: row.scopeType,
        });
        return toView(row);
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
            updatedAt: new Date(),
          })
          .where(eq(externalShares.id, id))
          .returning();
        if (!row) throw NOT_FOUND;
        await this.audit(tx, user, 'external_share.update', row.id);
        return toView(row);
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
    before: { scopeType: ExternalShareScopeType; permissions: ExternalSharePermissions; allowSensitive: boolean; otpRequired: boolean },
    next: { scopeType: ExternalShareScopeType; permissions: ExternalSharePermissions; allowSensitive: boolean; otpRequired: boolean },
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
        return toView(row);
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
        if (await isOrgSuspended(tx, user.orgId)) throw NOT_FOUND;
        const [row] = await tx
          .update(externalShares)
          .set({ updatedAt: new Date() })
          .where(and(eq(externalShares.id, id), isNull(externalShares.revokedAt)))
          .returning();
        if (!row) throw NOT_FOUND;
        await this.audit(tx, user, 'external_share.resend', id);
        return toView(row);
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
    const rows = await withTenant(
      user.orgId,
      async (tx) => {
        // Suspended org → empty (inert), same no-oracle posture as the by-id
        // paths (they 404; a list simply yields nothing).
        if (await isOrgSuspended(tx, user.orgId)) return [];
        const keyset: SQL | undefined = cur
          ? keysetCondition(externalShares.createdAt, externalShares.id, cur)
          : undefined;
        return tx
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
      },
      { userId: user.sub },
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map(toView),
      page: { limit, cursor: hasMore && last ? encodeCursor(last) : null, has_more: hasMore },
    };
  }

  private async audit(
    tx: TenantTx,
    user: AccessTokenPayload,
    action: string,
    targetId: string,
    afterState?: Record<string, unknown>,
  ): Promise<void> {
    await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
      orgId: user.orgId,
      actorId: user.sub,
      actorType: 'user',
      action,
      targetTable: 'external_share',
      targetId,
      afterState,
      sessionId: user.sid,
    });
  }
}
