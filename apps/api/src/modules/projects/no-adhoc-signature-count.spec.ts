/**
 * 0.1 DRIFT-GUARD (static ratchet) — the home KPI signature counts must NEVER
 * regress to a bare, doc-scope-blind `COUNT(*) FROM signature_requests WHERE
 * status = …`. That form is archived-inclusive and out-of-project-scope, so it
 * diverges from the canonical board/pulse definition (projectSetSignatureDocIdsSql)
 * — the "0 מתוך X" / home-KPI-lies class. Every signed/pending count in the home
 * KPI MUST be doc-scoped (aliased `sr.status … AND sr.document_id IN (…)`).
 *
 * Idiomatic sibling of `app-no-bare-text-muted.spec.ts` — a cheap, exact,
 * false-positive-free lock on the one file that carried the bug. (The provider
 * cross-tenant tally is a deliberately different org-scoped metric and is out of
 * scope for this guard.)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, 'projects.service.ts');

describe('0.1 drift-guard — no ad-hoc un-scoped signature count in the home KPI', () => {
  it('projects.service.ts never reintroduces a bare `FROM signature_requests WHERE status =`', () => {
    const src = readFileSync(SRC, 'utf8');
    // The fixed code aliases the table (`FROM signature_requests sr WHERE sr.status
    // = 'signed' AND sr.document_id IN (…)`), so the un-aliased bare form below is
    // absent. Its reappearance = the 0.1 regression.
    expect(src).not.toMatch(/FROM signature_requests WHERE status =/i);
  });
});
