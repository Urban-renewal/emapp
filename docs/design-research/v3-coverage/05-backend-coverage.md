# 05 — Backend Coverage Audit (every endpoint + BE slices vs the FE plan)

> Dimension: **Every API route × the redesign plan's backend slices (B1 pulse · B2 "why"
> migration · B3 autonomy worker · B4 holdout-name PII read).** Method: enumerated all
> **45 controllers / ~150 routes** from real code via Glob+Grep (NOT the plan's lists), then
> cross-checked each against `00-MASTER-PLAN-V2.md`. Verified the four load-bearing grep
> claims independently (scheduler=0, decline_reason=0, holdout name not selected,
> notification kinds). Classification: COVERED / CHANGED / AS-IS-OK / GAP.

---

## GAP SUMMARY (ranked by impact on the one-shot goal)

The plan's backend reasoning is **mostly sound** — B1–B4 + the cross-cutting bugs are
correctly identified, and the "re-composition not re-routing, all routes still respond"
guarantee holds for every endpoint I enumerated. But there are **real coverage gaps the
council under-specified or missed entirely**, the kind that would force mid-build patching:

1. **GAP-1 (P0) — B4 schema is named but its endpoint/shape/gate are NOT specified.** The
   plan asserts B4 ("PII-authz holdout-name read", `00:270`) but never says **which route**.
   `signatureProgressApartments` (`projects.service.ts:456–526`) deliberately selects NO
   owner identity (verified `:469–491`). There is no existing route returning "the holdout
   owner for apartment X." The plan must specify B4 as a concrete endpoint (e.g.
   `GET /projects/:id/signature-progress/apartments/:apartmentId/holdouts`, `view_owner_pii`
   gated, audited) **or** the "מי תקוע → tap → name" FE flow (M2/E2.2-S3) has no backend and
   stalls mid-implementation. This is the single most likely "discover a missing screen
   mid-build" event.

2. **GAP-2 (P0) — B1 pulse schema undercounts what the FE actually consumes.** The canonical
   `05 §2.A` shape is `{ buckets, attention: ProjectPulseRow[] }`, but the home (`E2.1`) and
   projects-list (`E2-list`) FE need **momentum** (`+N השבוע`), **stalled (N days)**, and
   **expiring-soon** per project — all of which require per-project derivations from
   `signature_requests.{signedAt,expiresAt,status,createdAt}`. The plan says these are
   "DERIVABLE behind B1" but **never pins them into the B1 response contract**. If `ProjectPulseRow`
   ships with only counts, E2-list's "sort-by-momentum" (`00:342`) and the home momentum chip
   (`00:185`) are silently un-backed. B1's row schema must explicitly carry
   `lastSignatureAt`/`signedThisWeek`/`stalledDays`/`nextExpiryAt` per project.

3. **GAP-3 (P1) — `/messages` is demoted to a topbar cluster but its 6 endpoints + the
   notification deep-link are never reconciled.** Plan moves messaging to the topbar
   (`00:77,81`) and drops the redundant notifications nav line — but the messaging module has
   **6 live routes** (`conversations` GET/POST, `:id`, `:id/messages` GET/POST, `:id/read`)
   and notifications deep-link to `/messages?c=...` (`notification-links.ts:26`). The plan
   never states the topbar cluster consumes these, nor whether the `/messages?c=` deep-link
   target survives the nav move. AS-IS the routes respond, but the **FE topbar surface has no
   named data plan** — a "where does the messages panel get its data" gap.

4. **GAP-4 (P1) — C1 print-of-record (the product's raison d'être) has NO backend plan at
   all.** The plan correctly flags "no print/PDF path anywhere" (`00:362`) and proposes a
   **print stylesheet** (FE-only). But a committee/lawyer artifact carrying the basis-labeled
   tally is a **document-of-record** — it plausibly needs a server-rendered, audited,
   immutable PDF endpoint (like `signed-document` at `signature-requests.controller.ts:112`
   already does for one signature). The plan budgets zero BE for C1. If "print stylesheet"
   proves insufficient for a legal artifact (very likely), this becomes an unplanned BE slice
   mid-build.

5. **GAP-5 (P1) — B2 widens the status CHECK + adds `decline_reason`, but the ripple to the
   ~6 status-consuming surfaces is unbudgeted.** Confirmed `decline_reason` exists **nowhere**
   (grep=0 files). B2 adds a `'declined'` status value. Per the memory note
   "Schema-constraint change ripples to all raw seeders," widening the
   `signature_requests.status` CHECK breaks every raw-SQL test INSERT and every status-label
   map (`adapters/signature-request.ts STATUS_LABELS`, the `statusColor`→intent rename of
   E2.0b, the contractor-portal status surface). The plan names the migration but not this
   ripple — a multi-file patch wave the one-shot goal wants closed up front.

6. **GAP-6 (P2) — B3 autonomy worker is net-new infra with NO module/deploy plan beyond
   "a Railway worker."** Confirmed zero schedulers in `apps/api/src` (only one unrelated test
   `setInterval`). B3 must sweep `pending→expired`, emit time-based notifications, and (post-B2)
   auto-remind. The plan does not specify: which notification **kind** the sweep emits (the
   current kinds are document/signatureRequest/apartment/note/task/projectShares/message —
   `notification-links.ts` — **none is "expiring"/"stalled"/"threshold-reached"**), nor the
   idempotency/locking model for a recurring worker against `withProvider`/`withTenant`. New
   notification kinds = new `notification-links` entries + FE deep-link targets, unbudgeted.

7. **GAP-7 (P2) — `org-stats` is the home's current backing endpoint; the plan replaces the
   home (E2.1) and adds B1 pulse, but never says whether `/org/stats` is retired, kept, or
   superseded.** `OrgStatsController` (`org-stats.controller.ts:31`) backs the KPI grid the
   plan deletes (`00:339`). If the KPI grid is deleted and B1 pulse replaces it, `/org/stats`
   may become dead — or may still back something. Plan is silent → risk of a dangling endpoint
   or a double-fetch on the new home.

8. **GAP-8 (P2) — no FE/BE plan for the populated calendar (C11) though `tasks.due_at` +
   the ICS generator both exist.** The plan *deletes* the calendar stub (`00:339`) and lists
   "populated calendar" under C11 deferred (`00:393`). But a real `CalendarService` ICS
   generator exists (`calendar/calendar.service.ts`) with **no read/feed controller** — there
   is no `GET /calendar` returning `tasks.due_at` + `signatureMilestones`. If the owner pulls
   C11's calendar into scope, it needs a net-new BE feed endpoint the plan hasn't scoped.

---

## FULL INVENTORY (route → plan status)

Legend: COVERED = plan explicitly addresses · CHANGED = plan modifies (how noted) ·
AS-IS-OK = plan correctly leaves untouched & it's fine · GAP = plan misses it.

### Backend slices the plan PROPOSES (B1–B4) — feasibility verified

| Slice | Real anchor | Verified claim | Status | Note |
|---|---|---|---|---|
| B1 pulse `GET /org/signature-pulse` | derives from `projects.service.ts:537–581` orgStats + agent-scope CTE | endpoint does NOT exist yet; orgStats CTE real | **CHANGED→new** | GAP-2: per-project momentum/stalled/expiry not pinned into the row schema |
| B2 `decline_reason` + `'declined'` status | grep `decline_reason` = **0 files** | confirmed only migration needed | **CHANGED→new** | GAP-5: CHECK-widen ripple to status maps + raw seeders unbudgeted |
| B3 autonomy worker | grep `@Cron\|ScheduleModule\|setInterval` = 1 unrelated test | confirmed zero prod schedulers | **CHANGED→new** | GAP-6: no notification-kind / locking / module plan |
| B4 holdout-name PII read | `signatureProgressApartments:469–491` selects NO owner id | confirmed counts-only by design | **GAP** | GAP-1: route/shape/gate never specified |

### Cross-cutting BE-adjacent items

| Item | file:line | Plan status | Note |
|---|---|---|---|
| `formatRelative` no-tz bug (P-TZ-1) | `lib/format.ts` (FE) | **COVERED** | `00:288–297` correctly flags + fixes; gates chase honesty |
| No threshold-reached notification emit | `notification-links.ts` kinds (no threshold) | **COVERED (as gap)** | `00:393` C11 names it; B3 would add it (GAP-6 ripple) |
| Consent gates on apartment-headcount, share never read | `projects.service.ts:398–421`; `ownerships.share_*` (migration 0065) | **COVERED** | `00:443–456` binding interim rule; P0-FIX deferred on OD-1 |

### Projects / signature spine (the product core)

| Route | file:line | Purpose | Plan status | Note |
|---|---|---|---|---|
| GET /projects | projects.controller.ts:44 | list (counts on rows) | **CHANGED** | E2-list enrich; sort-by-distance now (`00:342`) |
| GET /projects/:id | :53 | detail | **CHANGED** | board-first tab default (E2.2-S1) |
| GET /projects/:id/signature-progress | :63 | consentedPct/target/metThreshold | **COVERED** | the headline %; basis-label rule §6.1 |
| GET /projects/:id/signature-progress/apartments | :76 | per-apt counts, NO names | **CHANGED** | E2.2-S3 "מי תקוע"; **B4 needed for name** (GAP-1) |
| POST /projects | :85 | create | **CHANGED** | C5 wizard re-skin (`projects/new` 1468 lines) |
| PATCH /projects | :94 | update | AS-IS-OK | re-skin only |
| DELETE /projects | :104 | archive | AS-IS-OK | |
| GET /org/stats | org-stats.controller.ts:31 | home KPI grid backing | **GAP** | GAP-7: home deleted/replaced; fate of this endpoint unstated |
| POST /projects/:id/signature-campaign | signature-campaign.controller.ts:32 | campaign send | **COVERED** | M5 ConfirmDialog wrap; gate `signature_requests.send` kept |

### Signature requests (the chase loop)

| Route | file:line | Purpose | Plan status | Note |
|---|---|---|---|---|
| GET /signature-requests | signature-requests.controller.ts:52 | list/library | **CHANGED** | demoted to project tab; library survives |
| POST /signature-requests | :66 | create | AS-IS-OK | gate kept |
| POST /signature-requests/bulk | :81 | bulk create | AS-IS-OK | |
| GET /signature-requests/:id | :92 | detail | AS-IS-OK | |
| GET /signature-requests/:id/signed-document | :112 | signed PDF download | **AS-IS-OK** | precedent for C1 server-PDF (GAP-4) |
| POST /signature-requests/:id/cancel | :132 | cancel | AS-IS-OK | |
| **POST /signature-requests/:id/resend** | :142 | resend/remind (throttled 30/min, audited, 409-guarded) | **COVERED** | M2 wraps it (`00:341`); the one chase loop |
| POST /signature-requests/:id/link | :158 | out-of-band link | AS-IS-OK | |
| GET /sign/:token (public) | public-sign.controller.ts:29 | public sign view | AS-IS-OK | not in redesign scope (separate role) |
| POST /sign/:token | :37 | submit signature | AS-IS-OK | |

### Owners (person axis + global search)

| Route | file:line | Purpose | Plan status | Note |
|---|---|---|---|---|
| GET /owners | owners.controller.ts:55 | list | **CHANGED** | owners dossier / kept in spine (gated) |
| **POST /owners/search** | :72 | PII-in-body search (throttled 20/min) | **COVERED** | S4 omnibox extends THIS (`00:120,332`) |
| POST /owners | :82 | create | AS-IS-OK | |
| GET /owners/:id | :91 | dossier detail | **CHANGED** | person-axis dossier (`00:56`) |
| GET /owners/:id/projects | :102 | owner→projects | **COVERED** | dossier cross-project list |
| POST /owners/:id/reveal-pii | :115 | D.54 reveal | **AS-IS-OK** | `view_owner_pii` gate = the B4 model |
| GET /owners/:id/data-export | :128 | DSAR access | AS-IS-OK | compliance, untouched |
| POST /owners/:id/erase | :139 | RTBF | AS-IS-OK | |
| PATCH /owners/:id | :150 | update | AS-IS-OK | |
| DELETE /owners/:id | :160 | archive | AS-IS-OK | |

### Structure spine (buildings/apartments/ownerships/discovery/tabu/parcel)

| Route | file:line | Plan status | Note |
|---|---|---|---|
| GET/POST projects/:projectId/buildings | buildings.controller.ts:45,55 | **CHANGED** | Structure tab drill-down; routes kept |
| GET/PATCH/DELETE buildings/:id | :65,71,81 | AS-IS-OK | |
| GET/POST buildings/:buildingId/apartments | apartments.controller.ts:45,55 | **CHANGED** | Structure tab; apartment timestamps used by signals |
| GET/PATCH/DELETE apartments/:id | :65,71,81 | AS-IS-OK | `lastContactAt`/`statusChangedAt` feed "freshness" (`00:239`) |
| GET/GET/PUT apartments/:apartmentId/ownerships+owners | ownerships.controller.ts:32,42,55 | AS-IS-OK | share data exists, never read by consent calc (§6.1) |
| GET/POST apartments/:apartmentId/discovery-records | discovery.controller.ts:37,47 | **GAP (named)** | C10: `discovery_records` has NO FE; owner scope decision (`00:387`) |
| PATCH discovery-records/:id | :57 | **GAP (named)** | same — half the "find the owner" workflow is BE-only |
| tabu-extractions (7 routes) | tabu-extractions.controller.ts:38–102 | AS-IS-OK | Phase-5 parse flow; out of redesign scope |
| parcel-setups (5 routes) | parcel-setups.controller.ts:39–81 | AS-IS-OK | Setup/overflow tab; routes kept |

### Documents

| Route | file:line | Plan status | Note |
|---|---|---|---|
| GET/POST /documents (+ :id, download, content, finalize, patch, delete) | documents.controller.ts:64–171 | **CHANGED** | demoted to project Documents tab; global library survives; envelope-enc untouched |

### Imports (the live-SSE precedent)

| Route | file:line | Plan status | Note |
|---|---|---|---|
| POST/GET /imports, :id, :id/start, delete, errors, mapping, confirm | imports.controller.ts:73–164 | **CHANGED** | C8 re-skin; kept in spine |
| **GET /imports/:id/stream (SSE)** | :189 | **COVERED** | C8: live SSE disproves "no real-time"; M1/G6 must reconcile (`00:378`) |

### Tasks / notes / contractors / shares (demoted from spine)

| Route | file:line | Plan status | Note |
|---|---|---|---|
| tasks: GET/POST/GET/PATCH/DELETE tasks + assignees (8 routes) | tasks.controller.ts:46–103 | **CHANGED/COVERED** | kept in spine; `due_at` feeds calendar (GAP-8) |
| notes: GET/POST/GET/PATCH/DELETE (5 routes) | notes.controller.ts:44–78 | **CHANGED** | demoted → project Activity tab + dossier (`00:76`) |
| contractors: list/create/:id/patch/delete (5 routes) | contractors.controller.ts:40–74 | **CHANGED** | demoted → project Access tab (`00:77`) |
| shares: project shares CRUD + :id/link (5 routes) | shares.controller.ts:50–90 | **CHANGED** | Access tab; contractor share view C7 re-skin (`00:374`) |
| contractor portal: project/progress/documents/download (4 routes) | contractor-read.controller.ts:33–48 | **CHANGED** | C7 external deliverable; drops BE lifecycle to one `invalidLink` |

### Messaging + notifications (topbar cluster)

| Route | file:line | Plan status | Note |
|---|---|---|---|
| conversations: GET/POST/:id/:id messages GET/POST/:id read (6 routes) | messaging.controller.ts:34–73 | **GAP** | GAP-3: moved to topbar cluster but no data-plan for the panel |
| notifications: GET/unread-count/read-all/:id read (4 routes) | notifications.controller.ts:28–56 | **CHANGED** | bell kept; redundant nav line dropped (`00:78`); B3 adds new kinds (GAP-6) |
| notification deep-links incl. `/messages?c=` | notification-links.ts:16–26 | **CHANGED** | targets must survive nav move; `n.link` safety guaranteed (`00:84`) |

### Admin group (members/roles/audit/org/export) — gates carry over verbatim

| Route | file:line | Plan status | Note |
|---|---|---|---|
| members + capability-presets + resend + capabilities + preset + delete (8) | members.controller.ts:53–138 | **CHANGED** | collapsed into Admin group; `members.read` gate kept (`00:79`) |
| member-overrides GET/PUT/DELETE | member-overrides.controller.ts:41–57 | AS-IS-OK | |
| accept-invite | accept-invite.controller.ts:16 | AS-IS-OK | |
| roles: list/catalog/create/patch/delete/assignments (7) | roles.controller.ts:55–106 | AS-IS-OK | Admin group |
| audit GET | audit.controller.ts:23 | **CHANGED** | Admin group; `audit.read` gate kept |
| org-settings GET/PATCH | org-settings.controller.ts:41,47 | **CHANGED** | Admin group; brand-fork (OD-6) is a token edit, not this endpoint |
| export GET (`projects/:id/export`) | export.controller.ts:65 | **AS-IS-OK** | `export.run` gate kept; NOT the C1 print artifact (xlsx ≠ committee PDF, GAP-4) |
| project-assignments GET/POST/DELETE | project-assignments.controller.ts:43–64 | **CHANGED** | Access tab; agent-scope source |

### Auth + provider tiers (outside redesign scope, correctly untouched)

| Route | file:line | Plan status | Note |
|---|---|---|---|
| auth: signup/login/refresh/forgot/reset/logout/switch-org | auth.controller.ts:54–174 | AS-IS-OK | not redesign scope |
| me GET | me.controller.ts:13 | AS-IS-OK | seeded into session cache (PR #401) |
| step-up request/verify | step-up.controller.ts:30,41 | **CHANGED** | M6: StepUpDialog a11y retrofit (`00:396`) — FE-only |
| tenant otp request/verify | otp.controller.ts:30,41 | **CHANGED (named)** | C11: tenant-OTP counterparty outcome (`00:393`) |
| portal: me/apartment/documents/signatures/progress/resend/logout (8) | portal.controller.ts:52–139 | AS-IS-OK | tenant portal; `portal.ts` adapter in the statusColor rename (E2.0b) |
| provider/* (13 routes across 8 controllers) | provider-*.controller.ts | AS-IS-OK | Provider-Admin tier; explicitly out of E2 redesign scope |
| observability/metrics, system-health | metrics.controller.ts:22; provider-system-health.controller.ts:33 | AS-IS-OK | ops, untouched |

---

## VERIFICATION NOTES (independent re-checks of the plan's load-bearing greps)

- **Scheduler=0:** `@Cron|ScheduleModule|setInterval|SchedulerRegistry` over `apps/api/src`
  → one hit, `imports-sse-cap.spec.ts:208` (a test). B3 is genuinely net-new. ✓
- **decline_reason=0:** grep over `apps` → 0 files. B2 is genuinely the only migration. ✓
- **Holdout name not selectable today:** `signatureProgressApartments` (`:467–501`) selects
  apartment id/number/floor + two COUNT subqueries; owner id/name/national_id/phone never
  projected (comment `:451–454` confirms by design). B4 must be net-new. ✓
- **No threshold-reached notification:** notification link kinds = document, signatureRequest,
  apartment, note, task, projectShares, message (`notification-links.ts:16–26`). No
  threshold/expiring/stalled kind. ✓ (confirms GAP-6 + C11)
- **owners/search reuse for omnibox:** real, throttled 20/min, `owners.read`-gated, PII-in-body
  (`owners.controller.ts:64–80`). S4 reuse is sound. ✓
