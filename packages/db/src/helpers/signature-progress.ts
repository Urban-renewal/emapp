import { sql, type SQL } from 'drizzle-orm';

import type { TenantTx } from '../wrappers/with-tenant';

/**
 * PERF (D.51) — the project's signature-bearing document ids as a set, so the
 * count can be expressed as `... document_id IN (<this>)`.
 *
 * ROOT CAUSE (not a plaster): the prior `(d.project_id = P OR b.project_id =
 * P)` predicate has NO index path — EXPLAIN with `enable_seqscan = off` still
 * seq-scans signature_requests AND documents, because the OR straddles two
 * tables and the planner can't drive either side from an index. project_id is
 * genuinely NOT denormalised onto apartment-level docs (documents.service.ts
 * writes `projectId: input.projectId ?? null` — an apartment doc has
 * project_id NULL), so the predicate CANNOT collapse to `d.project_id = P`
 * alone; the UNION over the two real paths is required, not a stylistic
 * choice.
 *
 * Rewriting OR→UNION gives the planner an index path for the whole shape:
 * under `enable_seqscan = off` neither documents nor signature_requests is
 * seq-scanned and the count resolves through the
 * `idx_signature_requests_doc_status` (document_id, status) index (proven by
 * `signature-progress-perf.spec.ts`; the path is structural/volume-
 * independent — at MVP row counts the planner still picks the cheaper seq
 * scan, which is correct, exactly per D.51's mechanism-not-latency rule).
 *
 * BYTE-FOR-BYTE: this set is identical to the OR-form's matching set — it does
 * NOT add an `archived_at IS NULL` filter, so an archived doc's signatures are
 * counted exactly as before. (Whether archived docs *should* count toward live
 * progress is a separate product/correctness question, deliberately NOT
 * decided here.) Using the PARTIAL `idx_documents_org_project` (which would
 * require that filter) was rejected precisely because it would change the
 * count; the count-neutral form below still has a full index path.
 *
 * `projectId` may be a literal (parameterised) OR a `SQL` column reference
 * for a CORRELATED subquery (e.g. the portal's per-project counts pass
 * `sql\`${projects.id}\``). Internal aliases are `pd_a` / `pd_b` so this can
 * be embedded inside a query that already aliases `a`/`b`.
 */
export function projectSignatureDocIdsSql(projectId: string | SQL): SQL {
  return sql`
    SELECT d.id FROM documents d
      WHERE d.project_id = ${projectId}
    UNION
    SELECT d.id FROM documents d
      INNER JOIN apartments pd_a ON pd_a.id = d.apartment_id
      INNER JOIN buildings pd_b ON pd_b.id = pd_a.building_id
      WHERE pd_b.project_id = ${projectId}
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
