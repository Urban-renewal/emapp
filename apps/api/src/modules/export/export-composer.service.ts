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
  type TenantTx,
} from '@emapp/db';
import {
  Injectable,
  Logger,
  NotFoundException,
  InternalServerErrorException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { and, eq, isNull, inArray } from 'drizzle-orm';

import { canViewOwners } from '../../common/authz/agent-capabilities';
import {
  PermissionResolutionCache,
  PermissionService,
} from '../../common/authz/permission.service';
import { assertSessionPiiUnlocked, PII_STEP_UP_REQUIRED } from '../../common/authz/pii-step-up';
import type { AccessTokenPayload } from '../auth/auth.service';

import type {
  ProjectExportApartment,
  ProjectExportBuilding,
  ProjectExportInput,
  ProjectExportOwner,
} from './export.service';

/** Export PII fidelity. `masked` (default) is the D.54 reveal-on-demand
 *  posture — national_id/phone are masked for everyone, no step-up. `full`
 *  emits cleartext PII columns and REQUIRES a valid PII step-up unlock. */
export type ExportPiiMode = 'masked' | 'full';

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

  // B5/B6 — engine-backed permission resolution for the full-PII export gate's
  // defence-in-depth reveal-PII re-assertion. The engine is dependency-free (it
  // takes the request tx + a per-call cache), so we own one instance here
  // exactly like `DocumentsService` does for its sensitive-doc gate — no
  // DI/constructor churn (the export composer is constructed with no providers).
  private readonly permissions = new PermissionService();

  // Wave 6 E-H2 + EXP-M1: hard ceiling on apartments per export. Far
  // above any realistic SMB project (partner's largest ~300); purely
  // a DoS/OOM guard. Exposed for the spec.
  static readonly MAX_EXPORT_APARTMENTS = 5000;

  /**
   * B6 (DOCUMENT-SECURITY-AUDIT) — the FULL-PII export step-up gate. A full-PII
   * export (cleartext national_id + phone for every owner) is the single biggest
   * PII surface in the product, so it MUST clear the SAME gate as a single
   * sensitive-document download. This mirrors `documents.service.ts`
   * `assertPiiUnlocked` (the B5 fix) EXACTLY — same two layers, same shared 403
   * code — so the gate can never silently drift between the two cleartext-PII
   * surfaces. Called only AFTER project visibility + owner-read scope (never an
   * existence oracle).
   *
   * CLEARTEXT CONTRACT — a full-PII export emits cleartext national_id/phone for
   * EVERY owner, all-or-nothing, with no per-field mask (exactly like a sensitive
   * document serves a whole file). So, identical to the documents path, it
   * layers TWO checks:
   *
   *   1. ENTITLEMENT (B5 defence-in-depth) — re-resolve `owners.reveal_pii` from
   *      the LIVE engine, not trusted from the token. The step-up UNLOCK is the
   *      cleartext-PII gate, so honoring an unlock requires the caller to ACTUALLY
   *      hold reveal-PII NOW. `export.run` (the controller @RequirePermission)
   *      does NOT imply `owners.reveal_pii` (`permissions.ts`), and the two are
   *      DISCRETE removable permissions (`system-roles.ts`), and `pii_unlocked_at`
   *      is only ever SET, never cleared on role-change (`step-up.service.ts`).
   *      Without this re-assertion, a Manager who unlocked PII then moved to a
   *      custom role with `export.run` but WITHOUT `owners.reveal_pii` would keep
   *      serving cleartext via export for the whole TTL — while the document path
   *      correctly 403s. This closes that B5-class window for export too.
   *
   *   2. ACCESS (freshness/TTL) — delegated to the SHARED `assertSessionPiiUnlocked`
   *      (the single source of truth): the caller's CURRENT session (`user.sid`)
   *      must hold a VALID unlock — `pii_unlocked_at` NOT NULL and younger than the
   *      org's `security.piiUnlockTtlMinutes`. Fail-closed: an unknown/ghost sid
   *      finds no row → 403.
   *
   * BOTH must pass; either failing throws the shared `pii_step_up_required` 403,
   * so the FE opens the same step-up OTP dialog regardless of which surface
   * raised it, and ZERO cleartext is ever round-tripped into heap.
   */
  private async assertPiiUnlocked(tx: TenantTx, user: AccessTokenPayload): Promise<void> {
    // 1. ENTITLEMENT — re-resolve reveal-PII from the live engine (mirrors
    //    `documents.service.ts:1453-1480`). A stale/forged unlock can NEVER be
    //    leveraged by a role that does not currently hold reveal-PII.
    const cache = new PermissionResolutionCache();
    const effective = await this.permissions.effectivePermissions(
      { id: user.sub, orgId: user.orgId },
      { type: 'org', id: user.orgId },
      tx,
      cache,
    );
    if (!effective.has('owners.reveal_pii')) {
      throw PII_STEP_UP_REQUIRED;
    }

    // 2. ACCESS — session pii_unlock freshness/TTL via the shared helper (the
    //    SAME fail-closed check the tabu + documents paths use).
    await assertSessionPiiUnlocked(tx, user);
  }

  async composeProjectExport(
    user: AccessTokenPayload,
    projectId: string,
    format: 'xlsx' | 'pdf',
    piiMode: ExportPiiMode = 'masked',
  ): Promise<{ input: ProjectExportInput; rowCount: number; piiIncluded: boolean }> {
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
            // B6 — an empty project carries zero owner rows, so no cleartext
            // PII is emitted regardless of `piiMode`; the flag is false.
            afterState: { format, rowCount: 0, piiIncluded: false },
            sessionId: user.sid,
          });
          return { input: empty, rowCount: 0, piiIncluded: false };
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

        // D.54 / D.50 — the export mirrors the actor's owner READ scope. An
        // agent WITHOUT `view_owners` sees zero owners on screen, so the export
        // must carry zero owner rows too (not merely masked ones). Manager +
        // viewer can view owners. When blocked, skip the owner fetch + decrypt
        // entirely (no rows, no PII touched).
        const mayViewOwners = await canViewOwners(tx, user);

        // 5) Ownerships (active) JOIN owners (active) for those apts.
        const ownRows =
          aptIds.length === 0 || !mayViewOwners
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

        // B6 — does this export ACTUALLY emit cleartext PII columns? Only when
        // the caller asked for `full` fidelity AND there are owner rows to
        // emit (an owner-read-scoped actor with zero owners emits no PII). Any
        // full-mode owner emission is treated as PII-bearing for the step-up
        // gate + audit flag (the columns are unmasked).
        const piiIncluded = piiMode === 'full' && ownRows.length > 0;

        // B6 — a FULL-PII export must clear the SAME step-up gate as a single
        // sensitive document download. Asserted HERE — after visibility +
        // owner-read scope, and BEFORE the decrypt below, so a locked caller
        // never even round-trips the cleartext into heap. Without a valid
        // unlock this throws the shared `pii_step_up_required` 403.
        if (piiIncluded) {
          await this.assertPiiUnlocked(tx, user);
        }

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
        // D.54 / D.50 — the DEFAULT export is MASKED for everyone (reveal-on-
        // demand model). A `full` export (B6) emits cleartext national_id/phone
        // but ONLY after the step-up gate above passed. The transient cleartext
        // is never logged/persisted (audit logs only project/org/rowCount +
        // a pii_included flag — never the values). D.50 ("export fidelity ==
        // on-screen fidelity") holds: masked default mirrors the masked screen;
        // full mirrors the audited reveal.
        // S3a — a SHELL owner has no national_id; keep it null in the export
        // (the renderer shows a blank cell) rather than masking an empty value.
        const maskNid = (v: string | null): string | null =>
          v == null ? null : '•••••••' + v.slice(-2);
        const maskPhone = (v: string | null): string | null =>
          v == null ? null : '•••••' + v.slice(-4);
        const decryptedOwners: Array<ProjectExportOwner & { __apartmentId: string }> = ownRows.map(
          (r, i) => {
            const d = decryptedByIdx[i]!;
            return {
              __apartmentId: r.apartmentId,
              name: d.name,
              nationalId: piiMode === 'full' ? d.nationalId : maskNid(d.nationalId),
              phone: piiMode === 'full' ? d.phone : maskPhone(d.phone),
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
          // B6 — capture row count + a pii_included flag for forensics. NO
          // national_id/phone (or any owner value) ever lands here — counts
          // and flags only, per the PII-never-logged rule.
          afterState: { format, rowCount, piiIncluded },
          sessionId: user.sid,
        });

        return { input, rowCount, piiIncluded };
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
    extra?: { rowCount?: number; bytes?: number; errorTag?: string; piiIncluded?: boolean },
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
              // B6 — carry the pii_included flag onto the OUTCOME row too so a
              // delivered cleartext-PII export is auditable end-to-end. Counts
              // and flags only — never any owner value.
              piiIncluded: extra?.piiIncluded,
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
