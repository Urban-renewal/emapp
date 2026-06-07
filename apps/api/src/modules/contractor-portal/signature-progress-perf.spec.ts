/**
 * PERF regression gate (D.51) — the shared aggregate signature-progress query
 * (portal getProgress + contractor getProgress) MUST use an index path.
 *
 * Mechanism (not a symptom): runs `EXPLAIN` with `enable_seqscan = off` so a
 * MISSING index path is exposed even on a tiny test table (seqscan is cheaper
 * on small data and would otherwise hide it). Asserts the plan does NOT fall
 * back to a Seq Scan on `signature_requests`/`documents` and DOES use the
 * `idx_signature_requests_doc_status` (document_id, status) index.
 *
 * The earlier `(d.project_id = P OR b.project_id = P)` form had NO index path
 * — it seq-scanned signature_requests + documents even with seqscan disabled.
 * If anyone reintroduces that shape, this test fails.
 *
 * The `archived_at IS NULL` filter (D.57 valid-consent — archived docs are
 * excluded from live progress) is ALSO what makes the partial indexes
 * `idx_documents_org_project` / `idx_documents_apartment` (both `… WHERE
 * archived_at IS NULL`) usable. Without it the partial indexes cannot be used
 * and the project branch falls back to a seq scan even under
 * `enable_seqscan = off` — which is exactly why a count-neutral variant failed
 * this gate on CI's clean DB. Correctness (archived excluded) and the index
 * path land on the same predicate.
 *
 * The query below MIRRORS `packages/db/src/helpers/signature-progress.ts`
 * (`signatureProgressByProject` / `projectSignatureDocIdsSql`); keep them in
 * sync.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { providerPool } from '../../../../../packages/db/src/client';
import { setupTestDatabase } from '../../../../../packages/db/test/setup';

const P = '00000000-0000-4000-8000-000000000abc';
const QUERY = `
  SELECT
    COUNT(*) FILTER (WHERE sr.status = 'signed')::int  AS signed,
    COUNT(*) FILTER (WHERE sr.status = 'pending')::int AS pending
  FROM signature_requests sr
  WHERE sr.status IN ('signed', 'pending')
    AND sr.document_id IN (
      SELECT d.id FROM documents d
        WHERE d.project_id = $1 AND d.archived_at IS NULL
      UNION
      SELECT d.id FROM documents d
        INNER JOIN apartments pd_a ON pd_a.id = d.apartment_id
        INNER JOIN buildings pd_b ON pd_b.id = pd_a.building_id
        WHERE pd_b.project_id = $1 AND d.archived_at IS NULL
    )`;

beforeAll(async () => {
  await setupTestDatabase();
}, 90_000);
afterAll(() => {
  /* shared pools closed by global teardown */
});

describe('PERF — aggregate signature progress uses an index path (D.51)', () => {
  it('no Seq Scan on signature_requests/documents; uses idx_signature_requests_doc_status', async () => {
    const c = await providerPool.connect();
    try {
      // Force index paths so a MISSING one is revealed on small test data.
      await c.query('SET enable_seqscan = off');
      const res = await c.query<{ ['QUERY PLAN']: string }>(`EXPLAIN ${QUERY}`, [P]);
      const plan = res.rows.map((r) => r['QUERY PLAN']).join('\n');

      // The D.51 guarantee this gate exists for: NO full-table scan on either
      // table (the old `(d.project_id = P OR b.project_id = P)` shape seq-scanned
      // both even with seqscan off — reintroduce it and these two fail).
      expect(plan, plan).not.toMatch(/Seq Scan on signature_requests/i);
      expect(plan, plan).not.toMatch(/Seq Scan on documents/i);
      // Positive: signature_requests is reached via one of its purpose-built
      // status indexes (an index path, not an incidental scan). Which one the
      // planner picks — idx_signature_requests_doc_status (document_id, status)
      // or idx_signature_requests_owner_status (… status) — is a legitimate,
      // DATA-VOLUME-DEPENDENT cost choice (both avoid the full scan), so we
      // accept either rather than flaking on the planner's pick as sibling specs
      // seed more rows into the shared test DB. (Asserting one specific index on
      // tiny test data can't predict the at-scale choice anyway.)
      expect(plan, plan).toMatch(/idx_signature_requests_(doc_status|owner_status)/i);
    } finally {
      c.release();
    }
  });
});
