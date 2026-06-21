# CRITIQUE — Completeness (adversarial)

> Council second pass, completeness seat. I read all 8 v2 expert docs **and** the
> two sibling critiques (coherence, reality), then went looking for what the
> *whole panel* missed — surfaces nobody opened, flows nobody traced, data signals
> nobody named, scale/error/offline/concurrency realities nobody grounded.
> Everything below is cited to real files I re-opened **this pass (2026-06-18)** —
> where the prior draft of this seat asserted something I could falsify, I
> corrected it against the live tree and say so explicitly. Each gap is framed as
> a concrete plan item with **why it matters to the יזם persona**.
>
> **Verdict up front:** the panel did excellent depth on the **happy-path triad**
> (home pulse → board-first project page → chase loop) and on the **token re-skin
> mechanics**. But it scoped itself to ~10 of ~64 routes. The redesign as specified
> would leave the יזם with a beautiful mission-control and a chase loop sitting on
> top of **un-redesigned input, sharing, onboarding, and field-work surfaces**, plus
> **five cross-cutting realities no seat owned**: a connectivity story (more nuanced
> than the prior draft claimed — see §6, this is a *correction*), a unified
> error/loading/empty contract, scale-at-N for the full lists, PII-in-motion, and a
> **time-display correctness bug that quietly undermines the chase loop's trust**
> (§A, new this pass). The gaps below are the difference between "a redesigned home
> screen" and "a redesigned product."

---

## 0. The meta-gap: the panel redesigned the *output* surfaces and ignored the *input* surfaces

Every one of the 8 docs orbits the same three screens: the home, the project
board, and the signature-chase loop — the surfaces where the developer *reads his
status*. But a signature-collection product is equally about **putting data in**
and **getting it out to third parties**, and the panel analyzed almost none of it.

| Surface | Real route(s) | Size | Panel coverage |
|---|---|---|---|
| **Project creation wizard** | `(dashboard)/projects/new/page.tsx` | **1468 lines** (verified `wc -l`) | **Zero.** The single largest client file in the app. Not opened by any seat. |
| **Bulk Excel import flow** | `imports/[id]/page.tsx`, `…/mapping`, `…/errors`, `imports/new` | ~550 + a live SSE hook | Named only as a nav item; the *flow* (SSE progress, preview-confirm pause, mapping wizard, error triage) was never analyzed. |
| **Contractor share view** | `(contractor)/contractor/share/page.tsx` | 198 | IA seat **explicitly excluded** it. The יזם's primary *external-facing deliverable*, redesigned by nobody. |
| **Onboarding / first-run** | `(auth)/signup`, `accept-invite/[token]`, `tenant/login` | ~330+ | Zero. "Empty org, day one" — the most fragile moment for a low-tech user — is unanalyzed. |
| **Field-work / discovery** | `discovery_records` (BE) | **no FE at all** (verified: 2 incidental grep hits) | Domain seat named it; nobody noticed it has **no FE surface** and is half the workflow. |
| **Export / committee submission** | `export-xlsx-button.tsx`, `fetchSignedDocument`, **+ no print path at all** | ~120 | Zero. The "take the signed consents to the וועדה" moment — the *point* of the product — has no design analysis and **no print/PDF-of-record path** (§B, new). |

Sections 1–11 detail each, plus the cross-cutting realities. **Sections A and B
are entirely new this pass** — grounded gaps that neither the panel nor the prior
completeness draft named.

---

## A. NEW + GROUNDED — the chase loop displays the *wrong time* on a misconfigured device

**Evidence (read this pass):** `lib/format.ts` has two helpers.
- `formatRelative(at, locale)` (`:16-30`) — the "לפני 3 ימים" / "עוד יומיים" string
  the chase loop, notifications, owner activity, and 15 other surfaces lean on —
  computes its delta from **`Date.now()` and rounds against the browser's wall
  clock**. It pins **no timezone**. It is used by **18 adapters** (verified
  `grep -rln formatRelative adapters/ | wc -l` = 18).
- `formatJerusalem(at, locale)` (`:40-50`) — the *only* helper that pins
  `timeZone: 'Asia/Jerusalem'` — is used **only in the provider audit log**.

**Why it matters to the persona — this is a quiet trust-killer the whole panel
missed:** the hard rule in `CLAUDE.md` is "store UTC, **display Asia/Jerusalem**."
The chase loop's entire emotional weight rests on *when*: "פג תוקף עוד יומיים",
"חתם אתמול", "נשלח לפני 3 ימים". For a developer in Israel on a correctly-set
phone the delta is right *by luck* (his device tz ≈ Asia/Jerusalem). But (a) the
**day-boundary rounding** (`deltaDays = Math.round(deltaMs / 86_400_000)` from a
UTC instant) can flip "פג היום" ↔ "פג מחר" by up to the IDT/IST offset near
midnight — exactly the high-stakes window the expiry-chase cares about; and (b)
any team member on a travelling laptop, a mis-set device, or a future `en`/diaspora
user sees a *confidently wrong* relative time. The North Star forbids fabricated
signals; a confidently-wrong "פג מחר" on an expiry that actually passed *today* is
worse than no signal. The Motion seat's entire expiry-chase and the data seat's
"expiring-soon window" both render through this helper and **neither seat checked
the helper's tz correctness.**

**Concrete plan items:**
- **P-TZ-1 (cross-cutting, correctness):** `formatRelative` must compute its delta
  in Asia/Jerusalem (anchor "now" and the target to the same pinned tz before
  diffing), not the device clock — especially for the day-boundary rounding that
  the expiry copy depends on.
- **P-TZ-2:** any expiry/deadline string in the chase loop and pulse must be
  derived from the same tz-pinned helper; add a unit test that a UTC instant near
  the IDT day boundary renders the correct Jerusalem day.

---

## B. NEW + GROUNDED — there is no print / PDF-of-record path; the committee-submission moment has no artifact

**Evidence (read this pass):** a grep across the entire web app for
`window.print | @media print | print:` returns **one** incidental hit (a comment
in `adapters/document.ts`). There is **no print stylesheet, no print button, no
"generate a submission packet"** anywhere.

**Why it matters to the persona:** the *entire purpose* of the product (§0) is to
reach a legal majority and then **submit the consents + the consent tally to the
planning committee (הוועדה המקומית) or the developer's lawyer.** That hand-off is a
paper/PDF reality in Israeli urban renewal. Today the only egress is a raw xlsx of
owners (§9) and individual signed-doc downloads — there is **no single
"here is where the project stands, signed by these owners, as of this date"
document of record.** The redesign elevates the consent number to the headline
(board-first) but provides **no way to take that headline off the screen** and into
the developer's actual workflow. For a low-tech user this is the difference between
"a dashboard" and "a tool that does my job": he needs a button that says
"הפק מסמך הגשה" and gets a clean, dated, share-weighted tally + owner list he can
forward. This is the natural *output* counterpart to the import *input* flow, and
it is the most persona-defining missing surface in the whole set.

**Concrete plan items:**
- **P-PRINT-1 (scope decision + net surface):** decide whether a
  committee-submission/PDF-of-record artifact is in E2 scope. It is the product's
  *raison d'être* and has zero design. At minimum spec a print stylesheet so the
  board/owner-tally page prints cleanly.
- **P-PRINT-2:** the artifact must carry the **basis-labeled** consent number
  (per the coherence seat's Tension 1 interim rule) — a printed legal claim with no
  denominator label is the single most dangerous fabrication the product could emit.

---

## 1. GAP — Project creation: the 1468-line wizard nobody opened

**Evidence:** `projects/new/page.tsx` is **1468 lines** (verified) — by far the
largest client file (next is project-detail at ~560). The a11y seat cited it only
in passing (an `ArrowRight rotate-180` wizard-nav arrow), which *proves it's a
multi-step directional wizard* — yet **no seat analyzed the flow.**

**Why it matters:** this is the **first real thing** a יזם does, and the emotional
target ("open → relax → 'exactly what I need'") is set or destroyed here. A
1468-line single-file wizard is the textbook "dense, appy, intimidating" surface
the whole redesign exists to kill — and it's guaranteed to be his first deep
interaction. The panel redesigned the screen he sees on *day 30* and ignored the
one that decides whether he reaches day 30.

**Concrete plan items:**
- **P-NEW-1 (analysis):** audit step count, cognitive load per step, the
  ArrowLeft/ArrowRight RTL correctness the a11y seat flagged `[UNVERIFIED]`, and
  whether תמורה/consent-target/track-type are progressively disclosed or dumped.
- **P-NEW-2:** apply the panel's "sentence-first, one primary action per step,
  smart defaults" rubric (the doctrine's "propose, don't ask") to the wizard — this
  is *the* place to embody "zero-setup, pre-filled from data we have."
- **P-NEW-3 (re-skin):** the file almost certainly carries a large share of the
  visual seat's "79/35" default-palette baseline — the sweep must include it
  explicitly, or the guard ratchets from a false floor (see §10 G-RESKIN-SCOPE).

---

## 2. GAP — The import flow has a real-time interaction model the Motion seat declared absent

**Evidence (re-verified this pass):** `use-import-progress.ts` has **11**
`EventSource`/`aria-live` references and `imports/[id]/page.tsx` consumes it. The
import surface drives a **live Server-Sent-Events stream** with a live-merged
progress bar (`computeImportProgressPct`), `aria-live="polite"` connection-status
copy ("מחובר/החיבור אבד/מתחבר"), a **preview/confirm pause** (`awaiting_confirm` —
validates and persists *nothing* until the manager reviews a real per-entity change
summary and confirms/discards), an **awaiting-mapping** wizard hand-off, and an
**error-triage** sub-route.

**Why it matters:**
1. **The Motion seat's "no real-time, build from scratch" premise is partly
   wrong.** There is already a battle-tested SSE + `aria-live` + live-progress
   pattern in the repo. The threshold-crossed "wow", the live pulse, and the a11y
   seat's required live-region (Gap G6) should be specced *against this existing
   pattern*, not as greenfield. The Motion doc's M1 must reconcile with
   `use-import-progress.ts` so we don't ship a *second*, divergent live-update idiom.
2. **The import preview/confirm pause is the single best "the app already thought
   for you / safe to touch" pattern in the entire product** — exactly the doctrine's
   "propose, don't ask; approve, never construct" win — and no seat held it up as the
   internal precedent (UX used AgentHome + the portal; it should add this).

**Concrete plan items:**
- **P-IMP-1:** add an import-flow analysis to the UX/IA pass; name the
  preview-confirm pause as *the* precedent for "narrate-then-approve."
- **P-IMP-2 (motion):** reconcile the motion-token + live-region spec with the
  existing `useImportProgress` SSE pattern.
- **P-IMP-3 (re-skin):** include `imports/[id]/page.tsx` + `…/mapping` + `…/errors`
  in the default-palette sweep (raw `bg-amber-*`/`bg-blue-*`/`text-emerald-*` live there).

---

## 3. GAP — The contractor share view: the יזם's primary *external* deliverable, redesigned by nobody — and it IS on the badge-leak path

**Evidence (re-read this pass):** the IA seat **explicitly scoped it out**. Reading
`(contractor)/contractor/share/page.tsx`:
- It renders the org `<StatusBadge>` (`:102-103`) — so it is **directly on the
  `status-badge.tsx` Tailwind-default leak path** the coherence seat's Tension 4
  fights over, contradicting the visual seat's "I counted all 35 files" confidence:
  this surface was never opened, so the badge leak reaches further than measured.
- It has inline `var(--navy-100)` / `var(--navy-700)` progress-bar leaks
  (`:118,126`) — the exact inline-`var(--…)` Tier-1 leak class the visual seat
  (§1.7) said was "worst in AgentHome." It's *also* here, unmeasured.
- It collapses every failure to one opaque `invalidLink` state (`:81`) and shows a
  bare `t('loading')` (`:96`) with no recovery path.

**Why it matters:** the developer's trust isn't only "do *I* see where I stand" —
it's "does the link I send my construction partner make *me* look competent." A
contractor opening a share link stuck on "loading…" forever (expired cookie, no
explanation) reflects on the developer. This is a persona surface, full stop.

**Concrete plan items:**
- **P-CON-1:** bring the contractor share view into scope — same calm/sentence-first/
  token rubric; fix the dropped lifecycle status (BE returns it, FE drops it).
- **P-CON-2 (re-skin):** add this surface's `StatusBadge` use + `var(--navy-*)`
  leaks to the visual seat's inventory; the "79/35" baseline is incomplete until
  the three unopened surfaces (this, project-new, imports) are scanned.
- **P-CON-3 (error UX):** the "dead link" terminal state needs the calm,
  recovery-oriented treatment, not a bare opaque error.

---

## 4. GAP — Onboarding / empty-org / first-run: the most fragile moment, unanalyzed

**Evidence:** `(auth)/signup/page.tsx` and `accept-invite/[token]/page.tsx` exist;
**no seat opened them.** The UX emotional journey starts at a *populated* org — it
never covers the **day-one empty state**: zero projects, owners, imports.

**Why it matters:** for a low-tech, anxious user the empty product is *more*
intimidating than the full one. The redesign into a "needs you now" pulse + triage
list is actively *worse* on an empty org if not designed for it: an exception list
with nothing in it + a pulse with no data = a void. The data seat's "calm-home
reward" copy ("הכול רגוע · הכול זז יפה") is **dishonest for a brand-new org**
(nothing is "moving nicely"; there's just nothing). Empty-because-done and
empty-because-new are different states needing different copy — and the doctrine's
"the app already did the thinking" must extend to "…and it tells me my *first*
step."

**Concrete plan items:**
- **P-ONB-1:** design the **empty-org home** as a distinct state — a single proposed
  first action ("ניצור את הפרויקט הראשון" / "נייבא בעלים מאקסל"), per the doctrine's
  "propose, don't ask" — not the "everything's calm" reward.
- **P-ONB-2:** audit signup + accept-invite for the low-tech rubric; invite-acceptance
  is how the developer's *team* (agents/viewers) first touch the product.
- **P-ONB-3:** define **per-entity empty states** (projects, owners, imports, tasks)
  — the UX seat specced this only for the board.

---

## 5. GAP — The "find the owner" half of the workflow (discovery / field-work) has no FE

**Evidence (re-verified):** a grep for `discovery` across the **entire web app**
returns **2 hits, both incidental comments** (`ownerships/page.tsx`,
`ownership.vm.ts`). The `discovery_records` table (migration 0066:
`not_visited | no_answer | spoke_to_occupant | owner_identified | refused`, with
`notes`) has **no FE surface** — no way to record a field visit, no way to see a
building's discovery state.

**Why it matters:** the יזם's job has two halves — (1) *find out who legally owns
each apartment* (the נסח/discovery half) and (2) *get them to sign*. The panel
redesigned half (2) end-to-end and **left half (1) as a backend-only module with no
UI.** For פינוי-בינוי, discovery is where the developer spends his *first* months.
The domain seat's "owner SHELL = discovery in progress, not a gap" and the data
seat's "interim 'why' = `discovery_records.status`" are both **unbuildable in the
UI because the surface that would show/enter them doesn't exist.**

**Concrete plan items:**
- **P-DIS-1 (scope decision):** decide explicitly — discovery in E2 scope or
  post-MVP? The panel never made this call; it just didn't notice the surface was
  empty.
- **P-DIS-2:** the board's SHELL state and the interim "why" substitute both need a
  data-entry surface; flag that they're un-shippable until it exists.

---

## 6. CORRECTION + GAP — Offline/connectivity: the prior draft overstated "handled NOWHERE"; the real story is *half-handled and silent*

> **This corrects the prior completeness draft**, which claimed the TanStack default
> is `retry: 3` and offline is handled "nowhere." Both are stale.

**Evidence (read this pass — `_components/query-provider.tsx:55-66`):** the real
config is *already* connectivity-aware in part:
- Queries `retry` only **genuine network failures** (a raw `Error`), and surface
  any `ApiClientError` (definitive 4xx/5xx) **after the first attempt** — not blind
  `retry: 3`. Backoff is capped tight (250ms→2s).
- **Mutations are `retry: 0`** because `postIdempotent` mints a fresh UUID per call
  (double-create on retry). So the chase-loop send does **not** silently retry.
- There is even an **MSW offline-dev mode** (`NEXT_PUBLIC_MSW=1`, per `apps/web/CLAUDE.md`).

**What is still genuinely missing (the real gap):** there is **no
`navigator.onLine` signal, no offline banner, no `networkMode` config, and no
"queued, will send when back online" state** (verified: zero hits across
app/components/hooks/lib). So the failure mode is not "blind retry" — it's **silent,
honest failure with no user-facing explanation**: the user taps "remind", the
mutation fails once (retry 0), an inline error appears, and there is **no "you're
offline" framing and no recovery affordance.**

**Why it still matters to the persona:** the UX seat anchors the persona as "on his
phone, in a parking lot, flaky field connection." The chase loop becomes "one tap →
error → did it send? do I tap again?" — and because mutations don't retry, a flaky
connection genuinely *drops* the send with only a generic inline error. The
*exact* anxiety the redesign exists to remove, manufactured on a bad connection.

**Concrete plan items:**
- **P-OFF-1 (cross-cutting):** a global connectivity-aware banner ("אין חיבור · ננסה
  שוב כשתחזור הרשת") + TanStack `networkMode: 'offlineFirst'`/paused-mutation handling
  so a chase send *pauses* rather than fails-with-generic-error.
- **P-OFF-2:** the chase-loop optimistic flip (Motion §5) MUST distinguish
  "sent, confirmed" from "queued/failed offline" — an optimistic "נשלחה תזכורת" that
  silently dropped offline is a **lie the doctrine forbids.** The Motion optimistic
  spec assumed online.
- **P-OFF-3:** surface the idempotency safety ("כבר נשלח") on the double-tap path
  instead of a second generic error.

---

## 7. CORRECTION + GAP — Error/loading boundaries exist; the gap is the *contradiction* and the missing in-data-state contract

> **Corrects the prior draft's "no error handling" framing.** App-level boundaries
> DO exist: `app/global-error.tsx`, `app/[locale]/error.tsx` (a careful,
> token-themed, digest-only, never-leak-the-stack boundary), `app/not-found.tsx`,
> `app/[locale]/not-found.tsx`. Verified.

**The real gap is two-fold:**
1. **Zero per-route `loading.tsx`/`error.tsx` under `(dashboard)`** (verified:
   `find … -name error.tsx -o -name loading.tsx` = 0). Every page does its **own**
   in-island loading/error/empty state, so the experience is *inconsistent
   per-surface*: `SignatureProgressBoard` returns bare `null` on error (UX §2.3),
   the contractor view collapses to one opaque `invalidLink`, the manager home shows
   bare "—", while the import page has a *good* granular taxonomy (not_found vs
   loadFailed vs not_cancellable vs confirmFailed) **that no seat held up as the
   model to generalize.**
2. **The panel contradicts itself** (also caught by the coherence seat): UX says
   "the board must never be silent," FE-arch says "codify silent-null on error." The
   *right* model already ships in the import page; nobody unified it.

**Why it matters:** a fearful user reads a blank panel as "broken / I lost my data."
"Blank = broken" is the core anxiety. The `error.tsx` boundary only catches *thrown*
render errors — a *failed fetch that returns null* never throws, so it slips past
the boundary entirely and renders as a silent void. That is precisely the
board/home/contractor case.

**Concrete plan items:**
- **P-ERR-1 (resolve the contradiction):** kill "silent null on error"; adopt the
  import page's granular taxonomy as the app-wide loading/error/empty contract.
- **P-ERR-2:** a single `<DataState>` wrapper (loading skeleton / calm error+retry /
  403 access-denied / guided empty) — the panel named all four pieces across three
  docs; nobody specced the one component that enforces them. It must wire the a11y
  seat's live-region (Gap G6) so a screen-reader user hears the state change.
- **P-ERR-3:** distinguish **403 (lack permission — muted, no retry)** from
  **5xx/network (retry helps)**, code-enforced, not prose.

---

## 8. GAP — Scale-at-N was specced for the *home*, abandoned for every full-power list

**Evidence:** the panel's scale story is entirely "home shows 5, full list one tap
away." But the lists themselves were barely examined for real-N behavior:
- Projects-list search is **client-side over the current page only** (UX §2.2, IA
  §4) — flagged, but the fix (server search = a BE slice) was deferred with no
  owner, and the **same page-local filtering almost certainly applies to owners,
  tasks, notes, signature-requests** — nobody checked. An org with 2000 owners
  across 40 projects (realistic for a multi-project יזם) has an owners table the
  panel said to *keep* that paginates 25 at a time with page-local filter — i.e.
  *unusable* at real N, uncosted.
- The signature-requests "chase queue" — even after adding name+verb — is a flat
  list. At 200 pending requests, a flat list with no group/sort-by-urgency is a
  wall. The panel specced the *row*, not the *list at scale*.

**Why it matters:** North Star principle 3 is "triage by exception **at scale**."
The panel honored it for the home and abandoned it for every list the developer
actually lives in. "One tap to the full list" is hollow if the full list is a
25-row-paginated, page-locally-filtered, unsortable dump.

**Concrete plan items:**
- **P-SCALE-1:** audit *every* list (owners, tasks, notes, signature-requests,
  documents, members, audit) for client-side-page-only filtering.
- **P-SCALE-2:** the server-search BE slice needs an owner + scope decision — it
  gates the honesty of *every* list's search box.
- **P-SCALE-3:** the chase queue needs **list-level** triage (sort by
  expiring-soonest / stalled-longest, group by project) — spec the list, not the row.

---

## 9. GAP — PII *in motion* (omnibox, export, signed-doc download) — key cases missed

The a11y/IA seats covered PII-at-rest (masking, `<NameDisplay>`, POST-body search).
PII **in motion** through the *new* surfaces has holes:
- **The global search omnibox (IA §3.3)** resolves owner name/national_id via
  `POST /owners/search`. Nobody specced the **results dropdown** as a PII surface: it
  renders in the topbar over every screen, including when the developer is
  screen-sharing with his lawyer. No "auto-clear / no history" spec; the bidi
  `stripBidiOverrides` rule was never extended to dropdown `aria-label`s.
- **Export to xlsx** streams owner PII out of the RLS/encryption boundary into the
  developer's Downloads/email — the **only bulk PII egress** — with no "this file has
  personal data" cue. The redesign *elevates* export (§B); it's design-invisible.
- **Signed-doc download** — a signed consent is forensic PII; the download UX was
  never designed.

**Concrete plan items:**
- **P-PII-1:** spec the omnibox results as an ephemeral PII surface (no persistence,
  `stripBidiOverrides` on labels, `view_owner_pii`-gated national_id branch).
- **P-PII-2:** an honest "this export contains personal data (תעודות זהות, פרטי קשר)"
  cue on xlsx export, the committee packet (§B), and signed-doc download.

---

## 10. Smaller-but-real completeness gaps (each a plan line)

- **G-CONCURRENCY — two team members, one project.** The persona is "a small team"
  and `refetchOnWindowFocus: true` is on (verified) — but no seat addressed **two
  users chasing the same owner simultaneously.** Agent A sends a reminder; Manager
  B's stale board still shows "not sent" until refocus. The optimistic chase loop
  (only `use-apartments`/`use-notifications`/`use-org-settings` have `onMutate`
  today — verified) assumes a single actor. Spec the stale-on-refocus behavior and
  whether the resend's 409-guard surfaces calmly to user B ("כבר נשלח על ידי [שם]").
- **G-NOTIF-DESIGN — notifications got "demote to a bell," never a design.** A
  *signature product's* notifications ("אורי חתם!", "בקשה פגה") are the developer's
  **passive momentum feed** — the doctrine's "act in background and notify, don't
  task." The Motion seat noted the system doesn't even *emit* a threshold-reached
  notification — the most celebratory event has no notification, and nobody planned
  to add one. This is the backend half of the doctrine's "notify, don't task."
- **G-CALENDAR — the stub was correctly killed, but the *populated* calendar was
  never designed.** `tasks.due_at/scheduled_at` are real. "What do I need to do
  today" (visits, meetings, deadlines) is core to the persona; hiding the stub leaves
  a real need unmet, not just an anti-pattern removed.
- **G-TENANT-OTP — the resident's first touch.** `tenant/login` (OTP) and the
  `/sign/:token` flow are the *counterparties'* experience — even less technical than
  the יזם. A resident who can't complete OTP never signs, and the developer's project
  stalls. Not the יזם's screen, but **his outcome.**
- **G-MOTION-PERF — the Motion seat's count-up / bar-fill on the home ignores the
  perf baseline** (MEMORY: warm 200ms; PR #47 limited Heebo to 3 weights *for LCP*).
  Animating the hero number on every home load risks the first-paint cost the perf
  work fought. No seat reconciled motion with the perf budget.
- **G-RESKIN-SCOPE — the "79/35" baseline excludes three large unopened surfaces**
  (project-new §1, imports §2, contractor-share §3 — the last verified to use
  `StatusBadge` + `var(--navy-*)`). The real count is **higher than 79**; the new
  guard must be re-measured *after* including them, or it ratchets from a false floor.

---

## 11. The prioritized completeness backlog (what must become plan items)

Ranked by persona impact × certainty-of-occurrence.

| # | Gap | Why it's a real miss for the יזם | Type |
|---|---|---|---|
| **C0** | **Relative-time tz bug (§A)** | The chase loop's core "פג מחר/היום" can be confidently wrong; a fabricated-feeling signal the doctrine forbids. One-helper fix. | Cross-cutting, **P0** |
| **C1** | **Committee submission / print-of-record (§B)** | The product's *raison d'être* — taking signed consents to the וועדה — has no artifact and no print path. | Net surface, **P0** |
| **C2** | **Resolve silent-null vs never-silent; one `<DataState>` contract (§7)** | The panel contradicts itself; "blank = broken" is the core anxiety; boundaries exist but don't catch null-returns. | Cross-cutting, **P0** |
| **C3** | **Empty-org / first-run (§4)** | First impression for a low-tech user; the new pulse-home is *worse* on an empty org if not designed. | Net surface, **P0** |
| **C4** | **Offline banner + paused mutations (§6)** | Field reality; mutations don't retry, so flaky connections silently drop the chase send with a generic error. | Cross-cutting, **P1** |
| **C5** | **Project-creation wizard (1468 lines) (§1)** | The first deep interaction; the densest screen; sets the emotional tone. | Net analysis, **P1** |
| **C6** | **Scale-at-N across all lists (§8)** | "Triage at scale" abandoned everywhere except the home. | Cross-cutting, **P1** |
| **C7** | **Contractor share view (§3)** | His primary *external* deliverable; on the badge-leak path + `var(--navy)` leaks + a dropped-status bug. | Net surface, **P1** |
| **C8** | **Import flow + its SSE/preview model (§2)** | Disproves the "no real-time" premise; the best "safe-to-approve" precedent in the app. | Net analysis, **P1** |
| **C9** | **PII-in-motion: omnibox, xlsx, signed-doc (§9)** | The bulk PII egress points the redesign *elevates*; design-invisible today. | Cross-cutting, **P1** |
| **C10** | **Discovery / field-work FE (§5)** | Half the workflow ("find the owner") has no UI; the SHELL + interim "why" are unbuildable without it. | Scope decision, **P2** |
| **C11** | **Notifications-as-momentum + populated calendar + concurrency + tenant OTP (§10)** | The passive "the app nudges me / plans my day" layer + the counterparty outcome + multi-user reality. | Net analysis, **P2** |

---

## 12. One-paragraph summary

The panel did deep, excellent work on the **three screens where the developer reads
his status** and on the **token re-skin mechanics** — but it scoped itself to ~10 of
~64 routes and missed the **input, sharing, onboarding, and field-work halves of the
product**, plus cross-cutting realities no seat owned. This pass adds two
*entirely new, code-grounded* gaps the prior draft also missed: a **relative-time
helper that pins no timezone** (`lib/format.ts` `formatRelative`, used by 18
adapters) so the chase loop's "פג מחר/היום" can be confidently wrong against the hard
"display Asia/Jerusalem" rule, and the **total absence of a print/PDF-of-record
path** for the committee-submission moment that is the product's whole purpose. It
also *corrects* the prior draft on two over-claims: offline is **half-handled and
silently-failing** (mutations `retry:0`, no blind `retry:3`, but no offline banner),
and error boundaries **do exist** (`error.tsx`/`not-found.tsx`) — the real gap is
that they don't catch silent null-returns and there's no unified `<DataState>`
contract, which the panel actually contradicts itself about. The redesign as
specified would ship a beautiful mission-control sitting on an un-redesigned
1468-line creation wizard, an un-analyzed import flow that disproves the "no
real-time" premise, a contractor share-view nobody opened (with the same badge +
`var(--navy)` leaks the visual seat thought it had fully counted), an empty-org
first-run the new pulse-home makes *worse*, and a chase loop that can tell the
developer the wrong day.
