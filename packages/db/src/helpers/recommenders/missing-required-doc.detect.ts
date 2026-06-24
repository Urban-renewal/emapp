/**
 * `detectMissingRequiredDocs` — the ONE canonical, set-based detection of
 * "a gathering-signatures project is MISSING a required document type for its
 * renewal track" (the SINGLE source of truth shared by EVERY recommender that
 * acts on a missing-required-doc gap).
 *
 * ── Why this is factored out (one-source-of-truth, owner 2026-06-23) ─────────
 * TWO recommenders act on the SAME underlying condition:
 *   - `TaskWatcher` (G1)            → proposes an INTERNAL `task.create` (open a
 *                                     system task to chase the missing paperwork).
 *   - `DocumentChaseRecommender` (S5) → proposes an OUTBOUND `document.chase.send`
 *                                     (chase the responsible PARTY for the doc).
 * They differ ONLY in the proposal KIND they emit + the party derivation; the
 * DETECTION — which project, which missing required type, with the same scope
 * resolution — is IDENTICAL. Computing it twice in two slightly-different queries
 * is exactly the divergent-parallel-implementation defect the charter forbids
 * (the "0 מתוך X" board bug was two unaligned queries for the same fact). So the
 * detection lives HERE, once, and both recommenders consume these rows.
 *
 * ── Set-based detection (design correction H-runtime) ───────────────────────
 * ONE query across ALL orgs via the BYPASSRLS maintenance pool (`providerDb`) —
 * NOT a per-org/per-project loop. The required-doc set per track is the canonical
 * advisory law (`REQUIRED_DOC_TYPES_BY_TRACK`), expanded INLINE as a VALUES table
 * keyed off the project's track (derived from `projects.type`) and LEFT-JOINed to
 * the project's present, non-archived documents. A NULL match = a missing type.
 *
 * The doc-presence scope resolution is the SAME one the DocumentsService
 * board-completeness / DH2 checklist use: a doc satisfies a project's required
 * type when it is non-archived AND either the DH1 canonical
 * (`doc_scope='project'` AND `doc_scope_id=project.id`) OR the legacy
 * (`project_id=project.id`) linkage matches.
 *
 * NO PII: every returned column is a project id / org id / project type / track /
 * doc-type key — never an owner national_id/phone/name. Document TYPE keys
 * ('land_registry', …) are taxonomy, not PII.
 */
import { sql } from 'drizzle-orm';

import { providerDb } from '../../client';

/** One detected missing-required-doc gap. PII-FREE: ids + taxonomy keys only. */
export interface MissingRequiredDocRow {
  /** The org the gap belongs to (the producer writes per-tenant). */
  orgId: string;
  /** The gathering-signatures project missing the required type. */
  projectId: string;
  /** The raw `projects.type` enum value (audit/debug aid; e.g. 'tama38_1'). */
  projectType: string;
  /** The checklist TRACK the required-set was chosen for ('tama38' | …). */
  track: string;
  /** The required document TYPE the project is still missing (taxonomy key). */
  missingDocType: string;
}

/** Bound the working set per tick (mirrors the reissue/cadence recommenders). */
export const MISSING_REQUIRED_DOC_DETECT_LIMIT = 5000;

/**
 * Detect every (project, missing required type) gap across ALL orgs, once.
 *
 * The required-doc set per track is expanded INLINE here as a VALUES table keyed
 * by track (the SAME values as `REQUIRED_DOC_TYPES_BY_TRACK`, pinned in SQL so
 * detection stays a single statement — kept in lock-step with the shared-types
 * constant by the recommender specs):
 *   tama38 (tama38_1 | tama38_2)  → agreement, land_registry, blueprint
 *   pinui_binui                   → + regulation
 *   default (other / unknown)     → agreement, land_registry, blueprint
 */
export async function detectMissingRequiredDocs(): Promise<MissingRequiredDocRow[]> {
  const result = await providerDb.execute(sql`
    WITH required AS (
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
    proj AS (
      SELECT
        p.id   AS project_id,
        p.org_id,
        p.type AS project_type,
        CASE
          WHEN p.type IN ('tama38_1', 'tama38_2') THEN 'tama38'
          WHEN p.type = 'pinui_binui'             THEN 'pinui_binui'
          ELSE 'default'
        END AS track
      FROM projects p
      WHERE p.status = 'gathering_signatures'
        AND p.archived_at IS NULL
    )
    SELECT
      proj.project_id,
      proj.org_id,
      proj.project_type,
      proj.track,
      required.doc_type
    FROM proj
    JOIN required ON required.track = proj.track
    LEFT JOIN documents d
      ON d.type = required.doc_type
     AND d.archived_at IS NULL
     AND (
          (d.doc_scope = 'project' AND d.doc_scope_id = proj.project_id)
       OR d.project_id = proj.project_id
     )
    WHERE d.id IS NULL
    ORDER BY proj.org_id, proj.project_id, required.doc_type
    LIMIT ${MISSING_REQUIRED_DOC_DETECT_LIMIT}
  `);

  const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;

  return rows.map((row): MissingRequiredDocRow => ({
    orgId: String(row['org_id']),
    projectId: String(row['project_id']),
    projectType: String(row['project_type']),
    track: String(row['track']),
    missingDocType: String(row['doc_type']),
  }));
}
