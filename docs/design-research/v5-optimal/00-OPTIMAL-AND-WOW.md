# 00 — OPTIMAL & WOW: the pre-build creative + certainty gate (design-lead synthesis)

> **Role:** Design Lead. **Job:** answer the owner's four questions directly, then decide what raises
> the plan from *adequate* to *OPTIMAL* — grounded in the real tree, inventive where it counts, honest
> where the data can't back a signal.
> **Inputs synthesized:** `01-entity-oneclick-completeness.md` · `02-puzzle-vs-rebuild.md` ·
> `03-creative-rechallenge.md` · `04-wow-control-experience.md` · `v4-readiness/00-FINAL-BUILD-PLAN.md`
> · `v4-readiness/01-api-action-map.md` · `DESIGN-NORTH-STAR.md`.
> **Load-bearing claims re-verified directly against code** (not just inherited): the UI primitive layer
> (`apps/web/src/components/ui/*` = button, list-page-shell, list-skeleton, name-display, status-badge —
> **no ConfirmDialog, no toast**); the reminder-memory gap (`packages/db/src/schema/artifacts.ts:148-162`
> — `signature_requests` has only status/expiresAt/createdAt/signedAt, **no `reminder_count` /
> `last_reminded_at`**); the optimistic-undo engine (`apps/web/src/hooks/notifications-optimistic.ts`
> exists); the cron substrate (`apps/worker/src/main.ts`); the recipient resolver
> (`apps/api/src/modules/signatures/signature-requests.service.ts`).
> **Date:** 2026-06-18. **This is the gate before we build.**

---

## VERDICT (one line)

**The direction is OPTIMAL-AFTER-ADDITIONS. The build is a PUZZLE (~88% of the work touches code that
already ships). Not every action is one-click yet — exactly 19 are not — but every one is countable,
homed, and backed by an existing audited/idempotent/409-guarded endpoint. The plan as written ships a
*calmer, safer dashboard*; five small, data-honest additions turn it into a system that *feels like it
is managing the project for you* — and they ride the certainty gates rather than bypassing them.**

The owner asked for certainty + creativity, not reassurance. The certainty: this is assembling a puzzle,
the gaps are enumerated, the rebuilds are bounded and off the correctness path. The creativity: the plan
delivers "the system does the work" through exactly ONE active mechanism (B3 auto-chase) and ONE human
loop (M2 resend) — that is adequate, not optimal. The leap to "WOW" is a **ranked action queue + a
cadence memory + a what-I-did report**, which is what every best-in-class tool in this shape sells, and
the data for all three is already in the schema (one of them needs a single additive column).

---

## 1. PER-ENTITY ONE-CLICK COMPLETENESS — the verdict + the residual gaps

**Does every action of every entity resolve to a single button-press? NO — but the gap is exactly 19
actions against ~140 verb-actions across 21 first-class entities (~88% already one-click or a one-line
wrapper).** All 53 real tables were enumerated from the schema (the authoritative list, not the prompt's
prose): 21 carry user verbs and are graded; 8 are sub-resources folded into a parent (building_sections,
signatures, task/external attendees, tabu_rows, import_errors, conversation_participants, role sub-
resources); 24 are system/internal correctly invisible (sessions, otp, the `ba_*` Better-Auth tables
that CLAUDE.md D.21 confirms are NOT in the auth path, `parcel_lookup` the owner deferred). No entity was
missed; Groups B and C are *deliberately* not one-click targets.

**The 19 residual gaps, in four clean buckets (all homed in the plan, none unbounded):**

| # | Bucket | Actions | Resolution |
|---|---|---|---|
| 1 | **Long orchestrations** (multi-POST by construction) — **4** | new-project build · import (4 POST+SSE) · tabu extract→confirm (3 POST over a STUB) · campaign send (no preview) | W1 composite build · C8 keeps 4 steps · N11 honesty-label gate · M5 dry-run preview |
| 2 | **Governance/destructive writes lacking a confirm/undo contract** — **6** | owner RTBF erase (irreversible) · member remove · share revoke · role assign · role revoke · ownership full-set replace | W2 two-track rule: undo-toast for the reversible 5; preview+confirm for RTBF only |
| 3 | **Headless actions with NO UI home** — **7** | DSAR export · member-override set · member-override clear · task-assignee list/add/remove (×3) · discovery-records create/update | W4 `/admin/operations` console homes all 7 as one ranked action-inbox |
| 4 | **Reads the flagship one-click depends on (net-new)** — **2** | B1 org pulse (home momentum) · B4 holdout-name ("מי תקוע → tap → name") | B1 + B4, both reuse existing CTEs/gate models |

**Critical nuance the owner must hear:** Bucket-2 items *technically* fire on one HTTP call today — they
fail the **doctrine's** one-click bar ("one *calm, reversible-or-confirmed, audited* click"), not the
HTTP bar. That distinction IS question #4. The missing thing is the *design of the safe single press*,
not an endpoint.

**Go-live blockers inside the 19 (close first):** B4 holdout-name (flagship drill stalls without it),
C16 DSAR/RTBF (legal liability, zero UI today), C12b provider recovery (first MFA lockout needs raw DB
access today).

---

## 2. PUZZLE vs REBUILD — the honest ratio + the true rebuild items

**This is assembling a puzzle, decisively — not rebuilding the app.** The real tree was opened and every
load-bearing claim verified. Of 41 build slices:

| Class | Count | Share | Meaning |
|---|---|---|---|
| **PUZZLE** | 23 | ~56% | endpoint + FE component/hook both exist → restyle/compose/wire only |
| **PARTIAL** | 13 | ~32% | real spine + a bounded net-new column/route/migration/primitive |
| **REBUILD** | 5 | ~12% | genuinely net-new — and clustered OFF the correctness path |

**~88% of the work touches code that already exists.** The substrate that makes it a puzzle: the consent
multi-CTE (`projects.service.ts:363-407`), the cron scheduler (3 live consumers on a clean `IJobHandler`
register→schedule pattern — so **B3 autonomy is "add a 4th handler," not "build a scheduler"**), the
cache provider (`postgres.provider.ts`, needs read-through wiring only), the RSC-prefetch pattern (~15
pages), the resend endpoint (audited + 409-guarded), the campaign's discarded `failed` computation, the
optimistic-undo engine, the board components, the audit spine. The three certainty gates are edits to a
**single existing service method plus one CI guard**: B0 re-bases arithmetic (`:419-421`) onto the
existing CTE; B5 adds a transition-map + If-Match to the existing `update()`; S0-SEC is a pipe over
existing controllers. **Waves 0–1 (the correctness-critical gates) contain ZERO rebuilds.**

**The TRUE rebuild items (5 — be honest):**
1. **B1 org pulse** — net-new route, but recycled SQL (reuses the `orgStats` multi-subquery + agent-scope
   CTE; no migration). *Rebuild-lite.*
2. **B4 holdout-name** — net-new route, but mirrors the existing `owners/:id/reveal-pii` audit+gate model
   and reuses the counts-only apartments join. *Rebuild-lite, precedent to copy.* (And the apartment-
   grained 80% — "דירה 7 · partial" — ships off the existing counts TODAY, no PII gate; only the name
   reveal waits on B4.)
3. **C12b provider operator console** — read-only today; MFA-reset/unlock/resend-invite are net-new at
   every layer. **The only full-stack rebuild**, correctly flagged a go-live blocker.
4. **C1 committee print-of-record** — **downgrade to PARTIAL**: reuse the existing
   `pdf-signed-document.renderer.ts` pipeline with a new template, not a new renderer. The scariest
   go-live blocker becomes a puzzle piece.
5. **C17 bulk verbs** — net-new routes, but trivially derived from the single-`:id` services.

**The one place the plan UNDER-counts (the real surprise → fold into Wave 0):** the **FE primitive layer
is missing**. Verified directly: `components/ui/` has button, list-page-shell, list-skeleton,
name-display, status-badge — and **no ConfirmDialog, no toast/live-region** (zero `sonner`/`useToast`;
the only "toast" is a bespoke `<p role="status">` inside the campaign action). Every confirm/undo/toast
in Waves 2–4 depends on **M0+G6 (the live-region) + a ConfirmDialog** landing first. These are *building
two small primitives*, not restyling existing ones — harden them as a **Wave-0 prerequisite**, not a
restyle.

---

## 3. CREATIVE-ADDITIONS REGISTER — ranked, slotted, data-honest

The plan equates "the system does the work" with *automating the chase + calming the surface*. But the
יזם's real job is **deciding what to touch next across 50 projects and not dropping the one about to
die** — which the plan never ranks, predicts, drafts, or reports back on. These additions close that gap.
Each: **value · does the data exist (honest) · where it slots.** Ranked by leverage/cost.

### TIER 1 — the optimal delta (do these; they make the WOW)

**A1 ⭐ Reminder memory — `reminder_count` + `last_reminded_at` (the one-column unlock).**
*Value:* turns the blind chase into a system with judgment — "נזכרת לאורי 3 פעמים, אולי זמן להתקשר"
(escalation), "שלחתי לפני 6 שעות, אין צורך" (de-dup), and powers an HONEST auto-cadence.
*Data:* **NO — confirmed missing** (`schema/artifacts.ts:148-162`). A single additive migration (`ADD
COLUMN reminder_count int DEFAULT 0`, `ADD COLUMN last_reminded_at timestamptz`) + an UPDATE in the
resend path + B3 increments it. Gate-6 schema change but trivial; mirror migration 0063/0065's additive
pattern.
*Slot:* **a tiny BE slice BEFORE B3** (B3's cadence needs it to not over-nudge). Feeds A2, A3, A4.

**A2 ⭐ Next-Best-Action ranker — the "do this next" engine (the single biggest "it's managing it"
lever).**
*Value:* the home stops being "5 rows you must read" and becomes "the 3 things to do today, in order,
each with the reason + one tap." The first item: *"רחוב הרצל — אורי מדירה 7 לא חתם, נשארה חתימה אחת
לסף. [שלח תזכורת]"*, ranked above 49 other projects because it scored highest. B1's `attention[]` ranking
is currently **undefined in the spec** — "show the 5 that need you" with no ranking is just "5 rows
sorted by one column."
*Data:* **YES, almost entirely** — every input is already in the B1 pulse row (`stalledDays`,
`nextExpiryAt`, `signedThisWeek`, share-weighted distance-to-threshold from B0). A ranker is a **pure
scoring function over the B1 row** — no new query, no migration. The "recently-touched" de-prioritizer is
perfect only once A1 lands; until then, rank on the four signals that exist and omit the recency term.
*Slot:* **extend B1** with a `rankAttention()` output; E2.1 consumes it. ~1 pure function + tests.

**A3 ⭐ The "while you were away, I…" digest (the system takes credit — THE doctrine wow sentence).**
*Value:* open → *"מאז ביקורך: סימנתי 4 בקשות כפגות תוקף, התקבלו 2 חתימות, הרצל חצה את הסף."* The strongest
possible "it's managing this for me" signal — a *report*, not a notification firehose.
*Data:* **YES** — `audit_log` already persists system actions (`actor_type='system'` from the expiry
sweep); "new signatures since last login" = `signedAt > lastSeenAt`; "threshold crossings" = B0's
edge-diff (M3 already computes it client-side). Only missing piece: a `last_seen_at` per user (or reuse
session last-activity) + a digest assembler. **No new event source — it narrates events already
persisted.**
*Slot:* a small BE digest endpoint **after B3** + a hero strip on E2.1. The most under-valued idea
relative to cost.

### TIER 2 — strong, ride existing slices (design the slots now)

**A4 Bulk-by-intent campaign — "chase everyone who's gone quiet."**
*Value:* replaces per-row drudgery with one approval — *"12 בעלים בכל הפרויקטים לא הגיבו 14 יום — לשלוח
לכולם? [כן]"*. The doctrine's "propose, don't ask" at scale.
*Data:* **MOSTLY YES** — the hard part (who's eligible / a renter / has no phone) is **already computed**
in the bulk recipient resolver (`signatures/signature-requests.service.ts`, the per-owner
`created/skipped_existing/failed`+reason path). Missing: a cross-project query for stalled pending
requests + a thin intent→recipient-set resolver. M5's preview/dry-run IS the foresight surface — extend
it from per-project to intent-scoped.
*Slot:* extend **M5** (preview) + **C17** (bulk verbs); surface the proposal on E2.1.

**A5 Anticipatory `expires_at` cards (legitimate forward signal, NO cron).**
*Value:* "אין תנועה" is reactive; *"3 חתימות פגות בעוד 5 ימים — לשלוח עכשיו?"* is anticipatory — catches
the stall before the project dies.
*Data:* **YES, read-only today** — every pending row has `expiresAt`. "Expiring this week" is pure
arithmetic, **not** a fabrication, **not** B3-dependent.
*Honesty caveat (binding):* the copy must stay present/future-arithmetic ("פגות בעוד 5 ימים"), **never**
"נזכיר שוב בעוד 5 ימים" — that future-promise stays B3-gated per the DO-NOT-FABRICATE register. The
distinction is the whole game.
*Slot:* a derived field on **B1** + a card on E2.1 + a filter on E2-list. Zero new infra.

### TIER 3 — strong but gated on later/deferred slices (design slots, sequence after deps)

**A6 "Build the project for you" from parcel (propose the structure, approve once).** The composite
commit **already exists** (`parcel-setups.controller.ts:81` commits buildings+apartments+ownerships in one
transaction). The "review a proposed structure, approve once" *shape* ships over **manual parcel entry
today**; full auto-populate rides the **owner-deferred** GovMap/parcel-lookup provider (`IParcelDataProvider`
seam ready). Re-frame C5 from "polish the 1468-line wizard" to "propose-and-approve." See W1/W4.

**A7 "Finish this project" coach (guided last-mile).** For a project at 90%: *"נשארו 3 חתימות. אורי
(דירה 7), רחל (12), משה (4). [שלח לכולם] · [סמן את משה כמתנגד]."* Pure composition of B4 (names) + B2
(objection) + `signatureMilestones` (jsonb staged targets, already in schema) — no new data. Slot: a
panel on the project board (E2.2-S3).

**A8 Auto-triage of the 5% exceptions (`needsHuman[]`).** A distinct calm lane: no-phone owners (already
detected in the resolver), objecting owners (B2), apartments past N reminders (A1). A derivation, not new
data. Slot: a second bucket in B1's pulse, rendered as a lane on E2.1.

### Patterns stolen from best-in-class (the throughline)

CRM (Pipedrive/HubSpot) sells a **ranked action queue** → A2. E-sign (DocuSign/PandaDoc) sells **cadence
memory + "last reminded 2d ago" + bulk-with-preview** → A1+A4+M5. Field-ops (ServiceTitan) sells **"what
changed since yesterday"** → A3. Collections (Gaviti/YayPay) sells **"chase everyone N days overdue" as
one intent** → A4. **Every best-in-class tool in this shape sells a ranked queue + a cadence memory + a
what-I-did report. This product has the data for all three; the plan names none of them as such.** That
is the entire adequate→optimal gap, and it is cheap.

---

## 4. THE ACTIVE / SMART / YOU-CONTROL / WOW EXPERIENCE SPEC

**Verdict: GREEN-with-five-primitives.** The control paradox is solvable cheaply — the undo engine
(`notifications-optimistic.ts`: immutable transform + a `prev` snapshot that IS the undo), idempotency
(`apiClient.postIdempotent`), the autonomy clock (3 cron consumers), and safe deep-linking
(`safeInAppLink`) all already ship. What's missing is purely the *experience layer*.

### The one law that makes "active" not "scary" — the two-track rule

> Reversible actions (the 95% — resend, archive, status, assign, role grant/revoke, share revoke, member
> remove) fire **instantly with an undo-toast and NEVER a confirm**. The rare irreversible ones (campaign
> SMS fan-out, RTBF erase, the `approved` legal transition) get a **preview → ONE justified confirm →
> narrated result**.

This kills confirm-fatigue (ten dialogs the user learns to dismiss → the one real RTBF confirm gets
click-throughed). **One confirm the user always reads beats ten he's learned to ignore.** Write it into
the universal DoD (GAP-W1, ~free): every new action declares its track; reversible ⇒ undo-toast, MUST NOT
get a confirm. Without the rule, each slice re-invents feedback badly (as the campaign action already
did).

### The five primitives (each grounded, each homed)

1. **Action Queue — "מה המערכת מתכננת"** (see-before-it-happens + a pause toggle). A `GET
   /org/automation-plan` read over the *same state B3's consumer decides on*, rendered a tick early.
   Pause writes an `automation_paused` flag the consumer checks. This is the primitive that makes "act in
   the background" feel like **delegation, not loss of control** — and the honest surface that finally
   lets the "I'll remind in N days" copy be *true* (forbidden today by the fabrication register). *Slot:
   extend B3 (GAP-W2).*
2. **Explain-Chip — "למה?"** Every system row carries a "why" disclosure: *"הצעתי לשלוח לאורי כי עברו 5
   ימים בלי תגובה והקישור פג בעוד 3."* Zero new backend — it presents B1 pulse fields (`stalledDays`,
   `nextExpiryAt`) the plan already pins, and deep-links via `safeInAppLink`. **Binding: cite only signals
   the backend actually emitted — a fabricated reason is worse than no chip.** *Slot: build in M2,
   generalize in B3, reuse in E2.1.*
3. **Undo-Toast** — the app-root live-region renders "✓ נשלחה תזכורת · בטל" (auto-dismiss ~6s, pause-on-
   hover); undo restores the `prev` snapshot; the same region updates in place on a server disagreement
   (409). Generalizes `notifications-optimistic.ts`; idempotency via `postIdempotent` prevents double-
   fire. *Slot: M0+G6 (primitive) → M2 (first undo).*
4. **Calm-Home reward** — open → *"בוקר טוב. הכול רגוע — אין מה לעשות עכשיו."* **The "all calm"
   empty-state IS the reward** (a manager who opens to zero cards because the system handled everything
   overnight is the single most powerful wow), plus ≤5 ranked ActionCards (A2) each with one tap + an
   explain-chip, plus a past-tense "אתמול שלחתי 4 תזכורות, 2 חתמו מאז" line (A3, B3-gated). *Slot: E2.1 —
   structure planned; add the emotional framing (GAP-W3).*
5. **Failure-Grace — never a dead-end.** The board never returns bare `null` (today
   `signature-progress-board.tsx` does — reads as "the system died"; elevate the C2 fix to trust-critical).
   A down provider becomes a calm retry-promise, not a wall. The campaign result narrates failures
   (*"נשלח ל-37 · 3 נכשלו (אין טלפון) · [תקן]"*) instead of discarding the `failed` count the backend
   already computed. *Slot: C2 (board) + B3 (retry) + M5 (failed-surface) under one contract.*

### The control paradox, answered in-code (zero new infra)

Every system-initiated action (B3 auto-reminder) writes the **same audit row shape** as the manual resend
(`signature_request.resend`), with an actor badge ("המערכת" vs the manager's name). The activity feed
renders manual and automatic chases *identically* — **the system acts visibly in the manager's own
ledger.** Active, but his.

### First-five-minutes wow (where we win or lose the tech-phobic יזם)

empty-org → **empty-WARM** ("בוא נקים את הפרויקט הראשון — אני אעשה את רוב העבודה") → **W4 composite
`POST /projects/build-from-parcel`** wrapping the existing `parcel-setups confirm` so onboarding is one
"approve this layout?" tap instead of 3-5 sequential POSTs (**the highest wow-per-effort net-new BE on
the whole front** — the difference between the first session feeling like data-entry and feeling like
magic) → one ActionCard ("40 דירות מוכנות. לזמן את כולם? [כן]") → the campaign preview confirm → **the
first "it handled it" moment**: *"שלחתי ל-38. אעדכן אותך כשמישהו חותם — אתה לא צריך לעשות כלום."* He
closes the app relieved.

### The moat

The יזם today runs on spreadsheets + WhatsApp + a lawyer's folder: 100% manual (no chase) and 0% safe
(no undo, no preview, silent corruption). We are the inverse — the system does the 95%, the 5% he keeps
is the 5% he *wants* (the judgment calls), each surfaced one at a time, each reversible. **We don't sell
"a better spreadsheet"; we sell "a junior associate who never forgets, shows his work, and never does
anything you can't undo."** That feeling of *delegation-with-control* is what a spreadsheet structurally
cannot provide.

---

## 5. OPTIMALITY VERDICT

**OPTIMAL-AFTER-ADDITIONS.** The plan's spine is excellent and must not be broken: B0 (the correct legal
number) underpins A2's ranking; B5 (state-machine + concurrency) protects every "approve" the coach
triggers; B3 (cadence) is the honest engine A1 feeds; the DO-NOT-FABRICATE register is exactly the
discipline that keeps A3/A5 honest. The creative additions are **additive layers on slices already in
flight, not replacements** — they ride the certainty gates, never bypass them.

**The right sequencing:** (0) harden the missing FE primitive layer — M0+G6 live-region + ConfirmDialog —
as a Wave-0 prerequisite; (1) ship the four certainty gates (S0-SEC, B5, B0, B3) as planned; (2) land
**A1 (reminder memory) before B3**; (3) fold **A2 + A3 + A5** into B1/B3/E2.1 (mostly derivations); (4)
re-frame C5 + M5 toward "propose, don't ask" (A4, A6) and add **W4 (composite build-from-parcel)**; (5)
design the slots for A7/A8 now so B4/B2 land into a coaching frame instead of bolting on. **Net new beyond
the plan: 1 migration (A1), ~3 pure functions / derived reads (A2/A5/A8), 2 small reads (W2 automation-
plan, A3 digest), 1 composite wrapper (W4), 2 FE primitives (ConfirmDialog + live-region) — no new domain
logic, no schema/auth/isolation rewrite.** That is the difference between adequate and optimal, bought
cheaply because the substrate is already production-grade.
