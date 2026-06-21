# 05 — Data Feasibility (v2, second pass): real schema → buildable signals

> Role: **Data-feasibility expert.** This pass does NOT theorize from the brief.
> Every verdict below is checked against the actual schema, the actual
> aggregation SQL, and the actual wire contracts — file + line cited. Where the
> data does not exist, it says so and names the exact `ADD COLUMN`. Where a
> first-pass claim was imprecise, this pass corrects it.
>
> Supersedes `docs/design-research/04-data-feasibility.md` (v1). v1 was
> substantially correct; this pass adds **column-level grounding**, **index
> awareness** (so "DERIVABLE" doesn't quietly mean "seq-scan under load"), a
> **richer read of the existing "why" surface** (v1 under-credited
> `discovery_records`), a **per-signal DO-NOT-FABRICATE contract** the FE must
> honor until each backend slice ships, and — new this pass — the **autonomy-engine
> gap**: the single most important feasibility finding for the owner's
> "THE SYSTEM DOES THE WORK; THE DEVELOPER JUST APPROVES" doctrine.
>
> **Every line/column citation in this document was re-opened and verified
> against source on 2026-06-18.** Nothing here is recalled from a prior pass.
> READ-ONLY analysis. No code changed.

---

## 0. The signature domain, verified against source

The mission-control hangs off **two tables** in
`packages/db/src/schema/artifacts.ts`, both confirmed read this pass:

- **`signatures`** (`artifacts.ts:86-114`) — the forensic encrypted-SVG blob
  (`signatureBlob` bytea, `documentId`, `ownerId`, `signedAt`, `signerIp`,
  `signerUserAgent`, `authMethod`). Indexed on `documentId` and `ownerId`
  (`artifacts.ts:111-112`).
- **`signature_requests`** (`artifacts.ts:133-178`) — the workflow row. Verified
  columns: `id, orgId, documentId, ownerId, jti, status, expiresAt, createdBy,
  createdAt, signedAt, signedSignatureId, cancelledAt, cancelledBy`.
  **Status machine is exactly `pending | signed | cancelled | expired`** —
  enforced by the DB CHECK `signature_requests_status_valid`
  (`artifacts.ts:173-176`: `status IN ('pending','signed','cancelled','expired')`),
  mirrored in `packages/shared-types/src/signature-request.ts`. There is **no
  `declined` status and no `decline_reason` column** — confirmed by grep across
  `packages/**` this pass: zero hits for
  `decline_reason|declineReason|'declined'|objection|owner_disposition`. The
  "why" gap is real and total (§3).

**Three relevant indexes** (these decide whether a signal is cheap),
verified `artifacts.ts:165-172`:
- `idx_signature_requests_org_status_created (org_id, status, created_at DESC)`
  — backs status-filtered, org-scoped, time-ordered scans.
- `idx_signature_requests_doc_status (document_id, status)` — backs the
  per-document consent joins and every per-project count.
- `idx_signature_requests_owner_status (owner_id, status)` — backs the
  per-owner "did this owner sign" EXISTS subquery.
- **There is NO index on `expires_at`.** This matters for the "expiring soon"
  signal (§2.B): an org-wide `expires_at < now()+N` window would seq-scan.
  Scoped to a project's documents (`doc_status` prefix) or to
  `(org_id, status, …)` it's cheap. Not a blocker at MVP volume, but called out.

**Consent is per-owner → per-apartment → per-project**, never a flat count. The
canonical definition lives in `apps/api/src/modules/projects/projects.service.ts`
`signatureProgress` (lines **355-435**, re-read this pass) and is verified: an
apartment is `consented` iff it has ≥1 active owner ownership
(`ownerships.ended_at IS NULL AND relationship='owner'`,
`projects.service.ts:375-385`) **and the count of those owners equals the count
who hold a `status='signed'` `signature_request` on a project document**
(`:381-393`). The "signed for this project" join
(`signature_requests sr JOIN documents d ON d.id=sr.document_id WHERE
sr.owner_id=… AND sr.status='signed' AND d.project_id=…`) is repeated
**identically** in the per-apartment drill-down (`:479-491`). This is the ONE
definition of "signed"; any new signal MUST reuse it, not re-invent it.

The **threshold** is `projects.target_signature_pct` (numeric(5,2),
`projects.ts:45`; arrives as a string from pg-node, normalized to `number|null`
at `projects.service.ts:415-417`), defaulted per renewal track and
manager-overridable. Staged milestones live in `projects.signature_milestones`
jsonb (`projects.ts:49`, shape `{ pct, label? }[]`, migration 0053).

---

## 1. Signal-by-signal feasibility (verified)

Verdicts: **EXISTS** (already on the wire) · **DERIVABLE** (computable from
stored columns, no migration — needs a query/endpoint or FE math) ·
**NEEDS-DATA** (a new column/enum/migration).

| # | Signal the design wants | Verdict | Exact data / what's missing |
|---|---|---|---|
| 1 | **Distance-to-threshold** ("כמעט שם · חסרה חתימה אחת") | **EXISTS** | `GET /projects/:id/signature-progress` → `{ consentedPct, targetSignaturePct, apartmentsConsented, totalApartments }` (`SignatureProgressSchema`, `shared-types/src/project.ts:244-253`; service `:419-431`). Apartments-remaining = `ceil(target%/100 × totalApartments) − apartmentsConsented`. The "חסרה חתימה אחת" phrasing is honest ONLY when remaining is computed on **apartments** (the legal unit), not raw signature counts. |
| 2 | **Past-threshold flag** | **EXISTS** | `SignatureProgress.metThreshold` boolean, server-computed (`projects.service.ts:421`: `targetSignaturePct !== null && consentedPct >= targetSignaturePct`). Per-project; org rollup is DERIVABLE (#9). |
| 3 | **Signed / pending counts per project** | **EXISTS** | `ProjectStats { signaturesSignedCount, signaturesPendingCount, buildingsCount, unitsCount, agentsCount }` is merged onto **every** `ProjectListItem` via 5 correlated subqueries in `statsSubqueries` (`projects.service.ts:97-124`; schema `:219-229`). One round-trip, each subquery index-backed (`idx_signature_requests_doc_status`). The home can show real counts with zero extra calls. **Caveat:** these are raw `signature_requests` rows (per-owner), NOT apartments-consented — do not present them as "% consent". |
| 4 | **Expiring requests** ("פג בעוד יומיים") | **DERIVABLE (data) / NEEDS-ENDPOINT** | `signature_requests.expiresAt` is stored + NOT NULL (`artifacts.ts:151`); a terminal `expired` status exists in the CHECK. Live-pending guards already filter `gt(expiresAt, now())` (`signature-requests.service.ts:315,444` — verified exact). **But no endpoint returns "pending expiring within N days."** `ListSignatureRequestsQuery` filters by `status/documentId/ownerId` only (`signature-request.ts:188-196`, `.strict()`) — no `expiresAt` window. No migration; see §2.B. **AND see §2.E: nothing ever flips a lapsed `pending` row to `expired` — there is no sweep.** (Index caveat §0.) |
| 5 | **Momentum / velocity** ("זז יפה, +2 השבוע") | **DERIVABLE** | `signature_requests.signedAt` per-row timestamp (`artifacts.ts:156`). "+N this week" = `COUNT(*) WHERE status='signed' AND signed_at >= now()-interval '7 days'` scoped to project docs. Pure aggregate over stored timestamps; no field, no migration. Fold into §2.A. |
| 6 | **Stalled** ("תקוע · אין תנועה 18 יום") | **DERIVABLE** | "Days since last movement" = `now() − MAX(signed_at)` over the project's signed requests, falling back to `MAX(created_at)` of requests, then `projects.started_at` (`projects.ts:75`, nullable). All inputs stored. **Optional richer inputs exist** that v1 ignored: `apartments.last_contact_at` + `apartments.status_changed_at` (`projects.ts:140-141`) capture HUMAN field-activity distinct from signing — a more honest "no movement" signal for projects with zero signed-yet but active door-knocking. **No denormalized `last_signature_activity_at` column** — it's a `MAX()` subquery today (§2.C). |
| 7 | **The human "why"** ("3 בעלים מתנגדים", an objection reason) | **NEEDS-DATA** (partial existing surface — §3) | **No owner/request-level objection reason exists** (grep-confirmed §0). The closest REAL surfaces, both coarse: (a) `apartments.status` enum `pending\|contacted\|meeting\|signed\|refused\|unreachable` (`_enums.ts:26-33`) + `apartments.notes` free-text (`projects.ts:142`) — apartment-grained, manually set; (b) **`discovery_records`** with `status ∈ {not_visited, no_answer, spoke_to_occupant, owner_identified, refused}` + a `notes` free-text column (`projects.ts:344-372`, migration 0066) — apartment-attached field-visit log. **v1 under-credited (b).** Neither is owner-grained or a structured reason. The honest narrative today is a COUNT of refused apartments, NOT "3 בעלים מתנגדים". Owner-level structured reason needs a migration (§2.D). |
| 8 | **Named holdout** ("אורי דירה 7 לא חתם") | **DERIVABLE (apartment) / NEEDS-AUTHZ-ENDPOINT (name)** | `GET /projects/:id/signature-progress/apartments` returns per-apartment `{ number, floor, totalOwners, signedOwners, status: consented\|partial\|none }` (`ApartmentSignatureProgressSchema`, `project.ts:268-276`; service `:456-526`, natural-numeric ordered `:499-500`). "דירה 7 · 2 owners · 1 signed → partial" is **EXISTS**. The owner's NAME ("אורי") is deliberately omitted — the consent join lives entirely inside correlated EXISTS subqueries returning pure counts (`:484-491`), NO owner id/name/national_id/phone ever projected (comment `:451-454`). Surfacing the name needs a NEW authorized + audited per-apartment owner read (owners are PII, reveal-on-demand). Small, security-sensitive; NO migration. |
| 9 | **Org pulse buckets** (active / past-threshold / stuck / in-work) | **DERIVABLE / NEEDS-ENDPOINT** | `GET /org/stats` returns only 4 flat counts `{ activeProjects, residents, signaturesReceived, signaturesPending }` (`OrgStatsSchema`, `project.ts:282-288`; service `:537-581`) — NOT the buckets. Buckets ARE computable: active=`archived_at IS NULL`; in-work=`status='gathering_signatures'`; past-threshold=`metThreshold` (#2); stuck=last-activity > N days (#6). The project LIST already carries counts+target, so the FE *could* bucket client-side — but only by fetching ALL projects, which **breaks the "never dump all N" scale rule**. **Right answer: one new aggregate endpoint** (§2.A). No migration. |
| 10 | **Deadlines / calendar** | **EXISTS** | `tasks.dueAt` + `tasks.scheduledAt` + `tasks.location` (`collaboration.ts:104-111`), indexed (`idx_tasks_org_due`, `idx_tasks_org_scheduled`, `:125-131`). Powers the V11 WeekCalendar already. Outside the signature spine but available for the "what's on your plate" surface. |
| 11 | **Forecast** ("בקצב הזה, נעבור את הרף בערך באוגוסט") | **DERIVABLE (heuristic)** | Pure function of velocity (#5) + distance (#1): `daysToThreshold ≈ remaining_apartments / (signed_per_week/7)`. No storage. **Honesty caveat:** low-N velocity → noisy; present as a soft range ("בערך"), never a hard date, and SUPPRESS when `signed_per_week` is 0 or N is tiny (else it fabricates false confidence). |
| 12 | **Milestone overlay** (25→50→66 staged) | **EXISTS** | `projects.signatureMilestones` jsonb on the wire (`projects.ts:49`; `{pct,label?}[]`, validated ascending/≤target at the Zod edge). Light up reached milestones by comparing to `consentedPct` (#1). |
| 13 | **Field-work freshness** ("עודכן לפני 3 ימים") | **EXISTS** | `apartments.lastContactAt` + `apartments.statusChangedAt` (`projects.ts:140-141`; `statusChangedAt` is NOT NULL default now()). A staleness signal DISTINCT from signature velocity — it tracks human contact, not signing. A real, non-fabricated proxy for the "why"/triage layer. |

**Net:** of the 13 signals, **6 EXIST on the wire today** (#1,2,3,10,12,13),
**5 are DERIVABLE with no migration** (#4,5,6,9,11) but need ONE aggregate
endpoint to surface honestly at scale, **1 needs a small PII-authz endpoint**
(#8 name), and **exactly 1 needs a schema migration** (#7 the structured "why").

---

## 2. The minimal backend slices (ranked cheapest → costliest)

A–C and E are **no-migration** pure reads/jobs. D is the **only** migration.

### 2.A — `GET /api/v1/org/signature-pulse` (NO migration) — highest leverage

The single most valuable add. Powers the home's 4-bucket pulse AND the
"~5 needs-you-now" triage list in ONE call, honoring the scale rule (never
return all N projects).

- **Proposed shape:**
  ```
  {
    buckets: { active, pastThreshold, inWork, stuck },
    attention: ProjectPulseRow[]   // capped (≈5), ranked by urgency
  }
  ```
  where each `ProjectPulseRow` =
  `{ id, name, status, consentedPct, targetSignaturePct, metThreshold,
     daysSinceLastActivity, signedThisWeek, signaturesPending,
     expiringSoonCount }`.
- **Every field DERIVABLE** from `signature_requests` (`signedAt`, `expiresAt`,
  `status`, `createdAt`) + `projects` + the existing consent join. No new column.
- **Where to build it:** extend
  `apps/api/src/modules/projects/org-stats.controller.ts` — verified this pass
  to have **only** `@Get('stats')` (`org-stats.controller.ts:31-35`) under
  `@Controller('org')` + `@UseGuards(AuthGuard, TenantGuard, AuthorizationGuard)`.
  Add a sibling `@Get('signature-pulse')` with the same
  `@RequirePermission('projects.read')` guard stack and add the method to
  `projects.service.ts`. The `orgStats` method (`:537-581`) is the **exact
  template** — it already does the multi-subquery aggregate AND the agent-scope
  branch.
- **Authz / scale reuse (verified):** `orgStats` already implements the
  **agent-scope CTE** — `WITH assigned AS (SELECT project_id FROM
  project_assignments WHERE user_id=… AND unassigned_at IS NULL)` then every
  count is scoped `… IN (SELECT project_id FROM assigned)`
  (`projects.service.ts:543-563`). The pulse endpoint reuses this verbatim so an
  agent's pulse covers only assigned projects (no org-scale leak). It also
  reuses `projectSetSignatureDocIdsSql` (`:559,562`) — the single shared
  definition of "a project's signature docs".
- **"stuck" definition (must be locked):** `now() − MAX(signed_at over project's
  signed requests) > N days`. For zero-signed projects fall back to
  `MAX(created_at)` of requests, else `projects.started_at`. Consider mixing in
  `MAX(apartments.last_contact_at)` so a project being actively door-knocked
  (but not yet signed) is NOT flagged "תקוע". **Default N=14**; surface to owner
  whether 14 is the right threshold (it drives the "תקוע" copy). ← owner decision.
- **Add the wire schema** (`OrgSignaturePulseSchema` + `ProjectPulseRowSchema`)
  next to `OrgStatsSchema` in `shared-types/src/project.ts`, and a `gen-api-docs`
  ENDPOINTS registry entry — **this repo's api-docs-coverage guard fails CI for
  any new controller route without a registry entry** (owner caught 64 missing
  once; see MEMORY `api_docs_manual_registry`).

### 2.B — "Expiring soon" (NO migration) — fold into 2.A

Two options; **prefer folding into 2.A** so the home needs no second call:
- Per-project `expiringSoonCount` = `COUNT(*) WHERE status='pending' AND
  expires_at < now()+interval 'N days'` scoped to project docs, returned in the
  pulse row.
- OR add `expiringWithinDays` to `ListSignatureRequestsQuery`
  (`signature-request.ts:188-196`) for the per-project requests tab.
- **Index caveat:** there is no `expires_at` index (§0). Scoped to a project's
  documents (`idx_signature_requests_doc_status` prefix) it's cheap; a bare
  org-wide window would scan. At MVP volume fine; note for later.
- **Honesty caveat tied to 2.E:** "expiring soon" is only meaningful if lapsed
  rows are NOT silently lingering as `pending`. Today they are (no sweep, §2.E),
  so the FE must derive "expired" at read time (`expires_at < now()`) and treat
  `status='pending' AND expires_at < now()` as the de-facto expired set — do not
  trust `status='expired'` to be populated.

### 2.C — Velocity + last-activity as derived fields (NO migration) — inside 2.A

- `signedThisWeek` = `COUNT(signed_at >= now()-7d)`; `daysSinceLastActivity` =
  `now() − MAX(signed_at)`. Both subqueries over `signature_requests.signed_at`.
- **Deferred optimization:** a denormalized `projects.last_signature_activity_at`
  bumped on each sign — only if the `MAX(signed_at)` subquery proves hot under
  load. **Measure first; do not pre-build.**

### 2.D — The "why" layer (THE ONLY MIGRATION) — Gate-6

The one genuinely-new schema slice. Recommended smallest shape:

- **D-min (recommended):** `ALTER TABLE signature_requests ADD COLUMN
  decline_reason text NULL;` + widen the status CHECK to add `'declined'`
  (mirror migration 0063 which added `'expired'` to
  `signature_requests_status_valid`, `artifacts.ts:173-176`) + a manager action
  "סמן כמתנגד" setting `status='declined'` with a reason (closed list or free
  text). Then "X בעלים מתנגדים" = `COUNT(DISTINCT owner WHERE status='declined')`
  per project — surfaced in the pulse row (2.A).
- **D-alt (if objection must be owner-level, before any request is sent):** a
  small `owner_dispositions(owner_id, project_id, status, reason, note,
  created_by, created_at)` table (RLS via owner→org). Heavier; choose only if
  product wants objections decoupled from a sent request. (Owners CAN object
  before any link goes out — the `signature_requests`-attached D-min cannot
  represent that, which is the real reason to consider D-alt.)
- **Reconcile decision (owner):** the existing `apartments.status='refused'` and
  `discovery_records.status='refused'` are the de-facto current "why" surfaces
  but are apartment-grained + reasonless. The slice must decide: keep them as
  coarse field-status AND add owner-level reasons, OR drive apartment status
  FROM dispositions. **Do not silently overload `apartments.status`** — that's
  the BACKLOG "incoherent demo data" trap. ← owner decision.

### 2.E — The autonomy engine (NO migration, but a NEW background worker) — the doctrine gate

**This is the most important feasibility finding for the owner's central
doctrine ("THE SYSTEM DOES THE WORK; THE DEVELOPER JUST APPROVES"), and v1
missed it entirely.**

Verified this pass by grep across `apps/api/src`:
**there is NO scheduler, cron, or time-driven job anywhere in the API** — zero
hits for `@Cron|CronExpression|ScheduleModule|setInterval|nestjs/schedule`
(the single match is an unrelated SSE-cap *test*). The notification producer
(`apps/api/src/modules/notifications/notifications-producer.service.ts`) exposes
**only** `emit` / `emitMany` (`:51,84`) — pure SYNCHRONOUS hooks called inline
by domain services (document upload, task assigned, **signature received**, note
added). Every `signature_received` notification fires the instant a resident
signs; **nothing fires on a clock.**

Consequences for the design:
- **Doctrine (a) "the system chases holdouts automatically" has NO backend
  today.** Every reminder/resend is a manual manager action. The `resend`/swap
  paths exist (`signature-requests.service.ts:745-,841-,946-`) but are
  human-triggered. The "open the app and it already chased" emotional payoff is
  **not buildable on current data alone** — it needs a recurring worker.
- **Doctrine (b) "act in the background and NOTIFY" is half-built:** the
  notifications *table + types + producer + deep-links* all exist
  (`notification_type` includes `signature_received`, `_enums.ts:44-54`), so the
  DELIVERY surface is ready — but there is no PRODUCER of time-based events
  (expiry-approaching, "stalled 14 days", "reminder due"). Those notifications
  can only ever appear once a worker emits them.
- **`pending` rows never become `expired`** without this worker, so the
  `'expired'` status is effectively dead today (no path sets it). This is why
  every read guard re-derives liveness with `expires_at > now()` (§2.B).

**The slice:** a single recurring worker (the Railway "Worker" service already
in the stack per CLAUDE.md) that, on a cadence, (i) flips lapsed `pending` →
`expired`, (ii) emits "expiring in N days" + "stalled" notifications via the
existing producer, and (iii) — once D-min/proposals land — drives auto-reminders.
**No migration** (all columns exist); it is pure read + status-update + `emit`.
But it is NET-NEW infrastructure and is the true gate on the "system did the work"
feeling. ← surface to owner: this is the difference between a calm
dashboard and an app that *acts*. **The FE must NOT imply autonomous chasing
("שלחנו 3 תזכורות אתמול") until this worker ships.**

### Migration mechanics note (repo-specific gotcha)

Per `packages/db/CLAUDE.md`: hand-author the `.sql` + a `meta/_journal.json`
entry whose `when` is STRICTLY greater than the current max
(`drizzle-kit generate` is unusable here — TTY + sparse snapshots; the
`journal-integrity` guard + `assertJournalIntegrity` preflight fail a too-low
`when` before any DB connection). The D-min migration is a single `ADD COLUMN` +
CHECK widen — low risk, but it IS a Gate-6 schema change. 2.E needs no migration.

---

## 3. The "why" gap, stated precisely (corrects v1)

**What v1 said:** the only "why" surface is `apartments.status='refused'`.

**What is actually true** (verified): there are **two** coarse existing surfaces,
and a structured per-owner reason is genuinely absent:

1. `apartments.status` ∈ `{refused, unreachable, …}` (`_enums.ts:26-33`) +
   `apartments.notes` free-text (`projects.ts:142`). Apartment-grained,
   manually set, with `statusChangedAt`/`lastContactAt` freshness stamps.
2. **`discovery_records`** (`projects.ts:344-372`, migration 0066): an
   apartment-attached field-visit log with `status` ∈
   `{not_visited, no_answer, spoke_to_occupant, owner_identified, refused}` +
   a `notes` free-text column (and DEFERRED-and-empty `recordingRef`/`transcript`
   slots, `:359-360`). This is a real, under-used "why" signal v1 missed — a
   field worker's recorded reason for non-progress.

**The honest interim narrative** (until D-min ships): the app CAN truthfully say
"**X דירות סומנו כסירוב**" (count of `apartments.status='refused'`, or
`discovery_records.status='refused'`) and surface the field-worker `notes` where
present — but it **cannot** say "**3 בעלים מתנגדים**" (owner-grained) or render a
structured objection reason, because no owner-level reason column exists.
Per the North-Star "never fake it": until D-min, **omit the owner-objection
phrasing and the objector count; substitute the real apartment-refused count if
a "why" signal is wanted on the surface.**

---

## 4. DO-NOT-FABRICATE contract (the FE must honor this until each slice ships)

This is the load-bearing deliverable. For each signal, what the FE may render
TODAY vs what it must NOT render until the named slice merges.

| Signal | FE may render NOW | FE must NOT render until… |
|---|---|---|
| Distance-to-threshold (#1) | ✅ `consentedPct` vs `targetSignaturePct`; apartments-remaining computed on apartments | — (live) |
| Past-threshold (#2) | ✅ `metThreshold` celebration | — (live) |
| Per-project signed/pending (#3) | ✅ the two counts, labeled "חתימות" (requests), NOT "% consent" | conflating raw counts with consent % |
| Expiring soon (#4) | ❌ nothing | **2.B/2.A** ships `expiringSoonCount`. Even then derive expiry from `expires_at < now()`, NOT from `status='expired'`, until **2.E** sweeps |
| Momentum "+N השבוע" (#5) | ❌ nothing | **2.A** ships `signedThisWeek` |
| Stalled "אין תנועה X יום" (#6) | ❌ nothing | **2.A** ships `daysSinceLastActivity` |
| **Owner objection / "3 בעלים מתנגדים"** (#7) | ❌ NEVER the count or reason. ✅ MAY show "X דירות סומנו כסירוב" from `apartments.status`/`discovery_records.status` + field notes | **2.D (D-min)** ships `decline_reason` / `status='declined'` |
| Named holdout NAME "אורי" (#8) | ✅ "דירה 7 · partial" from the apartments endpoint. ❌ the owner's NAME | the audited PII-authz owner-read endpoint ships |
| Org pulse buckets (#9) | ❌ nothing (do NOT fetch-all-and-bucket client-side) | **2.A** ships the pulse endpoint |
| Forecast (#11) | ❌ nothing (depends on velocity) | **2.A** ships velocity; even then, SUPPRESS when velocity≈0 / N tiny |
| Milestone overlay (#12) | ✅ from `signatureMilestones` vs `consentedPct` | — (live) |
| Field-work freshness (#13) | ✅ `lastContactAt` / `statusChangedAt` relative time | — (live) |
| **"The system chased / sent reminders" (doctrine)** | ❌ NEVER imply autonomous action ("שלחנו 3 תזכורות") | **2.E** worker ships — until then the system does NOT act on a clock |

**Rule of thumb for the FE:** anything sourced from the **pulse endpoint (2.A)**
is dark until 2.A merges; anything sourced from **signature-progress**, **project
list stats**, **milestones**, or **apartment timestamps** is live now; and any
copy that asserts the SYSTEM *acted* (chased, reminded, expired-and-swept) is
dark until the **2.E worker** ships.

---

## 5. Open decisions for the owner (surfaced, not assumed)

1. **Consent-correctness rule (P0, domain — outside pure feasibility but it
   gates honesty of #1/#2/#9).** The current `consentedPct` is **binary
   per-apartment** (every active owner of an apartment must have signed; the
   apartment then counts as 1; `projects.service.ts:396-399` +
   `SignatureProgressSchema` JSDoc `project.ts:236-242`), NOT weighted by
   registered ownership share — even though
   `ownerships.shareNumerator/shareDenominator` are STORED as EXACT fractions
   summing to 1 per apartment (validated by the migration-0065 cross-multiply
   trigger, `projects.ts:289-299`). The legal תמ"א/פינוי-בינוי majority can be
   multi-dimensional (heads vs ownership-share vs per-building). **So the
   headline % the design will show may be legally wrong.** Confirm the exact
   counting rule per project type before the home leans on the number.
   ← BLOCKING for correctness; NOT a migration (the share columns already
   exist), but a domain decision + a `signatureProgress` rewrite.
2. **"stuck" threshold N** (default 14 days) — drives the "תקוע · אין תנועה X
   יום" copy and the pulse bucket; and whether `apartments.last_contact_at`
   activity should suppress the "stuck" flag. Owner to confirm.
3. **The "why" model (2.D):** D-min (`decline_reason` on `signature_requests`)
   vs D-alt (`owner_dispositions` table — the only one that can hold an objection
   BEFORE a request is sent). And whether to keep `apartments.status='refused'` /
   `discovery_records` as the coarse layer or drive them from dispositions.
   ← do not overload `apartments.status` silently.
4. **The autonomy worker (2.E) — the doctrine decision.** Building the recurring
   worker (expiry-sweep + time-based notifications + auto-reminders) is what
   makes the app *act* rather than merely *display*. It is no-migration but
   net-new infra. **Is this in scope for the re-skin, or does the redesign ship
   as a calmer read-only dashboard first, with the autonomy engine as a fast
   follow?** The design's "open the app and it already chased" payoff is
   impossible without it. ← the single biggest scope call for the doctrine.
5. **Forecast (#11):** show a soft range at all, or omit? Derivable but noisy at
   low N; recommend omit-until-velocity-is-meaningful.

---

## 6. Source map (every file cited, re-verified this pass on 2026-06-18)

- Schema: `packages/db/src/schema/artifacts.ts:86-178` (signatures,
  signature_requests, status CHECK `:173-176`, the 3 indexes `:165-172`,
  **no expires_at index**) · `packages/db/src/schema/projects.ts:34-80`
  (projects: target_signature_pct `:45`, signature_milestones `:49`,
  started_at `:75`), `:128-168` (apartments: status, status_changed_at,
  last_contact_at `:139-142`), `:208-334` (owners, ownerships + EXACT-share
  columns `:289-299`), `:344-372` (discovery_records) ·
  `packages/db/src/schema/collaboration.ts:90-143` (tasks due_at/scheduled_at,
  indexes), `:212-240` (notifications) · `packages/db/src/schema/_enums.ts:26-54`
  (apartment_status, notification_type incl. `signature_received`).
- Wire: `packages/shared-types/src/project.ts:219-288` (ProjectStats,
  SignatureProgress, ApartmentSignatureProgress, OrgStats) ·
  `packages/shared-types/src/signature-request.ts:188-196`
  (ListSignatureRequestsQuery — `.strict()`, no expires_at filter).
- Services: `apps/api/src/modules/projects/projects.service.ts:97-124`
  (statsSubqueries), `:355-435` (signatureProgress — canonical consent join),
  `:456-526` (per-apartment drill-down, no-PII), `:537-581` (orgStats +
  agent-scope CTE — the pulse-endpoint template) ·
  `apps/api/src/modules/projects/org-stats.controller.ts:26-36`
  (only `@Get('stats')` today — where the pulse endpoint lands) ·
  `apps/api/src/modules/signatures/signature-requests.service.ts:315,444`
  (expires_at > now() live-pending guards) ·
  `apps/api/src/modules/notifications/notifications-producer.service.ts:48-84`
  (emit/emitMany — synchronous only, no clock).
- **Autonomy gap:** grep `apps/api/src` for
  `@Cron|CronExpression|ScheduleModule|setInterval|nestjs/schedule` → **zero
  production hits** (one unrelated SSE-cap test). No time-driven job exists.
- FE consumption: `apps/web/src/app/[locale]/(dashboard)/page.tsx` +
  `_components/manager-home.tsx` (org-stats home today) ·
  `apps/web/src/hooks/use-projects.ts`, `use-signature-requests.ts`.

> **Bottom line (verified):** 6 of 13 signals are live on the wire today, 5 more
> are derivable behind ONE no-migration aggregate endpoint
> (`GET /org/signature-pulse`, a direct copy of the existing `orgStats`
> multi-subquery + agent-scope CTE), 1 needs a small audited PII-read for the
> holdout name, and EXACTLY ONE — the structured owner "why"/objection — needs a
> single `ADD COLUMN decline_reason` migration. The redesign's READ surface is
> buildable on today's data. But the owner's "THE SYSTEM DOES THE WORK" doctrine
> hits TWO hard gates: (1) the legal consent-counting rule, which decides whether
> the headline % is even correct; and (2) the **complete absence of any
> background worker** — today nothing chases, reminds, or expires on a clock, so
> the "it already did the work" payoff is a NET-NEW worker (no migration), not a
> data problem. The FE must not imply autonomy until that worker ships.
