# EMAPP — UX for the Low-Tech Power User (the יזם)

> Companion to `DESIGN-NORTH-STAR.md`. Where the North Star sets the rubric, this
> doc gives the **concrete interaction patterns, anti-patterns to kill, copy
> rules, and the spine interaction spec** that make it real. Opinionated on
> purpose. Read alongside `BACKLOG.md` E1 findings.

---

## 0. Who he is (one paragraph, keep it in your head)

A real-estate developer (יזם). He knows תמ"א 38 and פינוי-בינוי cold. He does
NOT know software. He is on his phone in a parking lot between meetings. He has
4–20 projects in flight, each with dozens of apartment owners he is chasing for
signatures. His fear is not "I can't do the task" — it's **"I'll press the wrong
thing and break something / lose something / look stupid."** Every design
decision below is downstream of removing *that specific fear* and replacing it
with **"the app already did the thinking, I just confirm."**

The proof that this is achievable is already in the codebase: the **tenant
portal** ("שלום יוסי", his apartment, his status, one clear action) is the
best-designed screen in the app (E1 finding). The whole internal product should
feel like that portal — personal, calm, one obvious next move — but with power
underneath.

---

## 1. Principles → what they mean in pixels

The North Star has 5 principles. Here is each one translated into an
**enforceable design rule** you can hold a slice against.

### P1 — Power underneath, calm on top → **"3-depth rule"**
Any screen has at most **three things competing for attention**: a greeting/
context line, the *one* triage zone ("needs you now"), and the way to "see
everything." Everything else lives one tap deeper. If a screen has a 4th
top-level zone, cut it or demote it.

> Rule: **the home never scrolls past one-and-a-half phone screens before the
> user has either acted or tapped deeper.**

### P2 — Plain Hebrew, zero jargon → **"sentence-first, number-as-evidence"**
Lead with a human sentence; the number is the *footnote* that backs it up, in a
quieter weight/color.

- ✅ `כמעט שם — חסרה חתימה אחת` (then small: `11 מתוך 12`)
- ❌ `92% · 11/12 · SLA: 3d`

> Rule: **if a non-technical reader can't say the line out loud as a normal
> sentence, it's wrong.**

### P3 — Triage by exception → **"the home is a to-do list, not a database"**
The home shows the **~5 things that need him today**, in priority order, each
with an inline action. The full N-project list (search/filter/sort = full power)
is **one tap away, never the first thing he sees.** An org with 20 projects must
feel as calm as an org with 2.

### P4 — Motion + the human "why" → **"every status carries a verb and a name"**
A status is a photo; he needs a movie. Each project/owner line earns a **momentum
phrase** (`זז יפה, +2 השבוע` / `אין תנועה 18 יום`) and, where the backend has it,
a **human bottleneck** (`אורי, דירה 7 — לא הגיב`). Never a chart. Never fake the
"why" — if the objection/last-activity field isn't in the backend yet, **omit
the phrase**, don't invent it (North Star: "What this is NOT").

### P5 — Built to be re-skinned → **"structure ≠ skin"**
Everything token-themed and componentized so the owner's designer changes color/
space/radius without touching interaction or data. **No hard-coded colors, no
pixel literals** in feature components — only design tokens.

---

## 2. Interaction patterns: power WITHOUT complexity

These are the load-bearing patterns. Each says **what to do**, **why it serves
the low-tech user**, and **where it lands in EMAPP**.

### 2.1 Progressive disclosure done right
Disclosure must be **predictable and reversible**, or it becomes a maze (the
opposite of calm).

- **Tap goes deeper, never sideways.** A tap on a project card → that project.
  A tap on an apartment → that apartment. The hierarchy IS the navigation:
  `home → project → building → apartment → owner → signature`. He can always
  point at where he is and say it in words. No modal-inside-modal, no drawer
  that opens a drawer.
- **Summary on the surface, detail on demand.** A project card surfaces the one
  number that matters (signatures vs threshold) + the momentum phrase. "Edit the
  14-field project record" is behind an explicit **"עריכת פרטי הפרויקט"**, not
  bleeding onto the overview.
- **Default to collapsed for anything advanced.** Filters, bulk actions, export,
  audit — collapsed/secondary by default, labeled in plain Hebrew, expand on
  intent. Advanced power is *present and discoverable*, never *in the way*.
- **One primary action per screen, visually obvious.** Everything else is
  secondary (ghost/quiet). He should never have to choose between two equally-
  loud buttons.

### 2.2 Sensible defaults — "the app already decided for you"
The single highest-leverage lever for this user. Every choice you can make *for*
him is a choice he can't get wrong.

- **New signature request:** pre-select **all owners who haven't signed**,
  pre-fill the standard reminder copy, default a sane expiry. He reviews and
  confirms — he doesn't *assemble*.
- **New project:** the 14-field wizard (E1 found it works) should default
  status=`gathering_signatures` when he adds owners, default the org as
  developer, default dates to today. Required fields only up front; the rest
  optional and collapsed.
- **Reminders:** default cadence pre-chosen (e.g. "every 3 days until signed").
  He toggles it on; he doesn't design a schedule.
- **Sort/triage:** the home is pre-sorted by "who needs you most" — he never
  has to *configure* the view to get the right view.

> Litmus: **count the decisions on each screen. Every one you can default away
> is fear removed.**

### 2.3 The "it already thought for you" feel
Beyond defaults — the app should visibly *pre-chew* the situation:

- **Triage is computed, not browsed.** "3 פרויקטים מחכים לך" with the actual 3,
  already ranked. He doesn't hunt.
- **The next action is named on the card.** Not "open project to find out what's
  wrong" — the card *says* `חסרה חתימה אחת — שלח תזכורת` with the button right
  there.
- **Anticipate the obvious follow-up.** After "campaign sent," the screen offers
  "set a reminder for non-responders" inline — the thing he'd do next anyway.

### 2.4 Inline actions vs deep pages
- **Inline** for the verbs he does ten times a day: send reminder, mark signed/
  follow-up, copy a tenant link, snooze. These act **in place** on the card,
  with an immediate visual state change. No navigation, no page load, no losing
  his place.
- **Deep page** only for genuinely separate contexts: a full project workspace,
  the searchable all-projects list, settings, audit. Going deep is a deliberate
  "I want to dig in," not an accident.

> Rule: **the 5 most common verbs must be doable without leaving the home.**

### 2.5 Undo over confirm (and confirm only when truly destructive)
Confirmation dialogs train this user to fear his own clicks ("am I sure? am I
*sure* sure?"). Replace them with **action + visible undo**.

- **Reversible actions (the vast majority):** do it immediately, show a quiet
  "בוצע — בטל" toast for ~6s. Send reminder, archive, mark follow-up → act-then-
  undo. He learns the app is *safe to touch*.
- **Confirm ONLY when:** the action is destructive **and** irreversible **and**
  high-stakes — e.g. permanently deleting (we use `archivedAt` soft-delete, so
  even "delete" is usually undo-able → no dialog), or sending something legally
  binding to real people (a signature campaign to 12 owners' phones — *that*
  earns a "שליחה ל-12 בעלים — לאישור"). Even then: a calm summary + one button,
  not a scary red modal.
- **Never** a confirm dialog for a read or a navigation.

### 2.6 Error PREVENTION over error messages
The best error is the one that can't happen.

- **Disable + explain, don't allow-then-reject.** E1 already found two good
  examples shipped: Settings "שמירה" disabled-until-dirty; documents/new "העלאה"
  disabled-until-file. Generalize this everywhere: a button he can't legally
  press is **disabled with a one-line reason next to it** (`אין מסמכים לשליחה —
  העלה מסמך קודם`), not pressable-then-erroring.
- **Constrain the input.** Phone fields format as he types; national_id validates
  inline (it's PII — never echo it in an error). Dates pick from a calendar, not
  free text. He can't enter a shape the system will reject.
- **Make the empty/invalid path a guided path,** not a dead end (see §6).

---

## 3. Anti-patterns to KILL (these scare him — and EMAPP has them today)

From E1's findings, mapped to the fear they cause. **Each is a concrete cut.**

| Anti-pattern (present in EMAPP) | Why it scares the low-tech user | Kill it by |
|---|---|---|
| **Vanity dashboard** — cold metric counts as the home | "Numbers I'm supposed to understand but don't. What do I *do*?" | Replace home with triage mission-control (§4). Counts become *sentences with actions*. |
| **Signature board buried as the 4th tab ("לוח בקרה")** | The one thing he came to do is hidden; he feels lost in his own app | The signature board IS the project page's default/primary view (E2.2). |
| **Project opens on an empty "go to buildings" residents tab** | First impression = blank + a chore. "Is it broken? Did I lose data?" | Project opens on the **signature overview**: progress vs threshold + who's stuck. Empty state is a guided next step, never a blank. |
| **Calendar "coming soon" stub on the home** | A dead feature on the most important screen = "this app is half-built, can I trust it with my deals?" | Remove the stub entirely. Ship nothing rather than a stub on the home. |
| **Test-data chat ("recent conversations")** | Fake data = instant distrust ("none of this is real, is *any* of it real?") | Remove. North Star: never fabricated data. |
| **Incoherent demo data** (a "completed" project with 0/4 signatures, no target) | Self-contradiction = he stops believing the numbers | Fix seed coherence; show threshold/target on every project so 0/4 reads as "0 of 4, target 3," not nonsense. |
| **Two equally-loud buttons / dense action bars** | Choice paralysis; fear of the wrong one | One primary, rest quiet (§2.1). |
| **Confirm dialogs on safe actions** | Trains "every click is dangerous" | Undo pattern (§2.5). |
| **Generic 403 "failed to load — try again"** on `/members`, `/audit` (E1 finding) | "I broke it" — when he simply lacks permission, and retry won't help | The proper access-denied component (the `/settings/roles` "אין לכם הרשאה…" pattern) everywhere a 403 can land. |
| **Jargon / metrics-soup** (`64% · SLA breach`) | Foreign language on his own data | Sentence-first copy (§5). |

> The meta-anti-pattern: **treating the app as a database to be browsed.** He
> doesn't want to query his data; he wants the app to *hand him today's work*.

---

## 4. The home / triage model at scale

The home is the whole thesis. Structure, top to bottom:

1. **Warm greeting + date context.** `בוקר טוב, דוד` + a single orienting line:
   `3 פרויקטים מחכים לך היום`. Personal, like the tenant portal. One sentence.
2. **Org pulse (one calm line, not a card-grid).** A single human summary:
   `12 פרויקטים פעילים · 4 קרובים לסף החתימות · אחד תקוע`. Words, not a KPI wall.
   Tapping the pulse → the full list, pre-filtered to that slice.
3. **"צריך אותך עכשיו" — the triage zone (the heart).** The ~5 items that need
   him, ranked, each a card with:
   - the project/owner in plain words,
   - the **one number that matters** vs its **threshold** (with a threshold
     marker, so "9/12, סף 8" reads as *"already past the line, push to finish,"*
     not just a fraction),
   - a **momentum phrase** (`זז יפה, +2 השבוע` / `תקוע 18 יום`),
   - a **human "why"** when the backend has it (`אורי, דירה 7 — לא הגיב`),
   - **one inline action** (`שלח תזכורת` / `המשך`).
4. **"כל הפרויקטים" — one tap to full power.** The searchable / filterable /
   sortable / paginated list. This is where "power underneath" lives. It is
   *never* the first thing he sees, but it's always one obvious tap away.

**At scale (20+ projects):** the triage zone is **capped at ~5** and computed by
priority (past-threshold-but-not-done > stuck-longest > expiring-soon). The pulse
absorbs the rest into one line. **The home does not grow with N.** A 40-project
org and a 3-project org both open to "here are the few that need you."

**Ranking heuristic (state it, so it's not magic):**
1. Past threshold but not closed → "finish-line, one push" (highest delight/value).
2. Expiring signature request → time-sensitive.
3. Stuck longest (no movement) → at-risk.
4. Close to threshold → momentum to ride.
Everything else → the pulse line + the full list.

---

## 5. Tone & copy guidance (Hebrew, for the non-technical reader)

The North Star says "plain Hebrew." Here is the operational style guide.

### Voice
- **Warm, calm, on his side.** The app is a competent assistant who already did
  the legwork — not a system reporting metrics at him.
- **Second person, gentle imperative for actions:** `שלח תזכורת`, `המשך`,
  `סקור ואשר`. Direct, not bossy.
- **Sentences over metrics.** A line should read aloud like a person talking.

### Use these patterns
- **Status as a human phrase:** `כמעט שם — חסרה חתימה אחת` · `מוכן לאישור` ·
  `מחכה לבעלים` · `תקוע — אין תנועה שבועיים`.
- **Momentum in plain words:** `זז יפה, +2 השבוע` · `אין תנועה 18 יום`.
- **Number serves the word:** small/quiet `11 מתוך 12`, after the sentence.
- **Empty states that guide:** `עוד אין דירות בפרויקט — בוא נוסיף את הבניין הראשון`.
- **Reassurance in waits:** `רגע, מביא את הפרויקטים שלך…`.
- **Success as relief:** `נשלח. 12 בעלים יקבלו תזכורת בדקות הקרובות.`

### Avoid these
- ❌ **Tech jargon:** SLA, breach, sync, endpoint, query, cache, token, payload,
  "record" → use `פרויקט` / `דירה` / `בעלים` / `בקשת חתימה`.
- ❌ **Bare metrics-soup:** `64% · 11/12 · 3d`.
- ❌ **Percentages as the headline** — count vs threshold is more meaningful to
  him than a percent. (Percent can appear small, as evidence.)
- ❌ **Cold system-voice errors:** `Error 403` / `Request failed` / `נסה שוב`
  when retry won't help → say what happened and what he can do.
- ❌ **Blame the user:** never `קלט שגוי` / `פעולה לא חוקית`. Reframe to the fix:
  `מספר טלפון לא תקין — צריך 10 ספרות`.
- ❌ **Vocabulary the spec forbids** (CLAUDE.md): never `יחידה`/"unit" → `דירה`;
  never `tz` → it's `national_id`/`תעודת זהות` (and it's PII — never in an error,
  never logged); soft-delete verb is **`ארכוב`**, never "מחיקה" for archive.

### Micro-rules
- One idea per line. If a line needs a comma-and-a-dash-and-a-number, split it.
- Numbers with their unit-word in Hebrew (`12 בעלים`, not a bare `12`).
- Hebrew names sort with `COLLATE he_il_icu` (CLAUDE.md) — copy that lists names
  should look correctly ordered, or he'll think it's broken.
- RTL always; numbers and the threshold marker must read naturally right-to-left.

---

## 6. First-run, empty, loading, and error states (the reassurance layer)

For a fearful user, these "edge" states are where trust is won or lost.

### First-run / empty
- **Never a blank screen or a spinner-into-nothing.** Empty = a **guided first
  step** with one inviting action.
  - Home, no projects: `נתחיל — בוא ניצור את הפרויקט הראשון שלך` + a single
    `צור פרויקט` button. Warm, not "0 results."
  - Project, no buildings: `עוד אין בניינים — נוסיף את הבניין הראשון` (not the
    current empty residents tab — E1 anti-pattern).
  - Triage zone empty (everything's fine!): make it a **reward**, not a void:
    `הכול רגוע — אין משהו דחוף כרגע. 4 פרויקטים זזים יפה.` This is a *delight*
    moment (§7), not an "empty state."

### Loading
- **Skeletons over spinners** — show the *shape* of what's coming (card outlines)
  so it feels like "almost there," not "frozen."
- **One reassuring line** for anything >~300ms: `רגע, מסדר את היום שלך…`.
- Because of the RSC server-prefetch work (BACKLOG: data-in-SSR-HTML), most
  high-traffic pages arrive with data already — keep them that way; don't
  re-introduce a client fetch-after-hydration spinner.

### Error
- **Reassure first, explain plainly, offer the real next step.**
  - Network/transient: `לא הצלחנו לטעון כרגע — ננסה שוב?` + a retry that actually
    helps. Calm tone, no error codes.
  - **Permission (403):** the proper access-denied component, plainly:
    `אין לך הרשאה לעמוד הזה.` + a way back. NEVER the generic "failed to load,
    try again" (E1 finding for `/members`, `/audit`).
  - Validation: inline, at the field, framed as the fix (§5), never a wall.
- **Never** show a raw stack/boundary, an error code, or PII in any message.
- **Preserve his work** on error — never lose a half-filled form to a failed save.

---

## 7. The "wow" moments to engineer (few, deliberate)

Delight comes from a *few* engineered moments, not sparkle everywhere.

1. **"כמעט שם" finish-line moment.** When a project crosses its signature
   threshold (or sits one signature away), the card celebrates calmly:
   `כמעט שם — חסרה חתימה אחת` with a warm accent + a one-tap `שלח תזכורת אחרונה`.
   The app noticed the milestone *for* him. This is the single highest-ROI wow —
   it maps to his actual emotional peak (a deal closing).
2. **"Crossed the line" confirmation.** The moment threshold is reached:
   `🎉 עברת את הסף בפרויקט הרצל 12 — 8 מתוך 8 הנדרשות.` Quiet, dignified
   celebration. (Real data only — fire on the real event, never fake it.)
3. **The one-tap holdout chase.** From the triage card, `שלח תזכורת` sends and
   shows `נשלח לאורי — נזכיר שוב בעוד 3 ימים אם לא יחתום`. He did the whole chase
   in one tap and the app *committed to following up*. That "it'll keep nudging
   for me" is pure relief.
4. **The calm-home reward.** When nothing is urgent: `הכול רגוע היום` (§6). Most
   apps punish you with an empty screen; this one *reassures* you that you're on
   top of things.
5. **"Already thought for you" campaign.** Opening "new signature request" with
   the right owners pre-selected and the copy pre-written — he expected a form
   and got a *decision to confirm*. The gap between expectation and ease = delight.

> Wow budget: **engineer these ~5; resist adding a sixth.** Delight diluted is
> just noise to a user who fears noise.

---

## 8. Mobile / touch (he works from the field, on his phone)

Treat **phone as the primary surface for the triage loop**, desktop for the
deep-dig work. The home + chase loop must be flawless on a phone in one hand.

- **Thumb-first layout.** Primary action on each card sits in the easy thumb arc
  (bottom-ish / trailing in RTL). Don't put the only action top-left.
- **Big tap targets:** ≥44px; generous spacing so he never fat-fingers the wrong
  card. Fear of mis-tap is real for this user — give margin.
- **Inline actions shine on mobile:** send-reminder-from-the-card means the whole
  chase happens without navigation — perfect for 20 seconds in a parking lot.
- **One column, vertical scroll** for the triage feed. No horizontal scroll, no
  side-by-side panes on phone. The deep all-projects table can be desktop-rich
  and mobile-simplified (cards, not a wide grid).
- **Sticky primary action** on long forms so "שמירה" is always reachable.
- **Tap, not hover.** Nothing important hides behind hover; momentum phrases and
  "why" are visible inline, not in a tooltip.
- **RTL + numbers** verified on small screens (threshold marker, `11 מתוך 12`).
- **Forgiving inputs on touch:** phone keypad for phone fields, date picker for
  dates, no tiny free-text where a constrained control will do (§2.6).
- **Offline-ish resilience:** a flaky field connection should show the calm
  retry (§6), never lose his place or his half-typed form.

---

## 9. The SPINE — concrete interaction spec

`project → buildings → apartments → owners → signature status → chase a holdout`.
This is E2.2 + E2.3. Specified as screens, defaults, inline actions, and copy.

### 9.1 Project page (workflow-first) — replaces the buried-board anti-pattern
**Opens on the signature overview** (NOT the empty residents tab).

- **Header:** project name + a one-line human status:
  `אוסף חתימות — 9 מתוך 12, סף 8 ✓ עברת את הסף`. Momentum phrase under it:
  `זז יפה, +2 השבוע`.
- **Progress, threshold-aware:** a single clear bar/marker showing signed vs
  total, with the **threshold marker** distinct, so "past the line" is obvious at
  a glance (the finish-line wow, §7).
- **"מי תקוע" (who's stuck) — the heart of the page:** a short list of the owners
  not yet signed, each with: name + apartment (`אורי — דירה 7`), status phrase
  (`לא הגיב 12 יום` / `נשלחה תזכורת אתמול` / `מתנגד`), and **one inline action**
  (`שלח תזכורת` / `המשך מעקב`). This is where he spends his time — surface it,
  don't bury it.
- **Secondary, quiet:** `בניינים ודירות`, `מסמכים`, `עריכת פרטי הפרויקט`,
  `ארכוב`. Present, not loud. Edit/archive are not finish-the-day actions.
- **Empty (no apartments yet):** guided step, not blank (§6).

### 9.2 Buildings → apartments (the structure, one tap down)
- A project has buildings; a building has apartments. Navigation is the
  hierarchy: tap a building → its apartments; tap an apartment → its owner(s) +
  that apartment's signature status.
- **Each apartment line carries its signature state in words:** `דירה 7 — אורי
  כהן — לא חתם` / `דירה 4 — נחתם ✓`. He reads the building's signature health by
  scanning, no drill-down needed for the overview.
- Add building / add apartment are **inline, defaulted** (next apartment number
  pre-filled), with undo — adding structure should feel light, not like a form
  marathon.
- Vocabulary lock (CLAUDE.md): **`דירה`** (never "unit"/"יחידה"), owner = `בעלים`.

### 9.3 Apartment → owner(s) → signature status
- An apartment shows its owner(s) with ownership share and **signature status per
  owner** in plain words.
- **PII discipline:** `national_id`/תעודת זהות and phone are PII — masked by
  default, reveal is an explicit, audited action (E1: PII-reveal correctly gated
  by role). Never show PII in a status line, an error, or a log. The *status*
  ("לא חתם") needs no PII to be useful.
- Owner status phrases: `לא הגיב` · `נשלחה בקשה — ממתין` · `נחתם ✓` · `מתנגד`
  (the last only if the backend has the objection signal — else omit, never fake;
  this is exactly the North Star "why-layer backend follow-up").

### 9.4 Chasing a holdout (E2.3 — the loop)
The emotional core. From **any** surface where a holdout appears (home triage
card, project "מי תקוע", apartment owner line), the chase is the same minimal
loop:

1. **One tap: `שלח תזכורת`.** Acts inline. No dialog (it's reversible / low-
   stakes per owner). Toast: `נשלח לאורי — נזכיר שוב בעוד 3 ימים אם לא יחתום`
   with `בטל`.
2. **The app commits to follow-up** (default reminder cadence) — he doesn't
   schedule it; he *opts out* if he wants. ("It'll keep nudging for me," §7.)
3. **Escalation, plainly offered, only when relevant:** if reminders aren't
   landing, surface the next real lever (`התקשר לאורי` with the number revealed
   via the audited PII action, or `שלח שוב עם מסמך`). Offer the *next real step*,
   never a dead end.
4. **State is always legible:** the owner's line updates to `נשלחה תזכורת — ממתין`
   immediately. He can see, in words, exactly where each holdout stands.

**Sending the full campaign** (to *all* unsigned owners) is the one place a
**confirm** is justified (real messages to real people, §2.5): a calm summary
`שליחת בקשת חתימה ל-3 בעלים שטרם חתמו` + one `שלח`. With **0 documents** the send
is **disabled with the reason** (`אין מסמכי פרויקט זמינים לשליחה — העלה מסמך`)
and an inline link to upload — exactly the error-prevention pattern (E1 already
gets the disabled-state right; just add the inline "upload" link it noted as a
minor gap).

### 9.5 The spine, as a single sentence he could say
> "I open the project, I see we're 9 of 12 — past the line — and that אורי in
> דירה 7 hasn't signed in 12 days, so I tap שלח תזכורת and the app says it'll
> remind him again in 3 days. Done. I close the phone."

If a slice doesn't make *that sentence* true and effortless, it isn't done.

---

## 10. Definition-of-done addendum (design-side, per E2 slice)

Hold every E2 slice against these, in addition to CLAUDE.md's DoD:

- [ ] **3-depth rule:** ≤3 top-level zones; full power is one tap, not on the surface.
- [ ] **Sentence-first:** every status reads aloud as plain Hebrew; numbers are evidence, not headline.
- [ ] **One primary action** per screen; the rest quiet.
- [ ] **Inline + undo** for common verbs; confirm only for destructive-irreversible or real-people-sends.
- [ ] **Error prevention:** disabled-with-reason over allow-then-reject; constrained inputs.
- [ ] **Empty/loading/error** are guided + reassuring, never blank/spinner/403-generic.
- [ ] **No fabricated data / no stub on a primary screen.**
- [ ] **Mobile:** the triage + chase loop works one-handed; ≥44px targets; thumb-reachable primary.
- [ ] **Tokens only** (no hard-coded color/space) so the designer can re-skin.
- [ ] **Vocabulary lock:** דירה / בעלים / national_id / ארכוב; no jargon; PII never surfaced/logged.
- [ ] **Real-Chrome verify** against the North Star rubric (BACKLOG gate).
