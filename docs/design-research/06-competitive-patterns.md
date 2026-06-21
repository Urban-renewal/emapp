# 06 — Competitive Patterns: what best-in-class analogues already solved

> Product-strategy research for the **E2 redesign** of EMAPP's signature-collection
> spine. Measured against `docs/DESIGN-NORTH-STAR.md` (power+calm, plain Hebrew,
> triage-by-exception, motion + the human "why", re-skinnable). Audience reminder:
> the **יזם** is a domain expert with **low technical ability** — relief, not a
> learning curve.

## How to read this doc
For each analogous category we name the **specific pattern**, what it solves, how
it **maps to EMAPP's spine** (project → buildings → apartments → owners →
signatures, chasing holdouts toward a % threshold), and a blunt **ADOPT / AVOID**
call. The payoff is the [top "steal-this" ideas](#the-steal-this-shortlist) at the
end — the five that earn the "this is exactly what I need" reaction.

EMAPP's spine in one line, so every mapping is concrete:

```
Project ──┬─ target threshold (e.g. 67% / 80% of owners)
          ├─ Building(s) ─ Apartment(s) ─ Owner(s)
          └─ each Owner has a signature state: not-sent · sent · viewed ·
             signed · declined · expired   →  chase the not-signed
```

The job-to-be-done is **not** "manage records." It is: *"Across my many projects,
tell me which one needs me today and which single owner is blocking it — then let
me nudge them in two taps."*

---

## 1. E-signature / document-collection workflow tools
**DocuSign (Rooms + envelopes), PandaDoc, signNow, Dropbox Sign**

These are the *closest* analogue — their entire product is "send a doc to N people
and chase the ones who haven't signed." Steal aggressively here.

### Patterns
- **Recipient status pipeline on the envelope** (DocuSign/PandaDoc). One row per
  signer with a state chip: *Sent → Viewed → Signed* (+ *Declined / Expired*).
  The "Viewed but not Signed" state is the killer signal — it tells you who is
  *aware and stalling* vs who *never saw it*. Two completely different chase moves.
- **One-click "Remind" / "Resend" per recipient**, plus a visible
  *"last reminded 3 days ago"* so you don't over-nudge. PandaDoc auto-reminder
  cadence (every N days until signed or expiry) is a set-and-forget loop.
- **Bulk Send** (DocuSign) — one template, many recipients, one action. Maps
  exactly to "send the consent doc to all owners in this building."
- **Expiry / voiding** with a countdown, surfaced *before* it lapses, not after.
- **Audit trail / certificate of completion** — who signed, when, from where.
  EMAPP already has this discipline (auth audit, RLS) — surface it as *trust*, not
  compliance noise.
- **Signing order / "in-person signing"** — sequential vs parallel routing.

### Maps to EMAPP
- The envelope-recipient table **is** the per-apartment owner signature board
  (E2.2). EMAPP's states already exist; what's missing is the **Viewed-not-Signed**
  distinction surfaced as a first-class triage bucket ("ראו ולא חתמו — 3 בעלים").
- **Remind-per-owner + cadence** is exactly E2.3 (the reminder/expiry/holdout loop)
  — but EMAPP delivers via **SMS OTP** (Israeli provider), not email, which is a
  *better* fit for non-technical owners. Show "תזכורת נשלחה לפני יומיים."
- **Bulk Send → "שלח בקשת חתימה לכל הבעלים בבניין"** (the audit already found this
  campaign CTA exists and works — promote it from buried toggle to primary action).

### ADOPT
- Per-owner state chip with the **Viewed-not-Signed** bucket called out by name.
- Per-owner **Remind** with last-reminded timestamp + an auto-reminder cadence.
- **Bulk send per building/project** as a first-class button, not a hidden toggle.
- A plain-Hebrew **completion certificate** per project ("X מתוך Y חתמו, היעד הושג").

### AVOID
- DocuSign's **drag-to-place signature-field editor** and template-tag grammar —
  far too "appy" for our user; consent docs are fixed templates, not ad-hoc forms.
- PandaDoc's **deal/quote/CPQ surface** — out of scope; it's a sales tool grafted on.
- Multi-step **routing-order designer** UIs — owners sign in parallel; don't import
  sequential-routing complexity nobody needs.

---

## 2. SMB / operator CRMs & pipeline tools
**Pipedrive, monday.com, HubSpot, Close**

These nail "calm dashboards at scale for a non-technical operator juggling many
open things." This is where EMAPP's **home screen** (E2.1) should crib its soul.

### Patterns
- **"What needs you today" as the landing surface** (HubSpot/Close *Today* /
  Pipedrive *Activities*). The home is a **task queue**, not a metrics wall — overdue
  follow-ups and at-risk deals float to the top; the other 200 deals stay quiet.
- **Pipeline health & "rotting" deals** (Pipedrive *rotting* indicator). A deal with
  no activity for N days gets a literal visual rot flag. This is EMAPP's
  *"אין תנועה 18 יום"* — momentum/stuck made visible **per project**.
- **Stage funnel as a calm bar**, not a chart — how many projects in
  *gathering_signatures*, how many *approved*. One glance = portfolio health.
- **Goals / quota progress** (HubSpot) — a single progress arc toward a target.
  Maps 1:1 to the **% threshold** per project.
- **Activity feed as a "movie"** — "+2 השבוע" momentum, last-touch recency. The
  North Star's photo-vs-movie principle is literally Pipedrive's activity timeline.

### Maps to EMAPP
- Home = **triage queue of ~5 projects that need you now** + a short pulse (North
  Star principle 3). Each row: project name, *one plain sentence* ("כמעט שם · חסרה
  חתימה אחת" / "תקוע · 3 בעלים מתנגדים"), a progress arc to threshold, and a
  primary action (nudge / open). The full filterable list is one tap away.
- **Rotting indicator → "no movement in N days"** per project — already a North-Star
  signal; Pipedrive proves the pattern lands with non-technical users.
- **Goal arc → threshold arc** per project (and a portfolio roll-up "12 פרויקטים,
  4 כמעט שם, 2 תקועים").

### ADOPT
- **Today-first home**: exception queue + pulse, not vanity counts. (Directly fixes
  the audited dashboard = "vanity counts + calendar stub + test-chat" problem.)
- **Stuck/rotting flag** with a day count, in plain words.
- A **single threshold progress arc** per project + a portfolio roll-up sentence.
- **Momentum delta** ("+2 השבוע") pulled from the activity timeline.

### AVOID
- **Kanban drag-between-stages boards** (monday/Pipedrive deal board) — powerful but
  busy and "appy"; project status is a controlled enum (D.18), not a free drag. A
  calm **list with status chips** beats a draggable board for this user.
- **Custom-field / pipeline-builder** configurability — monday's superpower is our
  trap; it turns a calm tool into a config project. Ship opinionated defaults.
- **Dashboard-widget galleries** — the user wants *the* view, not to assemble one.

---

## 3. Construction / property / real-estate PM tools
**Procore, Buildium, AppFolio, Northspyre**

These manage **many projects × many units × many stakeholders** — EMAPP's exact
fan-out shape — and they've learned hard lessons about not drowning the operator.

### Patterns
- **Portfolio → property → unit drill-down** (Buildium/AppFolio). The hierarchy is
  navigable but each level shows a **roll-up summary**, not raw children — you see
  "Building A: 8/10 signed" before you ever expand to apartments.
- **Per-unit occupant/owner card** with contact + status + history in one place
  (the tenant card in AppFolio). Maps to EMAPP's owner record done *as a workflow
  object*, not a CRUD form.
- **Stakeholder directory with role + reachability** — phone/SMS one tap from the
  unit. Field reality: you're often calling the holdout, not emailing.
- **Procore's "open items / punch list"** — an exception list of what's incomplete,
  per project, assignable and chase-able. This is literally "which owners haven't
  signed" reframed as a punch list.
- **Status roll-up that aggregates upward** — a red unit turns its building amber
  turns the portfolio tile "needs attention."

### Maps to EMAPP
- **E2.2 project page = Building → Apartment roll-ups**, expand-on-tap. Building row
  shows "8/10 חתמו" and *who's missing*, not a raw apartment dump. (Fixes the
  audited "project opens on an empty residents tab" — open on the signature
  roll-up instead.)
- **Owner card as a workflow object**: status chip, last-contact, *reason if
  declined* (the North-Star "why" layer — **omit until the backend field exists**,
  per the BACKLOG follow-up; never fake it).
- **One-tap SMS to the holdout** from the apartment row — fits the SMS-OTP rail.
- **Upward roll-up colour**: holdout apartment → building "needs attention" →
  project surfaces on the home queue. Wires §3 into §2's exception home.

### ADOPT
- **Roll-up-first hierarchy** (building shows progress + missing, expand for detail).
- **Owner card as a status+history object**, not a form.
- **One-tap contact** the holdout from where you spotted them.

### AVOID
- Procore's **module sprawl** (RFIs, submittals, budgets, scheduling, daily logs) —
  enterprise breadth that would bury our one job. We do *one* spine well.
- **Gantt / critical-path schedulers** — wrong altitude for signature chasing.
- **Per-unit financial ledgers** (Buildium's core) — not our domain.

---

## 4. Field-service / mobile-first operator apps
**ServiceTitan, Jobber, Housecall Pro, route-based dispatch apps**

The יזם is often *on site or in the car*, phone in hand, chasing a holdout. These
apps deliver real power to a non-technical operator on a small screen.

### Patterns
- **"My day" card stack** — big tap targets, one job per card, swipe to act.
  Thumb-reachable primary actions; no dense tables on glass.
- **Tap-to-call / tap-to-text the customer** front and centre on every job card.
- **Status advanced by big buttons** ("On my way → Started → Done"), not dropdowns.
- **Offline-tolerant, optimistic UI** — act now, sync later; the operator never
  waits on a spinner in a parking lot.
- **Notifications that are actionable**, not just informational ("Owner viewed the
  doc — remind now?").

### Maps to EMAPP
- The **home exception queue rendered as a thumb-friendly card stack** on mobile:
  each card = one project that needs you, one plain sentence, one big action.
- **Tap-to-SMS the holdout owner** is the single most-used action — make it a
  primary, thumb-zone button on the owner row (rail: SMS provider already wired).
- **Status via big chips/buttons**, never a fiddly dropdown — matches the controlled
  status enum and the low-tech user.
- **Actionable push/SMS-back**: "אורי צפה במסמך ולא חתם — שלח תזכורת?" with a
  one-tap reminder.

### ADOPT
- **Mobile card-stack home** with big tap targets + one primary action per card.
- **Tap-to-SMS the holdout** as a primary, ever-present action.
- **Optimistic action** on reminders (fire the nudge, confirm async) so it feels
  instant even on a flaky connection.

### AVOID
- **Dispatch maps / route optimisation / crew scheduling** — not our problem; owners
  aren't a route.
- **Heavy offline-sync engines** — the audit shows EMAPP is server-prefetch-fast
  already; a full offline store is over-engineering for this MVP. Optimistic UI on
  the *one* hot action (remind) is enough.
- **GPS/clock-in telemetry** — irrelevant and creepy here.

---

## 5. Inbox / triage patterns
**Superhuman, Linear, Hey, Things**

The *feel* layer: how to make "a lot to do" feel **calm and finished**, with
exception-first surfacing. This is the polish that produces the "wow."

### Patterns
- **Split inbox / exception-first** (Hey *Imbox*, Superhuman *Split Inbox*) — the
  important stuff is pre-separated from the noise. You never triage the firehose.
- **"Inbox Zero" affordance** (Superhuman) — when the queue is clear, you get a
  calm, rewarding empty state ("הכל מטופל · אין מה שדורש אותך עכשיו"), not a blank
  screen that reads as broken.
- **Snooze / "remind me later"** (Superhuman/Things) — defer an item to resurface at
  the right time. Maps to "this owner is on holiday, nudge again next week."
- **Triage triad** (Linear): everything is *what / who / when* — a terse, scannable
  one-liner per item, no chrome. Plain language, high signal-density without
  clutter.
- **Progressive disclosure** (Linear peek → full issue) — a row expands to a panel
  expands to a full page. Power revealed by depth, exactly North-Star principle 1.

### Maps to EMAPP
- Home queue = a **Split-Inbox for projects**: "צריך אותך עכשיו" vs "במעקב" vs
  "רגוע." You triage ~5, not N.
- **Calm empty state** when nothing needs you — a relief moment, on-brand for a
  tool whose emotional target is *relief*. (Crucial: an empty queue is the *goal*,
  not an error.)
- **Snooze a holdout** → resurfaces on the right day; pairs with the reminder
  cadence so the user offloads the "remember to chase Uri" mental load.
- **One-line-per-project** triad: *project · plain status · next action* — the
  North-Star "כמעט שם · חסרה חתימה אחת" sentence is literally Linear's terse row.
- **Tap to peek → tap to open** progressive disclosure across home → project →
  building → owner.

### ADOPT
- **Exception-first split** (needs-you / watching / calm).
- **Rewarding calm empty state** ("הכל מטופל").
- **Snooze a holdout to a date** (offload the mental tickler).
- **One-line triad rows** + **peek-then-open** progressive disclosure.

### AVOID
- **Keyboard-command palette / shortcut-driven everything** (Superhuman's core,
  Linear's `Cmd-K`) — a power-user idiom that *intimidates* our low-tech user. Keep
  it tap-first; a hidden palette can exist for us-the-builders, never as the
  expected path.
- **Dense, information-maximal rows** (Linear at full tilt) — we want *calm*
  density: fewer words, bigger breathing room.

---

## Cross-cutting: re-skinnability (North-Star principle 5)
Every pattern above must land as **token-themed, componentized** units so the
owner's designer can re-skin without touching structure/data/interaction
(`docs/ARCHITECTURE-fe-design-tokens.md`). The reusable primitives this research
implies:

- `StatusChip` (owner signature state — the one component the whole spine reuses)
- `ProgressArc` (threshold progress — project + portfolio roll-up)
- `TriageRow` (one-line triad: entity · plain-Hebrew status · primary action)
- `RollupCard` (building/project summary with expand-on-tap)
- `RemindButton` (per-owner nudge + last-reminded + cadence state)
- `CalmEmptyState` ("הכל מטופל")

If these six are token-driven and composable, every screen in E2.1–E2.3 is a
re-arrangement of the same vocabulary — calm, consistent, and re-skinnable.

---

## The "steal-this" shortlist
The five moves that make a developer open the screen and say *"this is exactly
what I need."* Each is proven in a best-in-class analogue, maps cleanly to the
spine, and fits a low-tech user.

### ⭐ 1. The "needs you today" project queue (steal from Pipedrive + Superhuman Split Inbox)
The home is **not** a dashboard. It's ~5 project cards that need you now, each a
one-line plain-Hebrew triad — *"רחוב הרצל 5 · כמעט שם, חסרה חתימה אחת · שלח
תזכורת"* — plus a calm "הכל מטופל" when the queue is empty. Everything else
(portfolio pulse, full searchable list) is one tap deeper. **This is the single
biggest leap from the audited dashboard** (vanity counts + calendar stub + test
chat) and the embodiment of triage-by-exception.

### ⭐ 2. The "Viewed-not-Signed" holdout bucket + one-tap nudge (steal from DocuSign/PandaDoc)
Surface the **aware-but-stalling** owners as their own bucket — *"3 בעלים ראו
ולא חתמו"* — distinct from "never saw it." Each gets a thumb-zone **Remind**
button over the SMS rail with a *"תזכורת נשלחה לפני יומיים"* guard. This is the
exact moment the manager has been doing in his head; the app does the thinking and
hands him the one action. The Viewed-not-Signed distinction is what makes it feel
*smart*, not just a list.

### ⭐ 3. Roll-up-first project page that opens on the signature board (steal from Buildium/AppFolio + Procore punch list)
The project opens on **"who's signed / who's missing,"** rolled up per building
("בניין א' · 8 מתוך 10 · חסרים: אורי דירה 7, ..."), expand-on-tap to apartments
and owners. Directly fixes the audited "opens on an empty residents tab,
signature board buried as the 4th tab." The hierarchy carries a roll-up summary at
every level so the manager never drowns in raw children.

### ⭐ 4. The "movie, not photo" momentum line (steal from Pipedrive rotting + activity timeline)
Every project carries a **plain-Hebrew motion sentence** — *"זז יפה, +2 השבוע"* or
*"אין תנועה 18 יום"* — and the day-count rot flag floats stalled projects up the
queue. This is North-Star principle 4 made concrete with a pattern non-technical
users already understand from CRMs. (The human "why" — *who's* blocking and *why* —
layers on **only when the backend objection field exists**; omit until then, never
fake it.)

### ⭐ 5. Snooze-the-holdout (steal from Superhuman/Things)
Let the manager **defer an owner to a date** — *"אורי בחו"ל, הזכר לי בעוד שבוע"* —
which resurfaces the nudge at the right time and pairs with an auto-reminder
cadence. It offloads the "remember to chase Uri next Tuesday" tickler from the
manager's head into the app. Small feature, disproportionate relief — exactly the
emotional target.

---

## What we are explicitly NOT borrowing (the discipline list)
So the redesign stays calm, these tempting-but-wrong patterns are out of scope:

- Drag-to-build signature templates / field editors (DocuSign) — fixed consent docs.
- Kanban deal boards & pipeline/field builders (monday/Pipedrive) — status is an enum.
- Module sprawl, Gantt, financial ledgers (Procore/Buildium) — we do one spine.
- Route maps, GPS/clock-in, heavy offline engines (field-service) — not our problem.
- Keyboard-command-palette-as-the-path (Superhuman/Linear) — tap-first for low-tech.
- Configurable dashboard-widget galleries — ship *the* opinionated view, not a kit.

> North-Star check: every ADOPT above is **power-revealed-progressively, plain
> Hebrew, exception-first, motion-aware, and token-themed.** Every AVOID is
> something that would make our low-tech יזם tense up instead of relax.
