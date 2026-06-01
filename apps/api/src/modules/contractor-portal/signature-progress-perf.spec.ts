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
 * NOTE: the OR→UNION rewrite is BYTE-FOR-BYTE count-neutral — it does NOT add
 * an `archived_at IS NULL` filter (that would change the count and is a
 * separate product question). The count-neutral UNION still has a full index
 * path: the project branch drives via `documents_pkey`, the apartment branch
 * via `idx_buildings_project_id` → `idx_apartments_building_id`, and the count
 * resolves through `idx_signature_requests_doc_status` — no seq scan on either
 * documents or signature_requests under `enable_seqscan = off`.
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
        WHERE d.project_id = $1
      UNION
      SELECT d.id FROM documents d
        INNER JOIN apartments pd_a ON pd_a.id = d.apartment_id
        INNER JOIN buildings pd_b ON pd_b.id = pd_a.building_id
        WHERE pd_b.project_id = $1
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

      expect(plan, plan).not.toMatch(/Seq Scan on signature_requests/i);
      expect(plan, plan).not.toMatch(/Seq Scan on documents/i);
      // Positive: the count resolves via the (document_id, status) index.
      expect(plan, plan).toMatch(/idx_signature_requests_doc_status/i);
    } finally {
      c.release();
    }
  });
});
