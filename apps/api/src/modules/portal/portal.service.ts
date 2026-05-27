import {
  apartments,
  auditLog,
  buildings,
  db,
  documents,
  owners,
  ownerships,
  projects,
  signatureRequests,
  tenantSessions,
  withTenant,
} from '@emapp/db';
import type {
  TenantPortalApartment,
  TenantPortalDocument,
  TenantPortalMe,
  TenantPortalSignature,
} from '@emapp/shared-types';
import { Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { flushSessionCache } from '../auth/session-validity';
import type { TenantTokenPayload } from '../auth/tenant/tenant-auth.guard';

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });

// PII decryption via the transaction-scoped `app.encryption_key` GUC
// (set by withTenant per migration 0010). Decrypt happens INSIDE the SQL
// select so cleartext never leaves Postgres until the result row reaches
// the Node process — same pattern as owners.service.ts NAME_DECRYPTED
// (file:line apps/api/src/modules/owners/owners.service.ts:48). Per
// D.40, the tenant sees their OWN cleartext (no mask theatre).
const NAME_CLEAR = sql<string>`pgp_sym_decrypt(${owners.nameEncrypted}, current_setting('app.encryption_key'))::text`;
const NID_CLEAR = sql<string>`pgp_sym_decrypt(${owners.nationalIdEncrypted}, current_setting('app.encryption_key'))::text`;
const PHONE_CLEAR = sql<
  string | null
>`case when ${owners.phoneEncrypted} is null then null else pgp_sym_decrypt(${owners.phoneEncrypted}, current_setting('app.encryption_key'))::text end`;

/**
 * Tenant Portal — own-data view (D.40, V11 B.S4).
 *
 * Every read here is scoped by the authenticated tenant's `owner.id`
 * (the JWT `sub` for the `emapp-tenant` audience — see
 * apps/api/src/modules/auth/tenant/tenant-auth.guard.ts:7). The
 * caller cannot influence the scope: there is no `:id` path param,
 * no query `?ownerId=`, no body — the SUB claim is the entire
 * identity. Combined with `withTenant(tenant.orgId, ...)` the
 * org-tier RLS predicates still hold, so a forged orgId in the JWT
 * (an attacker who somehow minted a `tenant_access` token for an
 * unrelated org) cannot read anything: the tenant.sub owner row
 * also doesn't exist in the (forged) org, returning 0 rows.
 *
 * Out of scope for B.S4 (stays Phase 2 per D.40): milestones / FAQ /
 * benefits comparison / tenant questions. Only the apartment + docs +
 * signatures triad is exposed.
 */
@Injectable()
export class PortalService {
  /** `GET /portal/me` — the tenant's own owner record with cleartext PII. */
  async getMe(tenant: TenantTokenPayload): Promise<TenantPortalMe> {
    return withTenant(tenant.orgId, async (tx) => {
      const [row] = await tx
        .select({
          id: owners.id,
          organizationId: owners.orgId,
          name: NAME_CLEAR,
          email: owners.email,
          nationalId: NID_CLEAR,
          phone: PHONE_CLEAR,
          createdAt: owners.createdAt,
        })
        .from(owners)
        .where(and(eq(owners.id, tenant.sub), isNull(owners.archivedAt)))
        .limit(1);
      if (!row) throw NOT_FOUND;
      return row;
    });
  }

  /** `GET /portal/apartment` — apartments the tenant owns (active
   *  ownerships), joined to building + project for FE display. */
  async getApartments(tenant: TenantTokenPayload): Promise<{ data: TenantPortalApartment[] }> {
    const rows = await withTenant(tenant.orgId, async (tx) =>
      tx
        .select({
          aptId: apartments.id,
          aptBuildingId: apartments.buildingId,
          aptNumber: apartments.number,
          aptFloor: apartments.floor,
          aptSizeSqm: apartments.sizeSqm,
          aptAreaSqm: apartments.areaSqm,
          aptRooms: apartments.rooms,
          aptStatus: apartments.status,
          aptUnitType: apartments.unitType,
          aptEntrance: apartments.entrance,
          bldId: buildings.id,
          bldAddress: buildings.address,
          bldCity: buildings.city,
          prjId: projects.id,
          prjName: projects.name,
          prjStatus: projects.status,
          prjType: projects.type,
          ownPct: ownerships.ownershipPct,
          ownRole: ownerships.role,
        })
        .from(ownerships)
        .innerJoin(apartments, eq(apartments.id, ownerships.apartmentId))
        .innerJoin(buildings, eq(buildings.id, apartments.buildingId))
        .innerJoin(projects, eq(projects.id, buildings.projectId))
        .where(
          and(
            eq(ownerships.ownerId, tenant.sub),
            isNull(ownerships.endedAt),
            isNull(apartments.archivedAt),
          ),
        ),
    );

    return {
      data: rows.map((r) => ({
        apartment: {
          id: r.aptId,
          buildingId: r.aptBuildingId,
          number: r.aptNumber,
          floor: r.aptFloor,
          // numeric columns come back as strings from node-pg; normalise.
          sizeSqm: r.aptSizeSqm === null ? null : Number(r.aptSizeSqm),
          areaSqm: r.aptAreaSqm === null ? null : Number(r.aptAreaSqm),
          rooms: r.aptRooms === null ? null : Number(r.aptRooms),
          status: r.aptStatus,
          unitType: r.aptUnitType,
          entrance: r.aptEntrance,
        },
        building: { id: r.bldId, address: r.bldAddress, city: r.bldCity },
        project: { id: r.prjId, name: r.prjName, status: r.prjStatus, type: r.prjType },
        ownership: { pct: Number(r.ownPct), role: r.ownRole },
      })),
    };
  }

  /** `GET /portal/documents` — documents attached to one of the
   *  tenant's owned apartments. Project/org-level docs (apartmentId
   *  NULL) are intentionally excluded — those belong to the org-tier
   *  surface, not the tenant's own data view. */
  async getDocuments(tenant: TenantTokenPayload): Promise<{ data: TenantPortalDocument[] }> {
    const rows = await withTenant(tenant.orgId, async (tx) => {
      const ownedApts = tx
        .select({ id: apartments.id })
        .from(ownerships)
        .innerJoin(apartments, eq(apartments.id, ownerships.apartmentId))
        .where(
          and(
            eq(ownerships.ownerId, tenant.sub),
            isNull(ownerships.endedAt),
            isNull(apartments.archivedAt),
          ),
        );

      return tx
        .select({
          id: documents.id,
          apartmentId: documents.apartmentId,
          name: documents.name,
          type: documents.type,
          mimeType: documents.mimeType,
          sizeBytes: documents.sizeBytes,
          createdAt: documents.createdAt,
        })
        .from(documents)
        .where(
          and(
            isNull(documents.archivedAt),
            // Inner-query: tenant's own apartment ids. inArray with a
            // subquery is a single round-trip; no separate fetch.
            inArray(documents.apartmentId, ownedApts),
          ),
        )
        .orderBy(desc(documents.createdAt));
    });

    return {
      data: rows
        // The schema permits NULL apartmentId at the column level (docs
        // can be project-level); the WHERE/inArray excludes them, but
        // narrow the type here for the wire shape (apartmentId: required).
        .filter((r): r is typeof r & { apartmentId: string } => r.apartmentId !== null)
        .map((r) => ({
          id: r.id,
          apartmentId: r.apartmentId,
          name: r.name,
          type: r.type,
          mimeType: r.mimeType,
          sizeBytes: r.sizeBytes,
          createdAt: r.createdAt,
        })),
    };
  }

  /**
   * `POST /portal/logout` (Wave 4 M-1) — kill the current tenant
   * session immediately. Soft revoke (sets revoked_at; matches CLAUDE.md
   * "no permanent deletes"). Cache flush propagates inside this instance
   * immediately; other instances converge within the 15s session-cache
   * TTL. Idempotent: calling twice on the same sid is a no-op.
   *
   * Audit row uses actor_type='system' because the CHECK constraint
   * `audit_log_actor_type_valid` (migration 0014) limits the
   * discriminator to ('user','system','provider'). Tenant identity is
   * recorded via target_table='owners' + target_id=ownerId, matching
   * the pattern in otp.service.writeAuditSafe.
   */
  async logout(tenant: TenantTokenPayload): Promise<void> {
    const now = new Date();
    // BYPASSRLS pool — tenant_sessions has no RLS (auth infrastructure,
    // matches auth_sessions). We pass the sid from the guard-verified
    // JWT; an attacker can't supply someone else's sid because the JWT
    // signature binds sid to this exact owner+org.
    await db
      .update(tenantSessions)
      .set({ revokedAt: now })
      .where(and(eq(tenantSessions.id, tenant.sid), isNull(tenantSessions.revokedAt)));
    flushSessionCache();
    // Best-effort audit (matches otp.service writeAuditSafe pattern).
    try {
      await db.insert(auditLog).values({
        orgId: tenant.orgId,
        actorType: 'system',
        action: 'auth.tenant_logout',
        targetTable: 'owners',
        targetId: tenant.sub,
        afterState: { sid: tenant.sid },
      });
    } catch {
      // Best-effort: an audit-write failure must not surface to the user.
    }
  }

  /** `GET /portal/signatures` — signature requests where this tenant
   *  is the recipient. NEVER returns `jti` / signing URL (D.12 LAW —
   *  the token is the credential; it lives only in the original SMS). */
  async getSignatures(tenant: TenantTokenPayload): Promise<{ data: TenantPortalSignature[] }> {
    const rows = await withTenant(tenant.orgId, async (tx) =>
      tx
        .select({
          id: signatureRequests.id,
          documentId: signatureRequests.documentId,
          documentName: documents.name,
          status: signatureRequests.status,
          expiresAt: signatureRequests.expiresAt,
          createdAt: signatureRequests.createdAt,
          signedAt: signatureRequests.signedAt,
          cancelledAt: signatureRequests.cancelledAt,
        })
        .from(signatureRequests)
        .innerJoin(documents, eq(documents.id, signatureRequests.documentId))
        .where(eq(signatureRequests.ownerId, tenant.sub))
        .orderBy(desc(signatureRequests.createdAt)),
    );

    return {
      data: rows.map((r) => ({
        id: r.id,
        documentId: r.documentId,
        documentName: r.documentName,
        status: r.status as 'pending' | 'signed' | 'cancelled',
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
        signedAt: r.signedAt,
        cancelledAt: r.cancelledAt,
      })),
    };
  }
}
