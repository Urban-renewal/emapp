# Definition of Done (UX) — the locked, binary spec that makes "perfect" converge

## Why this exists (the 3rd-time-asking problem)

"Make it more organized / clearer / easier" is a **direction**, not a **destination** — it has no end, so every
agent makes it "better" and you're still not satisfied, forever. The fix is to stop asking for a _gradient_ and
define a _target_: a **closed, binary (yes/no), technophobe-grounded acceptance spec**, applied to **every page
× every role**. When the matrix is all-YES, the product is DONE **by definition** — not by anyone's opinion.
You do it ONCE: lock the spec → audit every cell → build every NO → re-audit → all-green → done. Finite.

Two things make it converge (both are required):

1. **A fixed binary target** — criteria are yes/no, not better/worse. A gradient never ends; a checklist does.
2. **A stable oracle** — _your_ judgment, written as a reproducible test you (or anyone) apply identically to
   every page and get the same answer. Your in-the-moment "I don't connect with it" is real but moves; the
   written test below freezes it so it can be measured + verified.

## The oracle — your 5-second technophobe test (apply to every page, as every role)

Open the page as the role. Within ~5 seconds, without scrolling a wall, reading every row, or decoding anything,
can a non-technical person answer **all three**:

- **(a) Where am I / what's the state?**
- **(b) What needs ME right now?**
- **(c) What's my ONE next action, and what will it do?**

If any answer is "no / I'd have to hunt" → the page FAILS. This is the heart of the spec; everything below makes
it precise + checkable.

## The locked criteria (binary; a CLOSED list — DONE = every applicable one = YES, per page × role)

For each (page × role) from the coverage inventory (`docs/PRODUCT-AUDIT-HARNESS.md`), score **YES/NO** — there is
no "WEAK"; WEAK = NO (that's what forces convergence):

1. **C1 5-second test** — passes (a)+(b)+(c) above. [Y/N]
2. **C2 No flat wall at scale** — at 100 projects / 1000s of rows it stays scannable: grouped, attention-first,
   sort/filter, progressive disclosure. Not an undifferentiated list. [Y/N]
3. **C3 Fleet level (where the data spans projects)** — there's an org-of-many-projects rollup/portfolio view,
   not only per-project granularity. [Y/N or N/A]
4. **C4 One-click decision** — every pending decision states, in plain Hebrew, what's happening + WHY I see it +
   what the action will DO, and is actionable in one click, zero jargon, zero prior context. [Y/N]
5. **C5 Legible non-happy states** — empty, loading, and error each say in plain words what happened + what to do
   next. No dead-end, no raw error, no silent nothing. [Y/N]
6. **C6 Role-fit** — this is the right surface for THIS role's actual job + mental model (contractor sees a
   contractor's world; tenant sees only their own record, plainly; agent sees their assigned projects). [Y/N]
7. **C7 Autonomy / minimum-actions** — the system proposes / auto-assigns / chases; the user confirms, doesn't
   hunt or do manual per-item steps. [Y/N]
8. **C8 Outcome visible** — after an action the situation visibly changes for every affected party (not just a
   2xx). [Y/N]
9. **C9 Action matches the STATE** — the one-click action offered is the CORRECT next step for the entity's
   ACTUAL current state (from the situation model below), NOT a generic per-feature button. A "send reminder"
   CTA when the real blocker is a missing נסח / an opted-out owner / an unsigned co-owner FAILS. [Y/N]
10. **C10 COMPLETE situation** — the picture captures the WHOLE state across ALL dimensions that define the
    entity (signatures · documents · tasks · parties + who-blocks-whom · timeline/stage · consent), not one axis.
    A single-axis "picture" (e.g. signatures only) FAILS — it looks like a situation picture but isn't. [Y/N]
11. **C11 One focal point / calm order (anti-מבולגן)** — a single clear "the most important thing now," with
    everything else progressively disclosed; NOT N equal-weight stacked sections competing for attention. [Y/N]
12. **C12 Sub-second (anti-איטי)** — every interaction (nav/click/submit) is <1s warm, measured in ms. [Y/N]

**Why C9–C12 were missing — the root cause of "still מבולגן / לא-מלא / מתסכל" (v2, 2026-06-25):** C1–C8 are
component-level; a page passes them and still feels wrong because the picture and the action are assembled
**per-axis, not derived from ONE model.** The structural fix: every entity (project · owner · the org · each
role's world) has a **SITUATION MODEL** that computes its COMPLETE state across all dimensions AND the single
right-next-action for that state. The at-a-glance picture (C10) and the matched one-click action (C9) both
render from that ONE model — this is the autonomous-system vision (the system KNOWS the situation + the right
move). C11/C12 make the result calm + fast. So "frustrating" is no longer a vibe — it decomposes into the
measurable failures C9 (mismatch) / C10 (partial) / C11 (clutter) / C12 (slow).

A page × role is **DONE** when every applicable criterion is YES. The product is **DONE** when every cell in the
coverage matrix is DONE. That is the definition of "perfect" — finite, exhaustive, and binary.

## The golden exemplar (concrete > abstract)

Pick ONE surface that already passes all criteria and declare it the reference — the bar every other page must
match. Candidate: the mission-control **home** (board-first: pulse → ranked attention → fleet tiles → one-click
chase). "Make it like the home, measured by C1–C8" is concrete; "make it clearer" is not. If the home itself
fails a criterion at scale, fix it FIRST — the exemplar must be genuinely perfect.

## The process — do it ONCE, then it converges

1. **LOCK the spec (your one job).** You approve C1–C8 (+ the exemplar). This is the contract. After this, no one
   says "make it better" — they say "C4 is NO on /owners as agent → fix it." The target stops moving.
2. **Audit every cell** — run the harness (`PRODUCT-AUDIT-HARNESS.md`); it scores C1–C8 per page × role → the
   matrix. The output is a finite list of NOs.
3. **Build every NO** — through the gated loop (capped/disjoint builders → independent red-team → deep walk).
4. **Re-audit** — re-run the harness. The NO-count must strictly decrease each wave. Repeat until all-green.
5. **DONE = all-green.** You verify with certainty by spot-checking ANY cell yourself with the 5-second test —
   reproducible, so you get the same answer the harness did.

## How you get CERTAINTY (not vibes)

- **Binary** → reproducible (no judgment gradient).
- **Exhaustive** → the matrix is every page × role from code (no page missed).
- **Self-verifiable** → you can run C1–C8 on any page in minutes and confirm.
- **Convergent** → NO-count strictly drops to zero; all-green = done, full stop.
- **Versioned, not moving** → if you later want a NEW criterion, that's a deliberate **spec v2** bump (dated),
  not an endless gradient. The spec is the only thing that may change, and only on purpose.

This is how you do it once, fully: lock C1–C8, drive the matrix to all-green, and you'll _know_ it's complete —
because "complete" is now a defined, checkable state, not a feeling.
