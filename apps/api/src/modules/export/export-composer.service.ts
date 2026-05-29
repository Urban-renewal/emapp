import {
  AuditService,
  apartments,
  buildings,
  decryptOwnerPiiBatch,
  owners,
  ownerships,
  projectAssignments,
  projects,
  users,
  withTenant,
} from '@emapp/db';
import {
  Injectable,
  Logger,
  NotFoundException,
  InternalServerErrorException,
  PayloadTooLargeException,
} from '@nestjs/common';
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
 *   - `decryptOwnerPiiBatch` — ONE round-trip per column (name +
 *     national_id + phone) regardless of owner count. Mirrors the
 *     pre-existing `encryptOwnerPiiBatch` discipline. For 1000 owners
 *     at Neon's ~50ms RTT, total decrypt time is ~150ms (THREE
 *     round-trips), vs ~5 s for the previous per-owner Promise.all
 *     approach.
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

  // Wave 6 E-H2 + EXP-M1: hard ceiling on apartments per export. Far
  // above any realistic SMB project (partner's largest ~300); purely
  // a DoS/OOM guard. Exposed for the spec.
  static readonly MAX_EXPORT_APARTMENTS = 5000;

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
        //    org scoping; missing rows surface as undefined). For
        //    agents, additionally INNER JOIN project_assignments so
        //    an unassigned project surfaces as 404 (matches the
        //    posture of `ProjectsService.get()` — D.17: agent reads
        //    ONLY projects in an active project_assignments row).
        //    Closes the known-debt I documented in
        //    `ExportController` § "Manager/Agent/Viewer".
        const [project] =
          user.role === 'agent'
            ? await tx
                .select({
                  id: projects.id,
                  name: projects.name,
                  type: projects.type,
                  status: projects.status,
                  description: projects.description,
                })
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
                .limit(1)
            : await tx
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
          // Wave 5 E-C3 (errors audit 2026-05-28): D.16 envelope requires
          // `message` alongside `code`. The 404 here is the same
          // posture as the agent-scope miss (no oracle — cross-org and
          // unassigned both collapse to the same response), so the
          // message stays generic; the code is the actionable signal.
          throw new NotFoundException({
            error: { code: 'not_found', message: 'project not found' },
          });
        }

        // 2) Generator (the calling user) — name + email for the
        //    "produced by" metadata row. Same as task hooks.
        const [generator] = await tx
          .select({ id: users.id, name: users.name, email: users.email })
          .from(users)
          .where(eq(users.id, user.sub))
          .limit(1);
        if (!generator) {
          // Wave 5 E-C3: D.16 envelope — message present.
          throw new NotFoundException({
            error: { code: 'not_found', message: 'generator user not found' },
          });
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
          // Wave 6 drive-by: this empty-project branch was missed in
          // PR #158 (Wave 5 E-C1) which renamed the action to
          // `project.export.requested` only on the non-empty path. The
          // s10 test 5 happens to use a non-empty project so the
          // inconsistency wasn't caught. Both branches now use the
          // same action name — the compliance dashboard can pair
          // every requested row with its outcome row regardless of
          // whether the project had buildings.
          await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: 'project.export.requested',
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

        // Wave 6 E-H2 + EXP-M1 (errors + redteam audit 2026-05-28) —
        // server-side row cap. The composer holds ONE pool connection
        // for the whole compose (the withTenant tx); a 50k-apartment
        // project would (a) hold that connection through 3 decrypt
        // round-trips + grouping, starving the pool under concurrent
        // exports, and (b) build a ~70 MB HTML string before Chromium
        // even starts (OOM the Railway container). We refuse oversized
        // exports HERE — after the cheap apartments fetch, BEFORE the
        // expensive owner-decrypt + render — with a 413 carrying a
        // "split your project" hint. The cap (5000 apts) is far above
        // any realistic SMB urban-renewal project (the partner's
        // largest is ~300 apts) so no real user hits it; it's purely
        // a DoS/OOM ceiling.
        //
        // NOTE: the audit's original suggestion (move the apartments +
        // owners reads OUTSIDE the withTenant tx to shorten the
        // connection hold) was REJECTED — it would bypass RLS, which
        // CLAUDE.md forbids ("every DB read goes through withTenant").
        // The row cap achieves the same pool-protection goal without
        // touching the RLS boundary.
        if (aptRows.length > ExportComposerService.MAX_EXPORT_APARTMENTS) {
          throw new PayloadTooLargeException({
            error: {
              code: 'export_too_large',
              message: `project has ${aptRows.length} apartments; export is limited to ${ExportComposerService.MAX_EXPORT_APARTMENTS}. split the project or contact support for a bulk export.`,
            },
          });
        }
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

        // 6) Decrypt PII in ONE round-trip per column (3 total) using
        //    the batched helper. ownerId on each EncryptedOwnerRow is
        //    a position-preserving key the caller chooses — we use a
        //    composite of `ownerId|apartmentId` so the same owner on
        //    two different apartments stays distinct in the result
        //    map (an owner can co-own multiple apts in this project).
        const encryptedRows = ownRows.map((r, i) => ({
          // Use the row index as the position key. Owner-id alone is
          // NOT unique within ownRows (an owner with multi-apt
          // ownership appears once per apt).
          ownerId: `${i}`,
          nameEncrypted: r.nameEncrypted,
          nationalIdEncrypted: r.nationalIdEncrypted,
          phoneEncrypted: r.phoneEncrypted,
        }));
        // Wave 6 EXP-H2 (redteam audit 2026-05-28) — wrap the decrypt
        // path. `decryptOwnerPiiBatch` throws errors that contain the
        // row index ("missing name plaintext at idx 7") which would
        // bubble through GlobalExceptionFilter → logger.error (stack
        // + message) and, when AUTH_DEBUG_ERRORS=1 on staging, into
        // the response body. Combined with a pgcrypto-rotation bug,
        // every export 500 would be a row-index-disclosing event.
        // Now: the original detail goes only to the server log
        // (the orgId + project id give ops enough to investigate);
        // the throw carries a stable code + non-leaky message.
        let decryptedByIdx: Awaited<ReturnType<typeof decryptOwnerPiiBatch>>;
        try {
          decryptedByIdx = await decryptOwnerPiiBatch(
            tx as unknown as Parameters<typeof decryptOwnerPiiBatch>[0],
            encryptedRows,
          );
        } catch (e) {
          this.logger.error(
            `pgcrypto decrypt failed for project=${projectId} org=${user.orgId}: ${e instanceof Error ? e.message : 'unknown'}`,
          );
          throw new InternalServerErrorException({
            error: { code: 'export_decrypt_failed', message: 'export temporarily unavailable' },
          });
        }
        const decryptedOwners: Array<ProjectExportOwner & { __apartmentId: string }> = ownRows.map(
          (r, i) => {
            const d = decryptedByIdx[i]!;
            return {
              __apartmentId: r.apartmentId,
              name: d.name,
              nationalId: d.nationalId,
              phone: d.phone,
              email: r.email,
              ownershipPct: Number(r.ownershipPct),
              role: r.role,
            };
          },
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

        // 8) Audit — Wave 5 E-C1 (errors audit 2026-05-28): write the
        //    PRE-flight `project.export.requested` row in the same tx
        //    as the read (RLS + actor consistent; commits as soon as
        //    the composer returns). The controller writes a paired
        //    `project.export.delivered` or `project.export.failed` row
        //    AFTER the renderer outcome — so the forensic story
        //    distinguishes "audit-says-yes-and-user-got-bytes" from
        //    "audit-says-yes-but-renderer-threw" (previously
        //    indistinguishable, ISO 27001 A.12.4 violation).
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'project.export.requested',
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

  /**
   * Wave 5 E-C1 — record the export OUTCOME (delivered or failed) in a
   * fresh `withTenant` tx after the renderer returns. Best-effort: a
   * failure to write this auxiliary audit row logs loudly but does not
   * fail the user-facing response (the `project.export.requested` row
   * from `composeProjectExport` is the gate; this one is the outcome
   * marker the compliance dashboard pairs against it).
   *
   * Outcome values:
   *   - `'delivered'` — renderer returned a buffer; bytes are about
   *     to flush to the wire.
   *   - `'failed'` — renderer threw; the user will see a 500. The
   *     `error` field carries a short tag (Chromium / ExcelJS / etc),
   *     never the raw error message or stack (would leak cwd / file
   *     paths per E-H3).
   */
  async auditExportOutcome(
    user: AccessTokenPayload,
    projectId: string,
    format: 'xlsx' | 'pdf',
    outcome: 'delivered' | 'failed',
    extra?: { rowCount?: number; bytes?: number; errorTag?: string },
  ): Promise<void> {
    try {
      await withTenant(
        user.orgId,
        async (tx) => {
          await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: outcome === 'delivered' ? 'project.export.delivered' : 'project.export.failed',
            targetTable: 'projects',
            targetId: projectId,
            afterState: {
              format,
              rowCount: extra?.rowCount,
              bytes: extra?.bytes,
              error: extra?.errorTag,
            },
            sessionId: user.sid,
          });
        },
        { userId: user.sub },
      );
    } catch (e) {
      // Best-effort: forensic auxiliary, not the gate. Log + move on.
      this.logger.error(
        `audit(project.export.${outcome}) failed (project=${projectId}): ${e instanceof Error ? e.message : 'unknown'} — request continues; requested-row is the gate`,
      );
    }
  }
}

// silence the unused-tx-cast lint helper above
void and;
