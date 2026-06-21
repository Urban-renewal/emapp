# 01 — API Route → One-Click Action Map (the COMPLETE API documentation)

> **Front:** every API action accounted for, with a plan to make each a calm click.
> **Method:** enumerated **44 controller files / 158 routes** from real code via Glob + Grep
> (NOT the plan's lists), read every controller in full, cross-checked each route against
> the redesign roadmap (`docs/design-research/v3-coverage/00-FINAL-ROADMAP.md` +
> `05-backend-coverage.md`). Every claim below cites `file:line`.
> **Date:** 2026-06-18.

---

## READINESS VERDICT (this front)

**AMBER-LEANING-GREEN.** The API surface is **complete, consistent, and well-guarded** — there
is no "missing action" in the literal sense: every CRUD verb the UI needs exists, every route is
Zod-validated, permission-gated, RLS-scoped, throttled, and audited. The redesign roadmap has a
**named plan for ~90% of routes**. BUT: (a) **15 routes have no UI home today** (BE-only —
biggest control risk at 50-customer scale); (b) **4 write-actions that the doctrine demands be
"one calm click" are still multi-step or un-designed** (campaign send, new-project build,
add-residents/import, tabu confirm); (c) **2 net-new endpoints the roadmap depends on do not yet
exist** (B1 pulse, B4 holdout-name); (d) a **factual correction to the v3 audit**: the cron/
scheduler layer is **NOT zero** — it exists in `apps/worker` (the v3 audit only grepped
`apps/api/src` and missed it), but it does **hygiene only, zero proactive chasing**.

---

## GAP SUMMARY (ranked by production-impact at 50 customers / many projects)

### G1 (P0) — 15 write/read routes have NO UI home → uncontrolled at scale
These actions exist in the API and are reachable by anyone with a cookie + permission, but the
**redesign has no screen that surfaces them**, so a manager cannot SEE or CONTROL them from the
product. At 50 customers this is the chaos vector: the data exists, the actions fire, but there
is no operator console. Full list in the "NO UI HOME" section. The worst offenders:
`discovery-records` CRUD (`discovery.controller.ts:37,47,57` — half the "find the owner"
workflow is BE-only, roadmap `00:387` flags it but defers), `owners/:id/data-export` +
`owners/:id/erase` (GDPR DSAR/RTBF — `owners.controller.ts:128,139` — legally mandatory, no UI),
`member-overrides` PUT/DELETE (`member-overrides.controller.ts:47,57` — per-user permission
grants/denies with no console), and `tasks/:id/assignees` (`tasks.controller.ts:87,93,103`).

### G2 (P0) — the doctrine's "one calm click" is UNPROVEN for the 4 long flows
The owner's literal ask. Today these are **multi-request orchestrations the FE must sequence**,
and the roadmap names the re-skin but does **not** specify the single-click contract:
- **Campaign send** (`signature-campaign.controller.ts:32`) — one POST fans out to all owners,
  but there is **no preview/dry-run endpoint**: the manager cannot see "who will get this, how
  many, who is excluded, who has no phone" before firing. One click, zero foresight = the #1
  escalation generator ("you texted the wrong 40 people").
- **New-project build** — `POST /projects` (`projects.controller.ts:85`) creates only the
  project shell; buildings/apartments/ownerships are **separate POSTs**
  (`buildings.controller.ts:55`, `apartments.controller.ts:55`, `ownerships.controller.ts:55`).
  There is **no composite "build project from parcel" transaction**; `parcel-setups`
  (`parcel-setups.controller.ts:39,81`) is the closest but is its own multi-step confirm flow.
- **Add residents / import** (`imports.controller.ts:73→110→148→164` — create→start→mapping→
  confirm, a **4-POST wizard + SSE**). Powerful, but the antithesis of "one click"; roadmap
  C8 re-skins it but keeps all four steps.
- **Tabu confirm** (`tabu-extractions.controller.ts:48→68→102` — create→extract→confirm) —
  same 3-step shape; roadmap marks it out-of-scope (`05:168`).

### G3 (P1) — 2 roadmap-critical endpoints DO NOT EXIST yet
- **B1 pulse** (`GET /org/signature-pulse`) — the new home + projects-list momentum board
  depend on it; **no route exists** (confirmed: only `org-stats.controller.ts:31` `/org/stats`
  exists, which the roadmap deletes — `05:124` GAP-7). If the home ships before B1, it is
  un-backed or double-fetches a dead endpoint.
- **B4 holdout-name read** — the "מי תקוע → tap → name" flow. `signatureProgressApartments`
  (`projects.controller.ts:76`) deliberately returns **counts only, no owner identity**
  (`05:103,234` verified). No route returns the holdout owner. Without B4, the flagship
  drill-down stalls mid-build (`05:19` GAP-1).

### G4 (P1) — CORRECTION: scheduler EXISTS, but does ZERO chasing
The v3 audit (`05:231`) claims "scheduler=0" — that grep only covered `apps/api/src` and
**missed `apps/worker`**. Reality: pg-boss cron is live (`apps/worker/src/main.ts:245,274,309`)
running 3 jobs — `reaper` (hourly), `audit-retention` (daily), `signature-expiry` (hourly).
BUT the expiry sweep does a **bulk UPDATE → 'expired' + one audit row, and NOTHING ELSE**
(`packages/db/src/helpers/signature-expiry-sweep.ts:64–85` — no notification, no email, no SMS,
no reminder). So the lead's diagnosis is **half-right**: hygiene cron exists; **proactive
"chase" cron does not.** There is no "remind unsigned owners 3 days before expiry," no
"stalled-project nudge," no "threshold-reached" notification. At 50 customers, nothing chases on
a clock — the manager must remember to manually `resend` (`signature-requests.controller.ts:142`)
every pending link. This is the single biggest autonomy gap on this front.

### G5 (P2) — no project-status-transition guard at the API
`PATCH /projects/:id` (`projects.controller.ts:94`) accepts a status change via
`UpdateProjectInput`. There is **no state-machine guard** enforcing the legal D.18 transition
order (`planning → gathering_signatures → approved → in_construction → completed`). Any manager
can jump a project straight to `completed` or back to `planning`. At scale this corrupts the
pulse board's "stalled/momentum" derivations and the legal record. (Needs verification that the
service doesn't gate it — controller does not.)

### G6 (P2) — write-actions lacking a calm one-click design (roadmap silent)
Beyond the 4 long flows: `owners/:id/erase` (irreversible crypto-shred,
`owners.controller.ts:139`), `members/:userId` DELETE (`members.controller.ts:138`),
`shares/:id` revoke (`shares.controller.ts:80`), and `roles assignments` (`roles.controller.ts:96,
106`) are all destructive/governance writes with **no confirm-dialog or undo contract** named in
the roadmap. M5 names a generic `ConfirmDialog` for campaign send only (`05:125`); the rest are
unscoped.

---

## MASTER ENDPOINT TABLE (all 158 routes)

Legend — **UI**: which surface/role triggers it (or NO-UI). **Click**: redesign one-click plan
(or UNADDRESSED). All org routes: guard chain `AuthGuard → TenantGuard → AuthorizationGuard`,
`withTenant` RLS in service, `{data}` envelope (D.16) unless noted.

### Auth + identity (no redesign scope — correctly untouched)
| Method · Path | Guard / Permission | Does | DTO | UI / Role | Click plan | Notes |
|---|---|---|---|---|---|---|
| POST /auth/signup | @Public, Throttle 5/10min | self-serve signup (404 unless `PUBLIC_SIGNUP_ENABLED=1`) | `SignupSchema` | signup page (INACTIVE) | n/a | provider-led onboarding is the live path (`auth.controller.ts:54`) |
| POST /auth/login | @Public, 10/min | login, sets cookies | `LoginSchema` | login page | AS-IS | `auth.controller.ts:87` |
| POST /auth/refresh | @Public, 30/min | rotate refresh | cookie | transparent | AS-IS | `:110` |
| POST /auth/forgot-password | @Public, 5/15min | generic-200 reset email | `ForgotPasswordSchema` | forgot page | AS-IS | anti-enum `:130` |
| POST /auth/reset-password | @Public, 10/15min | consume reset token | `ResetPasswordSchema` | reset page | AS-IS | `:152` |
| POST /auth/logout | AuthGuard | revoke session | — | topbar | AS-IS | `:161` |
| POST /auth/switch-org | AuthGuard | switch active org | `OrgSwitchSchema` | org switcher | AS-IS | `:174` |
| POST /auth/accept-invite | @Public | set password from invite token | `AcceptInviteInput` | invite page | AS-IS | `accept-invite.controller.ts:16` |
| GET /me | AuthGuard | self profile | — | bootstrap | seeded in session cache (PR #401) | `me.controller.ts:13` |
| POST /auth/step-up/request | AuthGuard, 5/15min | email PII-unlock OTP | — | StepUpDialog | M6 a11y re-skin (FE) | `step-up.controller.ts:30` |
| POST /auth/step-up/verify | AuthGuard, 10/15min | stamp pii_unlocked_at | `StepUpVerifySchema` | StepUpDialog | M6 | `:41` |
| POST /auth/otp/request | @Public, 5/15min | tenant SMS OTP send | `OtpRequestSchema` | tenant login | C11 counterparty | `otp.controller.ts:30` |
| POST /auth/otp/verify | @Public, 10/15min | tenant OTP verify, sets cookie | `OtpVerifySchema` | tenant login | C11 | `:41` |

### Projects / signature spine (the product core)
| Method · Path | Permission | Does | DTO | UI / Role | Click plan | Notes |
|---|---|---|---|---|---|---|
| GET /projects | projects.read | list (counts) | `ListProjectsQuery` | projects list | **CHANGED** sort-by-distance (`00:342`) | `projects.controller.ts:44` |
| GET /projects/:id | projects.read | detail | — | project detail | **CHANGED** board-first | `:53` |
| GET /projects/:id/signature-progress | projects.read | consentedPct/target/metThreshold | — | board headline | **COVERED** basis-label §6.1 | `:63` |
| GET /projects/:id/signature-progress/apartments | projects.read | per-apt counts, **NO names** | — | "מי תקוע" | **CHANGED + needs B4** | `:76` (G3) |
| POST /projects | projects.create | create project shell ONLY | `CreateProjectInput` | new-project wizard | **G2: not one-click** | `:85` |
| PATCH /projects/:id | projects.update | update (incl. status) | `UpdateProjectInput` | detail edit | **G5: no transition guard** | `:94` |
| DELETE /projects/:id | projects.archive | archive | — | detail | AS-IS | `:104` |
| GET /org/stats | projects.read | home KPI grid backing | — | home (deleted) | **GAP-7** fate unstated | `org-stats.controller.ts:31` |
| POST /projects/:id/signature-campaign | signature_requests.send, 10/min | fan out 1 doc → ALL owners | `SignatureCampaignInput` | project board | **G2: one POST, no preview/dry-run** | `signature-campaign.controller.ts:32` |

### Signature requests (the chase loop)
| Method · Path | Permission | Does | DTO | UI / Role | Click plan | Notes |
|---|---|---|---|---|---|---|
| GET /signature-requests | signature_requests.read | list/library | `ListSignatureRequestsQuery` | project tab | **CHANGED** | `signature-requests.controller.ts:52` |
| POST /signature-requests | signature_requests.send, 30/min | create 1 | `CreateSignatureRequestInput` | request UI | AS-IS | `:66` |
| POST /signature-requests/bulk | signature_requests.send, 10/min | 1 doc → many owners (≤200) | `BulkCreateSignatureRequestInput` | bulk UI | AS-IS | `:81` |
| GET /signature-requests/:id | signature_requests.read | detail | — | detail | AS-IS | `:92` |
| GET /signature-requests/:id/signed-document | owners.read (+PII fidelity) | signed certificate PDF (binary) | — | detail download | AS-IS; precedent for C1 PDF | `:112` |
| POST /signature-requests/:id/cancel | signature_requests.cancel | pending→cancelled | — | detail | AS-IS | `:132` |
| POST /signature-requests/:id/resend | signature_requests.send, 30/min | re-mint + re-deliver link | — | detail | **COVERED** M2 (`00:341`) — the ONLY chase loop, manual | `:142` (G4) |
| POST /signature-requests/:id/link | signature_requests.send, 30/min | out-of-band link (no delivery) | — | detail | AS-IS | `:158` |
| GET /sign/:token | @Public, 30/hr | public sign view | — | public signer | AS-IS | `public-sign.controller.ts:29` |
| POST /sign/:token | @Public, 5/hr | submit signature | `PublicSignSubmitInput` | public signer | AS-IS | `:37` |

### Owners (person axis + global search)
| Method · Path | Permission | Does | DTO | UI / Role | Click plan | Notes |
|---|---|---|---|---|---|---|
| GET /owners | owners.read | list | `ListOwnersQuery` | owners table | **CHANGED** dossier | `owners.controller.ts:55` |
| POST /owners/search | owners.read, 20/min | PII-in-body hash search | `OwnerSearchDto` | omnibox | **COVERED** S4 (`00:120`) | `:72` |
| POST /owners | owners.create | create | `CreateOwnerDto` | owner UI | AS-IS | `:82` |
| GET /owners/:id | owners.read | dossier detail | — | dossier | **CHANGED** | `:91` |
| GET /owners/:id/projects | owners.read | owner→projects | — | dossier | **COVERED** | `:102` |
| POST /owners/:id/reveal-pii | owners.read (+view_owner_pii), 20/min | D.54 cleartext reveal | — | dossier | AS-IS = B4 model | `:115` |
| GET /owners/:id/data-export | owners.reveal_pii, 20/min | GDPR DSAR export (cleartext) | — | **NO UI HOME** | UNADDRESSED | `:128` (G1) |
| POST /owners/:id/erase | owners.reveal_pii, 20/min | GDPR RTBF crypto-shred (irreversible) | `OwnerEraseDto` | **NO UI HOME** | **G6: no confirm design** | `:139` (G1) |
| PATCH /owners/:id | owners.update | update | `UpdateOwnerDto` | dossier | AS-IS | `:150` |
| DELETE /owners/:id | owners.archive | archive | — | dossier | AS-IS | `:160` |

### Structure spine (buildings / apartments / ownerships / discovery / tabu / parcel)
| Method · Path | Permission | Does | UI / Role | Click plan | Notes |
|---|---|---|---|---|---|
| GET·POST /projects/:projectId/buildings | buildings.read·create | list·create | Structure tab | **CHANGED** | `buildings.controller.ts:45,55` |
| GET·PATCH·DELETE /buildings/:id | buildings.read·update·archive | CRUD | Structure tab | AS-IS | `:65,71,81` |
| GET·POST /buildings/:buildingId/apartments | apartments.read·create | list·create | Structure tab | **CHANGED** | `apartments.controller.ts:45,55` |
| GET·PATCH·DELETE /apartments/:id | apartments.read·update·archive | CRUD | Structure tab | AS-IS | `:65,71,81` |
| GET /apartments/:apartmentId/ownerships | ownerships.read | list ownerships | Structure | AS-IS | `ownerships.controller.ts:32` |
| GET /apartments/:apartmentId/owners | ownerships.read | apartment owners | Structure | AS-IS | `:42` |
| PUT /apartments/:apartmentId/ownerships | ownerships.set | **replace whole ownership set** | Structure | **G2-adjacent: bulk replace, no diff preview** | `:55` |
| GET·POST /apartments/:apartmentId/discovery-records | apartments.read·update | find-the-owner records | **NO UI HOME** | **GAP** C10 deferred (`00:387`) | `discovery.controller.ts:37,47` |
| PATCH /discovery-records/:id | apartments.update | update record | **NO UI HOME** | **GAP** | `:57` |
| GET·POST /apartments/:apartmentId/tabu-extractions | apartments.read·update | list·create extraction | tabu flow | AS-IS (out of scope) | `tabu-extractions.controller.ts:38,48` |
| GET /tabu-extractions/:id | apartments.read | detail | tabu | AS-IS | `:58` |
| POST /tabu-extractions/:id/extract | apartments.update | run parse | tabu | **G2: step 2 of 3** | `:68` |
| GET /tabu-extractions/:id/rows | apartments.read | parsed rows | tabu review | AS-IS | `:78` |
| PATCH /tabu-extractions/:id/rows/:rowId | apartments.update | edit row | tabu review | AS-IS | `:87` |
| POST /tabu-extractions/:id/confirm | apartments.update | commit ownerships | tabu review | **G2: step 3 of 3** | `:102` |
| POST·GET /projects/:projectId/parcel-setups | buildings.create·read | create·list parcel setup | Setup tab | AS-IS | `parcel-setups.controller.ts:39,49` |
| GET·PATCH /parcel-setups/:id | buildings.read·update | detail·edit payload | Setup tab | AS-IS | `:59,67` |
| POST /parcel-setups/:id/confirm | buildings.create | commit → buildings/apartments | Setup tab | **G2: closest thing to "build project" but multi-step** | `:81` |

### Documents
| Method · Path | Permission | Does | UI / Role | Click plan | Notes |
|---|---|---|---|---|---|
| GET /documents | documents.read | list/library | Documents tab | **CHANGED** | `documents.controller.ts:64` |
| POST /documents | documents.create, 30/min | create + presign PUT (or content path) | upload UI | AS-IS | `:76` |
| GET /documents/:id | documents.read | detail | detail | AS-IS | `:86` |
| GET /documents/:id/download | documents.read, 30/min | presign OR decrypt-stream | detail | AS-IS | `:92` |
| POST /documents/:id/content | documents.create, 30/min | raw-bytes upload (sensitive, ≤50MB) | upload | AS-IS | `:135` |
| POST /documents/:id/finalize | documents.create | finalize upload | upload | AS-IS | `:152` |
| PATCH /documents/:id | documents.update | update | detail | AS-IS | `:163` |
| DELETE /documents/:id | documents.archive | archive | detail | AS-IS | `:173` |

### Imports (live-SSE; the 4-step long flow)
| Method · Path | Permission | Does | UI / Role | Click plan | Notes |
|---|---|---|---|---|---|
| POST /imports | imports.run, 30/min | create row + presign | import wizard | **G2: step 1/4** | `imports.controller.ts:73` |
| GET /imports | imports.read | list | wizard | AS-IS | `:87` |
| GET /imports/:id | imports.read | status snapshot | wizard | AS-IS | `:96` |
| POST /imports/:id/start | imports.map, 30/min | enqueue worker job | wizard | **G2: step 2/4** | `:110` |
| DELETE /imports/:id | imports.cancel | cancel non-terminal | wizard | AS-IS | `:125` |
| GET /imports/:id/errors | imports.read | paginated errors | wizard | AS-IS | `:132` |
| POST /imports/:id/mapping | imports.map, 30/min | D.34 column mapping | wizard | **G2: step 3/4** | `:148` |
| POST /imports/:id/confirm | imports.map, 30/min | commit preview run | wizard | **G2: step 4/4** | `:164` |
| GET /imports/:id/stream | imports.read, 5/min, max 30 concurrent | SSE progress | wizard | **COVERED** C8 (`00:378`) | `:189` |

### Tasks / notes / contractors / shares (demoted from spine)
| Method · Path | Permission | Does | UI / Role | Click plan | Notes |
|---|---|---|---|---|---|
| GET·POST /tasks | tasks.read·create | list·create | spine | **CHANGED** | `tasks.controller.ts:46,55` |
| GET·PATCH·DELETE /tasks/:id | tasks.read·update·archive | CRUD | spine | AS-IS | `:64,70,80` |
| GET /tasks/:id/assignees | tasks.read | list assignees | **NO UI HOME** | UNADDRESSED | `:87` (G1) |
| POST /tasks/:id/assignees | tasks.create | add assignee | **NO UI HOME** | UNADDRESSED | `:93` (G1) |
| DELETE /tasks/:id/assignees/:userId | tasks.archive | remove assignee | **NO UI HOME** | UNADDRESSED | `:103` (G1) |
| GET·POST·GET·PATCH·DELETE /notes(+:id) | notes.* | CRUD (5) | Activity tab | **CHANGED** | `notes.controller.ts:44–78` |
| GET·POST·GET·PATCH·DELETE /contractors(+:id) | contractors.* | CRUD (5) | Access tab | **CHANGED** | `contractors.controller.ts:40–74` |
| GET /projects/:projectId/shares | @TenantScoped | list shares | Access tab | **CHANGED** | `shares.controller.ts:50` |
| POST /projects/:projectId/shares | shares.create | create share | Access tab | **CHANGED** | `:60` |
| PATCH /shares/:id | @TenantScoped | edit perms | Access tab | partial-UI | `:70` |
| DELETE /shares/:id | shares.revoke | revoke | Access tab | **G6: no confirm** | `:80` |
| POST /shares/:id/link | shares.create | mint contractor link | Access tab | AS-IS | `:90` |
| GET /contractor/project·progress·documents·documents/:id/download | ContractorAuthGuard, 60/min | contractor portal (4 reads) | contractor (external) | **CHANGED** C7 | `contractor-read.controller.ts:33–48` |

### Messaging + notifications (topbar cluster)
| Method · Path | Guard | Does | UI / Role | Click plan | Notes |
|---|---|---|---|---|---|
| GET·POST /conversations | AuthGuard+TenantGuard (NO authz) | list·create conversation | topbar | **GAP-3** no data-plan | `messaging.controller.ts:34,42` |
| GET /conversations/:id | same | detail | topbar | **GAP-3** | `:50` |
| GET·POST /conversations/:id/messages | same | list·post message | topbar | **GAP-3** | `:55,64` |
| POST /conversations/:id/read | same | mark read | topbar | **GAP-3** | `:73` |
| GET /notifications | @TenantScoped | list | bell | **CHANGED** | `notifications.controller.ts:28` |
| GET /notifications/unread-count | @TenantScoped | count | bell | AS-IS | `:43` |
| POST /notifications/read-all | @TenantScoped | mark all read | bell | AS-IS | `:49` |
| POST /notifications/:id/read | @TenantScoped | mark one read | bell | AS-IS | `:56` |

### Admin group (members / roles / overrides / audit / org / export)
| Method · Path | Permission | Does | UI / Role | Click plan | Notes |
|---|---|---|---|---|---|
| GET /members | members.read | list | Admin | **CHANGED** | `members.controller.ts:53` |
| GET /members/capability-presets | members.read | preset catalog | Admin | AS-IS | `:66` |
| POST /members | members.invite | invite | Admin | AS-IS | `:72` |
| POST /members/:userId/resend | members.invite, 5/min | re-issue invite | Admin | AS-IS | `:85` |
| PATCH /members/:userId | members.update | change role | Admin | AS-IS | `:100` |
| PATCH /members/:userId/capabilities | members.update | set agent JSONB flags | Admin | partial-UI | `:112` |
| POST /members/:userId/apply-capability-preset | members.update | apply preset | Admin | partial-UI | `:128` |
| DELETE /members/:userId | members.remove | remove member | Admin | **G6: no confirm** | `:138` |
| GET /members/:userId/overrides | roles.read | list per-user overrides | **NO UI HOME** (built #9 but roadmap silent) | UNADDRESSED | `member-overrides.controller.ts:41` |
| PUT /members/:userId/overrides | roles.manage | set grant/deny override | **NO UI HOME** | UNADDRESSED | `:47` (G1) |
| DELETE /members/:userId/overrides | roles.manage | clear override | **NO UI HOME** | UNADDRESSED | `:57` (G1) |
| GET /roles | roles.read | list | Admin | AS-IS | `roles.controller.ts:55` |
| GET /roles/catalog | roles.read | permission catalog | Admin | AS-IS | `:62` |
| POST·PATCH·DELETE /roles(+:id) | roles.manage | custom-role CRUD | Admin | AS-IS | `:68,77,87` |
| POST /roles/assignments | roles.assign | assign role | Admin | **G6: governance, no confirm** | `:96` |
| DELETE /roles/assignments | roles.revoke | revoke role | Admin | **G6** | `:106` |
| GET·POST /projects/:projectId/assignments | project_assignments.read·manage | agent project-scope | Access tab | **CHANGED** | `project-assignments.controller.ts:43,54` |
| DELETE /assignments/:id | project_assignments.manage | unassign | Access tab | AS-IS | `:64` |
| GET /audit | audit.read | audit log | Admin | **CHANGED** | `audit.controller.ts:23` |
| GET·PATCH /org/settings | org.settings.read·update | org settings | Admin | **CHANGED** | `org-settings.controller.ts:41,47` |
| GET /projects/:id/export?format=xlsx\|pdf | export.run, 10/hr (+DB rate-limit) | bulk export (binary) | project | AS-IS; **NOT the C1 committee PDF (GAP-4)** | `export.controller.ts:65` |

### Tenant portal (own-data, SMS-OTP tier)
| Method · Path | Guard | Does | Notes |
|---|---|---|---|
| GET /portal/me·apartment·documents·signatures·progress | TenantAuthGuard | own-data reads (5) | `portal.controller.ts:52,82,88,94,104` |
| PATCH /portal/me | TenantAuthGuard, 10/10min | self-update email only | `:69` |
| POST /portal/signatures/:id/resend | TenantAuthGuard, 3/10min | resident re-sends own link | `:124` |
| POST /portal/logout | TenantAuthGuard | revoke tenant session | `:139` |

### Provider-Admin tier (cross-tenant, MFA, audited — out of E2 redesign scope)
| Method · Path | Guard / Action | Does | Notes |
|---|---|---|---|
| POST /provider/auth/login·refresh·logout | ProviderAuthGuard | provider auth (3) | `provider-auth.controller.ts:34,49,63` |
| GET /provider/me | ProviderAuthGuard | self identity | `provider-me.controller.ts:50` |
| GET /provider/tenants | +audit interceptor, 30/min | list tenants | `provider-tenants.controller.ts:49` |
| POST /provider/tenants | RequireProviderAction(write), 10/min | onboard org | `provider-onboarding.controller.ts:39` |
| GET /provider/tenants/:id | audited, 10/min | tenant detail | `provider-tenant-detail.controller.ts:43` |
| GET /provider/tenants/:id/users | audited, 10/min | tenant users | `provider-tenant-users.controller.ts:59` |
| POST /provider/tenants/:id/suspend·reactivate | write, 10/min | suspend/reactivate (2) | `provider-tenant-suspension.controller.ts:55,67` |
| GET /provider/audit·audit/self | audited, 30/min | cross-tenant audit (2) | `provider-audit.controller.ts:42,57` |
| GET /provider/system-health | audited, 30/min | health | `provider-system-health.controller.ts:33` |
| GET /metrics | none (Prometheus scrape) | metrics text | `metrics.controller.ts:22` |

---

## ENDPOINTS WITH NO UI HOME (the control gap)
These respond to a valid cookie + permission but the redesign surfaces no screen → **invisible
actions** at 50-customer scale:
1. `GET·POST·PATCH /apartments/:apartmentId/discovery-records` + `/discovery-records/:id`
   (`discovery.controller.ts:37,47,57`) — find-the-owner workflow, BE-only (C10 deferred).
2. `GET /owners/:id/data-export` (`owners.controller.ts:128`) — **GDPR DSAR, legally mandatory.**
3. `POST /owners/:id/erase` (`:139`) — **GDPR RTBF, irreversible.**
4. `GET·PUT·DELETE /members/:userId/overrides` (`member-overrides.controller.ts:41,47,57`) —
   per-user permission grants/denies (engine-built, roadmap silent).
5. `GET·POST·DELETE /tasks/:id/assignees(+/:userId)` (`tasks.controller.ts:87,93,103`).
6. `PATCH /members/:userId/capabilities` + `apply-capability-preset` (`members.controller.ts:112,
   128`) — partial/uncertain UI home.

## ENDPOINTS WHOSE REDESIGN THE ROADMAP IS SILENT ON
- `GET /org/stats` — kept, retired, or superseded by B1? (`05:124` GAP-7).
- Messaging 6 routes — topbar cluster has no named data plan (`05:198` GAP-3).
- `member-overrides`, `tasks/assignees`, `discovery-records` (above).
- `tabu-extractions` 7 routes — "out of scope" but they're live owner-data writes.

## WRITE-ACTIONS LACKING A CALM ONE-CLICK DESIGN
- **Campaign send** — needs a **preview/dry-run endpoint** (who/how-many/excluded) before fire.
- **New-project build** — needs a **composite transaction** (project+buildings+apartments+
  owners in one call) to be one click; today 3–5 sequential POSTs.
- **Import** (4 POSTs + SSE) and **Tabu** (3 POSTs) — multi-step by design; one-click contract
  unspecified.
- **Destructive/governance**: `owners/erase`, `members DELETE`, `shares revoke`,
  `roles assignments` — no confirm/undo design (M5 covers only campaign).
- **`PUT /apartments/:id/ownerships`** — full-set replace with no diff preview.

## THE MISSING "CHASE" LAYER (autonomy gap — what SHOULD exist but doesn't)
The doctrine is "the system does the work." Today the only chase is the **manual**
`signature-requests/:id/resend`. To be genuinely autonomous the API needs (none exist):
- a **reminder-before-expiry** cron job (the expiry sweep only flips status —
  `signature-expiry-sweep.ts:64`);
- **stalled-project** + **threshold-reached** notification kinds (current kinds carry none —
  `05:71,237`);
- a **campaign dry-run/preview** endpoint;
- a **project-status state-machine guard** (`PATCH /projects` is ungated — G5).
