import {
  AuditService,
  apartments,
  buildings,
  decryptOwnerName,
  decryptOwnerPii,
  owners,
  ownerships,
  projects,
  users,
  withTenant,
} from '@emapp/db';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, eq, isNull, inArray } from 'drizzle-orm';

import type { AccessTokenPayload } from '../auth/auth.service';

import type {
  ProjectExportApartment,
  ProjectExportBuilding,
  ProjectExportInput,
  ProjectExportOwner,
} from './export.service';

/**
 * V11 B.S10 — Project → ProjectExportInput composer (Phase 7).
 *
 * Single responsibility: load a project + its sub-tree from Neon
 * inside `withTenant` (RLS scopes to the caller's org GUC), decrypt
 * owner PII, and shape the result into the `ProjectExportInput`
 * contract that both `ExportService` (xlsx, B.S8) and
 * `PdfExportService` (pdf, B.S9) consume.
 *
 * Why a separate composer:
 *   - The renderers (B.S8 / B.S9) are pure functions of data — they
 *     have no DB access by design (testable offline, runnable from
 *     the worker tier later, etc).
 *   - The composer owns the RLS boundary + decryption (every PII
 *     read goes through `decryptOwnerPii` / `decryptOwnerName` under
 *     the `app.encryption_key` GUC `withTenant` already set up).
 *   - Keeps the controller thin: it picks format, calls the
 *     composer, then the matching renderer.
 *
 * Decryption strategy:
 *   - Per-owner `decryptOwnerName` + `decryptOwnerPii` in parallel
 *     via `Promise.all`. Each owner needs 3 pgcrypto round-trips
 *     (name + national_id + phone). For 1000 owners @ Neon's
 *     ~10-conn pool + ~50ms RTT, the parallel pool keeps elapsed
 *     time bounded (typical: 5-10 s for 1000 owners).
 *   - If the perf budget (T7.7 = 25 s end-to-end) becomes tight in
 *     prod, follow-up: add a batched-decrypt helper modelled after
 *     `encryptOwnerPiiBatch` (one `unnest($1::bytea[])` round-trip
 *     per column instead of N). Out of scope for this slice.
 *
 * Audit:
 *   - Writes one `project.export` audit log row per call inside the
 *     same withTenant tx as the read, with `afterState =
 *     { format, rowCount }`. Caller surfaces the row count back to
 *     the controller for the log line.
 */
@Injectable()
export class ExportComposerService {
  private readonly logger = new Logger(ExportComposerService.name);

  async composeProjectExport(
    user: AccessTokenPayload,
    projectId: string,
    format: 'xlsx' | 'pdf',
  ): Promise<{ input: ProjectExportInput; rowCount: number }> {
    const t0 = Date.now();
    const result = await withTenant(
      user.orgId,
      async (tx) => {
        // 1) Project — 404 if missing or wrong org (RLS handles the
        //    org scoping; missing rows surface as undefined).
        const [project] = await tx
          .select({
            id: projects.id,
            name: projects.name,
            type: projects.type,
            status: projects.status,
            description: projects.description,
          })
          .from(projects)
          .where(eq(projects.id, projectId))
          .limit(1);
        if (!project) {
          throw new NotFoundException({ error: { code: 'not_found' } });
        }

        // 2) Generator (the calling user) — name + email for the
        //    "produced by" metadata row. Same as task hooks.
        const [generator] = await tx
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(eq(users.id, user.sub))
          .limit(1);
        if (!generator) {
          throw new NotFoundException({ error: { code: 'not_found' } });
        }

        // 3) Buildings (active only).
        const bldRows = await tx
          .select({
            id: buildings.id,
            address: buildings.address,
            city: buildings.city,
            block: buildings.block,
            parcel: buildings.parcel,
          })
          .from(buildings)
          .where(and(eq(buildings.projectId, projectId), isNull(buildings.archivedAt)));

        if (bldRows.length === 0) {
          // Empty project — render with a zero-building input (the
          // renderer handles it via empty for-loops).
          const empty: ProjectExportInput = {
            project,
            generatedAt: new Date(),
            generatedBy: { name: generator.name, email: generator.email },
            buildings: [],
          };
          await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: 'project.export',
            targetTable: 'projects',
            targetId: projectId,
            afterState: { format, rowCount: 0 },
            sessionId: user.sid,
          });
          return { input: empty, rowCount: 0 };
        }
        const bldIds = bldRows.map((b) => b.id);

        // 4) Apartments for those buildings (active only).
        const aptRows = await tx
          .select({
            id: apartments.id,
            buildingId: apartments.buildingId,
            number: apartments.number,
            floor: apartments.floor,
            sizeSqm: apartments.sizeSqm,
            areaSqm: apartments.areaSqm,
            rooms: apartments.rooms,
            status: apartments.status,
            unitType: apartments.unitType,
            entrance: apartments.entrance,
          })
          .from(apartments)
          .where(and(inArray(apartments.buildingId, bldIds), isNull(apartments.archivedAt)));
        const aptIds = aptRows.map((a) => a.id);

        // 5) Ownerships (active) JOIN owners (active) for those apts.
        const ownRows =
          aptIds.length === 0
            ? []
            : await tx
                .select({
                  apartmentId: ownerships.apartmentId,
                  ownerId: owners.id,
                  ownershipPct: ownerships.ownershipPct,
                  role: ownerships.role,
                  nameEncrypted: owners.nameEncrypted,
                  nationalIdEncrypted: owners.nationalIdEncrypted,
                  phoneEncrypted: owners.phoneEncrypted,
                  email: owners.email,
                })
                .from(ownerships)
                .innerJoin(owners, eq(owners.id, ownerships.ownerId))
                .where(
                  and(
                    inArray(ownerships.apartmentId, aptIds),
                    isNull(ownerships.endedAt),
                    isNull(owners.archivedAt),
                  ),
                );

        // 6) Decrypt PII in parallel (Promise.all caps at the pg pool
        //    size; for thousand-owner cases consider a batched helper).
        const decryptedOwners = await Promise.all(
          ownRows.map(async (r) => {
            const [name, pii] = await Promise.all([
              decryptOwnerName(
                tx as unknown as Parameters<typeof decryptOwnerName>[0],
                r.nameEncrypted,
              ),
              decryptOwnerPii(tx as unknown as Parameters<typeof decryptOwnerPii>[0], {
                nationalIdEncrypted: r.nationalIdEncrypted,
                phoneEncrypted: r.phoneEncrypted,
              }),
            ]);
            const o: ProjectExportOwner & { __apartmentId: string } = {
              __apartmentId: r.apartmentId,
              name,
              nationalId: pii.nationalId,
              phone: pii.phone,
              email: r.email,
              ownershipPct: Number(r.ownershipPct),
              role: r.role,
            };
            return o;
          }),
        );

        // 7) Group owners by apartment, then apartments by building.
        const ownersByApt = new Map<string, ProjectExportOwner[]>();
        for (const o of decryptedOwners) {
          const key = (o as ProjectExportOwner & { __apartmentId: string }).__apartmentId;
          const list = ownersByApt.get(key) ?? [];
          // Strip the __apartmentId before handing to the renderer
          // (its public type doesn't carry it).
          const { __apartmentId: _drop, ...rest } = o as ProjectExportOwner & {
            __apartmentId: string;
          };
          void _drop;
          list.push(rest);
          ownersByApt.set(key, list);
        }
        const aptsByBld = new Map<string, ProjectExportApartment[]>();
        for (const a of aptRows) {
          const list = aptsByBld.get(a.buildingId) ?? [];
          list.push({
            id: a.id,
            number: a.number,
            floor: a.floor,
            sizeSqm: a.sizeSqm === null ? null : Number(a.sizeSqm),
            areaSqm: a.areaSqm === null ? null : Number(a.areaSqm),
            rooms: a.rooms === null ? null : Number(a.rooms),
            status: a.status,
            unitType: a.unitType,
            entrance: a.entrance,
            owners: ownersByApt.get(a.id) ?? [],
          });
          aptsByBld.set(a.buildingId, list);
        }

        const composedBuildings: ProjectExportBuilding[] = bldRows.map((b) => ({
          id: b.id,
          address: b.address,
          city: b.city,
          block: b.block,
          parcel: b.parcel,
          apartments: aptsByBld.get(b.id) ?? [],
        }));

        const input: ProjectExportInput = {
          project,
          generatedAt: new Date(),
          generatedBy: { name: generator.name, email: generator.email },
          buildings: composedBuildings,
        };
        const rowCount = decryptedOwners.length || aptRows.length;

        // 8) Audit (inside the same tx so RLS + actor are consistent).
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'project.export',
          targetTable: 'projects',
          targetId: projectId,
          afterState: { format, rowCount },
          sessionId: user.sid,
        });

        return { input, rowCount };
      },
      { userId: user.sub },
    );
    this.logger.log(
      `composed project ${projectId} → ${format} input (${result.rowCount} rows, ${Date.now() - t0}ms)`,
    );
    return result;
  }
}

// silence the unused-tx-cast lint helper above
void and;
