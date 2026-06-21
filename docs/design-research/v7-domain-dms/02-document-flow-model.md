# 02 — THE PER-ENTITY DOCUMENT-FLOW MODEL (the owner's sharpened ask)

> **Front:** the document-FLOW model the owner sharpened — documents as the
> *connective tissue* of the whole urban-renewal process. NOT a flat file list, NOT
> a passive store: a **two-sided, per-entity flow** (what each entity PROVIDES vs
> what it RECEIVES/is OWED), where a **missing document is a first-class row** that
> **drives the workflow** (the agentic chase loop applied to documents).
> Author: v7 document-flow seat, 2026-06-18. Grounded in the live `documents`
> module + `artifacts.ts` schema + `tasks`/`notifications` + the `shares`/contractor
> external tier. Honest about puzzle (reuse) vs net-new.
>
> **Relationship to the sibling v7 docs.** `02-document-management.md` designed the
> *storage + organization + ACL + hub* (folders, parenting, versioning, search).
> `03-external-sharing.md` designed the *outbound send-to-external* mechanism
> (`document_shares`). **This doc is the layer ABOVE both:** the *flow model* — the
> per-entity, two-sided checklist of what is EXPECTED, what is RECEIVED, and what is
> MISSING, and how MISSING drives tasks/chasing. The hub/ACL/parenting/sharing work
> is the substrate; this doc adds the **`document_requirements`** spine (the
> expected-document as a row) that turns the store into a flow. Read those two first;
> this completes the picture the owner asked the experts to finish.
>
> **One-line verdict.** The storage spine is production-grade and the hub/parenting
> work (sibling docs) makes a document *findable per entity*. What is still entirely
> missing — and is the heart of the owner's sharpened ask — is the **expectation
> layer**: today a document only exists once uploaded; there is no concept of a
> document that *should* exist but doesn't. The flow model adds exactly one net-new
> spine table (`document_requirements`) + a per-entity-type requirement TEMPLATE +
> a fulfillment-matching rule + a missing→task chase tie-in. ~55% puzzle (parenting,
> tasks, notifications, audit, external sharing all reused), ~45% net-new (the
> requirement spine + template + the two-sided direction concept). The result: the
> system can finally answer *"what does this owner / this וועדה / this project still
> owe, and who is chasing it?"* — which is precisely the certainty the owner wants.

---

## 0. What exists today (grounded — the substrate this builds on)

### 0.1 The `documents` table (`packages/db/src/schema/artifacts.ts:23`)

`documents` is a **store of things that arrived**: `id, org_id, project_id?,
apartment_id?, name, type (free text), mime_type, size_bytes, r2_key, content_hash,
uploaded_by, uploaded_at, scan_status, scan_signature, sensitive, archived_at`. A
row exists **only after** an upload is initiated; the lifecycle is *(no row)* →
created → uploaded → scanned → (archived). **There is no row for a document that is
owed but not yet provided.** Parenting is the flat 3-way nullable FK
(project OR apartment OR org-level); there is no `owner_id`/`building_id` link
(the sibling hub doc adds those). `type` is free text.

### 0.2 The entity graph the flow rides on (`schema/projects.ts`)

`projects → buildings → apartments → ownerships → owners`, plus `discovery_records`
(occupant/renter as a discovery source attached to an apartment, NOT an owner —
`projects.ts:344`), `contractors` + `shares` (the one external tier today,
`collaboration.ts:21/54`), and team members (`users` + `project_assignments`,
`collaboration.ts:242`). **The external parties the owner names — שמאי / אדריכל /
עו"ד / bank / וועדה — do NOT exist as entities** (the sibling external-sharing doc
adds `external_recipients`). So the flow model's "entity" axis spans:
**project · building · apartment · owner · renter(occupant) · contractor ·
team-member · external-recipient(appraiser/architect/lawyer/bank/committee).**

### 0.3 The chase machinery (`collaboration.ts`)

- **`tasks`** (`:90`): `org_id, project_id?, apartment_id?, title, description,
  type (free text, default 'general'), status (pending|in_progress|completed|
  cancelled), priority, due_at, scheduled_at, completed_at, created_by`. **This is
  the chase primitive** — a task already hangs off a project or apartment and has a
  due date + status. It does **not** yet hang off an owner, a document, or a
  document-requirement.
- **`notifications`** (`:212`): typed (`notificationTypeEnum`), with `title, body,
  link, metadata jsonb`. `document_uploaded` already exists; **there is no
  `document_requested`/`document_overdue` type.**
- **`audit_log`** (`artifacts.ts`): every `document.{create,finalize,scan_clean,
  download,...}` is logged. The flow's state transitions ride this verbatim.

**Net substrate verdict:** the store, the entity graph, the task/notification chase
rails, and the audit spine all exist. **The one thing absent is the
*expectation*** — a representable "this entity owes this document and hasn't
provided it." That absence is the model.

---

## 1. The model in one picture

```
        PROVIDES (outbound)                         RECEIVES / IS OWED (inbound)
        ──────────────────                          ───────────────────────────
 OWNER  ת"ז · נסח-בעלות · ייפוי-כוח   ──┐      ┌──  ההסכם לחתימה · התקנון · נספח-דירה
 APT    מדידה · היתר-קודם              │      │     —
 BLDG   נסח-מתחם · תב"ע · מפת-מדידה    │      │     —
 PROJ   תקנון · נסח-מתחם · אומדן       │      │     —
 שמאי   השומה (the appraisal)          ├─►  DOCUMENT  ◄─┤  נסח · תוכניות · אומדן-בסיס
 אדריכל תוכניות · היתר                  │   REQUIREMENT  │  נסח · תב"ע · מדידה
 עו"ד   חוו"ד · נוסח-הסכם               │   (one row =   │  כל החתימות · התצהירים · התקנון
 bank   מכתב-ליווי                      │   one expected │  השומה · התקנון · ספירת-חתימות
 וועדה  אישור/החלטה · היתר              │    document)   │  החבילה המלאה (signed+תצהירים+שומה+תוכניות)
 contractor  —                         ┘               └  overview · shared docs (today)
```

Every cell is a **`document_requirement`** — a row that says *"entity E, in
project P, is EXPECTED to {provide|receive} a document of type T."* The row exists
from the moment the entity exists (templated, §3). It is `missing` until a real
`documents` row fulfills it. **The MISSING set is the work queue.** The same
document can fulfill a *provide* requirement on one side and a *receive*
requirement on the other (the שומה the שמאי PROVIDES is the שומה the bank/וועדה
RECEIVES) — one `documents` row, two satisfied requirements. That duality is the
"connective tissue."

---

## 2. THE REQUIRED-DOCUMENTS TEMPLATE (the domain IP)

This is the per-entity-type catalogue for תמ"א 38 / פינוי-בינוי. Each row is a
**requirement template**: `(entity_type, direction, doc_type, obligation, default
sensitivity, who-fulfills, who-it-satisfies)`. `obligation` ∈ `required | conditional
| optional`. The manager edits per project; this is the *day-one correct structure*
(the analogue, on the flow axis, of the sibling doc's system-folders).

Legend: **P** = PROVIDES (outbound, the entity supplies it) · **R** = RECEIVES
(inbound, the entity is owed it). 🔒 = sensitive (PII/financial → envelope-encrypted +
OTP per the existing gate). "cond." = conditional (only when a predicate holds).

### 2.1 PROJECT (the container)
| Dir | Document | Obligation | Notes |
|---|---|---|---|
| P/R | **תקנון** (regulation) | required | the master agreement framework; owners RECEIVE it, project HOLDS it |
| P | **נסח מתחם** (block tabu extract) | required | 🔒 holds PII once parsed |
| P | **תב"ע / זכויות בנייה** (zoning/TBA) | required | building-rights basis |
| P | **אומדן / תוכנית עסקית** (feasibility) | conditional | cond. on financing stage |
| P | **מפת מדידה / תשריט מתחם** | required | the site survey |
| R | **אישור וועדה / החלטה** (committee decision) | required | the approval artifact (post-threshold) |
| R | **היתר בנייה** (building permit) | conditional | cond. on `approved`→`in_construction` |

### 2.2 BUILDING
| Dir | Document | Obligation | Notes |
|---|---|---|---|
| P | **נסח טאבו (מבנה/חלקה)** | required | 🔒 per-parcel extract |
| P | **תשריט / מפת מדידה** | required | site plan for this building |
| P | **תיק בניין / היתר קודם** | optional | historical permit file |

### 2.3 APARTMENT
| Dir | Document | Obligation | Notes |
|---|---|---|---|
| P | **נסח דירה / רישום** | conditional | cond. when per-apartment tabu exists |
| P | **מדידת דירה / תשריט** | optional | self-declared measurement |
| R | **נספח דירה להסכם** (apartment annex) | required | the per-apartment terms annex owners sign against |

### 2.4 OWNER (the heart of the chase)
| Dir | Document | Obligation | Notes |
|---|---|---|---|
| P | **ת"ז / תעודת זהות** (id_document) | required | 🔒 the identity proof |
| P | **נסח בעלות** (ownership tabu) | required | 🔒 proves the share |
| P | **ייפוי כוח** (power_of_attorney) | conditional | cond. when signing via representative (ties DOM-1 estate/POA) |
| P | **תצהיר** (affidavit) | conditional | cond. on the legal track requiring it |
| R | **ההסכם לחתימה** (the agreement) | required | the signature artifact — RECEIVES then signs |
| R | **התקנון** (regulation copy) | required | owners are owed the rules |
| R | **נספח הדירה** (their apartment annex) | required | their specific terms |
| R | **אישור חתימה / עותק חתום** | required | the counter-signed copy back (non-repudiation) |

### 2.5 RENTER / OCCUPANT (`discovery_records`)
| Dir | Document | Obligation | Notes |
|---|---|---|---|
| P | **חוזה שכירות** | optional | establishes occupancy; rarely required |
| R | **הודעת פינוי / הסדר מעבר** | conditional | cond. on relocation track (post-MVP DOM-5) |

### 2.6 CONTRACTOR (builder — the existing external tier)
| Dir | Document | Obligation | Notes |
|---|---|---|---|
| P | **ערבויות / ביטוח / רישיון קבלן** | conditional | financial-guarantee docs (post-MVP) |
| R | **project overview · shared docs** | required | TODAY's contractor-share IS this row (puzzle) |

### 2.7 TEAM MEMBER (internal)
| Dir | Document | Obligation | Notes |
|---|---|---|---|
| — | (no document obligation) | — | members are *actors* in the flow, not parties owed/owing docs; they appear as `fulfilled_by`/`assignee`, not as a requirement subject. **Honest scoping decision** — do not invent member document requirements. |

### 2.8 EXTERNAL PARTIES (`external_recipients`, sibling doc) — the right side of the bureaucracy

| Party | RECEIVES (owed — the inbound package) | PROVIDES (the artifact back) |
|---|---|---|
| **שמאי / appraiser** | נסח · תוכניות/floor-plans · אומדן-בסיס · project overview | **השומה** (the appraisal) |
| **אדריכל / architect** | נסח · תב"ע · מפת-מדידה | **תוכניות אדריכליות · היתר** |
| **עו"ד / lawyer** | כל החתימות · התצהירים · התקנון · נסח | **חוו"ד · נוסח ההסכם** |
| **bank** | התקנון · השומה · ספירת-חתימות (aggregate) · מכתב-מצב | **מכתב ליווי / אישור מימון** |
| **וועדה / committee** | **החבילה המלאה**: כל החתימות + התצהירים + השומה + התוכניות + הנסח + הפרוטוקול | **אישור / החלטת-וועדה · היתר** |

The וועדה's RECEIVE row — "the full package" — is the **filing-package generator**
(`DOM-PKG` in the synthesis): a single requirement whose fulfillment IS the assembled
bundle. This is where the two-sided model and the package mechanism (sibling doc)
meet: a `document_requirement(committee, R, committee_package)` is fulfilled by a
`document_package` snapshot.

> **The cross-check the certainty audit wants** (this is the artifact to pressure-test
> against the real process): every "R" cell above is a thing the system today CANNOT
> represent as owed. Each is a candidate `should-exist-but-doesn't` the route-map could
> never surface — because there is no route for a document that doesn't exist yet.

---

## 3. THE DATA MODEL — one net-new spine table on the existing parenting

The sibling hub doc adds `documents.{building_id, owner_id, folder_id, version, ...}`.
The flow model adds **one table** that makes "expected" a first-class concept. It is
deliberately *parallel* to `documents` (not a column on it) because a requirement
exists **before and independently of** any document, and one document can satisfy
several requirements.

### 3.1 `document_requirements` (NET-NEW — the expectation spine)

```
document_requirements (
  id              uuid pk,
  org_id          uuid not null  -> organizations  (RLS FORCE — tenant isolation, like every table),
  project_id      uuid not null  -> projects        (the flow container; RLS rides project→org),

  -- WHICH ENTITY this requirement is ABOUT (exactly one set; a CHECK enforces XOR).
  -- Mirrors the existing flat-nullable-FK pattern on `documents`/`tasks`, extended
  -- to the full entity graph:
  subject_type    text not null,   -- 'project'|'building'|'apartment'|'owner'|'renter'
                                    -- |'contractor'|'external_recipient'
  building_id     uuid -> buildings(id)            on delete cascade,
  apartment_id    uuid -> apartments(id)           on delete cascade,
  owner_id        uuid -> owners(id)               on delete restrict,   -- 🔒 PII subject; externals NEVER traverse
  discovery_id    uuid -> discovery_records(id)    on delete cascade,    -- the renter/occupant axis
  contractor_id   uuid -> contractors(id)          on delete cascade,
  recipient_id    uuid -> external_recipients(id)  on delete cascade,    -- sibling-doc table
  -- (subject_type=='project' => all entity FKs NULL; the project IS the subject)

  -- THE TWO SIDES (the owner's framing):
  direction       text not null,   -- 'provide' | 'receive'   (P / R in §2)
  doc_type        text not null,   -- the requirement's expected type (the §3.3 enum; free-text-tolerant)
  obligation      text not null default 'required',  -- 'required'|'conditional'|'optional'
  sensitive       boolean not null default false,    -- mirrors documents.sensitive; drives §5 gating

  -- FULFILLMENT (the missing→received transition):
  status          text not null default 'missing',   -- 'missing'|'received'|'waived'|'not_applicable'
  fulfilled_by_document_id  uuid -> documents(id) on delete set null,  -- the doc that satisfied it
  -- (set null, not cascade: if the doc is later archived, the requirement
  --  reverts toward missing — see §4.3 — never silently deleted)
  fulfilled_at    timestamptz,
  waived_by       uuid -> users(id),     waived_reason text,           -- explicit manager override
  due_at          timestamptz,           -- the chase deadline (feeds §4 tasks)

  -- PROVENANCE:
  source          text not null default 'template',  -- 'template'|'manual'|'derived'
  template_key    text,                              -- which §2 template row seeded it (idempotent re-seed)
  created_by      uuid,    created_at,  updated_at,  archived_at
)
```

**Indexes / constraints (perf + integrity, matching the codebase conventions):**
- partial unique `(project_id, subject_type, COALESCE(owner_id,building_id,...),
  direction, doc_type) WHERE archived_at IS NULL` — one open requirement per
  (entity, side, type); idempotent template re-seed (the migration-silent-skip /
  raw-seeder cautions in memory apply to any backfill).
- `idx_doc_req_project_status (project_id, status) WHERE archived_at IS NULL` — the
  hot "what's missing in this project" query.
- `idx_doc_req_owner (owner_id) WHERE owner_id IS NOT NULL` — the per-owner lens.
- `subject_xor` CHECK — exactly the entity FKs allowed by `subject_type` are set.
- `direction_check` / `status_check` / `obligation_check` — closed sets at the DB
  *and* the Zod edge (the codebase's belt-and-suspenders pattern).
- RLS FORCE `tenant_isolation` on `org_id` (every table does this).

### 3.2 The fulfillment-matching rule (the only genuinely new logic)

When a `documents` row lands (or is re-parented), match it to open requirements:
1. Same `project_id` (or roll-up: a building doc satisfies the building's
   requirement via `documents.building_id`).
2. Same **subject** — `documents.owner_id == requirement.owner_id` (needs the sibling
   doc's `owner_id` link), or apartment/building match, or project-level.
3. Compatible `doc_type` (exact, or via the type→requirement map in §3.3).
4. `direction='provide'` requirements are satisfied by an *uploaded* doc on the
   subject; `direction='receive'` requirements are satisfied by a *sent*
   `document_share`/`document_package` to that recipient (the inbound side is
   fulfilled by delivery, not upload — see §4.4).

Matching is **suggest-then-confirm by default** (the DO-NOT-FABRICATE doctrine + the
tabu auto-parse→human-confirm precedent in memory): the system proposes "this upload
looks like it fulfills owner X's נסח requirement — confirm?" rather than silently
flipping state. A manager setting can make exact-type matches auto-confirm.

### 3.3 doc_type taxonomy (PUZZLE — shared with the hub doc)

Reuse the sibling hub doc's promoted enum verbatim (`agreement · regulation ·
tabu_extract · blueprint · appraisal · committee_doc · permit · financing ·
id_document · protocol · power_of_attorney · other`), each carrying default
sensitivity + default system-folder. The requirement's `doc_type` draws from the same
enum, so a requirement, an uploaded document, and a folder all speak one vocabulary.
**Free-text-tolerant reads preserved** (the DV-MGR-DOCS lesson): the enum validates
writes + labels + drives matching; a stray value never breaks a list `.parse`.

### 3.4 Why a separate table and not `documents.expected=true`

Three reasons, each grounded: (a) a requirement exists with **no bytes, no r2_key, no
scan** — it would violate every NOT NULL on `documents` and pollute the serving paths
(`uploaded_at IS NOT NULL` guards) with phantom rows. (b) **one document satisfies
many requirements** (the שומה satisfies the שמאי-provide AND the bank-receive AND the
וועדה-receive) — a 1:1 column can't model that. (c) the requirement is the unit the
*chase* and the *template* operate on; conflating it with the artifact loses the
clean "expectation vs fulfillment" axis the owner drew.

---

## 4. STATUS + HOW MISSING DRIVES THE WORKFLOW (the agentic loop)

### 4.1 Per-entity status (the checklist roll-up)

For any entity, its document status is a pure aggregate over its
`document_requirements`: **`expected` = count(all non-waived)**, **`received` =
count(status='received')**, **`missing` = count(status='missing' AND obligation IN
('required','conditional-active'))**. The entity is **document-complete** when
`missing = 0`. This roll-up is a read-model (a `GROUP BY subject` query under
`withTenant`) — **no new write path, pure projection**, and it composes up the graph
(owner→apartment→building→project) exactly the way the hub doc rolls documents up.

### 4.2 Missing → task (the chase) — PUZZLE on `tasks`

A `missing` required requirement past (or approaching) `due_at` **mints a chase
task**. The `tasks` table already carries `project_id`/`apartment_id`/`due_at`/
`status`/`type` (`collaboration.ts:90`). The tie-in is additive and minimal:
- Add a nullable `tasks.requirement_id -> document_requirements(id)` (one new FK) so a
  chase task is **traceable to the exact owed document** and auto-resolves when the
  requirement flips to `received` (a hook closes the task — mirrors the §6 "signed"
  hook in the hub doc).
- A `task.type = 'document_chase'` value (free text today — no enum change needed).
- For the **owner** subject the task needs to hang off the owner: today `tasks` has no
  `owner_id`. Two honest options — (a) add `tasks.owner_id` (one FK, symmetric with
  the new `documents.owner_id`); or (b) hang the chase task off the owner's apartment
  (`apartment_id`) + carry `owner_id` in `requirement_id`. **Recommend (a)** — it makes
  "tasks about this owner" first-class and matches the per-owner lens. *Net-new: 1 FK.*

### 4.3 The state machine (honest, fail-safe)

```
 missing ──(matching doc confirmed)──► received ──(fulfilling doc archived)──► missing
    │                                      │
    ├──(manager waives, reason)──► waived  └──(superseded by new version)──► received (re-pointed)
    └──(predicate false)──► not_applicable
```
Key invariants: a requirement **never silently disappears** — archiving the fulfilling
document reverts it toward `missing` (the chase re-opens), never deletes the
expectation (the DO-NOT-FABRICATE doctrine: don't let the system claim a doc is on
file when it was pulled). `waived` requires an explicit user + reason (audited).
`conditional` requirements only count as `missing` when their predicate is active
(e.g. POA requirement activates only when signing-via-representative is set — ties the
DOM-1 estate/POA model).

### 4.4 The inbound (RECEIVE) side — fulfilled by DELIVERY, not upload

A `direction='receive'` requirement (owner owed the agreement; וועדה owed the package)
is satisfied when the thing is **delivered**, which the system already has primitives
for:
- **owner receives the agreement** → fulfilled when a `signature_requests` row is
  created/sent for that owner (the signing flow is the delivery). The hub doc's
  `signed`-status hook off `signature_requests` is the same seam — extend it to also
  flip the matching `receive` requirement.
- **external party receives a package** → fulfilled when a `document_share` to that
  `external_recipient` is sent (sibling doc §C.4). The send IS the fulfillment event.
- This makes the **two sides close the loop**: the שומה the שמאי uploads (provide,
  fulfilled by upload) becomes available to fulfill the bank's receive (fulfilled when
  shared onward). The system can show "the שומה is in; it has NOT yet been forwarded to
  the bank" — a missing *receive* even though the *provide* is done. **That asymmetry
  is exactly the connective-tissue insight the owner described.**

### 4.5 The action-queue surfacing (PUZZLE — `notifications` + the dashboard)

- Add two `notificationTypeEnum` values: **`document_requested`** (you've been asked to
  provide X) and **`document_overdue`** (a required doc is past due). *Net-new: 1 enum
  migration — carry the schema-constraint-ripple caution from memory (scan raw seeders).*
- The existing notification `link` + `metadata` carry the deep-link to the
  requirement/owner (the notifications-deep-link work, task #30, is the precedent).
- The **org-wide "missing documents" queue** is a new dashboard lens (NET-NEW FE) over
  `document_requirements WHERE status='missing'` — grouped by project/entity, sorted by
  due date. This is the agentic loop's visible surface: *the system's list of what it is
  chasing.*

---

## 5. PRECISE PERMISSIONS — per entity + per document + per requirement

The flow model inherits the sibling hub doc's **three-layer ACL intersection** (role →
per-folder/doc `document_acl` → sensitive/OTP/encryption) verbatim, and adds the
**requirement-visibility rule** on top:

1. **Who sees a requirement** = who could see the document that would fulfill it.
   A requirement is gated by the same `document_acl` resolution that the fulfilling
   doc would be (a 🔒 owner-`id_document` requirement is manager-only + PII-tier, just
   like the doc). The "who-can-see" panel (hub doc §4.4) extends to show requirement
   audience, so an operator sees the blast radius of a *missing* doc too.
2. **Who can fulfill (upload against) a requirement** = the role/capability that can
   create documents for that subject (`documents.create` + project scope + agent
   `manage_documents`). An **external recipient can fulfill their own provide
   requirement** via an *inbound* share (the שמאי uploading the שומה back) — this is
   the one genuinely new external capability and the sibling doc's external read-service
   must be extended to a **scoped write-back** (upload that lands as a `documents` row
   on the project, full scan+encrypt pipeline, attributed to the external actor). That
   is the only net-new in the permission surface; everything else is reuse.
3. **PII stays structurally off for externals** (the contractor firewall, sibling doc
   §0.4): an external party's requirements never expose owner-`owner_id` PII docs. A
   שמאי's "receive נסח" requirement is satisfied by the *project/building* נסח, never an
   *owner-linked* one. The `owner_id` FK on requirements is the line externals never
   cross — same guarantee as `ContractorReadService`'s "no owners table is ever
   queried."
4. **Encryption preserved end-to-end:** a requirement carries `sensitive`; the
   fulfilling upload routes through the existing envelope-encryption + OTP-step-up gate
   unchanged. The flow layer adds **no new bytes path** — it points at the existing one.

**Audit:** requirement lifecycle (`requirement.create/fulfill/waive/overdue`) rides the
existing `AuditService`; external fulfillment needs the `actor_type='external'` migration
the sibling doc already calls for (`artifacts.ts:299`).

---

## 6. THE UI LENSES (the three views the owner named)

All three are read-models over `document_requirements` + `documents` — no new write
surface, dense RTL, same component family as the rebuilt Owners table (task #29).

1. **Per-project lens (the flow board).** The project's document-completeness at a
   glance: a matrix of **entities (rows) × required-doc-types (columns)**, each cell a
   traffic state (received ✓ / missing ⬚ / waived / N-A / overdue ⚠). This is the
   single screen that answers "what does this project still owe/need." Click a missing
   cell → the chase action (assign a task, request from the party, send a reminder).
2. **Per-entity lens (the checklist — the owner's/apartment's binder).** For one owner
   (or apartment, or external party): a two-column **PROVIDES | RECEIVES** checklist —
   what they've given, what they're owed, what's missing, with the upload/send/chase
   action inline. This is the literal artifact the owner described ("each entity has a
   document checklist"). The per-owner lens needs the sibling doc's `documents.owner_id`
   + this doc's `owner_id` requirement FK.
3. **Org-wide aggregate (the missing-docs queue).** Across all projects: every
   `status='missing'` required requirement, grouped and sorted by due date — the
   operator's "what is the system chasing right now" cockpit. The flat hub view (sibling
   doc) is the *document* aggregate; this is the *requirement* aggregate — the two tabs of
   one DMS cockpit.

---

## 7. PUZZLE vs NET-NEW — the honest ledger

| Capability | Verdict | Basis |
|---|---|---|
| Document store / scan / magic-byte / encryption / OTP / serving / audit | **PUZZLE (reuse 100%)** | `documents.service.ts` unchanged |
| Entity graph (project/bldg/apt/owner/renter/contractor) | **PUZZLE** | `projects.ts` + `collaboration.ts` |
| `documents.owner_id/building_id/folder_id` parenting | **PUZZLE (sibling hub doc DMS-1)** | adds the per-entity join |
| `external_recipients` (appraiser/architect/lawyer/bank/committee) | **PUZZLE (sibling external doc X1)** | the right-side entities |
| `document_shares`/`document_packages` (outbound deliver) | **PUZZLE (sibling external doc X2-X4)** | fulfills RECEIVE side |
| Tasks as the chase primitive | **PUZZLE (extend)** | `tasks` `:90` + 1 FK (`requirement_id`) + 1 FK (`owner_id`) |
| Notifications as the action-queue | **PUZZLE (extend)** | `notifications` + 2 enum values |
| `signature_requests`/signing as RECEIVE-fulfillment | **PUZZLE (extend the status hook)** | hub doc §6 hook |
| Audit of requirement lifecycle | **PUZZLE** + the `actor_type='external'` migration | `AuditService` |
| **`document_requirements` spine (expected-doc as a row)** | **NET-NEW (the core)** | no expectation concept today |
| **The two-sided `direction` (provide/receive) concept** | **NET-NEW** | docs are one-directional today |
| **The per-entity-type requirement TEMPLATE (§2)** | **NET-NEW (domain IP)** | the catalogue |
| **Fulfillment-matching (doc → requirement, suggest-confirm)** | **NET-NEW (the only real new logic)** | §3.2 |
| **Per-entity checklist + per-project flow-board + missing-queue lenses** | **NET-NEW FE** | read-models over the spine |
| **External scoped write-back (party uploads its provide-doc)** | **NET-NEW** | extends the external read-service |

**Roughly 55% puzzle, 45% net-new** — and the net-new is *one spine table + a template +
a matching rule + read-model lenses*, all riding proven rails (parenting, tasks,
notifications, signing, sharing, audit).

---

## 8. SLOTTING — a flow sub-wave on top of the DMS wave

The flow layer **depends on** the hub doc's DMS-1 (the `owner_id`/`building_id`
parenting — without it a requirement can't bind to an owner) and benefits from DMS-3
(the ACL/who-can-see surface). It slots **after DMS-1, alongside DMS-2/DMS-4**, and the
external write-back depends on the sibling external sub-wave (X1–X4). Proposed:

- **FLOW-1 — Requirement spine + template** *(BE, one migration)*: `document_requirements`
  table + RLS + the §2 template seeded per-project/per-entity on entity creation
  (idempotent; the system-folder-seeding hook is the precedent) + the Zod contract +
  CRUD. *Depends on DMS-1.*
- **FLOW-2 — Fulfillment matching + status roll-up** *(BE)*: the §3.2 suggest-confirm
  matcher (doc-upload → requirement), the per-entity status read-model, the
  RECEIVE-via-signing/sharing hooks. *Depends on FLOW-1 + the signing hook.*
- **FLOW-3 — Missing → chase** *(BE)*: `tasks.requirement_id`/`tasks.owner_id` FKs,
  the `document_chase` task minting + auto-close, the 2 notification types + the
  overdue sweep (the audit-retention cron is the precedent for a scheduled sweep).
  🔒 enum migration → schema-constraint-ripple scan.
- **FLOW-4 — The three lenses** *(FE)*: per-project flow-board · per-entity checklist ·
  org-wide missing-queue. *Depends on FLOW-1/2.*
- **FLOW-5 — External scoped write-back** *(BE+FE, SECURITY-SENSITIVE)*: the external
  party uploads its provide-doc through the external tier → lands as a scanned/encrypted
  `documents` row → fulfills the requirement. `@security-reviewer` before commit (a new
  external write path is exactly the gate the agent-write-endpoint memory flags).
  *Depends on the external sub-wave X1–X4.*

**Sequencing rule:** FLOW-1 → FLOW-2/FLOW-3 (parallel) → FLOW-4 → FLOW-5 (gated on
external sub-wave). None of this touches the v4 critical path (Waves 0–3); it is a
Wave-5+ completeness layer.

---

## 9. DECISIONS / GAPS TO FLAG TO SYNTHESIS

1. **The expectation spine is the keystone net-new.** Everything else (template, chase,
   lenses) hangs off `document_requirements`. It is *one additive table* — high leverage,
   low blast radius. This is the single most important thing this front says: **the
   system's missing organ is "expected-but-absent," and it is one table.**
2. **`tasks.owner_id` (and `documents.owner_id` from the hub doc)** are the small FKs
   that make the owner the first-class subject of both documents AND chases. Recommend
   adding both; they unlock the per-owner lens the owner explicitly wants.
3. **RECEIVE-side fulfillment = delivery, not upload** (§4.4) — the insight that closes
   the two-sided loop and surfaces "in, but not forwarded." Confirm the signing-flow +
   share-send hooks are the right fulfillment events (recommend yes — they already exist).
4. **External scoped write-back (FLOW-5)** is the one new *external write* capability and
   the only security-sensitive net-new beyond the sibling docs. It must reuse the full
   scan+encrypt pipeline and be `@security-reviewer`-gated. *Owner/legal note:* letting a
   שמאי upload back into the project is a trust decision — recommend it, gated + audited +
   scoped to that recipient's provide-requirements only.
5. **Template governance.** The §2 catalogue is the domain IP and will evolve (e.g. a new
   legal-track affidavit). Make it a *seeded-but-editable* per-org template (not hardcoded)
   so the owner can refine "what should be in the system" without a deploy — and so the
   §1.2 certainty method (re-run when the real world reveals a requirement) has a place to
   land the new requirement as data, not code.
6. **Conditional predicates** (POA-when-representative, permit-when-in_construction,
   relocation-when-renter-relocating) tie the flow to the project/owner state machines and
   to the DOM slices (estate/POA DOM-1, post-approval DOM-4, relocation DOM-5). MVP can ship
   `required`/`optional` and treat `conditional` as manager-toggled; auto-predicate
   activation is a fast-follow.
```
