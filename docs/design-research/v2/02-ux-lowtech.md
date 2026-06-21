# 02 — UX for the Low-Tech יזם (v2, depth pass)

> **Second-pass, code-grounded.** Supersedes `docs/design-research/02-ux-low-tech.md`,
> which was a strong *theory* derived from the brief + E1 findings but never
> opened the real screens. This pass READ the actual `.tsx` for every screen the
> developer touches, traces each anxiety claim to a file + line, and corrects /
> sharpens where the code differs from what the v1 doc assumed.
> Companion to `docs/DESIGN-NORTH-STAR.md`. Owner-decisions flagged inline + collected in §11.
>
> **Role of the author:** UX-for-low-tech-users specialist. The persona is an
> anxious, non-technical real-estate developer (יזם) on his phone between
> meetings. Everything below is downstream of removing his one fear — *"I'll
> press the wrong thing and look stupid / lose a deal"* — and replacing it with
> *"the app already did the thinking; I just confirm."*

---

## 0. What changed from v1 (so the synthesis step can trust this)

The v1 doc is **directionally correct and still worth reading** for its copy
system (§5) and wow-moment list (§7). But it asserted several things as *facts
about the current app* that the code contradicts or complicates. The corrections
below are the load-bearing delta:

| v1 claim | Reality in the code | Why it matters |
|---|---|---|
| "The signature board is **buried as the 4th tab**." | TRUE, and worse: the project page **opens on `tab: 'tenants'`** (`project-detail.client.tsx:79` `useState<TabId>('tenants')`), which is an **empty CTA card**, not data. The board is on `tab: 'dashboard'`, the **4th** tab. | The first thing the developer sees on his most important screen is a "go to buildings" chore, not his signature status. |
| "Home is a vanity dashboard." | TRUE for **managers** (`manager-home.tsx`: 4 cold KPI cards + a **calendar empty-state stub** + a conversations panel). The **agent** home (`agent-home.tsx`) is *better* — it's already a 3-list "my work" triage. | The redesign target (triage) **already exists for one role**. Use AgentHome's shape as the proven internal precedent, not just the tenant portal. |
| "Calendar 'coming soon' stub + test-chat on the home — KILL them." | Calendar stub is STILL THERE (`manager-home.tsx:115-139`, `calendar.empty` + `calendar.comingHint`). The test-chat was **already replaced** by live `HomeConversations` (`manager-home.tsx:155`). | v1's "remove test-chat" is done; don't re-flag it. The calendar stub on the home is the **live** anti-pattern. |
| "New signature request: pre-select all unsigned owners, pre-fill copy (sensible defaults)." | The `/signature-requests/new` form is **one document → one owner**, both empty `<select>`s, zero defaults (`signature-requests/new/page.tsx:21-22`). The **campaign** ("fan out to ALL owners") is a *different*, buried control inside the project dashboard tab (`signature-campaign-action.tsx`). | Two separate send paths exist, neither defaulted; the "already thought for you" campaign is real but hidden, and the per-owner one is a raw form. |
| "The chase loop is identical from every surface." | There is **no chase loop today.** The signatures list (`signature-requests-list.client.tsx`) shows status pills + dates with **no owner name, no document name, no action** — you can't tell *who* hasn't signed or *do* anything from it. | The single most important interaction for this user **does not exist as a loop**; it's a read-only opaque list. This is the biggest gap, bigger than v1 implied. |
| "Confirm dialogs train fear; replace with undo." | The app uses a **styled `useConfirm` dialog** (`project-detail.client.tsx:77,102`) for archive — already migrated off native `window.confirm` (BACKLOG F-1 in flight). | The fix is partly underway; the remaining work is *which* actions deserve a dialog at all, not *how* the dialog looks. |

**Net:** the v1 emotional thesis holds, but the redesign has a **better internal
precedent than v1 found (AgentHome)** and a **worse gap than v1 named (no chase
loop, anonymous signatures list)**.

---

## 1. The persona, re-anchored (kept from v1, sharpened)

A יזם who knows תמ"א 38 / פינוי-בינוי cold and software not at all. 4–20 projects,
each with dozens of owners. On his phone, in a parking lot, 20 seconds of
attention. His fear is **mis-tap + loss + looking incompetent**, not task
difficulty. The emotional win is **relief**: "I see where I stand and what to do
today, and the app already chewed it for me."

**Two proven "good" references already in the codebase** (use both, not just the portal):

1. **The tenant portal** (`portal/page.tsx`) — personal greeting (`hero.greeting`
   with `firstName`), one hero, one clear status, plain sections, an **aggregate
   progress bar with a sentence** (`progress.summary` → "X מתוך Y · Z%",
   `portal/page.tsx:437-443`). This is the calm-on-top reference.
2. **AgentHome** (`agent-home.tsx`) — already a **triage-by-list** home: "my
   projects / my tasks / my notifications", each a 5-item list with a "view all"
   escape hatch (`HOME_LIMIT = 5`, `agent-home.tsx:43`). It is structurally the
   thing the North Star wants the *manager* home to become. The manager just got
   the worse (KPI-grid) treatment.

> **Design instruction:** the manager home should converge toward AgentHome's
> *shape* (ranked lists, capped at ~5, "view all" tap-down) and the tenant
> portal's *voice* (greeting + sentence-first status), not toward a denser KPI
> grid.

---

## 2. Cognitive-load + anxiety audit, screen by screen (grounded)

Each screen: **what he sees first**, **the anxiety it creates**, **the file/line
evidence**, **the calm fix**. Severity is from the low-tech persona's POV.

### 2.1 Manager Home — `manager-home.tsx` · **anxiety: HIGH**

**What he sees first:** four cold metric cards — `פרויקטים פעילים`, `דיירים`,
`חתימות שהתקבלו`, `ממתינות` (`manager-home.tsx:54-79`) — each a big bold number
(`text-2xl font-bold`), then a **big empty calendar block** that says "coming
soon" (`calendar.empty` + `calendar.comingHint`, lines 126-138), then a
conversations panel.

**Anxiety mechanism:**
- **Numbers without a verb.** "47 ממתינות" — *47 what? do I do something? is that
  bad?* The North Star's exact anti-pattern (metrics-soup, no action). The number
  is the headline; nothing tells him what to *do*.
- **A dead feature on the most important screen.** The calendar empty-state on the
  home reads, to a fearful non-technical user, as *"this app is half-built — can I
  trust it with my deals?"* (North Star "What this is NOT": no stub on a primary
  screen). This is the single worst trust-leak in the app today, because it's on
  screen #1.
- **`—` fallback on failure** (`fmt` returns `kpi.placeholder` = "—",
  `manager-home.tsx:51-52`): when `/org/stats` fails, all four cards show "—" with
  no explanation. He reads "—" as *broken*, not *couldn't load*.

**Calm fix:**
- Replace the KPI grid with **one pulse sentence** + a **ranked "needs you now"
  list** (AgentHome's shape, manager-scoped). Data feasibility (§04) confirms the
  pulse buckets are **DERIVABLE today** from `ProjectListItem` stats + the
  `signature-progress` endpoint; the one new endpoint (`/org/signature-pulse`) is
  no-migration.
- **Delete the calendar stub from the home entirely** (ship-or-hide). The calendar
  data (`tasks.due_at`/`scheduled_at`) exists (§04 #10) but a *populated* calendar
  is a later slice; an *empty* one must not sit on screen #1.
- On stats failure show a calm line ("רגע, לא הצלחנו למשוך את הנתונים — ננסה שוב"),
  never bare "—".

### 2.2 Projects list — `projects-list.client.tsx` · **anxiety: MEDIUM**

**What he sees first:** a filters bar (search + cards/table toggle + "פרויקט חדש"),
then a hint line `dataPendingHint`, then a grid of cards. Each card shows name +
status badge + `type · createdRelative` + a **3-column grid where 2 of 3 cells are
"—"** (`column.gushHelka` = "—", `column.units` = count or "—", `column.signatures`
= ratio or "—", lines 246-289).

**Anxiety mechanism:**
- **A wall of "—".** The card *looks* like it should have data and mostly shows
  dashes. To a non-technical user, "—" is indistinguishable from "missing /
  broken." The code even ships a `dataPendingHint` line (line 199-201) admitting
  this — a developer-facing apology rendered to the end user.
- **`גוש/חלקה` is always "—"** (hard-coded, line 261) even though §04 says parcel
  fields *are* on the project wire (`block`/`parcel`, used in
  `RenewalDetailsSection`). So the list under-shows data that the detail page has.
- **Search is a lie of capability.** It filters only the **current 25-row page**
  client-side (`filteredItems`, lines 69-79) — at 20+ projects across pages, a
  search that returns "no results" for a project on page 2 will make him think the
  project is **gone**. Maximum anxiety: *"where did my project go?"*

**Calm fix:**
- **Drop every "—".** §04 #3 confirms `signaturesSignedCount` / `signaturesPendingCount`
  / `unitsCount` are **already on every list row** (one round-trip, no N+1). Render
  the **count vs threshold as a sentence + a bar**, not a raw ratio in a dash-filled
  grid. The 3-cell "—" grid is the most fixable anxiety in the app — the data is
  already in the response.
- **Sentence-first card:** "כמעט שם · חסרה חתימה אחת" (small: "11 מתוך 12") over a
  threshold-marked bar — not `name · type · 11/12`.
- **Make search honest**: either server-side search (a BE slice) or, until then,
  label it "סינון בעמוד הזה" and never let a paged-out project read as deleted.
- This is the **all-projects "full power" surface** (North Star depth-3); it's
  allowed to be denser than the home, but it must not *lie* (search) or *look
  broken* (dashes).

### 2.3 Project detail — `project-detail.client.tsx` · **anxiety: VERY HIGH**

This is the developer's primary workspace, and it is the most anxiety-inducing
screen because of **what it opens on**.

**What he sees first:** a header card (icon + name + status badge + a **3-col KPI
strip where "contractor" is always "—"**, lines 182-217), then **4 tabs**, and the
**default tab is `tenants`** (`useState('tenants')`, line 79) — which renders an
**empty CTA**: an icon, a title, a hint, and a "go to buildings" button
(`TabEmptyCta`, lines 264-277). His signature status — the entire reason the
product exists — is on the **4th tab** (`dashboard`), behind two clicks of
attention.

**Anxiety mechanism:**
- **First impression = a blank + a chore.** He opens "his" project and the app says,
  in effect, "there's nothing here, go set up buildings." For a project mid-campaign
  this reads as *"did I lose my data?"* — exactly the v1 anti-pattern, confirmed at
  the line level.
- **The board is two layers down AND silent on error.** `SignatureProgressBoard`
  returns `null` on error or empty (`signature-progress-board.tsx:36`). So on the
  one tab that matters, a load failure shows *nothing* — the most disorienting
  possible state for a fearful user (is it loading? empty? broken?).
- **Contractor "—" in the header KPI** (line 191, hard-coded "—") — a permanent dash
  in the most prominent strip.
- **The `dashboard` tab is overloaded** once you reach it: progress board +
  per-apartment drill + document upload + campaign action + a second progress bar +
  renewal details + buildings CTA + assignments CTA + shares CTA + archive (lines
  300-427). It violates the 3-depth rule hard — it's a **dumping ground** of every
  secondary action, all equally loud.

**Calm fix (this is E2.2, the highest-value slice):**
- **Open on the board.** Default tab = the signature overview. The board IS the
  page (North Star + v1 agree; the code proves it's not done).
- **The board must never be silent.** Replace the `return null` on error/empty with
  a calm line ("עוד לא יצאו בקשות חתימה — בוא נשלח את הראשונה") so the most important
  panel always says *something*.
- **Sentence headline, not a ratio.** Today the board renders
  "X מתוך Y דירות הסכימו · Z% · יעד W%" (`board.summary`, good!) — keep the sentence,
  add the **finish-line phrase** ("כמעט שם · חסרה חתימה אחת") and the **momentum**
  ("זז יפה · +2 השבוע", DERIVABLE per §04 #5) above the bar.
- **Demote the dumping ground.** Buildings / assignments / shares / renewal-details /
  archive are *settings*, not finish-the-day work. Collapse them under one quiet
  "ניהול הפרויקט" / "עריכת פרטים" section, not 4 equally-weighted CTA cards.
- **"מי תקוע" (who's stuck)** is the heart of this page and **does not exist yet**.
  The per-apartment drill (`SignatureProgressApartments`) has consented/partial/none
  per apartment (§04 #8, no PII) — promote it to a named "needs-you" list, not a
  collapsed drawer under the board.

### 2.4 Signature-requests list — `signature-requests-list.client.tsx` · **anxiety: HIGH (and the biggest functional gap)**

**What he sees first:** a status-filter row (all/pending/signed/cancelled) and a
list of rows. **Each row shows only a status badge + relative dates** — "ממתין ·
נוצר לפני 3 ימים · פג בעוד יומיים" (lines 95-110). **No owner name. No document
name. No apartment. No action.**

**Anxiety mechanism:**
- **This is the chase surface, and it's anonymous.** He cannot answer the only
  question he has — *"who hasn't signed, and what do I do about it?"* — from this
  screen. Every row is an undifferentiated "pending." For a user whose entire job is
  chasing named people, a list that hides the names is functionally useless and
  quietly stressful (he has to click each row to find out who it is).
- **No verb anywhere.** The North Star rule "every status carries a verb and a name"
  is violated completely here — there's neither.

**Calm fix:**
- This list should be the **chase loop's home**: each row = "אורי כהן · דירה 7 ·
  לא הגיב 12 יום" + an inline **`שלח תזכורת`** button. Names are PII-gated but the
  owner *name* (not national_id) is already shown elsewhere (owners list,
  `apartmentOwners`) — this is a wiring gap, not a privacy wall.
- Until the BE "why" field lands, **omit** "מתנגד" but **do** show name + apartment +
  days-since-activity (all DERIVABLE, §04 #5/#6/#8).

### 2.5 Owners list — `owners-list.client.tsx` · **anxiety: LOW-MEDIUM**

**What he sees:** a dense table — name · masked identity · apartment count · pending-
signatures pill · "view" link (lines 99-172). This is **the most "appy" / spreadsheet
screen in the dashboard**, and it's deliberately so ("dense management table",
comment line 99).

**Anxiety mechanism:**
- For the low-tech persona, a 5-column table with `font-mono` masked IDs and a
  numeric pill is the "cold database to be browsed" the North Star warns against —
  but this screen is a **legitimate power surface** (depth-3), so density is OK
  *here*. The risk is only if this table's *aesthetic* leaks up to the home/project
  pages.
- Minor: the pending-signatures pill uses `bg-amber-100 text-amber-800` (line 153) —
  the **re-skin palette leak** (see §9). A brand re-skin silently misses it.

**Calm fix:** keep it dense (it's the right depth), but (a) make the pending pill a
tap-to-chase entry into the chase loop, and (b) move it onto tokens so re-skin works.

### 2.6 Tasks list — `tasks-list.client.tsx` · **anxiety: LOW**

Simple list of title + status + due. Fine for depth-3. Note it uses **raw
`bg-red-100`** for priority/overdue pills (lines 78,83) — same palette leak.

### 2.7 Tenant portal — `portal/page.tsx` · **anxiety: LOW (the reference)**

The cited "good" screen, and the code mostly earns it: navy hero, greeting,
apartment card, masked-PII identity block (D.47), an **aggregate progress bar with a
sentence**, documents + signatures sections, each with its own loading/error/empty
state (the `viewState` 4-way switch, lines 86-96).

**What's still imperfect even here** (so the redesign doesn't over-idealize it):
- The hero is **heavy inline-styled** (40px padding, custom gradients, `#fff`
  literals, lines 163-247) — this is exactly the kind of **hard-coded color that
  blocks re-skin** (§9). The "good" reference is itself a re-skin offender.
- The resend control (`onResend`) acts inline with a "נשלח שוב" hint (good — this is
  the closest thing to the chase loop's act-then-confirm pattern in the whole app).
  **Mine this pattern** for the manager-side chase.

### 2.8 Public `/sign/:token` — `sign/[token]/page.tsx` · **anxiety: LOW-MEDIUM (for the *resident*, not the יזם)**

Out of the יזם's daily loop but it's the deal-closing moment, so it matters
emotionally. It's well-built: a 5-stage machine (loading/preview/submitting/done/
invalid), **inline document preview above the signature canvas** (so the resident
reads before signing, lines 292-312), consent notice, anti-enumeration on every
error (everything collapses to one generic "link no longer valid", lines 192-216).

**Low-tech-resident notes:**
- The signature canvas (600×240) on a **phone** is the risk — drawing a signature in
  a tiny landscape box one-handed is hard. Verify the canvas is responsive and
  finger-friendly (not just mouse). This is the one screen a *resident* (even less
  technical than the יזם) must complete alone.
- The "invalid" state is **calm and recovery-oriented** (login + self-resend, lines
  202-215) — a good model for the dashboard's error states.

---

## 3. The progressive-disclosure model (3-depth max, concrete to this codebase)

The North Star says "power underneath, calm on top." Here is the **exact 3-depth
tree** mapped to real routes, with the rule that **a tap goes deeper, never
sideways**.

```
DEPTH 1 — HOME (calm, never grows with N)
  ├─ greeting + one pulse sentence            ← derivable (org-pulse endpoint)
  ├─ "צריך אותך עכשיו" — ~5 ranked cards       ← AgentHome's shape, capped at 5
  │     each: project · count-vs-threshold · momentum · ONE inline action
  └─ "כל הפרויקטים →"                          ← the one tap to full power

DEPTH 2 — PROJECT  (/projects/[id]) — opens on the BOARD
  ├─ headline sentence + threshold bar + momentum
  ├─ "מי תקוע" — named holdouts, each with שלח תזכורת   ← the chase loop lives here
  └─ quiet "ניהול הפרויקט": buildings · owners · docs · settings · archive

  DEPTH 2.5 — drill within the project (still "going deeper", not sideways)
     building → apartment → owner(s) + per-owner signature status

DEPTH 3 — FULL-POWER SURFACES (the "database" views, density allowed)
  ├─ /projects        — searchable/sortable/filterable all-projects list
  ├─ /owners          — the dense management table (already exists, keep)
  ├─ /signature-requests — the chase queue (today anonymous; must gain name+verb)
  └─ /imports /audit /members /settings — admin/utility cluster
```

**Disclosure rules enforced as DoD (sharpened from v1):**
1. **Default-collapsed for advanced.** The project `dashboard` tab's 9 stacked
   panels (§2.3) must collapse to: board + who's-stuck visible; everything else
   under one "ניהול" expander.
2. **One primary action per screen.** Today the project header can show Export +
   Archive + 3 buildings/assignments/shares CTAs simultaneously. Pick one primary
   ("שלח תזכורת" / "המשך"); the rest go quiet.
3. **Tap = deeper, never a modal-in-a-modal.** The campaign action
   (`signature-campaign-action.tsx`) is an inline expandable panel (good — no portal
   modal); keep that pattern, don't introduce drawers-opening-drawers.
4. **The full list is always one obvious tap, never the first thing.** Home → "כל
   הפרויקטים". This already exists in AgentHome's "view all" links — generalize it.

> **Uncertainty flagged:** the project page uses a **4-tab** model
> (tenants/docs/tasks/dashboard) that mirrors a partner design
> (`screens-projects.jsx`). Collapsing to "board-first + quiet management" is a
> **structural** change to a partner-locked layout. **Owner decision (§11):** is the
> 4-tab model load-bearing, or may the redesign replace it with board-first?

---

## 4. Plain-Hebrew, sentence-first copy system (kept from v1, with code-specific targets)

v1's copy system (its §5) is good and I do not rewrite it. I add the **specific
strings in the codebase that violate it today**, so the synthesis has concrete
edit targets:

| Current string / behavior | File | Fix |
|---|---|---|
| `dataPendingHint` (a dev apology shown to users) | `projects-list.client.tsx:200` | Delete it; render real data (§2.2) so no apology is needed. |
| `kpi.placeholder` = "—" everywhere a number fails | `manager-home.tsx`, project header, list cards | Numbers fail → a calm sentence, never "—". |
| `calendar.empty` + `calendar.comingHint` (stub copy on the home) | `manager-home.tsx:132-137` | Remove the whole block. |
| Status pills with no sentence (`statusLabel` alone) | everywhere `<StatusBadge>` is used | Pair every status with a **verb + name** line; the badge is the quiet evidence, not the message. |
| Signatures list rows: dates only, no subject | `signature-requests-list.client.tsx:95-110` | "אורי כהן · דירה 7 · לא הגיב 12 יום" + `שלח תזכורת`. |

**Voice anchors that already exist and are good — reuse them:**
- `portal.progress.summary` (sentence "X מתוך Y · Z%") — the template for every
  count-vs-total line in the app.
- `projects.board.summary` ("X מתוך Y דירות הסכימו") — already sentence-first; extend
  with the finish-line + momentum phrases.
- `hero.greeting` (personal "שלום, {firstName}") — the manager home should greet too.

**Vocabulary lock (CLAUDE.md, verified in code):** דירה (never "unit"/"יחידה"),
בעלים, national_id/תעודת זהות (PII — masked, never in errors), soft-delete verb =
ארכוב. The owners table correctly shows `nationalIdMasked` (`owners-list.client.tsx:140`);
keep that discipline everywhere.

---

## 5. The emotional journey — and exactly where it breaks today

Trace the developer's real session, marking the **break points** with file
evidence. This is the "movie" the North Star asks for.

| Step | What he wants to feel | What the code delivers today | Break? |
|---|---|---|---|
| **Opens the app** | "I see where I stand." | Manager: 4 cold numbers + a "coming soon" calendar. (`manager-home.tsx`) | **BREAK** — no orientation, a dead feature on screen #1. |
| **Scans for what's urgent** | "The app handed me today's work." | Nothing is ranked or triaged for a manager; he must go hunt in `/projects`. | **BREAK** — no triage; he becomes the query engine. |
| **Opens a project** | "Here's our signature status." | Lands on an **empty "go to buildings" tab.** (`project-detail.client.tsx:79`) | **BREAK (worst)** — blank + chore where the answer should be. |
| **Finds the board** | "We're 9 of 12, past the line." | 4th tab; sentence is decent (`board.summary`) but silent on error and buried. | partial — good copy, wrong depth. |
| **Sees who's stuck** | "אורי, דירה 7 hasn't signed." | No named "who's stuck" list; per-apt drill is a collapsed drawer with no names. | **BREAK** — the human "why" is invisible. |
| **Chases a holdout** | "One tap, app keeps nudging." | No inline reminder from any list; the signatures list is anonymous + actionless. | **BREAK** — the core loop doesn't exist. |
| **Crosses the threshold** | "🎉 we made it." | No milestone moment; `metThreshold` exists (§04 #2) but isn't celebrated. | **BREAK** — the emotional peak is unmarked. |
| **Closes the phone** | "Done. I'm on top of it." | He's done a lot of clicking and still isn't sure who's outstanding. | **BREAK** — anxiety, not relief. |

**The journey breaks at 7 of 8 steps.** Crucially, **most breaks are surfacing/
wiring, not new data** (§04: 9 of 13 signals are EXISTS/DERIVABLE). The product
*has* the facts; it just never assembles them into the movie. That's the
opportunity — and it's why this is a design+wiring redesign, not a rebuild.

---

## 6. Per-screen "calm" redesign direction (concrete, actionable)

Condensed, build-ready direction per screen. Each is achievable on today's data
unless flagged NEEDS-BACKEND.

**Home (manager).** Greeting line → one pulse sentence ("12 פעילים · 4 קרובים לסף ·
אחד תקוע") → "צריך אותך עכשיו" list of ≤5 ranked cards (past-threshold > expiring >
stuck-longest > close-to-threshold) → "כל הפרויקטים →". Delete the calendar stub.
Reuse AgentHome's list component. *Needs the `/org/signature-pulse` endpoint (§04 A,
no migration).*

**Project detail.** Default to the board. Headline sentence + threshold-marked bar +
momentum. A named "מי תקוע" list with inline `שלח תזכורת`. Collapse buildings/owners/
docs/assignments/shares/archive under one quiet "ניהול". Board never returns `null` —
always a calm line. *Holdout names = small audited read (§04 #8/#12); rest is EXISTS.*

**Projects list.** Kill all "—": render count-vs-threshold sentence + bar from the
stats already on each row. Surface real גוש/חלקה. Fix or honestly label search.

**Signatures (chase queue).** Add owner name + apartment + days-since-activity +
inline `שלח תזכורת` per row. This converts the app's most useless screen into its
most useful. *Names are PII-gated but already shown elsewhere; this is wiring.*

**Owners.** Keep dense (correct depth). Make the pending-pill a tap-into-chase. Move
off raw Tailwind palette onto tokens.

**Empty / loading / error (cross-cutting).** Skeletons over spinners (the portal's
`SectionSkeleton` is the model). Every empty = a guided first step, never "0 results"
or a `null`. 403 = the proper access-denied component (BACKLOG confirms the
`/settings/roles` pattern exists) — never "failed to load, try again" where retry
won't help.

---

## 7. Low-tech / consumer-grade patterns worth borrowing (which apply, and why)

Best-in-class patterns from consumer + prosumer tools, filtered to *this* anxious
persona. I only list ones that map to a real EMAPP surface.

| Pattern (where it's proven) | Apply to | Why it fits this user |
|---|---|---|
| **"Inbox Zero" / today-list as home** (Things, Todoist, Superhuman) | Manager home | He wants *today's work handed to him*, not a database. AgentHome already half-does this; extend to manager. |
| **Act-then-undo toast** (Gmail "Undo Send", iOS) | Send reminder, archive, mark-followup | Removes the "am I sure?" dialog tax; teaches the app is *safe to touch*. The portal's inline resend (`onResend`) is the seed. |
| **Disabled-with-reason** (Stripe, Linear) | Campaign send with 0 docs, save-until-dirty | Error *prevention* > error message. The campaign action already disables on no-doc (`signature-campaign-action.tsx:119`); add the *reason* + an inline "upload" link. |
| **Segmented progress with a goal marker** (Strava goals, fundraising thermometers) | Project board + list cards | A bar with the **66% threshold marker** turns "9/12" into "past the line" at a glance — the finish-line wow. Data exists (`targetSignaturePct`, `signature_milestones`). |
| **Named, photo-light "who's waiting on you"** (Slack DMs, DocuSign recipients view) | "מי תקוע" + signatures queue | He thinks in *people* ("אורי didn't sign"), not in request-IDs. DocuSign's recipient list is the exact mental model for a signature product. |
| **Pull-to-refresh + skeletons** (every mobile app) | All list pages on phone | Reassures "almost there" vs "frozen." Portal skeletons are the template. |
| **One-thumb primary action, bottom-trailing** (mobile commerce) | Every card's `שלח תזכורת` | He's one-handed in a parking lot; the action must be in the thumb arc, not top-left. |
| **Quiet celebration, not confetti-spam** (Duolingo *restraint*, Apple Fitness rings) | Threshold-crossed moment | Dignified "עברת את הסף" once, on the real event — not sparkle everywhere (he fears noise). |

**Deliberately NOT borrowed:** dashboard-builder/widget customization (Mixpanel,
Grafana) — the opposite of "the app already decided for you"; command palettes
(too power-user); dense data-grids on the *home* (right for `/owners`, wrong for
depth-1).

---

## 8. The chase loop — spec'd, because it's the missing core (sharpened from v1 §9)

v1 spec'd this well; I keep its shape and pin it to the code gaps. The loop must be
**identical from three surfaces** (home triage card, project "מי תקוע", signatures
queue) — today it exists on **none** of them.

1. **`שלח תזכורת`** acts inline (no dialog — reversible, per-owner, low-stakes).
   Toast: "נשלח לאורי — נזכיר שוב בעוד 3 ימים אם לא יחתום" + `בטל`. Mirror the
   portal's `onResend` mechanics.
2. **App commits to follow-up** (default cadence; he opts out, doesn't schedule).
   "It'll keep nudging for me" = the relief moment.
3. **Escalation offered only when relevant** (call the owner via the audited PII
   reveal; resend with a doc). Never a dead end.
4. **State always legible:** the owner's line flips to "נשלחה תזכורת — ממתין"
   immediately.

**The one place a confirm IS justified:** sending the *campaign* to ALL unsigned
owners (real SMS to real people). The campaign action exists but is buried in the
4th tab and has **no confirm summary** today — add a calm "שליחת בקשת חתימה ל-3
בעלים" + one `שלח`, and keep its existing disabled-on-no-doc (just add the reason +
upload link).

---

## 9. Re-skin readiness (the 5th principle — where the code helps and hurts)

The North Star demands the owner's designer can re-skin via tokens without touching
structure. **Status today: partial — good token foundation, real leaks.**

**Good (real):** `globals.css` is a genuine token source — `--navy-*`, `--success-*`,
`--warning-*`, `--danger-*`, `--text`, `--bg-*`, radii, and a static ratchet
(`app-no-new-inline-colors.spec.ts`) bans new inline hex. Most feature components
consume `var(--…)`.

**Leaks (must fix for the principle to hold) — verified:**
1. **`StatusBadge` bypasses the token ramps.** `status-badge.tsx:20-25` maps to
   **Tailwind defaults** (`bg-amber-100 text-amber-800`, `bg-emerald-100`, `bg-red-100`),
   NOT `--warning/--success/--danger`. Every status pill in the app
   (projects, owners, tasks, signatures, portal) re-skins *wrong* because the ratchet
   checks inline hex, not Tailwind class names. **This is the single highest-leverage
   re-skin fix** — one file, app-wide effect.
2. **Raw `bg-amber-100` / `bg-red-100` / `bg-gray-200` in feature files**
   (`owners-list.client.tsx:153,132`, `tasks-list.client.tsx:78,83`,
   `signature-requests-list.client.tsx:97`) — same leak, scattered.
3. **The tenant portal hero is heavy inline style** (`#fff`, custom gradients, 40px
   literals, `portal/page.tsx:163-247`). The "good reference" is itself a re-skin
   offender.
3b. **The public sign page is entirely off the token path.** `sign/[token]/page.tsx`
   uses raw shadcn/Tailwind utility classes for its buttons and surfaces
   (`bg-primary text-primary-foreground`, `rounded-md border bg-card`,
   `text-destructive` — lines 379–393, 275, 344) instead of the partner `.btn
   .btn-primary` / `.card` token classes. This is the page a **real apartment owner**
   touches to sign; when the owner's designer re-skins `--primary-partner`/`--navy-*`,
   the dashboard moves and this page does **not**. Low-effort, high-symbolism fix: port
   it onto the `.btn`/`.card` classes so the signing surface matches the brand.
4. **No spacing or type scale.** Only `--pad: 16px` exists (`globals.css:106`); sizes
   are ad-hoc literals (`text-[26px]`, `padding: 22`, `text-2xl`). "Generous calm
   whitespace" and "hierarchy via type scale" — both North-Star calm levers — are
   **unbuildable as tokens today.** Add a spacing scale + a Heebo type scale before
   E2.0 ships, or the designer can't tune calm.

> **Owner decision (§11):** the duplicated palette (CSS vars **and** Tailwind hex,
> documented in `globals.css:20-28`) means a re-skin must edit two places. Worth a
> consolidation slice now, or defer? It directly affects how cleanly the designer
> can re-skin.

---

## 10. Mobile / one-handed (the field is the primary surface)

Kept from v1 §8; the code-specific risks:
- **The project page's 4-tab bar** + 9-panel dashboard tab is a lot of horizontal +
  vertical navigation on a phone. Board-first + collapsed management is *also* the
  mobile fix.
- **The signature canvas** (600×240 fixed, `sign/[token]`) — verify it scales and
  takes finger input on a phone; it's the one thing a non-technical *resident* must
  do alone.
- **Tap targets:** the projects-list card is a good big target; the owners table row
  and the signatures list row need ≥44px tap height and a thumb-reachable inline
  action when the chase loop lands.
- **Skeletons, not spinners** on flaky field connections (portal pattern). Never lose
  a half-filled form (the `/sign` and `/signature-requests/new` forms preserve state
  on error — keep that).

---

## 11. Owner decisions surfaced (collected)

1. **Project page structure (blocking E2.2):** the 4-tab model
   (tenants/docs/tasks/dashboard) mirrors a partner design. May the redesign replace
   it with **board-first + quiet management**, or is the 4-tab layout locked? *(My
   strong recommendation: replace — the default-on-empty-tenants-tab is the worst
   anxiety break in the app, §2.3/§5.)*
2. **Consent counting (P0 correctness, from §04/BACKLOG T4):** the board's "X מתוך Y
   דירות הסכימו" counts apartments, ignoring registered ownership-share
   (`ownerships.share_*`, stored, unused) — so the headline % can be *legally wrong*
   for תמ"א/פינוי-בינוי. Confirm the legal rule (heads vs ownership-share vs
   per-building) before the redesign hard-codes a number into the calm headline.
3. **The "why" layer:** "מתנגד" / objection reason has **no backend field** (§04 #7).
   Confirm the smallest slice (one `ADD COLUMN decline_reason` + a manager "סמן
   כמתנגד" action) — until it lands, the redesign **omits** the phrase, never fakes it.
4. **Re-skin debt:** fix the `StatusBadge` token leak + add spacing/type scales as
   part of **E2.0 (design-system foundation)**? And consolidate the duplicated
   palette now or defer? (§9)
5. **Holdout names = PII:** surfacing "אורי, דירה 7" in the chase loop needs a small
   audited owner-status read (§04 #8). Confirm this is in scope for E2.3 (it's the
   difference between an anonymous queue and a real chase).

---

## 12. Source map (every file actually read for this pass)

- Home: `app/[locale]/(dashboard)/page.tsx`, `_components/manager-home.tsx`,
  `_components/agent-home.tsx`.
- Project: `projects/[id]/page.tsx`, `projects/[id]/project-detail.client.tsx`,
  `projects/[id]/_components/signature-progress-board.tsx`,
  `_components/signature-campaign-action.tsx`.
- Lists: `projects/projects-list.client.tsx`, `owners/owners-list.client.tsx`,
  `tasks/tasks-list.client.tsx`,
  `signature-requests/signature-requests-list.client.tsx`,
  `signature-requests/new/page.tsx`.
- Portal + public: `(tenant)/portal/page.tsx`, `sign/[token]/page.tsx`.
- Shell + tokens: `(dashboard)/layout.tsx`, `(dashboard)/_components/sidebar.tsx`,
  `app/globals.css`, `components/ui/status-badge.tsx`.
- Companion docs: `DESIGN-NORTH-STAR.md`, `design-research/00-MASTER-PLAN.md`,
  `design-research/02-ux-low-tech.md`, `design-research/04-data-feasibility.md`,
  `BACKLOG.md`.
