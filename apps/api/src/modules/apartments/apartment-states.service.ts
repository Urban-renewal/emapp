import {
  apartments,
  apartmentStates,
  AuditService,
  buildings,
  isOrgSuspended,
  projects,
  withTenant,
} from '@emapp/db';
import {
  BLOCKING_APARTMENT_STATE_KINDS,
  type ApartmentStateKind,
  type ApartmentStateView,
  type CreateApartmentState,
} from '@emapp/shared-types';
import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';

import type { AccessTokenPayload } from '../auth/auth.service';

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });
const FORBIDDEN = new ForbiddenException({ error: { code: 'forbidden' } });

/** The apartment-state projection. NO PII columns exist on apartment_states, so the
 *  projection is simply the public fields (ids + taxonomy + bounded labels). */
const apartmentStateCols = {
  id: apartmentStates.id,
  apartmentId: apartmentStates.apartmentId,
  kind: apartmentStates.kind,
  subKind: apartmentStates.subKind,
  note: apartmentStates.note,
  status: apartmentStates.status,
  createdAt: apartmentStates.createdAt,
  resolvedAt: apartmentStates.resolvedAt,
} as const;

interface ApartmentStateRow {
  id: string;
  apartmentId: string;
  kind: ApartmentStateKind;
  subKind: string | null;
  note: string | null;
  status: 'active' | 'resolved';
  createdAt: Date;
  resolvedAt: Date | null;
}

const BLOCKING_SET = new Set<ApartmentStateKind>(BLOCKING_APARTMENT_STATE_KINDS);

const toView = (r: ApartmentStateRow): ApartmentStateView => ({
  id: r.id,
  apartmentId: r.apartmentId,
  kind: r.kind,
  subKind: r.subKind,
  note: r.note,
  status: r.status,
  isBlocking: BLOCKING_SET.has(r.kind),
  createdAt: r.createdAt.toISOString(),
  resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
});

/**
 * Slice 2.7 — apartment legal/life-state service (PII-FREE — the structural mirror
 * of OwnerStatesService minus the guardian-encryption machinery).
 *
 * Apartment-states are ORG-scoped (apartment_states.org_id → direct RLS inside
 * withTenant); a cross-org apartment id ⇒ 0 apartment rows ⇒ 404 (no oracle).
 * Manager-gated writes (create/resolve); reads are any-org-role (the controller's
 * coarse `apartments.read` permission gates the tier; RLS owns the org boundary —
 * fine `requireManager` because agents already hold the coarse apartments-update
 * cap and we want a tighter manager-tier gate on legal-state writes).
 *
 * The apartment is reached via building → project (apartments are NOT org-scoped),
 * so existence is asserted by joining the apartment to a project IN the caller's org
 * — a no-oracle 404 when the apartment is missing / archived / cross-org.
 */
@Injectable()
export class ApartmentStatesService {
  private requireManager(user: AccessTokenPayload): void {
    if (user.role !== 'manager') throw FORBIDDEN;
  }

  /** Assert the apartment exists AND belongs to the caller's org (via its project),
   *  and is not archived. 404 (no oracle) when missing/cross-org/archived. The org
   *  match is the load-bearing isolation check: apartments are NOT org-scoped — they
   *  are reached through building → project, and only the project carries org_id. A
   *  cross-org apartment id resolves the row but fails the `projects.orgId` join →
   *  no-oracle 404 (same status as a missing apartment). */
  private async assertApartmentInOrg(
    tx: Parameters<Parameters<typeof withTenant>[1]>[0],
    apartmentId: string,
    orgId: string,
  ): Promise<void> {
    const [row] = await tx
      .select({ id: apartments.id })
      .from(apartments)
      .innerJoin(buildings, eq(buildings.id, apartments.buildingId))
      .innerJoin(projects, eq(projects.id, buildings.projectId))
      .where(
        and(
          eq(apartments.id, apartmentId),
          isNull(apartments.archivedAt),
          eq(projects.orgId, orgId),
        ),
      )
      .limit(1);
    if (!row) throw NOT_FOUND;
  }

  /**
   * List the ACTIVE, non-archived apartment-states for one apartment. Any org role
   * (read). Newest first.
   */
  async listForApartment(
    user: AccessTokenPayload,
    apartmentId: string,
  ): Promise<ApartmentStateView[]> {
    return withTenant(
      user.orgId,
      async (tx) => {
        // Fail-closed parity with the write paths: a suspended org surfaces no
        // apartment-state data (no-oracle 404, never a partial/leaky read).
        if (await isOrgSuspended(tx, user.orgId)) throw NOT_FOUND;
        await this.assertApartmentInOrg(tx, apartmentId, user.orgId);
        const rows = await tx
          .select(apartmentStateCols)
          .from(apartmentStates)
          .where(
            and(
              eq(apartmentStates.apartmentId, apartmentId),
              eq(apartmentStates.status, 'active'),
              isNull(apartmentStates.archivedAt),
            ),
          )
          .orderBy(desc(apartmentStates.createdAt), desc(apartmentStates.id));
        return rows.map(toView);
      },
      { userId: user.sub },
    );
  }

  /**
   * Create an apartment-state (manager only). PII-FREE — the audit afterState records
   * the kind + the bounded non-PII labels supplied (which are not PII by contract).
   */
  async create(
    user: AccessTokenPayload,
    apartmentId: string,
    input: CreateApartmentState,
  ): Promise<ApartmentStateView> {
    this.requireManager(user);
    return withTenant(
      user.orgId,
      async (tx) => {
        if (await isOrgSuspended(tx, user.orgId)) throw NOT_FOUND;
        await this.assertApartmentInOrg(tx, apartmentId, user.orgId);

        const [ins] = await tx
          .insert(apartmentStates)
          .values({
            orgId: user.orgId,
            apartmentId,
            kind: input.kind,
            subKind: input.subKind ?? null,
            note: input.note ?? null,
            status: 'active',
            createdBy: user.sub,
          })
          .returning({ id: apartmentStates.id });
        if (!ins)
          throw new InternalServerErrorException({
            error: { code: 'insert_no_row', message: 'unexpected db state' },
          });

        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'apartment_state.create',
          targetTable: 'apartment_states',
          targetId: ins.id,
          // PII-FREE afterState: the kind + the bounded non-PII labels (subKind/note
          // are bounded free-text the caller is contracted not to fill with PII).
          afterState: {
            kind: input.kind,
            ...(input.subKind ? { subKind: input.subKind } : {}),
            hasNote: Boolean(input.note),
          },
          sessionId: user.sid,
        });

        const [row] = await tx
          .select(apartmentStateCols)
          .from(apartmentStates)
          .where(eq(apartmentStates.id, ins.id))
          .limit(1);
        if (!row)
          throw new InternalServerErrorException({
            error: { code: 'reload_no_row', message: 'unexpected db state' },
          });
        return toView(row);
      },
      { userId: user.sub },
    );
  }

  /**
   * Resolve an apartment-state (manager only) — a status transition, NOT a delete.
   * Idempotent: resolving an already-resolved state is a no-op (returns the row).
   * 404 (no oracle) when the state is missing/cross-org. PII-free audit.
   */
  async resolve(user: AccessTokenPayload, stateId: string): Promise<ApartmentStateView> {
    this.requireManager(user);
    return withTenant(
      user.orgId,
      async (tx) => {
        if (await isOrgSuspended(tx, user.orgId)) throw NOT_FOUND;

        const [before] = await tx
          .select({ id: apartmentStates.id, status: apartmentStates.status })
          .from(apartmentStates)
          .where(and(eq(apartmentStates.id, stateId), isNull(apartmentStates.archivedAt)))
          .limit(1);
        if (!before) throw NOT_FOUND;

        if (before.status === 'active') {
          await tx
            .update(apartmentStates)
            .set({
              status: 'resolved',
              resolvedAt: new Date(),
              resolvedBy: user.sub,
              updatedAt: new Date(),
            })
            .where(eq(apartmentStates.id, stateId));
          await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: 'apartment_state.resolve',
            targetTable: 'apartment_states',
            targetId: stateId,
            afterState: { status: 'resolved' },
            sessionId: user.sid,
          });
        }

        const [row] = await tx
          .select(apartmentStateCols)
          .from(apartmentStates)
          .where(eq(apartmentStates.id, stateId))
          .limit(1);
        if (!row) throw NOT_FOUND;
        return toView(row);
      },
      { userId: user.sub },
    );
  }
}
