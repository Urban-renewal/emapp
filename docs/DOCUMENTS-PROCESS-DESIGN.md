# Org-customer document process — council synthesis + build plan

Owner 2026-06-23: the documents experience is still flat/static + won't hold at 100 projects/contractors;
"design the FULL process for an org customer with a council." 4 design lenses ran (read-only); full
lens docs in the agent transcripts. This is the synthesis + the prioritized, collision-aware build plan.

## The unified picture (where the 4 lenses converge)

The substrate is ~70% built; the failures are **seams + correctness + flat UIs**, not the model:

- **Situation-picture (L1):** org view must be a cockpit (pulse → ranked **project-attention** cards →
  fleet tiles), NOT 9 party cards / 100 flat tiles. The `כל המסמכים` tab + search are flat walls → one
  grouped+faceted shell. The per-project checklist (built, `GET /projects/:id/document-checklist`) is
  UNSURFACED — surface it as the project drill-down. **The "0 מתוך X" bug = one card fed by two unaligned
  queries** (required-SLOT count `received/required` ÷ a separate doc-ROLLUP `total`, different scope
  resolvers/populations) → fix: compute in ONE pass + show TWO distinct facts ("N מסמכים" + "מסמכי-ליבה X/Y").
- **Doc-model + auto-assign (L2):** the rigid dropdown / hardcoded `agreement` throw away the existing
  classifier + scope axis. Replace with ONE scope-aware **generic dropzone**: scope = the page you stand on
  (free), doc_type = classifier (confidence bands: AUTO ≥0.85 / CONFIRM 0.5–0.85 / ASK <0.5), party =
  derived, owner = inferred; sensitive types always pause for the encrypt notice + "חסר כאן" gap chips.
  GAPS: no document **lifecycle** (`valid_until`/`superseded_by` → completeness counts stale/dupes); 6
  missing doc_types + empty `supervisor` party; dedup "link-to-existing" needs a `document_links` join.
- **Autonomy (L3):** a `DocumentChaseRecommender` (reuses TaskWatcher detection) + 4 kinds
  (`document.request.send` / `.chase.send` / `.autofile` / `.sensitivity.flagForReview`) → the system
  CHASES the responsible party per missing doc; ~12–18 manual actions → 3 one-click confirms → 1 with
  bulk. Zero new engine parts. Outbound kinds need the OutboundGovernor gates + enforced share expiry.
- **Collaboration (L4):** two verbs — SHARE-TO (push, `external_share` exists) + **REQUEST-FROM** (pull,
  NEW `document_request` lets a party upload INTO the file). The binder's `missingTypes` IS the request
  queue ("חסר שומה" → "בקש מהשמאי"). `external_share` is reusable (extend, don't redesign): add recipient
  identity + the party portal (X-S4 token, OTP, reuse `decideExternalPartyAccess`) + invite-a-party FE +
  reconcile the two party taxonomies. **GATE: the #486-family sensitive-at-rest fix must land before the
  external party portal ships** (else `allowSensitive` parties risk plaintext PII).

## Build order (collision-aware: BE-correctness first, then UI, then model, then autonomy, then collab)

- **S1 — Fix the "0 מתוך X" bug + correct the completeness contract (BE + FE, foundational).**
  `documents.service.ts boardCompleteness`: compute `total` with the SAME canonical scope resolver as
  `received`; STOP dividing slot-count by doc-count — expose `coreReceived`/`coreRequired` (required-slot
  gauge) and `total` (docs filed) as distinct fields; FE shows "N מסמכים · מסמכי-ליבה X/Y". Add the
  regression test (party with N non-required docs + 0 required → "N · 0/#", never "0 מתוך N"). Security-light.
- **S2 — Org cockpit + kill the flat walls (FE).** Project-attention default (pulse → ranked attention
  ActionCards → fleet tiles, reuse board-primitives); redesign `כל המסמכים` + search into ONE grouped
  (project→party) + server-faceted (party/type/project/scope/scan-status) shell; surface the per-project
  checklist in the project drill-down. Add `projectId` to the search query.
- **S3 — Generic scope-aware upload (FE + thin BE).** Delete the 19-option dropdown + hardcoded `agreement`;
  one dropzone wired to classify + dedup + scope-from-context + confidence bands + "חסר כאן" chips;
  auto-associate to the exact party/project/owner. Optional `POST /documents/assign-preview` (suggest-only).
- **S4 — Doc-model: lifecycle + taxonomy (BE migration, owner-Gate-6).** `valid_until` + `superseded_by`
  columns; completeness counts only current+valid; close 6 doc_types (2 sensitive → SENSITIVE_DOC_TYPES) +
  the `supervisor` party; `document_links` join for one-object-many-placements. (Migration → Gate-6.)
- **S5 — Document autonomy (BE, reuses engine).** `DocumentChaseRecommender` + the 4 kinds + executors via
  external_share + OutboundGovernor; surfaces in the inbox + "המערכת מטפלת — נשלחה בקשה ל…" board state.
- **S6 — Cross-party collaboration (BE+FE, GATED on #486-family).** `document_request` (REQUEST-FROM) +
  recipient identity on external_share + the X-S4 party portal + invite-a-party FE + taxonomy bridge.

Gates per slice: G-RT (every security-sensitive: S4/S5/S6 + the PII boundary), G-QA **DEEP** real-Chrome
walk (test at scale, enter sub-surfaces, verify the NUMBERS), the new §G-QA standards (no flat/static,
auto-assign+minimum-actions, walk-deeply). Coarser cohesive PRs (couple BE contract + its FE consumer).
S1→S2→S3 are the visible-now wins; S4 is owner-Gate-6 (migration); S6 waits on #486.
