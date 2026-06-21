# E2 Design — LOCKED owner decisions (2026-06-18)

All five confirmed by the owner; the council's recommended options were adopted.
These govern the entire E2 build. Full reasoning: `00-MASTER-PLAN-V2.md` + the
8 expert docs + 3 critiques in this folder. Doctrine: `../DESIGN-NORTH-STAR.md`
("the system does the work; the developer just approves").

## 1. Consent counting = SHARE-WEIGHTED
The legal headline % + threshold gate = **% of registered ownership**
(`ownerships.share_numerator/denominator`, DB-guaranteed to sum to 1, migration
0065) — NOT the current binary `apartmentsConsented/totalApartments`. Heads +
per-building shown as supporting lines.
- **INTERIM BINDING RULE (until lawyer confirms the statutory %):** no slice
  renders a bare % as a legal claim — every % carries its denominator/basis
  label and leads with the plain-Hebrew count sentence. board-first amplifies
  this number, so this rule is non-negotiable in the meantime.
- **Still needs (domain/lawyer, NOT a code claim):** exact statutory % (66 vs 67,
  pre-2023 80% grandfathering) + whether a partially-signed apartment's
  signed-share counts. Supersedes the binary calc in `signatureProgress`.

## 2. Automation = PROPOSE → ONE-TAP-APPROVE now; full-auto via B3 later
- Ship the honest one-tap send NOW (the `נשלחה תזכורת` endpoint already exists).
- Build **B3** (recurring worker: expiry sweep + time-based notifications +
  auto-reminders — NO migration) as the fast-follow that makes real background
  auto-chasing true, then unlock the autonomy copy.
- **HARD GUARDRAIL:** the API has ZERO scheduler/cron today. Do NOT show any
  "the system chased / נזכיר שוב / שלחנו 3 תזכורות" copy until B3 ships.

## 3. Build scope = FOUNDATION-FIRST + converge the home
- **Wave 0 (foundation):** 3-tier tokens (primitive → semantic → components) +
  the two missing scales (spacing + type, Heebo) + the FUSED ActionToast/
  live-region primitive + the relative-time tz fix + a unified DataState
  contract. Fix the 3 shipping token bugs (dead `bg-card` ×41 files, contradictory
  `--r-lg`, status-color leak) + close the palette leak at TRUE scope (79
  occurrences / 35 files: VM + 6 adapters + 3 specs) + a class-name guard.
- **E2.1:** converge `ManagerHome` off its ad-hoc raw-fetch (no Zod/TanStack,
  divergent env var) onto the RSC-prefetch Pattern A — cache-correct + restores
  post-mutation invalidation.

## 4. Nav = sidebar 14→5 + global search SAME wave; merger deferred
- Sidebar regroup 14→~5 now (zero-route-risk; gating stays in middleware +
  AuthorizationGuard + useHasPermission). Global search omnibox (POST body,
  `view_owner_pii`-gated) ships in the SAME wave so no demoted destination is
  left with neither a nav line nor search.
- board-first = the project-tab DEFAULT + ORDER only. The project-tab MERGER
  (docs+signature-requests; tasks+notes→Activity) is a SEPARATE later slice
  (FE-arch risk pare-back).

## 5. Brand = NAVY `#0b2545`
`--brand → --navy-900`. The partner's institutional brand; AA-safe white-on-navy.
Resolves the teal(shadcn `--primary`)/navy(`.btn-primary`) split — one-token change.

---
## Roadmap (dependency-ordered, from the master plan)
Foundation wave (§3) → zero-BE structural wave (board-first default, sidebar 14→5,
global search) → backend-gated surfaces (B1 no-migration pulse endpoint → home
mission-control → board content → the ONE chase loop) → B3 autonomy worker + B2
"why"/decline_reason migration → the "movie"/motion layer.
Every slice: green-gate + real-Chrome verify vs the north star; the hard
DO-NOT-FABRICATE register enforced (no signal rendered that the backend can't back).
