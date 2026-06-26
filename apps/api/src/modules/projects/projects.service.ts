import { serverEnv } from '@emapp/config';
import {
  AuditService,
  apartments,
  buildingSections,
  buildings,
  documents,
  projectAssignments,
  projectSetSignatureDocIdsSql,
  projectSignatureDocIdsSql,
  projects,
  withTenant,
  type Project as ProjectRow,
  type TenantTx,
} from '@emapp/db';
import {
  PROJECT_TYPE_DEFAULT_CONSENT_PCT,
  PULSE_EXPIRING_SOON_DAYS,
  PULSE_STALLED_DAYS,
  isAllowedStatusTransition,
} from '@emapp/shared-types';
import type {
  ApartmentHoldout,
  ApartmentSignatureProgress,
  CreateProject,
  DocumentChecklist,
  DocumentType,
  OrgStats,
  Project,
  ProjectLeverage,
  ProjectListItem,
  ProjectPulseRow,
  ProjectSegment,
  ProjectStats,
  ProjectStatus,
  SignaturePulse,
  SignatureProgress,
  UpdateProject,
} from '@emapp/shared-types';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';

import { resolveOwnerPiiFidelity } from '../../common/authz/agent-capabilities';
import {
  decodeCursor,
  encodeCursor,
  keysetCondition,
  keysetOrderBy,
} from '../../common/keyset-cursor';
import type { AccessTokenPayload } from '../auth/auth.service';

import {
  REQUIRED_DOC_TYPES_BY_TRACK,
  checklistCompletionPct,
  trackForProjectType,
} from './document-checklist.config';
import { rankAttention } from './rank-attention';
import { StatsCacheService } from './stats-cache.service';

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
    // P3 create-form enrichment (migration 0062). Nullable text/int ride the
    // select as-is; pg `numeric` (extraAreaSqm) arrives as a string → Number().
    developerName: r.developerName,
    developerCompanyId: r.developerCompanyId,
    existingUnits: r.existingUnits,
    plannedUnits: r.plannedUnits,
    extraAreaSqm: r.extraAreaSqm === null ? null : Number(r.extraAreaSqm),
    relocationType: r.relocationType as Project['relocationType'],
    relocationNotes: r.relocationNotes,
    typeLabel: r.typeLabel,
    block: r.block,
    parcel: r.parcel,
    subparcel: r.subparcel,
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
    // A signature counts for THIS project when its document is associated with
    // the project EITHER project-level (d.project_id) OR via the doc's apartment
    // (apartment → building → project). Owners sign their APARTMENT's agreement
    // doc (apartment-scoped, project_id NULL/different), so the bare
    // `d.project_id = P` join silently missed those — see
    // `projectSignatureDocIdsSql` (the canonical, index-using doc-set).
    signaturesPendingCount: sql<number>`COALESCE((
      SELECT COUNT(*)::int FROM signature_requests sr
      WHERE sr.status = 'pending'
        AND sr.document_id IN (${projectSignatureDocIdsSql(projectIdRef)})
    ), 0)`.as('sigs_pending'),
    signaturesSignedCount: sql<number>`COALESCE((
      SELECT COUNT(*)::int FROM signature_requests sr
      WHERE sr.status = 'signed'
        AND sr.document_id IN (${projectSignatureDocIdsSql(projectIdRef)})
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

/**
 * Bounded concurrency for `signaturePulse`'s per-project consent aggregates.
 * Each in-flight aggregate holds ONE pg pool connection for its short
 * `withTenant` tx, so the cap MUST stay well under the pool ceiling
 * (default ~10–20) to avoid connection starvation — an UNBOUNDED Promise.all
 * over 100+ projects would exhaust the pool and be WORSE than sequential. 8 is
 * the SAME value + idiom already proven on the bulk-delivery path
 * (`signature-requests.service.ts` `DELIVERY_CONCURRENCY`): enough parallelism
 * to collapse the cold-path latency wall, few enough connections to never
 * starve the pool.
 */
const PULSE_CONSENT_CONCURRENCY = 8;

@Injectable()
export class ProjectsService {
  /**
   * E2 Wave-0 PERF — the read-through stats cache is OPTIONAL by construction.
   * When DI provides it (the wired app path), `orgStats`/`signatureProgress`
   * are cache-read-through and writes invalidate the org's epoch. When it is
   * ABSENT (`new ProjectsService()` in the many unit specs), the service
   * computes fresh every call — identical to the pre-cache behaviour, so no
   * spec needs the cache stood up. `@Optional()` makes Nest inject `undefined`
   * rather than fail when no provider is registered.
   */
  constructor(@Optional() private readonly statsCache?: StatsCacheService) {}

  private requireManager(user: AccessTokenPayload): void {
    if (user.role !== 'manager') throw FORBIDDEN;
  }

  /**
   * Best-effort org-wide stats invalidation after a consent-affecting write.
   * Never throws into the write path — a cache blip must not fail the actual
   * mutation (which already committed). No-op when the cache isn't wired.
   */
  private async invalidateStats(orgId: string): Promise<void> {
    if (!this.statsCache) return;
    try {
      await this.statsCache.invalidateOrg(orgId);
    } catch {
      // Swallow: the bump is a cache hint, not a correctness gate for the
      // write. A missed bump self-heals at the STATS_TTL_SECONDS ceiling.
    }
  }

  /**
   * NS1 (server-side search) — the optional project-list search/filter
   * predicates, additive on top of the existing archived-exclusion + keyset.
   *
   *  - `q`      → name substring ILIKE (case-insensitive; trigram-index served).
   *              The value is bound as a PARAMETER (never string-concatenated)
   *              and the LIKE metacharacters %/_/\ are escaped so a user typing
   *              "50%" searches the literal text, not a wildcard. No injection
   *              surface (drizzle `sql` parameterises ${...}).
   *  - `status` → exact D.18 status equality (Zod-validated enum at the edge).
   *  - `segment`→ a SYSTEM segment computed from the SAME signature facts the
   *              pulse uses, expressed as correlated (NOT) EXISTS subqueries so
   *              the page stays ONE round-trip and the keyset order is untouched:
   *                · stalled  — NOT EXISTS a signed request on a project doc in
   *                             the last PULSE_STALLED_DAYS days.
   *                · expiring — EXISTS a pending request on a project doc whose
   *                             expires_at is within PULSE_EXPIRING_SOON_DAYS.
   *                · mine     — the CALLER is actively assigned to the project.
   *              The doc-resolution (project-level ∪ apartment-level, archived
   *              excluded) mirrors signaturePulse's proj_docs CTE exactly.
   *
   * Returns the array of predicates (possibly empty); the caller ANDs them into
   * the existing WHERE. When the query carries none of q/status/segment this is
   * empty and behaviour is byte-identical to the pre-NS1 list.
   */
  private projectSearchFilters(
    user: AccessTokenPayload,
    query: { q?: string; status?: ProjectStatus; segment?: ProjectSegment },
  ): SQL[] {
    const filters: SQL[] = [];
    if (query.q) {
      // Escape LIKE metacharacters so the search is a literal substring.
      const escaped = query.q.replace(/[\\%_]/g, (c) => `\\${c}`);
      filters.push(sql`${projects.name} ILIKE ${'%' + escaped + '%'}`);
    }
    if (query.status) {
      filters.push(eq(projects.status, query.status));
    }
    if (query.segment === 'mine') {
      filters.push(sql`EXISTS (
        SELECT 1 FROM project_assignments pa
        WHERE pa.project_id = ${projects.id}
          AND pa.user_id = ${user.sub}
          AND pa.unassigned_at IS NULL
      )`);
    } else if (query.segment === 'stalled') {
      // The project's signature-bearing docs (project-level ∪ apartment-level,
      // archived excluded) — same resolution as the pulse. "Stalled" = no
      // SIGNED request on those docs within the stalled window.
      filters.push(sql`NOT EXISTS (
        SELECT 1
        FROM signature_requests sr
        WHERE sr.status = 'signed'
          AND COALESCE(sr.signed_at, sr.created_at) >= now() - (${PULSE_STALLED_DAYS} * interval '1 day')
          AND sr.document_id IN (
            SELECT d.id FROM documents d
              WHERE d.project_id = ${projects.id} AND d.archived_at IS NULL
            UNION
            SELECT d.id FROM documents d
              INNER JOIN apartments a ON a.id = d.apartment_id
              INNER JOIN buildings b ON b.id = a.building_id
              WHERE b.project_id = ${projects.id} AND d.archived_at IS NULL
          )
      )`);
    } else if (query.segment === 'expiring') {
      filters.push(sql`EXISTS (
        SELECT 1
        FROM signature_requests sr
        WHERE sr.status = 'pending'
          AND sr.expires_at IS NOT NULL
          AND sr.expires_at <= now() + (${PULSE_EXPIRING_SOON_DAYS} * interval '1 day')
          AND sr.document_id IN (
            SELECT d.id FROM documents d
              WHERE d.project_id = ${projects.id} AND d.archived_at IS NULL
            UNION
            SELECT d.id FROM documents d
              INNER JOIN apartments a ON a.id = d.apartment_id
              INNER JOIN buildings b ON b.id = a.building_id
              WHERE b.project_id = ${projects.id} AND d.archived_at IS NULL
          )
      )`);
    }
    return filters;
  }

  async list(
    user: AccessTokenPayload,
    query: {
      limit: number;
      cursor?: string;
      q?: string;
      status?: ProjectStatus;
      segment?: ProjectSegment;
    },
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
        const keyset = cur ? keysetCondition(projects.createdAt, projects.id, cur) : undefined;
        // NS1 — additive search/filter predicates (empty ⇒ unchanged behaviour).
        const search = this.projectSearchFilters(user, query);

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
            .where(and(isNull(projects.archivedAt), keyset, ...search))
            .orderBy(...keysetOrderBy(projects.createdAt, projects.id))
            .limit(limit + 1);
        }

        return tx
          .select({ p: projects, ...stats })
          .from(projects)
          .where(and(isNull(projects.archivedAt), keyset, ...search))
          .orderBy(...keysetOrderBy(projects.createdAt, projects.id))
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
   * Lightweight no-oracle visibility gate, designed to run INSIDE an existing
   * withTenant transaction. Enforces the SAME authz as `get()` — org-isolation
   * (RLS) plus the agent → assigned-project scope — but WITHOUT the 5 stats
   * subqueries `get()` computes. The signature-progress methods only need to
   * know "is this project visible to the caller?"; calling `get()` meant a
   * SECOND withTenant (extra connection-acquire + BEGIN/SET ROLE round-trip)
   * plus five thrown-away aggregate subqueries. Throws the same NOT_FOUND
   * (no oracle — a cross-org id and an unassigned-agent id are indistinguishable
   * from "never existed").
   */
  private async assertProjectVisible(
    tx: TenantTx,
    user: AccessTokenPayload,
    projectId: string,
  ): Promise<void> {
    const rows =
      user.role === 'agent'
        ? await tx
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
            .limit(1)
        : await tx
            .select({ id: projects.id })
            .from(projects)
            .where(eq(projects.id, projectId))
            .limit(1);
    if (rows.length === 0) throw NOT_FOUND;
  }

  /**
   * DH2 (V13) — project document-CHECKLIST (ADVISORY only, read-only).
   *
   * Reports, per the project's renewal TRACK (derived from `projects.type` via
   * `trackForProjectType`), the REQUIRED document types and whether each is
   * present, plus a completeness %. A type is `present` iff a NON-archived
   * `documents` row of that `type` is scoped to THIS project — either the DH1
   * canonical scope (`doc_scope='project'` AND `doc_scope_id=projectId`) OR the
   * legacy `project_id` column (back-compat; pre-DH1 + the existing
   * documents.create path still writes `project_id`). Both are tenant-isolated by
   * RLS under the withTenant context, so no cross-project / cross-org leak.
   *
   * ADVISORY ONLY: this method NEVER reads or writes project status — it only
   * reports. No writes of any kind. (The "→ approved" gate-wiring is deferred —
   * V13 Open #2.)
   *
   * Visibility first (no-oracle 404): a cross-org id or an unassigned-agent id is
   * indistinguishable from "never existed" — `assertProjectVisible` throws the
   * same NOT_FOUND `get()` does. We also pull the project's `type` in the same
   * round-trip to derive the track. NO PII and NO document ids/names leave this
   * method — only the type keys + present booleans + counts.
   */
  async documentChecklist(user: AccessTokenPayload, projectId: string): Promise<DocumentChecklist> {
    return withTenant(
      user.orgId,
      async (tx) => {
        // Visibility + load the project type in one query (agent → assigned scope
        // enforced exactly as get()/assertProjectVisible does).
        const baseSelect = tx.select({ type: projects.type }).from(projects).$dynamic();
        const projRows =
          user.role === 'agent'
            ? await baseSelect
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
            : await baseSelect.where(eq(projects.id, projectId)).limit(1);
        const projRow = projRows[0];
        if (!projRow) throw NOT_FOUND;

        const projectType = projRow.type;
        const track = trackForProjectType(projectType);
        const requiredTypes: readonly DocumentType[] = REQUIRED_DOC_TYPES_BY_TRACK[track];

        // Distinct doc TYPES present for this project, restricted to the required
        // set (no point fetching the rest). Non-archived only. Scope = DH1
        // canonical (doc_scope='project' AND doc_scope_id=projectId) OR legacy
        // project_id. RLS scopes to the org; the project filter scopes to this
        // project — no cross-project leak. Counts/types only — NO PII, NO ids.
        const presentTypes = new Set<string>();
        if (requiredTypes.length > 0) {
          const docRows = await tx
            .selectDistinct({ type: documents.type })
            .from(documents)
            .where(
              and(
                isNull(documents.archivedAt),
                inArray(documents.type, requiredTypes as string[]),
                or(
                  and(eq(documents.docScope, 'project'), eq(documents.docScopeId, projectId)),
                  eq(documents.projectId, projectId),
                ),
              ),
            );
          for (const r of docRows) presentTypes.add(r.type);
        }

        const items = requiredTypes.map((type) => ({
          type,
          present: presentTypes.has(type),
        }));
        const presentCount = items.reduce((n, it) => n + (it.present ? 1 : 0), 0);
        const totalCount = items.length;

        return {
          projectId,
          projectType,
          track,
          items,
          presentCount,
          totalCount,
          completionPct: checklistCompletionPct(presentCount, totalCount),
          advisory: true as const,
        };
      },
      { userId: user.sub },
    );
  }

  /**
   * Phase-6 "תמונת מצב" — project signature-progress BOARD (S5a, read-only).
   *
   * Visibility first: `assertProjectVisible` (org-isolation via RLS AND the
   * agent → assigned-project scope), run INSIDE this method's own withTenant.
   * A project not visible to the caller throws the same no-oracle NOT_FOUND
   * — a cross-org id or an unassigned-agent
   * id is indistinguishable from "never existed". Only after the project is
   * proven visible do we compute the aggregates, all under the SAME withTenant
   * org context (RLS scopes every table touched).
   *
   * `apartmentsConsented` is the genuinely-new logic: a BINARY per-apartment
   * measure (NOT share-weighted). An apartment is consented iff it has >=1 active
   * owner ownership AND the count of those owners equals the count of those
   * owners who hold a SIGNED signature_request on a project document. The
   * "matching signed request" detection is `sr.status='signed' AND
   * sr.document_id IN (projectSignatureDocIdsSql(projectId))` — the canonical
   * project↔document resolution (project-level docs ∪ apartment-level docs whose
   * apartment is in the project). This FIXES the live bug where an owner signed
   * their APARTMENT's agreement doc (apartment-scoped, project_id NULL/different)
   * and the old bare `d.project_id = <projectId>` join missed it, leaving
   * consentedPct / signaturesSigned at 0. NO PII: only counts + the project's
   * own target/derived percentages leave this method.
   */
  async signatureProgress(user: AccessTokenPayload, projectId: string): Promise<SignatureProgress> {
    // E2 Wave-0 PERF — read-through cache (tenant-scoped key: org_id + epoch +
    // projectId). The board VALUE is per-project, identical for every caller
    // who is allowed to see it (it's counts, not caller-specific), so it is
    // safe to share across callers — BUT visibility is per-caller. We therefore
    // ALWAYS run the no-oracle visibility gate first (a cache HIT must NEVER
    // bypass authz: an unassigned agent who guessed a projectId must still get
    // 404, not a leaked board), then cache ONLY the heavy aggregate compute.
    if (this.statsCache) {
      await withTenant(user.orgId, (tx) => this.assertProjectVisible(tx, user, projectId), {
        userId: user.sub,
      });
      return this.statsCache.readThrough(
        user.orgId,
        this.statsCache.signatureProgressKey(projectId),
        () => this.computeSignatureProgress(user, projectId),
      );
    }
    return this.computeSignatureProgress(user, projectId);
  }

  /**
   * E2 Wave-1 B0/B5 — SINGLE SOURCE OF TRUTH for the SHARE-WEIGHTED consent
   * aggregates. Runs on the PASSED tenant tx (NO nested withTenant) so both
   * callers share ONE query under their own RLS context:
   *  - `computeSignatureProgress` (B0 board) passes its own withTenant's tx,
   *    then assembles the 7 board fields + `basis: 'share'` from this result.
   *  - the `→ approved` status gate (B5) passes the already-open update() tx
   *    and derives JUST the `metThreshold` boolean.
   * Previously this CTE was duplicated byte-for-byte in both places; the B5
   * copy projected only a subset. This method returns the SUPERSET so each
   * caller takes exactly what it needs from ONE round-trip.
   * ───────────────────────────────────────────────────────────────────────────
   * Per apartment, the consent CONTRIBUTION is the signed owners' total share
   * divided by ALL active owners' total share, clamped to [0,1]:
   *   contribution = Σ(signed owners' share) / Σ(active owners' share)
   * "signed" = the owner holds a signature_requests.status='signed' on a
   * document of THIS project (the IDENTICAL signed-detection join the old binary
   * board used — unchanged). The canonical exact share is the rational
   * `share_numerator/share_denominator` (default 0/10000); we normalise by the
   * apartment's OWN total active-owner share rather than assuming shares sum to 1
   * — the ROBUST form (an apartment whose owner shares are mid-edit or default-0
   * still yields a sane [0,1] value, and a zero-active-share apartment
   * contributes 0, never NaN).
   *
   * The headline `consentedPct` is EQUAL apartment weight:
   *   consentedPct = round(Σ contributions / total_apartments * 100)
   * total_apartments = every non-archived apartment INCLUDING zero-owner ones
   * (a zero-owner apartment contributes 0 but still counts in the denominator —
   * it is "not consented", not "excluded").
   *
   * `apartmentsConsented` is a SEPARATE display count meaning FULLY-consented
   * (contribution == 1: active_share > 0 AND signed_share == active_share). It
   * does NOT drive consentedPct.
   *
   * OWNER-CONFIRMED interpretation (E2 Wave-1 B0). LEGAL GATE (OD-1/OD-3): the
   * EXACT statutory %, the shell-owner denominator, and the rounding rule are
   * legally gated and refined later — this ships the engine BEHIND the
   * `basis: 'share'` label, NOT as a statutory claim.
   *
   * NO PII leaves this query: only summed shares + counts are projected; the
   * per-owner shares live entirely inside aggregate subqueries.
   */
  private async computeConsentAggregates(
    tx: TenantTx,
    projectId: string,
  ): Promise<{
    totalApartments: number;
    apartmentsConsented: number;
    consentedPct: number;
    targetSignaturePct: number | null;
    signaturesSigned: number;
    signaturesPending: number;
  }> {
    const result = await tx.execute(sql`
      WITH proj_apartments AS (
        SELECT a.id
        FROM apartments a
        INNER JOIN buildings b ON b.id = a.building_id
        WHERE b.project_id = ${projectId}
          AND a.archived_at IS NULL
      ),
      -- PERF (login-nav-latency 2026-06-26): the project's signature-bearing
      -- doc set was inlined THREE times below (the signed-share EXISTS + the two
      -- signature counts), so the planner re-resolved the same documents⋈
      -- apartments⋈buildings UNION three times per consent query — and this
      -- consent query is itself fanned out once per project on the cold home
      -- "signature-pulse" read. Materialising it ONCE as a CTE removes that
      -- redundant re-execution. It STILL reuses the canonical
      -- \`projectSignatureDocIdsSql\` (single source of truth — same doc-set
      -- definition, same partial-index alignment, same archived-excluded
      -- valid-consent rule); only the number of times the planner evaluates it
      -- changes, never the rows it yields, so every count is byte-identical.
      proj_doc_ids AS (
        ${projectSignatureDocIdsSql(projectId)}
      ),
      apt_consent AS (
        SELECT
          pa.id,
          -- Σ of ALL active owners' exact share (numerator/denominator) as a
          -- float ratio; 0 when the apartment has no active owners.
          COALESCE((SELECT SUM(o.share_numerator::numeric / o.share_denominator)
             FROM ownerships o
             WHERE o.apartment_id = pa.id
               AND o.ended_at IS NULL
               AND o.relationship = 'owner'), 0) AS active_share,
          -- Σ of the SIGNED active owners' exact share (same signed-detection
          -- join as before): an owner with a 'signed' request on a project doc.
          COALESCE((SELECT SUM(o.share_numerator::numeric / o.share_denominator)
             FROM ownerships o
             WHERE o.apartment_id = pa.id
               AND o.ended_at IS NULL
               AND o.relationship = 'owner'
               AND EXISTS (
                 SELECT 1
                 FROM signature_requests sr
                 WHERE sr.owner_id = o.owner_id
                   AND sr.status = 'signed'
                   AND sr.document_id IN (SELECT id FROM proj_doc_ids)
               )), 0) AS signed_share
        FROM proj_apartments pa
      ),
      apt_contrib AS (
        SELECT
          id,
          active_share,
          signed_share,
          -- contribution = signed_share / active_share, clamped to [0,1];
          -- 0 when active_share = 0 (zero-owner / zero-active-share apt).
          CASE WHEN active_share > 0
               THEN LEAST(1, GREATEST(0, signed_share / active_share))
               ELSE 0 END AS contribution
        FROM apt_consent
      )
      SELECT
        (SELECT COUNT(*)::int FROM proj_apartments) AS total_apartments,
        -- FULLY-consented apartments (contribution == 1): active share > 0
        -- AND the full active share signed. Retained for display only.
        (SELECT COUNT(*)::int FROM apt_contrib
           WHERE active_share > 0 AND signed_share >= active_share) AS apartments_consented,
        -- Σ of per-apartment contributions (the share-weighted numerator).
        COALESCE((SELECT SUM(contribution) FROM apt_contrib), 0) AS consented_weight,
        (SELECT COUNT(*)::int FROM signature_requests sr
           WHERE sr.status = 'signed'
             AND sr.document_id IN (SELECT id FROM proj_doc_ids)) AS signatures_signed,
        (SELECT COUNT(*)::int FROM signature_requests sr
           WHERE sr.status = 'pending'
             AND sr.document_id IN (SELECT id FROM proj_doc_ids)) AS signatures_pending,
        (SELECT target_signature_pct FROM projects WHERE id = ${projectId}) AS target_signature_pct
    `);
    const r = (result as unknown as { rows: Array<Record<string, unknown>> }).rows[0] ?? {};

    const totalApartments = Number(r['total_apartments'] ?? 0);
    const apartmentsConsented = Number(r['apartments_consented'] ?? 0);
    // pg `numeric`/SUM arrives as a string (or null) — normalise to number.
    const consentedWeight = Number(r['consented_weight'] ?? 0);
    const signaturesSigned = Number(r['signatures_signed'] ?? 0);
    const signaturesPending = Number(r['signatures_pending'] ?? 0);
    // pg `numeric` arrives as a string (or null) — normalise to number|null.
    const rawTarget = r['target_signature_pct'];
    const targetSignaturePct =
      rawTarget === null || rawTarget === undefined ? null : Number(rawTarget);

    const consentedPct =
      totalApartments > 0 ? Math.round((consentedWeight / totalApartments) * 100) : 0;

    return {
      totalApartments,
      apartmentsConsented,
      consentedPct,
      targetSignaturePct,
      signaturesSigned,
      signaturesPending,
    };
  }

  private async computeSignatureProgress(
    user: AccessTokenPayload,
    projectId: string,
  ): Promise<SignatureProgress> {
    return withTenant(
      user.orgId,
      async (tx) => {
        // No-oracle visibility gate, INSIDE this tx (was a separate get() tx
        // + 5 thrown-away stats subqueries). Throws NOT_FOUND when invisible.
        // (On the cached path the wrapper above already ran this; keeping it
        // here means the uncached path and the cache-MISS compute are identical
        // — the gate is cheap and idempotent.)
        await this.assertProjectVisible(tx, user, projectId);

        // E2 Wave-1 B0 — SHARE-WEIGHTED consent. The aggregate query is the
        // single-source `computeConsentAggregates` (shared with the B5 →approved
        // gate), run on THIS withTenant's tx. The board assembles all 7 fields
        // from it; the derived `metThreshold` matches the gate's rule exactly.
        const agg = await this.computeConsentAggregates(tx, projectId);
        const metThreshold =
          agg.targetSignaturePct !== null && agg.consentedPct >= agg.targetSignaturePct;

        return {
          totalApartments: agg.totalApartments,
          apartmentsConsented: agg.apartmentsConsented,
          signaturesSigned: agg.signaturesSigned,
          signaturesPending: agg.signaturesPending,
          targetSignaturePct: agg.targetSignaturePct,
          consentedPct: agg.consentedPct,
          metThreshold,
          // E2 Wave-1 B0 — always 'share' today (share-weighted). Drives the
          // mandatory FE basis label; never a bare %.
          basis: 'share' as const,
        };
      },
      { userId: user.sub },
    );
  }

  /**
   * E2 Wave-1 B5 — the `metThreshold` LEGAL GATE for the `→ approved` status
   * transition, computed on an ALREADY-OPEN tenant tx (so it runs inside the
   * update()'s withTenant + RLS context, NOT a nested withTenant).
   *
   * Delegates to the single-source `computeConsentAggregates` (the SAME query
   * the B0 board uses) and derives JUST the boolean: `metThreshold = target !=
   * null && consentedPct >= target`. This is the same by-share rule the board
   * surfaces — we do NOT recompute by-heads. NO PII leaves the query (summed
   * shares + counts only).
   *
   * Returns `metThreshold` only; the caller has already proven the project
   * visible (it read the `before` row under the same RLS context).
   */
  private async computeMetThresholdOnTx(tx: TenantTx, projectId: string): Promise<boolean> {
    const agg = await this.computeConsentAggregates(tx, projectId);
    return agg.targetSignaturePct !== null && agg.consentedPct >= agg.targetSignaturePct;
  }

  /**
   * Phase-6 "תמונת מצב" — per-apartment DRILL-DOWN (S5d, read-only).
   *
   * Same visibility gate as the 5a aggregate: `assertProjectVisible` so a
   * cross-org id or an unassigned-agent id throws the no-oracle NOT_FOUND
   * BEFORE any compute, and the whole query runs under the SAME withTenant org
   * context (RLS scopes every table touched).
   *
   * This breaks the 5a board's single aggregate CTE out PER apartment: for each
   * non-archived apartment in the project we compute `totalOwners` (active
   * `relationship='owner'` ownerships) and `signedOwners` (of those, the ones with
   * a SIGNED signature_request on a project document — the IDENTICAL consent join
   * the 5a board uses), then derive a TERNARY status (consented / partial / none).
   *
   * NO PII: the projection selects ONLY apartment fields (id/number/floor) +
   * the two counts + the derived status. No owner id, name, national_id, or phone
   * is ever selected — the consent join lives entirely inside correlated EXISTS
   * subqueries whose results are pure counts.
   */
  async signatureProgressApartments(
    user: AccessTokenPayload,
    projectId: string,
  ): Promise<ApartmentSignatureProgress[]> {
    return withTenant(
      user.orgId,
      async (tx) => {
        // No-oracle visibility gate, INSIDE this tx (was a separate get() tx
        // + 5 thrown-away stats subqueries). Throws NOT_FOUND when invisible.
        await this.assertProjectVisible(tx, user, projectId);

        const result = await tx.execute(sql`
          SELECT
            a.id AS apartment_id,
            a.number AS number,
            a.floor AS floor,
            -- active owner ownerships on this apartment
            (SELECT COUNT(*)::int
               FROM ownerships o
               WHERE o.apartment_id = a.id
                 AND o.ended_at IS NULL
                 AND o.relationship = 'owner') AS total_owners,
            -- of those, the ones with a signed request on a project document
            (SELECT COUNT(*)::int
               FROM ownerships o
               WHERE o.apartment_id = a.id
                 AND o.ended_at IS NULL
                 AND o.relationship = 'owner'
                 AND EXISTS (
                   SELECT 1
                   FROM signature_requests sr
                   WHERE sr.owner_id = o.owner_id
                     AND sr.status = 'signed'
                     AND sr.document_id IN (${projectSignatureDocIdsSql(projectId)})
                 )) AS signed_owners
          FROM apartments a
          INNER JOIN buildings b ON b.id = a.building_id
          WHERE b.project_id = ${projectId}
            AND a.archived_at IS NULL
          -- Natural (numeric-aware) order: extracted numeral first (digitless
          -- labels last), raw label as the lexical tie-break. ::numeric (not
          -- ::bigint) so a pathologically long digit-run cannot overflow.
          ORDER BY NULLIF(regexp_replace(a.number, '\\D', '', 'g'), '')::numeric ASC NULLS LAST,
                   a.number ASC
        `);
        const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;

        return rows.map((r) => {
          const totalOwners = Number(r['total_owners'] ?? 0);
          const signedOwners = Number(r['signed_owners'] ?? 0);
          const status: ApartmentSignatureProgress['status'] =
            totalOwners > 0 && signedOwners === totalOwners
              ? 'consented'
              : signedOwners > 0
                ? 'partial'
                : 'none';
          const floorRaw = r['floor'];
          return {
            apartmentId: String(r['apartment_id']),
            number: String(r['number']),
            floor: floorRaw === null || floorRaw === undefined ? null : Number(floorRaw),
            totalOwners,
            signedOwners,
            status,
          };
        });
      },
      { userId: user.sub },
    );
  }

  /**
   * E2 Wave-2 B4 — apartment HOLDOUTS ("מי תקוע / who's stuck"). The NAMED list of
   * the ACTIVE owners of ONE apartment who have NOT signed — the per-apartment
   * drill-down's human counterpart for the board (E2.2-S3 consumes it later).
   *
   * This is the ONLY signature-progress surface that returns owner NAMES, so it
   * is a PII reveal and is gated + audited EXACTLY like the owners reveal-pii
   * endpoint (`OwnersService.revealPii`, POST /owners/:id/reveal-pii):
   *   - `view_owner_pii` capability REQUIRED (manager always · agent iff the flag ·
   *     viewer never, via `resolveOwnerPiiFidelity === 'unmasked'`) — else 403.
   *   - a per-access audit row (`apartment.holdouts_revealed`, ISO A.12.4) records
   *     WHO revealed WHICH apartment's holdouts, WHEN — NEVER any cleartext value.
   *
   * Gate order (no-oracle, mirrors the rest of signature-progress):
   *   `assertProjectVisible` 404 (cross-org / unassigned-agent is indistinguishable
   *   from absent) → apartment-in-project 404 (an apartment of another project is
   *   the same no-oracle 404) → `view_owner_pii` 403. Visibility/scope is proven
   *   BEFORE the pii capability so an out-of-scope apartment never becomes an oracle.
   *
   * "Holdout" = an ACTIVE owner ownership (`ended_at IS NULL AND relationship='owner'`)
   * of the apartment who DOES NOT hold a SIGNED signature_request on a project
   * document — the EXACT negation of the consent detection the drill-down/board
   * use (`sr.owner_id = o.owner_id AND sr.status='signed' AND sr.document_id IN
   * (projectSignatureDocIdsSql(projectId))` — project-level docs ∪ the project's
   * apartment-level docs, so an owner who signed their apartment's agreement is
   * correctly NOT a holdout).
   *
   * STRICT PII boundary: the projection returns ONLY `owner_id`, the in-SQL
   * decrypted `name`, and the apartment `number`. national_id / phone are NEVER
   * selected (never leave Postgres), NEVER returned, NEVER logged.
   */
  async signatureProgressHoldouts(
    user: AccessTokenPayload,
    projectId: string,
    apartmentId: string,
  ): Promise<ApartmentHoldout[]> {
    return withTenant(
      user.orgId,
      async (tx) => {
        // No-oracle visibility gate FIRST (org-isolation via RLS + agent →
        // assigned-project scope). Throws NOT_FOUND when invisible.
        await this.assertProjectVisible(tx, user, projectId);

        // The apartment must belong to THIS visible project; an apartment of
        // another project (or org) is the SAME no-oracle 404. Checked BEFORE the
        // pii capability so an out-of-scope apartment is never a capability oracle.
        const [apt] = await tx
          .select({ id: apartments.id, number: apartments.number })
          .from(apartments)
          .innerJoin(buildings, eq(buildings.id, apartments.buildingId))
          .where(
            and(
              eq(apartments.id, apartmentId),
              eq(buildings.projectId, projectId),
              isNull(apartments.archivedAt),
            ),
          )
          .limit(1);
        if (!apt) throw NOT_FOUND;

        // view_owner_pii gate: manager always · agent iff the flag · viewer never.
        // Anything but `unmasked` → 403 (this surface returns owner NAMES).
        const fidelity = await resolveOwnerPiiFidelity(tx, user);
        if (fidelity !== 'unmasked') throw FORBIDDEN;

        // Active owners of the apartment who have NOT signed (negation of the
        // consent join). name decrypted IN-SQL (app.encryption_key set by
        // withTenant) so the ciphertext never crosses the wire; national_id /
        // phone are NEVER selected. Ordered by name (Hebrew COLLATE) so the list
        // is stable; a shell owner (null name) sorts last.
        const result = await tx.execute(sql`
          SELECT
            o.owner_id AS owner_id,
            pgp_sym_decrypt(ow.name_encrypted, current_setting('app.encryption_key'))::text AS name
          FROM ownerships o
          INNER JOIN owners ow ON ow.id = o.owner_id
          WHERE o.apartment_id = ${apartmentId}
            AND o.ended_at IS NULL
            AND o.relationship = 'owner'
            AND ow.erased_at IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM signature_requests sr
              WHERE sr.owner_id = o.owner_id
                AND sr.status = 'signed'
                AND sr.document_id IN (${projectSignatureDocIdsSql(projectId)})
            )
          ORDER BY pgp_sym_decrypt(ow.name_encrypted, current_setting('app.encryption_key'))::text
                     COLLATE he_il_icu ASC NULLS LAST,
                   o.owner_id ASC
        `);
        const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;

        // HB-5 fix — the per-APARTMENT signable document a one-click chase CREATES
        // a request against. Signing is PER-APARTMENT (each apartment has its OWN
        // agreement doc), so the create MUST target THIS apartment's doc — a single
        // project-wide campaign doc resolves to ONE apartment's agreement and a
        // create for a holdout in a DIFFERENT apartment 409s `recipient_not_
        // associated`. Precedence (RLS-safe via withTenant — every read is
        // org-scoped + the apartment is already proven in-project above):
        //   (1) THIS apartment's most-recent FINALIZED (uploaded_at NOT NULL),
        //       non-archived, AGREEMENT-type doc — matched by the canonical
        //       doc_scope='apartment' + doc_scope_id=apartmentId OR the legacy
        //       apartment_id=apartmentId column (freshly-seeded apartment docs
        //       carry the legacy column but doc_scope='org', so BOTH are needed);
        //   (2) ELSE the project's most-recent finalized PROJECT-scoped agreement
        //       (doc_scope='project'+scope_id=projectId OR legacy project_id, and
        //       NOT apartment-scoped) — the doc every owner may sign;
        //   (3) ELSE NULL.
        // Document ids only — never PII.
        const signableResult = await tx.execute(sql`
          SELECT COALESCE(
            (SELECT d.id
               FROM documents d
               WHERE d.type = 'agreement'
                 AND d.uploaded_at IS NOT NULL
                 AND d.archived_at IS NULL
                 AND (
                   (d.doc_scope = 'apartment' AND d.doc_scope_id = ${apartmentId})
                   OR d.apartment_id = ${apartmentId}
                 )
               ORDER BY d.uploaded_at DESC
               LIMIT 1),
            (SELECT d.id
               FROM documents d
               WHERE d.type = 'agreement'
                 AND d.uploaded_at IS NOT NULL
                 AND d.archived_at IS NULL
                 AND d.apartment_id IS NULL
                 AND d.doc_scope <> 'apartment'
                 AND (
                   (d.doc_scope = 'project' AND d.doc_scope_id = ${projectId})
                   OR d.project_id = ${projectId}
                 )
               ORDER BY d.uploaded_at DESC
               LIMIT 1)
          ) AS signable_document_id
        `);
        const signableRows = (signableResult as unknown as { rows: Array<Record<string, unknown>> })
          .rows;
        const signableRaw = signableRows[0]?.['signable_document_id'];
        const signableDocumentId =
          signableRaw === null || signableRaw === undefined ? null : String(signableRaw);

        const apartmentNumber = String(apt.number);
        const holdouts: ApartmentHoldout[] = rows.map((r) => ({
          ownerId: String(r['owner_id']),
          name: r['name'] === null || r['name'] === undefined ? null : String(r['name']),
          apartmentNumber,
          signableDocumentId,
        }));

        // ISO A.12.4 — per-access audit (a NAMED PII reveal). Record WHO revealed
        // WHICH apartment's holdouts + HOW MANY; NEVER any name/national_id/phone.
        await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
          orgId: user.orgId,
          actorId: user.sub,
          actorType: 'user',
          action: 'apartment.holdouts_revealed',
          targetTable: 'apartments',
          targetId: apartmentId,
          afterState: { projectId, holdoutCount: holdouts.length },
          sessionId: user.sid,
        });

        return holdouts;
      },
      { userId: user.sub },
    );
  }

  /**
   * Battle-Map BM-1 — the LEVERAGE scorer: the single not-yet-fully-signed
   * active owner whose signature, if flipped to signed, moves the project's
   * headline share-weighted `consentedPct` the MOST toward target.
   *
   * ── WHY MARGINAL-DELTA, NOT SHARE-SUM (the council + red-team correctness
   * rule) ─────────────────────────────────────────────────────────────────────
   * The headline (`computeConsentAggregates`) is an EQUAL-APARTMENT-WEIGHTED
   * average of per-apartment contributions, where apartment k contributes
   * `clamp(Σ signed-owner share / Σ active-owner share, 0, 1)`. An owner signs
   * ONCE for the whole project (the consent join is per OWNER across the
   * project's docs), so flipping owner X to signed adds X's share to the signed
   * sum of EVERY apartment X co-owns. The headline delta of flipping X is thus
   *   Δ(X) = Σ_{apt k owned by X, X unsigned}
   *            ( clamp((signed_k + own_{X,k}) / active_k)
   *            − clamp( signed_k          / active_k) )  /  totalApartments.
   * Ranking by raw SHARE-SUM (Σ of X's shares) is WRONG on two counts: (a) the
   * equal-apartment weighting means an owner spread thinly across many apartments
   * can out-rank a single large share; (b) the per-apartment clamp means share in
   * an already-near-complete apartment is wasted. We rank by the EXACT (unrounded)
   * per-OWNER Δ — summed over the owner's apartments — and only THEN round
   * `projectedPct`. The reported `apartmentId/apartmentLabel` is the owner's
   * SINGLE most-impactful apartment (largest per-apartment Δ contribution).
   *
   * Reuses the single-source consent machinery: the per-apartment active-share /
   * signed-share / clamped-contribution definitions are IDENTICAL to
   * `computeConsentAggregates` (same `relationship='owner' AND ended_at IS NULL`
   * active set, same signed-detection EXISTS join). `currentPct` itself comes
   * from `computeConsentAggregates` so the card and the board agree to the point.
   *
   * ── PII (mirrors B4 holdouts) ────────────────────────────────────────────────
   * The winning owner's NAME is returned ONLY when the caller holds
   * `view_owner_pii` (manager always · agent iff the flag · viewer never). When
   * the cap is absent we still return the leverage (apartment + delta), with
   * `ownerName: null`. national_id / phone are NEVER selected. No audit row is
   * written when no name is revealed; when a name IS revealed it is the same
   * NAMED-PII reveal as B4 and is audited (`project.leverage_revealed`).
   *
   * Gate order (no-oracle): `assertProjectVisible` 404 first; the `view_owner_pii`
   * decision is a FIDELITY downgrade (name-or-no-name), never a 403 — leverage is
   * a board-visible surface for everyone with `projects.read`.
   *
   * Returns `leverage: null` when there are no movable owners (every active owner
   * already signed, or no candidate has a positive marginal delta).
   */
  async leverage(user: AccessTokenPayload, projectId: string): Promise<ProjectLeverage> {
    return withTenant(
      user.orgId,
      async (tx) => {
        // No-oracle visibility gate FIRST (org-isolation via RLS + agent →
        // assigned-project scope). Throws NOT_FOUND when invisible.
        await this.assertProjectVisible(tx, user, projectId);

        // The CURRENT headline — single-source with the board (same CTE). The
        // candidate scorer below recomputes the SAME contribution shape, so
        // `currentPct` here and the per-candidate baseline agree.
        const agg = await this.computeConsentAggregates(tx, projectId);
        const currentPct = agg.consentedPct;
        const targetSignaturePct = agg.targetSignaturePct;

        // PII fidelity decision (mirrors B4). Manager always unmasked; agent iff
        // view_owner_pii; viewer masked. Masked → return leverage WITHOUT name.
        const fidelity = await resolveOwnerPiiFidelity(tx, user);
        const reveal = fidelity === 'unmasked';

        // ── Candidate scorer, ONE pass ──────────────────────────────────────
        // `apt_shares` is the per-apartment active/signed share (identical to
        // computeConsentAggregates). `owner_apt` is every (unsigned active owner,
        // apartment) pair with that pair's marginal Δcontribution if the owner
        // signs. `owner_delta` SUMS those per-apartment deltas PER OWNER (an owner
        // signs once → flips in all their apartments) and picks the owner's
        // single most-impactful apartment for display. We rank owners by the
        // summed delta DESC and round `projectedPct` ONCE off the EXACT current
        // headline weight. Name decrypted ONLY when `reveal`; never national_id/phone.
        const result = await tx.execute(sql`
          WITH proj_apartments AS (
            SELECT a.id, a.number
            FROM apartments a
            INNER JOIN buildings b ON b.id = a.building_id
            WHERE b.project_id = ${projectId}
              AND a.archived_at IS NULL
          ),
          apt_shares AS (
            SELECT
              pa.id AS apartment_id,
              pa.number AS apartment_number,
              COALESCE((SELECT SUM(o.share_numerator::numeric / o.share_denominator)
                 FROM ownerships o
                 WHERE o.apartment_id = pa.id
                   AND o.ended_at IS NULL
                   AND o.relationship = 'owner'), 0) AS active_share,
              COALESCE((SELECT SUM(o.share_numerator::numeric / o.share_denominator)
                 FROM ownerships o
                 WHERE o.apartment_id = pa.id
                   AND o.ended_at IS NULL
                   AND o.relationship = 'owner'
                   AND EXISTS (
                     SELECT 1
                     FROM signature_requests sr
                     WHERE sr.owner_id = o.owner_id
                       AND sr.status = 'signed'
                       AND sr.document_id IN (${projectSignatureDocIdsSql(projectId)})
                   )), 0) AS signed_share
            FROM proj_apartments pa
          ),
          -- The EXACT current headline numerator: Σ over ALL apartments of the
          -- clamped contribution (identical to computeConsentAggregates'
          -- consented_weight). Equal-apartment-weighted denominator = COUNT(*).
          headline AS (
            SELECT
              (SELECT COUNT(*)::int FROM proj_apartments) AS total_apartments,
              COALESCE(SUM(
                CASE WHEN active_share > 0
                     THEN LEAST(1, GREATEST(0, signed_share / active_share))
                     ELSE 0 END), 0) AS current_weight
            FROM apt_shares
          ),
          owner_apt AS (
            -- Every (UNSIGNED active owner, apartment) pair with that pair's
            -- marginal Δcontribution if the owner flips to signed.
            SELECT
              o.owner_id,
              s.apartment_id,
              s.apartment_number,
              s.active_share,
              (o.share_numerator::numeric / o.share_denominator) AS own_share,
              (CASE WHEN s.active_share > 0
                    THEN LEAST(1, GREATEST(0, (s.signed_share + (o.share_numerator::numeric / o.share_denominator)) / s.active_share))
                    ELSE 0 END)
              - (CASE WHEN s.active_share > 0
                    THEN LEAST(1, GREATEST(0, s.signed_share / s.active_share))
                    ELSE 0 END) AS delta_contrib
            FROM ownerships o
            INNER JOIN apt_shares s ON s.apartment_id = o.apartment_id
            WHERE o.ended_at IS NULL
              AND o.relationship = 'owner'
              AND NOT EXISTS (
                SELECT 1
                FROM signature_requests sr
                WHERE sr.owner_id = o.owner_id
                  AND sr.status = 'signed'
                  AND sr.document_id IN (${projectSignatureDocIdsSql(projectId)})
              )
          ),
          -- Per-OWNER total delta (signing flips them in ALL their apartments)
          -- plus their single most-impactful apartment (largest per-apt delta;
          -- apartment-number then id as deterministic tie-breaks).
          owner_delta AS (
            SELECT
              owner_id,
              SUM(delta_contrib) AS total_delta,
              (ARRAY_AGG(apartment_id ORDER BY delta_contrib DESC, apartment_number ASC, apartment_id ASC))[1] AS top_apartment_id,
              (ARRAY_AGG(apartment_number ORDER BY delta_contrib DESC, apartment_number ASC, apartment_id ASC))[1] AS top_apartment_number,
              (ARRAY_AGG(own_share ORDER BY delta_contrib DESC, apartment_number ASC, apartment_id ASC))[1] AS top_own_share,
              (ARRAY_AGG(active_share ORDER BY delta_contrib DESC, apartment_number ASC, apartment_id ASC))[1] AS top_active_share
            FROM owner_apt
            GROUP BY owner_id
          )
          SELECT
            od.owner_id,
            od.top_apartment_id AS apartment_id,
            od.top_apartment_number AS apartment_number,
            od.top_own_share AS own_share,
            od.top_active_share AS active_share,
            od.total_delta AS delta_contrib,
            h.total_apartments,
            h.current_weight,
            ${
              reveal
                ? sql`pgp_sym_decrypt(ow.name_encrypted, current_setting('app.encryption_key'))::text`
                : sql`NULL::text`
            } AS owner_name
          FROM owner_delta od
          CROSS JOIN headline h
          INNER JOIN owners ow ON ow.id = od.owner_id AND ow.erased_at IS NULL
          WHERE od.total_delta > 0
          ORDER BY od.total_delta DESC,
                   od.top_apartment_number ASC,
                   od.owner_id ASC
          LIMIT 1
        `);
        const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;
        const top = rows[0];

        if (!top) {
          // All signed, or no movable owner (no positive marginal delta).
          return { projectId, currentPct, basis: 'share' as const, leverage: null };
        }

        const totalApartments = Number(top['total_apartments'] ?? 0);
        const currentWeight = Number(top['current_weight'] ?? 0);
        const deltaContrib = Number(top['delta_contrib'] ?? 0);
        const activeShare = Number(top['active_share'] ?? 0);
        const ownShare = Number(top['own_share'] ?? 0);

        // This owner's own fraction of their (most-impactful) apartment, as a
        // percent. That apartment has active_share > 0 (it hosted a positive
        // delta), so this never divides by zero; clamp to [0,100] for safety.
        const ownerSharePctInApartment =
          activeShare > 0 ? Math.min(100, Math.max(0, (ownShare / activeShare) * 100)) : 0;

        // projectedPct = round((Σ current contributions + Δowner) / N * 100),
        // rounded ONCE off the EXACT current weight (never the rounded board %).
        const projectedPct =
          totalApartments > 0
            ? Math.round(((currentWeight + deltaContrib) / totalApartments) * 100)
            : currentPct;

        const crossesThreshold = targetSignaturePct !== null && projectedPct >= targetSignaturePct;

        const rawName = top['owner_name'];
        const ownerName =
          reveal && rawName !== null && rawName !== undefined ? String(rawName) : null;

        // NAMED-PII reveal (only when a name actually left Postgres) — audit it
        // like B4. Counts/ids only; NEVER the name/national_id/phone.
        if (ownerName !== null) {
          await new AuditService(tx, { ip: user.ip, userAgent: user.userAgent }).log({
            orgId: user.orgId,
            actorId: user.sub,
            actorType: 'user',
            action: 'project.leverage_revealed',
            targetTable: 'projects',
            targetId: projectId,
            afterState: {
              ownerId: String(top['owner_id']),
              apartmentId: String(top['apartment_id']),
            },
            sessionId: user.sid,
          });
        }

        return {
          projectId,
          currentPct,
          basis: 'share' as const,
          leverage: {
            ownerId: String(top['owner_id']),
            ownerName,
            apartmentId: String(top['apartment_id']),
            apartmentLabel: String(top['apartment_number']),
            ownerSharePctInApartment,
            projectedPct,
            crossesThreshold,
          },
        };
      },
      { userId: user.sub },
    );
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
    // E2 Wave-0 PERF — read-through cache. The KEY embeds the scope that varies
    // the OUTPUT: an agent's counts are scoped to their assigned projects
    // (key `agent:<userId>`); manager/viewer share the org-wide result (`all`).
    // So an agent never reads another agent's scoped numbers, and never reads
    // the org-wide ones — the value under each key was computed for exactly that
    // scope. No per-caller authz gate is needed here: orgStats has no
    // project-id input to guess (every org member may read THEIR OWN org-scoped
    // KPI), and RLS still scopes the MISS-path compute to the caller's org.
    if (this.statsCache) {
      const scope = user.role === 'agent' ? { agentId: user.sub } : ('all' as const);
      return this.statsCache.readThrough(user.orgId, this.statsCache.orgStatsKey(scope), () =>
        this.computeOrgStats(user),
      );
    }
    return this.computeOrgStats(user);
  }

  private async computeOrgStats(user: AccessTokenPayload): Promise<OrgStats> {
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

  /**
   * E2 Wave-2 B1 — the org-wide "signature pulse" feed backing the board-first
   * home (E2.1). Returns one {@link ProjectPulseRow} PER project the caller may
   * see — an AGENT sees ONLY their assigned projects, a manager/viewer the whole
   * org — plus the A8 `needsHuman` bucket and the header `buckets` counts.
   *
   * ── AGENT-SCOPE (the load-bearing visibility invariant) ────────────────────
   * The set of projects is resolved by the SAME rule as everywhere else: agents
   * inner-join their ACTIVE project_assignments (unassigned_at IS NULL), so an
   * unassigned project never enters the feed. Org isolation is RLS (withTenant);
   * a cross-tenant org therefore yields ZERO visible projects → an empty feed,
   * never another org's rows.
   *
   * ── CONSENT IS SINGLE-SOURCE ───────────────────────────────────────────────
   * The consent fields (`consentedPct`/`metThreshold`/`basis`) come from
   * `computeConsentAggregates` — the IDENTICAL share-weighted CTE the per-project
   * board uses — run per visible project under THIS withTenant's tx. We do NOT
   * recompute consent by-heads, so the home feed and the board agree exactly.
   * The per-project consent compute is read-through cached under the SAME
   * tenant-scoped key the board uses (`sigProgress:p:<projectId>`), so a warm
   * board read warms the pulse and vice-versa — never a cross-tenant key.
   *
   * ── NO PII ─────────────────────────────────────────────────────────────────
   * Every projected field is a count, a derived %, a timestamp, or the project's
   * own id/name. The signature-activity query touches signature_requests +
   * documents but selects only aggregates; no owner id/name/national_id/phone is
   * ever read.
   */
  async signaturePulse(user: AccessTokenPayload): Promise<SignaturePulse> {
    // 1) Resolve the visible projects + their PII-free signature-activity facts
    //    in ONE round-trip, scoped by RLS (org) AND the agent assignment join.
    const facts = await withTenant(
      user.orgId,
      async (tx) => {
        // The agent-visibility predicate, applied as a project_assignments
        // inner-join filter. Manager/viewer: no extra filter (whole org).
        const visibleProjects =
          user.role === 'agent'
            ? sql`
                SELECT p.id, p.name
                FROM projects p
                INNER JOIN project_assignments pa
                  ON pa.project_id = p.id
                  AND pa.user_id = ${user.sub}
                  AND pa.unassigned_at IS NULL
                WHERE p.archived_at IS NULL`
            : sql`
                SELECT p.id, p.name
                FROM projects p
                WHERE p.archived_at IS NULL`;

        const result = await tx.execute(sql`
          WITH visible AS (${visibleProjects}),
          proj_docs AS (
            -- The project's signature-bearing docs (project-level ∪
            -- apartment-level, archived excluded) — one doc-resolution
            -- definition reused from the board's signatureProgress path.
            SELECT v.id AS project_id, d.id AS document_id
            FROM visible v
            INNER JOIN documents d ON d.project_id = v.id AND d.archived_at IS NULL
            UNION
            SELECT v.id AS project_id, d.id AS document_id
            FROM visible v
            INNER JOIN buildings b ON b.project_id = v.id
            INNER JOIN apartments a ON a.building_id = b.id
            INNER JOIN documents d ON d.apartment_id = a.id AND d.archived_at IS NULL
          )
          SELECT
            v.id AS project_id,
            v.name AS project_name,
            -- most-recent SIGNED request's signed_at (fallback created_at if a
            -- legacy signed row predates signed_at) on a project doc.
            (SELECT MAX(COALESCE(sr.signed_at, sr.created_at))
               FROM signature_requests sr
               WHERE sr.status = 'signed'
                 AND sr.document_id IN (SELECT document_id FROM proj_docs WHERE project_id = v.id)
            ) AS last_signature_at,
            -- requests that flipped to signed in the trailing 7 days.
            (SELECT COUNT(*)::int
               FROM signature_requests sr
               WHERE sr.status = 'signed'
                 AND COALESCE(sr.signed_at, sr.created_at) >= now() - interval '7 days'
                 AND sr.document_id IN (SELECT document_id FROM proj_docs WHERE project_id = v.id)
            ) AS signed_this_week,
            -- soonest-expiring PENDING request on a project doc.
            (SELECT MIN(sr.expires_at)
               FROM signature_requests sr
               WHERE sr.status = 'pending'
                 AND sr.document_id IN (SELECT document_id FROM proj_docs WHERE project_id = v.id)
            ) AS next_expiry_at,
            -- HB-5 — the CAMPAIGN document a holdout request is CREATED against
            -- when an owner has no live pending request. Precedence (RLS-safe,
            -- single round-trip): (1) the document of the project's MOST-RECENT
            -- signature_request of ANY status — whatever the project already
            -- collects against; ELSE (2) the most-recent FINALIZED
            -- (uploaded_at NOT NULL), non-archived, PROJECT-scoped 'agreement'
            -- document; ELSE NULL. COALESCE preserves the precedence.
            COALESCE(
              (SELECT sr.document_id
                 FROM signature_requests sr
                 WHERE sr.document_id IN (SELECT document_id FROM proj_docs WHERE project_id = v.id)
                 ORDER BY sr.created_at DESC
                 LIMIT 1),
              (SELECT d.id
                 FROM documents d
                 WHERE d.project_id = v.id
                   AND d.type = 'agreement'
                   AND d.uploaded_at IS NOT NULL
                   AND d.archived_at IS NULL
                 ORDER BY d.uploaded_at DESC
                 LIMIT 1)
            ) AS campaign_document_id
          FROM visible v
          ORDER BY v.id
        `);
        return (result as unknown as { rows: Array<Record<string, unknown>> }).rows;
      },
      { userId: user.sub },
    );

    // 2) For each visible project, fetch the SINGLE-SOURCE share-weighted
    //    consent (cached, tenant-scoped key — same as the board). Each
    //    per-project aggregate is INDEPENDENT, so we resolve them with BOUNDED
    //    concurrency instead of one-at-a-time: the COLD path (after a consent
    //    write bumps the org epoch and invalidates every project's cached
    //    aggregate) would otherwise run N SEQUENTIAL aggregate queries → a
    //    latency wall at 100+ projects. We bound the fan-out to
    //    PULSE_CONSENT_CONCURRENCY (each in-flight aggregate holds ONE pg pool
    //    connection for its short `withTenant` tx) so we never exceed the pool
    //    ceiling — an unbounded Promise.all would STARVE the pool and be worse
    //    than sequential. Cache semantics are UNCHANGED: still `readThrough`
    //    per project under the same `pulseConsentKey` (distinct keys → no
    //    stampede), same per-org epoch invalidation; only the await pattern
    //    changed. We compute consent ONLY for projects already proven visible
    //    by step 1, so there is no extra visibility surface here.
    const now = Date.now();
    const expiringSoonMs = PULSE_EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000;

    type ConsentAgg = Awaited<ReturnType<ProjectsService['computeConsentAggregates']>>;
    const resolveAgg = (projectId: string): Promise<ConsentAgg> =>
      this.statsCache
        ? this.statsCache.readThrough(user.orgId, this.statsCache.pulseConsentKey(projectId), () =>
            withTenant(user.orgId, (tx) => this.computeConsentAggregates(tx, projectId), {
              userId: user.sub,
            }),
          )
        : withTenant(user.orgId, (tx) => this.computeConsentAggregates(tx, projectId), {
            userId: user.sub,
          });

    // Index-preserving aggregate resolution: `aggs[i]` is the consent for
    // `facts[i]`. Building via slice + Promise.all (NOT push-as-it-resolves)
    // keeps `aggs` byte-identical to the sequential order the downstream
    // ranking depends on — parallelism changes only WHEN each agg resolves,
    // never its slot.
    const aggs: ConsentAgg[] = new Array<ConsentAgg>(facts.length);
    for (let i = 0; i < facts.length; i += PULSE_CONSENT_CONCURRENCY) {
      const chunk = facts.slice(i, i + PULSE_CONSENT_CONCURRENCY);
      const chunkAggs = await Promise.all(chunk.map((f) => resolveAgg(String(f['project_id']))));
      for (let j = 0; j < chunkAggs.length; j += 1) {
        aggs[i + j] = chunkAggs[j]!;
      }
    }

    const rows: ProjectPulseRow[] = facts.map((f, i): ProjectPulseRow => {
      const projectId = String(f['project_id']);
      const projectName = String(f['project_name']);
      const lastSig = f['last_signature_at'];
      const lastSignatureAt =
        lastSig === null || lastSig === undefined
          ? null
          : new Date(lastSig as string).toISOString();
      const nextExp = f['next_expiry_at'];
      const nextExpiryAt =
        nextExp === null || nextExp === undefined
          ? null
          : new Date(nextExp as string).toISOString();
      const signedThisWeek = Number(f['signed_this_week'] ?? 0);

      const stalledDays =
        lastSignatureAt === null
          ? null
          : Math.max(0, Math.floor((now - new Date(lastSignatureAt).getTime()) / 86_400_000));

      const expiringSoon =
        nextExpiryAt !== null && new Date(nextExpiryAt).getTime() - now <= expiringSoonMs;

      // HB-5 — the project's campaign document (the doc a holdout request is
      // CREATED against). null when the project has no campaign at all (no
      // signature_request ever AND no finalized project-scoped 'agreement').
      const campaignDoc = f['campaign_document_id'];
      const campaignDocumentId =
        campaignDoc === null || campaignDoc === undefined ? null : String(campaignDoc);

      // SINGLE-SOURCE consent — the IDENTICAL share-weighted CTE the board uses,
      // read-through cached under a pulse-specific, tenant-scoped key. The board
      // caches the ASSEMBLED SignatureProgress under sigProgress:p:<id>; we cache
      // the raw aggregates under pulseConsent:p:<id> to avoid an envelope-shape
      // clash. The SAME per-org epoch invalidates both on any consent write.
      const agg = aggs[i]!;
      const metThreshold =
        agg.targetSignaturePct !== null && agg.consentedPct >= agg.targetSignaturePct;

      return {
        projectId,
        projectName,
        lastSignatureAt,
        signedThisWeek,
        stalledDays,
        nextExpiryAt,
        expiringSoon,
        consentedPct: agg.consentedPct,
        metThreshold,
        basis: 'share' as const,
        campaignDocumentId,
        hasCampaign: campaignDocumentId !== null,
      };
    });

    // 3) Order most-urgent-first via the pure A2 scorer.
    const attention = rankAttention(rows);

    // 4) Header buckets, derived from the SAME rows (no new query). Each project
    //    is classified into exactly one of stalled/expiringSoon/onTrack (stalled
    //    wins, then expiringSoon); `needsHuman` is a SEPARATE overlay count of the
    //    projects carrying a human-actionable signal (stalled OR expiring — a
    //    stalled project may also be expiring). The per-project A8 row array was
    //    removed: it was fully derived from `attention` (the same stalled/expiring
    //    subset, already surfaced as the home's ranked cards) and never read by
    //    the FE — keeping it was dead, divergence-prone wire weight.
    let stalled = 0;
    let expiringSoonCount = 0;
    let onTrack = 0;
    let needsHuman = 0;

    for (const r of attention) {
      const isStalled = r.stalledDays !== null && r.stalledDays >= PULSE_STALLED_DAYS;
      if (isStalled) stalled += 1;
      else if (r.expiringSoon) expiringSoonCount += 1;
      else onTrack += 1;

      if (isStalled || r.expiringSoon) needsHuman += 1;
    }

    // HB-1 — surface the N15 send KILL-SWITCH to the FE so the board can
    // disable/explain the one-tap "remind pending" action instead of letting the
    // manager tap into a 503. OPT-OUT semantics MUST match the send-path gate
    // (signature-requests.service): enabled unless explicitly '0'/'false'. This
    // is a process-wide env flag, NOT per-project — it rides the org-scoped pulse
    // only as a single convenient read for the action's enabled state.
    const sendFlag = serverEnv.CAMPAIGN_SEND_ENABLED;
    const sendEnabled = !(sendFlag === '0' || sendFlag === 'false');

    return {
      buckets: { stalled, expiringSoon: expiringSoonCount, needsHuman, onTrack },
      attention,
      sendEnabled,
    };
  }

  async create(user: AccessTokenPayload, input: CreateProject): Promise<Project> {
    this.requireManager(user);
    const created = await withTenant(
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
            // P3 create-form enrichment (migration 0062). All optional/nullable
            // — already validated by CreateProjectInput at the controller edge.
            // numeric columns travel as strings on the wire (pg-node semantics).
            developerName: input.developerName ?? null,
            developerCompanyId: input.developerCompanyId ?? null,
            existingUnits: input.existingUnits ?? null,
            plannedUnits: input.plannedUnits ?? null,
            extraAreaSqm:
              input.extraAreaSqm === undefined || input.extraAreaSqm === null
                ? null
                : String(input.extraAreaSqm),
            relocationType: input.relocationType ?? null,
            relocationNotes: input.relocationNotes ?? null,
            typeLabel: input.typeLabel ?? null,
            block: input.block ?? null,
            parcel: input.parcel ?? null,
            subparcel: input.subparcel ?? null,
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
    // A new project (and any wizard-created buildings/apartments) changes
    // orgStats.activeProjects + the project's own signatureProgress denominator.
    await this.invalidateStats(user.orgId);
    return created;
  }

  async update(user: AccessTokenPayload, id: string, input: UpdateProject): Promise<Project> {
    this.requireManager(user);
    const updated = await withTenant(
      user.orgId,
      async (tx) => {
        const [before] = await tx.select().from(projects).where(eq(projects.id, id)).limit(1);
        if (!before) throw NOT_FOUND;

        // E2 Wave-1 B5 — STATUS STATE MACHINE (D.18 enum). Gate ONLY when a
        // status is supplied AND actually DIFFERS from current (same→same is a
        // no-op; a non-status update is untouched). Before B5 this assignment
        // was unconditional any→any, which silently allowed e.g. `completed`→
        // `planning` — legal/business corruption. Now an edge not in the map
        // throws `invalid_status_transition` (409), and the `→ approved` edge
        // additionally requires the share-weighted consent to have met target.
        if (input.status !== undefined && input.status !== before.status) {
          if (!isAllowedStatusTransition(before.status, input.status)) {
            throw new ConflictException({
              error: {
                code: 'invalid_status_transition',
                message: 'project status transition not allowed',
                details: { from: before.status, to: input.status },
              },
            });
          }
          // LEGAL GATE (OD-1/OD-3): a project may be marked `approved` ONLY once
          // its share-weighted consent has crossed the project's target. Reuse
          // B0's exact metThreshold definition, computed on THIS tx/RLS context.
          if (input.status === 'approved') {
            const metThreshold = await this.computeMetThresholdOnTx(tx, id);
            if (!metThreshold) {
              throw new ConflictException({
                error: {
                  code: 'threshold_not_met',
                  message: 'consent threshold not met for approval',
                  details: { from: before.status, to: input.status },
                },
              });
            }
          }
        }

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
        // P3 create-form enrichment (migration 0062). Each field is set on the
        // patch ONLY when present in the body (undefined = leave unchanged;
        // explicit null = clear). numeric columns serialise to string.
        if (input.developerName !== undefined) patch.developerName = input.developerName;
        if (input.developerCompanyId !== undefined)
          patch.developerCompanyId = input.developerCompanyId;
        if (input.existingUnits !== undefined) patch.existingUnits = input.existingUnits;
        if (input.plannedUnits !== undefined) patch.plannedUnits = input.plannedUnits;
        if (input.extraAreaSqm !== undefined) {
          patch.extraAreaSqm = input.extraAreaSqm === null ? null : String(input.extraAreaSqm);
        }
        if (input.relocationType !== undefined) patch.relocationType = input.relocationType;
        if (input.relocationNotes !== undefined) patch.relocationNotes = input.relocationNotes;
        if (input.typeLabel !== undefined) patch.typeLabel = input.typeLabel;
        if (input.block !== undefined) patch.block = input.block;
        if (input.parcel !== undefined) patch.parcel = input.parcel;
        if (input.subparcel !== undefined) patch.subparcel = input.subparcel;
        if (input.startedAt !== undefined) patch.startedAt = input.startedAt;

        // E2 Wave-1 B5 — OPTIMISTIC CONCURRENCY. When the client supplies the
        // `updated_at` it last read, gate the UPDATE on it: a concurrent edit
        // since that read advanced `updated_at`, so the predicate matches 0
        // rows even though the row exists (we proved it via `before`) → reject
        // `stale_write` (409) so the stale edit can't silently clobber.
        //
        // Precision: node-postgres returns `timestamptz` as a JS Date at
        // MILLISECOND precision, but the column can hold MICROSECONDS (a project
        // created via `defaultNow()`/pg now() and never updated). Comparing the
        // ms-truncated client value against a micros column would FALSELY report
        // stale on a never-updated row. So both sides are `date_trunc(
        // 'milliseconds', …)` — the SAME D.58 fix the keyset cursor uses. The
        // id tie-breaker is the PK equality already in the WHERE.
        const whereClause =
          input.expectedUpdatedAt !== undefined
            ? and(
                eq(projects.id, id),
                sql`date_trunc('milliseconds', ${projects.updatedAt}) = date_trunc('milliseconds', ${input.expectedUpdatedAt.toISOString()}::timestamptz)`,
              )
            : eq(projects.id, id);
        const [row] = await tx.update(projects).set(patch).where(whereClause).returning();
        if (!row) {
          // The row DOES exist (proven by `before`); 0 rows affected means the
          // concurrency predicate failed → a stale write, not a missing row.
          if (input.expectedUpdatedAt !== undefined) {
            throw new ConflictException({
              error: {
                code: 'stale_write',
                message: 'project was modified by someone else; reload and retry',
              },
            });
          }
          throw NOT_FOUND;
        }
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
    // An update can change target_signature_pct (→ signatureProgress.metThreshold)
    // or status; invalidate the org's stats so the board reflects it.
    await this.invalidateStats(user.orgId);
    return updated;
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
    // Archiving drops the project from orgStats.activeProjects.
    await this.invalidateStats(user.orgId);
  }
}
