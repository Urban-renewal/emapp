import {
  AuditService,
  apartments,
  buildingSections,
  buildings,
  projectAssignments,
  projectSetSignatureDocIdsSql,
  projects,
  withTenant,
  type Project as ProjectRow,
} from '@emapp/db';
import { PROJECT_TYPE_DEFAULT_CONSENT_PCT } from '@emapp/shared-types';
import type {
  CreateProject,
  OrgStats,
  Project,
  ProjectListItem,
  ProjectStats,
  UpdateProject,
} from '@emapp/shared-types';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';

import { decodeCursor, encodeCursor } from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';

export interface ProjectListPage {
  data: ProjectListItem[];
  page: { limit: number; cursor: string | null; has_more: boolean };
}

function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    organizationId: r.orgId,
    name: r.name,
    type: r.type,
    status: r.status,
    description: r.description,
    // pg `numeric` is returned as string by the driver — normalise to number.
    targetSignaturePct: r.targetSignaturePct === null ? null : Number(r.targetSignaturePct),
    // Owner-approved staged overlay (Gate-6, migration 0053). jsonb rides the
    // select as-is; null for pre-feature rows.
    signatureMilestones: r.signatureMilestones ?? null,
    startedAt: r.startedAt,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    archivedAt: r.archivedAt,
  };
}

function toProjectListItem(r: ProjectRow, stats: ProjectStats): ProjectListItem {
  return { ...toProject(r), ...stats };
}

/**
 * Aggregate-stats SELECT fragment used by both list() and get(). Five
 * correlated subqueries; each one is index-backed and sub-ms. We compute
 * server-side via a single round-trip (no N+1) so the FE can render
 * KPI cards (signature counts, agents, units) without follow-up calls.
 *
 * Doc-debt closure: `packages/shared-types/src/project.ts` previously
 * noted "stats depend on Phase 5 signatures" and shipped without the
 * fields. Phase 5 has landed (signature_requests + signatures tables),
 * so this is the wiring that lets the FE drop "—" placeholders for
 * real numbers.
 */
function statsSubqueries(projectIdRef: ReturnType<typeof sql>) {
  return {
    buildingsCount: sql<number>`COALESCE((
      SELECT COUNT(*)::int FROM buildings
      WHERE project_id = ${projectIdRef} AND archived_at IS NULL
    ), 0)`.as('buildings_count'),
    unitsCount: sql<number>`COALESCE((
      SELECT COUNT(*)::int FROM apartments a
      INNER JOIN buildings b ON b.id = a.building_id
      WHERE b.project_id = ${projectIdRef}
        AND a.archived_at IS NULL AND b.archived_at IS NULL
    ), 0)`.as('units_count'),
    signaturesPendingCount: sql<number>`COALESCE((
      SELECT COUNT(*)::int FROM signature_requests sr
      INNER JOIN documents d ON d.id = sr.document_id
      WHERE d.project_id = ${projectIdRef} AND sr.status = 'pending'
    ), 0)`.as('sigs_pending'),
    signaturesSignedCount: sql<number>`COALESCE((
      SELECT COUNT(*)::int FROM signature_requests sr
      INNER JOIN documents d ON d.id = sr.document_id
      WHERE d.project_id = ${projectIdRef} AND sr.status = 'signed'
    ), 0)`.as('sigs_signed'),
    agentsCount: sql<number>`COALESCE((
      SELECT COUNT(DISTINCT user_id)::int FROM project_assignments
      WHERE project_id = ${projectIdRef} AND unassigned_at IS NULL
    ), 0)`.as('agents_count'),
  } as const;
}

const NOT_FOUND = new NotFoundException({ error: { code: 'not_found' } });
const FORBIDDEN = new ForbiddenException({ error: { code: 'forbidden' } });

/**
 * V11 F2 — detect the partial-unique-index violation on
 * `apartments_building_number_active` (migration 0001). pg drivers wrap
 * the original error; the diagnostic fields can be on the error itself
 * or nested under `.cause` (drizzle does the wrap in some paths).
 * The function walks the cause chain up to 8 levels and matches both
 * the SQLSTATE (`23505` = unique_violation) AND the constraint name to
 * avoid claiming OTHER unique violations on apartments (none exist
 * today, but defence in depth — F2 was discovered exactly because we
 * trusted "throws something" without inspecting the shape).
 */
function isDuplicateApartmentNumberError(err: unknown): boolean {
  let cur: unknown = err;
  let depth = 0;
  while (cur && depth < 8) {
    const pg = cur as { code?: string; constraint?: string };
    if (pg.code === '23505' && pg.constraint === 'apartments_building_number_active') {
      return true;
    }
    cur = (cur as { cause?: unknown })?.cause;
    depth += 1;
  }
  return false;
}

/** Returns only the numbers that appear more than once in the input.
 *  Used to populate `apartment_number_duplicate.details.numbers` so a
 *  wizard FE can highlight the offending row(s). De-duplicated and
 *  alphabetised for a stable wire shape (response is deterministic for
 *  the same input, easier to test). */
function collectDuplicateNumbers(nums: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const n of nums) counts.set(n, (counts.get(n) ?? 0) + 1);
  return Array.from(counts.entries())
    .filter(([, c]) => c > 1)
    .map(([n]) => n)
    .sort();
}

/**
 * Projects domain service (Phase 3 Slice 1).
 *
 * Authorization (D.17) is owned HERE, not in a god-guard:
 *  - manager → full CRUD + reads all org projects.
 *  - viewer  → read-only, all org projects.
 *  - agent   → read-only, ONLY projects in an active project_assignments row
 *              (scoped in the SERVICE per the approved plan, not via an extra
 *              RLS policy — avoids via-parent N+1 and keeps RLS = org isolation).
 * Tenant org-isolation itself is enforced by RLS inside withTenant; a
 * cross-org id therefore returns zero rows → 404 (no oracle).
 */
@Injectable()
export class ProjectsService {
  private requireManager(user: AccessTokenPayload): void {
    if (user.role !== 'manager') throw FORBIDDEN;
  }

  async list(
    user: AccessTokenPayload,
    query: { limit: number; cursor?: string },
  ): Promise<ProjectListPage> {
    const { limit } = query;
    const cur = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cur) {
      // Tampered/garbage cursor is a client error, never a 500.
      throw new BadRequestException({ error: { code: 'invalid_cursor' } });
    }

    const rows = await withTenant(
      user.orgId,
      async (tx) => {
        const keyset = cur
          ? or(
              lt(projects.createdAt, new Date(cur.c)),
              and(eq(projects.createdAt, new Date(cur.c)), lt(projects.id, cur.i)),
            )
          : undefined;

        const stats = statsSubqueries(sql`${projects.id}`);

        // Agent: inner-join the active assignment so only assigned projects
        // are visible. The idx_project_assignments_user_active partial index
        // backs this — no N+1, single round-trip.
        if (user.role === 'agent') {
          return tx
            .select({ p: projects, ...stats })
            .from(projects)
            .innerJoin(
              projectAssignments,
              and(
                eq(projectAssignments.projectId, projects.id),
                eq(projectAssignments.userId, user.sub),
                isNull(projectAssignments.unassignedAt),
              ),
            )
            .where(and(isNull(projects.archivedAt), keyset))
            .orderBy(desc(projects.createdAt), desc(projects.id))
            .limit(limit + 1);
        }

        return tx
          .select({ p: projects, ...stats })
          .from(projects)
          .where(and(isNull(projects.archivedAt), keyset))
          .orderBy(desc(projects.createdAt), desc(projects.id))
          .limit(limit + 1);
      },
      { userId: user.sub },
    );

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1]?.p;
    return {
      data: pageRows.map((r) =>
        toProjectListItem(r.p, {
          buildingsCount: Number(r.buildingsCount),
          unitsCount: Number(r.unitsCount),
          signaturesPendingCount: Number(r.signaturesPendingCount),
          signaturesSignedCount: Number(r.signaturesSignedCount),
          agentsCount: Number(r.agentsCount),
        }),
      ),
      page: {
        limit,
        cursor: hasMore && last ? encodeCursor(last) : null,
        has_more: hasMore,
      },
    };
  }

  async get(user: AccessTokenPayload, id: string): Promise<ProjectListItem> {
    const row = await withTenant(
      user.orgId,
      async (tx) => {
        const stats = statsSubqueries(sql`${projects.id}`);
        if (user.role === 'agent') {
          const [r] = await tx
            .select({ p: projects, ...stats })
            .from(projects)
            .innerJoin(
              projectAssignments,
              and(
                eq(projectAssignments.projectId, projects.id),
                eq(projectAssignments.userId, user.sub),
                isNull(projectAssignments.unassignedAt),
              ),
            )
            .where(eq(projects.id, id))
            .limit(1);
          return r;
        }
        const [r] = await tx
          .select({ p: projects, ...stats })
          .from(projects)
          .where(eq(projects.id, id))
          .limit(1);
        return r;
      },
      { userId: user.sub },
    );
    if (!row) throw NOT_FOUND;
    return toProjectListItem(row.p, {
      buildingsCount: Number(row.buildingsCount),
      unitsCount: Number(row.unitsCount),
      signaturesPendingCount: Number(row.signaturesPendingCount),
      signaturesSignedCount: Number(row.signaturesSignedCount),
      agentsCount: Number(row.agentsCount),
    });
  }

  /**
   * Home dashboard KPI cards. Single round-trip, four COUNTs against indexed
   * tables. Manager/viewer see ORG-WIDE counts; an AGENT sees counts scoped to
   * their ASSIGNED projects only — org-wide numbers would both mislead the agent
   * (contradicting their visible project list) and leak org scale to a scoped
   * user. The agent scope reuses the SAME indexed doc-resolution as the portal/
   * contractor progress (projectSetSignatureDocIdsSql), so there is one
   * definition of "a project's signature docs", not a copy. Still one round-trip.
   */
  async orgStats(user: AccessTokenPayload): Promise<OrgStats> {
    return withTenant(
      user.orgId,
      async (tx) => {
        const result =
          user.role === 'agent'
            ? await tx.execute(sql`
                WITH assigned AS (
                  SELECT project_id FROM project_assignments
                    WHERE user_id = ${user.sub} AND unassigned_at IS NULL
                )
                SELECT
                  (SELECT COUNT(*)::int FROM projects p
                     WHERE p.archived_at IS NULL
                       AND p.id IN (SELECT project_id FROM assigned)) AS active_projects,
                  (SELECT COUNT(DISTINCT o.owner_id)::int FROM ownerships o
                     INNER JOIN apartments a ON a.id = o.apartment_id
                     INNER JOIN buildings b ON b.id = a.building_id
                     WHERE o.ended_at IS NULL
                       AND b.project_id IN (SELECT project_id FROM assigned)) AS residents,
                  (SELECT COUNT(*)::int FROM signature_requests sr
                     WHERE sr.status = 'signed'
                       AND sr.document_id IN (${projectSetSignatureDocIdsSql(sql`SELECT project_id FROM assigned`)})) AS signatures_received,
                  (SELECT COUNT(*)::int FROM signature_requests sr
                     WHERE sr.status = 'pending'
                       AND sr.document_id IN (${projectSetSignatureDocIdsSql(sql`SELECT project_id FROM assigned`)})) AS signatures_pending
              `)
            : await tx.execute(sql`
                SELECT
                  (SELECT COUNT(*)::int FROM projects WHERE archived_at IS NULL) AS active_projects,
                  (SELECT COUNT(DISTINCT owner_id)::int FROM ownerships WHERE ended_at IS NULL) AS residents,
                  (SELECT COUNT(*)::int FROM signature_requests WHERE status = 'signed') AS signatures_received,
                  (SELECT COUNT(*)::int FROM signature_requests WHERE status = 'pending') AS signatures_pending
              `);
        const r = (result as unknown as { rows: Array<Record<string, unknown>> }).rows[0] ?? {};
        return {
          activeProjects: Number(r['active_projects'] ?? 0),
          residents: Number(r['residents'] ?? 0),
          signaturesReceived: Number(r['signatures_received'] ?? 0),
          signaturesPending: Number(r['signatures_pending'] ?? 0),
        };
      },
      { userId: user.sub },
    );
  }

  async create(user: AccessTokenPayload, input: CreateProject): Promise<Project> {
    this.requireManager(user);
    return withTenant(
      user.orgId,
      async (tx) => {
        const [row] = await tx
          .insert(projects)
          .values({
            orgId: user.orgId,
            name: input.name,
            type: input.type,
            status: input.status ?? 'planning',
            description: input.description ?? null,
            // Functional type: the consent threshold DEFAULTS from the project's
            // urban-renewal track (the legal majority that track requires) when
            // the manager doesn't set one explicitly. Manager override always
            // wins; the per-type defaults live in one editable map (shared-types).
            targetSignaturePct:
              input.targetSignaturePct === undefined || input.targetSignaturePct === null
                ? String(PROJECT_TYPE_DEFAULT_CONSENT_PCT[input.type])
                : String(input.targetSignaturePct),
            // Owner-approved staged overlay (Gate-6, migration 0053). Already
            // validated (shape + ascending/unique + <= target) by the
            // CreateProjectInput Zod schema at the controller boundary.
            signatureMilestones: input.signatureMilestones ?? null,
            startedAt: input.startedAt ?? null,
            createdBy: user.sub,
          })
          .returning();
        if (!row)
          throw new InternalServerErrorException({
            error: { code: 'insert_no_row', message: 'unexpected db state' },
          });

        // V11 B.S2 — wizard-driven atomic structure expansion (D.39).
        // The AddProjectModal wizard ships project + buildings + sections
        // + apartments in ONE request; we expand them inside this same
        // withTenant tx so a failure anywhere rolls back the whole thing
        // (no half-created projects, no orphaned buildings). Per-row
        // entity audit is skipped in favour of one summary audit row
        // with counts — easier to query later, and the atomic tx itself
        // is the forensic boundary.
        let buildingsCreated = 0;
        let sectionsCreated = 0;
        let apartmentsCreated = 0;

        for (const b of input.buildings ?? []) {
          const [bRow] = await tx
            .insert(buildings)
            .values({
              projectId: row.id,
              address: b.address,
              city: b.city,
              block: b.block ?? null,
              parcel: b.parcel ?? null,
              subparcel: b.subparcel ?? null,
              // `aptCount` is intentionally NOT set: the per-row
              // `trg_apartments_count_maintenance` trigger (migration
              // 0002) increments it for each apartment INSERT below.
              // Writing it here would double-count.
              notes: b.notes ?? null,
            })
            .returning();
          if (!bRow)
            throw new InternalServerErrorException({
              error: { code: 'insert_no_row', message: 'unexpected db state' },
            });
          buildingsCreated += 1;

          if (b.sections?.length) {
            await tx.insert(buildingSections).values(
              b.sections.map((s) => ({
                buildingId: bRow.id,
                entrance: s.entrance ?? null,
                kind: s.kind,
                floors: s.floors ?? null,
                unitCount: s.unitCount ?? null,
                gush: s.gush ?? null,
                helka: s.helka ?? null,
                notes: s.notes ?? null,
              })),
            );
            sectionsCreated += b.sections.length;
          }

          if (b.apartments?.length) {
            // numeric columns travel as strings on the wire (pg-node
            // semantics, matching the toProject pattern in this file).
            //
            // V11 F2 — the partial-unique index
            // `apartments_building_number_active` (migration 0001) rejects
            // duplicate `number` within the same building. Pre-fix this
            // leaked as `HTTP 500 {"error":{"code":"500"}}` because the
            // pg 23505 reached the global exception filter. Surfaced by
            // smoke backfill against PR #107 (see #107 comment). Catch
            // it here, map to a clean 4xx with a stable `code` and the
            // offending number(s) in `details` so the wizard FE can
            // highlight the right row. Atomicity is unchanged — the
            // throw still propagates out of `withTenant` and rolls back
            // the whole project + building + sections.
            try {
              await tx.insert(apartments).values(
                b.apartments.map((a) => ({
                  buildingId: bRow.id,
                  number: a.number,
                  floor: a.floor ?? null,
                  sizeSqm: a.sizeSqm === undefined || a.sizeSqm === null ? null : String(a.sizeSqm),
                  rooms: a.rooms === undefined || a.rooms === null ? null : String(a.rooms),
                  // unit_type column is NOT NULL DEFAULT 'apt' (0035) — sending
                  // undefined lets the DB default apply, which is more honest
                  // than coercing here.
                  unitType: a.unitType ?? 'apt',
                  areaSqm: a.areaSqm === undefined || a.areaSqm === null ? null : String(a.areaSqm),
                  entrance: a.entrance ?? null,
                  notes: a.notes ?? null,
                })),
              );
            } catch (err) {
              if (isDuplicateApartmentNumberError(err)) {
                throw new ConflictException({
                  error: {
                    code: 'apartment_number_duplicate',
                    details: {
                      building: { address: b.address, city: b.city },
                      // Caller-visible numbers (no PII, just the values
                      // they sent us) so the wizard can highlight rows.
                      numbers: collectDuplicateNumbers(b.apartments.map((a) => a.number)),
                    },
                  },
                });
              }
              throw err;
            }
            apartmentsCreated += b.apartments.length;
          }
        }

        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'project.create',
          targetTable: 'projects',
          targetId: row.id,
          afterState: {
            name: row.name,
            type: row.type,
            status: row.status,
            // Counts always emitted so the audit shape stays stable
            // whether the request used the wizard structure or not.
            buildingsCreated,
            sectionsCreated,
            apartmentsCreated,
          },
          sessionId: user.sid,
        });
        return toProject(row);
      },
      { userId: user.sub },
    );
  }

  async update(user: AccessTokenPayload, id: string, input: UpdateProject): Promise<Project> {
    this.requireManager(user);
    return withTenant(
      user.orgId,
      async (tx) => {
        const [before] = await tx.select().from(projects).where(eq(projects.id, id)).limit(1);
        if (!before) throw NOT_FOUND;

        const patch: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() };
        if (input.name !== undefined) patch.name = input.name;
        if (input.type !== undefined) patch.type = input.type;
        if (input.status !== undefined) patch.status = input.status;
        if (input.description !== undefined) patch.description = input.description;
        if (input.targetSignaturePct !== undefined) {
          patch.targetSignaturePct =
            input.targetSignaturePct === null ? null : String(input.targetSignaturePct);
        }
        // Owner-approved staged overlay (Gate-6). Editable post-create: a
        // supplied list replaces, `null` clears. Validated by UpdateProjectInput.
        if (input.signatureMilestones !== undefined) {
          patch.signatureMilestones = input.signatureMilestones ?? null;
        }
        if (input.startedAt !== undefined) patch.startedAt = input.startedAt;

        const [row] = await tx.update(projects).set(patch).where(eq(projects.id, id)).returning();
        if (!row) throw NOT_FOUND;
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'project.update',
          targetTable: 'projects',
          targetId: row.id,
          beforeState: { name: before.name, status: before.status },
          afterState: { name: row.name, status: row.status },
          sessionId: user.sid,
        });
        return toProject(row);
      },
      { userId: user.sub },
    );
  }

  // Soft delete = archivedAt (CLAUDE.md hard rule; UI verb "ארכוב").
  // Idempotent: archiving an already-archived project still succeeds.
  async archive(user: AccessTokenPayload, id: string): Promise<void> {
    this.requireManager(user);
    await withTenant(
      user.orgId,
      async (tx) => {
        const [before] = await tx.select().from(projects).where(eq(projects.id, id)).limit(1);
        if (!before) throw NOT_FOUND;
        if (before.archivedAt) return;
        await tx
          .update(projects)
          .set({ archivedAt: sql`now()`, updatedAt: new Date() })
          .where(eq(projects.id, id));
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'project.archive',
          targetTable: 'projects',
          targetId: id,
          sessionId: user.sid,
        });
      },
      { userId: user.sub },
    );
  }
}
