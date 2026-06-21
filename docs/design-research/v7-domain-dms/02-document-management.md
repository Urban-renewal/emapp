# v7 Domain Front — The Professional Document-Management Hub (DMS)

> Author: v7 DMS seat, 2026-06-18. Grounded in the live `documents` module, the
> `shares`/contractor-portal mechanism, the `artifacts.ts` schema, the IAM
> matrix, and the v4 build plan. Honest about puzzle (reuse) vs net-new.
>
> **One-line verdict.** EMAPP already has a *security-grade document pipeline*
> (upload → magic-byte → ClamAV → AES-GCM envelope → presign/decrypt-stream →
> per-record visibility → audit). What it does **not** have is a *document
> MANAGEMENT product*: there is no folder/taxonomy layer, no versioning, no
> org-wide aggregate view, no full-text/metadata search, no per-document/
> per-folder ACL beyond the 4 coarse role permissions, no "who-can-see"
> surface, and no external-party sharing beyond the single contractor share.
> The plumbing is excellent; the **hub, the organization, and the precise
> permissions are the missing 80%.** This is a net-new **DMS wave**, built by
> EXTENDING three existing patterns, not a rebuild.

---

## 0. What exists today (verified in code — the foundation we build on)

### 0.1 The document pipeline (`apps/api/src/modules/documents/`)

Confirmed end-to-end, all fail-closed:

| Capability | Where | Notes |
|---|---|---|
| Metadata-first create → presigned PUT | `documents.service.ts:353` `create()` | client never sees `r2Key`; presign minted post-commit, bounded by content-type + size ceiling |
| Two-layer integrity gate | `:546` `finalize()` | client-consistency + R2 `head()` attestation; mismatch → archive + purge + 409 |
| Magic-byte real-content-type filter | `magic-bytes.ts` + `scanGate():691` | SECURITY-UPLOAD-AUDIT threat #3; declared MIME vs leading bytes; mismatch → archive+purge |
| ClamAV anti-malware scan | `:666` `scanGate()` via `IFileScanProvider` | fail-closed: only `scan_status='clean'` is ever servable |
| Sensitive-by-type derivation | `:360`, `SENSITIVE_DOC_TYPES = {id_document, financial}` | turn-ON-only; also set by tabu-extraction (the נסח holds PII) |
| AES-256-GCM envelope-at-rest | `:1059` `encryptEnvelope` / `:1077` decrypt | `EMAPPENC|v1|keyId|iv|tag|ct`; key from `DOC_ENCRYPTION_KEY`, never in R2; content-path upload (no presign) |
| PII step-up gate on download | `:897` `assertPiiUnlocked` | sensitive doc served only if `auth_sessions.pii_unlocked_at` within org TTL (default 60m) |
| Per-record visibility (no-oracle) | `:322` `loadVisible`, `:305` agent-scope | foreign id → generic 404 before any informative code |
| Keyset-paginated list with parent + archived filter | `:1213` `list()` | `projectId` / `apartmentId` / `archived` filters; agent EXISTS-scoping |
| `nosniff` + dual Content-Disposition (RFC 6266 + 5987 Hebrew) | controller `:124`, service `:866` | |
| Full audit trail | every mutation + **every download** | `document.{create,finalize,scan_clean,scan_reject,download,update,archive,content_upload}` |

### 0.2 The data model (`packages/db/src/schema/artifacts.ts:23`)

`documents` columns: `id, org_id, project_id?, apartment_id?, name, type (FREE
TEXT), mime_type, size_bytes, r2_key, content_hash, uploaded_by, created_at,
updated_at, archived_at, uploaded_at, scan_status, scan_signature, sensitive,
bytes_encrypted`. Indexed on `(org_id, project_id)`, `apartment_id`,
`content_hash`. RLS FORCE `tenant_isolation` on `org_id`.

**Key structural facts that shape the DMS design:**
- **Parenting is a flat 3-way nullable FK** (project OR apartment OR org-level
  if both null). There is **no `owner_id` link** and **no folder/container
  table** — a document cannot today be attached to an owner, a building, or a
  named folder.
- `type` is **free text**, not a DB enum. The curated UI enum
  (`shared-types/document.ts:28`) is `agreement | blueprint | regulation |
  contract | permit | id_document | floor_plan | financial | other`. The READ
  schema is deliberately tolerant (a bad row must not break the whole list
  `.parse` — the DV-MGR-DOCS lesson).
- **There is no version/supersede column.** Each upload is an independent row.
  `content_hash` is stored + indexed but never used for dedup or lineage.
- The lifecycle that EXISTS is: *(no row)* → created (presign minted) →
  uploaded (`uploaded_at`) → scanned (`scan_status`) → archived (`archived_at`).
  There is **no document-status field** (draft/final/signed) — "signed" is
  inferred indirectly via the `signatures` / `signature_requests` tables that
  FK to `documents.id`.

### 0.3 The IAM surface (`apps/api/src/common/authz/permissions.ts:53`)

Exactly **4 coarse permissions**: `documents.read | documents.create |
documents.update | documents.archive`. Agents are additionally gated by the
fine capability `manage_documents` (`agent-effective-permissions.ts:37`) and
record-scoped to assigned projects. Viewer = read-only. **There is no
per-document, per-folder, or per-type ACL** — visibility is "all docs in your
org that your role+assignment lets you see." A manager sees every org document;
an agent sees docs of assigned projects; org-level (unparented) docs are
manager/viewer-only.

### 0.4 The external-sharing pattern (`shares` + contractor-portal)

The **natural seam to extend** for external parties (שמאי/אדריכל/עו"ד/bank/
וועדה). Today:
- `shares` (`collaboration.ts:54`): org → contractor → **project** grant,
  JSONB `permissions`, `revoked_at` lifecycle, `last_accessed_at`,
  `created_by`. Unique-active per (project, contractor).
- `share_permissions` (`_share-permissions.ts`): strict JSONB —
  `{overview:{on}, documents:{on, actions:{download}}, signatures:{on}}`.
- `ShareTokenService` mints a JWT (audience `emapp-share`), delivered
  out-of-band; revocation is immediate via `shares.revoked_at`.
- `ContractorReadService` (`contractor-read.service.ts`) is the consumption
  side: **structurally narrow** — project-level docs only
  (`apartment_id IS NULL`), `scan_status='clean'`, **`sensitive=false`
  excluded** (no OTP step-up for the external tier), `archived_at IS NULL`,
  ghost-excluded, IDOR-checked per `r2Key`. Per-share `documents.actions.download`
  gates the download.

**This pattern already proves the external-sharing primitives the owner wants:
scoped + time-limited (token TTL) + revocable (`revoked_at`) + audited
(`last_accessed_at` + audit_log) + permissioned (JSONB).** It is currently
*hardcoded to one role (contractor) and one scope (a whole project's
project-level docs).* The DMS extends it to *named external recipients on a
chosen set of documents/folders.*

---

## 1. The target: what "professional DMS" means here

A document-management hub for an urban-renewal developer is **the project's
legal binder made digital.** The bar is set by what a יזם's office does today
with physical folders + Dropbox + WhatsApp + a lawyer's email:

1. **One place for ALL of a project's paper** — תקנון, הסכמי החתמה, נסחי טאבו,
   תוכניות אדריכליות, שומות, אישורי וועדה, היתרים, חוזי מימון, פרוטוקולים.
2. **Organized so a non-technical operator finds anything in seconds** — by
   project, by building, by apartment, by owner, by type, by status, by date.
3. **Precise control over who sees what** — the org's people by role; specific
   externals on specific documents; PII docs gated harder.
4. **A trustworthy record** — versions, "this is the FINAL signed תקנון",
   supersede history, and a who-viewed/who-downloaded trail.
5. **"Send my bureaucracy in one click"** — hand a שמאי or the וועדה a
   time-limited, watermarked, revocable, audited bundle of exactly the right
   documents.

Mapping that bar against §0, the **gaps** are: the hub view, the taxonomy
(folders + building/owner parenting), precise permissions, search, versioning +
document status, and external sharing beyond the contractor. The **plumbing**
(encryption, scan, audit, presign, RLS) is done and is reused unchanged.

---

## 2. The org-wide hub + the lensed views

### 2.1 The aggregate view (NET-NEW)

Today there is **no org-wide documents screen** that crosses projects — the FE
`documents/page.tsx` lists via `GET /documents` which already supports no
parent filter (returns all org docs the caller can see), but there is no
project/type/status faceting, no grouping, and the IA demotes it
(`E2-IA-S2` moves documents off the spine). The hub needs:

- **`GET /api/v1/documents` enriched** (PUZZLE — extend the existing list):
  add facet filters `type[]`, `status`, `buildingId`, `ownerId`,
  `folderId`, `q` (search), `uploadedBy`, date range; add lightweight
  aggregate counts (`{ byType, byStatus, byProject }`) for the facet rail.
  The keyset cursor + agent EXISTS-scoping + RLS stay **byte-identical**.
- **A `documents` cockpit screen** (NET-NEW FE): a dense, RTL, faceted table —
  the same component family as the rebuilt Owners table (task #29) — with the
  facet rail on the right (RTL), saved views, and the four lenses as tabs:
  *Org · Project · Apartment · Owner*. Same data, different `WHERE` lens.

### 2.2 The per-X lenses (PUZZLE — already half-built)

- **Per-project**: `GET /documents?projectId=` exists; surface it as the
  project's "מסמכים" tab (the FE already has `project-document-upload.tsx`).
- **Per-apartment**: `GET /documents?apartmentId=` exists; surface on the
  apartment page (already linked from tabu review, task #22).
- **Per-owner**: **does NOT exist** — requires the new `owner_id` link (§3.1).
  This is the gap that makes "show me everything about owner X" impossible
  today (their ID doc, their signed agreement, their נסח row are not joinable
  to the owner from the documents side).

---

## 3. The taxonomy / organization layer (the core NET-NEW)

This is the heart of the missing 80%. Four orthogonal axes; the operator
should be able to slice on any combination.

### 3.1 Parenting: project → building → apartment → owner (NET-NEW migration)

Today: `project_id` OR `apartment_id` OR org-level. Add **two nullable FKs** to
`documents` (one migration, additive, no backfill needed):
- `building_id uuid REFERENCES buildings(id) ON DELETE CASCADE` — a building-
  level doc (e.g. a נסח for the whole parcel, an architectural site plan).
- `owner_id uuid REFERENCES owners(id) ON DELETE RESTRICT` — an owner-level doc
  (their ID document, their personal agreement copy). **`owner_id` makes the
  per-owner lens possible** and is the join the contractor tier must *never*
  traverse (owner PII is structurally off for externals — preserve that).

Keep the existing flat model — a doc still hangs off the **most specific** node
it belongs to; the hub rolls up child docs into parent views via the
building→project and apartment→building→project chains the code already walks
(`assertApartmentVisible` already joins `apartments → buildings → projects`).

> Decision to flag: do we want a doc attached to a **building** to also appear
> in the project lens? Recommendation: **yes, roll-up by default** (a project
> binder shows everything beneath it), with a "this level only" toggle. This
> matches how a physical project binder works.

### 3.2 Folders (NET-NEW table — the operator-facing organizer)

Parenting answers "which entity"; folders answer "which drawer." A new
`document_folders` table:

```
document_folders (
  id, org_id (RLS FORCE),
  project_id?  -- a folder lives under a project (or org-level if null)
  parent_folder_id?  -- nesting (self-FK); cap depth (e.g. 6) in the service
  name, position,
  is_system boolean,  -- system folders auto-created per project (see below)
  created_by, created_at, updated_at, archived_at
)
```
`documents.folder_id` nullable FK added in the same migration. A doc has at
most one folder (a true filesystem model, not tags — tags are §3.4).

**System folders** (auto-seeded per project on creation, `is_system=true`,
non-deletable): `תקנון ומסמכי יסוד · הסכמי החתמה · נסחי טאבו · תוכניות
אדריכליות · שומות · אישורי וועדה והיתרים · מימון ובנקאות · כללי`. This gives
non-technical operators a *correct empty structure on day one* — the single
biggest UX lever for "everything that should be there." The operator can add
custom subfolders.

### 3.3 Type taxonomy (PUZZLE — promote the existing enum to law)

The curated `DocumentTypeEnum` exists but is FE-only and incomplete for the
domain. **Extend it** (write path validates; read stays tolerant — preserve the
DV-MGR-DOCS lesson) to the real urban-renewal set:
`agreement (הסכם) · regulation (תקנון) · tabu_extract (נסח טאבו) · blueprint
(תוכנית אדריכלית) · appraisal (שומה) · committee_doc (מסמך וועדה) · permit
(היתר) · financing (מימון/בנקאות) · id_document (ת"ז) · protocol (פרוטוקול) ·
power_of_attorney (ייפוי כוח) · other`. Each type carries a **default sensitivity**
(id_document, appraisal, financing → sensitive) and a **default system-folder**
(drives auto-filing on upload). `type` stays free-text in the column (tolerant
reads), the enum is the upload validator + label map + filing hint.

### 3.4 Tags + status + date (NET-NEW, small)

- **Status** (NET-NEW column `documents.lifecycle_status`, default `final`):
  `draft | final | signed | superseded | archived`. See §6.
- **Tags** (optional, post-MVP): a `document_tags` join table for cross-cutting
  labels (e.g. "for the bank", "disputed"). Not a launch blocker — folders +
  type + status cover 95%.
- **Date**: already have `created_at` / `uploaded_at`; expose date-range facets
  in the enriched list (§2.1). No schema change.

---

## 4. Precise permissions (the second core NET-NEW)

Today's 4 coarse role permissions are the floor. Professional DMS needs **three
layers, evaluated as an intersection** (a grant must pass ALL three):

### 4.1 Layer 1 — role (PUZZLE, unchanged)

`documents.read/create/update/archive` + agent `manage_documents` + agent
project-scoping + viewer read-only. Keep exactly as-is; it is the coarse gate.

### 4.2 Layer 2 — per-folder / per-document ACL (NET-NEW)

The new capability: a manager can mark a folder or a document **restricted** and
grant named org members access. New `document_acl` table:

```
document_acl (
  id, org_id (RLS FORCE),
  folder_id?  XOR  document_id?,   -- the protected resource
  principal_user_id?,              -- a specific org member
  principal_role?,                 -- OR a role-wide grant
  access text,                     -- 'view' | 'manage'
  granted_by, created_at, revoked_at
)
```
Resolution rule (fail-closed, mirrors the member-override pattern from tasks
#6-#8): a doc/folder with **no ACL row is open to the role gate** (today's
behavior — backward compatible); the moment **any** ACL row exists on a resource
it becomes **restricted** — only listed principals (plus managers-always, plus
the uploader) may see it. Folder ACLs inherit to contained docs unless the doc
has its own. **PII docs (`sensitive=true`) are auto-restricted** and additionally
require the existing OTP step-up — that gate is untouched and remains the
hardest layer.

### 4.3 Layer 3 — the existing sensitive/OTP/encryption gate (PUZZLE, unchanged)

`sensitive=true` → envelope-encrypted at rest + per-session OTP unlock on
download. **Reuse verbatim.** The DMS adds nothing here except making the
sensitivity *visible* in the UI (a lock badge) and auto-deriving it from the
expanded type taxonomy (§3.3).

### 4.4 "Who can see this" surface (NET-NEW FE)

A per-document/per-folder panel that resolves and *displays* the effective
audience: "Managers (always) · Agent ראובן (assigned to project) · Viewer דנה ·
🔒 requires PII unlock · 👁 external: שמאי כהן (until 30/06)". This is the single
most reassuring feature for the certainty question — the operator can *see* the
blast radius before sharing. Pure read-model over layers 1-3 + §5.

---

## 5. External sharing to non-contractor parties (the owner's headline ask)

**This is a generalization of the existing `shares` mechanism, NOT a new
subsystem.** The owner explicitly framed it as "send its bureaucracy in one
click" to שמאי / אדריכל / עו"ד / bank / וועדה.

### 5.1 The model (EXTEND `shares`, NET-NEW additive)

Today `shares` is hardcoded `project → contractor`. Generalize to a
**document-share** that is the puzzle-piece extension:

```
document_shares (  -- a sibling of `shares`, same lifecycle DNA
  id, org_id (RLS FORCE),
  project_id,                       -- scope anchor (RLS via project→org)
  recipient_kind text,              -- 'appraiser'|'architect'|'lawyer'|'bank'|'committee'|'other'
  recipient_label text,             -- "שמאי כהן ושות'" (business name, not PII)
  recipient_email?,                 -- where the link is delivered (delivery PII)
  scope jsonb,                      -- { folderIds[], documentIds[] }  -- EXACTLY what is shared
  permissions jsonb,                -- { download:bool, viewOnly:bool, watermark:bool }
  expires_at timestamptz,           -- TIME-LIMITED (token TTL + hard column)
  revoked_at, revoked_by,           -- REVOCABLE (immediate, like shares)
  last_accessed_at,                 -- audited usage
  created_by, created_at
)
```
- **Token**: reuse `ShareTokenService` shape with a new audience
  (`emapp-doc-share`) bound to `document_shares.id`; same out-of-band delivery,
  same immediate-revoke-via-column posture.
- **Consumption endpoint**: a new external read-service modeled *exactly* on
  `ContractorReadService` — structurally narrow, IDOR-checked per `r2Key`,
  `scan_status='clean'` only, ghost-excluded, RLS via project→org, suspension-
  gated (the D.49 note in `shares.service.ts` applies verbatim). **It resolves
  the share's `scope` (explicit folder/doc ids) instead of "all project-level
  docs"** — that is the only real new logic.
- **PII**: by default `sensitive=true` docs are **excluded** from an external
  share (same fail-closed posture as the contractor tier — no OTP for externals).
  A manager *may* explicitly include a sensitive doc in a scope, but only if the
  recipient is given a one-time access code (post-MVP — keep the MVP fail-closed:
  externals never see PII docs).

### 5.2 Watermarking + view-only (NET-NEW, partly post-MVP)

- **View-only / no-download**: trivial — the external service omits the
  download presign and serves an inline decrypt-stream (we already have the
  inline disposition path). MVP-able.
- **Dynamic watermark** ("הופק עבור שמאי כהן · 18/06/2026 · לא להפצה" stamped
  across each PDF page): NET-NEW, **post-MVP** — needs a PDF-render step
  (precedent exists: the C1 committee print-of-record + the
  `signature-requests/:id/signed-document` PDF route). Flag as a fast follow,
  not a launch blocker. Until then, view-only + the audit trail + expiry are
  the controls.

### 5.3 "Send bureaucracy in one click"

The UX: select a folder (or multi-select docs) → "שתף עם גורם חיצוני" → pick
recipient kind + label + email + expiry + view-only → one click mints the
link, emails it, and writes the audit row. The **bundle** is just a
`document_shares` row with a multi-doc `scope`. Optionally generate a single
**ZIP-on-the-fly** download of the bundle (NET-NEW small — stream-zip the
decrypted/plain objects through the API; bounded by the existing 50MB-per-object
ceiling and a total cap).

---

## 6. Versioning + the document lifecycle (NET-NEW)

Today each upload is an island. Professional DMS needs lineage.

### 6.1 Versioning (NET-NEW, additive)

Add `documents.version int default 1` + `documents.supersedes_id uuid
REFERENCES documents(id)` + `documents.is_current boolean default true`. A
"new version of" upload:
1. creates a new `documents` row (full pipeline: scan + encrypt + integrity),
2. stamps `supersedes_id = <old>` + `version = old.version + 1`,
3. flips the old row `is_current = false` + `lifecycle_status = 'superseded'`
   (NOT archived — the old version stays retrievable as history).
The list defaults to `is_current = true`; a "show versions" expander walks the
`supersedes_id` chain. `content_hash` (already indexed) powers a "this is
identical to v2 — really a new version?" guard.

**Why net-new and not deferrable:** an urban-renewal תקנון goes through many
redline rounds before the FINAL signed version. Without versioning the operator
keeps "תקנון_final_FINAL_v3.pdf" naming chaos — exactly the unprofessionalism
the owner is escaping.

### 6.2 Lifecycle status (NET-NEW column, §3.4)

`draft → final → signed → superseded → archived`. `signed` is set when a
`signature_requests` row for this doc completes (a small hook in the signing
flow flips the doc status — the FK already exists). This makes "show me the
SIGNED תקנון" a first-class filter instead of a cross-table inference.

---

## 7. Search + filter (NET-NEW)

Today: filter by parent + archived only, no text search.

- **MVP — metadata search** (PUZZLE-ish): extend `GET /documents` with `q`
  matching `name` + `type` label + folder name, via a trigram index
  (`pg_trgm` on `documents.name`) — bounded, RLS-safe, agent-scoped. Hebrew:
  use the existing `he_il_icu` collation for sort; trigram for substring match.
- **Facet filters** (NET-NEW): the `type[] / status / building / owner / folder
  / uploadedBy / date-range` from §2.1.
- **Post-MVP — full-text content search**: index extracted text (we already
  parse נסח PDFs via `IExtractionProvider`; generalize an extract-on-upload
  step into a `documents_fts` tsvector). Flag as post-MVP; metadata search
  covers the launch bar.

---

## 8. Bulk operations (NET-NEW, small)

Operators manage binders, not single files. Add bulk endpoints (each a
loop over the existing single-doc service methods inside one `withTenant`, each
audited individually — no new authz surface):
- bulk move-to-folder, bulk re-type, bulk archive, bulk add-to-share,
  bulk download (ZIP, §5.3). Throttled like the existing
  confidential-doc-bulk-exfil defense (`@Throttle 30/min` already on
  list/download/create).

---

## 9. Audit — who viewed / who downloaded (PUZZLE — already there, surface it)

The audit_log already records **every** `document.download` (and create/
finalize/update/archive/scan). The gap is **surfacing** it: a per-document
"היסטוריית גישה" panel (who downloaded, when, from where) + the external-share
`last_accessed_at`. This is a read-model over `audit_log WHERE target_table =
'documents' AND target_id = ?` — **no new capture, pure FE + a scoped query.**
Add a `document.view` audit action for inline-preview opens (today only
download is logged) so "viewed" vs "downloaded" are distinguishable.

---

## 10. Puzzle vs net-new — the honest ledger

| Capability | Verdict | Basis |
|---|---|---|
| Upload / scan / magic-byte / integrity | **PUZZLE (reuse 100%)** | `documents.service.ts` unchanged |
| Envelope encryption + OTP step-up + PII gating | **PUZZLE (reuse 100%)** | `:1059` / `:897` unchanged |
| Presign + decrypt-stream + nosniff + dispositions | **PUZZLE** | `:818` / `:1113` |
| List + keyset + agent-scope + RLS | **PUZZLE (extend filters)** | `:1213` |
| Download/view audit capture | **PUZZLE (surface + add `view` action)** | audit_log already written |
| External-share primitives (scoped/timed/revocable/audited/permissioned) | **PUZZLE (generalize `shares`)** | `shares` + `ContractorReadService` |
| **Org-wide aggregate hub view** | **NET-NEW (FE + list facets/counts)** | no cross-project screen today |
| **Folders + system folders** | **NET-NEW** (`document_folders`, `folder_id`) | no container table |
| **building_id / owner_id parenting + per-owner lens** | **NET-NEW migration** | flat 3-way FK today |
| **Per-folder / per-document ACL + "who-can-see"** | **NET-NEW** (`document_acl`) | only 4 coarse perms today |
| **Versioning + supersede + lifecycle status** | **NET-NEW** (`version`/`supersedes_id`/`is_current`/`lifecycle_status`) | each upload an island today |
| **Metadata search + facets** | **NET-NEW** (`pg_trgm`, list extension) | parent-filter only today |
| **Document-shares to externals (appraiser/architect/lawyer/bank/committee)** | **NET-NEW** (`document_shares` + external read-service, generalizes `shares`) | contractor-only today |
| **Bulk ops + ZIP bundle** | **NET-NEW (small)** | single-doc only today |
| **Dynamic watermark** | **NET-NEW (post-MVP)** | needs PDF render (C1 precedent) |
| **Full-text content search** | **NET-NEW (post-MVP)** | extraction exists; FTS index doesn't |

---

## 11. Slotting into the build plan — a new DMS wave

The v4 plan (`00-FINAL-BUILD-PLAN.md`) front-loads the certainty/consent/
security gates (Waves 0-3) and pushes completeness to Wave 4. The DMS is a
**coherent new wave** that depends on Wave 0 (S0-SEC global validation pipe +
PERF cache) but is otherwise independent. Proposed **Wave 5 — DMS** (or fold
the MVP slices into Wave 4's long tail):

**DMS-MVP (launch-bar, gates external sharing the owner asked for):**
- **DMS-1 — Taxonomy schema**: migration for `document_folders`,
  `documents.{folder_id, building_id, owner_id, version, supersedes_id,
  is_current, lifecycle_status}`; system-folder seeding on project create;
  extend `DocumentTypeEnum` (tolerant reads preserved). *BE, one migration.*
- **DMS-2 — Hub + lenses + facet list**: enrich `GET /documents` (facets,
  counts, `q` via `pg_trgm`); the org-wide cockpit screen + 4 lens tabs;
  per-owner lens (needs DMS-1 `owner_id`). *BE+FE.*
- **DMS-3 — Per-folder/doc ACL + "who-can-see"**: `document_acl` + resolution
  (mirror member-override pattern, fail-closed) + the audience panel. *BE+FE.*
- **DMS-4 — Versioning + lifecycle status + access-history panel**: supersede
  flow; `signed`-status hook off `signature_requests`; surface the existing
  download audit. *BE+FE.*
- **DMS-5 — Document-shares to externals** ⭐ (the owner's headline): generalize
  `shares` → `document_shares` + external read-service (clone
  `ContractorReadService`) + the "send bureaucracy in one click" UX +
  view-only/expiry/revoke. *BE+FE. Depends on DMS-1 (folders), DMS-3 (ACL).*

**DMS-POST-MVP:** dynamic watermark (PDF render, C1 precedent) · full-text
content search (tsvector over extracted text) · tags · ZIP-bundle download ·
external one-time-code access to sensitive docs.

**Ordering note:** DMS-5 (external sharing) is the owner's emotional priority,
but it is **safety-gated on DMS-1 (a scope to share) + DMS-3 (the ACL/audience
model that tells the operator what they're exposing).** Shipping DMS-5 without
DMS-3's "who-can-see" surface would be exactly the kind of blind PII egress the
v4 plan front-loads guards against. Sequence DMS-1 → DMS-2/3 (parallel) →
DMS-4 → DMS-5.

---

## 12. Risks / decisions to flag to synthesis

1. **owner_id link + the contractor firewall.** Adding `documents.owner_id` is
   the per-owner lens enabler, but the contractor/external tiers must **never**
   traverse it. The structural "no owners table is ever queried" guarantee in
   `ContractorReadService` must be preserved in the new external read-service —
   externals see project/building/folder docs, never owner-linked PII docs.
2. **ACL backward-compat.** The "no ACL row = open to role gate" rule keeps
   every existing doc visible exactly as today; restriction is strictly
   additive (opt-in). Verify no existing test asserts "manager sees ALL docs"
   in a way the restricted-folder feature would break.
3. **Versioning vs signatures FK.** Superseding a signed doc: signatures FK to
   the OLD `documents.id` (`ON DELETE RESTRICT`) — versioning must keep the old
   row (we do; `superseded`, not deleted), so the forensic signature chain is
   intact. Good — but the signing flow must point new signature_requests at the
   `is_current` row.
4. **External watermark is the one true "later" item** the owner named —
   confirm it is acceptable to ship view-only + expiry + audit for MVP and add
   the stamped watermark in the post-MVP fast-follow.
5. **Sensitive-in-external-share** stays fail-closed (excluded) for MVP. The
   one-time-code path to share a PII doc externally is a deliberate post-MVP
   decision (legal review territory — שמאי seeing a ת"ז).
