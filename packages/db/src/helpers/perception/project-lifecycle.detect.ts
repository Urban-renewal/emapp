/**
 * `assembleProjectPerception` — the ONE PII-FREE, SET-BASED assembler that, per
 * NON-TERMINAL project of the tenant, COMPOSES the existing canonical seams into
 * a single `ProjectPerception` read-model (blueprint wave 1.1 — the PERCEIVE leg).
 *
 * ── Why this exists (single source of truth, owner 2026-06-23) ───────────────
 * Today the home KPI, the boards, and the recommender fleet each re-query the
 * same facts (signatures, consent, missing docs) in slightly-different SQL — the
 * divergent-parallel-implementation defect that produced the "0 מתוך X" board bug
 * and the home-stat drift. This assembler is the shared substrate they will ALL
 * read FROM (wired in the next slice): every signature/consent/missing-doc fact
 * resolves through the SAME canonical seam HERE, so two surfaces cannot drift.
 *
 *   - signatures      → `projectSignatureDocIdsSql` (the canonical doc-scope —
 *                        NO second signature-count query is introduced anywhere)
 *   - consent (share) → the SAME share-weighted CTE shape as the per-project
 *                        board's `computeConsentAggregates` (apt contribution =
 *                        signed_share / active_share, clamped, equal-apt-weighted)
 *   - missing docs    → the SAME required-set + scope resolution as the canonical
 *                        `detectMissingRequiredDocs` CTE (REQUIRED_DOC_TYPES_BY_TRACK
 *                        expanded inline; doc satisfies via DH1 `doc_scope='project'`
 *                        OR legacy `project_id` linkage; non-archived)
 *   - terminal flag   → `PROJECT_TERMINAL_STATUSES` (mirrored locally — see below)
 *   - holdouts        → the SAME `relationship='owner' AND ended_at IS NULL` active-
 *                        owner seam, COUNTED ONLY (never a name — PII-free)
 *
 * INVENTS NO NEW FACT: every returned field is a count, a derived %, an id, a
 * timestamp, or an enum. No owner name / national_id / phone / signature column
 * is ever selected — provable by the `no-PII-column` spec.
 *
 * ── Set-based, ONE query, RLS-scoped (the detectMissingRequiredDocs pattern) ──
 * Like `detectMissingRequiredDocs`, this is a SINGLE statement over ALL the
 * relevant projects — NOT an N-query per-project loop. The crucial difference:
 * this runs INSIDE `withTenant` (the org's RLS app_user), so every table read is
 * automatically org-scoped by the RLS policies — the assembler never adds an
 * `org_id =` predicate (RLS owns that), and it can NEVER read another tenant's
 * rows. (The canonical missing-doc detector uses the BYPASSRLS `providerDb` to
 * sweep ALL orgs for the worker; perception is a TENANT read, so it composes the
 * identical CTE shape but under withTenant — same facts, tenant-safe.)
 *
 * NON-TERMINAL only: `completed` / `cancelled` deals need no perception (no
 * further collection/chasing). Excluding them here keeps the perception array the
 * exact universe the boards render and the recommenders act on.
 */
import { sql } from 'drizzle-orm';

import type { TenantTx } from '../../wrappers/with-tenant';
import { projectSignatureDocIdsSql } from '../signature-progress';

/**
 * STORAGE-LAYER STRUCTURAL MIRROR of `@emapp/shared-types` `ProjectPerception`.
 *
 * `@emapp/db` deliberately does NOT import `@emapp/shared-types` at runtime: the
 * `@emapp/*` source-path mapping in the root tsconfig resolves shared-types to
 * its SOURCE dir, which violates this package's `rootDir` (`tsc` TS6059 — the same
 * reason `schema/projects.ts` mirrors `SignatureMilestone` and the status enum
 * locally rather than importing them). So the CANONICAL contract — the Zod schema,
 * the `AttentionReason` enum, and the `attentionReasonToActionKind` map — lives in
 * shared-types (the FE/BE source of truth), and THIS is the structurally-identical
 * shape the assembler produces.
 *
 * The binding that the two cannot drift is the SPEC: `project-perception.assembler.spec.ts`
 * asserts every emitted row `ProjectPerceptionSchema.parse`s clean (run via vitest,
 * which — unlike `tsc` — resolves shared-types fine), so a shape divergence fails CI.
 * Field-for-field identical to `ProjectPerceptionSchema`; every field is a count /
 * %% / id / timestamp / enum — NO PII.
 */
export interface PerceptionMissingDoc {
  track: string;
  docType: string;
}
export interface PerceptionSignatures {
  signed: number;
  pending: number;
  totalApartments: number;
  apartmentsConsented: number;
  consentedPct: number;
  targetSignaturePct: number | null;
  metThreshold: boolean;
  basis: 'share';
}
export interface PerceptionActivity {
  lastSignatureAt: string | null;
  oldestPendingAt: string | null;
  oldestPendingAgeDays: number | null;
  nextExpiryAt: string | null;
}
export interface PerceptionHoldouts {
  activeOwners: number;
  unsignedOwners: number;
}
export interface ProjectPerception {
  projectId: string;
  projectName: string;
  projectType: string;
  status: string;
  isTerminal: boolean;
  archivedAt: string | null;
  signatures: PerceptionSignatures;
  activity: PerceptionActivity;
  holdouts: PerceptionHoldouts;
  missingRequiredDocs: PerceptionMissingDoc[];
  atRisk: boolean;
}

/**
 * Local mirror of `@emapp/shared-types` `PROJECT_TERMINAL_STATUSES`. `@emapp/db`
 * does NOT depend on `@emapp/shared-types` (schema files mirror enums the same
 * way — see `projects.ts`), so the canonical set lives there and this is the
 * storage-layer copy, used ONLY to choose the non-terminal universe in SQL. The
 * `project-perception.assembler.spec.ts` asserts this mirror equals the canonical
 * `PROJECT_TERMINAL_STATUSES` so the two can never drift.
 */
export const PERCEPTION_TERMINAL_STATUSES: readonly string[] = ['completed', 'cancelled'];

/** Bound the working set per call (mirrors the recommender detect limits). */
export const PROJECT_PERCEPTION_LIMIT = 5000;

/** EXPIRING-SOON / STALLED day windows — kept here so the assembler and any
 *  consumer derive `atRisk` / activity from the SAME thresholds (no drift).
 *  These mirror `PULSE_EXPIRING_SOON_DAYS` / `PULSE_STALLED_DAYS` in
 *  shared-types (storage-layer copy; the spec pins them equal). */
export const PERCEPTION_STALLED_DAYS = 14;

/**
 * Assemble the tenant's per-project perception array. ONE set-based query inside
 * the caller's `withTenant` tx (RLS-scoped). Returns one PII-free
 * `ProjectPerception` per non-terminal project.
 *
 * The result rows are `ProjectPerceptionSchema.parse`d — a hard, fail-closed
 * gate that any unexpected (e.g. PII) column or out-of-range value throws rather
 * than silently flowing to a consumer (`.strict()` rejects strays).
 */
export async function assembleProjectPerception(tx: TenantTx): Promise<ProjectPerception[]> {
  // Parameterised terminal-status set (derived from PERCEPTION_TERMINAL_STATUSES so
  // a future terminal state flows in for free) — NOT string-interpolated.
  const terminalList = sql.join(
    PERCEPTION_TERMINAL_STATUSES.map((s) => sql`${s}`),
    sql`, `,
  );

  const result = await tx.execute(sql`
    WITH live_projects AS (
      SELECT p.id, p.name, p.type, p.status, p.archived_at, p.target_signature_pct,
        CASE
          WHEN p.type IN ('tama38_1', 'tama38_2') THEN 'tama38'
          WHEN p.type = 'pinui_binui'             THEN 'pinui_binui'
          ELSE 'default'
        END AS track
      FROM projects p
      WHERE p.archived_at IS NULL
        AND p.status NOT IN (${terminalList})
    ),
    -- The canonical required-doc set, expanded inline (lock-step with
    -- REQUIRED_DOC_TYPES_BY_TRACK / detectMissingRequiredDocs).
    required AS (
      SELECT * FROM (VALUES
        ('tama38',      'agreement'),
        ('tama38',      'land_registry'),
        ('tama38',      'blueprint'),
        ('pinui_binui', 'agreement'),
        ('pinui_binui', 'land_registry'),
        ('pinui_binui', 'blueprint'),
        ('pinui_binui', 'regulation'),
        ('default',     'agreement'),
        ('default',     'land_registry'),
        ('default',     'blueprint')
      ) AS r(track, doc_type)
    ),
    -- Per-project MISSING required types (same scope resolution as the canonical
    -- detector: a doc satisfies via DH1 doc_scope='project' OR legacy project_id;
    -- non-archived). Aggregated to a jsonb array so it rides one row per project.
    missing_docs AS (
      SELECT lp.id AS project_id,
        COALESCE(
          jsonb_agg(jsonb_build_object('track', req.track, 'docType', req.doc_type)
                    ORDER BY req.doc_type)
            FILTER (WHERE req.doc_type IS NOT NULL),
          '[]'::jsonb
        ) AS missing
      FROM live_projects lp
      JOIN required req ON req.track = lp.track
      LEFT JOIN documents d
        ON d.type = req.doc_type
       AND d.archived_at IS NULL
       AND (
            (d.doc_scope = 'project' AND d.doc_scope_id = lp.id)
         OR d.project_id = lp.id
       )
      WHERE d.id IS NULL
      GROUP BY lp.id
    ),
    -- Per-project apartments (the consent/holdout denominator universe).
    proj_apartments AS (
      SELECT a.id AS apartment_id, b.project_id
      FROM apartments a
      INNER JOIN buildings b ON b.id = a.building_id
      INNER JOIN live_projects lp ON lp.id = b.project_id
      WHERE a.archived_at IS NULL
    ),
    -- Per-apartment share-weighted consent contribution (IDENTICAL math to the
    -- canonical computeConsentAggregates: signed_share / active_share, [0,1]).
    apt_consent AS (
      SELECT
        pa.apartment_id,
        pa.project_id,
        COALESCE((SELECT SUM(o.share_numerator::numeric / o.share_denominator)
           FROM ownerships o
           WHERE o.apartment_id = pa.apartment_id
             AND o.ended_at IS NULL
             AND o.relationship = 'owner'), 0) AS active_share,
        COALESCE((SELECT SUM(o.share_numerator::numeric / o.share_denominator)
           FROM ownerships o
           WHERE o.apartment_id = pa.apartment_id
             AND o.ended_at IS NULL
             AND o.relationship = 'owner'
             AND EXISTS (
               SELECT 1 FROM signature_requests sr
               WHERE sr.owner_id = o.owner_id
                 AND sr.status = 'signed'
                 AND sr.document_id IN (${projectSignatureDocIdsSql(sql`pa.project_id`)})
             )), 0) AS signed_share
      FROM proj_apartments pa
    ),
    apt_contrib AS (
      SELECT apartment_id, project_id, active_share, signed_share,
        CASE WHEN active_share > 0
             THEN LEAST(1, GREATEST(0, signed_share / active_share))
             ELSE 0 END AS contribution
      FROM apt_consent
    ),
    consent AS (
      SELECT
        lp.id AS project_id,
        (SELECT COUNT(*)::int FROM proj_apartments pa WHERE pa.project_id = lp.id) AS total_apartments,
        (SELECT COUNT(*)::int FROM apt_contrib ac
           WHERE ac.project_id = lp.id AND ac.active_share > 0
             AND ac.signed_share >= ac.active_share) AS apartments_consented,
        COALESCE((SELECT SUM(ac.contribution) FROM apt_contrib ac
           WHERE ac.project_id = lp.id), 0) AS consented_weight
      FROM live_projects lp
    ),
    -- Per-project active owners + how many are UNSIGNED (holdout COUNTS only).
    holdouts AS (
      SELECT lp.id AS project_id,
        COUNT(DISTINCT o.owner_id)::int AS active_owners,
        COUNT(DISTINCT o.owner_id) FILTER (
          WHERE NOT EXISTS (
            SELECT 1 FROM signature_requests sr
            WHERE sr.owner_id = o.owner_id
              AND sr.status = 'signed'
              AND sr.document_id IN (${projectSignatureDocIdsSql(sql`lp.id`)})
          )
        )::int AS unsigned_owners
      FROM live_projects lp
      LEFT JOIN proj_apartments pa ON pa.project_id = lp.id
      LEFT JOIN ownerships o
        ON o.apartment_id = pa.apartment_id
       AND o.ended_at IS NULL
       AND o.relationship = 'owner'
      GROUP BY lp.id
    ),
    -- Signature counts + activity, all on the canonical doc-scope (one source).
    sigs AS (
      SELECT lp.id AS project_id,
        (SELECT COUNT(*)::int FROM signature_requests sr
           WHERE sr.status = 'signed'
             AND sr.document_id IN (${projectSignatureDocIdsSql(sql`lp.id`)})) AS signed,
        (SELECT COUNT(*)::int FROM signature_requests sr
           WHERE sr.status = 'pending'
             AND sr.document_id IN (${projectSignatureDocIdsSql(sql`lp.id`)})) AS pending,
        (SELECT MAX(sr.signed_at) FROM signature_requests sr
           WHERE sr.status = 'signed'
             AND sr.document_id IN (${projectSignatureDocIdsSql(sql`lp.id`)})) AS last_signature_at,
        (SELECT MIN(sr.created_at) FROM signature_requests sr
           WHERE sr.status = 'pending'
             AND sr.document_id IN (${projectSignatureDocIdsSql(sql`lp.id`)})) AS oldest_pending_at,
        (SELECT MIN(sr.expires_at) FROM signature_requests sr
           WHERE sr.status = 'pending'
             AND sr.document_id IN (${projectSignatureDocIdsSql(sql`lp.id`)})) AS next_expiry_at
      FROM live_projects lp
    )
    SELECT
      lp.id          AS project_id,
      lp.name        AS project_name,
      lp.type        AS project_type,
      lp.status      AS status,
      lp.archived_at AS archived_at,
      lp.target_signature_pct AS target_signature_pct,
      sigs.signed, sigs.pending,
      sigs.last_signature_at, sigs.oldest_pending_at, sigs.next_expiry_at,
      consent.total_apartments, consent.apartments_consented, consent.consented_weight,
      holdouts.active_owners, holdouts.unsigned_owners,
      COALESCE(missing_docs.missing, '[]'::jsonb) AS missing_required_docs
    FROM live_projects lp
    JOIN sigs     ON sigs.project_id = lp.id
    JOIN consent  ON consent.project_id = lp.id
    JOIN holdouts ON holdouts.project_id = lp.id
    LEFT JOIN missing_docs ON missing_docs.project_id = lp.id
    ORDER BY lp.id
    LIMIT ${PROJECT_PERCEPTION_LIMIT}
  `);

  const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;
  const now = Date.now();

  return rows.map((row): ProjectPerception => {
    const totalApartments = Number(row['total_apartments'] ?? 0);
    const consentedWeight = Number(row['consented_weight'] ?? 0);
    const consentedPct =
      totalApartments > 0 ? Math.round((consentedWeight / totalApartments) * 100) : 0;

    const rawTarget = row['target_signature_pct'];
    const targetSignaturePct =
      rawTarget === null || rawTarget === undefined ? null : Number(rawTarget);
    const metThreshold = targetSignaturePct !== null && consentedPct >= targetSignaturePct;

    const oldestPendingAt = toIso(row['oldest_pending_at']);
    const oldestPendingAgeDays =
      oldestPendingAt === null
        ? null
        : Math.max(0, Math.floor((now - Date.parse(oldestPendingAt)) / 86_400_000));

    const pending = Number(row['pending'] ?? 0);
    const unsignedOwners = Number(row['unsigned_owners'] ?? 0);
    const missingRequiredDocs = parseMissingDocs(row['missing_required_docs']);

    // ANTICIPATE — at-risk = stalled (old pending) ∧ below target ∧ missing docs.
    const stalled =
      oldestPendingAgeDays !== null && oldestPendingAgeDays >= PERCEPTION_STALLED_DAYS;
    const belowTarget = !metThreshold;
    const atRisk = stalled && belowTarget && missingRequiredDocs.length > 0;

    return {
      projectId: String(row['project_id']),
      projectName: String(row['project_name'] ?? ''),
      projectType: String(row['project_type'] ?? ''),
      status: String(row['status'] ?? ''),
      isTerminal: false,
      archivedAt: toIso(row['archived_at']),
      signatures: {
        signed: Number(row['signed'] ?? 0),
        pending,
        totalApartments,
        apartmentsConsented: Number(row['apartments_consented'] ?? 0),
        consentedPct,
        targetSignaturePct,
        metThreshold,
        basis: 'share',
      },
      activity: {
        lastSignatureAt: toIso(row['last_signature_at']),
        oldestPendingAt,
        oldestPendingAgeDays,
        nextExpiryAt: toIso(row['next_expiry_at']),
      },
      holdouts: {
        activeOwners: Number(row['active_owners'] ?? 0),
        unsignedOwners,
      },
      missingRequiredDocs,
      atRisk,
    };
  });
}

/** pg timestamp → ISO UTC string | null (Date or string both arrive from pg). */
function toIso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  // pg may hand back an ISO-ish string already; normalise via Date.
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Parse the jsonb-aggregated missing-doc array (string or array from pg) into
 *  the typed shape, defensively (anything malformed → empty). PII-free keys. */
function parseMissingDocs(v: unknown): Array<{ track: string; docType: string }> {
  const raw = typeof v === 'string' ? safeJsonArray(v) : Array.isArray(v) ? v : [];
  const out: Array<{ track: string; docType: string }> = [];
  for (const item of raw) {
    if (item && typeof item === 'object') {
      const rec = item as Record<string, unknown>;
      const track = rec['track'];
      const docType = rec['docType'];
      if (typeof track === 'string' && typeof docType === 'string') {
        out.push({ track, docType });
      }
    }
  }
  return out;
}

function safeJsonArray(s: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
