import { sql, type SQL } from 'drizzle-orm';

import type { TenantTx } from '../wrappers/with-tenant';

/**
 * PERF (D.51) — the project's signature-bearing document ids, as an
 * INDEX-FRIENDLY set: project-level docs via `idx_documents_org_project`,
 * apartment-level docs via `idx_buildings_project` → apartments →
 * `idx_documents_apartment`. Used as `... document_id IN (<this>)`.
 *
 * This deliberately AVOIDS the `(d.project_id = P OR b.project_id = P)`
 * predicate, which has no index path (EXPLAIN with seqscan disabled still
 * seq-scans signature_requests + documents). Driving from the documents
 * indexes lets the count use the `idx_signature_requests_doc_status`
 * (document_id, status) Index-Only Scan.
 */
/**
 * `projectId` may be a literal (parameterised) OR a `SQL` column reference
 * for a CORRELATED subquery (e.g. the portal's per-project counts pass
 * `sql\`${projects.id}\``). Internal aliases are `pd_a` / `pd_b` so this can
 * be embedded inside a query that already aliases `a`/`b`.
 */
export function projectSignatureDocIdsSql(projectId: string | SQL): SQL {
  return sql`
    SELECT d.id FROM documents d
      WHERE d.project_id = ${projectId} AND d.archived_at IS NULL
    UNION
    SELECT d.id FROM documents d
      INNER JOIN apartments pd_a ON pd_a.id = d.apartment_id
      INNER JOIN buildings pd_b ON pd_b.id = pd_a.building_id
      WHERE pd_b.project_id = ${projectId} AND d.archived_at IS NULL
  `;
}

// Type ALIAS (not interface) so drizzle's `tx.execute<T>` accepts it — its
// constraint is `Record<string, unknown>`, which interfaces don't satisfy
// structurally (the well-known TS2344 quirk). Type aliases do.
type ProgressRow = {
  signed: number;
  pending: number;
};

/**
 * AGGREGATE signature progress for ONE project — ACTIVE only (signed +
 * pending; cancelled excluded). ONE query, index-using (see above). Returns
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
