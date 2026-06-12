import {
  AuditService,
  apartments,
  buildings,
  owners,
  ownerships,
  projectAssignments,
  projects,
  withTenant,
  type TenantTx,
} from '@emapp/db';
import {
  RelationshipSchema,
  SetOwnershipsInput,
  deriveShareFraction,
  fractionToPct,
  type ApartmentOwner,
  type Ownership,
  type SetOwnerships,
} from '@emapp/shared-types';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

import { canViewOwners } from '../../common/authz/agent-capabilities';
import { decodeCursor, encodeCursor } from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';

export interface OwnershipListPage {
  data: Ownership[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}
export interface ApartmentOwnerListPage {
  data: ApartmentOwner[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });
const FORBIDDEN = new ForbiddenException({ error: { code: 'forbidden' } });
const SUM_INVALID = new BadRequestException({ error: { code: 'ownership_sum_invalid' } });

function toOwnership(r: typeof ownerships.$inferSelect): Ownership {
  return {
    id: r.id,
    apartmentId: r.apartmentId,
    ownerId: r.ownerId,
    ownershipPct: Number(r.ownershipPct),
    // S3b — surface the EXACT share fraction alongside the compat percent.
    shareNumerator: Number(r.shareNumerator),
    shareDenominator: Number(r.shareDenominator),
    // Feature A (D.25): the relationship discriminator. Post-0066 the DB column
    // is `text` pinned by a CHECK ('owner') so we narrow it through the
    // shared-types enum — the single source of truth for the closed set —
    // rather than a bare cast. A row outside the set is a data-integrity bug,
    // not a 200.
    relationship: RelationshipSchema.parse(r.relationship),
    role: r.role,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** One row of an atomic ownership-set replacement (the 3b semantics). */
export interface OwnershipReplacementEntry {
  ownerId: string;
  shareNumerator: number;
  shareDenominator: number;
  relationship: 'owner' | 'renter';
  role?: string | null;
  /** S7c provenance (migration 0071) — the tabu extraction whose confirm
   *  wrote this row. NULL for the manual replaceSet / import paths. */
  sourceExtractionId?: string | null;
}

/**
 * THE trigger-sensitive atomic full-set replace (3b semantics) — end ALL
 * currently-active ownerships of the apartment + insert the new set in the
 * CALLER'S tx, so the DEFERRED sum trigger (migration 0065) validates the
 * exact fraction-sum = 1 (over relationship='owner' rows) at COMMIT.
 *
 * Single shared mechanic for every replace path (manual PUT replaceSet AND
 * the S7c tabu confirm) — do NOT re-implement the end+insert pair anywhere
 * else; a partial copy that splits the two statements across transactions
 * trips the trigger mid-way. ownership_pct is ALWAYS recomputed from the
 * canonical fraction (round(num/den*100, 2)) so the compat percent cannot
 * drift from the exact share.
 */
export async function replaceApartmentOwnershipSet(
  tx: TenantTx,
  apartmentId: string,
  entries: OwnershipReplacementEntry[],
): Promise<(typeof ownerships.$inferSelect)[]> {
  // End every currently-active ownership for the apartment.
  await tx
    .update(ownerships)
    .set({ endedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(ownerships.apartmentId, apartmentId), isNull(ownerships.endedAt)));

  if (entries.length === 0) return [];
  return tx
    .insert(ownerships)
    .values(
      entries.map((e) => ({
        apartmentId,
        ownerId: e.ownerId,
        ownershipPct: String(fractionToPct(e.shareNumerator, e.shareDenominator)),
        shareNumerator: e.shareNumerator,
        shareDenominator: e.shareDenominator,
        relationship: e.relationship,
        role: e.role ?? null,
        sourceExtractionId: e.sourceExtractionId ?? null,
      })),
    )
    .returning();
}

// Masked owner columns — identical policy to OwnersService (decrypt+mask
// in SQL via the transaction-scoped app.encryption_key GUC; clear PII
// never leaves Postgres).
const NID_MASK = sql<string>`'•••••••' || right(pgp_sym_decrypt(${owners.nationalIdEncrypted}, current_setting('app.encryption_key'))::text, 2)`;
const PHONE_MASK = sql<
  string | null
>`case when ${owners.phoneEncrypted} is null then null else '•••••' || right(pgp_sym_decrypt(${owners.phoneEncrypted}, current_setting('app.encryption_key'))::text, 4) end`;

/**
 * Ownerships domain service (Phase 3 Slice 5).
 *
 * Writes are an ATOMIC FULL-SET REPLACE per apartment — mandated by the
 * locked Phase-1 constraint trigger (active shares must total 0 or exactly
 * 100 at COMMIT). One withTenant tx: end all current active ownerships,
 * insert the new set; the deferred trigger validates the final total.
 *
 * via-parent isolation (ownership → apartment → building → project → org)
 * by RLS. D.17: read = any org role (agent only for assigned-project
 * apartments); write = manager. The sum rule is validated in-app BEFORE
 * the write (clean 400 ownership_sum_invalid); the DB trigger is the
 * authoritative backstop and its raise is also mapped to 400 (never 500).
 */
@Injectable()
export class OwnershipsService {
  private requireManager(user: AccessTokenPayload): void {
    if (user.role !== 'manager') throw FORBIDDEN;
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

  async list(
    user: AccessTokenPayload,
    apartmentId: string,
    query: { limit: number; cursor?: string },
  ): Promise<OwnershipListPage> {
    const { limit } = query;
    const cur = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cur) {
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }
    const rows = await withTenant(
      user.orgId,
      async (tx) => {
        await this.assertApartmentVisible(tx, user, apartmentId);
        const keyset: SQL | undefined = cur
          ? or(
              lt(ownerships.createdAt, new Date(cur.c)),
              and(eq(ownerships.createdAt, new Date(cur.c)), lt(ownerships.id, cur.i)),
            )
          : undefined;
        return tx
          .select()
          .from(ownerships)
          .where(and(eq(ownerships.apartmentId, apartmentId), isNull(ownerships.endedAt), keyset))
          .orderBy(desc(ownerships.createdAt), desc(ownerships.id))
          .limit(limit + 1);
      },
      { userId: user.sub },
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map(toOwnership),
      page: { limit, cursor: hasMore && last ? encodeCursor(last) : null, has_more: hasMore },
    };
  }

  // docs/09 §3.13 GET /apartments/:id/owners — masked Owner + share.
  async listApartmentOwners(
    user: AccessTokenPayload,
    apartmentId: string,
    query: { limit: number; cursor?: string },
  ): Promise<ApartmentOwnerListPage> {
    const { limit } = query;
    const cur = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cur) {
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }
    const rows = await withTenant(
      user.orgId,
      async (tx) => {
        await this.assertApartmentVisible(tx, user, apartmentId);
        // D.54 — the `view_owners` gate applies to EVERY owner-bearing surface,
        // not just /owners. An agent assigned to the apartment's project but
        // WITHOUT view_owners sees the apartment yet NO owners → full deny here
        // too (manager/viewer always pass). Mirrors OwnersService.list. PII is
        // masked for everyone (reveal-on-demand for cleartext).
        if (!(await canViewOwners(tx, user))) throw FORBIDDEN;
        const keyset: SQL | undefined = cur
          ? or(
              lt(ownerships.createdAt, new Date(cur.c)),
              and(eq(ownerships.createdAt, new Date(cur.c)), lt(ownerships.id, cur.i)),
            )
          : undefined;
        return tx
          .select({
            ownershipId: ownerships.id,
            ownershipPct: ownerships.ownershipPct,
            // S3d — surface the EXACT Tabu share fraction per co-owner so the FE
            // can render "1/3" beside the lossy compat percent.
            shareNumerator: ownerships.shareNumerator,
            shareDenominator: ownerships.shareDenominator,
            relationship: ownerships.relationship,
            role: ownerships.role,
            id: owners.id,
            organizationId: owners.orgId,
            // v8 §v8-S3 — decrypt inside SQL (same pattern as
            // NID_MASK / PHONE_MASK); never expose ciphertext.
            name: sql<string>`pgp_sym_decrypt(${owners.nameEncrypted}, current_setting('app.encryption_key'))::text`,
            email: owners.email,
            nationalIdMasked: NID_MASK,
            phoneMasked: PHONE_MASK,
            notes: owners.notes,
            createdAt: owners.createdAt,
            updatedAt: owners.updatedAt,
            archivedAt: owners.archivedAt,
          })
          .from(ownerships)
          .innerJoin(owners, eq(owners.id, ownerships.ownerId))
          .where(and(eq(ownerships.apartmentId, apartmentId), isNull(ownerships.endedAt), keyset))
          .orderBy(desc(ownerships.createdAt), desc(ownerships.id))
          .limit(limit + 1);
      },
      { userId: user.sub },
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    const data: ApartmentOwner[] = pageRows.map((r) => ({
      id: r.id,
      organizationId: r.organizationId,
      name: r.name,
      email: r.email,
      nationalIdMasked: r.nationalIdMasked,
      phoneMasked: r.phoneMasked,
      notes: r.notes,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      archivedAt: r.archivedAt,
      ownershipId: r.ownershipId,
      ownershipPct: Number(r.ownershipPct),
      // S3d — EXACT share fraction (bigint columns → number; both NOT NULL with
      // DB defaults, so always present). Lets the FE show "1/3" not just 33.33%.
      shareNumerator: Number(r.shareNumerator),
      shareDenominator: Number(r.shareDenominator),
      // Feature A (D.25) — surface owner/renter on the masked projection.
      // PII handling is IDENTICAL for both (name/national_id/phone masked the
      // same above); relationship only governs display + the signature gate.
      relationship: RelationshipSchema.parse(r.relationship),
      role: r.role,
    }));
    return {
      data,
      page: {
        limit,
        cursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
        has_more: hasMore,
      },
    };
  }

  /**
   * Atomically replace the apartment's active ownership set. End all
   * current active rows + insert the new set in ONE tx so the deferred
   * trigger sees exactly 100 (or 0 when clearing). Sum/uniqueness already
   * Zod-validated; we still re-guard and map the trigger raise to 400.
   */
  async replaceSet(
    user: AccessTokenPayload,
    apartmentId: string,
    input: SetOwnerships,
  ): Promise<Ownership[]> {
    this.requireManager(user);
    try {
      return await withTenant(
        user.orgId,
        async (tx) => {
          await this.assertApartmentVisible(tx, user, apartmentId);

          if (input.owners.length > 0) {
            // Feature A (D.25): only OWNERS count toward the 100% invariant
            // (renters carry pct 0, excluded) and each row's pct↔relationship
            // rule (owner ⇒ >0, renter ⇒ ===0) must hold. We re-run the
            // SHARED-TYPES schema (single source of truth) rather than
            // re-implement the sum here, so this in-app 400 agrees EXACTLY with
            // the DB constraint trigger predicate `... AND relationship='owner'`.
            // The controller already Zod-validated; this is the defense-in-depth
            // re-guard the existing contract mandated (it mapped a re-summed
            // mismatch to ownership_sum_invalid).
            if (!SetOwnershipsInput.safeParse(input).success) throw SUM_INVALID;

            // All referenced owners must exist & be active in this org
            // (RLS scopes the query to the caller's org).
            const ids = input.owners.map((o) => o.ownerId);
            const found = await tx
              .select({ id: owners.id })
              .from(owners)
              .where(and(inArray(owners.id, ids), isNull(owners.archivedAt)));
            if (found.length !== ids.length) throw NOT_FOUND;
          }

          // S7c — the atomic end-all + insert-new pair lives in the SHARED
          // replaceApartmentOwnershipSet helper (also used by the tabu
          // confirm). S3b — derive-on-write: prefer an explicit fraction,
          // else derive num/den from pct; ownership_pct is recomputed from
          // the canonical fraction inside the helper. Feature A (D.25) —
          // `relationship` rides along per row; the DB trigger sums only
          // 'owner' rows.
          const created = await replaceApartmentOwnershipSet(
            tx,
            apartmentId,
            input.owners.map((o) => {
              const { numerator, denominator } = deriveShareFraction(o);
              return {
                ownerId: o.ownerId,
                shareNumerator: numerator,
                shareDenominator: denominator,
                relationship: o.relationship,
                role: o.role ?? null,
              };
            }),
          );

          await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: 'ownership.replace_set',
            targetTable: 'ownerships',
            targetId: apartmentId,
            afterState: {
              apartmentId,
              count: input.owners.length,
              ownerIds: input.owners.map((o) => o.ownerId),
            },
            sessionId: user.sid,
          });
          return created.map(toOwnership);
        },
        { userId: user.sub },
      );
    } catch (e) {
      // Deferred trigger backstop: its COMMIT-time RAISE must surface as a
      // clean 400, never a 500 (it should not fire — we pre-validate).
      if (isOwnershipSumRaise(e)) throw SUM_INVALID;
      throw e;
    }
  }
}

export function isOwnershipSumRaise(e: unknown): boolean {
  let cur: unknown = e;
  let depth = 0;
  while (cur && depth < 6) {
    const m = (cur as { message?: string }).message;
    // S3b — the sum trigger now raises on the FRACTION invariant
    // ("Sum of ownership shares must equal the whole (1) …"). The legacy
    // percent message ("…percentages must equal 100") is gone, but we keep
    // matching it too for back-compat with any not-yet-migrated environment.
    if (
      typeof m === 'string' &&
      (m.includes('Sum of ownership shares must equal the whole') ||
        m.includes('Sum of ownership percentages must equal 100'))
    ) {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
    depth += 1;
  }
  return false;
}
