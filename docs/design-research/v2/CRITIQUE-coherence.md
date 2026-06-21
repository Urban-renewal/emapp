# CRITIQUE — Coherence & Tensions (council v2, adversarial pass)

> **Role:** adversarial coherence critic. My job is **not** to add a ninth opinion
> on the design. It is to read the eight v2 expert docs as a single body of work and
> find where they **contradict, double-count, or quietly disagree** with each other —
> and for each tension, state the real trade-off and either point to the synthesis
> resolution or flag it as a genuine **OWNER DECISION** that the council cannot
> resolve from inside.
>
> Inputs read in full: `01-domain-workflow.md`, `02-ux-lowtech.md`,
> `03-information-architecture.md`, `04-visual-design-system.md`,
> `05-data-feasibility.md`, `06-interaction-motion.md`, `07-frontend-architecture.md`,
> `08-accessibility-i18n.md`, plus `DESIGN-NORTH-STAR.md`.
>
> **Headline:** the eight docs are unusually *aligned* on the big diagnosis (board-first,
> kill the cold KPI home, the consent-counting bug, the StatusBadge leak, never-fake-it).
> That alignment is itself a risk: **shared agreement is masking three real, unresolved
> contradictions** about *what number the developer sees first*, *how much navigation we
> dare to move*, and *whether the "calm" promise is honest given what the backend can do
> today*. Those three are the load-bearing tensions. The rest are sequencing /
> ownership-boundary frictions that synthesis can resolve mechanically. I rank them.

---

## How to read this doc

Each tension has: **the two (or more) positions, each cited** · **the real trade-off**
· **verdict** — one of:
- **SYNTHESIS-RESOLVABLE** — the docs already contain the resolution; synthesis just has
  to *pick it and write it down* so the conflict doesn't resurface mid-build.
- **OWNER DECISION** — genuinely cannot be resolved by the council; needs the product
  owner / a lawyer / the partner designer.
- **PROCESS GAP** — the docs agree on the *what* but contradict on *who owns it* or
  *when it ships*, which will cause a real collision if not assigned.

---

## TENSION 1 — The board-first decision and the consent-counting bug are on a collision course (the sharpest tension in the set)

**This is the most important contradiction in the eight docs, and it is partly hidden
because every author *agrees* on both halves independently without noticing they fight.**

**Position A — "make the signature board the first thing the developer sees."**
Unanimous. IA (`03` §3.2, §1.2) makes board-first its headline move ("almost free… a
re-order, not new construction"). UX (`02` §2.3) calls board-first "E2.2, the
highest-value slice." FE-arch (`07` §0.2, E2.2) and interaction (`06`) both build on it.
The North Star itself (E2.2) mandates it.

**Position B — "the headline consent % the board shows may be legally wrong."**
Also unanimous, and stated even more forcefully. Domain (`01` §0, §3.5) calls
`metThreshold` "legally wrong in both directions" and "the trust fulcrum of the entire
product." Data-feasibility (`05` §5.1) calls it "BLOCKING for correctness." IA (`03` R5,
D-IA-2) explicitly notes board-first **amplifies** the bug: "Making the
possibly-legally-wrong 'Z%' the first thing the user sees raises the cost of the §7
domain bug." FE-arch (`07` P0-FIX) says the same: "making a possibly-wrong number more
prominent is worse than the current burial."

**The real trade-off the docs do NOT fully confront:** every author has independently
flagged that board-first + a legally-wrong % is a *worse* state than today, where the
number is buried on tab 4. Yet **every author still recommends shipping board-first
(E2.2) before the consent rule is decided** — the slice plans (`07` §5, `03` G4-S1, `02`
§6) put board-first as an early/no-BE win and the consent-counting fix as a separate,
later, owner-gated track (`01` decision #1, `05` decision #1, `07` P0-FIX). **The council
is recommending we make a number more prominent and more authoritative-looking at the
exact moment we admit we don't trust it.** That is a genuine incoherence, not a
sequencing nicety.

**Three ways out, and the docs don't pick one:**
1. **Gate board-first on the consent decision** (don't ship E2.2's prominent % until the
   owner confirms the rule). Safest for trust; slows the single highest-value visual win.
2. **Ship board-first now but render the % with an explicit, honest qualifier** — IA `03`
   R5 proposes exactly this: render "by apartments" ("לפי ראשי דירות") as the basis label
   until share-weighting lands. Domain `01` §3.4 independently proposes the *same*
   mechanism (name the denominator, show heads as a supporting line). **This is the
   latent synthesis: board-first is safe to ship early IF the % is never shown as a bare,
   unqualified legal claim — it must carry its basis label from day one.**
3. **Ship board-first but demote the % from "the headline" to a supporting line** until
   share-weighting exists, leading instead with the count sentence ("23 מתוך 40 דירות
   חתמו") which is *not* a legal claim.

**Verdict: OWNER DECISION on the counting rule (1/2/3 above is the owner's call), but
SYNTHESIS-RESOLVABLE on the interim safety mechanism.** Synthesis MUST write the binding
rule: *no slice may render an unqualified consent % as a legal/threshold claim until the
owner confirms the basis; until then every % carries its denominator label (`01` §3.4 +
`03` R5 give the exact copy).* Without this, board-first and the domain doc are in open
conflict and the build will ship the worse state.

---

## TENSION 2 — Navigation 14→5 (IA's boldest move) vs. the migration-safety and calm promises

**Position A — collapse the sidebar from 14 items to 5.** IA (`03` §3.1, §0) is
emphatic: 14→5 is the cure for "the user assembles the workflow in his head." It demotes
signature-requests, documents, notes, contractors, messages, notifications out of the
primary spine and merges members/audit/settings into a gated Admin group.

**Position B (three quiet objections, none of which IA fully answers):**

- **B1 — Migration safety says "demote ≠ delete," but creates a discoverability hole IA
  itself names.** IA `03` R2 admits: "Power users who bookmarked `/signature-requests` or
  `/notes` will find the nav line gone." Its mitigation is *the global search omnibox*
  (`03` §3.3) — but the omnibox is a **separate slice (S4)** that lands *after* the
  sidebar collapse (S2). So between S2 and S4 there is a window where six destinations
  have **no nav entry and no search** — a regression for the very power users (the
  developer's small team) the product serves. **The docs sequence the cure after the
  wound.**

- **B2 — FE-arch's "re-composition not re-routing" guarantee is real but narrower than
  IA's claim.** FE-arch (`07` §4.1) correctly scopes the safe part: editing
  `sidebar.tsx items[]` is zero-route-risk. But IA's plan also **merges documents +
  signature-requests into in-project tabs** and **tasks + notes into a project Activity
  tab** (`03` §3.2). That is *not* just an `items[]` edit — it is new in-project
  composition that renders/filters existing components by project. FE-arch flags exactly
  this as the higher-risk part and explicitly de-scopes it ("change ONLY the tab default…
  defer any visual restyle of the other tabs," `07` E2.2 risk). **So FE-arch has already
  quietly pared back IA's project-tab merger to "later" — the two docs are not actually
  agreeing on the same E2.2.**

- **B3 — "Tasks at 5 vs 4" is an open question IA flags but the calm rubric pressures
  toward 4.** IA `03` D-IA-1 leaves Tasks-as-5th-item open. The North Star's "calm on top,
  ~5 things" principle and UX's anxiety lens both push *toward fewer* top-level choices,
  i.e. demote Tasks. This is minor but unresolved.

**The real trade-off:** 14→5 is the move with the highest *calm* payoff and the highest
*disruption* to an existing team that has muscle memory for the flat list. The aggressive
version (collapse sidebar AND merge project tabs in the same wave) maximizes the North
Star win but is exactly what FE-arch warns breaks reused flows; the safe version (sidebar
`items[]` only, project-tab merger deferred, search shipped *with or before* the collapse)
is coherent but is a smaller first step than IA's prose implies.

**Verdict: SYNTHESIS-RESOLVABLE, with one ordering correction that is non-negotiable.**
Synthesis should adopt FE-arch's scoping (sidebar regroup is S1-cheap; project-tab
merger is a *separate, later* slice, not part of the board-first reorder) AND **re-order
so global search ships no later than the sidebar collapse**, closing the B1 hole. The
Tasks 5-vs-4 question is a real but low-stakes **OWNER DECISION** (D-IA-1). If synthesis
papers over B1's ordering, the first migration wave is a net usability regression.

---

## TENSION 3 — The "calm, it-keeps-nudging-for-me" emotional promise vs. what the backend can honestly deliver today

This is where the emotional/UX docs and the data/interaction docs are in the sharpest
*factual* disagreement about what is shippable — and to their credit, the data-side docs
caught it.

**Position A — the North Star + UX promise an app that does the developer's chasing for
him.** North Star principle: "Motion + the human 'why', woven in calmly." UX (`02` §7
wow-list, §8 chase loop) wants the toast "נשלח לאורי — **נזכיר שוב בעוד 3 ימים** אם לא
יחתום" and "the app commits to follow-up… 'It'll keep nudging for me' = the relief
moment."

**Position B — interaction + data say that recurring-nudge cadence does not exist and
must not be faked.** Interaction (`06` Finding B, §3.3) is unambiguous: "*That job does
not exist in the codebase.* `resend` is a manual, manager-initiated, one-shot
re-delivery. There is no cron, no `reminder_schedule`, no `next_reminder_at` column." It
explicitly forbids the copy: "the toast must say only `נשלחה תזכורת לאורי` and NOT promise
a future nudge." Data-feasibility (`05` §4) and a11y (`08` §4.3) reinforce the
never-fake-it contract and even add an a11y consequence (don't reserve an `aria-live`
region for a perpetually-empty "why").

**This is NOT actually a contradiction between the docs — it is a contradiction between
the North Star's aspiration and reality, which the data-side docs correctly surfaced and
the UX doc partially absorbed but its copy examples didn't.** The danger is that the UX
doc's vivid "it'll keep nudging" copy (§8.1–8.2) is the most memorable, quotable line in
the whole council output, and a builder skimming for the "voice" will lift it verbatim and
ship a lie. The honest version (`06` §3.3 path (a): ship the one-tap send, omit the
future-nudge sentence) is buried three docs away.

**The same fault-line runs through a second signal pair the docs treat inconsistently:**
the "why" / "3 בעלים מתנגדים" line. Domain `01` §5, data `05` #7/§3, IA `03` §7, a11y `08`
§4.3, and FE-arch `07` §4.4 *all* correctly say: no `decline_reason` column exists, omit
the objection phrase until the B2 migration. But the **visual-design doc (`04` §4.3
ActionCard)** lists "3 בעלים מתנגדים" as the example "why" sentence for its hero
ActionCard, with the caveat in prose but the *example* still showing the forbidden string.
And the North Star uses "3 בעלים מתנגדים" as a headline example. So the most-fabrication-
prone string in the product appears as an *illustrative example* in the rubric and two
expert docs, while five other docs say it's illegal to render. A builder copies examples.

**The real trade-off:** the council can either (1) keep the aspirational copy as the
"north" and rely on every builder reading the honesty caveats in `05`/`06`, or (2) **purge
the un-shippable strings from every example and replace them with the honest interim copy**
so the fabrication can't leak through copy-paste.

**Verdict: SYNTHESIS-RESOLVABLE and MANDATORY.** Synthesis must produce a single
**DO-NOT-SHIP-COPY register** (data `05` §4 is 80% of it already) and **rewrite every
illustrative example across the North Star and docs `02`/`04` to the honest interim
string** — "נשלחה תזכורת לאורי" (no future nudge), "X דירות סומנו כסירוב" (not "3 בעלים
מתנגדים"). This is the single highest-leverage coherence fix: it converts "never fake it"
from a principle everyone *states* into copy nobody *can* violate by reflex. The owner
decisions behind it (build the auto-cadence? build `decline_reason`?) are real (`06` D2,
`05` decision #3) but separable — **OWNER DECISION on whether to build the capability;
SYNTHESIS-RESOLVABLE on not shipping the copy until it exists.**

---

## TENSION 4 — Three docs each claim the StatusBadge/token leak as "the #1 fix," and they disagree on its size and its guard

**The agreement:** visual (`04` §1.6), UX (`02` §9), interaction (`06`), FE-arch (`07`
§3), and a11y (`08` §6.4) all name the `status-badge.tsx` Tailwind-default leak. Good.

**The disagreements that will cause a build collision:**

- **Scope: "one file" vs "35 files."** UX `02` §9 calls it "the single highest-leverage
  re-skin fix — one file, app-wide effect." FE-arch `07` §3 also frames it as fixing
  *two* components (`status-badge` + `button.destructive`). But visual `04` §1.6
  **measured it at 79 occurrences across 35 files**, including private re-duplications
  (`provider/page.tsx`, `member-overrides-panel.tsx`) and a *second* leak class (inline
  `var(--tier1)`, `04` §1.7). **If synthesis takes UX/FE-arch's "one file" framing, the
  slice will fix the shared component, the ratchet will stay green, and 78 of 79 leaks
  survive invisibly** — exactly the silent-rot the visual doc warns about. The visual
  doc's measurement is the correct one; the other two under-scoped it.

- **The guard: the existing ratchet vs. a NEW guard.** Visual `04` §5.4 and FE-arch `07`
  §6.7 both correctly note the existing `app-no-new-inline-colors.spec.ts` is
  *architecturally blind* to Tailwind class-name leaks (it only matches hex/rgb/hsl). But
  FE-arch files extending the ratchet as a "small follow-up… flag, not a blocker" (`07`
  risk #7), while visual makes the new guard "the single most important new engineering
  artifact this redesign needs" (`04` §5.4) and wants it baseline-frozen at 79/35 in
  E2.0. **Same finding, opposite priority.** If the new guard is a "follow-up," the sweep
  has nothing enforcing it and re-leaks immediately.

- **VM color-vocabulary rename (`statusColor`→`tone`).** Visual `04` §1.8/§9 wants the
  three-way `green|emerald|amber` fork unified to intent names *now*, in E2.0, touching
  the data layer (adapters + VMs). FE-arch `07` §1 maps `StatusBadge`→`StatusPill` but
  says "Keep the `StatusColor` VM contract identical so no caller changes" — i.e.
  **explicitly does NOT do the rename**, to keep the slice presentation-only and low-risk.
  These are direct opposites on whether E2.0 touches the VMs.

**The real trade-off:** the visual doc is correct that a presentation-only fix that leaves
the VM vocabulary forked and the guard deferred will *silently re-rot* — but FE-arch is
correct that touching the VM layer in the foundation slice raises its risk above
"presentation-only" and pulls in the data layer. You cannot have both "lowest-risk E2.0"
and "the leak is actually closed."

**Verdict: SYNTHESIS-RESOLVABLE — adopt the visual doc's scope and guard, accept the
slightly higher E2.0 risk.** The correct resolution: E2.0 = (a) fix the shared component,
(b) **add the new static guard frozen at 79/35** (visual's priority, not FE-arch's
"follow-up"), (c) do the `tone` rename (visual is right — the remap is pure debt and the
rename is mechanical), and (d) treat the 35-file sweep as ratcheting the new guard down,
slice by slice. FE-arch's "keep the contract identical / one file" framing is the
*comfortable* path but it is the one that leaves the re-skin promise broken. **Synthesis
must explicitly overrule the "one file" framing.** (No owner decision needed; this is an
engineering-correctness call the visual doc already won on evidence.)

---

## TENSION 5 — Where the "why" / momentum signal lives, and who owns the spacing/type/motion tokens (double-ownership)

**Double-counted ownership (PROCESS GAP, not a design conflict):**

- **Spacing + type scales.** Visual `04` §3.2 owns them ("`--space-*`, `--text-*`… fix in
  E2.0"). FE-arch `07` §3 *also* specs them ("the only Tier-1 schema growth… additive").
  Same tokens, two owners. Harmless if synthesis assigns it once (visual owns the token
  values; FE-arch owns wiring them into `tailwind.config.ts`), a collision if both slices
  edit `globals.css` `:root` independently.

- **Motion tokens + `prefers-reduced-motion`.** Interaction `06` §6 specs
  `--motion-duration-*`/`--motion-ease-*` and says they are "owned jointly with the
  `05-visual-system` token work." Visual `04` §2.7 mentions motion only in passing (keep
  existing keyframes) and does **not** spec the motion tokens or the reduced-motion guard.
  So motion tokens are "jointly owned" by one doc that specs them and one that doesn't
  mention them — i.e. **effectively unowned.** A11y `08` independently requires
  reduced-motion as an AA concern. If synthesis doesn't assign motion tokens to a concrete
  slice (interaction's M1), they fall between the visual and interaction seats.

- **`ActionToast` (`06`) and the a11y live-region (`08` G6) are the SAME primitive seen
  from two seats — and neither doc notices.** Interaction `06` §2.2 specs `useActionToast`
  / `ActionToast` as `role="status" aria-live="polite"` (assertive for danger) and calls
  it the keystone slice (M0). A11y `08` §10 independently specs Gap G6 — a single app-root
  live-region pair, `role="status" aria-live="polite"` + `role="alert" aria-live="assertive"`
  — and calls **it** "the gating dependency before any one-tap-approve hero ships." These
  are the **same DOM surface with the same ARIA roles**, specced by two docs that each
  think they own the foundational announcement channel and neither cross-references the
  other. **If built as two slices they become two overlapping announcement channels — a
  textbook double-SR-announcement a11y bug** (the polite toast and the polite live region
  both fire on "נשלחה תזכורת"). Synthesis MUST fuse them into ONE primitive (build once,
  polite + assertive variants), satisfying both `06` M0 and `08` G6 — this is the single
  highest-value coherence fix in the duplication class, and the most consequential omission
  in two otherwise-excellent docs.

- **The pulse endpoint (`GET /org/signature-pulse`) is specced in four docs with four
  slightly different field lists.** Data `05` §2.A is the authoritative shape
  (`{buckets, attention: ProjectPulseRow[]}` with a named field set). IA `03` §7, FE-arch
  `07` B1, interaction `06` (chase surfaces), and UX `02` §6 all consume it but each
  enumerates a slightly different subset. Not a contradiction, but synthesis must declare
  **data `05` §2.A as the single canonical schema** so the four consumers don't each
  assume a different wire.

**Verdict: PROCESS GAP — SYNTHESIS-RESOLVABLE by assignment.** No design conflict; assign
each token group and the pulse schema to exactly one owning slice (spacing/type → E2.0
visual; motion → interaction M1; pulse schema → data `05` §2.A canonical, B1 builds it).
The only risk is silent omission (motion tokens) or three slices editing `:root` at once.

---

## TENSION 6 — "Calm / generous whitespace / progressive disclosure" vs. the legitimately-dense power surfaces

A subtle one the docs mostly get right but state inconsistently enough to confuse a
builder.

**Position A — calm, generous, words-over-numbers, ~5 things.** The North Star and UX
`02` and visual `04` §2 push hard on whitespace and restraint.

**Position B — some surfaces are *correctly* dense and must stay so.** UX `02` §2.5
explicitly defends the owners table as "a legitimate power surface (depth-3), density is
OK *here*." IA `03` §5.2 keeps the owners list as a dense directory. Domain `01` §3.4
wants the board to show *three* counting bases (share / heads / building) — which is
*more* number-dense than today's single bar, in direct tension with "numbers serve words."

**The real trade-off:** the calm rubric is a *depth-1 / home* rule, not a global ban on
density. The docs know this (UX's 3-depth model, `02` §3) but the North Star's blanket
"not a dense dashboard of cold metric cards" can be mis-read as "no dense surfaces
anywhere." The domain doc's three-basis board is the live test case: it is the *right*
amount of legal density for the developer's lawyer-facing moment, but it sits on the
board-first page that the calm rubric most wants to keep serene.

**Verdict: SYNTHESIS-RESOLVABLE.** Synthesis should state the rule the docs imply but
never quite write: **calm/whitespace is a depth-1 (home + card) contract; depth-3 power
surfaces (owners table, full projects list, the lawyer-facing multi-basis consent
breakdown) are allowed — even required — to be dense, reached by a tap.** Domain's
three-basis view resolves cleanly as *progressive disclosure*: headline = one
plain-Hebrew basis-labeled line; the heads/per-building breakdown is one tap deeper (`01`
§3.4 already says this). No conflict once the depth-scoping is explicit.

---

## TENSION 7 — Minor / latent frictions (flagged so synthesis doesn't trip on them)

- **`metThreshold` celebration honesty.** Interaction `06` Wow 2 builds a "crossed the
  line" celebration off a *client-cache edge-diff* of `metThreshold`, and admits it won't
  fire for a crossing that happened while the manager was away (no server event). Domain
  `01` §3.5 simultaneously says `metThreshold` can be *legally wrong*. So the celebration
  may fire on a legally-wrong crossing. This is downstream of Tension 1 — **if the consent
  rule isn't fixed, the celebration inherits the lie.** Synthesis: gate the celebration on
  the same basis-correctness rule as the headline %.

- **AgentHome vs ManagerHome as the precedent.** UX `02`, IA `03`, and FE-arch `07` all
  correctly nominate AgentHome as the existing triage exemplar. But visual `04` §1.7 names
  AgentHome as the **worst inline-`var(--…)` leak offender (~15 sites)**, and FE-arch `07`
  §0.1 notes ManagerHome does an **off-seam ad-hoc fetch**. So the structural precedent
  (AgentHome) and the data-pipeline precedent (the projects-list RSC shell) are *different
  files*, and AgentHome must be token-cleaned *before* it's promoted as the pattern, or the
  redesign propagates its leaks. Minor but concrete: **clean AgentHome's inline tokens in
  E2.0, don't just copy its shape.**

- **`en` locale reality gates the i18n bar but no other doc accounts for it.** A11y `08`
  decision #1 surfaces that status labels render Hebrew regardless of locale — so if `en`
  is real, the adapter-level enum labels (`01`'s domain vocabulary, `04`'s status tones)
  all need en variants. No other doc assumes en work. If the owner says "en is real," it
  ripples into domain/visual/IA scope that none of them budgeted. **OWNER DECISION (a11y
  #1) with cross-doc scope impact.**

- **StepUpDialog focus-trap gap (a11y G1).** A11y `08` is the only doc that catches it,
  and interaction `06` builds *new* modals (ActionToast) that should follow ConfirmDialog,
  not StepUpDialog. No conflict — just make sure interaction's M0 primitive inherits a11y's
  RULE A4, and the StepUp retrofit (G1) is assigned somewhere (it currently isn't in any
  slice plan).

---

## Consolidated owner-decision register (de-duplicated across all 8 docs)

The docs surface **the same handful of owner decisions repeatedly under different IDs.**
De-duplicated, there are really only these:

| # | Decision | Raised by (independently) | Blocking? |
|---|---|---|---|
| **OD-1** | **The consent-counting rule** (apartment-heads vs ownership-share vs per-building) — and, until decided, whether board-first ships with a basis-qualified % | `01` D#1 (gating), `02` §11.2, `03` D-IA-2, `05` D#1, `07` P0-FIX | **YES — gates Tension 1; the single most-cited decision** |
| **OD-2** | **Build the auto-reminder cadence?** (unlocks the "it'll keep nudging" promise; until then the copy is forbidden) | `06` D2, North Star (implied) | No, but gates the copy (Tension 3) |
| **OD-3** | **Build the `decline_reason` / objection "why" layer?** (D-min column vs D-alt table) — until then "X מתנגדים" is forbidden | `01` D#4, `05` D#3, `03` B2, `07` B2 | No, but gates the copy (Tension 3) |
| **OD-4** | **Exact statutory percentages** (66 vs 67, pre-2023 grandfathering) — lawyer-confirmable config | `01` D#2 (LEGAL-CONFIRM) | Config-only, low-risk |
| **OD-5** | **Is `en` a real shipping locale?** (materially changes i18n + adapter scope) | `08` D#1 | Scope-determining |
| **OD-6** | **Project-tab structure** — is the partner's 4-tab layout locked, or may board-first replace it? | `02` §11.1, `03` §3.2 (assumes yes), `04`/`07` (mockup-v4 provenance unconfirmed) | Gates the *form* of board-first |
| **OD-7** | **Tasks = 5th spine item or demote to 4?** | `03` D-IA-1 | Low-stakes |
| **OD-8** | **"stuck" threshold N** (default 14 days) drives the "תקוע" copy | `05` D#2, `06` (pulse) | Low-stakes config |
| **OD-9** | **Reminder undo semantics** (delay-the-send true-undo vs theater-undo) | `06` D1 | Low-stakes UX |
| **OD-10** | **Brand fork: navy vs teal** → one `--brand` token | `04` §9 D#1 | Designer's call |

**Coherence note on the register itself:** the fact that OD-1 appears in *five* docs under
*five* IDs (D#1, §11.2, D-IA-2, D#1, P0-FIX) is a sign the council has been circling the
same blocker without anyone empowered to close it. Synthesis should present OD-1 as **the
one decision that unblocks the most slices**, not as five separate footnotes.

---

## Bottom line for synthesis (what must actually be written down)

The eight docs do not have many *design* contradictions — they have an unusually coherent
shared vision. The real incoherences are **three substantive** and **two procedural**:

1. **(Tension 1, OWNER) Board-first vs. the legally-wrong %.** Resolve by: OD-1 decides
   the rule; until then, a **binding interim rule** that no % renders as an unqualified
   legal claim (basis label mandatory). Write this rule explicitly or the build ships the
   worse state.
2. **(Tension 3, SYNTHESIS-MANDATORY) The "calm nudging" copy promises capabilities that
   don't exist.** Resolve by a **DO-NOT-SHIP-COPY register** and **rewriting every
   illustrative example** (incl. the North Star's own) to the honest interim string. This
   is the highest-leverage coherence fix.
3. **(Tension 4, SYNTHESIS) The StatusBadge leak is 35 files, not one, and needs a new
   guard now, not later.** Overrule the "one file / keep-contract / follow-up-guard"
   framing; adopt the visual doc's scope + guard + `tone` rename in E2.0.
4. **(Tension 2, SYNTHESIS-ORDERING) Ship global search no later than the sidebar collapse**,
   and scope the project-tab merger as a separate later slice (per FE-arch), not part of the
   board-first reorder.
5. **(Tension 5, ASSIGNMENT) Assign the double-owned tokens** (spacing/type → E2.0;
   motion → interaction M1) and declare **data `05` §2.A the canonical pulse schema.**

Everything else (Tensions 6, 7) is resolvable by writing down the depth-scoping rule the
docs already imply. The danger is not that the docs disagree loudly — it is that they
**agree warmly while leaving OD-1 unowned and the un-shippable copy in every example.**
Those two are what will bite the build.
