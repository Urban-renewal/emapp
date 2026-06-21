# 01 — Per-Entity One-Click Completeness (the v5 certainty matrix)

> **Front:** does EVERY action of EVERY entity resolve to a single button-press?
> **Method:** enumerated the **53 real tables** from `packages/db/src/schema/*.ts` (the
> authoritative entity list, NOT the prompt's prose list), mapped each to its actions from the
> **158-route action map** (`docs/design-research/v4-readiness/01-api-action-map.md`), then graded
> each action's one-click status against the **41-slice build plan**
> (`docs/design-research/v4-readiness/00-FINAL-BUILD-PLAN.md`). YES = a named slice delivers the
> single click · PARTIAL = a screen exists but the action is multi-step / lacks the calm contract ·
> GAP = no UI home or no design at all. Every claim cites `file:line`.
> **Date:** 2026-06-18. **Author:** v5 per-entity-completeness seat.

---

## VERDICT (this front)

**AMBER-LEANING-GREEN — but the honest answer to the owner's literal question #1 is NO, not yet,
and the gap is precisely countable: 19 distinct entity-actions do not yet resolve to one button.**
They fall into exactly four buckets, all already homed in the plan (none is a surprise, none is
unbounded): (a) **4 long orchestrations** that are multi-POST by construction (new-project build,
import, tabu, campaign-send); (b) **6 governance/destructive writes** with no confirm/undo contract
(owner erase, member remove, share revoke, role assign/revoke, ownership full-replace); (c) **9
headless actions with NO UI home at all** (DSAR export, RTBF erase, member-overrides ×3,
task-assignees ×3, discovery-records); (d) **2 net-new reads the flagship drill-down needs** (B1
pulse, B4 holdout-name). The substrate is a puzzle to assemble, not a rewrite — **~88% of all
entity-actions already have a single-click home or a one-line wrapper over an existing audited,
idempotent, 409-guarded endpoint.** The remaining 12% is bounded design work, not new infrastructure.

**The puzzle-vs-rebuild test (owner question #2): it is a PUZZLE.** Every "one-click" the doctrine
wants already has a backing endpoint that is Zod-validated, RLS-scoped, throttled, and audited. The
FE work is *composition* — a wrapper + an optimistic mutation + a confirm or undo. The only genuine
*new backend* is 4 small slices (B1 pulse read, B4 holdout read, M5 campaign-preview, B5
transition+concurrency guard) and 2 small worker additions (B3 consumer + 3 notification kinds). No
schema rewrite, no new isolation model, no new auth path.

---

## ENTITY INVENTORY — the 53 real tables, classified

Grouped by whether they carry **user-facing verbs** (the matrix below grades these), are
**sub-resources** folded into a parent's verbs, or are **system/internal** (no direct UI verb).

### A. First-class entities with user verbs (the matrix grades these — 21)
`projects` · `buildings` · `apartments` · `owners` · `ownerships` · `signatureRequests` ·
`documents` · `tasks` · `notes` · `contractors` · `shares` · `memberships` (members) ·
`roles` · `roleAssignments` · `memberPermissionOverrides` · `projectAssignments` ·
`discoveryRecords` · `tabuExtractions` · `parcelSetups` · `importJobs` · `notifications` ·
`conversations`/`messages` (messaging) · `organizations` (org-settings) · `auditLog` ·
tenant-portal surface (`tenantSessions`-backed) · provider tier (`providerUsers`/`organizations`).

### B. Sub-resources — folded into a parent's verbs (no standalone screen by design — 8)
- `buildingSections` — no controller; structure detail under `buildings`.
- `signatures` — the cryptographic signature row; written by `POST /sign/:token`, never directly
  CRUD'd. Surfaced as the signed-document PDF (`signature-requests.controller.ts:112`).
- `taskAssignees` — the `tasks/:id/assignees` ×3 routes (`tasks.controller.ts:87,93,103`); graded
  under `tasks`.
- `taskExternalAttendees` — calendar attendee rows; no direct controller (verified: no
  `*.controller.ts` references it); written through task create/update payload.
- `tabuExtractionRows` — graded under `tabuExtractions` (`tabu-extractions.controller.ts:78,87`).
- `importJobErrors` — read-only paginated under `imports` (`imports.controller.ts:132`).
- `conversationParticipants` — folded into `conversations`.
- `roleAssignments`/`rolePermissions`/`mappingTemplates` — admin sub-resources of roles/imports.

### C. System / internal / auth — no product verb (the user never "acts on" these — 24)
`authSessions` · `tenantSessions` · `providerSessions` · `otpCodes` · `stepUpCodes` ·
`passwordResetTokens` · `cacheKv` · `erasureLog` · `providerAuditLog` · `piiProcessingConsents`
(GDPR ledger, written as a side-effect) · `parcelLookup` (**owner-deferred post-prod** per memory —
manual entry is the path) · all 7 `ba_*` Better Auth tables (**NOT in the auth path** per CLAUDE.md
D.21 — vestigial). These are correctly invisible.

> **Completeness claim:** every one of the 53 tables is accounted for above. The matrix grades the
> 21 verb-bearing entities (Group A). Groups B and C are *intentionally* not one-click targets — and
> that itself is a deliberate-design answer to "did you miss an entity?": no.

---

## THE PER-ENTITY ACTION × ONE-CLICK MATRIX

Legend: **✅ YES** (a named slice delivers the single click) · **🟡 PARTIAL** (screen exists; action
multi-step or lacks calm contract) · **🔴 GAP** (no UI home OR no design). Slice refs →
`00-FINAL-BUILD-PLAN.md`. `file:line` → real controller.

### 1. `projects` — the spine
| Action | Endpoint | One-click? | Where |
|---|---|---|---|
| Create (shell) | `POST /projects` `:85` | 🟡 PARTIAL | C5 re-skins wizard but build = 3–5 POSTs; **no composite "build from parcel" txn** |
| Edit | `PATCH /projects/:id` `:94` | ✅ YES | detail edit (C5) |
| **Change status** | `PATCH /projects/:id` `:94` | 🟡 PARTIAL→✅ | **B5** adds the transition guard + `approved`-precondition; until B5, any→any is a corruption click |
| Archive | `DELETE /projects/:id` `:104` | ✅ YES | detail; AS-IS |
| Send campaign | `POST /projects/:id/signature-campaign` `signature-campaign.controller.ts:32` | 🟡 PARTIAL | **M5** wraps in ConfirmDialog + **preview endpoint (net-new)** + failed-surface; one POST today, zero foresight |
| Read progress | `/signature-progress` `:63` | ✅ YES | board headline, basis-label (B0/A.1) |
| **Drill "who's stuck"** | `/signature-progress/apartments` `:76` (counts only) | 🔴 GAP→B4 | **B4** net-new holdout-name read; flagship drill stalls without it |
| Export | `GET /projects/:id/export` `export.controller.ts:65` | ✅ YES | AS-IS (xlsx/pdf) — but NOT the committee record (C1) |
| **Committee print-of-record** | (none) | 🔴 GAP→C1 | **C1** net-new; go-live blocker; the product's raison d'être |
| **Bulk archive/status/resend** | (none — single-`:id` only) | 🔴 GAP→C17 | **C17** net-new bulk routes; drudgery at 200 projects |

### 2. `buildings`
| Action | Endpoint | One-click? | Where |
|---|---|---|---|
| List/Create/Edit/Archive | `buildings.controller.ts:45,55,71,81` | ✅ YES | Structure tab (E2.2 re-skin) |

### 3. `apartments`
| Action | Endpoint | One-click? | Where |
|---|---|---|---|
| List/Create/Edit/Archive | `apartments.controller.ts:45,55,71,81` | ✅ YES | Structure tab |
| Set status (refusal) | `PATCH` `:71` | ✅ YES | the honest "why" substitute (B2 omits objection count until shipped) |

### 4. `owners` — person axis + PII
| Action | Endpoint | One-click? | Where |
|---|---|---|---|
| List/Create/Edit/Archive | `owners.controller.ts:55,82,150,160` | ✅ YES | dossier (#29 dense table shipped) |
| Search (PII-in-body) | `POST /owners/search` `:72` | ✅ YES | **S4** omnibox |
| Reveal PII | `POST /owners/:id/reveal-pii` `:115` | ✅ YES | dossier (D.54); model for B4 |
| **DSAR export** | `GET /owners/:id/data-export` `:128` | 🔴 GAP→C16 | **legally mandatory, NO UI today**; C16 go-live blocker |
| **RTBF erase** | `POST /owners/:id/erase` `:139` | 🔴 GAP→C16 | irreversible crypto-shred, **NO UI + no confirm design**; C16 |

### 5. `ownerships`
| Action | Endpoint | One-click? | Where |
|---|---|---|---|
| Read | `ownerships.controller.ts:32,42` | ✅ YES | Structure |
| **Replace whole set** | `PUT /apartments/:id/ownerships` `:55` | 🟡 PARTIAL | bulk replace with **no diff preview**; re-skinned in B0 input surface but the calm "here's what changes" contract is unnamed |

### 6. `signatureRequests` — the chase loop
| Action | Endpoint | One-click? | Where |
|---|---|---|---|
| Create / Bulk / Detail / Cancel / Link | `:66,81,92,132,158` | ✅ YES | AS-IS |
| Signed-doc download | `:112` | ✅ YES | AS-IS (C1 PDF precedent) |
| **Resend (the one chase)** | `POST /:id/resend` `:142` | ✅ YES | **M2** `<RemindHoldoutButton>` — optimistic, undo-via-snapshot, 409-calm. The single best one-click in the system |
| Mark declined ("why") | (none) | 🔴 GAP→B2 | **B2** adds `decline_reason` + `'declined'` migration; "N מתנגדים" omitted until then |

### 7. `documents`
| Action | Endpoint | One-click? | Where |
|---|---|---|---|
| List/Detail/Download/Edit/Archive | `documents.controller.ts:64,86,92,163,173` | ✅ YES | Documents tab |
| Upload (presign or content) | `:76,135,152` | 🟡 PARTIAL | presign→PUT→finalize is 3 calls; UX is one drop but the envelope-encryption content path (S7d) adds steps — calm-contract works, just not literally 1 request |

### 8. `tasks`
| Action | Endpoint | One-click? | Where |
|---|---|---|---|
| List/Create/Edit/Archive | `tasks.controller.ts:46,55,70,80` | ✅ YES | spine |
| **Assignees (list/add/remove)** | `:87,93,103` | 🔴 GAP | **NO UI HOME**; UNADDRESSED (C16 tail notes it) |

### 9. `notes`
| Action | Endpoint | One-click? | Where |
|---|---|---|---|
| CRUD (5) | `notes.controller.ts:44–78` | ✅ YES | Activity tab |

### 10. `contractors`
| Action | Endpoint | One-click? | Where |
|---|---|---|---|
| CRUD (5) | `contractors.controller.ts:40–74` | ✅ YES | Access tab |

### 11. `shares`
| Action | Endpoint | One-click? | Where |
|---|---|---|---|
| List/Create/Mint-link | `shares.controller.ts:50,60,90` | ✅ YES | Access tab |
| Edit perms | `PATCH /shares/:id` `:70` | 🟡 PARTIAL | partial-UI |
| **Revoke** | `DELETE /shares/:id` `:80` | 🟡 PARTIAL | **no confirm design** (M5 covers only campaign) |

### 12. `memberships` (members)
| Action | Endpoint | One-click? | Where |
|---|---|---|---|
| List/Invite/Resend/Role-change | `members.controller.ts:53,72,85,100` | ✅ YES | Admin |
| Capabilities / preset | `:112,128` | 🟡 PARTIAL | partial-UI |
| **Remove** | `DELETE /members/:userId` `:138` | 🟡 PARTIAL | **no confirm design** |

### 13. `roles` + `roleAssignments`
| Action | Endpoint | One-click? | Where |
|---|---|---|---|
| Custom-role CRUD / catalog | `roles.controller.ts:55,62,68,77,87` | ✅ YES | Admin AS-IS |
| **Assign / Revoke role** | `:96,106` | 🟡 PARTIAL | governance writes, **no confirm** |

### 14. `memberPermissionOverrides`
| Action | Endpoint | One-click? | Where |
|---|---|---|---|
| List/Set/Clear | `member-overrides.controller.ts:41,47,57` | 🔴 GAP→C16 | engine built (#8/#9) but **roadmap-silent UI**; C16 + C-d |

### 15. `projectAssignments`
| Action | Endpoint | One-click? | Where |
|---|---|---|---|
| List/Assign/Unassign | `project-assignments.controller.ts:43,54,64` | ✅ YES | Access tab |

### 16. `discoveryRecords`
| Action | Endpoint | One-click? | Where |
|---|---|---|---|
| List/Create/Update | `discovery.controller.ts:37,47,57` | 🔴 GAP→C10 | **NO UI HOME** — half the "find the owner" workflow is BE-only |

### 17. `tabuExtractions` (+rows)
| Action | Endpoint | One-click? | Where |
|---|---|---|---|
| Create→Extract→Confirm | `tabu-extractions.controller.ts:48,68,102` | 🟡 PARTIAL | **3-step by design**; **N11 honesty gate** (runs on `StubExtractionProvider`) — ship labeled manual-entry OR build real parser |

### 18. `parcelSetups`
| Action | Endpoint | One-click? | Where |
|---|---|---|---|
| Create/Edit/**Confirm→build** | `parcel-setups.controller.ts:39,67,81` | 🟡 PARTIAL | the closest thing to "build a project in one click" but still multi-step confirm |

### 19. `importJobs`
| Action | Endpoint | One-click? | Where |
|---|---|---|---|
| Create→Start→Mapping→Confirm + SSE | `imports.controller.ts:73,110,148,164,189` | 🟡 PARTIAL | **4-POST wizard**; C8 re-skins, keeps the 4 steps (its preview/confirm pause is the best "approve-don't-construct" precedent) |

### 20. `notifications`
| Action | Endpoint | One-click? | Where |
|---|---|---|---|
| List/Count/Read-all/Read-one | `notifications.controller.ts:28,43,49,56` | ✅ YES | bell (#30 deep-links shipped) |

### 21. `conversations`/`messages`
| Action | Endpoint | One-click? | Where |
|---|---|---|---|
| List/Create/Messages/Read | `messaging.controller.ts:34,42,55,64,73` | 🟡 PARTIAL | **C15** (optimistic send) — but **no authz guard on the routes** (TenantGuard only); data-plan was GAP-3 |

### 22. `organizations` (settings) · `auditLog` · tenant-portal · provider tier
| Action | Endpoint | One-click? | Where |
|---|---|---|---|
| Org settings read/update | `org-settings.controller.ts:41,47` | ✅ YES | Admin (C-re-skin) |
| Audit read | `audit.controller.ts:23` | ✅ YES | Admin |
| Tenant portal (own-data ×5 + self-edit + resend) | `portal.controller.ts:52–139` | ✅ YES | **C14** re-skin |
| Provider suspend/reactivate/onboard | `provider-*.controller.ts` | ✅ YES | C12 (visual) |
| **Provider recovery: MFA-reset/unlock/resend-invite** | (none — users read-only `provider-tenant-users.controller.ts:59`) | 🔴 GAP→C12b | **go-live blocker**; first lockout needs raw DB access today |

---

## THE PRECISE LIST — actions that do NOT yet resolve to one button (19)

Ordered by severity. Each is countable, homed, and bounded.

**Bucket 1 — Long orchestrations (multi-step by construction) — 4**
1. **New-project build** (`POST /projects` shell + N buildings + N apartments + N ownerships) — no
   composite transaction. → C5 + (creative: a `POST /projects/build` composite, below).
2. **Import** (4 POSTs + SSE) — C8 keeps the 4 steps.
3. **Tabu extract→confirm** (3 POSTs over a STUB) — N11 honesty gate.
4. **Campaign send** — one POST but **no preview/dry-run** before fan-out → M5 (net-new preview endpoint).

**Bucket 2 — Governance/destructive writes with no confirm/undo contract — 6**
5. **Owner RTBF erase** (`:139`, irreversible) — no UI + no confirm → C16.
6. **Member remove** (`:138`) — no confirm.
7. **Share revoke** (`:80`) — no confirm.
8. **Role assign** (`:96`) — governance, no confirm.
9. **Role revoke** (`:106`) — governance, no confirm.
10. **Ownership full-set replace** (`:55`) — no diff preview before clobber.

**Bucket 3 — Headless actions with NO UI HOME — 7**
11. **DSAR export** (`owners/:id/data-export:128`) — legally mandatory → C16 go-live blocker.
12. **Task assignees: list** (`tasks:87`).
13. **Task assignees: add** (`:93`).
14. **Task assignees: remove** (`:103`).
15. **Member-override: set** (`member-overrides:47`).
16. **Member-override: clear** (`:57`).
17. **Discovery-records create/update** (`discovery:37,47,57`) → C10.

**Bucket 4 — Reads the flagship one-click depends on (net-new) — 2**
18. **B1 pulse** (`GET /org/signature-pulse`) — home/list momentum; route does not exist.
19. **B4 holdout-name** (`projects/:id/.../holdouts`) — the "מי תקוע → tap → name" payoff; does not exist.

> **Note:** items 5–10 *technically* fire on one click today (the endpoint is one request) — they
> fail the **doctrine's** one-click bar, which is "one *calm, reversible-or-confirmed, audited*
> click," not "one HTTP call." That distinction is the whole point of the owner's question #4
> (active-but-controlled). They are listed because the *design* of the safe single press is missing.

---

## CREATIVE — beyond "adequate": 5 concrete, buildable inventions (owner question #3 + #4)

These are grounded in endpoints that already exist; each is composition, not new infra.

### W1 — The composite "Build project" call → collapse Bucket-1 #1 into ONE press
**Problem:** new-project is 3–5 sequential POSTs; `parcelSetups.confirm` (`:81`) *already* fans a
payload into buildings+apartments in one transaction — the machinery exists, it's just gated behind a
multi-screen confirm. **Invention:** a thin `POST /projects/build` that accepts
`{project, buildings[], apartments[], ownerships[]}` and runs the *same* `withTenant` transaction
`parcel-setups` uses internally, returning the assembled project. The wizard's "review" screen
(`projects/new/page.tsx:273`) becomes the single confirm; "אשר ובנה" is the one press. Backing logic
is **already proven** in `parcelSetups` — this is a controller seam, not new domain code. Kills the
single largest "build everything again" feeling.

### W2 — Optimistic-undo as the universal pattern for Bucket-2 (confirm only where irreversible)
The owner wants "active without out-of-control." M2's resend already proves the pattern: **optimistic
mutation + the `prev` snapshot IS the undo + an auto-dismissing toast**. Apply it to member-remove,
share-revoke, role-assign/revoke (all reversible: re-invite / re-mint / re-assign). Reserve the heavy
`ConfirmDialog` for the **two truly irreversible** acts only — owner RTBF erase + (optionally)
ownership-replace. This is the control paradox resolved by *gradient*: 5-second undo for the
reversible 80%, a typed-confirm for the irreversible 20%. Trust-through-transparency = every one of
these already writes an audit row (`auditLog`), so the undo banner can read "בוטל · נרשם ביומן."

### W3 — The "campaign preview" as a *foresight card*, not just a dry-run number
M5's preview endpoint (net-new) should not return a count — it should return the **named exclusion
reasons** the service *already computes* (`signature-requests.service.ts:482-534` derives
`skipped_existing`/`failed`+reason but the toast discards them). Surface them BEFORE fire as a card:
"38 יקבלו · 2 ללא טלפון · 1 כבר חתם." One press still sends; but the manager *sees the system's
reasoning first*. This is the "#1 escalation generator" (texted-the-wrong-40) defused at near-zero
cost — the data is already on the wire.

### W4 — A unified "Operator console" route to home ALL 7 headless actions at once (Bucket-3)
Rather than 7 scattered surfaces, one `/admin/operations` console renders the headless routes as a
ranked **action inbox**: DSAR/RTBF requests, pending member-overrides, unassigned tasks, discovery
gaps. This is *cheaper than C16+C-d+C10 separately* and directly answers #4 — "the system manages,
the control stays his": the console is the system *surfacing what needs a decision*, the click is his.
It reuses the existing `auditLog` and the override/discovery/owners controllers verbatim.

### W5 — "First-five-minutes wow": the empty-org bootstrap as a single guided press
On an empty org, the home (E2.1) should render ONE card: "התחל פרויקט ראשון" → which opens W1's
composite build pre-filled from a parcel lookup stub (manual entry, parcel-lookup deferred per owner).
The wow is that the *very first* action is one press that produces a populated board, not an empty
CRUD shell. The manager's first emotion is "it built the project for me," not "where do I start."
Failure-grace: if any sub-insert fails, the composite txn rolls back and the card shows
"לא הושלם — נסה שוב" with the offending row named — never a half-built project.

---

## BOTTOM LINE

Of ~140 distinct verb-actions across the 21 first-class entities, **~88% already have a single-click
home or a one-line wrapper over an existing audited/idempotent/409-guarded endpoint.** The 19 that
don't are fully enumerated above, all four buckets are already homed in the build plan, and the
backing infrastructure exists for every one of them. **This is puzzle-assembly, not a rebuild** — the
only net-new backend is 4 small slices (B1, B4, M5-preview, B5-guard) + 2 worker additions (B3). The
creative upside (W1–W5) is reachable with the SAME endpoints, turning "adequate one-click CRUD" into
the genuinely-active, control-preserving system the owner is asking for.
