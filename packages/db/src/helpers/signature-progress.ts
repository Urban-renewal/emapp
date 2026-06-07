import { sql, type SQL } from 'drizzle-orm';

import type { TenantTx } from '../wrappers/with-tenant';

/**
 * PERF (D.51) + CORRECTNESS (D.57) — the project's signature-bearing document
 * ids as a set, so the count can be expressed as `... document_id IN (<this>)`.
 *
 * ROOT CAUSE of the perf issue (not a plaster): the prior `(d.project_id = P
 * OR b.project_id = P)` predicate has NO index path — EXPLAIN with
 * `enable_seqscan = off` still seq-scans signature_requests AND documents,
 * because the OR straddles two tables and the planner can't drive either side
 * from an index. project_id is genuinely NOT denormalised onto apartment-level
 * docs (documents.service.ts writes `projectId: input.projectId ?? null` — an
 * apartment doc has project_id NULL), so the predicate CANNOT collapse to
 * `d.project_id = P` alone; the UNION over the two real paths is required.
 *
 * VALID-CONSENT (D.57, owner-approved): live signature progress counts only
 * signatures on ACTIVE documents — `archived_at IS NULL`. A signature on a
 * superseded (archived) agreement is not valid consent and must not inflate
 * the live %. This is a deliberate behavior change (NOT byte-for-byte vs the
 * old OR-form, which counted archived), uniform across the tenant portal
 * (slice 5) and the contractor read-tier (DEF-1), and consistent with
 * getDocuments/getProject which already exclude archived.
 *
 * The `archived_at IS NULL` filter is ALSO what makes this index-friendly: it
 * matches the PARTIAL indexes `idx_documents_org_project` (… WHERE
 * project_id IS NOT NULL AND archived_at IS NULL) and `idx_documents_apartment`
 * (… WHERE apartment_id IS NOT NULL AND archived_at IS NULL), so the planner
 * gets a real index path and the count resolves through
 * `idx_signature_requests_doc_status` (document_id, status). Without the
 * filter the partial indexes are unusable — which is exactly why the
 * count-neutral variant failed the perf gate on CI's clean DB. Correctness and
 * perf land on the same line. (The path is structural/volume-independent,
 * proven by `signature-progress-perf.spec.ts` under `enable_seqscan = off`;
 * at MVP row counts the planner still picks the cheaper seq scan — correct,
 * per D.51's mechanism-not-latency rule.)
 *
 * `projectId` may be a literal (parameterised) OR a `SQL` column reference
 * for a CORRELATED subquery (e.g. the portal's per-project counts pass
 * `sql\`${projects.id}\``). Internal aliases are `pd_a` / `pd_b` so this can
 * be embedded inside a query that already aliases `a`/`b`.
 */
/**
 * ONE doc-resolution definition (project-level docs ∪ apartment-level docs),
 * with the project match applied to BOTH paths via the caller's predicate.
 * The two exported adapters below (`= id` and `IN <set>`) are thin wrappers, so
 * the single-project and project-set callers share the same UNION shape +
 * partial-index alignment — no copy-pasted query to drift (SOLID open/closed).
 */
function signatureDocIdsSql(projectMatch: (projectCol: SQL) => SQL): SQL {
  return sql`
    SELECT d.id FROM documents d
      WHERE ${projectMatch(sql`d.project_id`)} AND d.archived_at IS NULL
    UNION
    SELECT d.id FROM documents d
      INNER JOIN apartments pd_a ON pd_a.id = d.apartment_id
      INNER JOIN buildings pd_b ON pd_b.id = pd_a.building_id
      WHERE ${projectMatch(sql`pd_b.project_id`)} AND d.archived_at IS NULL
  `;
}

export function projectSignatureDocIdsSql(projectId: string | SQL): SQL {
  return signatureDocIdsSql((col) => sql`${col} = ${projectId}`);
}

/**
 * Same doc-resolution, scoped to a SET of projects (e.g. an agent's assigned
 * projects). `projectIds` is an SQL subquery yielding `project_id` rows (e.g. a
 * CTE reference). Used by the agent-scoped home KPIs so the count reflects only
 * the agent's assignments — same index path as the single-project form.
 */
export function projectSetSignatureDocIdsSql(projectIds: SQL): SQL {
  return signatureDocIdsSql((col) => sql`${col} IN (${projectIds})`);
}

// Type ALIAS (not interface) so drizzle's `tx.execute<T>` accepts it — its
// constraint is `Record<string, unknown>`, which interfaces don't satisfy
// structurally (the well-known TS2344 quirk). Type aliases do.
type ProgressRow = {
  signed: number;
  pending: number;
};

/**
 * AGGREGATE signature progress for ONE project — ACTIVE consent only: signed +
 * pending (cancelled excluded), and ONLY on ACTIVE documents (archived
 * excluded, D.57 valid-consent). ONE query, index-using (see above). Returns
 * bare counts; no owner identity is selected or reachable. Shared by the
 * tenant portal (D.47) and the contractor read-tier (D2-DEF-1/D.46).
 */
export async function signatureProgressByProject(
  tx: TenantTx,
  projectId: string,
): Promise<{ signed: number; pending: number }> {
  const res = await tx.execute<ProgressRow>(sql`
    SELECT
      COUNT(*) FILTER (WHERE sr.status = 'signed')::int  AS signed,
      COUNT(*) FILTER (WHERE sr.status = 'pending')::int AS pending
    FROM signature_requests sr
    WHERE sr.status IN ('signed', 'pending')
      AND sr.document_id IN (${projectSignatureDocIdsSql(projectId)})
  `);
  const row = res.rows[0];
  return { signed: Number(row?.signed ?? 0), pending: Number(row?.pending ?? 0) };
}
