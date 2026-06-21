# 03 — Secure External Sharing + One-Click "Send the Bureaucracy"

> **Front:** Secure document sharing with EXTERNAL parties (שמאי / appraiser,
> אדריכל / architect, עו"ד / lawyer, bank, the וועדה) — the scoped recipient model,
> time-limited + audited + revocable access, secure delivery, and the one-tap
> "package-and-send" flow. Author: v7 DMS council, external-sharing seat, 2026-06-18.
> **Status:** Design / grounded in code. READ-ONLY — no app code changed by this doc.
>
> **Verdict in one line:** ~60% of this is a *re-parameterization of code that already
> ships and is genuinely production-grade* (the contractor-share tier). The net-new is
> a **generic external-recipient entity**, a **document-set "package"**, and a
> **secure external viewer** — three bounded slices, not a rebuild.

---

## A. What already exists (the puzzle pieces — verified in code)

The owner's instinct is right: **external sharing EXTENDS an existing pattern.** EMAPP
already operates a full external-party access tier for *contractors*, and it is built to a
high bar. The relevant pieces, with file evidence:

### A.1 — The share-as-grant + scoped-permissions model
`packages/db/src/schema/collaboration.ts` — `shares` table: `(project_id, contractor_id,
permissions jsonb, created_by, revoked_at, revoked_by, last_accessed_at, created_at,
updated_at)`. A partial-unique index `shares_project_contractor_active WHERE revoked_at IS
NULL` enforces "one active share per (project, contractor)"; revocation is **lifecycle, not
delete** (`revoked_at` + `revoked_by`).
`packages/shared-types/src/share.ts` — `SharePermissionsSchema` is `.strict()` (fail-closed:
unknown permission keys are **rejected**, not silently granted — comment A3/L4 even records
removing dead+PII-footgun keys). This is exactly the JSONB scoped-permission shape the mandate
calls for, already hardened.

### A.2 — The external auth tier (token + guard), parallel to org auth
`apps/api/src/modules/contractor-portal/share-token.service.ts` — a **dedicated JWT audience**
`emapp-share` (token-confusion proof: a share token cannot authenticate against `emapp-api` /
`emapp-provider` / `emapp-tenant` / `emapp-sign`, and none of those pass the contractor guard).
30-day TTL, but **revocation is immediate** because the guard re-checks `revoked_at` on every
request, so the long TTL never outlives a revoke. Secret-isolation is flagged (currently reuses
`JWT_SECRET`; a dedicated `SHARE_TOKEN_SECRET` is a known PL-hardening step).
`apps/api/src/modules/contractor-portal/contractor-auth.guard.ts` — per request: extract token
(cookie `contractor_access_token` **or** Bearer) → verify audience → load the bound `shares` row
**under the token's org RLS** → refuse if missing / revoked / org-suspended (D.49) → attach
`req.contractor = { ids + LIVE permissions re-read from DB, not the token }`. It also writes
`last_accessed_at` (throttled 5-min, try/catch, never breaks a read) — i.e. **"did the partner
ever open the link?" telemetry already exists.**

### A.3 — The scoped read-view service (the structural-narrowing pattern)
`apps/api/src/modules/contractor-portal/contractor-read.service.ts` — every method scoped to the
share's project under `withTenant(ctx.orgId)` RLS and gated by JSONB perms. Critically, it is
**structurally narrow, not flag-narrow**: no owners table is ever queried (owner-PII OFF is
structural), signature progress is aggregate-only, documents are project-level only, and the
download gate fail-closes on `uploaded_at IS NOT NULL AND scan_status='clean' AND sensitive=false`
with an explicit IDOR check (`documents.project_id = ctx.projectId`). This is the template for a
secure external document view.

### A.4 — The document confidentiality + serving spine
`apps/api/src/modules/documents/documents.service.ts` + `storage.ts`:
- **Envelope encryption at rest** for sensitive bytes: `EMAPPENC | v1 | keyId | iv(12) | tag(16) |
  AES-256-GCM ciphertext`, random IV per object, key from Infisical (`DOC_ENCRYPTION_KEY`), never
  logged. Sensitive docs flow through `POST /documents/:id/content` (server scans plaintext, stores
  ciphertext) and download via a **decrypt-stream** (`getDecryptedStream`), never a presigned URL.
- **Upload pipeline:** magic-byte real-type verification (`verifyMagicBytes`) → ClamAV scan
  (`IFileScanProvider`) → fail-closed archive+purge on infected/mismatch.
- **Presigned-URL hygiene:** server-generated unguessable `r2Key` (`org/<orgId>/doc/<uuid>`, never
  on the wire), short TTLs (download 120s), forced `Content-Disposition: attachment` with a
  sanitized RFC-6266 filename + UTF-8 channel, pinned `responseContentType` (anti-sniff), inline-vs-
  attachment toggle. nosniff added on up/download (commit `541ebc8`).

### A.5 — The package-as-export precedent
`apps/api/src/modules/export/` — `export-composer.service.ts`, `pdf-export.service.ts`,
`export-rate-limit.service.ts`. A bulk export (xlsx/pdf) of project data already exists
(`GET /projects/:id/export`, 10/hr + DB rate-limit). This is the **bundling + binary-artifact +
rate-limit precedent** for the "send the bureaucracy" package.

### A.6 — The audit spine
`AuditService(tx, {ip, userAgent}).log({orgId, actorId, actorType, action, targetTable, targetId,
sessionId, beforeState?, afterState?, metadata?})` — append-only, used everywhere. Existing
share actions: `share.create / share.update / share.revoke / share.link_minted`. **One constraint
to note:** `actor_type IN ('user','system','provider')` (`packages/db/src/schema/artifacts.ts:299`)
— an *external recipient* action is not yet a representable actor type (see §E.4).

**Net:** the access model, the token tier, the scoped view, the encryption, the serving, the
bundling precedent, and the audit are all **already built and hardened.** What is missing is the
*generalization* of the recipient and the *grouping* of documents.

---

## B. The gap: contractor-share ≠ generic external sharing

The contractor tier is **project-scoped and contractor-entity-bound**. Five concrete gaps stand
between it and the mandate:

| # | Gap | Why the contractor tier doesn't cover it |
|---|-----|-------------------------------------------|
| **G1** | **Recipient is an existing org `contractor`** | A שמאי / עו"ד / bank / וועדה is an *arbitrary external party*, not a Contractor row. The share FK is `contractor_id NOT NULL`. We need a recipient that is **named but NOT a full user and NOT necessarily a Contractor.** |
| **G2** | **Scope is a whole project, not a document set** | The appraiser needs *docs X+Y+Z*, the וועדה needs *the committee record + signed consents + the tally* — a curated **document-scoped** grant, not "the whole project overview." |
| **G3** | **No expiry** | The share token has a 30-day TTL but the *grant* has no `expires_at`; a contractor share lives until revoked. A bureaucratic send should be **time-boxed** ("the appraiser has 14 days"). |
| **G4** | **Telemetry is binary** | `last_accessed_at` answers "ever opened?" but not **who-viewed-what-when / view counts** per document — the professional receipt bar. |
| **G5** | **No package + no one-click send** | There is no "bundle these documents and send them to this party with a covering note + a receipt" flow. Export composes *project data*, not a *curated doc set delivered to a named external party*. |

---

## C. The design — three net-new layers on the existing spine

The North Star: **extend, don't reinvent.** Re-use the token audience pattern, the guard pattern,
the RLS scoping, the encryption, the serving, the audit. Add exactly three things.

### C.1 — Net-new entity: `external_recipients` (the named-but-not-a-user party)

```
external_recipients
  id            uuid pk
  org_id        uuid not null  -> organizations (RLS boundary, FORCE)
  kind          text not null  -- 'appraiser'|'architect'|'lawyer'|'bank'|'committee'|'other'
  display_name  text not null  -- "שמאי דוד כהן" / "ועדה מקומית רעננה" (business label, NOT PII)
  contact_email citext         -- delivery target; optional (link can be copied out-of-band)
  contact_phone text           -- optional; enables SMS-OTP delivery (re-use ISMSProvider)
  notes         text
  created_by    uuid not null  -> users
  created_at / updated_at / archived_at
```

Deliberately **mirrors `contractors`** (same shape, same org-scoping, same archive lifecycle) so it
slots into the existing RLS + audit patterns with zero new infrastructure. `kind` drives the UI
preset ("the appraiser usually needs the נסח + the floor plans") and the audit label. **Decision
to lock:** keep this a *separate* table from `contractors` rather than overloading `contractors` —
a contractor is an ongoing business relationship with project-wide access; an external recipient is
a one-shot or short-lived document-scoped recipient. Conflating them re-introduces the G1/G2 PII
footgun the A3/L4 cleanup just removed.

### C.2 — Net-new entity: `document_packages` + `document_package_items` (the bundle)

```
document_packages
  id            uuid pk
  org_id        uuid not null (RLS FORCE)
  project_id    uuid not null -> projects (the package lives in a project)
  name          text not null  -- "תיק לשמאי – רחוב הרצל 5"
  cover_note    text           -- free-text covering message to the recipient
  created_by    uuid not null
  created_at / updated_at / archived_at

document_package_items
  id            uuid pk
  package_id    uuid not null -> document_packages (on delete cascade)
  document_id   uuid not null -> documents
  -- snapshot guard: an item references a document; the SEND snapshots the
  -- doc set at send-time (see C.4) so a later doc edit can't silently change
  -- what an already-sent recipient sees.
  unique (package_id, document_id)
```

A package is a **reusable, named, curated set of documents within a project.** The "send the
bureaucracy" presets (§D) pre-fill a package from a `kind`. The package itself is internal (org
users build/edit it); it becomes external only when *sent* (C.3).

### C.3 — Net-new entity: `document_shares` (the grant — generalizes `shares`)

This is the heart. It is the `shares` table, **generalized along the two axes G1+G2+G3**, and it
re-uses the exact lifecycle (`revoked_at`/`revoked_by`), telemetry (`last_accessed_at`), and JSONB-
perms patterns:

```
document_shares
  id              uuid pk
  org_id          uuid not null (RLS FORCE)
  project_id      uuid not null -> projects
  recipient_id    uuid not null -> external_recipients   -- G1: arbitrary party
  package_id      uuid          -> document_packages      -- G2: a curated set...
  -- (package_id null + a single document_id column, OR always-via-package; the
  --  council should pick one. Recommend ALWAYS-via-package: a single doc is a
  --  1-item package. Uniform downstream = one viewer, one audit shape.)
  permissions     jsonb not null  -- .strict() fail-closed, see C.5
  delivery        text not null   -- 'link'|'email_otp'|'sms_otp'
  expires_at      timestamptz not null   -- G3: ALWAYS time-boxed (no infinite external share)
  revoked_at      timestamptz
  revoked_by      uuid
  last_accessed_at timestamptz
  view_count      integer not null default 0    -- G4 (coarse; fine grain in audit)
  created_by      uuid not null
  created_at / updated_at
  -- partial-unique optional; a recipient MAY get multiple packages over time,
  -- so do NOT replicate the (project,contractor) one-active uniqueness blindly.
```

**Token tier:** a new audience `emapp-doc-share` (NOT `emapp-share` — keep the contractor tier's
blast radius separate; token-confusion proof per A.2). New `DocShareTokenService` modeled
byte-for-byte on `ShareTokenService`, payload `{ sub: recipient_id, shareId, orgId, projectId,
packageId }`. **TTL = `min(token-default, expires_at - now)`** so the token can never outlive the
grant's `expires_at`; revocation stays immediate via the guard's per-request `revoked_at` check.

### C.4 — The "send the bureaucracy" flow (one tap → receipt)

```
POST /api/v1/projects/:projectId/document-shares
  body: { recipientId, packageId | documentIds[], permissions, delivery, expiresInDays }
```

Server, in ONE withTenant tx (mirrors `shares.create` + `documents.create` patterns):
1. `assertProjectVisible` (re-use the existing helper verbatim — manager/agent-assigned gate).
2. Resolve the recipient + package under RLS; **snapshot** the package's document_ids into the
   share's items (so a later doc edit/archive can't change what a sent recipient sees — the legal
   send is the artifact at send-time).
3. **Re-assert each document is servable** at send time: `uploaded_at IS NOT NULL AND
   scan_status='clean'`. A package containing a ghost/infected doc **fails the send** with an
   actionable code (never silently drops a doc the יזם thinks they sent — the DO-NOT-FABRICATE
   doctrine applied to sends).
4. **Sensitive-doc gate:** if any item is `sensitive=true`, the send REQUIRES `delivery` to be
   `email_otp` or `sms_otp` (NOT bare link) AND the manager's session holds a valid PII step-up
   unlock (re-use `assertPiiUnlocked`). A bare-link send of a sensitive doc is **refused**
   (fail-closed) — this mirrors the contractor tier's "sensitive is structurally excluded" but
   *upgrades* it to "sensitive is allowed externally only behind OTP + watermark + manager step-up."
5. Insert the `document_shares` row + items, mint the token, audit `doc_share.create`
   (metadata: recipient kind, doc count, expires_at — never PII, never file content).
6. **Deliver:** via `IEmailProvider` (the signed link, or a "click to receive your OTP" link) or
   `ISMSProvider` (OTP). The link is `https://app/.../external/:token`.
7. **Return the RECEIPT** to the manager: `{ shareId, recipientName, docCount, expiresAt,
   deliveredVia, sentAt }` — the professional feedback the mandate asks for. The Access/Documents
   tab then shows the live share with its view telemetry.

### C.5 — The external viewer (net-new FE surface) + its permission shape

A new `(external)/external/[token]/page.tsx` route (sibling of the existing
`(contractor)/contractor/share` route — re-skinned per C7 in the build plan). It calls a new
`DocShareReadService` (modeled on `ContractorReadService`): list the package's documents (names +
types + sizes), and a per-document view/download endpoint that runs the **identical gate chain**
(visibility → uploaded → clean → expiry → revoked → OTP-if-sensitive → audit → serve). Permissions
JSONB, `.strict()` fail-closed:

```
DocSharePermissionsSchema = {
  view:     { on: boolean },          -- can list + open in-browser viewer
  download: { on: boolean },          -- view-only vs download (G: view-only is the safe default)
  watermark:{ on: boolean },          -- burn recipient+timestamp into served PDFs (C.6)
}.strict()
```

`view-only` (download.on=false) is the **professional default** for a bank/וועדה: the doc renders
in an in-app PDF viewer (the existing inline-disposition path) but no save/presigned-download URL is
minted. Download is an explicit opt-in per share.

### C.6 — Watermarking (net-new, scoped)

For PDFs served to an external recipient with `watermark.on`, burn a footer band:
`<recipient display_name> · <org name> · <served-at UTC→Asia/Jerusalem> · share <short-id>`. Re-use
`pdf-export.service.ts`'s PDF toolchain (already a dependency). Watermark applies **on serve**
(the at-rest object is unchanged + still envelope-encrypted) — so the same doc watermarks
differently per recipient, and a leaked PDF traces back to the recipient + share. Non-PDF types
(images, docx): watermark is **not applicable** → such a doc may be sent view-only but the UI must
not *claim* a watermark it can't burn (DO-NOT-FABRICATE). Recommend: external sends of sensitive
docs are **PDF-only** at MVP (the bureaucracy is overwhelmingly PDF anyway), with a clear "convert
to PDF to share securely" affordance for other types.

---

## D. The "kind → package preset" map (the domain intelligence)

The one-click value is in *knowing what each party needs*. From the urban-renewal job-to-be-done:

| Recipient `kind` | Default package preset (the bureaucracy) | Default perms |
|---|---|---|
| **שמאי / appraiser** | נסח טאבו (per building) · floor plans / תוכניות · the project overview · valuation-relevant owner *aggregate* (never per-owner PII) | view + download, watermark, 14d |
| **אדריכל / architect** | floor plans · building survey · the parcel/תב"ע docs | view + download, 30d |
| **עו"ד / lawyer** | the signed consent set (signed-document PDFs) · the consent tally · the committee record · נסח | view + download, watermark, 30d |
| **bank** | the consent tally · valuation · project status letter · signed-consent count (aggregate) | **view-only**, watermark, OTP, 30d |
| **וועדה / committee** | the committee record (פרוטוקול) · ALL signed consents · the tally · נסח · plans | view + download, watermark, OTP, 60d |
| **other** | empty package (manual curation) | view-only, 14d |

The preset is a *starting point* the manager edits — never an auto-send. These presets are the
single most domain-valuable artifact this front produces; they encode "what should be in the
system" for the send-bureaucracy job. **The completeness-audit front should cross-check these
against the real-world process** (e.g. does the וועדה also require a שמאות-מקרקעין certificate we
don't yet model as a document type?).

---

## E. Security model — what stays, what's new, the honest sharp edges

### E.1 — Preserved invariants (free, because we extend)
- **Envelope encryption preserved at rest** — the external viewer decrypt-streams via the existing
  `getDecryptedStream`; ciphertext never leaves R2. R2 keys never on the wire.
- **RLS / tenant isolation preserved** — every external read loads the grant + docs under
  `withTenant(token.orgId)` FORCE; a forged orgId can't cross-tenant (RLS), and revoked/expired/
  suspended → generic 401/404 no-oracle (the contractor guard's exact posture).
- **Magic-byte + AV gate preserved** — nothing un-scanned/un-clean is ever in a package send.
- **Audit preserved + extended** — every external view/download is an audit row.

### E.2 — New controls
- **Always time-boxed** (`expires_at` non-null; token TTL clamped to it). No infinite external share.
- **One-click revoke** — `DELETE /document-shares/:id` → `revoked_at` + `revoked_by`; immediate
  (guard re-checks every request). Re-use `shares.revoke` verbatim incl. the notify pattern.
- **OTP-gated delivery** for sensitive sends (`email_otp` / `sms_otp` via the existing providers;
  `NoopSMSProvider` is dev/test only per D.20).
- **Watermark** per-recipient traceability (C.6).
- **View-only default** (no download URL minted unless `download.on`).
- **Per-document view telemetry** — audit row per serve + `view_count` increment → the receipt.

### E.3 — The sharp edges (honest)
1. **A signed link IS a bearer credential.** A pure-link delivery (no OTP) means anyone with the
   URL can view until expiry/revoke. Mitigation tiers: OTP for sensitive (mandatory), short expiry,
   view-only+watermark, immediate revoke, and "the link was opened from N distinct IPs" surfaced to
   the manager. **Decision needed:** is bare-link acceptable for *non-sensitive* sends (floor plans
   to an architect)? Recommend **yes for non-sensitive, OTP-mandatory for sensitive.**
2. **View-only is not screenshot-proof.** A determined recipient can screenshot a rendered PDF.
   Watermarking is the realistic control (traceability, not prevention). Don't oversell "secure
   view" as un-exfiltratable — it deters + traces, it doesn't prevent. State this plainly in the UI.
3. **Snapshot vs live.** Recommend **snapshot at send** (legal artifact = what was sent). A
   *re-send* (new share) is the way to deliver updated docs — never silently mutate a live share's
   doc set. This also makes the audit trail honest ("share #X delivered exactly these 5 docs").
4. **OTP for a וועדה is a shared mailbox.** A committee email is often a role inbox; OTP-to-email
   may land with many readers. That's acceptable (the org chose that recipient) but the audit can't
   distinguish *which human* opened it — surface "delivered to <committee email>", not "opened by
   <person>".

### E.4 — Schema touch-point (real, small)
`actor_type IN ('user','system','provider')` (`artifacts.ts:299`). An external-recipient view/
download needs an actor identity. **Two options:** (a) add `'external'` to the CHECK (a migration +
the schema-constraint-ripple caution from memory — every raw-SQL seeder of audit_log must be
checked); or (b) log external actions with `actor_type='system'` + `metadata.recipient_id` +
`metadata.share_id`. **Recommend (a) `'external'`** — it makes the forensic spine honestly
attribute external access as a first-class actor, matching how `contractor` access *should* have
been attributed too (the contractor guard currently writes `last_accessed_at` but emits no audit
row per contractor read — a latent gap this work can close for both tiers). This is the one
non-trivial migration; everything else is additive tables.

---

## F. Puzzle vs net-new (the honest ledger)

| Layer | Status | Evidence / re-used file |
|---|---|---|
| Share-as-grant + JSONB `.strict()` perms + revoke lifecycle | **PUZZLE** | `collaboration.ts` shares · `share.ts` |
| External token tier (audience isolation, guard, RLS load, immediate-revoke) | **PUZZLE** (clone w/ new audience) | `share-token.service.ts` · `contractor-auth.guard.ts` |
| Scoped structural read-view + IDOR + fail-closed serving | **PUZZLE** (clone) | `contractor-read.service.ts` |
| Envelope encryption + magic-byte + AV + presign hygiene + decrypt-stream | **PUZZLE** (re-used verbatim) | `documents.service.ts` · `storage.ts` |
| Bundling + binary artifact + rate-limit | **PUZZLE** (precedent) | `export/*` |
| Audit spine | **PUZZLE** + 1 CHECK migration | `AuditService` · `artifacts.ts:299` |
| `external_recipients` entity | **NET-NEW** (mirrors `contractors`) | — |
| `document_packages` + items (the bundle) | **NET-NEW** | — |
| `document_shares` grant (doc-scoped + expiry + view_count) | **NET-NEW** (generalizes `shares`) | — |
| `kind → package preset` domain map | **NET-NEW** (domain IP) | §D |
| Watermark-on-serve | **NET-NEW** (re-uses pdf toolchain) | `pdf-export.service.ts` |
| External viewer FE + view-only render | **NET-NEW** (sibling of contractor route) | `(external)/external/[token]` |
| OTP delivery for sensitive sends | **PUZZLE** (re-use IEmail/ISMS) | wiring only |

**Roughly 60% puzzle, 40% net-new** — and the net-new is three additive tables + a viewer + a
preset map, all on proven rails.

---

## G. Slot into the build plan

This is a **new sub-wave in the DMS track** (v7), dependency-ordered, every slice carrying the
universal DoD (§A.3 of `00-FINAL-BUILD-PLAN.md`: typecheck/lint/test + 4-axis Chrome verify per
role + perf budget + North-Star check + the input-validation-coverage guard for new endpoints).
It depends on **C7 (contractor share re-skin)** landing first (shares the external-route shell) and
on the DMS hub front's document-library work (the package builder needs a doc picker).

| Slice | Name | What | Files | Gate |
|---|---|---|---|---|
| **X1** | External recipients | `external_recipients` table + migration + Zod contract + CRUD (`/external-recipients`) + RLS + audit | new `modules/external-sharing/*`; `shared-types/external-recipient.ts`; `schema/collaboration.ts` | P1; api-docs registry entry (memory: coverage guard) |
| **X2** | Document packages | `document_packages` + items + builder endpoints (`/projects/:id/document-packages`) + the `kind→preset` presets | `modules/external-sharing/*`; reuse doc-picker | P1; snapshot-at-send unit test |
| **X3** | Doc-share grant + token tier | `document_shares` table + `DocShareTokenService` (audience `emapp-doc-share`) + `DocShareReadGuard` + `DocShareReadService` (clone the contractor trio) | `modules/external-sharing/*` | **SECURITY-SENSITIVE** → `@security-reviewer` before commit; token-confusion + RLS-isolation specs |
| **X4** | Send + receipt + delivery | `POST .../document-shares` (snapshot, servable-recheck, OTP-gate, mint, deliver, audit, receipt) + revoke + list-with-telemetry | + `IEmailProvider`/`ISMSProvider` wiring | 4-axis verify (manager); the receipt is the FE proof |
| **X5** | External viewer + view-only + watermark | `(external)/external/[token]` route, in-app PDF viewer, view-only enforcement, watermark-on-serve | `apps/web/.../external/*`; `pdf-export.service.ts` | view-source self-check; watermark visual smoke (memory: "render PDFs visually") |
| **X6** 🔒 | `actor_type='external'` migration + per-external-read audit (also retrofit contractor reads) | CHECK migration + audit row per external view/download | `schema/artifacts.ts`; both guards | schema-constraint-ripple check (memory): scan every raw-SQL audit_log seeder |

**Owner/legal gate to clear (🔒):** is a *bare signed link* (no OTP) acceptable for non-sensitive
external sends, or is OTP mandatory for **all** external delivery? (Recommend bare-link OK for
non-sensitive, OTP-mandatory for sensitive — but this is a posture the owner should ratify, like the
other external/legal go/no-go items in the plan's §G.)
