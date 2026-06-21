# EMAPP E2 — Master Plan (product redesign)

> Synthesis of the 6-expert design panel (`01`–`06` in this folder) +
> `DESIGN-NORTH-STAR.md` + the E1 audit (`docs/BACKLOG.md`). 2026-06-18.
> Every slice: green-gate + real-Chrome verify against the north star; never
> fabricate a signal; design is owner-approved before build.

## 1. Vision (one line)
A **calm signature mission-control** for a non-technical developer: it already
knows what matters and what to do today; full power is one tap away, never on
the surface. Open → relief → "this is exactly what I need."

## 2. What all 6 experts converged on
- **The plumbing works (E1).** This is a *product/design* redesign, not a
  bug-fix. The reference for "good" already exists in-app: the tenant portal.
- **~9 of 13 signals are buildable NOW** from existing data (momentum,
  distance-to-threshold, pulse buckets, expiring) — they need aggregation +
  surfacing, not new capture (`04-data-feasibility`). The home draft (#411)
  already proves the calm shell on real data.
- **Only ONE genuine new-data gap:** the human "why"/objection layer
  ("3 בעלים מתנגדים", an owner's objection reason). One small `ADD COLUMN`.
  Until it ships → **omit the phrase, never fake it** (all 6 docs agree).
- **Two real bugs surfaced (not design):**
  1. **Consent-counting correctness (P0, domain):** consent is counted as
     apartments-consented / total, ignoring the **registered ownership share**
     (`ownerships.share_numerator/denominator`, stored, unused). The legal
     תמ"א/פינוי-בינוי majority is multi-dimensional (heads + ownership-share +
     per-building). So the headline 66% can be **legally wrong**. (`01-domain`)
  2. **Re-skin leak (small, visual):** `status-badge.tsx`/`button.tsx` use
     Tailwind default palette (`bg-amber-100`, `bg-red-600`), NOT the EMAPP
     ramps — a brand re-skin silently misses status pills; the ratchet doesn't
     catch class-name palette. (`05-visual-system`)

## 3. IA — workflow-first (`03-information-architecture`)
- **Spine:** project → buildings → apartments → owners → signatures → threshold.
  Reorganize the flat entity lists around it.
- **Primary nav 14 → ~5** (Home · Projects · Owners · Imports · Tasks).
  Signature-requests/documents/notes move INTO the project (tabs, **board
  first**). Contractors/messages/notifications → utility cluster. Members/audit/
  settings → one gated Admin group. Add a **global search omnibox**
  (POST-body, `view_owner_pii`-gated — national_id is PII).
- **Project page:** open on the **signature board**, not the empty residents
  tab (fixes the E1 finding). The board IS the page.
- **Scale:** home = triage-by-exception (~5, capped, rest folded into the
  pulse); projects-list = full sort/filter/saved-views by urgency/momentum/
  threshold-distance.
- **Migration = re-composition, not re-routing:** no route deleted, deep links
  + role-gating intact (gating lives in middleware + AuthorizationGuard +
  useHasPermission, not the nav grouping).

## 4. Design system — re-skinnable for the owner's designer (`05`,`02`)
- **3-tier token layering:** primitive tokens → semantic aliases → components
  consume aliases ONLY. Designer re-skins by editing Tier 1; dark mode +
  per-org branding fall out for free.
- **Fix the gaps:** add a real **spacing scale** (only `--pad` today — blocks
  "generous whitespace") + a tokenized **type scale** (Heebo, hierarchy via
  size/weight/color, no caps/italics). Unify the 3 forked color palettes.
- **Hero component set** (token-driven, RTL `ms/me`, WCAG AA, `<NameDisplay>`
  bidi, color-never-the-only-signal): `StatCard`, `ThresholdProgress` (the bar +
  66% marker), `ActionCard` (triage), `ProjectRow`, `StatusPill` (replaces the
  leaky status-badge), calm empty/loading/error.
- **Locked visual direction:** mockup v4 — meaningful metric cards + per-project
  progress bar WITH the 66% threshold marker + plain momentum/why phrase +
  "needs you now" triage + scale via "N of M" + "all projects" link.

## 5. UX rules (`02`) — enforce per slice
3-depth max · sentence-first, number-as-evidence · home-is-a-to-do-list ·
every status carries a verb + a name · undo over confirm · disable-with-reason ·
the chase loop is identical from every surface · ~5 engineered "wow" moments
(finish-line "כמעט שם", threshold-crossed, one-tap holdout chase, the calm-home
reward, "already thought for you"). Kill: vanity dashboard, buried board, empty
residents tab, calendar stub, test-chat, incoherent demo data.

## 6. Backend — the smallest slices (`04`)
- **B1 — `GET /org/signature-pulse`** (NO migration): one aggregate endpoint
  powering the 4-bucket pulse + the ~5 triage rows + velocity/stalled/expiring
  (copy the existing `orgStats` multi-subquery + agent-scope CTE). Highest
  leverage; unblocks momentum/stalled/expiring honestly.
- **B2 — the "why" layer (the only migration):** `ALTER TABLE signature_requests
  ADD COLUMN decline_reason text` + widen status CHECK + a manager "mark
  objection" action (mirror the 0063 'expired' add). Gate-6.
- **B3 — consent correctness:** ownership-share-weighted + per-building consent
  in `signatureProgress`. Legal-correctness; needs a domain decision on the
  exact rule per project type. **Surface to owner.**

## 7. Roadmap (recommended sequence)
| Slice | What | Depends on | Gate |
|---|---|---|---|
| **E2.0** | Design-system foundation: 3-tier tokens + spacing/type scales + hero components + fix the status-badge/button palette leak | — | green-gate; ratchet baseline drops |
| **E2.1** | Home mission-control — align the #411 draft to v4 + the hero components | E2.0 | browser-verify vs north star |
| **B1** | `/org/signature-pulse` endpoint | — (parallel) | api build + docs regen |
| **E2.2** | Project page workflow-first (board-first; spine drill: buildings→apartments→owners→signature status) | E2.0 | browser-verify |
| **E2.3** | The chase loop (remind / expiry / holdout) — identical from every surface | E2.2, B1 | browser-verify |
| **IA** | sidebar 14→5, board-first tabs, global search (POST, PII-gated) | E2.0 | role-gating regression check |
| **B2** | "why"/objection field + mark-objection action → unhide the "why" phrase | — | Gate-6 migration |
| **P0-FIX** | consent ownership-share correctness | owner decision on the rule | tests + Gate-6 |

## 8. Decisions needed from the owner
1. **Consent rule (P0):** confirm the legal counting per project type
   (heads vs ownership-share vs per-building) so B3 is correct. ← blocking for
   correctness.
2. Visual direction v4 = locked? (assumed yes.)
3. Scope/sequence: start with **E2.0 (design-system foundation)** then E2.1, or
   land the #411 home draft first behind the foundation?

## Reference
`01-domain-workflow` · `02-ux-low-tech` · `03-information-architecture` ·
`04-data-feasibility` · `05-visual-system` · `06-competitive-patterns` ·
`../DESIGN-NORTH-STAR.md` · `../BACKLOG.md`.
