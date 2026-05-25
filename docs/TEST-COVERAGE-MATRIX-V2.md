# TEST-COVERAGE-MATRIX V2 — Full Functionality + Permissions Inventory

> **Audience:** any new agent joining the team, any human reviewer planning tests, any designer producing mockups.
> **Generated:** 2026-05-25 from live source (controllers + pages + policy.ts + shared-types).
> **Refresh:** re-run the enumeration commands at the bottom whenever a controller/page is added.

---

## 1. The product, in three tiers

EMAPP is a multi-tenant B2B SaaS for Israeli urban renewal (תמ"א 38, פינוי-בינוי). The data model is segregated into three **independent JWT audiences** (D.29 — never confuse):

```
┌─────────────────────────┐  ┌─────────────────────┐  ┌──────────────────────────┐
│  Tier 1 — Org users     │  │  Tier 2 — External  │  │  Tier 3 — Provider Admin │
│  emapp-api audience     │  │  emapp-tenant aud   │  │  emapp-provider audience │
│                         │  │  / emapp-sign aud   │  │                          │
│  Manager / Agent /      │  │  Tenant (OTP) /     │  │  Provider Admin (us)     │
│  Viewer                 │  │  Contractor (share) │  │  + MFA mandatory         │
│                         │  │                     │  │                          │
│  withTenant(orgId, fn)  │  │  RLS-scoped to own  │  │  withProvider(uid,       │
│                         │  │  owner record +     │  │    reason, fn)           │
│                         │  │  share/signature    │  │  BYPASSRLS pool          │
│                         │  │                     │  │  Every call audited      │
└─────────────────────────┘  └─────────────────────┘  └──────────────────────────┘
```

A user in one tier can never accidentally act as another. The JWT verification (`audience` claim) makes mis-routing physically impossible — not policy, structural.

---

## 2. The D.17 Authorization Matrix — locked

Source: `apps/api/src/common/authz/policy.ts`. Enforced by `AuthorizationGuard` on every controller. Verified against an independent restatement in `policy.spec.ts` (catches drift).

Legend: ✅ = allowed; — = denied (403). Cells marked `record-scoped` mean the role passes the coarse gate but the service further filters by record (e.g., Agent → only assigned projects; Notification → only own).

| Resource                             | read                                                         | create          | update                                                           | delete                                                                     |
| ------------------------------------ | ------------------------------------------------------------ | --------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **projects**                         | manager / agent / viewer                                     | manager         | manager                                                          | manager                                                                    |
| **buildings**                        | manager / agent / viewer                                     | manager         | manager                                                          | manager                                                                    |
| **apartments**                       | manager / agent / viewer                                     | manager         | manager                                                          | manager                                                                    |
| **owners**                           | manager / agent / viewer                                     | manager         | manager                                                          | manager                                                                    |
| **ownerships** (set-replace via PUT) | manager / agent / viewer                                     | manager         | manager                                                          | manager                                                                    |
| **contractors**                      | manager / agent / viewer                                     | manager         | manager                                                          | manager                                                                    |
| **shares**                           | manager / agent / viewer                                     | manager         | manager                                                          | manager                                                                    |
| **tasks**                            | manager / agent / viewer (Agent: assigned only)              | manager         | **manager / agent** (Agent: only own assigned, only status+desc) | manager                                                                    |
| **notifications**                    | self only (RLS-locked)                                       | manager         | **any role** (mark-read = self update)                           | manager                                                                    |
| **notes**                            | manager / agent / viewer                                     | manager / agent | manager / agent (author check in service)                        | manager / agent (author check in service)                                  |
| **audit**                            | **manager only**                                             | manager         | manager                                                          | manager                                                                    |
| **members**                          | **manager only**                                             | manager         | manager                                                          | manager                                                                    |
| **documents**                        | manager / agent / viewer (Agent: assigned-project docs only) | manager         | manager                                                          | manager                                                                    |
| **project_assignments**              | manager / agent / viewer                                     | manager         | manager                                                          | manager                                                                    |
| **signature_requests**               | manager / agent / viewer                                     | manager         | manager                                                          | manager (cancel = status flip, never DELETE — forensic per migration 0021) |
| **imports**                          | manager / agent / viewer                                     | manager         | manager                                                          | manager                                                                    |

**Tenant tier:** no rows above apply. Tenant sees only own owner record + own signature flow.

**Provider Admin tier:** entirely separate policy table (no D.17 cells apply). Read-only on `tenants`, `audit`, `system-health`. Any write = Gate-6 (D.x extension needed).

---

## 3. BE Endpoint Catalog (live, 2026-05-25)

### 3.1 Auth (org) — `/api/v1/auth/*` and `/api/v1/me`

| Method | Path                  | Auth                 | Role                 | Notes                                                                                                       |
| ------ | --------------------- | -------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------- |
| POST   | `/auth/signup`        | public               | —                    | Throttle 5/10min. D.14 anti-enum: dup-email returns 201.                                                    |
| POST   | `/auth/login`         | public               | —                    | Throttle 10/min. argon2id verify. Sets `access_token` + `refresh_token` (hostOnly, HttpOnly, SameSite=Lax). |
| POST   | `/auth/refresh`       | public (uses cookie) | —                    | Refresh token rotation + reuse-detection (D.21).                                                            |
| POST   | `/auth/logout`        | authed               | any                  | Clears both cookies + revokes session.                                                                      |
| POST   | `/auth/switch-org`    | authed               | any (multi-org user) | Issues new JWT with selected org.                                                                           |
| POST   | `/auth/accept-invite` | public (uses token)  | —                    | Member-onboarding via emailed invite token.                                                                 |
| GET    | `/me`                 | authed               | any                  | Returns `UserProfile` for current session.                                                                  |

### 3.2 Auth (tenant OTP) — `/api/v1/auth/otp/*`

| Method | Path                | Auth   | Notes                                                                                                          |
| ------ | ------------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| POST   | `/auth/otp/request` | public | Throttle 5/15min. SMS code (NoopSMSProvider in dev). D.30: multi-org phone disambiguation requires `org_slug`. |
| POST   | `/auth/otp/verify`  | public | Throttle 10/15min. Mints `emapp-tenant` JWT.                                                                   |

### 3.3 Auth (Provider Admin) — `/api/v1/provider/auth/*`

| Method | Path                     | Auth            | Role           | Notes                                                   |
| ------ | ------------------------ | --------------- | -------------- | ------------------------------------------------------- |
| POST   | `/provider/auth/login`   | public          | —              | Throttle 5/10min. Password + TOTP code (MFA mandatory). |
| POST   | `/provider/auth/refresh` | public (cookie) | —              | Throttle 20/min.                                        |
| POST   | `/provider/auth/logout`  | authed          | provider_admin |                                                         |

### 3.4 Public signing — `/api/v1/sign/:token`

| Method | Path           | Auth               | Notes                                                                                                                |
| ------ | -------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| GET    | `/sign/:token` | none (JWT in path) | Throttle 30/hour. Returns preview (owner + document + expiry).                                                       |
| POST   | `/sign/:token` | none (JWT in path) | Throttle 5/hour. Atomic single-use via `WHERE jti AND status='pending'`. SVG signature encrypted-at-rest (D.12 LAW). |

### 3.5 Org domain entities — all gated by `AuthGuard + TenantGuard + AuthorizationGuard`

| Module                  | Routes (selected)                                                                                                              | Notes                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| **projects**            | `GET / · POST / · GET :id · PATCH :id · DELETE :id`                                                                            | Cursor pagination on list.                                                                             |
| **buildings**           | `GET /projects/:projectId/buildings · POST · GET :id · PATCH :id · DELETE :id`                                                 | Nested under project.                                                                                  |
| **apartments**          | `GET /buildings/:buildingId/apartments · POST · GET :id · PATCH :id · DELETE :id`                                              | Nested under building. Entity is "apartment" — UI "דירה".                                              |
| **owners**              | `GET / · POST /search · POST · GET :id · PATCH :id · DELETE :id`                                                               | Search via POST body (PII never in URL). `national_id` masked `•••••••XX`, `phone` masked `•••••XXXX`. |
| **ownerships**          | `GET /apartments/:apartmentId/ownerships · GET /apartments/:apartmentId/owners · PUT /apartments/:apartmentId/ownerships`      | **Atomic set-replace** (D.25). Sum must = 100 or empty.                                                |
| **contractors**         | `GET / · POST · GET :id · PATCH :id · DELETE :id`                                                                              | External contractor records.                                                                           |
| **shares**              | `GET /projects/:projectId/shares · POST · PATCH :id · DELETE :id`                                                              | Contractor access grants (JSONB perms, validated).                                                     |
| **tasks**               | `GET /tasks · POST · GET :id · PATCH :id · DELETE :id · GET :id/assignees · POST :id/assignees · DELETE :id/assignees/:userId` | Agent sees only own assigned (T3.T.1).                                                                 |
| **notes**               | `GET / · POST · GET :id · PATCH :id · DELETE :id`                                                                              | Manager-or-author for write.                                                                           |
| **audit**               | `GET /`                                                                                                                        | **Manager-only.** Append-only org-scoped read. IP/UA stored but not exposed in this view.              |
| **members**             | `GET / · POST · PATCH :userId · DELETE :userId`                                                                                | Manager-only. Invite via email (D.27).                                                                 |
| **documents**           | `GET / · POST · GET :id · GET :id/download · POST :id/finalize · PATCH :id · DELETE :id`                                       | Presigned PUT to R2 (D.28). `r2Key` never on wire. Magic-byte check on finalize.                       |
| **notifications**       | `GET / · POST /read-all · POST :id/read`                                                                                       | Self-scoped (RLS-locked).                                                                              |
| **project_assignments** | `GET /projects/:projectId/assignments · POST · DELETE /assignments/:id`                                                        | Manager assigns Agents to projects.                                                                    |
| **imports**             | `POST / · GET / · GET :id · POST :id/start · DELETE :id · GET :id/errors · POST :id/mapping · GET :id/stream`                  | Excel pipeline (D.34). SSE progress. pg-boss worker.                                                   |
| **signature_requests**  | `GET / · POST · GET :id · POST :id/cancel`                                                                                     | Cancel = status flip (never DELETE per migration 0021).                                                |

### 3.6 Provider Admin tier — `/api/v1/provider/*`

All gated by `ProviderAuthGuard + ProviderAuthorizationGuard`. Every call requires `access_reason` header. Every call writes an `audit_log` row. PII masked even at Provider tier (per D.37).

| Method | Path                      | Notes                                                             |
| ------ | ------------------------- | ----------------------------------------------------------------- |
| GET    | `/provider/tenants`       | List orgs. Cursor pagination. Throttle 30/min.                    |
| GET    | `/provider/tenants/:id`   | Tenant detail + sample owners (PII masked). Throttle 10/min.      |
| GET    | `/provider/audit`         | Cross-tenant audit search. Filters: org_id + date range + action. |
| GET    | `/provider/system-health` | pg-boss queue depth, DB pool stats, R2 errors. Read-only gauges.  |

**Writes (suspend / reset MFA / reactivate) = Gate-6.** Not implemented; would require new D.NN entry per docs/03 §10.5.

---

## 4. FE Route Catalog (live, 2026-05-25)

### 4.1 Public (no auth, no [locale])

| Route           | Purpose                          | API used                                 |
| --------------- | -------------------------------- | ---------------------------------------- |
| `/sign/[token]` | Tenant signs document (D.12 LAW) | `GET /sign/:token` · `POST /sign/:token` |

### 4.2 Auth shell (no [dashboard])

| Route              | Purpose                       | Role | API used            |
| ------------------ | ----------------------------- | ---- | ------------------- |
| `/[locale]/login`  | Manager/Agent/Viewer login    | —    | `POST /auth/login`  |
| `/[locale]/signup` | New org self-serve onboarding | —    | `POST /auth/signup` |

### 4.3 Dashboard — Manager surface (existing FE)

| Route                                     | Purpose                         | Role gate        | API used                                                              |
| ----------------------------------------- | ------------------------------- | ---------------- | --------------------------------------------------------------------- |
| `/[locale]/`                              | Home / welcome                  | any org role     | `GET /me` (server)                                                    |
| `/[locale]/projects`                      | List projects                   | any              | `GET /projects`                                                       |
| `/[locale]/projects/new`                  | Create                          | manager          | `POST /projects`                                                      |
| `/[locale]/projects/[id]`                 | Detail                          | any              | `GET /projects/:id`                                                   |
| `/[locale]/projects/[id]/buildings`       | List buildings of project       | any              | `GET /projects/:id/buildings`                                         |
| `/[locale]/projects/[id]/buildings/new`   | Create building                 | manager          | `POST /projects/:id/buildings`                                        |
| `/[locale]/buildings/[id]`                | Building detail                 | any              | `GET /buildings/:id`                                                  |
| `/[locale]/buildings/[id]/apartments`     | List apts of building           | any              | `GET /buildings/:id/apartments`                                       |
| `/[locale]/buildings/[id]/apartments/new` | Create apt                      | manager          | `POST /buildings/:id/apartments`                                      |
| `/[locale]/apartments/[id]`               | Apt detail                      | any              | `GET /apartments/:id`                                                 |
| `/[locale]/apartments/[id]/ownerships`    | Set-replace ownerships          | manager          | `PUT /apartments/:id/ownerships`                                      |
| `/[locale]/owners`                        | List owners (PII masked)        | any              | `GET /owners`                                                         |
| `/[locale]/owners/new`                    | Create owner                    | manager          | `POST /owners`                                                        |
| `/[locale]/owners/[id]`                   | Owner detail                    | any              | `GET /owners/:id`                                                     |
| `/[locale]/documents`                     | List documents                  | any              | `GET /documents`                                                      |
| `/[locale]/documents/new`                 | Upload doc (presigned PUT → R2) | manager          | `POST /documents` then `PUT <r2>` then `POST /documents/:id/finalize` |
| `/[locale]/documents/[id]`                | Doc detail + download           | any              | `GET /documents/:id` + `GET /documents/:id/download`                  |
| `/[locale]/imports`                       | List imports                    | any              | `GET /imports`                                                        |
| `/[locale]/imports/new`                   | Upload Excel                    | manager          | `POST /imports` then `PUT <r2>` then `POST /imports/:id/start`        |
| `/[locale]/imports/[id]`                  | Import detail + SSE progress    | any              | `GET /imports/:id` + `GET /imports/:id/stream`                        |
| `/[locale]/imports/[id]/errors`           | List import errors              | any              | `GET /imports/:id/errors`                                             |
| `/[locale]/imports/[id]/mapping`          | Manual column mapping wizard    | manager          | `POST /imports/:id/mapping`                                           |
| `/[locale]/signature-requests`            | List signature requests         | any              | `GET /signature-requests`                                             |
| `/[locale]/signature-requests/new`        | Create request                  | manager          | `POST /signature-requests`                                            |
| `/[locale]/signature-requests/[id]`       | Detail + copy link + cancel     | manager (cancel) | `GET :id` + `POST :id/cancel`                                         |

### 4.4 Gaps — BE endpoints with NO FE coverage today

These need Phase 4b (Provider Admin) and Phase 4c (Collaboration) to ship a feature-complete MVP:

**Phase 4b (Provider Admin tier — entirely new surface):**

- `/provider/login` (with MFA challenge)
- `/provider/tenants` (cross-tenant list)
- `/provider/tenants/:id` (tenant detail + sample data, PII masked)
- `/provider/audit` (cross-tenant audit search)
- `/provider/system-health` (gauges dashboard)

**Phase 4c (Collaboration FE — missing org-side pieces):**

- `/[locale]/members` (Manager-only — invite + manage org members)
- `/[locale]/projects/[id]/assignments` (Manager assigns Agents to project)
- `/[locale]/notifications` (Self mark-read; bell icon in topbar)
- `/[locale]/audit` (Manager-only — view org audit log with filters)

**P2 (later, not MVP-blocking):**

- `/[locale]/tasks` (Tasks UI per role)
- `/[locale]/notes` (Notes UI)
- `/[locale]/contractors` + `/[locale]/projects/[id]/shares` (Contractor management)
- Tenant SMS-OTP login + own-record view (currently Tenant only signs via /sign/[token], doesn't see records)

---

## 5. Tier Separation — cookie / URL / audience

|              | Org (Tier 1)                     | Tenant (Tier 2)                                                    | Provider Admin (Tier 3)                            |
| ------------ | -------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------- |
| Cookie name  | `access_token` + `refresh_token` | `tenant_access_token` (or none — `/sign/[token]` uses JWT-in-path) | `provider_access_token` + `provider_refresh_token` |
| Path scope   | `/` and `/api/v1/auth/refresh`   | (sign flow is cookie-less; OTP cookie scoped to `/`)               | TBD (Phase 4b route-group decision pending)        |
| JWT audience | `emapp-api`                      | `emapp-tenant` / `emapp-sign`                                      | `emapp-provider`                                   |
| URL prefix   | `/[locale]/*`                    | `/sign/[token]` (locale-agnostic)                                  | `/provider/*` (route group decision pending)       |
| MFA          | optional (Phase 9+)              | n/a                                                                | **mandatory**                                      |
| Audit        | per write action                 | per signing event                                                  | **every call** with `access_reason`                |
| PII handling | masked on display                | sees own data only                                                 | **always masked**, even cross-tenant               |

---

## 6. The Test Coverage Axes — every slice covers all five

Per the agreed methodology (from §0.8 of the agent prompt), a slice is not "done" until tests cover all five axes:

**א. פונקציונליות** — happy path + edge cases (null/empty/max/UTF-8/Hebrew/NUL/state transitions)
**ב. אבטחה** — defense-in-depth (RLS alone / withTenant alone / Guard alone / Zod DTO alone each stops abuse) + no-oracle 404s + PII never leaks
**ג. ניהול שגיאות** — every documented error code fires, envelope tight, no internals leak (DB / R2 / NestJS) + timeout/abort/network drops survive
**ד. זמן ריצה** — p95 budget, N+1 counter, batch limits, factory memoization, storage deadlines
**ה. SOLID + concurrency** — extension via interface (not core change), idempotency, race winners, retry safety

**The final test:** "If I changed the code incorrectly in exactly the way I'm worried about, would this test catch it?" If no → it's not a test, it's documentation.

---

## 7. Browser-based testing — what's there + what's needed

**Currently in repo (`apps/web/e2e/`):**

- `dev-console-clean.spec.ts` — §P0-3 CI guardrail (asserts no console.error during any test)
- `sign-flow.spec.ts` — public signing flow (canvas draw + submit + anti-enum)
- `fixtures.ts` — Playwright fixtures with consoleErrors collector

**Missing — needs Playwright agent (Phase E):**

1. Manager onboarding (signup → create project)
2. Manager — build hierarchy (project → building → apt → owners → ownerships sum=100)
3. Manager — Documents (upload PDF via presigned PUT → list → download)
4. Manager — Signature lifecycle (create request → copy link → cancel)
5. Manager — Import (Excel upload → SSE progress → mapping wizard → completion)
6. Manager — Import errors (bad file → see errors → re-upload)
7. Agent — Assigned-only visibility (sees only assigned projects/tasks)
8. Viewer — Read-only enforcement (no create/edit buttons visible)
9. Cross-tenant no-oracle (Org A user navigates Org B's URL → 404)
10. Provider Admin — Login + MFA + Tenants view + audit row check
11. Provider Admin — Audit search across tenants
12. Auth recovery (locked account → 15min → unlock)
13. Session expiry (token expires → silent refresh → continue)
14. Logout (cookies cleared → /login redirect)
15. Members invite (Manager invites → email → accept → first login)

---

## 8. Refresh commands (run weekly or after any phase merge)

```bash
# BE endpoint inventory
for f in $(find apps/api/src -name "*.controller.ts"); do
  module=$(echo "$f" | sed 's|.*modules/||; s|/.*||')
  echo "▶ $module"
  grep -hE "^\s*@(Get|Post|Put|Patch|Delete|UseGuards|AuthzResource)" "$f"
done

# FE route inventory
find apps/web/src/app -name "page.tsx" | sed "s|apps/web/src/app||; s|/page.tsx||" | sort

# Policy matrix re-verification
pnpm --filter @emapp/api test policy.spec
```

If output diverges from this document → update this document in the same PR as the change.
