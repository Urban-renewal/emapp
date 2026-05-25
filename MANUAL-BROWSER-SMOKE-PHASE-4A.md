# Manual Browser Smoke — Phase 4a

**Date:** 2026-05-25
**Branch:** `phase-4a-fe`
**Mode:** Real Chromium / Edge / Firefox with DevTools open (Network + Application + Console).
**Setup:** `infisical run --env=dev -- pnpm --filter @emapp/web dev` (port 3001) + API on :3000 + Postgres.

## The 4-axis pass per docs/DOD-BROWSER-SMOKE.md

For every interaction below, verify:

- **Network:** request fired to expected URL with expected method (POST, not GET, for mutations); body matches Zod
- **URL:** address bar does NOT contain any form-field name or value (no `email=`, `password=`, `name=`, `national_id=`, UUIDs)
- **Cookies:** Set-Cookie has no `Domain=`, has `HttpOnly`, `SameSite=Lax`; `Secure` per env
- **Redirect:** lands on the expected post-action page; preserves locale; no open-redirect

## Smoke matrix

| Page                              | Action                   | Expected URL after                                  | Expected POST                                                                     | Notes / status                                                                     |
| --------------------------------- | ------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| /he/login                         | Submit valid creds       | `/he` (dashboard)                                   | POST `/api/v1/auth/login`                                                         | Cookies set (access_token + refresh_token, hostOnly, HttpOnly, SameSite=Lax)       |
| /he/login                         | Submit wrong creds       | `/he/login` (unchanged)                             | POST `/api/v1/auth/login` → 401                                                   | Inline serverError shown ("שם משתמש או סיסמה שגויים")                              |
| /he/login                         | Disable JS, submit       | (browser falls back to native)                      | Should be POST to `/he/login` not GET due to `method="post"`                      | Post-S1-SEC1 closure — verifies the §S1-VG1 fix                                    |
| /he/signup                        | Submit valid form        | `/he`                                               | POST `/api/v1/auth/signup`                                                        | Cookies set                                                                        |
| /he/signup                        | Submit duplicate email   | `/he` (anti-enumeration: returns 201 same envelope) | POST `/api/v1/auth/signup`                                                        | D.14                                                                               |
| /he                               | Click "Projects" sidebar | `/he/projects`                                      | GET `/api/v1/projects`                                                            | TanStack list                                                                      |
| /he/projects                      | Click "New project"      | `/he/projects/new`                                  | (no POST yet)                                                                     | Form rendered                                                                      |
| /he/projects/new                  | Submit                   | `/he/projects/<uuid>`                               | POST `/api/v1/projects` with Idempotency-Key                                      | Project shows in list (refetch)                                                    |
| /he/projects/[id]                 | Click "Archive"          | confirm dialog → DELETE → list page                 | DELETE `/api/v1/projects/<id>`                                                    | Confirm preserves user choice                                                      |
| /he/projects/[id]                 | Click "ניהול הבניינים"   | `/he/projects/<id>/buildings`                       | GET buildings list                                                                |                                                                                    |
| /he/projects/[id]/buildings/new   | Submit                   | `/he/buildings/<uuid>`                              | POST `/api/v1/projects/<projectId>/buildings`                                     |                                                                                    |
| /he/buildings/[id]                | Click "דירות"            | `/he/buildings/<id>/apartments`                     | GET apts list                                                                     |                                                                                    |
| /he/buildings/[id]/apartments/new | Submit                   | `/he/apartments/<uuid>`                             | POST `/api/v1/buildings/<id>/apartments`                                          |                                                                                    |
| /he/apartments/[id]               | Click "ownerships"       | `/he/apartments/<id>/ownerships`                    | GET ownerships                                                                    |                                                                                    |
| /he/apartments/[id]/ownerships    | Save sum-100 set         | (page reloads)                                      | PUT `/api/v1/apartments/<id>/ownerships`                                          | Save disabled when sum != 100                                                      |
| /he/owners                        | Click "New owner"        | `/he/owners/new`                                    | (no POST yet)                                                                     |                                                                                    |
| /he/owners/new                    | Submit                   | `/he/owners/<uuid>`                                 | POST `/api/v1/owners`                                                             | **PII NEVER in URL** (national_id, phone). Verify view-source has `method="post"`. |
| /he/owners/[id]                   | Click "Archive"          | `/he/owners`                                        | DELETE `/api/v1/owners/<id>`                                                      |                                                                                    |
| /he/documents                     | Click "Upload"           | `/he/documents/new`                                 |                                                                                   |                                                                                    |
| /he/documents/new                 | Upload PDF               | `/he/documents/<uuid>`                              | POST `/api/v1/documents` → XHR PUT to R2 → POST `/api/v1/documents/<id>/finalize` | **PUT to R2 has `credentials:'omit'`** (CRITICAL §v9-post-audit fix)               |
| /he/documents/[id]                | Click "Download"         | (new tab with R2 GET)                               | POST `/api/v1/documents/<id>/download`                                            | 2-min presigned URL                                                                |
| /he/imports                       | Click "Upload"           | `/he/imports/new`                                   |                                                                                   |                                                                                    |
| /he/imports/new                   | Upload .xlsx             | `/he/imports/<uuid>`                                | POST `/api/v1/imports` → XHR PUT to R2 → POST `/api/v1/imports/<id>/start`        | Progress bar shows during upload                                                   |
| /he/imports/[id]                  | (auto) SSE stream        | (page polls)                                        | `GET /api/v1/imports/<id>/stream` (EventSource)                                   | Status/counters update live                                                        |
| /he/imports/[id]                  | Click "Cancel"           | (page updates)                                      | DELETE `/api/v1/imports/<id>`                                                     | Confirm dialog                                                                     |
| /he/imports/[id]/mapping          | Submit mapping           | `/he/imports/<id>`                                  | POST `/api/v1/imports/<id>/mapping`                                               | Defensive safeParse before POST                                                    |
| /he/signature-requests            | Click "New"              | `/he/signature-requests/new`                        |                                                                                   |                                                                                    |
| /he/signature-requests/new        | Submit (doc + owner)     | (same page, shows signUrl reveal)                   | POST `/api/v1/signature-requests` with Idempotency-Key                            | **signUrl shown ONCE; copy-to-clipboard; warning about leak**                      |
| /he/signature-requests/[id]       | Click "Cancel"           | (page updates)                                      | POST `/api/v1/signature-requests/<id>/cancel`                                     | 409 on signed → UX message                                                         |
| /sign/<JWT>                       | (load)                   | (stays on /sign/<JWT>)                              | GET `/api/v1/sign/<JWT>` with `credentials:'omit'`                                | Preview rendered                                                                   |
| /sign/<JWT>                       | Draw + submit            | (success stage)                                     | POST `/api/v1/sign/<JWT>` with `credentials:'omit'`                               | Atomic single-use; second submit → "הקישור אינו תקף"                               |
| /sign/not-a-jwt                   | (load)                   | `/he/login` (redirect via middleware)               | (no API call)                                                                     | Anti-enumeration                                                                   |

## CI automation status

The smoke matrix above is the **complete manual** test plan. The following are **automated** in CI today:

- ✅ Static check: every form has `method="post"` (apps/web/src/app-forms-no-get-fallback.spec.ts)
- ✅ Playwright: auth URL-leak tests (4) — login + signup
- ✅ Playwright: middleware bypass coverage (4) — /sign/<jwt> matcher
- ⚠️ NOT automated: the dashboard happy-path flows (S2-S9). These need a BE fixture or `next start` mode to be Playwright-reliable; recorded as a deferred TODO in PROGRESS.md §S11 caveat.

## How to actually run the manual smoke

```powershell
# 1. Boot infra
cd C:/emapp
infisical run --env=dev -- pnpm --filter @emapp/api start:dev   # port 3000
infisical run --env=dev -- pnpm --filter @emapp/web dev          # port 3001

# 2. Seed dev data
pnpm --filter @emapp/db seed:dev

# 3. Login as manager@alpha.dev / DevPassword123!
# 4. Walk the matrix above; check 4 axes in DevTools
# 5. Any FAIL → root-cause fix, NOT a test patch
```

## Findings log

(Populate as you walk. Empty section means clean run.)

- (none yet — manual smoke pending for the dashboard flows; auth flows automated via Playwright)
