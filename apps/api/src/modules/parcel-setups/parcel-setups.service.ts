import {
  AuditService,
  apartments,
  buildings,
  parcelSetups,
  projectAssignments,
  projects,
  withTenant,
  type ParcelSetup as ParcelSetupRow,
  type TenantTx,
} from '@emapp/db';
import {
  CreateParcelSetupInput,
  ListOwnershipsQuery,
  ParcelSetupPayload,
  type CreateParcelSetup,
  type ParcelSetup,
  type ParcelSetupPayloadDto,
  type ParcelSetupStatus,
} from '@emapp/shared-types';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, lt, or, type SQL } from 'drizzle-orm';

import { requireAgentCapability } from '../../common/authz/agent-capabilities';
import { decodeCursor, encodeCursor } from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });

/** Draft-only lifecycle writes (PATCH payload / confirm's single-claim). A
 * confirmed/discarded setup is terminal → 409 (the caller already passed
 * visibility, so the lifecycle state is not a secret here; for confirm
 * specifically the 409 IS the idempotency contract). */
const NOT_DRAFT = new ConflictException({ error: { code: 'parcel_setup_not_draft' } });

/** Confirm tripped an active-skeleton unique constraint
 * (apartments_building_number_active 0002 / buildings_project_address_active
 * 0029) — the drafted skeleton collides with what already exists in the
 * project. Clean 409; the whole tx (audit + claim + partial inserts) rolls
 * back, the setup stays a confirmable draft. Never a raw PG 23505 leak. */
const SKELETON_CONFLICT = new ConflictException({ error: { code: 'parcel_skeleton_conflict' } });

/** Confirm needs a saved draft payload (PATCH first). */
const PAYLOAD_MISSING = new BadRequestException({ error: { code: 'parcel_payload_missing' } });

/** The payload (or create input) failed the STRICT no-PII Zod schema. The
 * message NEVER echoes values — a poisoned payload could carry PII. */
const PAYLOAD_INVALID = new BadRequestException({ error: { code: 'validation_error' } });

/** The service no-query default MUST equal the Zod DTO default
 * (ListOwnershipsQuery.limit, currently 25). Derived, not hardcoded. */
const DEFAULT_LIST_LIMIT = ListOwnershipsQuery.parse({}).limit;

/** Walk the cause chain (drizzle/pg wrap differently per path) for a 23505 on
 * one of the active-skeleton unique indexes confirm can trip. Same posture as
 * projects.service's isDuplicateApartmentNumberError. */
function isSkeletonUniqueViolation(err: unknown): boolean {
  const constraints = new Set([
    'apartments_building_number_active',
    'buildings_project_address_active',
  ]);
  let cur: unknown = err;
  let depth = 0;
  while (cur && depth < 8) {
    const pg = cur as { code?: string; constraint?: string };
    if (pg.code === '23505' && pg.constraint && constraints.has(pg.constraint)) return true;
    cur = (cur as { cause?: unknown }).cause;
    depth += 1;
  }
  return false;
}

function toWire(r: ParcelSetupRow): ParcelSetup {
  return {
    id: r.id,
    projectId: r.projectId,
    blockNumber: r.blockNumber,
    parcelNumber: r.parcelNumber,
    subParcel: r.subParcel,
    status: r.status as ParcelSetupStatus,
    source: r.source,
    payload: (r.payload ?? null) as ParcelSetup['payload'],
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    confirmedAt: r.confirmedAt,
  };
}

export interface ParcelSetupListPage {
  data: ParcelSetup[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

/**
 * Parcel-setups domain service (P3a — the parcel-setup ENVELOPE + lifecycle +
 * the MANUAL path → physical skeleton; docs/DESIGN-phase3-parcel-autosetup.md
 * §1/§4/§6 P3a/§7.1).
 *
 * A parcel_setup is the PROJECT-attached envelope around a single גוש-חלקה
 * setup run: block+parcel(+sub) in, a draft buildings/apartments jsonb payload
 * (STRICT no-PII Zod — re-parsed HERE, defense-in-depth), and a
 * draft→confirmed/discarded lifecycle. CONFIRM materializes the skeleton
 * (buildings + apartments) atomically with provenance
 * (buildings.source_parcel_setup_id). MANUAL path only this slice — NO
 * provider seam, NO constructor deps (IParcelDataProvider is P3b).
 *
 * Tenant isolation is direct org_id (FORCE RLS, mirror tabu_extractions 0068)
 * inside withTenant. Authz mirrors buildings (the project is the parent
 * resource): manager/viewer see all org rows; an agent only setups whose
 * project is an active assignment. Every WRITE (create / updatePayload /
 * confirm) additionally runs the FINE agent gate
 * requireAgentCapability('edit_project_data') in its OWN named method (D.54 —
 * the static guard does not cover named service methods).
 */
@Injectable()
export class ParcelSetupsService {
  // Throws 404 unless the project is visible to this user (org via RLS +,
  // for agents, an active assignment). Mirrors BuildingsService.
  private async assertProjectVisible(
    tx: TenantTx,
    user: AccessTokenPayload,
    projectId: string,
  ): Promise<void> {
    if (user.role === 'agent') {
      const [row] = await tx
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
        .limit(1);
      if (!row) throw NOT_FOUND;
      return;
    }
    const [row] = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!row) throw NOT_FOUND;
  }

  // Load the setup + enforce via-parent visibility (no-oracle 404).
  private async loadVisibleSetup(
    tx: TenantTx,
    user: AccessTokenPayload,
    id: string,
  ): Promise<ParcelSetupRow> {
    const [row] = await tx.select().from(parcelSetups).where(eq(parcelSetups.id, id)).limit(1);
    // Foreign / unknown / cross-org (RLS hides it) → no-oracle 404.
    if (!row) throw NOT_FOUND;
    // For an agent, the parent project must be an active assignment.
    if (user.role === 'agent') await this.assertProjectVisible(tx, user, row.projectId);
    return row;
  }

  /**
   * POST /projects/:projectId/parcel-setups — create a 'draft' envelope on an
   * EXISTING project (§7.1-4). Gates (in order — never an oracle):
   *   1. project visible (RLS org + agent assigned-project) → else 404;
   *   2. D.54 — requireAgentCapability('edit_project_data') in THIS named
   *      method (the static guard does not cover named service methods).
   */
  async create(
    user: AccessTokenPayload,
    projectId: string,
    input: CreateParcelSetup,
  ): Promise<ParcelSetup> {
    // Defense-in-depth: re-parse even though the controller's Zod pipe already
    // validated (this service is also driven directly by internal callers).
    const parsedInput = CreateParcelSetupInput.safeParse(input);
    if (!parsedInput.success) throw PAYLOAD_INVALID;

    return withTenant(
      user.orgId,
      async (tx) => {
        await this.assertProjectVisible(tx, user, projectId);
        await requireAgentCapability(tx, user, 'edit_project_data');

        const [row] = await tx
          .insert(parcelSetups)
          .values({
            orgId: user.orgId,
            projectId,
            blockNumber: parsedInput.data.blockNumber,
            parcelNumber: parsedInput.data.parcelNumber,
            subParcel: parsedInput.data.subParcel ?? null,
            status: 'draft',
            source: 'manual',
            createdBy: user.sub,
          })
          .returning();
        if (!row) throw NOT_FOUND;

        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'parcel_setup.create',
          targetTable: 'parcel_setups',
          targetId: row.id,
          afterState: { projectId, status: row.status, source: row.source },
          sessionId: user.sid,
        });
        return toWire(row);
      },
      { userId: user.sub },
    );
  }

  /**
   * PATCH /parcel-setups/:id — save the draft buildings/apartments JSON.
   * DRAFT-only (409). The payload is Zod-parsed with the STRICT no-PII schema
   * IN THE SERVICE (defense-in-depth — a PII-looking key like
   * ownerName/nationalId/phone at ANY level is rejected and nothing is saved).
   */
  async updatePayload(
    user: AccessTokenPayload,
    id: string,
    payload: unknown,
  ): Promise<ParcelSetup> {
    const parsed = ParcelSetupPayload.safeParse(payload);
    if (!parsed.success) throw PAYLOAD_INVALID;

    return withTenant(
      user.orgId,
      async (tx) => {
        const setup = await this.loadVisibleSetup(tx, user, id);
        // D.54 — fine agent gate for this WRITE, in its own named method.
        await requireAgentCapability(tx, user, 'edit_project_data');
        if (setup.status !== 'draft') throw NOT_DRAFT;

        const [row] = await tx
          .update(parcelSetups)
          .set({ payload: parsed.data })
          .where(eq(parcelSetups.id, setup.id))
          .returning();
        if (!row) throw NOT_FOUND;

        // Audit — ids + COUNTS only. Never the addresses (user-entered text).
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'parcel_setup.update_payload',
          targetTable: 'parcel_setups',
          targetId: setup.id,
          metadata: {
            projectId: setup.projectId,
            buildingCount: parsed.data.buildings.length,
            apartmentCount: parsed.data.buildings.reduce((n, b) => n + b.apartments.length, 0),
          },
          sessionId: user.sid,
        });
        return toWire(row);
      },
      { userId: user.sub },
    );
  }

  /**
   * POST /parcel-setups/:id/confirm — THE manual-path commit. ONE withTenant
   * tx, in this exact order:
   *
   *   1. Gates: visibility (no-oracle 404) → D.54
   *      requireAgentCapability('edit_project_data') in THIS named method
   *      (spec B3 pins the gate on confirm itself, not only create).
   *   2. Payload present + STRICT re-parse (defense-in-depth; the stored jsonb
   *      is re-validated before it can drive writes).
   *   3. Audit 'parcel_setup.confirm' FIRST — metadata ids + counts ONLY
   *      (never addresses/PII). Inside the tx: any later throw rolls it back,
   *      so a failed confirm leaves ZERO orphan audit trace.
   *   4. IDEMPOTENT SINGLE-CLAIM: UPDATE … SET status='confirmed',
   *      confirmed_at=now() WHERE id=:id AND status='draft' RETURNING. No row
   *      claimed (second confirm / discarded) → 409, tx rolls back.
   *   5. Create the skeleton: one building per payload entry (city falls back
   *      to the public block/parcel label — buildings.city is NOT NULL; the
   *      preview screen always passes city), stamped
   *      source_parcel_setup_id = :id (provenance, mirror 0071), then its
   *      apartments (number + floor). floorsCount/number are DRAFT-only hints
   *      — no building columns, not mapped.
   *
   * A unique-constraint collision with the project's EXISTING skeleton
   * (apartments_building_number_active / buildings_project_address_active) is
   * caught and mapped to a clean 409 parcel_skeleton_conflict with FULL
   * rollback — no partial skeleton, no orphan audit, setup stays 'draft'.
   */
  async confirm(user: AccessTokenPayload, id: string): Promise<ParcelSetup> {
    try {
      return await withTenant(
        user.orgId,
        async (tx) => {
          const setup = await this.loadVisibleSetup(tx, user, id);
          // D.54 — fine agent gate in this named method, BEFORE any write.
          await requireAgentCapability(tx, user, 'edit_project_data');

          if (!setup.payload) throw PAYLOAD_MISSING;
          const parsed = ParcelSetupPayload.safeParse(setup.payload);
          if (!parsed.success) throw PAYLOAD_INVALID;
          const payload: ParcelSetupPayloadDto = parsed.data;
          const buildingCount = payload.buildings.length;
          const apartmentCount = payload.buildings.reduce((n, b) => n + b.apartments.length, 0);

          // Audit-FIRST (ids + counts ONLY — never the user-entered
          // addresses). Inside the tx: a later 409/23505 rolls it back, so a
          // failed confirm leaves no audit trace (spec F: zero orphan audit).
          await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: 'parcel_setup.confirm',
            targetTable: 'parcel_setups',
            targetId: setup.id,
            metadata: { projectId: setup.projectId, buildingCount, apartmentCount },
            sessionId: user.sid,
          });

          // IDEMPOTENT single-claim: only a DRAFT confirms, exactly once. A
          // second confirm (or a discarded setup) claims no row → 409.
          const [claimed] = await tx
            .update(parcelSetups)
            .set({ status: 'confirmed', confirmedAt: new Date() })
            .where(and(eq(parcelSetups.id, setup.id), eq(parcelSetups.status, 'draft')))
            .returning();
          if (!claimed) throw NOT_DRAFT;

          // Materialize the skeleton. buildings.city is NOT NULL — the spec/
          // preview screen always passes city; the public block/parcel label
          // is the sensible fallback (no PII, no invented data).
          const cityFallback = `גוש ${setup.blockNumber} חלקה ${setup.parcelNumber}`;
          for (const b of payload.buildings) {
            const [building] = await tx
              .insert(buildings)
              .values({
                projectId: setup.projectId,
                address: b.address,
                city: b.city ?? cityFallback,
                sourceParcelSetupId: setup.id,
              })
              .returning({ id: buildings.id });
            if (!building) throw NOT_FOUND;
            for (const a of b.apartments) {
              await tx.insert(apartments).values({
                buildingId: building.id,
                number: a.number,
                floor: a.floor ?? null,
              });
            }
          }

          return toWire(claimed);
        },
        { userId: user.sub },
      );
    } catch (e) {
      // Active-skeleton unique collision → clean 409 (the tx already rolled
      // back EVERYTHING above: audit, claim, partial buildings). Never leak
      // the raw PG error (its detail echoes the colliding address).
      if (isSkeletonUniqueViolation(e)) throw SKELETON_CONFLICT;
      throw e;
    }
  }

  /** GET /projects/:projectId/parcel-setups — org-scoped list (no-oracle 404
   *  on a foreign/unknown project), keyset-paginated. */
  async list(
    user: AccessTokenPayload,
    projectId: string,
    query?: { limit?: number; cursor?: string },
  ): Promise<ParcelSetupListPage> {
    const limit = query?.limit ?? DEFAULT_LIST_LIMIT;
    const cur = query?.cursor ? decodeCursor(query.cursor) : null;
    if (query?.cursor && !cur) {
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }
    const rows = await withTenant(
      user.orgId,
      async (tx) => {
        await this.assertProjectVisible(tx, user, projectId);
        const keyset: SQL | undefined = cur
          ? or(
              lt(parcelSetups.createdAt, new Date(cur.c)),
              and(eq(parcelSetups.createdAt, new Date(cur.c)), lt(parcelSetups.id, cur.i)),
            )
          : undefined;
        return tx
          .select()
          .from(parcelSetups)
          .where(and(eq(parcelSetups.projectId, projectId), keyset))
          .orderBy(desc(parcelSetups.createdAt), desc(parcelSetups.id))
          .limit(limit + 1);
      },
      { userId: user.sub },
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      data: pageRows.map(toWire),
      page: { limit, cursor: hasMore && last ? encodeCursor(last) : null, has_more: hasMore },
    };
  }

  /** GET /parcel-setups/:id — org-scoped no-oracle 404. */
  async getOne(user: AccessTokenPayload, id: string): Promise<ParcelSetup> {
    const row = await withTenant(user.orgId, async (tx) => this.loadVisibleSetup(tx, user, id), {
      userId: user.sub,
    });
    return toWire(row);
  }
}
