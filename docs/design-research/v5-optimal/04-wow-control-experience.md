# 04 — The "Wow + Control" Experience: active, smart, you-stay-in-control

> **Front:** the emotional/interaction layer of the owner's north star — "the system is the one
> MANAGING, but the CONTROL stays the manager's." This doc designs the concrete UI/interaction
> **primitives** that make proactive automation feel *empowering, not threatening*, and ties each to
> a real slice in `00-FINAL-BUILD-PLAN.md` (or flags a new one).
> **Method:** grounded in the real FE/BE code (cited `file:line`), the build plan, and the doctrine
> (`DESIGN-NORTH-STAR.md`). Author: wow+control seat, 2026-06-18.

---

## 0. Verdict (this front)

**GREEN-with-five-primitives.** The control paradox is *solvable cheaply* because the substrate the
owner needs already exists in three forms most teams have to build from scratch:

1. **The undo engine is already proven** — `apps/web/src/hooks/notifications-optimistic.ts` shows the
   exact pattern (immutable cache transform + a `prev` snapshot that *is* the undo). The build plan
   already says "the `prev` snapshot IS the undo" for M2 (`00-FINAL-BUILD-PLAN.md` Wave 2, M2). Undo is
   a generalization of code that ships today, not new infra.
2. **The autonomy clock is already running** — `apps/worker/src/main.ts:245,274,309` runs 3 cron
   consumers with a clean two-step `registerHandler(...) → boss.schedule(...)` pattern. B3 ("the system
   chases") is *adding a 4th consumer*, not building a scheduler.
3. **The safe-deep-link substrate exists** — `adapters/notification.ts:47 safeInAppLink()` already
   narrows any system-emitted link to a relative in-app path. Every "why did the system do this → tap
   to see" explain-chip rides this.

**But the experience layer that turns those into a *feeling* does not exist yet.** Concretely:
the app has **no Toast / no ConfirmDialog / no live-region primitive** (confirmed: a full-tree search
for `*Toast*`/`*Confirm*`/`*live-region*` returns nothing; the only "toast" is a bespoke inline
`<p role="status">` hand-rolled inside `signature-campaign-action.tsx:140-154`). The board **returns
bare `null` on error** (`signature-progress-board.tsx:36`), which reads as "the system died silently" —
the *opposite* of "it's got my back." And **every smart action today is invisible**: the campaign toast
shows `{created, skipped}` and *discards the `failed` count the backend computed*
(`signature-campaign-action.tsx:48`). The wow+control layer is **five primitives** built on the
existing substrate (§2), homed almost entirely in slices the plan already has (§6).

The trap to design against is explicit in the mandate and I'll keep returning to it: **an active system
that hides control = scary.** The single rule that prevents it: **nothing irreversible happens silently,
and everything reversible happens in the open with a visible, named, undoable trail.**

---

## 1. The control paradox — the core principle, stated as a law

> A system feels *empowering* when it does the work **but the manager can always (a) see what it's
> about to do, (b) see what it just did and why, (c) stop or reverse it, and (d) trust that the one
> thing he can't reverse never fires without his explicit tap.**

This collapses to a **two-track action model** — every system action is classified into exactly one of
two tracks, and the track dictates the entire UX:

| Track | Definition | UX contract | Examples (real endpoints) |
|---|---|---|---|
| **Reversible (the 95%)** | No external side effect the manager can't take back; or the side effect is itself idempotent/re-sendable. | **Optimistic + undo-toast. NEVER a confirm dialog.** Fire instantly, show "✓ done · בטל", undo restores the `prev` snapshot. | resend reminder (`signature-requests/:id/resend` `:142`), archive project (`projects/:id` DELETE `:104` — `archivedAt`, D.1 soft-delete), mark-read, status change (post-B5 guard), assign agent. |
| **Irreversible (the 5%)** | A real-world effect that can't be unwound: an SMS fired to 40 phones; a crypto-shred; a legal-state mark. | **Preview → ONE justified confirm → narrated result.** Show *exactly* who/what is affected BEFORE the tap. After, show the full tally including failures. | campaign send (`signature-campaign.controller.ts:32` — texts real people), RTBF erase (`owners/:id/erase` `:139`), `approved` status transition (legal filing basis). |

**Why this is the right cut (not merely adequate):** the doctrine says "undo over confirm" (principle
6) AND "the only routine confirm that survives is campaign send" (M5). Those two are in tension unless
you have a *rule* for which is which. The reversible/irreversible cut IS that rule. It also kills the
"confirm-dialog fatigue" failure mode that makes technophobic users stop reading dialogs (and then a
real RTBF confirm gets click-throughed). **One confirm the user always reads beats ten he's learned to
dismiss.**

> **GAP-W1 (fold into Wave 0 doctrine + M0+G6):** the two-track classification must be written into
> the slice DoD as a checklist item — "every new action declares its track; reversible actions get an
> undo-toast and MUST NOT get a confirm dialog." Today there is no such rule and the campaign action
> hand-rolls its own feedback. Without the rule, each slice re-invents (badly) and the confirm-count
> creeps back up.

---

## 2. The five primitives (the buildable core)

These five components ARE the wow+control layer. Each is grounded in existing code and homed in a slice.

### Primitive 1 — **The Action Queue / "what's queued" panel** (the see-before-it-happens affordance)

**The fear it kills:** "the system is doing things behind my back and I don't know what." The antidote
is not *less* automation — it's **making the automation's plan visible and pausable.**

**What it is:** a small, always-reachable panel (topbar, next to the bell) titled **"מה המערכת מתכננת"**
("what the system plans"). It lists the *upcoming* automated actions on a calm timeline:
- "מחר ב-9:00 — אזכיר ל-3 בעלים שטרם חתמו בפרויקט רוטשילד" (tomorrow 9am — I'll remind 3 unsigned owners)
- "בעוד 4 ימים — קישור החתימה של דירה 7 פג; אשלח תזכורת יום לפני" (in 4 days — apt-7's link expires; I'll remind the day before)

Each row has **one control: a pause toggle** ("השהה"). Pausing is itself reversible (un-pause). The
panel is the *single screen that makes "act in the background" (doctrine principle 2) feel like
delegation, not loss of control* — because the manager can watch the queue and veto any item before it
fires.

**Grounding / feasibility:** this is a **read over the same state the B3 consumer reads** — the cron
consumer (`00-FINAL-BUILD-PLAN.md` Wave 3, B3) computes "which requests are pending/expiring/stalled" to
decide what to chase; the queue panel renders *that same computation* a tick early as "here's what I'll
do." So B3 should emit, alongside the action, a **"planned actions" projection** the panel reads. The
pause toggle writes a per-project or per-org `automation_paused` flag the consumer checks before
emitting (the consumer already runs `withTenant`/`withProvider` per `00` B3 spec — the flag read is one
predicate). **This is the inverse of the DO-NOT-FABRICATE register (`00` A.2):** the register forbids
faking "I'll remind in N days" *until B3 ships*; the queue panel is the honest, B3-backed surface that
*finally lets that copy be true* — and adds the control (pause) that makes it safe.

**New work flagged → GAP-W2:** B3 as scoped emits notifications *after* acting. Add a thin **`GET
/api/v1/org/automation-plan`** read (the consumer's decision projection, no migration) + the panel +
the pause flag. Small BE add; home for it = **extend B3** (it already touches the consumer + a new
read). Until B3, the panel shows only the honest manual-reminder history (past tense), never a future
claim.

### Primitive 2 — **The Explain-Chip** (trust through transparency — "why did it do that?")

**The fear it kills:** "I don't understand why it sent that, so I don't trust it."

**What it is:** every system-originated row (a sent reminder, a queued action, a notification) carries a
tiny **"למה?"** ("why?") chip. Tapping it expands one plain-Hebrew sentence in the assistant's voice
(doctrine principle 5):

> **"הצעתי לשלוח לאורי כי עברו 5 ימים בלי תגובה והקישור פג בעוד 3 ימים."**
> (I suggested texting Uri because 5 days passed with no response and the link expires in 3 days.)

The chip is **never a modal** — it's an inline `<details>`/disclosure (progressive disclosure, principle
1: "power underneath, calm on top"). It cites the *real signals* that triggered the decision:
`stalledDays` (days since last signature), `nextExpiryAt` (the soonest pending link expiry) — **both of
which B1's `ProjectPulseRow` already defines on the wire** (`00` Wave 2, B1: "`ProjectPulseRow` carries
`lastSignatureAt`, `signedThisWeek`, `stalledDays`, `nextExpiryAt`"). So the explain-chip has **zero new
backend cost** — it's a presentation of pulse fields the plan already pins.

**Grounding / feasibility:** the deep-link target inside the chip ("→ ראה את דירה 7") rides
`adapters/notification.ts:47 safeInAppLink()` (already exists). The "why" *text* is an i18n template fed
by pulse numbers — a pure `format.ts` function, the same shape as the existing `formatRelative`
(`00` P-TZ-1). **The discipline (binding):** the chip must cite signals the backend *actually emitted*,
never invent a reason. This is the doctrine's "never fake a signal" applied to *explanations* — and it's
why the explain-chip can only show reasons B1/B3 truly computed. A chip that fabricates a reason is
worse than no chip; it teaches the manager the explanations are theater.

**Home:** the explain-chip is the *connective tissue* of the autonomy story. Build the primitive in
**M2** (the chase loop — the first action that needs a "why" next to it), generalize it in **B3** (every
queued/fired auto-action gets one), and reuse it in **E2.1** (the home action cards).

### Primitive 3 — **The Undo-Toast** (reversible-by-default, the anxiety eliminator)

**The fear it kills:** "if I tap the wrong thing I've made an irreversible mistake." For a technophobic
יזם this is *the* paralysis. Undo-over-confirm is the cure (doctrine principle 6).

**What it is:** the app-root live-region (`00` M0+G6) renders an **ActionToast** that, for every
reversible action, shows:

> **✓ נשלחה תזכורת לאורי** · **בטל** *(undo — auto-dismisses in ~6s, pause-on-hover)*

Tapping **בטל** restores the optimistic `prev` snapshot and (where the server already acted) fires the
compensating call. The toast is the *settle* surface too: if the server later disagrees (e.g. a 409
`recipient_not_associated`, `00` M2), the *same toast region* updates in place — "לא ניתן לשלוח לאורי
— הוא כבר לא משויך לדירה" — so success and failure share one calm channel.

**Grounding / feasibility — this is the strongest "puzzle not rebuild" case on this front:**
- The **optimistic transform + `prev` snapshot** pattern already ships in
  `apps/web/src/hooks/notifications-optimistic.ts` (immutable `applyMarkRead` / `applyMarkAllRead`,
  with the comment "a re-applied or double-fired mutation is a no-op"). Undo is the *inverse* transform
  over the same `prev`.
- **Idempotency** for the redo/compensate is already wired: `apiClient.postIdempotent` auto-mints an
  Idempotency-Key (used by `createSignatureRequest` `:98` and the campaign `:131`). So undo→redo can't
  double-fire.
- The **live-region** the toast lives in is *explicitly* M0+G6 in the plan: "ONE app-root
  `role=status aria-live=polite` region that is BOTH the `ActionToast` (auto-dismiss, pause-on-hover,
  undo, concurrent `settle`) AND the a11y G6 region" (`00` Wave 0, M0+G6). **The plan already named
  this primitive — this doc is specifying its behavior contract.**

**Home:** **M0+G6** (build the primitive) → **M2** (first real undo: resend). The plan's M2 line already
says "optimistic; `prev` snapshot IS the undo" — this doc just adds the *toast surface* and the
two-track rule that says resend gets undo, NOT a confirm.

### Primitive 4 — **The Calm-Home reward** (the emotional payoff — "it already handled it")

**The feeling it creates:** open the app → see that it *already chased, already sorted, already knows
what's left* → relief. This is the doctrine's emotional target verbatim (`DESIGN-NORTH-STAR.md:34-37`).

**What it is:** the home (`00` E2.1) replaces the cold 4-KPI grid (today: `manager-home.tsx:93-105`,
four `card`s of bare numbers wired to `/org/stats`) and the **dead calendar stub**
(`manager-home.tsx:115-139`, which the plan deletes) with:
1. **A greeting + one pulse sentence** in plain Hebrew: *"בוקר טוב. הכול רגוע — אין מה לעשות עכשיו."*
   (Good morning. All calm — nothing to do right now.) The **"all calm" empty state is the reward**: a
   manager who opens to *zero* action cards because the system handled everything overnight is the
   single most powerful wow this product can deliver. **Design the empty/calm state as a feature, not a
   void.**
2. **~5 ranked ActionCards** — only the projects that *need a human* now, each pre-loaded with the one
   tap (a `<RemindHoldoutButton>`, `00` M2) and an explain-chip (Primitive 2). Triage-by-exception
   (doctrine principle 3): never a dump of all N projects.
3. **A quiet "what I did" line** under the greeting: *"אתמול שלחתי 4 תזכורות. 2 בעלים חתמו מאז."*
   (Yesterday I sent 4 reminders. 2 owners signed since.) — past tense, B3-backed, honest.

**Grounding / feasibility:** E2.1 is already the slice that "delete the calendar stub… greeting + one
pulse sentence + ~5 ranked ActionCards" (`00` Wave 2, E2.1). The pulse sentence reads B1's `buckets`
(`{active, pastThreshold, inWork, stuck}`) and `attention` rows (`00` B1). **The redesign already plans
the structure; this doc adds the *emotional framing*:** the calm empty-state as the hero, the "what I
did" past-tense line as the trust-builder, and the rule that the home *leads with relief, not work.*

**Home:** **E2.1** (structure exists in plan) — fold in the calm-state-as-reward + the "what I did" line
(B3-gated; until B3, omit the line per `00` A.2, never fake it).

### Primitive 5 — **The Failure-Grace pattern** (never a dead-end)

**The fear it kills:** "something broke and now I'm stuck and it's my fault." Doctrine principle 7:
"never a dead-end — every problem shown WITH its fix."

**What it is:** three concrete failure surfaces, each turned from a dead-end into a one-tap recovery:

1. **The board never returns `null`.** Today `signature-progress-board.tsx:36` returns bare `null` on
   error — the manager sees *nothing* and assumes the worst. Replace with the `<DataState>` contract
   (`00` Wave 0, C2: "Kill 'silent null on error'… `signature-progress-board.tsx` returns bare `null` —
   confirmed"): a calm "לא הצלחתי לטעון את הלוח · נסה שוב" with a retry tap. **The plan already names
   this exact file** — this doc elevates it from a C2 cleanup to a *trust-critical* fix: a silent board
   is the most "the system abandoned me" moment in the product.
2. **A down provider is a calm queue, not an error.** When SMS/email delivery fails on a reminder, the
   undo-toast (Primitive 3) settles to: *"לא הצלחתי לשלוח כרגע לאורי — אנסה שוב אוטומטית בעוד שעה. [שלח
   עכשיו ידנית]"* (couldn't send now — I'll auto-retry in an hour. [send manually now]). This rides
   B3's consumer retry/drain (the plan folds "job retry/drain" into C12b via N14) — a transient
   failure becomes a *visible promise to retry*, not a wall. **Grounding:** the campaign service already
   computes per-owner `failed` + reason (`signature-requests.service.ts:482-534`, per `00` M5/N7) — the
   failure data exists; we're surfacing it as a calm next-step instead of discarding it (today
   `signature-campaign-action.tsx:48` throws it away).
3. **The campaign "failed" drill-down.** When a fan-out partially fails, the result narration (Primitive
   in M5) shows *"נשלח ל-37 · 3 נכשלו (אין טלפון) · [תקן]"* — the `[תקן]` tap routes to the 3
   phone-less owners. Never report "sent to 40" when 3 silently failed (`00` A.2 inverse: "always
   surface a failure the backend DID detect").

**Home:** **C2** (board `null` fix — named), **M5** (failed-surface + drill-down — named, N7), **B3**
(auto-retry promise). All three already in the plan; this doc binds them under the "never a dead-end"
emotional contract.

---

## 3. The first-five-minutes wow (the empty-org → first "it handled it" arc)

The mandate: the exact first session for a tech-phobic יזם, empty-org → first project → first "the
system handled it" moment. This is where we win or lose him — and the build plan today is **thin here**
(C5 re-skins the 1468-line `projects/new/page.tsx` but the *emotional onboarding* is unspecified).

**The arc, minute by minute:**

| Min | What he sees | The primitive | Grounding / gap |
|---|---|---|---|
| **0:00** | Provider-onboarded login → a home that is **not empty-cold but empty-warm**: *"ברוך הבא. בוא נקים את הפרויקט הראשון — זה לוקח דקה ואני אעשה את רוב העבודה."* One primary button: **"פרויקט ראשון"**. | Calm-Home empty-org variant (Primitive 4) | **GAP-W3:** `00` E2.1 says "Design the empty-org/first-run state distinctly" but doesn't specify the *welcome* arc. Fold the welcome copy + single-CTA here. |
| **0:30** | The wizard (C5) **proposes, doesn't ask**: he types גוש/חלקה, the system pre-fills building/apartment counts from the parcel (the `parcel-setups` confirm flow, `parcel-setups.controller.ts:81`). Every field has a smart default; nothing is a blank he must understand. | "Propose, don't ask" (doctrine 1) + zero-setup (doctrine 3) | The composite "build from parcel" exists but is multi-step (`01-api-action-map.md` G2). **The one-click north star wants a composite transaction** — flag below. |
| **2:00** | Project created. The home now shows **one ActionCard**: *"פרויקט רוטשילד מוכן. 40 דירות. רוצה שאזמין את כולם לחתום? [כן, שלח לכולם]"* | Propose-don't-ask + the ONE justified confirm (campaign, with preview) | M5 preview endpoint (`00` N8) — the preview *is* the "before you fire, here's who" foresight. |
| **2:30** | He taps. The campaign confirm shows the **preview**: *"ישלח ל-38 בעלים · 2 ללא טלפון (אטפל בהם אחר כך)."* He taps שלח. | Irreversible-track confirm + preview (Primitive in M5) | `POST /projects/:id/signature-campaign/preview` (`00` N8, net-new). |
| **3:00** | **The first "it handled it" moment:** the result narrates *"שלחתי ל-38 בעלים. אעדכן אותך כשמישהו חותם — אתה לא צריך לעשות כלום."* The Action Queue (Primitive 1) now shows *"אזכיר אוטומטית את מי שלא חתם בעוד 3 ימים."* | Result narration + Action Queue | The "I'll auto-remind" line is **B3-gated** — until B3, say only "שלחתי ל-38" (honest), no future promise (`00` A.2). |
| **5:00** | He closes the app **relieved**. Nothing else is asked of him. | The emotional payoff | — |

**The single biggest first-five-minutes lever — flag as creative addition (GAP-W4):** the **"build
project from parcel" composite transaction.** Today new-project is 3-5 sequential POSTs
(`01-api-action-map.md` G2: project shell + buildings + apartments + ownerships). For the doctrine's
"one tap, never a multi-step form," the *most* impactful net-new BE work this front can recommend is a
**`POST /projects/build-from-parcel`** that creates project+buildings+apartments in one audited
transaction (the `parcel-setups confirm` already does the commit half — `parcel-setups.controller.ts:81`
— so this is a *wrapper that pre-fills and auto-confirms*, not new domain logic). This turns minute
0:30-2:00 from a wizard into a single "approve this layout?" tap. **It's the difference between the
first session feeling like data-entry and feeling like magic.** Home: **extend C5** (small BE add) or a
new micro-slice **C5b**.

---

## 4. The emotional arc, mapped to primitives

> open → relief → "it's got my back" → confidence

| Beat | Trigger | Primitive that delivers it |
|---|---|---|
| **Open** | Home loads to a calm greeting + ≤5 cards (or "all calm"), never a 200-row dump. | Calm-Home (P4) + triage-by-exception. |
| **Relief** | "All calm" empty-state, OR each card pre-loaded with its one tap — no thinking required. | Calm-Home empty-state-as-reward (P4). |
| **"It's got my back"** | The "what I did" past-tense line + the Action Queue showing what's handled next. He sees the system *working while he was away*. | Action Queue (P1) + "what I did" line (P4, B3-backed). |
| **Confidence** | He taps an action, sees ✓+undo, knows he can't break anything; taps a "why?" and the reason is sound; sees a failure *with* its fix. | Undo-Toast (P3) + Explain-Chip (P2) + Failure-Grace (P5). |

The arc is **circular and compounding:** every session that opens calm and ends with no dead-ends
deepens the confidence, which is what lets him *delegate more* (un-pause more automation in the Action
Queue) — which makes the next open even calmer. **That virtuous loop is the moat** (§5).

---

## 5. Competitive edge — why this beats the יזם's status quo

The יזם today runs signature collection on **spreadsheets + WhatsApp + a lawyer's folder.** Map our
primitives directly against that status quo:

| His pain today | Status-quo "tool" | Our primitive that wins |
|---|---|---|
| "Who hasn't signed? Let me scroll the spreadsheet." | Excel, manually colored | Calm-Home (P4) ranks the stuck ones to the top automatically. |
| "Did I remember to chase Uri? When did I last text him?" | WhatsApp scrollback | Explain-Chip (P2) — `stalledDays` is computed, shown, and *acted on* without him remembering. |
| "I texted the wrong group / texted someone who already signed." | No preview, fire-and-pray | Campaign preview (M5/N8) — "ישלח ל-38, 2 בלי טלפון" before the tap. |
| "Is it past the legal threshold? Let me ask the lawyer." | A phone call, days of latency | Board + threshold celebration (M3), basis-labeled (`00` A.1) — the legal number, live, correct. |
| "I forgot to remind people before the link expired." | His memory | Action Queue (P1) + B3 auto-chase — the clock chases, not him. |
| "I made a mistake in the sheet and didn't notice for a week." | Silent data corruption | Undo-Toast (P3) + the optimistic-concurrency 409 (`00` B5) — mistakes are visible and reversible. |

**The moat is not any single feature — it's the *feeling of delegation with control* that a spreadsheet
structurally cannot provide.** A spreadsheet is 100% manual (no chase) and 0% safe (no undo, no
preview, silent corruption). We are the inverse: the system does the 95%, and the 5% he keeps is the
5% he *wants* (the judgment calls), surfaced one at a time, each reversible. **That is the genuinely
inventive claim: we don't sell "a better spreadsheet," we sell "a junior associate who never forgets,
shows his work, and never does anything you can't undo."**

---

## 6. Slice mapping — where each primitive lands (no orphans)

| Primitive / mechanism | Slice (in `00-FINAL-BUILD-PLAN.md`) | New work flagged |
|---|---|---|
| Two-track action rule (reversible vs irreversible) | **Wave-0 doctrine + DoD checklist** | **GAP-W1** — add the rule to the universal DoD. |
| P1 — Action Queue / "what's queued" + pause | **Extend B3** (Wave 3) | **GAP-W2** — `GET /org/automation-plan` read + pause flag + panel. |
| P2 — Explain-Chip | **M2** (build) → **B3** (generalize) → **E2.1** (reuse) | None new — reads B1 pulse fields + `safeInAppLink` (both exist/planned). |
| P3 — Undo-Toast | **M0+G6** (primitive) → **M2** (first undo) | None new — generalizes `notifications-optimistic.ts`; M0+G6 already specs it. |
| P4 — Calm-Home + empty-state-as-reward + "what I did" line | **E2.1** | **GAP-W3** — empty-org *welcome* arc + calm-state framing (E2.1 says "design distinctly" but not the emotional spec). |
| P5 — Failure-Grace (board null-fix · provider-down queue · campaign failed drill-down) | **C2** (board) · **B3** (retry) · **M5** (failed-surface, N7) | None new — all three named in plan; bind under "never a dead-end". |
| First-five-minutes arc | **E2.1** (welcome) + **C5** (wizard) | **GAP-W3** + **GAP-W4** (`POST /projects/build-from-parcel` composite). |

**Net new work this front recommends:** 4 gaps — W1 (a DoD rule, ~free), W2 (a small read + flag +
panel, extend B3), W3 (emotional framing of E2.1's existing empty-state, FE-only), W4 (a composite
parcel-build wrapper over the existing confirm — the one with the highest wow-per-effort). None require
new domain logic; all ride substrate that exists or is already planned.

---

## 7. The anti-trap audit (designing AGAINST "active = scary")

Five concrete ways an active system becomes threatening, and the primitive that prevents each:

1. **It acts and I don't know.** → Action Queue (P1) shows it *before*; "what I did" line shows it
   *after*. **Never a silent act.**
2. **It acts and I can't stop it.** → Pause toggle (P1) on every queued action; nothing irreversible is
   ever auto-queued (the two-track rule, §1 — auto-chase = resend = reversible; a campaign fan-out is
   never auto-fired, always manager-tapped).
3. **It acted wrong and I can't undo.** → Undo-Toast (P3) on every reversible action; the one
   irreversible class gets a preview + confirm instead (§1).
4. **It acted for a reason I don't understand.** → Explain-Chip (P2), citing only real signals.
5. **It broke and left me stuck.** → Failure-Grace (P5): board never `null`, provider-down becomes a
   retry-promise, failures surface with a fix.

**The binding invariant across all five:** *the manager can always answer "what is it doing, why, and
how do I stop/undo it?" in one tap.* If any new slice introduces an action that can't answer those, it
violates the north star — make that a DoD line (GAP-W1).

---

## 8. Bottom line

The wow+control experience is **buildable as a puzzle, not a rebuild** — the undo engine
(`notifications-optimistic.ts`), the idempotency (`postIdempotent`), the cron substrate
(`worker/src/main.ts` 3 consumers), and the safe-link narrowing (`safeInAppLink`) all exist. The five
primitives (Action Queue · Explain-Chip · Undo-Toast · Calm-Home · Failure-Grace) are homed almost
entirely in slices the plan already has (M0+G6, M2, B1, B3, E2.1, C2, M5), with **four small additions**
(W1-W4) the plan should fold in. The single principle that keeps "active" from becoming "scary" is the
**two-track rule**: reversible actions fire instantly with undo and never a confirm; the rare
irreversible ones get a preview and the one confirm the manager always reads. Build that, and the
manager *feels* the system managing while *knowing* the control is his — which is the entire north star.
