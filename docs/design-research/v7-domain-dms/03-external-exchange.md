# 03 — Secure Two-Way External Exchange + One-Click "Send the Bureaucracy"

> **Front:** External parties (שמאי / appraiser · אדריכל / architect · עו"ד / lawyer · bank ·
> the וועדה / committee) are **entities in the document flow** — they both **PROVIDE** (upload back
> into the project) and **RECEIVE** (are sent the document set they need). This doc designs the
> **secure, scoped, time-limited, audited, revocable, two-way exchange**, grounded in and extending
> the existing **contractor-share** mechanism, plus the **one-click "send the bureaucracy"** package
> builder.
> **Author:** v7 DMS council — external-exchange seat. **Date:** 2026-06-18.
> **Status:** Design, grounded in real code. READ-ONLY — no app code changed by this doc.
> **Relationship to siblings:** `01-domain-completeness.md` defines the per-entity document
> checklist (expected / received / missing) and the entity taxonomy; `02-document-management.md`
> defines the per-entity two-sided ledger and the missing→chase tie-in; **THIS doc owns the
> outward boundary** — how a document leaves the org to an external party and how it comes back.
> Where the older `03-external-sharing.md` is delivery/send-centric, this is the canonical
> **two-sided (provide + receive)** treatment the owner sharpened the model to.

---

## VERDICT (this front)

**AMBER-GREEN — extend, don't rebuild.** The org already operates a **production-grade external
read tier** (the contractor share: token-confusion-proof JWT audience, immediate revocation,
RLS-scoped, structurally-narrow read view, fail-closed download gate, access telemetry,
org-suspend kill-switch). That tier is **~60% of the secure-receive half of this front** and is the
right thing to generalize. The honest gaps are three net-new capabilities the contractor tier was
never built for, all of which **slot cleanly onto the existing seams**:

1. **A GENERIC external recipient** — today the only external party is `contractors` (a business
   partner with an aggregate project read). שמאי / אדריכל / עו"ד / bank / וועדה are not contractors;
   they need a **role-typed, document-scoped** grant (a שמאי sees the שומה bundle, not the whole
   project structure). The share row hard-binds `contractor_id`; the perms JSONB has only
   `overview / documents / signatures`. **Net-new: a generic external-party entity + a
   document-set-scoped (not project-overview-scoped) permission shape.**
2. **THE EXTERNAL CAN PROVIDE (upload back)** — every external endpoint today is **read-only**
   (`@Get` only, "Read-only" is asserted in the controller doc-comment). The appraiser returning
   the שומה, the architect returning plans, the עו"ד returning a redlined agreement — **the
   inbound provide-side does not exist.** This is the single biggest net-new piece. It reuses the
   ENTIRE sensitive-upload spine (scan → envelope-encrypt → finalize → ghost-guard) but needs an
   **external write path** that lands the bytes as a *received* document on the right entity in the
   project flow.
3. **THE PACKAGE — one-click "send the bureaucracy"** — bundling a *required document set* for a
   recipient (the וועדה package = consents tally + תצהירים + שומה + plans; the bank package =
   שומה + …) and sending it with a professional receipt + audit trail. The export composer
   (`projects/:id/export`) is the closest precedent (binary bundle, PII-fidelity, per-call audit,
   client-disconnect abort) but it produces an xlsx/pdf for the *org's own* download — it is **not**
   a recipient-addressed, multi-document, access-controlled outbound package. **Net-new: a package
   builder + the secure delivery + the receipt.**

Everything else — the token tier, the guard, revocation, RLS isolation, the encrypted serving path,
the audit spine, the last-accessed telemetry — is **puzzle (reuse)**, already at the bar.

---

## A. THE PUZZLE PIECES — what already ships, verified in code

The owner's instinct is exactly right: this **extends an existing pattern**. EMAPP already runs a
full external-party access tier; it is built to a high security bar. Evidence:

### A.1 — Share-as-grant + scoped JSONB permissions (the authZ substrate)
`packages/db/src/schema/collaboration.ts` — `shares (project_id, contractor_id, permissions jsonb,
created_by, revoked_at, revoked_by, last_accessed_at, …)`. A partial-unique index enforces "one
active share per (project, contractor)"; **revocation is lifecycle, not delete** (`revoked_at` +
`revoked_by`), so a revoked grant survives as forensic evidence.
`packages/db/src/schema/_share-permissions.ts` — `sharePermissionsSchema` is `.strict()`:
fail-closed, unknown permission keys are **rejected**, not silently granted. The A3/L4 comment
records the team *removing* dead+PII-footgun keys (`tenants.national_id`, `notes`, `team`,
`documents.actions.upload`) so the persisted JSONB reflects only enforced authority. This is the
JSONB scoped-permission shape the mandate calls for — **already hardened, just shaped for a
contractor.**

### A.2 — The external auth tier: token + guard (parallel to org auth)
`apps/api/src/modules/contractor-portal/share-token.service.ts` — a **dedicated JWT audience**
`emapp-share`. This is the structural token-confusion guard: a share token cannot authenticate
against `emapp-api` / `emapp-provider` / `emapp-tenant` / `emapp-sign`, and none of those pass the
contractor guard. 30-day TTL, but **revocation is immediate** because the guard re-checks
`revoked_at` on every request — the long TTL never outlives a revoke. Secret-isolation is *flagged*
(reuses `JWT_SECRET`; a dedicated `SHARE_TOKEN_SECRET` is a known PL-hardening step — tracked, not
silent).
`apps/api/src/modules/contractor-portal/contractor-auth.guard.ts` — per request: extract token
(cookie `contractor_access_token` **or** `Bearer`) → verify audience → load the bound `shares` row
**under the token's org RLS** → refuse if missing / revoked / org-suspended (D.49) → attach
`req.contractor = { ids + the LIVE permissions re-read from DB, not from the token }`. It also writes
`shares.last_accessed_at` (throttled 5-min, try/catch, never breaks a read): **"did the partner ever
open the link?" telemetry already exists.**

### A.3 — The scoped read-view: structurally narrow, not flag-narrow
`apps/api/src/modules/contractor-portal/contractor-read.service.ts` — every method is scoped to the
share's project under `withTenant(ctx.orgId)` RLS and gated by JSONB perms. Critically it is **narrow
by construction**: the `owners` table is *never queried* (owner-PII OFF is structural, not a runtime
flag); signature progress is **aggregate-only** (`signatureScopeForShare` returns `'none' |
'aggregate'` — `'individual'` is type-unrepresentable); documents are project-level only
(`apartment_id IS NULL`). The download gate fail-closes on
`uploaded_at IS NOT NULL AND scan_status='clean' AND sensitive=false`, with an explicit IDOR check
(`documents.project_id = ctx.projectId`) → any other id is a `404` no-oracle, never a minted URL.
**This is the exact template for a secure external document view — it just needs to be scoped to a
document SET instead of a whole project.**

### A.4 — The document confidentiality + serving spine
`apps/api/src/modules/documents/*` + `packages/db/src/schema/artifacts.ts` (`documents`):
- **Envelope encryption at rest** — `bytesEncrypted` docs are stored as
  `EMAPPENC|v1|keyId|iv|tag|AES-256-GCM-ciphertext` (key = `DOC_ENCRYPTION_KEY`, never in R2, never
  logged). Sensitive bytes ingress via `POST /documents/:id/content` (raw octet-stream, 50 MB
  ceiling) and **egress via decrypt-STREAM** in the API (a presigned URL would serve ciphertext) —
  `documents.controller.ts:92` branches `kind==='presign'` vs the decrypt-stream with
  `x-content-type-options: nosniff`.
- **ClamAV scan gate** — `scan_status` (`pending|clean|infected|error`); serving paths require
  `clean` (fail-closed).
- **Ghost-doc guard** — `uploaded_at IS NOT NULL` (a never-finalized doc is never listed/served).
- **PII step-up** — `sensitive` docs need a per-session `pii_unlocked_at` (org TTL) before the org
  download mints; the contractor tier has no step-up session, so its only fail-closed posture is
  **exclusion** (`sensitive=false`), already enforced.
- **`documents` carries `projectId` + `apartmentId` already** — so a doc can already be pinned to
  the project or to an apartment entity. The richer per-entity pin (owner / building / external
  party) is the `01`/`02` model's job; this front consumes whatever pin exists.

### A.5 — The package precedent: the export composer
`apps/api/src/modules/export/export.controller.ts` + `export-composer.service.ts` — a binary bundle
(`xlsx|pdf`) under `withTenant`, with: PII-fidelity by role, **per-call audit** (`project.export`
requested + delivered/failed outcome rows), a **DB-backed cross-replica rate limit**
(`cache_kv` PK lock, 10/hr — the in-memory `@Throttle` alone leaks 10×N on N replicas),
**client-disconnect → AbortController** (an abandoned PDF render can't pin Chromium and DoS the next
caller), and Hebrew-safe RFC-5987 `Content-Disposition` + `Cache-Control: private, no-store` +
`Vary: Cookie`. **This is the package-builder's spine** — it already knows how to compose a
recipient-grade artifact with a forensic trail. What it lacks: addressing it to an *external
recipient* and gating *their* access to it.

### A.6 — The audit + suspend + notification spine (cross-cutting, reused as-is)
`audit_log` (append-only, RLS) already records `share.create / share.update / share.revoke /
share.link_minted`. `isOrgSuspended` (D.49) freezes every share path to a `404`. The
notifications producer + `resolveNotificationRecipients` already fire `share_revoked` to the project
team. The two-way exchange reuses all three verbatim and adds new action verbs (below).

---

## B. THE TWO-SIDED MODEL — external parties as flow entities

The owner's sharpening: an external party is not just a *recipient of a link*. It is an **entity in
the document flow with two sides**:

| Party (entity type) | PROVIDES (uploads back / outbound from them) | RECEIVES / is OWED (we send to them) |
|---|---|---|
| שמאי / appraiser | the שומה (appraisal) | the data pack to appraise (plans, ownership tally, project brief) |
| אדריכל / architect | plans, היתר-track drawings | site/parcel data, program brief |
| עו"ד / lawyer | redlined / executed agreement, תצהירים drafts | owner list, consent status, the draft agreement |
| bank | financing approval / appraisal acceptance | the שומה + project financials package |
| וועדה / committee | decision / החלטה, requests-for-info | **the bureaucracy package** = consents tally + תצהירים + שומה + plans |

So **each external party has a per-party document checklist** (expected ⇄ received ⇄ missing) — the
`01`/`02` model — and **this front is the boundary mechanism that moves a document across that
checklist's two sides securely.** Two primitives:

- **RECEIVE = an outbound, recipient-addressed, access-controlled package** (B.2 + the package
  builder). The missing-on-*their-inbound* state drives "send it."
- **PROVIDE = a scoped inbound upload-back** that lands as a *received* document on the project flow
  and flips a *their-outbound-expected* item from missing→received (B.3). That flip is what closes
  the agentic loop (the chase stops).

---

## B.1 — Net-new: the generic external-party entity

**Why a new entity (not `contractors`):** a contractor is a *business partner with an aggregate
project read*. A שמאי is a *single-document-job vendor* — they should see the שומה data pack and
nothing else; not the building/apartment structure, not signature progress, not other parties' docs.
The `shares` row hard-binds `contractor_id` and the perms JSONB is project-overview-shaped. Forcing
a שמאי through `contractors` would over-grant (whole-project overview) and mis-model (a שמאי is not
a "קבלן").

**Proposed shape (extends, doesn't fork, the share tier):**

- **`external_parties`** (net-new table, org-scoped, RLS FORCE — mirror `contractors`):
  `(id, org_id, project_id, kind, display_name, contact_email?, contact_phone?, archived_at, …)`.
  `kind` is a **closed enum + DB CHECK**: `appraiser | architect | lawyer | bank | committee |
  other` (Hebrew labels in the UI layer, never in the enum — D-style). Contact PII (`contact_email`,
  `contact_phone`) is the only personal data and is treated like `contractors.contactEmail` (org
  business data, kept OUT of notification bodies, never logged).
- **`external_exchanges`** (net-new — the grant, the generalization of one `shares` row):
  `(id, org_id, project_id, external_party_id, scope jsonb, direction, expires_at, revoked_at,
  revoked_by, last_accessed_at, created_by, created_at)`. This is `shares` **plus** an
  `expires_at` (the contractor share has no native expiry — see B.4 SECURE) and a `direction`
  (`receive | provide | both`).
- **`scope jsonb`** — a `.strict()` Zod schema, the **document-SET-scoped** generalization of
  `sharePermissionsSchema`. Instead of `overview/documents/signatures` it carries:
  `{ documents: { items: uuid[] | {bundleId}, download: bool, view_only: bool, watermark: bool },
  provide: { allowed: bool, expected_types: text[] }, expires_at, otp_required: bool }`.
  Role-typed defaults per `kind` (a שמאי scope ≠ an אדריכל scope) come from a
  `defaultExternalScope(kind)` helper, mirroring `defaultSharePermissions()`.

**Reuse, not rewrite:** the token service, the guard, the RLS-scoped resolve pattern, the
last-accessed telemetry, the suspend gate — all carry over. The **audience** can stay `emapp-share`
(or split to `emapp-exchange` for blast-radius isolation — a clean PL decision); the **guard** gains
an `expires_at` + `direction` check on top of the existing `revoked_at` + suspend checks.

---

## B.2 — RECEIVE side: the scoped external viewer (read)

Generalize `contractor-read.service.ts` from "project-level docs" to "the exchange's **document
set**":

- The download/list query changes its predicate from `project_id = P AND apartment_id IS NULL` to
  `id = ANY(exchange.scope.documents.items)` (or a resolved bundle) — **still under
  `withTenant(orgId)` RLS, still IDOR-checked, still fail-closed** on `uploaded_at / scan_status /
  sensitive`. The structural-narrowing principle (A.3) is preserved: the viewer can reach **only the
  documents in its scope**, nothing else in the project.
- **`sensitive` docs CAN now be in scope** — unlike the contractor tier (which excludes them because
  it has no step-up). The שומה / financial pack ARE sensitive and ARE the whole point. The fail-closed
  posture for the external tier is **OTP/signed-link at the boundary** (B.4) + **decrypt-stream
  through the API** (never a presigned URL for an `EMAPPENC` object — already the org behavior) +
  optional **watermark** + **view-only** (no download). So sensitive exposure is *gated*, not
  *excluded* — a deliberate, scope-bound widening, audited per access.
- **view-only vs download** — `scope.documents.view_only` serves the decrypt-stream with
  `Content-Disposition: inline` and **no** download URL minted; `download` mints the
  attachment/stream. Watermark (B.5) overlays party-id + timestamp on view-only PDFs.

---

## B.3 — PROVIDE side: the external upload-back (the big net-new)

This is the inbound half the contractor tier never had. The appraiser returns the שומה; it must land
as a **received** document on the project flow, scanned + encrypted, and **flip the party's
outbound-expected checklist item from missing→received** (closing the chase loop in `02`).

**Design — reuse the entire sensitive-upload spine, add an external write path:**

- New external endpoints under the exchange tier (the FIRST `@Post` on this tier — today it's
  `@Get`-only): `POST /exchange/documents` (create + declare type/size/hash) →
  `POST /exchange/documents/:id/content` (raw octet-stream, the SAME 50 MB ceiling +
  `application/octet-stream` parser) → `POST /exchange/documents/:id/finalize`.
  **Every byte goes through the existing pipeline:** ClamAV scan → `scan_status` gate →
  AES-256-GCM envelope encrypt (`DOC_ENCRYPTION_KEY`) → ghost-guard (`uploaded_at`) → magic-byte
  real-type pre-filter (the most recent commit on this branch already hardened this) + `nosniff`.
  **No new crypto, no new scanner** — the provide path is a thin external-auth wrapper over
  `DocumentsService.uploadContent` + `finalize`.
- **Where it lands:** the uploaded doc is inserted with `org_id` = the exchange's org, `project_id`
  = the exchange's project, `uploaded_by` = a **system/exchange actor** (not a real org user — the
  external party is not a `users` row), `sensitive` derived from declared type (a שומה/financial =
  sensitive by default), and **pinned to the providing party** (the `01`/`02` per-entity pin). It is
  immediately a *received* document for the org; the manager sees it in the project's document flow
  with provenance "הועלה ע"י <party> דרך קישור מאובטח".
- **Authority + safety on the provide path:**
  - `scope.provide.allowed` must be `true` AND the exchange not revoked/expired AND the org not
    suspended — else `403`/`404` no-oracle (same posture as reads).
  - `scope.provide.expected_types` allow-lists what the party may upload (a שמאי uploads `appraisal`,
    not arbitrary types) — declared at create, enforced server-side.
  - **Tight rate limit** (e.g. 10/hr, DB-backed like the export limiter) — a leaked provide-link must
    not be a bulk-upload / storage-spam / malware-injection vector at speed.
  - The provide path **cannot read** anything it didn't just upload (no list of org docs) — write is
    structurally separate from the read scope.
  - **Audit** every provide: `exchange.document.provided` (party, exchange, doc id, declared type) —
    forensic "who returned what, when," and the signal that fires the missing→received notification
    to the project team.

---

## B.4 — SECURE: scoped + time-limited + audited + revocable + OTP/signed-link

The mandate's security checklist, mapped to mechanism (✅ = already exists / ⊕ = net-new on the seam):

- **Scoped** ✅⊕ — RLS + `.strict()` JSONB perms exist; ⊕ tighten from project-overview to a
  **document-set** scope. The viewer never sees other-entity PII because it queries only the scoped
  doc ids and **never joins owners** (A.3 structural principle carried forward). RLS/tenant isolation
  is maintained on every path (`withTenant(orgId)`).
- **Time-limited** ⊕ — the contractor share has **no native expiry** (30-day token TTL only,
  revocation-immediate). For one-shot external jobs add an explicit **`expires_at`** on the exchange,
  checked in the guard alongside `revoked_at`. A שמאי link that expires in 14 days is the norm; the
  manager sets it at create.
- **Audited** ✅⊕ — `last_accessed_at` (open telemetry) ✅ already written by the guard; ⊕ add
  **per-document, per-event** access rows: `exchange.document.viewed` / `…downloaded` with
  **counts** (who-viewed/downloaded-what-when-how-many). This is the "professional receipt"
  backbone. Append-only `audit_log` already supports it; just new action verbs.
- **Revocable in one click** ✅ — `revoked_at` + `revoked_by`, guard re-checks every request →
  **immediate** kill. Reuse `SharesService.revoke` verbatim (idempotent, fires a `*_revoked`
  notification to the team). One-click is a single `POST /exchange/:id/revoke`.
- **Envelope encryption preserved end-to-end** ✅ — `EMAPPENC` at rest both directions: the org's
  sensitive doc is decrypt-streamed *out* (never presigned ciphertext), the party's uploaded doc is
  scanned-then-encrypted *in*. The boundary never holds plaintext-at-rest.
- **OTP / signed-link** ⊕ — the contractor tier authenticates by possession of the share token only.
  For sensitive external exchange, add an **OTP step at link-open** (reuse the existing tenant SMS-OTP
  spine `auth/otp/*`, or an email OTP via Resend) gated by `scope.otp_required`. The signed link
  carries the exchange-token; OTP binds it to the human who opened it. Defaults: `otp_required=true`
  whenever the scope contains a `sensitive` doc.
- **View-only vs download** ⊕ — `scope.documents.view_only` (B.2) — inline decrypt-stream, no
  download URL.
- **Optional watermark** ⊕ — B.5.

---

## B.5 — The package builder: one-click "send the bureaucracy"

The RECEIVE side's flagship: bundle a **required document set** for a recipient and send it with a
professional receipt + audit trail.

- **Bundle templates per recipient `kind`** — a **`PackageTemplateService`** that, given
  `(project, kind)`, resolves the *expected document set*:
  - **וועדה / committee** = consents tally (the share-weighted consent artifact, A.1 of the build
    plan — already a print-grade output via the PDF export) + תצהירים + שומה + plans.
  - **bank** = שומה + project financials.
  - The template is the **`01`/`02` per-entity required-docs model read in REVERSE**: what the
    *recipient* is owed. It surfaces **missing items before send** ("השומה עדיין לא הותקבלה — לא ניתן
    לשלוח חבילה מלאה לוועדה") — the missing-state driving the workflow, exactly the owner's framing.
- **The composite (one-click contract):** `POST /projects/:id/packages` with `{ recipientPartyId,
  templateKind }` → server (a) resolves the doc set, (b) verifies each is `clean` + finalized +
  in-scope, (c) creates/refreshes an `external_exchange` scoped to exactly that set
  (`direction: receive`, `expires_at`, `otp_required` per sensitivity), (d) mints the signed link,
  (e) delivers (email/SMS via the existing `IEmailProvider`/`ISMSProvider`), (f) writes the
  **receipt** (`package.sent` audit + a `packages` row recording recipient, item list, hashes,
  sent-at). **One click, full foresight** — the preview shows who, what N documents, what's missing,
  what's sensitive, before fire (mirrors the campaign dry-run pattern the build plan mandates, M5/N8).
- **Reuse:** the export composer's binary-bundle + per-call audit + abort + Hebrew RFC-5987 +
  `no-store`/`Vary` machinery is the package-render spine; the share tier is the access-grant; the
  notification producer is the delivery signal; `audit_log` is the receipt.
- **The professional receipt** = the `packages` row + its audit trail, surfaced to the manager as
  "נשלח ל<party> ב<date> · N מסמכים · נצפה/הורד" (driven by the B.4 per-doc view/download counts).
  This is the artifact that lets a non-technical יזם *prove to the וועדה* what was sent and that it
  was received.

---

## C. PUZZLE vs NET-NEW (honest ledger)

| Capability | Verdict | Basis / what's missing |
|---|---|---|
| Share-as-grant + `.strict()` JSONB scoped perms | **PUZZLE** | `shares` + `_share-permissions.ts`, hardened |
| External JWT tier (audience-isolated token + guard) | **PUZZLE** | `share-token.service.ts` + `contractor-auth.guard.ts` |
| RLS-scoped, structurally-narrow read view | **PUZZLE** | `contractor-read.service.ts` — generalize predicate to a doc SET |
| Immediate revocation (lifecycle, guard-rechecked) | **PUZZLE** | `revoked_at` + `SharesService.revoke` |
| Envelope-encrypt + scan + ghost-guard + nosniff + magic-byte | **PUZZLE** | documents spine, both directions |
| Access telemetry (`last_accessed_at`) | **PUZZLE** | guard already writes it |
| Org-suspend kill-switch + audit spine | **PUZZLE** | `isOrgSuspended` (D.49) + `audit_log` |
| Binary-bundle + per-call audit + abort + Hebrew disposition | **PUZZLE** | export composer |
| **Generic external-party entity (kind-typed, doc-scoped)** | **NET-NEW** | `external_parties` + `external_exchanges` + `scope` Zod |
| **Time-limited grant (`expires_at`)** | **NET-NEW** (small) | one column + one guard check |
| **OTP at link-open for sensitive exchange** | **NET-NEW** (reuses OTP spine) | wire `auth/otp/*` into the exchange guard |
| **The PROVIDE path (external upload-back)** | **NET-NEW** (biggest) | external write wrapper over `uploadContent`+`finalize` |
| **Per-doc view/download counts + receipt** | **NET-NEW** (small) | new audit verbs + a `packages` row |
| **Package builder (required-set template + composite send)** | **NET-NEW** | `PackageTemplateService` + `POST /projects/:id/packages` |
| **View-only / watermark** | **NET-NEW** (medium) | inline decrypt-stream flag + PDF overlay |

**Net assessment:** ~60% reuse on the **receive/read** half; the **provide (upload-back)** half and
the **package builder** are the genuine net-new, but both bolt onto existing seams (the upload spine
and the export composer) rather than inventing infrastructure.

---

## D. SLOTTING INTO THE FINAL BUILD PLAN

Sequenced to land on the substrate the plan already front-loads (S0-SEC input-validation guard,
the audit spine, the gen-api-docs registry). Proposed slices (each carries the universal DoD: typecheck/
lint/test, 4-axis browser smoke per role, perf budget, gen-api-docs entry, North-Star check):

- **X1 — `external_parties` + `external_exchanges` + `scope` Zod (+ migration, RLS FORCE).**
  The generic entity + the grant. `defaultExternalScope(kind)`. Manager CRUD to create a party +
  mint an exchange. Reuses the share token/guard (extended with `expires_at` + `direction`). Gate:
  contract + RLS-isolation spec (other-org party invisible).
- **X2 — RECEIVE viewer (scoped read).** Generalize `contractor-read` to a document-SET scope;
  view-only vs download; sensitive-in-scope behind OTP. Gate: IDOR + no-other-entity-PII spec; OTP
  at boundary; browser walk as a real שמאי (sees only the שומה pack).
- **X3 — PROVIDE upload-back (the net-new write tier).** External `POST` create/content/finalize
  over the existing scan+encrypt spine; `expected_types` allow-list; DB-backed rate limit; lands as
  a *received* doc pinned to the party; fires missing→received notification (ties to `02`/B3 chase).
  Gate: malware-rejected spec, IDOR-on-write spec, "external can't read org docs via the write tier"
  spec.
- **X4 — Package builder + one-click send.** `PackageTemplateService` (וועדה / bank templates as the
  `01`/`02` required-set reversed) + `POST /projects/:id/packages` composite + **preview/dry-run**
  (who/what/missing/sensitive) before fire + the receipt (`packages` row + audit). Reuses export
  composer + notification + email/SMS providers. Gate: "missing-item blocks full package" spec;
  receipt audit spec; browser walk (manager sends the bureaucracy in one click, sees the receipt).
- **X5 (owner/legal-gated 🔒) — watermark + OTP-default policy + secret-isolation.** PDF watermark
  overlay (party-id + timestamp), `otp_required` defaulting, and the flagged `SHARE_TOKEN_SECRET` /
  `EXCHANGE_TOKEN_SECRET` split. Owner-gated because watermark legal text + OTP channel cost + a new
  boot env var are owner decisions.

**Dependencies:** X1 → X2 → X3 → X4 (X4 needs the receive grant + ideally the provide-side so it can
warn on still-missing items). X5 hardens after the tier is live. X3's "missing→received" signal is
the join to the `02` chase loop and the `01` per-entity checklist — this front is the **boundary
mechanism**; `01`/`02` own the checklist state it moves documents across.

---

## E. RISKS / OPEN DECISIONS for synthesis

1. **Token audience split (🔒 PL):** keep `emapp-share` for both contractors and external parties, or
   split to `emapp-exchange`? Splitting is cleaner blast-radius isolation but adds a boot env var.
   Recommend split at X5 with the secret split.
2. **`sensitive`-in-scope for external parties** is a deliberate widening over the contractor tier's
   hard exclusion. It is safe ONLY because of OTP-at-boundary + decrypt-stream + per-access audit +
   expiry + revocation. The synthesis must confirm the OTP channel (SMS vs email) and the default
   (`otp_required=true` when any scoped doc is `sensitive`).
3. **The external party is not a `users` row** — `uploaded_by` on a provided doc points to a
   system/exchange actor. Confirm the actor model so the audit/provenance reads cleanly ("via secure
   link", not a fake user).
4. **Package "completeness" is advisory, not blocking by default** — a manager may need to send a
   *partial* package to the וועדה. Recommend: preview WARNS on missing items, send is allowed with an
   explicit "שליחה חלקית" acknowledgment (audited), never silently.
5. **Watermark = PDF-only** (can't watermark an xlsx/arbitrary binary meaningfully); view-only is the
   universal control, watermark is a PDF-specific enhancement. Scope X5 to PDFs.
</content>
</invoke>
