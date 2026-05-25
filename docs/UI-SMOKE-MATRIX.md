# UI Smoke Matrix — every dashboard interaction

**Effective:** 2026-05-25
**Scope:** every interactive surface under `apps/web/src/app/[locale]/(dashboard)/`.
**Pair with:** [`DOD-BROWSER-SMOKE.md`](DOD-BROWSER-SMOKE.md) (the 4-axis runtime DoD).

## Why this exists

This is a per-route inventory of every button, link, form, select, and file input shipped to a Manager / Agent / Viewer / Provider Admin in the dashboard. It supplements (does not replace) the 4-axis browser DoD — that doc tells you **how** to verify a single interaction; this one tells you **what to verify on every route** so a manual smoke walkthrough (or a future Playwright matrix) covers the entire surface without gaps.

Three uses:

1. **Manual smoke pass** — walk the table top-to-bottom in a real browser. Each row gives the expected network call + console invariant + adversarial probe.
2. **Playwright authoring** — each row is a test spec. The "Expected network" column is the assertion; the "Adversarial" column is a separate test in the same spec file.
3. **Code review** — when a route changes, the diff is reviewed against this row. New buttons or new fields require a new row before merge.

## Conventions

- **Method** column uses HTTP verbs. `IDEMP` = mutation MUST carry `Idempotency-Key` header (Doc 06 §5.7 — auto-mint via `apiClient.postIdempotent`).
- **Console** column is the **failure** signature: any of these listed strings appearing in `console.error` or as a `pageerror` is a P0 regression (see `apps/web/e2e/fixtures.ts` — the failOnConsoleError CI guardrail).
- **Role** column lists which `getMe().role` values reach the page. Anyone else 403s on the BE; the FE sidebar cosmetically hides the link.
- **PII** column flags fields where the wire payload is masked-only (D.19 / Doc 07 §7.10). Verify the rendered HTML never contains the un-masked value.
- All forms MUST carry `method="post"` (§S1-SEC1 GET-fallback defense). The static check `apps-forms-no-get-fallback.spec.ts` enforces this — but list each form here so review notices a missing attribute before CI does.

---

## Global elements (every dashboard route)

| Surface | Element                                                                                      | Method               | Expected network                                                                   | Console invariant                                                     | Notes                                                  |
| ------- | -------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------ |
| Topbar  | Org name (`<NameDisplay>`)                                                                   | —                    | —                                                                                  | no `pageerror` from bidi U+202E                                       | RLS-scoped via `getMe()` SSR                           |
| Topbar  | User name + role label                                                                       | —                    | —                                                                                  | role label from `nav.role.<role>` namespace                           | label = single source of truth (also used by /members) |
| Topbar  | Notification bell `<button aria-haspopup="menu">`                                            | GET                  | `GET /api/v1/notifications?limit=5`                                                | bell badge `5+` when full + unread; no `Connection closed` (HMR-only) | popover dismisses on outside-click + Escape            |
| Topbar  | Bell → "View all" `<Link>`                                                                   | client-nav           | route to `/notifications`                                                          | —                                                                     | preserves locale                                       |
| Topbar  | Logout `<Button>`                                                                            | POST (server action) | `POST /api/v1/auth/logout` → router.refresh + `router.replace('/${locale}/login')` | NO `Domain=` on Set-Cookie clear; `HttpOnly`; `SameSite=Lax`          | §RED-10 — locale preserved on post-logout redirect     |
| Sidebar | Home / Projects / Owners / Imports / Documents / Signature-Requests / Notifications `<Link>` | client-nav           | —                                                                                  | tab-order is enabled-items only                                       | §v9-H-4 closed: `<Link>` (not `<a>`)                   |
| Sidebar | Members (Manager-only) `<Link>`                                                              | client-nav           | hidden unless `role === 'manager'`                                                 | —                                                                     | BE 403 if reached anyway                               |
| Sidebar | Audit (Manager-only) `<Link>`                                                                | client-nav           | hidden unless `role === 'manager'`                                                 | —                                                                     | BE 403 if reached anyway                               |
| Sidebar | Provider (Provider-only) `<Link>`                                                            | client-nav           | hidden unless `role === 'provider_admin'`                                          | —                                                                     | BE ProviderAuthGuard enforces                          |
| Sidebar | Disabled item `<span aria-disabled>`                                                         | —                    | —                                                                                  | not in tab order                                                      | §v9-L-1 closed                                         |

**Global invariants — verify on every route:**

- URL never contains `national_id=`, `phone=`, `email=`, or any form value (§S1-SEC1).
- `view-source:` shows every `<form>` with `method="post"`.
- No `console.error` and no `pageerror`. Benign HMR / WebSocket / ResizeObserver patterns are filtered by `e2e/fixtures.ts`; anything else is a P0.
- Every name-bearing string (user-supplied or wire-supplied) wraps in `<NameDisplay>` (§v9-H-3 bidi defense). The exception: `<option>` cannot host `<NameDisplay>` so it carries `dir="auto"` instead (§SEC-M4).
- D.16 envelope: success → `{ data, page? }`, error → `{ error: { code, message, details? } }`. Anything that escapes is a 404-envelope-bug regression (closed in M-1).

---

## / (Home)

**File:** [page.tsx](<../apps/web/src/app/[locale]/(dashboard)/page.tsx>)
**Role:** all org tiers + provider_admin (welcome shell only).

| Element                                 | Method | Expected network | Console | Adversarial |
| --------------------------------------- | ------ | ---------------- | ------- | ----------- |
| `<h1>home.title</h1>` (server-rendered) | —      | none on mount    | —       | none        |

Smoke: no interaction. The page is a Server Component reading next-intl on the server; nothing to click. Verify the org name in the topbar matches the cookie-bound session.

---

## /projects

**File:** [page.tsx](<../apps/web/src/app/[locale]/(dashboard)/projects/page.tsx>)
**Role:** manager / agent / viewer.

| Element                                                  | Method     | Expected network                                   | Console | Adversarial                        |
| -------------------------------------------------------- | ---------- | -------------------------------------------------- | ------- | ---------------------------------- |
| Create `<Button asChild><Link href="/projects/new">`     | client-nav | none on click                                      | —       | none                               |
| Row `<Link href="/projects/:id">`                        | client-nav | warm `useProject(id)` on hover (TanStack prefetch) | —       | name `<NameDisplay>` strips U+202E |
| Next-page `<Button onClick={setCursor}>`                 | GET        | `GET /api/v1/projects?limit=25&cursor=…`           | —       | cursor opaque; not a row ID        |
| Reset-to-first `<Button onClick={setCursor(undefined)}>` | GET        | `GET /api/v1/projects?limit=25`                    | —       | —                                  |
| Retry `<Button onClick={refetch}>` (error path)          | GET        | same as initial GET                                | —       | —                                  |

**Bidi probe:** create a project with name `Owner‮evil.txt` → list view MUST render with the override stripped (defense lives in `adapters/project.ts` per #67).

---

## /projects/new

**File:** [new/page.tsx](<../apps/web/src/app/[locale]/(dashboard)/projects/new/page.tsx>)
**Role:** manager only (BE 403 otherwise).

| Element                                             | Method     | Expected network                                       | Console                        | Adversarial                                                                          |
| --------------------------------------------------- | ---------- | ------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------ |
| `<form method="post" onSubmit={handleSubmit}>`      | POST IDEMP | `POST /api/v1/projects` with `Idempotency-Key: <uuid>` | —                              | double-click submit ⇒ 1 row, not 2 (P0-3)                                            |
| Name `<input>`                                      | —          | —                                                      | —                              | bidi U+202E in name accepted; adapter strips at read time                            |
| Type `<select>` (tama38_1 / tama38_2 / pinui_binui) | —          | —                                                      | —                              | client + server enforce D.18 enum                                                    |
| Description `<textarea>`                            | —          | —                                                      | —                              | XSS test: `<script>alert(1)</script>` rendered as text, never executed (NameDisplay) |
| Cancel `<Button onClick={router.back}>`             | client-nav | —                                                      | —                              | —                                                                                    |
| Submit (disabled while `isSubmitting`)              | POST IDEMP | navigates to `/projects/:id` on 200                    | server-error in red text below | `validation_error` → field-level via `useApiErrorHandler`                            |

**Network**: Content-Type `application/json`, body `{ name, type, description? }`. **URL**: stays `/projects/new`, not `/projects/new?name=…` (§S1-SEC1).

---

## /projects/:id

**File:** [\[id\]/page.tsx](<../apps/web/src/app/[locale]/(dashboard)/projects/[id]/page.tsx>)

| Element                                                                 | Method     | Expected network                                                                  | Console                                     | Adversarial                                                 |
| ----------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------- |
| `<NameDisplay>` for name + description                                  | —          | —                                                                                 | —                                           | bidi strip + XSS-safe                                       |
| Archive `<Button onClick={onArchive}>`                                  | POST IDEMP | `window.confirm` → `POST /api/v1/projects/:id/archive` → router.push('/projects') | "archive failed" inline on `ApiClientError` | concurrent click: button disabled while `archive.isPending` |
| Buildings → Manage `<Button asChild><Link>`                             | client-nav | none                                                                              | —                                           | —                                                           |
| Assignments → Manage `<Button asChild><Link>`                           | client-nav | none                                                                              | —                                           | always visible (BE gates writes, not reads)                 |
| Back-to-list (error path) `<Button onClick={router.push('/projects')}>` | client-nav | —                                                                                 | —                                           | not-found maps to `projects.notFound` label                 |

---

## /projects/:id/buildings

**File:** [buildings/page.tsx](<../apps/web/src/app/[locale]/(dashboard)/projects/[id]/buildings/page.tsx>)

Same list-shape as /projects: pagination buttons, row link, create link, retry. Backend `GET /api/v1/projects/:id/buildings?limit=&cursor=`. Row link goes to `/buildings/:bid` (not nested) — verify URL.

---

## /projects/:id/buildings/new

**File:** [new/page.tsx](<../apps/web/src/app/[locale]/(dashboard)/projects/[id]/buildings/new/page.tsx>)

| Element                                                    | Method     | Expected network                      | Console | Adversarial                          |
| ---------------------------------------------------------- | ---------- | ------------------------------------- | ------- | ------------------------------------ |
| `<form method="post">`                                     | POST IDEMP | `POST /api/v1/projects/:id/buildings` | —       | —                                    |
| address / city / block / parcel / subparcel / notes inputs | —          | —                                     | —       | bidi-in-address: stripped at adapter |
| Cancel + Submit                                            | —          | navigates to `/buildings/:newId`      | —       | —                                    |

---

## /projects/:id/assignments

**File:** [assignments/page.tsx](<../apps/web/src/app/[locale]/(dashboard)/projects/[id]/assignments/page.tsx>)
**Role:** read = all; write = manager only (D.17). The form is **hidden** when the side-load `GET /members` returns 403 — that signal is the only client-side gate.

| Element                                                            | Method                 | Expected network                                                                | Console                                                            | Adversarial                                                                          |
| ------------------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Side-load `useQuery(['members','list',…,'assignments-side-load'])` | GET                    | `GET /api/v1/members?limit=100` — 200 (Manager) or 403 (others), `retry: false` | —                                                                  | non-Manager: form not rendered (cosmetic); BE enforces                               |
| Back `<Button onClick={router.push('/projects/:id')}>`             | client-nav             | —                                                                               | —                                                                  | —                                                                                    |
| User `<select>` (manager-only)                                     | —                      | populated by JOIN of /members ∩ active assignments                              | —                                                                  | `<option dir="auto">` — partial bidi isolation, can't host `<NameDisplay>` (§SEC-M4) |
| Role `<select>` (manager-only)                                     | —                      | OrgRoleEnum.options                                                             | —                                                                  | label from `nav.role.<role>` (single namespace)                                      |
| Assign `<form method="post" onSubmit={onAssignSubmit}>`            | POST IDEMP             | `POST /api/v1/projects/:id/assignments`                                         | `assignment_exists` / `invalid_assignee` / `forbidden` field-level | duplicate detection happens BE-side too — UI hide is sugar                           |
| Unassign `<Button onClick={onUnassign(id)}>`                       | POST IDEMP (or DELETE) | `window.confirm` → `DELETE /api/v1/projects/:id/assignments/:aid`               | `forbidden` inline                                                 | row hidden if `!a.active`; Manager-only                                              |

**Probe:** open the page as Manager → list shows; switch to Agent in another tab → reload — form disappears, list still loads. Verify the 403 on `/members` is NOT logged as `console.error` (api-client classifies it as expected).

---

## /owners

**File:** [page.tsx](<../apps/web/src/app/[locale]/(dashboard)/owners/page.tsx>)
**Role:** all org tiers.

| Element                                                                  | Method     | Expected network                       | Console | Adversarial                                                            |
| ------------------------------------------------------------------------ | ---------- | -------------------------------------- | ------- | ---------------------------------------------------------------------- |
| Create `<Link href="/owners/new">`                                       | client-nav | —                                      | —       | —                                                                      |
| Row link                                                                 | client-nav | warms `useOwner(id)`                   | —       | —                                                                      |
| **PII display**: `nationalIdMasked` (e.g. `XXX-XX-1234`) + `phoneMasked` | —          | —                                      | —       | view-source: never contains the raw `national_id` or full phone (D.19) |
| Pagination + retry                                                       | GET        | `GET /api/v1/owners?limit=25&cursor=…` | —       | —                                                                      |

---

## /owners/new

**File:** [new/page.tsx](<../apps/web/src/app/[locale]/(dashboard)/owners/new/page.tsx>)

| Element                                                           | Method     | Expected network                                                           | Console | Adversarial                                                                          |
| ----------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------ |
| `<form method="post">` (§S5-SEC1 mandatory — PII payload)         | POST IDEMP | `POST /api/v1/owners` body `{ name, national_id, phone?, email?, notes? }` | —       | URL never `?national_id=…`                                                           |
| Name                                                              | —          | —                                                                          | —       | —                                                                                    |
| National-ID `<input inputMode="numeric" maxLength={9} dir="ltr">` | —          | —                                                                          | —       | invalid checksum → 400 `validation_error`; existing → 409 `owner_exists` field-level |
| Phone `<input type="tel" dir="ltr">`                              | —          | —                                                                          | —       | Israeli-format normalization happens BE-side                                         |
| Email + notes                                                     | —          | —                                                                          | —       | —                                                                                    |
| Submit                                                            | POST IDEMP | navigates to `/owners/:id` on 200                                          | —       | double-click → 1 owner, not 2                                                        |

**Critical:** open DevTools Network → submit → Headers tab — `Content-Type: application/json`, **NOT** `application/x-www-form-urlencoded`. Request URL is `/api/v1/owners`, **NOT** `/owners/new?national_id=…`. This is the §S1-SEC1 / GET-fallback regression test.

---

## /owners/:id

**File:** [\[id\]/page.tsx](<../apps/web/src/app/[locale]/(dashboard)/owners/[id]/page.tsx>)

Detail view: masked-only PII rendered in `<dl dir="ltr">` (mono font). Archive button mirrors /projects/:id pattern. **PII probe:** open view-source on the detail page — verify only the masked form appears in the HTML. The raw value must never round-trip to the wire (BE never returns it on read; FE never reconstructs).

---

## /buildings/:id

**File:** [buildings/\[id\]/page.tsx](<../apps/web/src/app/[locale]/(dashboard)/buildings/[id]/page.tsx>)

Same archive + back-link pattern. Card: Apartments → Manage `<Link>` to `/buildings/:id/apartments`.

---

## /buildings/:id/apartments

**File:** [apartments/page.tsx](<../apps/web/src/app/[locale]/(dashboard)/buildings/[id]/apartments/page.tsx>)

List with status badge (`pending` / `signed` / `refused` etc — see `APARTMENT_STATUS_LABELS_HE`). Pagination + create link.

---

## /buildings/:id/apartments/new

**File:** [apartments/new/page.tsx](<../apps/web/src/app/[locale]/(dashboard)/buildings/[id]/apartments/new/page.tsx>)

| Element                                           | Method     | Expected network                        | Console | Adversarial                |
| ------------------------------------------------- | ---------- | --------------------------------------- | ------- | -------------------------- |
| `<form method="post">`                            | POST IDEMP | `POST /api/v1/buildings/:id/apartments` | —       | —                          |
| number / floor / rooms / sizeSqm / status / notes | —          | nullable numerics via `setValueAs`      | —       | empty string → null, not 0 |
| Submit                                            | POST IDEMP | navigate to `/apartments/:newId`        | —       | —                          |

---

## /apartments/:id

**File:** [apartments/\[id\]/page.tsx](<../apps/web/src/app/[locale]/(dashboard)/apartments/[id]/page.tsx>)

Status badge + archive + back-link + Ownerships → Manage button.

---

## /apartments/:id/ownerships

**File:** [ownerships/page.tsx](<../apps/web/src/app/[locale]/(dashboard)/apartments/[id]/ownerships/page.tsx>)

| Element                                                 | Method     | Expected network                                                                     | Console                        | Adversarial                                                            |
| ------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------ | ------------------------------ | ---------------------------------------------------------------------- |
| Row select (owner)                                      | —          | catalog from `useOwnerList({limit:100})`                                             | —                              | `<option dir="auto">` — bidi partial isolation                         |
| Row pct `<input type="number" min=0 max=100 step=0.01>` | —          | —                                                                                    | —                              | sum-to-100 epsilon 0.001 enforced client + server                      |
| Add row `<Button onClick={addRow}>`                     | —          | —                                                                                    | —                              | only owners not already in `rows` shown                                |
| Remove row `<Button onClick={removeRow}>`               | —          | —                                                                                    | —                              | —                                                                      |
| Save `<Button onClick={onSave}>`                        | PUT IDEMP  | `PUT /api/v1/apartments/:id/ownerships` body `{ owners: [{ownerId, ownershipPct}] }` | `ownership_sum_invalid` inline | duplicate ownerId red-border + disable submit; server is authoritative |
| Cancel                                                  | client-nav | —                                                                                    | —                              | —                                                                      |

**Probe:** edit sum to 99.99 → Save disabled, red text "sum must be 100"; click Add to push to 100.5 → still disabled. Server-side sum check covers the case where someone bypasses the FE.

---

## /imports

**File:** [page.tsx](<../apps/web/src/app/[locale]/(dashboard)/imports/page.tsx>)

List shows file name + status badge + dry-run badge + row counts. Status colors driven by adapter; row link to `/imports/:id`.

---

## /imports/new

**File:** [new/page.tsx](<../apps/web/src/app/[locale]/(dashboard)/imports/new/page.tsx>)

| Element                                        | Method           | Expected network                                                              | Console             | Adversarial                                                                       |
| ---------------------------------------------- | ---------------- | ----------------------------------------------------------------------------- | ------------------- | --------------------------------------------------------------------------------- |
| Project `<select>`                             | —                | populated by `useProjectList({limit:100})`                                    | —                   | `dir="auto"` per option                                                           |
| File `<input type="file" accept=".xlsx,.xls">` | —                | —                                                                             | —                   | Excel MIME UX check is non-security — BE does ZIP magic-byte preflight (v8 Sec-7) |
| Dry-run `<input type="checkbox">`              | —                | —                                                                             | —                   | —                                                                                 |
| Submit `<form method="post">`                  | POST IDEMP + PUT | `POST /api/v1/imports` → presigned PUT to R2 → router.push(`/imports/:newId`) | progress bar 0→100% | mid-upload cancel → no orphan row; 5-min TTL on presigned PUT (D.36 #2)           |
| Cancel                                         | client-nav       | —                                                                             | —                   | —                                                                                 |

**Error codes:** `upload_failed` / `import_conflict` / `upload_size_mismatch` / `storage_unavailable` / `validation_error` / `wrong_file_type` each map to a distinct user message — verify they don't collapse to a generic "create failed".

**Network probe:** Network panel — three rounds: (1) `POST /api/v1/imports` (200, returns presigned URL), (2) `PUT https://*.r2.dev/…` (200, file body), (3) `POST /api/v1/imports/:id/confirm` or equivalent. CSP must allow R2 in `connect-src` (§csp-r2).

---

## /imports/:id

**File:** [\[id\]/page.tsx](<../apps/web/src/app/[locale]/(dashboard)/imports/[id]/page.tsx>)

| Element                              | Method     | Expected network                                     | Console                                                           | Adversarial                               |
| ------------------------------------ | ---------- | ---------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------- |
| Status + progress bar                | —          | initial GET + SSE                                    | —                                                                 | SSE only opens for non-terminal imports   |
| `useImportProgress(id)` SSE          | GET stream | `GET /api/v1/imports/:id/events` `text/event-stream` | live counters update; `stream_closed` → fallback to polling label | EventSource not allowed eval — verify CSP |
| Cancel `<Button onClick={onCancel}>` | POST IDEMP | `window.confirm` → `POST /api/v1/imports/:id/cancel` | `import_not_cancellable` inline                                   | only shown when `data.isCancellable`      |
| Mapping wizard `<Link>`              | client-nav | shown when `data.isAwaitingMapping` (amber card)     | —                                                                 | —                                         |
| Errors `<Link>`                      | client-nav | shown when `counters.failedRows > 0`                 | —                                                                 | —                                         |
| Back-to-list                         | client-nav | —                                                    | —                                                                 | —                                         |

---

## /imports/:id/errors

**File:** [errors/page.tsx](<../apps/web/src/app/[locale]/(dashboard)/imports/[id]/errors/page.tsx>)

Table of row-level errors. Read-only — no buttons except retry on load failure.

| Element               | Method     | Expected network                 | Console |
| --------------------- | ---------- | -------------------------------- | ------- |
| Initial load          | GET        | `GET /api/v1/imports/:id/errors` | —       |
| Retry (error path)    | GET        | same                             | —       |
| Back-to-list `<Link>` | client-nav | —                                | —       |

---

## /imports/:id/mapping

**File:** [mapping/page.tsx](<../apps/web/src/app/[locale]/(dashboard)/imports/[id]/mapping/page.tsx>)

| Element                                                                                                  | Method     | Expected network                                                     | Console                                                                                 | Adversarial                                                 |
| -------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 6 column-index inputs (national_id / name / phone / apartment_number / building_address / ownership_pct) | —          | 5 required, ownership_pct optional                                   | —                                                                                       | duplicate column index → red-border + disable submit        |
| Template name `<input maxLength={120}>`                                                                  | —          | —                                                                    | —                                                                                       | optional; saves mapping for future same-fingerprint imports |
| Submit `<form method="post">`                                                                            | POST IDEMP | `POST /api/v1/imports/:id/mapping` body `{ columns, templateName? }` | `mapping_duplicate_column` / `import_not_in_awaiting_mapping` / `import_status_changed` | bounce to `/imports/:id` if status changed                  |
| Cancel + Back                                                                                            | client-nav | —                                                                    | —                                                                                       | —                                                           |

**State-guard:** if `!data.isAwaitingMapping` on entry — render `notInAwaitingState` and back-button (not form). Probe: cancel the import in another tab → wizard switches to bounce-state on reload.

---

## /documents

**File:** [page.tsx](<../apps/web/src/app/[locale]/(dashboard)/documents/page.tsx>)

List + upload-link + pagination + retry. Same shape as /owners.

---

## /documents/new

**File:** [new/page.tsx](<../apps/web/src/app/[locale]/(dashboard)/documents/new/page.tsx>)

| Element                                      | Method           | Expected network                                      | Console                                                                   | Adversarial                                                       |
| -------------------------------------------- | ---------------- | ----------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Type `<select>` (`DOCUMENT_TYPE_LABELS_HE`)  | —                | —                                                     | —                                                                         | —                                                                 |
| File `<input type="file" accept=".pdf,...">` | —                | MIME allow-list = `DocumentMimeEnum`                  | —                                                                         | size > 50MB → `tooLarge` inline; MIME mismatch → `mimeNotAllowed` |
| Submit `<form method="post">`                | POST IDEMP + PUT | `POST /api/v1/documents` → R2 presigned PUT → confirm | `storage_unavailable` / `upload_size_mismatch` / `upload_failed` distinct | CSP `connect-src` must include R2                                 |

---

## /documents/:id

**File:** [\[id\]/page.tsx](<../apps/web/src/app/[locale]/(dashboard)/documents/[id]/page.tsx>)

| Element                                  | Method     | Expected network                                                                                     | Console                 | Adversarial                                                                                |
| ---------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| Download `<Button onClick={onDownload}>` | GET        | `GET /api/v1/documents/:id/download` → `{url}` → `window.open(url, '_blank', 'noopener,noreferrer')` | `downloadFailed` inline | §RED-1 — re-verify `^https://` before window.open (defense-in-depth over `HttpsUrlSchema`) |
| Archive `<Button onClick={onArchive}>`   | POST IDEMP | `window.confirm` → `POST /api/v1/documents/:id/archive`                                              | `archiveFailed` inline  | —                                                                                          |
| Back-to-list `<Link>`                    | client-nav | —                                                                                                    | —                       | —                                                                                          |

**Critical probe:** craft a presigned URL with scheme `javascript:` server-side (or stub it via MSW) — FE MUST refuse to open and surface `downloadFailed`. The schema check + the regex are both required (one fails open if the other is bypassed).

---

## /signature-requests

**File:** [page.tsx](<../apps/web/src/app/[locale]/(dashboard)/signature-requests/page.tsx>)

| Element                                                           | Method     | Expected network                                     | Console | Adversarial                                                          |
| ----------------------------------------------------------------- | ---------- | ---------------------------------------------------- | ------- | -------------------------------------------------------------------- |
| Create `<Link>`                                                   | client-nav | —                                                    | —       | —                                                                    |
| Status filter `<Button>` × 4 (all / pending / signed / cancelled) | GET        | `GET /api/v1/signature-requests?limit=25&status=<s>` | —       | switching filter resets cursor (no orphan cursor against new status) |
| Row `<Link>`                                                      | client-nav | —                                                    | —       | —                                                                    |
| Pagination + retry                                                | GET        | —                                                    | —       | —                                                                    |

---

## /signature-requests/new

**File:** [new/page.tsx](<../apps/web/src/app/[locale]/(dashboard)/signature-requests/new/page.tsx>)

| Element                                                                  | Method     | Expected network                                                                              | Console                                                                                                | Adversarial                                                    |
| ------------------------------------------------------------------------ | ---------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Document `<select>`                                                      | —          | populated by `useDocumentList({limit:100})`                                                   | —                                                                                                      | `dir="auto"`                                                   |
| Owner `<select>`                                                         | —          | populated by `useOwnerList({limit:100})`                                                      | —                                                                                                      | `dir="auto"` — RLS guarantees no cross-org leak                |
| Submit `<form method="post">`                                            | POST IDEMP | `POST /api/v1/signature-requests` body `{ documentId, ownerId }` → 201 `{ request, signUrl }` | `signature_request_pending_exists` / `storage_unavailable` / `validation_error` / `forbidden` distinct | —                                                              |
| Success screen — sign URL `<input readOnly dir="ltr">`                   | —          | URL is a single-use JWT (§D.12)                                                               | —                                                                                                      | view URL only once; reload erases (state-only, no cache write) |
| Copy `<Button onClick={copyToClipboard}>`                                | —          | navigator.clipboard.writeText                                                                 | clipboard may fail in non-secure context (silent)                                                      | —                                                              |
| View request `<Button onClick={router.push('/signature-requests/:id')}>` | client-nav | —                                                                                             | —                                                                                                      | —                                                              |

**§D.12 probe:** capture the signUrl, hit `/sign/:token` in a tab → submit → success. Reload `/sign/:token` → second submit MUST fail (single-use JWT enforcement). The success screen warning `signUrlWarning` is the UI signal.

---

## /signature-requests/:id

**File:** [\[id\]/page.tsx](<../apps/web/src/app/[locale]/(dashboard)/signature-requests/[id]/page.tsx>)

| Element                                                    | Method     | Expected network                                                | Console                                                     | Adversarial                          |
| ---------------------------------------------------------- | ---------- | --------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------ |
| Status + expired badge                                     | —          | initial GET                                                     | —                                                           | —                                    |
| Cancel `<Button variant="destructive" onClick={onCancel}>` | POST IDEMP | `window.confirm` → `POST /api/v1/signature-requests/:id/cancel` | `signature_request_already_signed` → `alreadySigned` inline | only shown when `data.isCancellable` |
| Back-to-list `<Link>`                                      | client-nav | —                                                               | —                                                           | —                                    |

---

## /members

**File:** [page.tsx](<../apps/web/src/app/[locale]/(dashboard)/members/page.tsx>)
**Role:** manager only (D.17 policy.ts:71). Sidebar hides for non-Manager; BE 403s otherwise.

| Element                              | Method     | Expected network                                               | Console | Adversarial               |
| ------------------------------------ | ---------- | -------------------------------------------------------------- | ------- | ------------------------- |
| Invite `<Link>`                      | client-nav | —                                                              | —       | —                         |
| Row `<Link href="/members/:userId">` | client-nav | —                                                              | —       | —                         |
| State badge + Primary badge          | —          | shows active + pending + revoked rows (forensic — ISO A.9.4.1) | —       | revoked rows still listed |
| Pagination + retry                   | GET        | `GET /api/v1/members?limit=25&cursor=…`                        | —       | —                         |

---

## /members/new

**File:** [new/page.tsx](<../apps/web/src/app/[locale]/(dashboard)/members/new/page.tsx>)

| Element                                                   | Method     | Expected network                                                                     | Console                             | Adversarial                                                    |
| --------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------ | ----------------------------------- | -------------------------------------------------------------- |
| email / name / role `<form method="post">`                | POST IDEMP | `POST /api/v1/members` body `{ email, name, role }` → 201 `{ member, inviteToken? }` | `member_exists` → email field-level | dual-tab dedup via Idempotency-Key (double-click → one invite) |
| Success — invite-token `<textarea readOnly dir="ltr">`    | —          | only in NON-PROD (D.27); prod returns no token in response                           | —                                   | token shown ONCE; navigating away erases (state-only)          |
| Copy `<Button onClick={copyToken}>`                       | —          | clipboard.writeText (silent fail OK)                                                 | —                                   | —                                                              |
| Back-to-list `<Button onClick={router.push('/members')}>` | client-nav | —                                                                                    | —                                   | —                                                              |

---

## /members/:userId

**File:** [\[userId\]/page.tsx](<../apps/web/src/app/[locale]/(dashboard)/members/[userId]/page.tsx>)

| Element                                                                                       | Method     | Expected network                                                              | Console                                                               | Adversarial                                                         |
| --------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Role `<select>` (disabled when revoked)                                                       | —          | OrgRoleEnum.options                                                           | —                                                                     | —                                                                   |
| Save `<form method="post">`                                                                   | POST IDEMP | `POST /api/v1/members/:userId/role` body `{ role }`                           | `cannot_modify_self` / `cannot_remove_last_manager` distinct messages | self-edit blocked BE-side; FE can't know `sub` so error is the gate |
| Revoke `<Button variant="destructive" onClick={onRevoke}>` (disabled when revoked or primary) | POST IDEMP | `confirm()` → `POST /api/v1/members/:userId/revoke` → router.push('/members') | `cannot_modify_self` / `cannot_remove_last_manager`                   | primary member cannot be revoked (BE refuses)                       |
| Back-to-list `<Button onClick={router.push('/members')}>`                                     | client-nav | —                                                                             | —                                                                     | —                                                                   |

---

## /notifications

**File:** [page.tsx](<../apps/web/src/app/[locale]/(dashboard)/notifications/page.tsx>)
**Role:** all org tiers (RLS self-scoped).

| Element                                               | Method     | Expected network                              | Console                             | Adversarial                                                                                                                                                                                                                                   |
| ----------------------------------------------------- | ---------- | --------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Initial load                                          | GET        | `GET /api/v1/notifications?limit=25&cursor=…` | —                                   | row carries own user_id via RLS — no cross-user leak                                                                                                                                                                                          |
| Mark-all-read `<Button>` (shown if `unreadCount > 0`) | POST IDEMP | `POST /api/v1/notifications/mark-all-read`    | silent fail (idempotent retry-safe) | —                                                                                                                                                                                                                                             |
| Per-row Mark-read `<Button>` (unread rows only)       | POST IDEMP | `POST /api/v1/notifications/:id/mark-read`    | silent fail                         | —                                                                                                                                                                                                                                             |
| Row link `<Link href={n.link as `/${string}`}>`       | client-nav | TypeScript-asserted internal path             | —                                   | **probe:** craft a notification with `link: "https://attacker.example/"` → BE schema should refuse; even if it passes, Next.js Link would render relative since the `as `/${string}`` cast is a lie — verify the runtime guard in the adapter |
| Pagination + retry                                    | GET        | —                                             | —                                   | —                                                                                                                                                                                                                                             |

---

## /audit

**File:** [page.tsx](<../apps/web/src/app/[locale]/(dashboard)/audit/page.tsx>)
**Role:** manager only (D.17 policy.ts:68 + AuditReadService role check).

| Element                                        | Method | Expected network                                                            | Console | Adversarial                                                   |
| ---------------------------------------------- | ------ | --------------------------------------------------------------------------- | ------- | ------------------------------------------------------------- |
| Initial load                                   | GET    | `GET /api/v1/audit?limit=25&cursor=…` (keyset by `createdAt DESC, id DESC`) | —       | non-Manager 403 — sidebar hides anyway                        |
| Row actor-email `<NameDisplay>`                | —      | —                                                                           | —       | bidi strip                                                    |
| Target table + truncated ID `<code dir="ltr">` | —      | —                                                                           | —       | doc 07 §8.1: no IP, no UA, no before/after diffs surface here |
| Pagination + retry                             | GET    | —                                                                           | —       | —                                                             |

**PII probe:** scroll the log — verify the rendered HTML never contains a full national_id, a full phone, or a raw before/after JSON blob. The wire shape doesn't include them; this is a regression guard against adapter widening.

---

## /provider

**File:** [page.tsx](<../apps/web/src/app/[locale]/(dashboard)/provider/page.tsx>)
**Role:** provider_admin only. Routed via [provider/layout.tsx](<../apps/web/src/app/[locale]/(dashboard)/provider/layout.tsx>) server-side role gate + [AccessReasonGate](../apps/web/src/components/provider/access-reason-gate.tsx) client-side blocker.

| Element                                                    | Method     | Expected network                                                             | Console | Adversarial                                                                    |
| ---------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------ |
| AccessReasonGate input (first entry, sessionStorage empty) | —          | NO `/api/v1/provider/*` call until reason ≥ 3 chars                          | —       | sessionStorage (NOT localStorage) — fresh-investigation intent per tab session |
| System-health gauge `useProviderSystemHealth()`            | GET        | `GET /api/v1/provider/system-health` with header `x-access-reason: <reason>` | —       | header is `encodeURIComponent`-wrapped for non-ASCII; ASCII fast-path          |
| Tenants link `<Link href="/provider/tenants">`             | client-nav | —                                                                            | —       | —                                                                              |
| Audit + System-Health links                                | client-nav | (enabled in `feat/phase-4b-s2`, not on main)                                 | —       | —                                                                              |

**Provider gate probe:** open `/provider` in incognito (no sessionStorage) — input must appear before any provider API call fires (verify Network panel is empty until reason is entered). Reload — gate re-appears (sessionStorage cleared per-tab; not persistent). Switch tab → reason in tab A NOT shared with tab B.

---

## /provider/tenants

**File:** [tenants/page.tsx](<../apps/web/src/app/[locale]/(dashboard)/provider/tenants/page.tsx>)

| Element                                   | Method     | Expected network                                                               | Console | Adversarial                                         |
| ----------------------------------------- | ---------- | ------------------------------------------------------------------------------ | ------- | --------------------------------------------------- |
| Initial load                              | GET        | `GET /api/v1/provider/tenants?limit=25&cursor=…` with `x-access-reason` header | —       | row counts only, NO PII at tenant-list level (D.37) |
| Row `<Link href="/provider/tenants/:id">` | client-nav | (detail page lands in S2)                                                      | —       | —                                                   |
| Slug pill + archived pill                 | —          | —                                                                              | —       | —                                                   |
| Pagination + retry                        | GET        | —                                                                              | —       | —                                                   |

---

## Cross-cutting adversarial probes

These probes don't bind to a single route; they're product-wide invariants. Run them once per release.

### B1 — Bidi family-defense

Create 1 owner + 1 project + 1 document each with a name containing `U+202E` (RTL override). Walk every list + detail page that surfaces that entity (incl. `<option>` dropdowns in /signature-requests/new and /imports/new). Verify:

- Lists render with the override stripped (adapter layer — `apps/web/src/adapters/{owner,project,document}.ts`).
- `<option>` elements render with `dir="auto"` partial isolation (NameDisplay cannot be a child of option).
- view-source on each surface — `U+202E` byte is absent from the served HTML.

Source: `apps/web/src/adapters/bidi-strip-invariant.spec.ts` is the unit-level matrix; this is the runtime confirmation.

### B2 — PII discipline (D.19 / Doc 07 §7.10)

- View-source on /owners and /owners/:id — verify `XXX-XX-`/masked form only, never raw `national_id`. Same for phone.
- Network → response body for `GET /owners` — `national_id` field is masked-string, NOT the raw 9-digit.
- Audit log row — actor email masked iff non-current-user (verify against the BE schema if uncertain).

### B3 — Idempotency-Key (Doc 06 §5.7)

Double-click every Submit / Archive / Cancel / Revoke / Mark-read button. Verify:

- One server-side row, not two.
- Network panel shows TWO requests with the SAME `Idempotency-Key` header (auto-mint via `apiClient.postIdempotent`).
- BE returns 200 to both; second is served from idempotency cache.

### B4 — §D.12 single-use signature JWT

Capture a `signUrl` from /signature-requests/new. Submit via /sign/:token → success. Reload `/sign/:token` → second submission MUST fail with a token-already-used error. The signing route's atomic invalidation is the LAW per D.12.

### B5 — Role gate cosmetic + BE enforcement

- Provider tier user — verify /members, /audit links are HIDDEN in sidebar.
- Manager — verify /provider link is HIDDEN.
- Anyone — hit `/members` directly (URL bar) as Agent → BE returns 403 → FE renders `loadFailed`. No PII leak in the error.

### B6 — Session expiry (D.31 G2 + §v9-P0-3/P0-4)

- Open /owners as Manager. In DevTools Application → Cookies, delete the `access_token` cookie ONLY (keep `refresh_token`).
- Navigate to /projects. The single-flight refresh should fire `POST /auth/refresh`, the navigation proceeds — NO redirect to /login.
- Now delete `refresh_token` too. Navigate. → `/login` redirect, locale preserved (§RED-10).

### B7 — CSP eval-block + R2 connect-src

- Open Console — no `EvalError` on any page load (§v9-P0-5, post-#47 close).
- Network — every upload route hits `*.r2.dev` for the PUT (§csp-r2 must allow). If R2 PUT is blocked → CSP regression.

### B8 — 4-axis on every form

Per [DOD-BROWSER-SMOKE.md](DOD-BROWSER-SMOKE.md): every form in this matrix carries `method="post"`. Run the `apps-forms-no-get-fallback.spec.ts` check + manually view-source one sample of each — if a form is missing the attribute it WILL credential-leak via GET fallback.

### B9 — Console-error CI guardrail

Walk the smoke matrix end-to-end with DevTools Console open. ANY `console.error` or `pageerror` (filtered per `e2e/fixtures.ts` benign-patterns) is a P0 regression — the failOnConsoleError fixture is the CI-side enforcement; this is the manual equivalent.

---

## How to use this document going forward

1. **Slice review:** when a route is touched, the diff must update the matching row. New buttons → new row.
2. **Pre-release manual smoke:** walk the matrix in a fresh browser session — Manager → Agent → Viewer → Provider Admin, one role per session, full top-to-bottom pass. Annotate failures in the PR description.
3. **Playwright authoring:** each section is a `describe` block; each row is an `it`. The adversarial cross-cuts (B1-B9) get their own file.
4. **Onboarding:** new contributor reads this + `CLAUDE.md` + `DOD-BROWSER-SMOKE.md` before writing FE code.

When the dev environment's proxy POST issue is resolved, the manual walk is the immediate next step. Until then, this document is the static rehearsal — anyone with a working dev env can execute it end-to-end.
