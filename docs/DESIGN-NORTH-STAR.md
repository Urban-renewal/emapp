# EMAPP — Design North Star (E2 product redesign)

> The single rubric every E2 slice is measured against. Owner-set 2026-06-18.

## Who we design for
The **יזם (real-estate developer)** and his team — domain experts with **low
technical ability**. They are intimidated by dense, "appy" interfaces. The win
is when the developer opens a screen, **relaxes, smiles, and says "this is
exactly what I need."** Relief, not a learning curve.

## THE CENTRAL DOCTRINE (owner, 2026-06-18) — the system does the work; the developer just approves
> The dominant lens. The five principles below SERVE this. We build the **developer's
> (יזם) operator side**, and our users have real **technophobia** — the smallest
> complication and we lose them. So the measure of a good screen is **how FEW actions
> it demands** while staying **fully capable, reliable, and trustworthy** — and how
> strongly it feels like **a system that already understood them and did the work.**

Every surface follows:
1. **Propose, don't ask.** Never "what do you want to do?" — always "do this?" with
   one tap. The system pre-decides recipients/message/timing/defaults; the developer
   **approves, never constructs.**
2. **Act in the background; notify, don't task.** Routine chasing (reminders, expiry,
   holdouts) runs automatically on a cadence; only the true exceptions that need a
   human (an objection, a call) surface. The machine handles the 95%, hands up the 5%.
3. **Zero-setup, smart defaults everywhere.** No blank field he must understand, no
   config step; pre-fill from data we already have; every input has a sane default.
4. **One tap, never a multi-step form** for the core loop.
5. **Speak like a competent assistant reporting what IT did:** "כמעט שם — חסרה חתימה
   אחת, של אורי מדירה 7. שלחתי לו תזכורת אתמול."
6. **Reversible by default, undo over confirm** — mistakes are cheap (soft-delete
   philosophy in the UX) so an anxious user acts without fear.
7. **Never a dead-end** — every problem shown WITH its fix (disable-with-reason +
   remedy), never a bare error.

Emotional proof: he opens the app, sees it **already chased, already sorted, already
knows what's left**, and just taps "yes." Relief + "it gets me."

## The five principles
1. **Power underneath, calm on top.** Full control exists — but it is revealed
   **progressively** (tap to go deeper), never dumped on one screen.
2. **Plain Hebrew, zero jargon.** Sentences, not metrics-soup. "כמעט שם · חסרה
   חתימה אחת", not "64% · SLA breach". Numbers serve words, not the reverse.
3. **Triage by exception (scale).** An org has MANY projects. The home shows the
   ~5 that **need you now** + a short pulse — never a dump of all N. The full
   searchable/filterable/sortable list (full power) is one tap away.
4. **Motion + the human "why", woven in calmly.** A status board is a photo; a
   manager needs a movie. Surface momentum ("זז יפה, +2 השבוע" / "אין תנועה 18
   יום") and the human bottleneck ("3 בעלים מתנגדים" / "אורי דירה 7 לא חתם") — in
   plain words, not charts.
5. **Built to be re-skinned.** Visual polish is the owner's designer's domain.
   Everything is **token-themed** (CSS design tokens for color/space/radius) and
   **componentized**, so the designer can change the skin without touching
   structure, data, or interaction.

## Emotional target
Open → "I instantly see where I stand and what to do today" → calm + confident +
a little delighted. The app already did the thinking.

## What this is NOT
Not a dense dashboard of cold metric cards. Not "all projects" on the home. Not
fabricated data — if a signal (e.g. an owner's objection reason) isn't in the
backend yet, omit it or flag it as a follow-up; never fake it.

## Slices (each: green-gate + real-Chrome verify against this rubric)
- **E2.1 — Home as signature mission-control** (calm, exception-triage at scale).
- **E2.2 — Project page, workflow-first** (buildings → apartments → owners, with
  per-owner signature status + who's stuck).
- **E2.3 — Signature-chasing flow** (the reminder/expiry/holdout loop).
- **Backend follow-ups** for the "why" layer (owner objection/status field) — a
  small slice; do NOT fake it in the meantime.
