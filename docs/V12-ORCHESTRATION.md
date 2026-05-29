# EMAPP — V12 Orchestration (control tower)

> How the V12 work is surfaced, ordered, divided across agents, paced, and
> verified. Companion to: `FINDINGS-REGISTER.md` (what's broken),
> `MASTER-PLAN-V12.md` (slices + deps), `DECISIONS-V12.md` (D.42–45),
> `SETUP-EXTERNAL-SERVICES.md` (infra). This doc is the **who/when/how-paced**.

---

## 1. Ordering principle — what to close first, and why

Efficiency = unblock → highest-leverage → parallelize isolated surfaces →
foundation before features. The order is NOT "by severity" — it's by
**dependency + leverage**:

1. **Unblock (ENV-1)** — nothing runs reliably without it. One slice, first.
2. **Highest leverage (PERF-1 + PERF-2)** — they touch _every_ request. Fix
   early and all later testing/demos run on the fast stack. Biggest ROI/hour.
3. **Already-done quick win (FUNC-2 / PR #134)** — merge it; instant visible value.
4. **Parallel isolated surfaces** — perf-core (BE), FE-fixes, and the new-tier
   build don't touch the same files → run simultaneously.
5. **Foundation before new tiers** — stabilize the built Org tier while the new
   Provider/Resident build runs on its own surface.
6. **Decision-gated work** — was blocked; D.42–45 are now made → unblocked.

---

## 2. Agent division (ownership map — chosen to avoid merge collisions)

| Agent                            | Track | Surface (owns)                                                                                                           | Must NOT touch                |
| -------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------- |
| **A1 — Core/Perf**               | A     | `packages/db` wrappers, `apps/api` infra, indexes, env/turbo                                                             | FE, new tiers                 |
| **A2 — FE Fixes**                | B     | `apps/web` existing Org screens/forms/routes/copy                                                                        | BE, new tiers                 |
| **A3 — Architecture**            | D     | NEW: permission model (policy/JSONB), Provider console + `admin.emapp.io`, contractor portal, resident portal completion | existing Org perf/forms       |
| **A4 — Security/ISO**            | C     | auth/portal hardening, logging, ISO mapping                                                                              | joins after stack stable      |
| **(you / a session) — Verifier** | —     | runs the `e2e/audit/*` suite objectively after each merge                                                                | never fixes (stays objective) |

**Collision rule:** different surfaces by design. The one shared seam is
`packages/shared-types` — **add only, never change an existing type without
posting an issue to the affected track** (V11 lesson). `policy.ts` is Gate-6 —
only Track D edits it, and only per D.43.

---

## 3. Rollout — who launches when (don't start 5 at once into a fresh tree)

```
G0      Infra gates FIRST (operator, ~30 min total):
        G0.1 branch protection + required CI checks on main
        G0.2 CODEOWNERS (policy.ts / shared-types / migrations → owner)
        G0.3 security-review + code-review skills per PR
        → from here, a red or self-graded PR cannot be merged. Mechanical.
                               ▼
Day 0   A1: ENV-1 (unblock)  ──┐  every other agent waits for green stack
        merge PR #134 (FUNC-2) │
                               ▼
Day 0-1 LAUNCH IN PARALLEL (isolated surfaces):
        A1 → PERF-1, PERF-2 (perf core)        [Track A]
        A2 → FUNC-1, FUNC-3, FUNC-4, UX-3      [Track B]
        A3 → permission-model canary, then admin-app scaffold  [Track D]
Day 2+  A4 joins → SEC-2..6 (needs only running stack)  [Track C]
        A1 → PERF-3, PERF-4 ; A3 → Provider console, portals
Ongoing Verifier runs full audit suite after every merge (integration gate)
Pre-launch  PL1 prod-build+colocated DB · PL2 full suite · PL3 load · PL4 scaling
```

Track D is the longest (new tiers) — it starts **day 0** in parallel because
its surface is net-new (no collision), gated only on D.42–45 (now decided).

---

## 4. Cadence — the rhythm you see

- **Per slice:** branch → write/locate the failing verification test → fix →
  red→green + full suite green → PR with mechanical evidence → self-merge (if
  all green) → heartbeat → next slice. No waiting for you between slices.
- **Heartbeat:** each agent appends to `docs/heartbeats/track-<x>/<date>.md`
  after every slice: what shipped, decisions self-made, surprises, next.
- **Integration gate (per milestone):** Verifier runs the **full** `e2e/audit/*`
  suite → confirms no cross-track regression before the next milestone.
- **What you see each morning:** N merged PRs + N heartbeats + maybe 1–2
  STOP-condition asks. NOT 8 open PRs awaiting approval.

---

## 5. Verification contract — the anti-self-grading core

The whole reason the previous agents failed: they graded their own work. V12
removes trust from the loop:

1. **The audit already wrote failing tests** (`apps/web/e2e/audit/*`). A fix is
   "done" only when its specific test goes **red→green** — and the fixer
   **did not write that test** (the objective auditor did).
2. **No regression:** the full audit suite stays green.
3. **Mechanical evidence in every PR** — curl/trace/query-plan/screenshot,
   never "verified ✓".
4. **Independent Verifier** re-runs the full suite after each merge — the
   real-state dashboard, no agent's word required.
5. **New work needs a new test first** (TDD-from-spec): for a slice the audit
   didn't cover (e.g. provider console), the agent writes the test **from the
   spec/DECISIONS**, not from the code, and a different session/you confirm it
   actually asserts the behavior.
6. **Quality gate, not just correctness (PROC-3 / D.51).** Correctness (test
   green) is necessary, not sufficient. Each fix also needs: a root-cause
   statement, **mechanism-based criteria a plaster can't pass** (if a caching
   hack would also pass the test, the test is too weak), and an anti-plaster
   review. This is the gate against "understood the problem, shipped a shortcut".
7. **Autopilot completion — a slice isn't done until ALL its checks are green.**
   "Opened a PR / CI is running" is NOT done. The agent waits out its own CI
   (the 8 branch-protected checks), fixes any failure, and only then merges and
   advances. It never leaves a slice half-verified or hands a red/pending PR
   forward. Branch protection now enforces this mechanically — a red PR cannot
   merge, period.

---

## 6. The shared agent operating contract (every V12 agent reads this)

```
אתה חבר צוות מן המניין ב-EMAPP, V12 (Stabilize + Complete). לא קונסולטנט —
אתה בעלים של track, רץ אוטונומית, ועוצר רק ב-STOP conditions מוגדרים.

קרא לפני קוד (~1.5 שעות):
  CLAUDE.md (root + apps/api + apps/web + packages/db) ·
  DECISIONS.html (D.01–D.41, LAW) + DECISIONS-V12.md (D.42–45) ·
  GATES.md · FINDINGS-REGISTER.md · MASTER-PLAN-V12.md (ה-track שלך) ·
  V12-ORCHESTRATION.md (זה) · V11-BROWSER-SMOKE.md · PROGRESS.md ·
  packages/db/src/wrappers/with-tenant.ts (איך RLS נאכף) ·
  apps/api/src/common/authz/policy.ts (D.17 — Gate-6, אל תיגע אלא אם track D)

פרוטוקול תשאול-עצמי (על כל ממצא/טענה):
  1. observed או inferred? inferred=לא ראיה.
  2. מה היה מפריך? נסה לשבור.
  3. תחשוד בהצלחה יותר מבכישלון.
  4. ground truth: docs/code/UI/DB לא תמיד תואמים — מצא מי האמת.
  5. אמת בסשן הזה, לא מהזיכרון.
  adversarial self-review לפני כל commit.

לולאת slice:
  branch ← main → כתוב/אתר את הטסט שנכשל (אתה לא כתבת אותו = אובייקטיבי) →
  תקן root cause → הטסט red→green + כל ה-suite ירוק + lint+typecheck+test →
  PR עם evidence מכני (curl/trace/query-plan/screenshot, לא "✓") →
  self-merge אם הכל ירוק → heartbeat → slice הבא. לא מחכה לי.

verification: עבודה "גמורה" = טסט (שמישהו אחר כתב) ירוק + אפס regression.
לעבודה חדשה (provider console וכו') — כתוב טסט מה-spec קודם, לא מהקוד.

DNA: תמונה מלאה לפני שינוי · מאותגר→הנח שטעית · root cause לא פלסטר ·
ראיה לא טענה (file:line) · withTenant/Provider/Bootstrap בלבד (db ישיר=Gate-1) ·
secrets מ-Infisical (אמת שחסר לפני שתטען שחסר) · PII לעולם לא בלוגים ·
Hebrew למשתמש/English בקוד · כתוב כאילו audit מחר.

STOP (היחידים): Gate-6 architectural לא ב-DECISIONS → D.NN draft + עצור ·
security CRITICAL → דיסקרטי · 5 כשלונות על אותו דבר · L4 irreversible
(secrets set/delete, force-push, prod data, merge --admin) · משאב חיצוני ·
חסום על track אחר → issue + עבור לסלייס לא-חסום (אל תעצור הכל).

סביבה: git worktree משלך (cp .infisical.json) · infisical run --env=dev --
prefix תמיד · Playwright primary לאימות (deterministic), curl לאבטחה, psql
ל-query plans, Chrome MCP רק לויזואלי (tabId חובה, אין param "format").

PRs מצטברים, אני מאחד. אתה לא מחכה.
```

---

## 7. Per-track kickoff (the addendum each agent gets on top of §6)

**Track A — Core/Perf/Env (Agent A1):**

> שלך: ENV-1 → PERF-1 (withTenant pipeline, canary) → PERF-2 (getMe SSR) →
> PERF-3 (index) → PERF-4 (retry) → PERF-5 → ENV-2/3. canary=PERF-1 (round-trip
> count ≤2, מדוד). אתה owner של packages/db wrappers + apps/api infra. אל
> תיגע ב-FE או policy.ts.

**Track B — FE Fixes (Agent A2):**

> שלך: merge PR #134 → FUNC-1 (owner-email + sweep optional+formatted class) →
> FUNC-3 (404 routes) → FUNC-4 (hydration) → UX-3 (jargon) → UX-2 (skeletons) →
> FUNC-5. canary=FUNC-1. owner של apps/web Org screens. אל תיגע ב-BE.

**Track D — Architecture (Agent A3):**

> שלך (הכי ארוך): permission-model (D.43 — Agent capability matrix + Contractor
> per-share scope, JSONB, IDOR-safe download, server-enforced D.17) → admin-app
> (D.45 — admin.emapp.io, cookie scope) → Provider console (D1 onboarding → D2
> console → D3 config) → Contractor portal → Resident portal completion (D5).
> canary=permission-model slice. policy.ts הוא שלך (Gate-6 — לפי D.43 בלבד).

**Track C — Security/ISO (Agent A4, joins day 2):**

> שלך: SEC-1 masking (D.44, קואורדינציה עם portal של D) → SEC-2 (PII-in-logs) →
> SEC-3 (provider MFA) → SEC-4 (refresh reuse) → SEC-5 (CSRF) → SEC-6 → C7 (ISO
> mapping, gated על ISO-SCOPE). canary=SEC-2.

---

## 8. PM-level guards (things easy to miss)

- **Small PRs.** 3 agents merging to main → keep PRs atomic so reverts are clean.
- **Integration gate每 milestone** — full audit suite green before next wave.
- **New tiers get a canary** (like V11) — first slice of Track D proves the
  pattern before the rest.
- **Rollback path per slice** — revert PR is the undo; that's why self-merge is
  safe.
- **shared-types = add-only** across tracks.
- **Procurement-pending tracked** (SMS/ISO-scope/domain) — not design blockers,
  but flagged so they don't surprise pre-launch.

---

## 9. Self-verification — coverage cross-check (every finding → owner)

| Finding                 | Track      | In plan?         | Verification defined? |
| ----------------------- | ---------- | ---------------- | --------------------- |
| PERF-1..6               | A (PL1)    | ✓                | ✓                     |
| ENV-1,2,3               | A          | ✓                | ✓                     |
| FUNC-1..5               | B          | ✓                | ✓                     |
| UX-2,3                  | B          | ✓                | ✓ (UX-1=PERF-4)       |
| SEC-1                   | C+D        | ✓ (=D.44)        | ✓                     |
| SEC-2..6                | C          | ✓                | ✓                     |
| ISO-SCOPE/C7            | C          | ✓ (gated)        | ✓                     |
| ARCH-1,2,3              | D          | ✓                | ✓                     |
| ARCH-5 (contractor)     | D          | ✓ (D.43)         | ✓                     |
| ARCH-6 (resident)       | D          | ✓                | ✓                     |
| permission-model (D.43) | D          | ✓                | ✓                     |
| admin-app (D.45)        | D          | ✓                | ✓                     |
| PROC-1,2                | cross      | ✓ (the contract) | ✓                     |
| PL1-4 (prod/load/scale) | pre-launch | ✓                | ✓                     |

**Honest gaps after self-check:**

1. **Provider/Resident tiers have NO audit test yet** — the auditor only wrote
   specs for what exists. Track D must write those specs _from spec_ before
   building (TDD), and the Verifier confirms they assert real behavior. Without
   this, Track D self-grades — the exact trap. **Mitigation: §5.5 enforced.**
2. **Procurement (SMS / ISO-scope / domain)** can stall Track C (ISO) and the
   SMS-dependent OTP prod path. Design is decided; **owner must procure** to
   fully close C7 and prod OTP.
3. **Concurrency/scale (PL3/PL4)** validate "many customers" — but only at
   pre-launch. If scale is a near-term sales promise, pull PL3 earlier.
