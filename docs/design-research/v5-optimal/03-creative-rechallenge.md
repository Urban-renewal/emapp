# 03 — Creative Re-Challenge: is the planned direction OPTIMAL, or merely adequate?

> **Front:** push the current direction's assumptions, then INVENT — concretely, on THIS stack.
> **Method:** read the FINAL-BUILD-PLAN + North-Star + DECISIONS-LOCKED + the api-action-map, then
> ground every creative claim in real services/schema (`file:line`). No fabrication: where a signal
> the backend cannot honestly back, it is flagged.
> **Author:** Creative re-challenge seat. **Date:** 2026-06-18.

---

## VERDICT (this front)

**The planned direction is CORRECT but currently scoped to ADEQUATE, not OPTIMAL.** The build plan is
the best *defensive* plan I have read for this codebase — it correctly front-loads the four certainty
gates (S0-SEC, B5, B0, B3), it is honest about what the backend can back (the DO-NOT-FABRICATE
register, §A.2), and it homes all 55 gaps. But "the system does the work; the developer just approves"
(North-Star §11) is, in the current 41-slice plan, delivered by exactly **ONE** active mechanism:
**B3** (1 cron consumer + 3 notification kinds) and **ONE** human loop: **M2** (one-tap resend). Everything
else in the plan is *re-composition of CRUD into calmer CRUD*. That is necessary and it will ship a
materially better product — but it is **a prettier, safer dashboard with one chase loop bolted on.** It
is not yet a system that **feels like it is managing the project for you.** The gap between "calm CRUD"
and "WOW, it's doing my job" is **4–5 small, buildable mechanisms the plan does not yet name** — every
one of which sits on data the schema already holds. Closing them is the difference between adequate and
optimal, and the marginal cost is low because the substrate is already there.

**The core assumption I am challenging:** the plan treats "the system does the work" as satisfied by
*automating the chase* (B3) and *calming the surface* (E2.x). But the יזם's real job is not chasing —
it is **deciding what to touch next across 50 projects, and not dropping the one that's about to die.**
The plan gives him a calmer list and an auto-nudger. It does **not** give him a system that **ranks his
day, predicts the stall, drafts the message, and reports back what it already did.** Those four are the
"WOW." They are missing, and they are cheap.

---

## PART 1 — Challenging the current direction (skeptical pass)

### Challenge 1 — "Triage by exception" is specified as a VIEW, not an ENGINE
North-Star §3 and the plan's home (E2.1) promise "the ~5 projects that need you now." But read what
actually backs it: B1's pulse (`org/signature-pulse`) returns `buckets` + an `attention[]` array whose
ranking is **undefined** in the spec — the plan pins the *row schema* (`lastSignatureAt`, `signedThisWeek`,
`stalledDays`, `nextExpiryAt`, build-plan §WAVE-2/B1) but **never says how the 5 are CHOSEN or ORDERED.**
"Show the 5 that need you" without a ranking function is just "show 5 rows sorted by one column." The
manager still has to scan and decide. **The single highest-leverage missing piece is a Next-Best-Action
ranker** — and every input it needs is already in the B1 row. This is adequate-vs-optimal in one slice.
*(See Idea A.)*

### Challenge 2 — M2's "one-tap chase" is honest but BLIND
M2 wraps `POST /signature-requests/:id/resend` (`signature-requests.controller.ts:142`) in a calm button.
Good. But the manager taps it **per holdout, per project**, with no memory: there is **no `reminderCount`
/ `lastRemindedAt` / `sentAt` column on `signature_requests`** (confirmed — `schema/artifacts.ts:150-156`
has only `status`, `expiresAt`, `signedAt`, `createdAt`). So the system cannot tell him "you already
nudged אורי twice, escalate to a call" or "don't re-nudge, you sent one 6 hours ago." The chase loop is
**one tap but zero judgment.** The doctrine says "act in the background; hand up the 5% that need a human"
(§North-Star) — but with no reminder history, the system **can't distinguish the 5% from the 95%.** This
is a one-column migration that unlocks the entire "the system knows what it already tried" story. *(Idea B.)*

### Challenge 3 — "Propose, don't ask" is violated at the two highest-stakes moments
The doctrine's #1 principle (§North-Star.1) is "the system pre-decides recipients/message/timing; the
developer approves." Yet the **two biggest actions remain construct-it-yourself**:
- **Campaign send** — M5 adds a preview/dry-run (good, N8), but the manager still picks the document and
  fires a raw fan-out. The system never *proposes* "Building א has 12 unsigned owners — send them the
  agreement?" It waits to be told. The recipient resolution that would power a *proposal* already exists
  (`signature-requests.service.ts:455-534` computes who's eligible, who's a renter, who has no phone).
- **New-project build** — C5 re-skins a 1468-line wizard. But the plan itself notes (api-action-map G2)
  there's no composite "build project from parcel" transaction; `parcel-setups` confirm
  (`parcel-setups.controller.ts:81`) is the closest, and it **already commits buildings+apartments in one
  step.** The system *could* propose the whole building from a גוש/חלקה and have the manager approve — the
  seam exists. C5 instead polishes the manual form. **The plan re-skins the asking; it does not remove it.** *(Ideas C, D.)*

### Challenge 4 — the plan is "honest about the past, silent about the future"
§A.2 (correctly) forbids future-tense copy until B3. But it then under-delivers on the *legitimate*
forward signal the data CAN back. `expiresAt` is on every pending row (`artifacts.ts:151`). "3 חתימות
פגות תוקף בעוד 5 ימים" is **not a fabrication** — it is arithmetic on a stored column. The plan defers ALL
forward-looking copy to B3's notification, when a large slice of it is derivable **today, read-only, no
cron.** Anticipation is being treated as harder than it is. *(Idea E.)*

### Challenge 5 — "the system did X for you" report does not exist anywhere in 41 slices
The single most emotionally load-bearing doctrine sentence — "he opens the app, sees it **already chased,
already sorted, already knows what's left**" (§North-Star, Emotional proof) — has **no slice.** B3 emits
notifications (events), but there is no **"here's what I did since you were last here"** digest. Notifications
are a firehose; a *report* is the system taking credit for its work, which is what produces the "it's
managing this for me" feeling. The `audit_log` already records system actions (the expiry sweep writes
`actor_type='system'` rows, `signature-expiry-sweep.ts:84`). The raw material for "what the system did"
is **already being persisted.** Nobody surfaces it. *(Idea F.)*

---

## PART 2 — INVENT: concrete, buildable mechanisms that raise this to OPTIMAL

Each idea: **the user value · does the data/endpoint exist (honest) · where it slots.**

### IDEA A ⭐ — The Next-Best-Action engine (the "do this next" ranker)
**Value:** the home stops being "5 rows you must read" and becomes "the 3 things to do today, in order,
each with the reason and a one-tap action." This is the single biggest "the system is managing it" lever.
The manager opens the app and the FIRST item is *"פרויקט רחוב הרצל — אורי מדירה 7 לא חתם, נשארה חתימה
אחת לסף. [שלח תזכורת]"* — ranked above 49 other projects because it scored highest.
**Data exists?** YES, almost entirely. The B1 pulse row already carries every input: `stalledDays`
(=now−MAX(signedAt)), `nextExpiryAt` (=MIN(expiresAt WHERE pending)), `signedThisWeek`, and the
share-weighted distance-to-threshold from B0's `ConsentCalcService`. A ranker is a **pure scoring function
over the B1 row** — `score = w1·(closeness to threshold) + w2·(expiry urgency) + w3·(stall length) −
w4·(recently touched)`. No new query, no migration. It slots as a **derivation on top of B1** (a
`rankAttention()` in the same service) + the FE renders the sorted list E2.1 already builds.
**Honesty caveat:** the "recently touched" de-prioritizer needs Idea B's reminder timestamp to be perfect;
without it, rank on the four signals that DO exist and omit the recency term. Still optimal-grade.
**Where it slots:** extend **B1** (Wave 2) with a ranking output; **E2.1** consumes it. Net add: ~1 pure function + tests.

### IDEA B ⭐ — Reminder memory (`reminder_count` + `last_reminded_at`) — the one-column unlock
**Value:** turns the blind chase (Challenge 2) into a system with judgment: *"נזכרת לאורי 3 פעמים — אולי
זמן להתקשר"* (escalation), *"שלחתי תזכורת לפני 6 שעות, אין צורך עוד"* (de-dupe), and it powers the
auto-cadence (B3) honestly. It is the spine under "act on the 95%, hand up the 5%."
**Data exists?** NO — and this is the highest-value gap on this front. `signature_requests` has no reminder
history (`artifacts.ts:150-156`). This is a **single additive migration** (`ADD COLUMN reminder_count int
DEFAULT 0`, `ADD COLUMN last_reminded_at timestamptz`) + an UPDATE in the resend path
(`signature-requests.service.ts` resend) + B3's auto-reminder increments it. Mirror the proven additive
pattern of migration 0063/0065. Gate-6 schema change, but trivially small.
**Where it slots:** a tiny BE slice **before B3** (B3's auto-cadence needs it to not over-nudge), feeding
Ideas A, E, F. This is the cheapest high-leverage thing on the entire creative front.

### IDEA C ⭐ — Auto-drafted campaign by INTENT ("chase everyone who's gone quiet")
**Value:** replaces per-row drudgery and per-project campaign-construction with **bulk-by-intent**: the
home offers *"12 בעלים בכל הפרויקטים לא הגיבו 14 יום — לשלוח לכולם תזכורת? [כן]"*. One approval, system
picks the targets, the document, the message. This is the doctrine's "propose, don't ask" at scale, and
it directly answers the owner's "bulk-by-intent instead of per-row."
**Data exists?** MOSTLY YES. The hard part — *who is an eligible recipient, who's a renter, who has no
phone* — is **already computed** (`signature-requests.service.ts:455-534`, the bulk path returns per-owner
`created/skipped_existing/failed` with reasons `owner_is_renter`/`owner_not_found`/`recipient_not_associated`).
"Gone quiet" = pending requests where `now − createdAt > N days` (or `> last_reminded_at` once Idea B lands).
What's missing: a **cross-project query** that gathers stalled pending requests org-wide, and a thin
**intent→recipient-set resolver** that hands the existing bulk path its owner list. M5's new
preview/dry-run endpoint (`signature-campaign/preview`) is **exactly the foresight surface** this needs —
extend it from per-project to intent-scoped.
**Where it slots:** extend **M5** (preview) + **C17** (bulk verbs, Wave 4) with an intent dimension; surface
the proposal on **E2.1**. The riskiest-feeling action becomes the safest because preview shows the blast radius first.

### IDEA D — "Build the project for you" from parcel (propose the structure, approve once)
**Value:** the new-project moment sets the emotional tone (the plan says so, C5). Instead of a 1468-line
wizard, the system says *"גוש 6941 חלקה 23 — זיהיתי בניין 1, 24 דירות. לבנות? [כן]"* and the manager
approves a pre-built structure he then tweaks. This is "zero-setup, smart defaults" (§North-Star.3) made literal.
**Data exists?** PARTIALLY — and honestly so. The composite commit **already exists**: `parcel-setups`
confirm (`parcel-setups.controller.ts:81`) commits buildings+apartments+ownerships in one transaction
(api-action-map calls it "the closest thing to build-project"). The project has `block/parcel/subparcel`
columns (`schema/projects.ts:72-73`). What does NOT exist is the **data source that proposes the
structure** — that's the GovMap/parcel-lookup provider, which is **owner-deferred to post-prod**
(MEMORY: parcel lookup deferred; `IParcelDataProvider` seam ready, manual entry is the path). So the FULL
auto-build is honestly blocked on an owner decision. BUT the *shape* — "review a proposed structure, approve
once" — can ship over **manual parcel entry** today (the manager types גוש/חלקה + count, system proposes
the apartment grid, he approves). The seam is built; only the auto-populate is gated.
**Where it slots:** re-frame **C5** from "polish the wizard" to "propose-and-approve over `parcel-setups`
confirm"; full auto-populate rides the deferred parcel provider when the owner unblocks it. Honest, buildable, optimal-shaped.

### IDEA E — Anticipatory nudges from `expires_at` (legitimate forward signal, no cron)
**Value:** "אין תנועה" is reactive; **"3 חתימות פגות בעוד 5 ימים — לשלוח להן עכשיו?"** is anticipatory and
is the difference between a status board and a system that watches the clock for you. It catches the stall
*before* it becomes a dead project.
**Data exists?** YES, read-only, today. Every pending request has `expiresAt` (`artifacts.ts:151`). "Expiring
this week" is `WHERE status='pending' AND expires_at < now()+7d` — pure arithmetic, **not** a fabrication,
**not** dependent on B3. The plan defers this to B3's `expiring` notification, but the *read-side* signal
(a home card / a list filter) needs no cron at all. B3 makes it *push*; this makes it *visible now*.
**Honesty caveat:** the COPY must stay present/future-arithmetic ("פגות בעוד 5 ימים"), never "נזכיר שוב
בעוד 5 ימים" (that future-promise stays B3-gated per §A.2). The distinction is the whole game.
**Where it slots:** a derived field on **B1** + a card on **E2.1** + a filter on **E2-list** — all Wave 2, zero new infra.

### IDEA F ⭐ — The "while you were away, I…" digest (the system takes credit)
**Value:** THE wow sentence from the doctrine, made real: open the app → *"מאז ביקורך האחרון: סימנתי 4
בקשות כפגות תוקף, התקבלו 2 חתימות חדשות, פרויקט הרצל חצה את הסף."* This is the system **reporting what it
did** — the strongest possible "it's managing this for me" signal, and it is almost entirely free.
**Data exists?** YES. The `audit_log` already persists system actions with `actor_type='system'`
(`signature-expiry-sweep.ts:84` writes per-org sweep rows; B3 will add notification emissions). "New
signatures since last login" = `signature_requests WHERE signedAt > lastSeenAt`. "Threshold crossings" =
B0's `metThreshold` edge-diff (M3 already computes this client-side). The only missing piece is a
**`last_seen_at` per user** (or reuse the session's last-activity) and a **digest assembler** that reads
the audit + signature deltas since that timestamp. No new event source — it *narrates the events that
already happened.*
**Where it slots:** a small BE digest endpoint after **B3** (so it can include B3's emissions) + a hero
strip on **E2.1**. Fold the "threshold crossed" edge (M3) into it. This is the single most under-valued
idea relative to its cost.

### IDEA G — "Finish this project" coach (guided last-mile)
**Value:** for a project at 90%, the system becomes a closer: *"נשארו 3 חתימות לאישור. אורי (דירה 7),
רחל (דירה 12), משה (דירה 4). [שלח לכולם] · [סמן את משה כמתנגד]."* It turns the abstract "approve" into a
checklist the system maintains. Directly serves "never a dead-end — every problem with its fix"
(§North-Star.7).
**Data exists?** YES. `signatureProgressApartments` (`projects.service.ts:456`) already returns the
per-apartment partial/none status; B4 adds the holdout names; B2 adds "mark as objecting"
(`decline_reason`). `signatureMilestones` (jsonb staged targets, `schema/projects.ts:49`) gives the
intermediate finish-lines. The coach is a **composition of three slices that already exist** into one
guided panel — no new data.
**Where it slots:** a panel on the project board (**E2.2-S3**) that activates above a configurable distance
to threshold; consumes B4 + B2 + milestones. Pure FE composition once those land.

### IDEA H — Auto-triage of the 5% exceptions (objection / no-phone / hard-stuck)
**Value:** the doctrine's "hand up the 5% that need a human." Today nothing *classifies* exceptions — the
manager finds them by scanning. The system should surface a short **"needs your judgment"** lane:
owners with no phone (can't be SMS-chased), owners marked objecting (B2), apartments stalled past N
reminders (Idea B). Each with its specific remedy.
**Data exists?** YES once B2 (objection) + Idea B (reminder count) land. No-phone is **already detected**
in the bulk recipient resolver (the renter/no-phone branch, `signature-requests.service.ts:460-505`).
The classification is a derivation, not new data.
**Where it slots:** a second bucket in **B1**'s pulse (`needsHuman[]` alongside `attention[]`); rendered
as a distinct calm lane on **E2.1**. Reuses B1's query shape.

---

## PART 3 — Patterns to STEAL from best-in-class adjacent products

| Product class | Pattern | How it maps here | Backable? |
|---|---|---|---|
| **CRM (pipeline)** — Pipedrive/HubSpot | "**Your day**" — a ranked action queue, not a list of deals | Idea A: rank the 50 projects into a 3-item to-do | YES (B1 row inputs) |
| **CRM** — Salesforce Einstein | "**Deals at risk**" — predicts stalls from activity velocity | Idea E + B: `expiresAt` + reminder cadence → at-risk flag | PARTIAL (E now; B needs 1 col) |
| **E-sign** — DocuSign/PandaDoc | **Auto-reminder cadences** + "last reminded 2d ago" + bulk send with a recipient preview | Idea B (cadence memory) + C (intent bulk) + M5 (preview) | PARTIAL (B is the missing col) |
| **E-sign** — DocuSign | **"Sent/Delivered/Viewed/Signed" per-recipient funnel** | We have sent/signed/expired; "viewed" needs the public-sign GET to stamp a timestamp | PARTIAL (a `viewed_at` col, like Idea B) |
| **Field-ops** — ServiceTitan/Jobber | **"What changed since yesterday"** activity digest | Idea F: the "while you were away" report off `audit_log` | YES (audit already persists system actions) |
| **Project mgmt** — Linear | **Saved views + smart filters as first-class** | C17 saved views — already planned; promote it | YES (C17) |
| **Collections/AR** — Gaviti/YayPay | **"Chase everyone N days overdue" as a single intent** | Idea C: bulk-by-intent over the stalled set | YES (recipient resolver exists) |
| **Tax/onboarding** — TurboTax | **Coached last-mile** ("3 things left, do this next") | Idea G: finish-the-project coach | YES (progress + B4 + B2) |

The throughline: **best-in-class tools in this shape all sell a RANKED ACTION QUEUE + a CADENCE MEMORY +
a "what I did" report.** This product has the data for all three and the plan names none of them as such.

---

## PART 4 — What the plan got RIGHT (don't break it)

This is not a teardown. The plan's spine is excellent and these creative ideas are **additive layers on
its slices, not replacements:** B0 (correct legal number) is non-negotiable and underpins Idea A's ranking;
B5 (state-machine + concurrency) protects every "approve" the coach (G) will trigger; B3 (cadence) is the
honest engine Idea B feeds; the DO-NOT-FABRICATE register (§A.2) is exactly the discipline that keeps
Ideas E/F honest. **The creative additions ride the certainty gates — they do not bypass them.** The
right sequencing is: ship the four CRITICAL gates as planned, then fold A/B/E/F into B1/B3/E2.1 (they're
mostly derivations on slices already in flight), and re-frame C5 and M5 toward "propose" (D, C).

---

## PART 5 — The optimal delta (what raises adequate → optimal), ranked by leverage/cost

1. **Idea B — reminder memory (`reminder_count`+`last_reminded_at`)** — 1 additive migration; unlocks
   judgment, de-dupe, escalation, honest cadence. Highest leverage/cost ratio on this front. Land before B3.
2. **Idea A — Next-Best-Action ranker** — 1 pure function on the B1 row; turns the home from a list into a
   to-do. The single biggest "it's managing it" lever. Fold into B1.
3. **Idea F — "while you were away" digest** — narrates `audit_log` + signature deltas the system already
   persists; the doctrine's exact wow sentence, nearly free. Fold in after B3.
4. **Idea C — bulk-by-intent campaign** — reuses the existing recipient resolver + M5 preview; bulk
   without drudgery. Extend M5/C17.
5. **Idea E — anticipatory `expires_at` card** — read-only arithmetic, no cron, honest. Fold into B1/E2-list.

Ideas D (propose-the-build), G (finish-coach), H (5%-triage) are strong but ride deferred/later slices
(parcel provider, B4, B2) — sequence them after their dependencies, but **design the slots now** so the
later slices land into a coaching frame instead of bolting on.
