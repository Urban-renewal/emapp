# EMAPP — Autonomous Orchestration Log

The manager (Claude, main loop) does **not write feature code** — it orchestrates agents,
verifies every diff itself before any PR, and merges. This file documents the run at its
important points. Started 2026-06-07.

## Operating model (owner-approved: FULL AUTONOMY, high-risk documented)

**Per-task pipeline — builder ≠ test-author ≠ reviewer (no overlap, so no self-deception):**

1. **Scope** — the manager extracts goal/files/DoD from `MASTER-BACKLOG.md` + `DECISIONS`,
   and briefs every agent with the FULL PICTURE (architecture, locked decisions, the spine,
   the quality bar).
2. **Builder agent** — implements. Quality bar: runtime-efficiency · SOLID · single source of
   truth · error-handling · NO plaster (D.51 root-cause).
3. **Test-author agent (separate)** — writes adversarial real-DB/unit tests. Does NOT trust
   the builder's own tests.
4. **Reviewer agent (separate, `code-reviewer`)** — TWO jobs: (a) code review for SOLID /
   single-source / error-handling / runtime / root-cause-not-plaster; (b) **test-integrity** —
   proves the tests are not deceptive (assert real behavior, cover the risk paths, no
   tautologies, no over-mocking that hides the real path).
5. **Security-reviewer agent (separate)** — on any PII / auth / RLS / migration touch.
6. **Verify agent (separate)** — independently REPRODUCES the original finding and CONFIRMS the
   fix resolves it (gap gone, root cause addressed, no regression). Proves closure, doesn't
   assume it.
7. **Manager verifies the diff itself** — reads the full diff, runs typecheck + lint + the
   tests locally, re-confirms the finding is closed against the DoD, and re-checks its own
   conclusion. The PR is opened only after the manager's own pass.
8. PR → CI green → **merge** → log entry → end-of-phase re-audit → next task.

**Merge posture:** full autonomy — self-merge on green CI + the manager's verification.
**High-risk gate:** for any high-risk change (D.25 trigger, RLS, destructive migration,
auth-core), the manager writes a **decision record** (below) BEFORE proceeding, then proceeds
autonomously with extra verification rigor. The owner can intervene on any PR.

### ⚠️ VERIFICATION DISCIPLINE (owner-critical — "we must not err"; the owner runs the system himself)

Verify at EVERY transition — never trust a claim, prove it:

1. **Verify the finding** — before any fix, confirm the reported problem is REAL (reproduce it /
   cite the exact code). No false findings, no fixing a non-problem.
2. **Verify the fix** — after a fix, confirm it actually RESOLVES the finding (re-run the repro;
   prove the gap is gone) AND fixes the root cause, not the symptom (no plaster).
3. **Verify closure** — before declaring a task done and moving to the next, the manager
   INDEPENDENTLY re-confirms: diff does what's claimed · tests real + green · DoD met · no
   regression. A dedicated **Verify** agent stage reproduces-and-confirms; the manager then
   re-verifies on top (does not just trust the agents).
4. **Manager self-verify** — the manager re-checks its OWN conclusions, not only the agents'.
5. **End-of-phase re-audit** — after each phase, re-verify the phase's closed items still hold
   (no silent regression) before advancing. Nothing is "done" until proven done.
   This adds a **Verify** phase to every task pipeline (build → test → review → VERIFY → manager
   self-verify → PR).

### High-risk decision-record template

```
## [task-id] DECISION RECORD — <title>  (risk: HIGH)
PROBLEM:        what's risky + the blast radius.
OPTIONS:        the directions considered (A / B / C) with trade-offs.
RECOMMENDATION: the chosen one + WHY (correctness, reversibility, blast radius).
VERIFICATION:   how it was proven safe (local-DB invariant test, security review).
```

### Sequencing

By `MASTER-BACKLOG.md` order: Phase 1 (foundations) → 2 (schema while small) → 3 (trust) →
4 (core-loop) → 5 (notifications) → 6 (per-org generic) → 7 (provider) → 8 (billing) →
9 (polish) → 10 (design). Blocked-on-owner items (externals/inputs/decisions) are skipped
with a note, not stalled.

---

## Task ledger

| #    | Task                                 | Risk | Builder                                          | Test-author                                 | Review | Mgr verify                          | PR   | Status    |
| ---- | ------------------------------------ | ---- | ------------------------------------------------ | ------------------------------------------- | ------ | ----------------------------------- | ---- | --------- |
| P1-1 | OrgSettings config resolver          | low  | schema+resolver, pure-fn/DB split                | 46 tests (41 unit + 5 real-DB)              | PASS   | typecheck+lint+46 tests + read code | #284 | ✅ merged |
| P1-2 | design-token posture + ratchet guard | low  | canonical-source doc + inline-color ratchet spec | adversarial probe, +rgb/rgba, baseline 58/9 | PASS   | typecheck+lint+guard + read code    | —    | ✅ done   |

### P1-2 — notes

- Established `globals.css :root` as the canonical color-token source (+ a `tailwind.config.ts` breadcrumb for the known globals↔tailwind hex duplication) and a static RATCHET guard (`app-no-new-inline-colors.spec.ts`, wired into `pnpm test`) that blocks NEW inline-color debt without refactoring existing (Phase-10 work).
- **Separation caught a false-confidence gap (the owner's worst case):** the builder's guard was blind to `rgba()` — 44 of 58 occurrences = 76% of the true debt — so a builder could have shipped unlimited new `rgba()` debt with the guard green. The adversarial test-author added `rgb/rgba` and re-measured the honest baseline (14/7 → **58/9**).
- Reviewer independently reproduced 58/9 + verified near-zero false-positive risk (read all 48 rgba matches; tested the worst evasion candidate). Documented honest limits (named colors, `.ts` scope) rather than ship a guard that false-positives.
- Manager fixed a stale-comment NIT, ran typecheck+lint+guard, read the spec. Closure proven.

### P1-1 — notes

- Built the per-org config SEAM: `OrgSettingsSchema`+`DEFAULT_ORG_SETTINGS`+pure `resolveOrgSettings` (shared-types) + `getOrgSettings(tx,orgId)` resolver (api). No migration (uses existing `organizations.settings` jsonb). No consumers wired (later phases).
- **Reviewer found a robustness improvement** (not a blocker): fallback was whole-tree → one malformed leaf nuked the org's whole config. Manager decision: APPLY per-namespace fallback now (it's THE seam; ~6 lines; root-cause not plaster). Done + re-tested.
- **Test-author integrity call:** refused a deceptive tx-mock for the resolver; used the real-DB harness (`setupTestDatabase`+`withTenant`) so the SELECT + missing-row branch are genuinely exercised.
- Security-floor fields (OTP/lockout/throttle/token-TTL) deliberately OMITTED from the open settings seam (spine §SECURITY FLOOR).
- Manager independently ran: typecheck (both), lint, 41 unit + 5 real-DB tests, and read the code. Closure proven.

### P2 — Feature A (owner/renter) — 🟡 IN PROGRESS · branch `task/p2-feature-a` · UNCOMMITTED working tree (RESUME HERE)

Decision record: `docs/decision-records/P2-feature-a-owner-renter.md` (the build order + verification plan). HIGH-RISK (locked D.25 trigger); owner reviews at the very end.

- ✅ **STEP 1 — schema + migration + shared-types — DONE + LOCAL-DB VERIFIED** (in working tree, not committed):
  - `ownerships.relationship text NOT NULL DEFAULT 'owner'` + CHECK(`owner`|`renter`); `ownership_pct` stays NOT NULL.
  - Migration `0051_ownership_relationship.sql` (+ journal `when` 1781103600000): trigger predicate `+= AND relationship='owner'`, added `SET search_path=pg_temp,public` (closes §v8-M5), memo + {0,100} byte-for-byte, in-place `CREATE OR REPLACE` (no binding change).
  - shared-types: `relationship` enum on row/`shareEntry`/`ApartmentOwnerSchema`; refines `renter⇒pct=0` / `owner⇒pct>0`; owners-only-sum-to-100 (Zod edge ⟷ trigger backstop AGREE).
  - Verified on LOCAL PG (NOT Neon): owners=100 commits · renter pct0 inert · owners=90 rejects · `search_path` present. typecheck clean.
- ✅ **STEP 2 — ownerships service** — DONE (uncommitted): `replaceSet` persists `relationship`; in-app validation re-pointed to the shared-types refine (SoT, agrees with the trigger); `toOwnership`/`listApartmentOwners` surface `relationship` (PII parity). typecheck pass.
- ✅ **STEP 3 — signature renter-gate** — DONE (uncommitted): no server-side apartment→owners resolution exists (ownerIds are client-supplied), so added `resolveRenterOnly(tx, ownerIds)` guard at the single chokepoint in `signature-requests.service.ts` (create→404, bulk→`failed reason:'owner_is_renter'`), re-resolving `relationship` from the DB not the request. Excludes pure renters (≥1 renter row AND 0 owner rows). ⚠️ test-author/security to probe: cross-project owner-of-X / renter-of-Y semantics (gate is global-owner, not per-document-context).
- ✅ **STEP 5 — fixture-cascade sweep** — DONE (uncommitted): `pnpm -r typecheck` FULLY GREEN (8 pkgs); fixed web samples + 3 runtime-parsed fixtures (ownership.spec, ownerships.spec, ownerships.contract.spec); seeds/raw-inserts default to 'owner'. 26 spot-tests pass.
- ✅ **STEP 4 — FE owner/renter selector + inline create** — DONE (uncommitted): בעלים/שוכר select per row (renter forces pct 0 + disables %), owners-only sum hint mirrors `SetOwnershipsInput`, PUT body now carries `relationship` (fixes the broken save), inline "+ אדם חדש" reuses `useCreateOwner` (method=post, PII), VM+adapter+i18n(he/en)+e2e updated. typecheck+lint green.
- ✅ **TEST-AUTHOR** — DONE: `apps/api/.../owner-renter.spec.ts`, 16 real-DB tests green (A/B/C/E). A4+A6 = real predicate mutation tests; C4 = forged renter id re-resolved from DB; PII parity verified; E3 = `search_path` present.
- 🟢 **MANAGER DECISION — C3 cross-project renter-gate:** the gate is GLOBAL (owns-anything ⇒ eligible), so owner-of-X+renter-of-Y still gets a link. ACCEPTED for Feature A: the core guarantee (pure renter never signs) is met + tested; per-document-context blocking overlaps a PRE-EXISTING gap (the system already doesn't verify the signer owns an apartment in the document's project) and needs a larger change. → logged as a follow-up (document-context signature targeting), NOT a blocker.
- ⏭ **NEXT (resume from here):** **SECURITY-REVIEW** (F: trigger SQL + migration idempotency/journal, PII parity for renters, RLS via-parent isolation, the renter-gate) → fix any finding → **MANAGER VERIFY** (run full -r typecheck + the owner-renter real-DB spec + read the migration/gate myself) → ONE PR for all of Feature A → then resume MASTER-BACKLOG (next after P2 = Phase 3 trust: A3 / scheduler, per the plan).
