# MASTER PLAN V13 — unified build sprint (docs hub + sharing + Battle Map + scale IA)

> **Status: LOCKED + APPROVED (tech-lead) 2026-06-20.** Owner approved the council decision
> (`docs/COUNCIL-DOCS-TENANTS-DECISION.html`) + the search-first IA direction. This file is the
> single source of truth for the ~1.5-day sprint and its crash-recovery resume point.
> Companion: `docs/E2-SLICE-LEDGER.md` (per-slice evidence) · `docs/COUNCIL-OPEN-DECISIONS.md`.

## The promise (read literally)

NOT "all 41 streams ship in 1.5 days." The honest, keepable promise is:
**the security floor + the held merges + the full pure-BE substrate ship GAP-FREE; a bounded,
leverage-ordered set of FE slices ships real-Chrome-QA'd; and everything migration-risky /
counsel-gated / high-QA-surface is DEFERRED AS A COMPLETE NEXT-SLICE — never half-built.**
"No holes" ≠ "no deferrals." The binding constraint is the orchestrator's **serial real-Chrome
QA throughput** (every browser-observable slice = one manual walk in the owner's Chrome before
merge; pure-BE slices skip it). The plan budgets ~a dozen serial walks.

## The 4 feasibility cuts (APPLIED to this locked plan)

1. **BM-2 (battle grid + lifecycle migration) → DEFERRED.** Owner-migration-gated; BM-1 (leverage
   card, zero-schema) delivers the Battle-Map value alone. Highest-leverage cut.
2. **X-S6/X-S7 (share-sheet + revoke FE) → NOT GUARANTEED** (Wave D, pull-in-only-if-budget). Keep
   the full external_share BE foundation (X-S1/2/3/4/5) in-scope so the seam is closed, not a hole.
3. **NS8 (seeded-500/50k perf gate) → PROMOTED into Wave B as a hard gate.** The scale-gap closer
   must not ride the cuttable tail.
4. **DH1 (doc_type schema migration) → ISOLATED lane + full-suite gate BEFORE DH2/3/4.** If DH1's
   full suite isn't green at the checkpoint, defer the ENTIRE DH chain as a clean next-epic. A
   half-applied doc_type backfill on the live `documents` table is the worst possible hole.

## Locked waves (dependency-ordered)

### Wave A — security floor + zero-/cheap-QA merges (FIRST; spend the cheapest walks early) ∥

- **FL-1** `SHARE_TOKEN_SECRET` dedicated secret (replace JWT_SECRET reuse in share-token.service) + dual-verify grace. [BE 0.5d]
- **FL-2** audience split `emapp-share` vs `emapp-exchange` (additive; verify-side pinning; the exchange seam for Wave-5 without building it). [BE 0.5d]
- **FL-3** `DOC_ENCRYPTION_KEY` keyId→key registry (rotation-ready; backward-compatible single-key decrypt; ships code, prod values owner-deploy-gated). [BE 1d]
- **FL-5** נסח-backfill remediation sweep — idempotent, **dry-run-default**, ops-panel, re-classifies pre-existing tabu-content docs (closes the #450 HIGH follow-up). [BE-ish 1d]
- **FL-6** #442 tenant-portal reskin — live tenant-OTP QA walk (phone `0501234567`, org `alpha-dev`, OTP `000000`) → merge. [FE-QA 0.5d]
- **FL-7** #444 provider-subtree reskin — **seed a provider-admin (MFA) fixture first**, then QA walk → merge. [FE-QA 0.5d]
- **FL-8** F-a `text-muted` foreground guard — ratchet/lint ban on bare `text-muted` as a text utility + fix offenders. [BE-guard 0.5d]
- **FL-9** F-b apartment designation — extend `formatApartmentLabel` with building/floor qualifier + e2e literal updates. [FE 1d]

### Wave B — pure-BE substrate (MAX parallel fan-out, ZERO serial-QA cost) ∥

- **NS1** server-side search endpoints: `GET /projects?q=&status=&segment=`, `/owners/search`, `/documents/search` (keyset, RLS, trgm+btree indexes). [BE 2d]
- **NS2** PII-gated cross-project national_id lookup branch on `/owners/search` (view_owner_pii, hashed-match, audited, @security-reviewed). [BE 1d] ←NS1
- **NS3** `saved_view` model + endpoints + system segments (Zod-validated query_json on save AND replay). [BE 1d] ←NS1
- **NS8** ⚡ HARD GATE — seeded-500-project / 50k-owner perf gate on signaturePulse + rankAttention + the 3 search endpoints + leverage. [BE 1d] ←NS1,NS2
- **X-S1** `SHARE_TOKEN_SECRET` split (== FL-1; build once). **X-S2** `external_share` schema + hand-authored migration + party/scope enums + preset ceilings + strict Zod. [BE 2d]
- **X-S3** `external_share` BE service: create (preset ceiling re-validated, fail-closed, narrows-only), update, revoke, list, extend, resend; suspended-org inert; no-oracle. [BE 2d] ←X-S2
- **X-S4** OTP access gate BE: `external_share_otp` + session tables + migration; issue/verify, session cookie, rate-limit + reuse-detection; org default-ON + per-share narrow-only. [BE 2d] ←X-S3
- **X-S5** per-recipient watermark on sensitive external delivery (decrypt-stream overlay + audit; non-sensitive byte-identical). [BE 2d] ←X-S3
- **DH1** ⚡ ISOLATED — `doc_type` pgEnum (~16 types) + `scope` pgEnum(org|project|apartment|owner) + `scopeId` uuid + ownerId FK + CHECK + sensitive-derive migration. **Full-suite gate before DH2/3/4.** [BE 2d]
- **DH2** `GET /projects/:id/document-checklist` endpoint + view — required doc_types per track, auto-tick, completeness %, **ADVISORY only** (gate-wiring deferred to Open #2). [BE 2d] ←DH1
- **DH3** heuristic classifier + suggest (filename regex + mime + magic-byte + first-page text) — suggest-never-auto-commit. [BE 2d] ←DH1,DH2
- **DH4** dedup link-not-duplicate: contentHash probe → "קשר לקיים" scope link. [BE 1d] ←DH1
- **BM-1-be** leverage scorer: `GET /projects/:id/leverage` — marginal-delta-to-headline one-SQL-pass (NOT share-sum). [BE part of BM-1]

### Wave C — value-now browser-observable FE (serial QA, leverage-ordered) →

- **BM-1** leverage card FE — "מפת קרב" entry: "המנוף שלך: דנה כהן, 28% בדירה 4 — 61%→71%, מעל הסף" + one-tap remind. [FE 2d] ←BM-1-be
- **HB-1** home card chase — inline "שלח תזכורת לכולם" resend (kill-switch + Idempotency-Key + recipient-scope + optimistic undo); act WITHOUT leaving home. [FE 2d] ←#437,#417,#418,B1
- **HB-3** inline "מי תקוע?" gated holdout-name expander on each card (B4 names, NameDisplay) + per-name single-remind. [FE 2d] ←HB-1,#438
- **HB-4** per-card mini ThresholdProgress sliver + queue-tail line ("ועוד N פרויקטים במעקב"). [FE 0.5d]
- **NS6** projects-list server-search swap — kill the client-side-only filter in projects/page.tsx, wire to NS1. [FE 1d] ←NS1,NS3

### Wave D — external-share FE + scale FE (serial QA, only what FULLY finishes; NOT promised) →

- **X-S6** share sheet FE (party-chip → preset auto-fill, can-only-narrow, StepUp for sensitive, one-tap create+send). [FE 2d] — pull-in if budget
- **X-S7** share-activity / revoke panel FE (countdown, last-accessed, extend/resend/revoke via ConfirmDialog). [FE 1d] — pull-in if budget
- Natural cut line under time pressure: NS6 → X-S7 → X-S6 (each cut item stays complete-or-untouched).

## DEFERRED — complete next-slices, NOT holes (each fully specced)

- **BM-2 / BM-3** battle grid + `owner_engagement_status` lifecycle + delivery-event log + estate handling — owner-migration-gated; BM-1 stands alone.
- **NS4 / NS5** owners + documents search-first FE work-queues — the two largest serial-QA FE swaps; backend (NS1/2/3) is in-scope so the foundation is closed.
- **NS7** global ⌘K/"/" omnibox (S4) — additive on the existing endpoints.
- **X-S8** recipient-OTP gate FE + **contractor-tier migration onto external_share** — highest-regression; contractor stays on its merged path until a deliberate parity-proven walk.
- **FL-4** documents-aware erasure (RTBF) — HIGH-risk false-compliance fix; needs full erasure spec + R2-delete durability + DPO (owner) sign-off; Open #3 (evidence pack) stays out.
- **HB-2** expiring "חדש קישורים" re-mint · **HB-5** M3 drain/finish-line motion — polish; board fully functional without.
- **DH2 hard `→approved` gate wiring** — ships ADVISORY; gate is a one-flag flip after counsel signs templates (Open #2).
- **prod DOC_ENCRYPTION_KEY + SHARE_TOKEN_SECRET deploy values** — owner-deploy-gated (FL-1/FL-3 ship code with dev fallbacks; CI green).
- **Owner-migration set:** A1 reminder-memory · B2 decline_reason migration · B3 worker · C1 print · C16/C12b · OD-1 statutory % · OD-7 signer-identity · Wave-5 outbound exchange (owner MUST-RESOLVE) · Wave-6 AI/DPA · owner↔doc package sharing (needs owner↔doc link).

## Execution discipline (the owner's rules)

- **No jumping.** Build Wave A + Wave B in parallel (agents, mostly pure-BE → no QA cost). Then Wave
  C serial-QA in strict leverage order. Wave D only if budget.
- **Every slice green-gated** (typecheck+lint+test+`next build`) + its own PR. Pure-BE merges on
  green; browser-observable merges ONLY after the orchestrator's real-Chrome QA walk in owner's
  Chrome (no `--auto` for UI). Security-sensitive diffs (HB-1 external resend, HB-3/NS2 PII, X-S5
  watermark, all share/erasure) get @security-reviewer BEFORE commit.
- **DH1 is a hard checkpoint:** full-suite green before DH2/3/4, else defer the whole DH chain.
- **Never leave a hole.** If the window tightens, cut from the tail (Wave D first) — each cut item
  stays complete-or-untouched.

## ▶ SPRINT RESUME POINT (update each turn)

- **2026-06-20 — Plan LOCKED + APPROVED.** Council planning done (9 agents). Cuts applied.
  Kicking off Wave A + Wave B substrate (parallel BE agents, background). Nothing built yet this
  sprint. Next: dispatch Wave B dependency-root BE agents (NS1, X-S1/2/3 share-foundation, DH1
  isolated) + Wave A quick wins (FL-8 guard), then fan out dependents as roots land.
