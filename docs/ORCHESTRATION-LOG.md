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

| #    | Task                        | Risk | Builder                           | Test-author                    | Review | Mgr verify                          | PR  | Status  |
| ---- | --------------------------- | ---- | --------------------------------- | ------------------------------ | ------ | ----------------------------------- | --- | ------- |
| P1-1 | OrgSettings config resolver | low  | schema+resolver, pure-fn/DB split | 46 tests (41 unit + 5 real-DB) | PASS   | typecheck+lint+46 tests + read code | —   | ✅ done |

### P1-1 — notes

- Built the per-org config SEAM: `OrgSettingsSchema`+`DEFAULT_ORG_SETTINGS`+pure `resolveOrgSettings` (shared-types) + `getOrgSettings(tx,orgId)` resolver (api). No migration (uses existing `organizations.settings` jsonb). No consumers wired (later phases).
- **Reviewer found a robustness improvement** (not a blocker): fallback was whole-tree → one malformed leaf nuked the org's whole config. Manager decision: APPLY per-namespace fallback now (it's THE seam; ~6 lines; root-cause not plaster). Done + re-tested.
- **Test-author integrity call:** refused a deceptive tx-mock for the resolver; used the real-DB harness (`setupTestDatabase`+`withTenant`) so the SELECT + missing-row branch are genuinely exercised.
- Security-floor fields (OTP/lockout/throttle/token-TTL) deliberately OMITTED from the open settings seam (spine §SECURITY FLOOR).
- Manager independently ran: typecheck (both), lint, 41 unit + 5 real-DB tests, and read the code. Closure proven.
