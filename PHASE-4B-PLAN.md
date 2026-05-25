# Phase 4b — Provider Admin FE plan

**Created:** 2026-05-25
**Branch:** `phase-4b-provider-fe` (forked off `phase-4a-fe` after Phase 4a CI green)
**Depends on:** Phase 6.5 Provider Admin BE (merged via PR #40 + #41 — `provider.ts` shared-types present)
**Blockers cleared:** H1 (Provider FE topology) resolved — see §Topology below.

## §Topology — closes H1 (BE D.36 audit)

**Decision: same-domain at `/provider/*` routes; separate cookies.**

| Aspect          | Org tier (existing)                           | Provider tier (Phase 4b)                                        |
| --------------- | --------------------------------------------- | --------------------------------------------------------------- |
| Domain          | `app.emapp.io`                                | `app.emapp.io` (SAME)                                           |
| Login route     | `/[locale]/login`                             | `/provider/login` (no locale — EN-only MVP)                     |
| Dashboard       | `/[locale]/*`                                 | `/provider/*`                                                   |
| Access cookie   | `access_token` (path `/`)                     | `provider_access_token` (path `/`)                              |
| Refresh cookie  | `refresh_token` (path `/api/v1/auth/refresh`) | `provider_refresh_token` (path `/api/v1/provider/auth/refresh`) |
| BE prefix       | `/api/v1/*`                                   | `/api/v1/provider/*`                                            |
| Audience claim  | `emapp-api`                                   | `emapp-provider`                                                |
| Reverse proxy   | Pages Function (D.35) — REUSED                | Pages Function (D.35) — REUSED                                  |
| Middleware gate | checks `access_token`                         | checks `provider_access_token` for `/provider/*` paths          |

**Rationale:**

- The BE shipped cookies hostOnly (no `Domain=`); same-origin proxy preserves them. No subdomain needed.
- Separate cookie NAMES + separate refresh PATHS means an org-tier session and a provider-tier session can coexist in the same browser without confusion. The middleware just routes by URL prefix.
- Reusing the same Pages Function reverse-proxy means zero infra change. The proxy already strips `Host`/`Forwarded`/`cf-*` headers correctly per D.35.
- EN-only for Provider Admin MVP: this surface is internal-staff-only, all Israeli; we don't need next-intl on `/provider/*` (saves a `[locale]` segment). HE can be added in a future polish slice.

**Will write D.NN entry in `docs/DECISIONS.html` before any controller-touching code lands.** Suggested D.38 number.

## Slice plan (S1-S6, mirrors Phase 4a structure)

### S0 — adapters + VMs + API client + topology doc (no UI)

- `apps/web/src/models/tenant.vm.ts` — VM for tenant list/detail
- `apps/web/src/adapters/tenant.ts` — Wire → VM (counts, sample owners)
- `apps/web/src/models/provider-audit.vm.ts` + adapter
- `apps/web/src/models/system-health.vm.ts` + adapter
- `apps/web/src/lib/api/provider.ts` — API client wrapper. KEY: `access_reason` header is mandatory (400 `reason_required` if missing). Wrap with `apiClient.get` + custom header.
- D.38 entry drafted in `docs/DECISIONS.html`

### S1 — provider auth shell

- `/provider/login` page (separate from `/[locale]/login`)
- `lib/provider-auth.ts` — Server Action mirror of `lib/auth.ts`, reads `provider_access_token` cookie
- Middleware extension: `/provider/*` paths require `provider_access_token`; missing → `/provider/login`. `/provider/*` is OUTSIDE next-intl middleware (EN-only).
- Topbar with "ProviderAdmin" badge + logout

### S2 — Tenants list

- `/provider/tenants` page — list + cursor pagination
- "Access reason" prompt at every navigation (modal) — `withProvider` audit logs the reason
- Empty state, error retry, count chips
- MSW handlers + SAMPLE_TENANTS

### S3 — Tenant detail

- `/provider/tenants/[id]` page
- 5 sample owners (masked PII only — `NameDisplay` for `nameMasked`, `dir=ltr` for `phoneMasked`)
- "Why are you accessing this?" prompt enforces D.37 audit reason
- `national_id` NEVER on wire — verified by a key-allowlist spec

### S4 — Cross-tenant audit search

- `/provider/audit` page with filters: orgId, action prefix, date range
- Reuse `<NameDisplay>` for action/target text
- Cursor pagination

### S5 — System health dashboard

- `/provider/health` page
- Gauges for queue (created/active/retry/failed/completed), pool stats (app + provider), R2 error counter
- Auto-refresh every 30s (live operations surface)

### S6 — E2E + audit closure + PR

- Playwright happy-path tests (4-axis browser smoke on `/provider/login`)
- 4-agent fresh-eyes audit
- Close findings, open PR

## Anti-pattern reminders (from Phase 4a learnings)

| Pattern                                  | Phase 4a closure  | Apply to Phase 4b                                                                                                                             |
| ---------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `<form>` without `method="post"`         | §S1-SEC1 closure  | Every Phase 4b form gets `method="post"` from S1; the static check at `apps/web/src/app-forms-no-get-fallback.spec.ts` already enforces this. |
| `z.string().url()` accepts `javascript:` | §RED-1 closure    | Phase 4b URL fields use `HttpsUrlSchema` from `safe-url.ts`.                                                                                  |
| Raw wire render of names                 | §RED-2 closure    | Every Phase 4b name render goes through `<NameDisplay>`. Tenant slugs / actions / target tables that originate from user data → wrap.         |
| MSW shipping in prod                     | §RED-3 closure    | `next.config.ts` already enforces; nothing additional needed.                                                                                 |
| Sentry PII leak                          | §RED-4 closure    | If Provider Admin gets its own Sentry scope, mirror the `beforeSend` scrub for `provider_access_token` URL paths.                             |
| Adapter pattern bypass                   | §SOLID-H1 closure | Every Phase 4b page consumes VMs only — no raw wire shape destructuring.                                                                      |
| Browser smoke gap                        | §S1-VG1 closure   | Per `docs/DOD-BROWSER-SMOKE.md`, every Phase 4b interactive slice gets the 4-axis manual OR same-slice Playwright.                            |

## Provider-tier-specific deltas vs Phase 4a

| Concern                | Org tier               | Provider tier                                                             |
| ---------------------- | ---------------------- | ------------------------------------------------------------------------- |
| `access_reason` header | not required           | MANDATORY on every GET (BE 400 `reason_required` otherwise)               |
| Audit row written      | only on writes         | EVERY read (D.37 + Gate-6)                                                |
| Cookie name            | `access_token`         | `provider_access_token`                                                   |
| JWT audience           | `emapp-api`            | `emapp-provider`                                                          |
| Refresh endpoint       | `/api/v1/auth/refresh` | `/api/v1/provider/auth/refresh`                                           |
| MFA                    | Manager has MFA        | Provider Admin has MANDATORY MFA (TOTP)                                   |
| Bootstrap              | self-signup            | provider-only invite OR manual psql (H3 from D.36 audit — needs a script) |

## What's NOT in Phase 4b scope

- Tenant impersonation (write surface — Gate-6 blocked, future phase only after explicit decision)
- Provider Admin user creation FE (H3 audit gap — needs bootstrap script, not FE form)
- PII unmask flag (no FE control to unmask — would require Gate-6)
- Tenant archive / restore from Provider tier (write surface)
- Cross-tenant CSV export (likely future Phase 7 polish)

## Verification checklist

Before opening the Phase 4b PR:

- [ ] CI 9/9 green (test, typecheck, lint, build, conformance, e2e, secrets-scan, audit, setup)
- [ ] All 4 axes Playwright-tested on `/provider/login` AND `/provider/tenants/[id]` (per DoD-BROWSER-SMOKE)
- [ ] PII key-allowlist spec on every VM (no `nationalId`, `phone`, `email` in clear)
- [ ] `app-forms-no-get-fallback.spec.ts` still green (provider login form has `method="post"`)
- [ ] Provider tier isolation: a manager JWT must 401 against `/api/v1/provider/*` (BE already enforces; FE just doesn't send wrong cookie)
- [ ] 4-agent fresh-eyes audit run with NO P0 / NO HIGH outstanding
- [ ] D.38 topology decision merged before any provider auth code lands
