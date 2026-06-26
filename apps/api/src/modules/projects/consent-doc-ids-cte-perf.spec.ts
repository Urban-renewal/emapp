import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * PERF REGRESSION GUARD (login-nav-latency 2026-06-26) — DB-free, source-level.
 *
 * `computeConsentAggregates` is the SINGLE-SOURCE share-weighted consent query
 * (board `signatureProgress` ∪ the home `signature-pulse` fan-out ∪ the
 * →approved gate). The project's signature-bearing doc set
 * (`projectSignatureDocIdsSql`) used to be inlined THREE times inside that one
 * query (the signed-share EXISTS + the two signature counts), so the planner
 * re-resolved the same `documents ⋈ apartments ⋈ buildings` UNION three times
 * per consent query — and the pulse fans this query out once PER project on the
 * cold home read. Materialising the doc-id set ONCE as a `proj_doc_ids` CTE and
 * referencing it via `IN (SELECT id FROM proj_doc_ids)` removed that redundant
 * re-execution (~26% faster on the busiest seeded project; results proven
 * byte-identical across 1442 local projects, 0 mismatches).
 *
 * This guard LOCKS that shape so a future edit can't silently re-inline the
 * doc-set back into the consent CTE (the regression that re-introduces the
 * triple re-resolution). It is intentionally structural (no DB): it asserts the
 * `proj_doc_ids` CTE exists, that the consent query references it at least
 * twice via `SELECT id FROM proj_doc_ids`, and that the canonical
 * `projectSignatureDocIdsSql(projectId)` is invoked EXACTLY ONCE inside
 * `computeConsentAggregates` (the CTE definition) — never 3×.
 *
 * Single-source is preserved: the CTE is DEFINED from the canonical
 * `projectSignatureDocIdsSql` helper, so the doc-set definition itself has not
 * forked — only the number of times the planner evaluates it changed.
 */
const SERVICE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'projects.service.ts');

/** Strip block + line comments so prose mentioning the old shape doesn't trip the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/** Extract the body of `computeConsentAggregates` (up to the next private/async
 *  method) so the assertions are scoped to THAT query, not the whole file. */
function computeConsentAggregatesBody(src: string): string {
  const start = src.indexOf('computeConsentAggregates');
  expect(start, 'computeConsentAggregates must exist in projects.service.ts').toBeGreaterThan(-1);
  // The next method after it in the file is `computeSignatureProgress`.
  const end = src.indexOf('computeSignatureProgress', start);
  expect(end, 'computeSignatureProgress must follow computeConsentAggregates').toBeGreaterThan(
    start,
  );
  return src.slice(start, end);
}

describe('PERF — consent doc-id set is materialised ONCE (proj_doc_ids CTE)', () => {
  const code = stripComments(readFileSync(SERVICE_PATH, 'utf8'));
  const body = computeConsentAggregatesBody(code);

  it('defines a proj_doc_ids CTE inside the consent query', () => {
    expect(body).toMatch(/proj_doc_ids\s+AS\s*\(/);
  });

  it('references the CTE (SELECT id FROM proj_doc_ids) at least twice', () => {
    const refs = body.match(/SELECT\s+id\s+FROM\s+proj_doc_ids/g) ?? [];
    // signed-share EXISTS + signatures_signed + signatures_pending → 3 refs;
    // assert ≥2 so a small refactor that legitimately drops one count still
    // passes, but a wholesale re-inline (0 CTE refs) fails loudly.
    expect(refs.length).toBeGreaterThanOrEqual(2);
  });

  it('invokes the canonical projectSignatureDocIdsSql exactly ONCE (the CTE def, not 3× inline)', () => {
    const calls = body.match(/projectSignatureDocIdsSql\s*\(/g) ?? [];
    expect(calls.length).toBe(1);
  });
});
