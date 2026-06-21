# 04 — Data & Feasibility Analysis (E2 "signature mission-control")

> Grounds `docs/DESIGN-NORTH-STAR.md` in what the backend can actually serve
> **today**. For each signal the redesign wants, this maps it to one of:
> **EXISTS** (a field/endpoint already on the wire) · **DERIVABLE** (computable
> from data already stored, no migration — just a query/endpoint or FE math) ·
> **NEEDS-BACKEND** (a new column / enum / endpoint / migration).
>
> Cardinal North-Star rule: **never fake a signal.** If it's NEEDS-BACKEND, the
> UI omits it until the slice lands. This doc scopes the smallest such slice.
> READ-ONLY analysis — cites schema/type/service files; no code changed.

---

## 0. The data model, briefly (so the table below is legible)

The "signature" domain is **two tables**, both in
`packages/db/src/schema/artifacts.ts`:

- **`signatures`** — the encrypted-SVG forensic blob (`document_id`, `owner_id`).
- **`signature_requests`** (migration 0021) — the workflow row that the whole
  mission-control hangs off. Columns:
  `id, org_id, document_id, owner_id, jti, status, expires_at, created_by,
  created_at, signed_at, signed_signature_id, cancelled_at, cancelled_by`
  (`artifacts.ts:133-181`). Status machine **`pending | signed | cancelled |
  expired`** (DB CHECK widened in 0063; mirrored in
  `packages/shared-types/src/signature-request.ts:25`).

Consent is **per-owner → per-apartment → per-project**, never a flat count:
an apartment is "consented" iff every active owner-ownership
(`ownerships.relationship='owner' AND ended_at IS NULL`,
`packages/db/src/schema/projects.ts:278-331`) has a SIGNED request on one of
the project's documents. This join already lives in
`apps/api/src/modules/projects/projects.service.ts` (`signatureProgress`,
lines 355-435) and is the canonical definition of "signed for this project".

The **consent threshold** is `projects.target_signature_pct`
(`projects.ts:45`), defaulted from the urban-renewal track via
`PROJECT_TYPE_DEFAULT_CONSENT_PCT` (66% post-2023 for all tracks,
`shared-types/src/project.ts:62-71`), manager-overridable. Optional staged
milestones live in `projects.signature_milestones` jsonb (`projects.ts:49`).

There is a **separate, parallel** apartment-level signal: `apartments.status`
enum `pending|contacted|meeting|signed|refused|unreachable`
(`_enums.ts:26-33`) + `status_changed_at` + `last_contact_at`
(`projects.ts:139-141`). This is a **manually-set field-work status**, distinct
from the signature_requests workflow. The two are NOT reconciled today (an apt
can be `status='signed'` with zero signed requests — the BACKLOG "incoherent
demo data" note). This matters: the "why" layer has a partial, under-used home
here (`refused`/`unreachable`) — see §3.

---

## 1. Signal → feasibility table

| # | Redesign signal | Verdict | Where the data is / what's missing |
|---|---|---|---|
| 1 | **Distance-to-threshold** ("כמעט שם · חסרה חתימה אחת") | **EXISTS** | `GET /projects/:id/signature-progress` → `SignatureProgress { consentedPct, targetSignaturePct, apartmentsConsented, totalApartments }` (`project.ts:244-253`; service `projects.service.ts:355-435`). Distance = `target − consentedPct`, or apartments-remaining = `ceil(target% × total) − consented`. |
| 2 | **Past-threshold flag** (org pulse "past-threshold" bucket) | **EXISTS** | `SignatureProgress.metThreshold` boolean, computed server-side (`projects.service.ts:421`). Per-project only — org rollup is DERIVABLE (#9). |
| 3 | **Signed / pending counts per project** (the photo) | **EXISTS** | `ProjectListItem` already merges `ProjectStats { signaturesSignedCount, signaturesPendingCount, buildingsCount, unitsCount, agentsCount }` onto **every list row** via correlated subqueries (`project.ts:219-229`, `projects.service.ts:97-124`). One round-trip, no N+1. The home can render counts with zero extra calls. |
| 4 | **Expiring signature requests** ("פג בעוד 2 ימים") | **DERIVABLE** (data) / **NEEDS-BACKEND** (endpoint) | `signature_requests.expires_at` is stored and `status` carries a terminal `expired` (`artifacts.ts:151`, status enum). Live-pending guards already filter `expires_at > now()` (`signature-requests.service.ts:315,444`). **But no endpoint surfaces "pending requests expiring within N days"** — the list endpoint filters by `status` only (`ListSignatureRequestsQuery`, `signature-request.ts:188-197`), not by an `expires_at` window. Smallest add: an `expiringBefore` query param OR a project-scoped "expiring soon" count. No migration. |
| 5 | **Momentum / velocity** ("זז יפה, +2 השבוע") | **DERIVABLE** | `signature_requests.signed_at` is a per-signature timestamp (`artifacts.ts:156`). "+N this week" = `COUNT(signed_at >= now()-7d)` over the project's requests. No field exists for it yet, but it's a pure aggregate over stored timestamps. Needs a query (new endpoint or extra subquery on the list) — **no migration.** |
| 6 | **Stalled / "תקוע · אין תנועה 18 יום"** | **DERIVABLE** | "Days since last movement" = `now() − MAX(signed_at)` over the project's signed requests (fall back to `MAX(created_at)` of requests, or `projects.started_at`, when none signed yet). Every input timestamp is stored (`artifacts.ts:155-156`). **There is no `projects.last_signature_activity_at` denormalized column** — so today it's a `MAX()` aggregate, not a field. Cheap as a subquery; a denormalized column (#B below) is the optimization, not a requirement. **No migration required to ship.** |
| 7 | **The human "why" — owner objection / "3 בעלים מתנגדים"** | **NEEDS-BACKEND** | **No objection/decline reason exists anywhere.** Confirmed: no `objection`/`decline`/`reason` field on `owners`, `ownerships`, `apartments`, or `signature_requests` (grep across `schema/**` and `shared-types/**` — the only "reason" hits are erasure/provider/SMS-delivery, unrelated). The closest existing signal is **apartment-level** `apartments.status='refused'|'unreachable'` (`_enums.ts:31-32`) — but it's coarse (no free-text why), apartment-not-owner granularity, and manually set. Per North-Star: **omit "3 בעלים מתנגדים" until a slice lands.** Smallest add scoped in §3. |
| 8 | **"אורי דירה 7 לא חתם"** (named holdout, per-apartment) | **DERIVABLE** (counts) / partial **NEEDS-BACKEND** (the name) | `GET /projects/:id/signature-progress/apartments` returns per-apartment `{ number, floor, totalOwners, signedOwners, status: consented\|partial\|none }` (`project.ts:268-276`, service `:456-526`) — so "דירה 7, 2 owners, 1 signed → partial" is **EXISTS**. The owner's **name** ("אורי") is deliberately NOT in that payload (NO-PII rule). Surfacing the holdout's name needs a new authorized, audited per-apartment owner-status read (owners are reveal-on-demand, `owner.ts:33-56`) — a small, security-sensitive endpoint, not a migration. |
| 9 | **Org pulse aggregates** (active / past-threshold / stuck / in-work) | **DERIVABLE** / **NEEDS-BACKEND** (one endpoint) | `GET /org/stats` exists but returns only 4 flat counts `{ activeProjects, residents, signaturesReceived, signaturesPending }` (`project.ts:282-288`, service `:537-581`) — **not** the 4 mission-control buckets. The buckets ARE computable: "active"=non-archived; "past-threshold"=`metThreshold` (#2); "in-work"=`status='gathering_signatures'`; "stuck"=last-activity older than N days (#6). The project **list** already carries the counts + target, so the FE could bucket client-side IF it fetched all projects — but that breaks the "triage-by-exception, never dump all N" scale rule. **Right answer: one new aggregate endpoint** that returns the 4 bucket counts + the ~5 "needs-you-now" projects. No migration; pure read. |
| 10 | **Deadlines / calendar** (tasks with due/scheduled dates) | **EXISTS** | `tasks.due_at` + `tasks.scheduled_at` + `tasks.location` already power the V11 WeekCalendar (`collaboration.ts:104-131`). Out of the signature spine but available for "deadlines" surfacing. |
| 11 | **Forecasts** ("at this rate, threshold by ~Aug") | **DERIVABLE** (heuristic) | Pure function of velocity (#5) + distance (#1): `daysToThreshold ≈ remaining / (signed_per_week/7)`. No new storage; a computed projection. Honesty caveat: low-N velocity makes this noisy — present as a soft range, not a hard date (North-Star "plain Hebrew, numbers serve words"). |
| 12 | **Milestone progress** (staged 25→50→66 overlay) | **EXISTS** | `projects.signature_milestones` jsonb on the wire (`project.ts:147`, validated ascending/≤target). Combine with `consentedPct` (#1) to light up reached milestones. |
| 13 | **"Last contact" / field-work freshness** | **EXISTS** | `apartments.last_contact_at` + `status_changed_at` on the wire (`apartment.ts:40-41`). A secondary staleness signal distinct from signature velocity. |

---

## 2. Concrete backend additions needed (smallest-viable, ranked by size)

Ordered cheapest → costliest. Items A–C are **no-migration** (pure read
endpoints over existing columns); D is the only one needing a schema change.

### A. Org-pulse endpoint — `GET /api/v1/org/signature-pulse` *(no migration)*
The single highest-leverage add: powers the home's 4-bucket pulse **and** the
"~5 needs-you-now" triage list in one call, respecting the scale rule.

- **Returns** (proposed): `{ buckets: { active, pastThreshold, inWork, stuck },
  attention: ProjectPulseRow[] }` where each `ProjectPulseRow` = the project's
  `{ id, name, status, consentedPct, targetSignaturePct, metThreshold,
  daysSinceLastActivity, signedThisWeek, signaturesPending, expiringSoonCount }`.
- **All derivable** from `signature_requests` (`signed_at`, `expires_at`,
  `status`, `created_at`) + `projects` + the existing consent join. No new
  column.
- **Where**: extend `apps/api/src/modules/projects/org-stats.controller.ts` /
  `projects.service.ts` (the `orgStats` method already does exactly this shape
  of multi-subquery aggregate, lines 537-581 — copy the pattern). Add the wire
  schema next to `OrgStatsSchema` in `shared-types/src/project.ts`.
- **Authz**: same as `orgStats` — agent gets ASSIGNED-project scope
  (`projects.service.ts:541-563` already has the agent CTE to reuse).
- **"stuck" definition** = `now() − MAX(signed_at over project requests) > N
  days` (N configurable, default 14). For zero-signed projects fall back to
  `MAX(created_at)` of requests, else `projects.started_at`.

### B. "Expiring soon" surfacing — `expiringBefore` on the list, or a count *(no migration)*
- Add `expiringWithinDays` (or `expiringBefore`) to `ListSignatureRequestsQuery`
  (`shared-types/src/signature-request.ts:188-197`) → service adds
  `status='pending' AND expires_at < now()+interval`. Reuses the
  `idx_signature_requests_org_status_created` index plus `expires_at` filter.
- Or fold the per-project `expiringSoonCount` into the pulse rows (A) so the
  home shows it without a second call. **Prefer folding into A.**

### C. Velocity + last-activity as derived fields *(no migration)*
- `signedThisWeek` = `COUNT(signed_at >= now()-7d)`, `daysSinceLastActivity` =
  `now()-MAX(signed_at)`. Both are subqueries over `signature_requests.signed_at`
  (`artifacts.ts:156`). Ship inside A's per-project rows.
- **Optimization (defer): denormalized `projects.last_signature_activity_at`**
  column, bumped on each sign/resend (a trigger or a write in the public-sign
  path). Only worth it if the `MAX()` subquery shows up hot under load — start
  with the subquery; measure first.

### D. The "why" layer — owner signature-status + objection reason *(NEEDS A MIGRATION — the only one)*
This is the one genuinely-new schema slice. Two options, escalating:

- **D-min (recommended first slice):** an **owner-per-project signature
  disposition with reason**. Smallest shape: a new nullable enum + text on a row
  that already exists per (owner, project-document) — i.e. extend
  `signature_requests` with `decline_reason text` + widen handling so a manager
  can mark a request `cancelled`/a new `declined` state **with a reason**.
  - **Smallest migration:** `ALTER TABLE signature_requests ADD COLUMN
    decline_reason text NULL;` plus (optional) widen the status CHECK to include
    `'declined'` (mirror the 0063 pattern that added `'expired'`,
    `artifacts.ts:173-176`). Set on a new manager action ("סמן כמתנגד" with a
    free-text/closed-list reason) on the per-apartment drill-down.
  - Then "3 בעלים מתנגדים" = `COUNT(distinct owner WHERE decline_reason IS NOT
    NULL / status='declined')` per project — surfaced in pulse row A.
- **D-alt (if objection must be owner-level, project-independent):** a small
  `owner_dispositions` table (`owner_id, project_id, status, reason, note,
  created_by, created_at`) so an objection is recorded even before any request
  was sent. Heavier (new table + RLS via owner→org). Choose only if product
  wants objections decoupled from a sent request.
- **Reconcile note:** the existing `apartments.status='refused'` is the *de-facto*
  current "why" surface but is apartment-grained + reasonless. The slice should
  decide whether to (a) keep it as the coarse field-status and add owner-level
  reasons, or (b) drive apartment status FROM signature dispositions. **Flag for
  product — don't silently overload `apartments.status`.**

---

## 3. The "why" gap, called out explicitly

Per the North-Star ("never fake it"): **today the app cannot truthfully render
"3 בעלים מתנגדים" or an owner's objection reason** — that data does not exist
(§1 #7). The honest interim:

- Use what's real: per-apartment `partial`/`none` consent status (#8, EXISTS),
  and the coarse `apartments.status='refused'|'unreachable'` as a "needs
  attention" flag **without** inventing a count of objectors or a reason string.
- Land **D-min** (one ADD COLUMN migration + a manager "mark objection" action)
  before the home promises an objection narrative. It is a small, self-contained
  slice — but it is the ONE thing in the redesign that is not buildable from
  today's data.

---

## 4. Feasibility-ranked feature list (for the plan)

### Tier 1 — BUILD NOW (data already on the wire, zero backend)
1. **Distance-to-threshold** per project — `consentedPct` vs `targetSignaturePct`
   (signature-progress endpoint). (#1)
2. **Past-threshold celebration** — `metThreshold`. (#2)
3. **Signed/pending counts everywhere** — `ProjectListItem` stats are already on
   every list row; drop all "—" placeholders. (#3)
4. **Per-apartment consent board** (consented/partial/none, "דירה 7 partial") —
   `signature-progress/apartments`. (#8, minus the owner name)
5. **Milestone overlay** (25→50→66 staged) — `signature_milestones`. (#12)
6. **Deadlines surface** — task `due_at`/`scheduled_at` (calendar already built).
   (#10)
7. **Field-work freshness** — `last_contact_at`/`status_changed_at`. (#13)

### Tier 2 — SMALL BACKEND SLICE (derivable; needs a read endpoint, NO migration)
8. **Org pulse (4 buckets) + "needs-you-now" triage list** — endpoint A. The
   centerpiece of the home; respects the scale rule. (#9)
9. **Momentum "+N this week" + stalled "אין תנועה X יום"** — folded into A's
   rows via `signed_at` aggregates. (#5, #6)
10. **Expiring-soon count / list** — endpoint B (or folded into A). (#4)
11. **Forecast ("threshold by ~MONTH")** — computed from velocity+distance,
   presented as a soft range. (#11)
12. **Named holdout ("אורי דירה 7 לא חתם")** — small authorized+audited per-apt
   owner-status read (reveal-on-demand posture). Slightly heavier than the
   others because it touches PII authz, still no migration. (#8 name part)

### Tier 3 — LARGER / MIGRATION REQUIRED
13. **The "why" layer — owner objection status + reason ("3 בעלים מתנגדים")** —
   slice D-min (one `ADD COLUMN decline_reason` + status widen + a manager
   action), or D-alt (`owner_dispositions` table) if objections must be
   owner-level. The ONLY redesign signal not buildable from today's data;
   **must not be faked in the interim.** (#7)
14. *(Optional perf)* **`projects.last_signature_activity_at` denormalized
   column** — only if the `MAX(signed_at)` subquery proves hot. Measure first.

---

## 5. Source map (files cited)

- Schema: `packages/db/src/schema/projects.ts` (projects/buildings/apartments/
  owners/ownerships), `packages/db/src/schema/artifacts.ts:108-181`
  (signatures, signature_requests), `packages/db/src/schema/collaboration.ts`
  (tasks/shares), `packages/db/src/schema/_enums.ts` (status enums).
- Wire contracts: `packages/shared-types/src/project.ts` (ProjectStats,
  ProjectListItem, SignatureProgress, ApartmentSignatureProgress, OrgStats,
  PROJECT_TYPE_DEFAULT_CONSENT_PCT), `.../signature-request.ts` (request status,
  list query, delivery), `.../apartment.ts`, `.../owner.ts`.
- Services: `apps/api/src/modules/projects/projects.service.ts` (statsSubqueries,
  signatureProgress, signatureProgressApartments, orgStats),
  `apps/api/src/modules/signatures/signature-requests.service.ts`
  (expires_at handling, resend, live-pending guards).

> **Bottom line:** ~9 of the 13 mission-control signals are EXISTS or DERIVABLE
> with **no migration** — the home can be built mostly on today's data via **one
> aggregate read endpoint** (the org-pulse). Exactly **one** signal — the human
> "why" / objection layer — needs a schema change, and it's a single
> `ADD COLUMN` slice. The redesign is buildable; the data is there.
