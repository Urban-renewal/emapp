# Provider Admin Console — Capability Inventory & Gap Analysis

**Date:** 2026-06-18
**Scope:** Tier 3 Provider Admin (cross-tenant platform operator) — backend surface (`apps/api/src/modules/provider/**` + `apps/api/src/modules/auth/provider/**`) and frontend (`apps/web/src/app/[locale]/(dashboard)/provider/**`).
**Method:** READ-ONLY code audit. Every claim cites a file.
**Question asked by the owner:** *"If I were the Provider Admin, could I actually MANAGE the platform with this interface?"*

**TL;DR verdict (full version at the bottom):** It is **not a thin shell — it is a real, well-built, but deliberately narrow console.** Eight pages are genuinely wired to audited backend endpoints. But the surface is ~80% **read/observe** and ~20% **act**, and the actions that exist are exactly **three**: create a tenant, suspend a tenant, reactivate a tenant. **Every single "manage a human" support task — reset a locked-out manager, reset MFA, resend an invite, deactivate a user, impersonate to reproduce a bug — does not exist at any layer.** The owner's suspicion is correct *in spirit*: the buttons that exist work, but the toolkit is missing the entire account-recovery and team-management half of an operator console. The 7 padlocked sidebar items are honestly-labelled future work, not broken wiring.

---

## 1. Backend provider surface — every endpoint

Nine controllers register routes under `/api/v1/provider/*`. All domain endpoints are gated by the two-layer `ProviderAuthGuard` + `ProviderAuthorizationGuard`, carry a mandatory `@AccessReason` header, and write a forensic `provider_audit_log` row via `withProvider(...)`.

| # | Method + Path | Read/Mutate | Real capability | File |
|---|---|---|---|---|
| 1 | `POST /provider/auth/login` | mutate (session) | Provider login — **password + mandatory TOTP** (`mfa_code`). MFA enforced at the service. | `auth/provider/provider-auth.controller.ts:34`; `auth/provider/provider-auth.service.ts:86-105` |
| 2 | `POST /provider/auth/refresh` | mutate (session) | Rotate provider access/refresh tokens. | `provider-auth.controller.ts:49` |
| 3 | `POST /provider/auth/logout` | mutate (session) | Revoke provider session. | `provider-auth.controller.ts:63` |
| 4 | `GET /provider/me` | **read** | Self-identity (id/email/name/role). Gates the FE `/provider/*` subtree. | `auth/provider/provider-me.controller.ts:50`; service `getProfile` at `provider-auth.service.ts:448` |
| 5 | `GET /provider/tenants` | **read** | List all orgs (cross-tenant), cursor-paginated, with counts + suspended/archived flags + name search. **No PII.** | `provider/provider-tenants.controller.ts:49` |
| 6 | `GET /provider/tenants/:id` | **read** | Single org detail: 5 counts (users/projects/owners/importJobs/signatureRequests) + ≤5 **PII-masked** sample owners. | `provider/provider-tenant-detail.controller.ts:43`; service masks name/phone in-SQL, omits national_id entirely (`provider-tenant-detail.service.ts:120-134`) |
| 7 | `GET /provider/tenants/:id/users` | **read** | List an org's members (masked name/email, role, status invited/active/revoked, last-login). **READ-ONLY by design** (Gate-6 note in file). | `provider/provider-tenant-users.controller.ts:59` |
| 8 | `POST /provider/tenants` | **mutate** | **Onboard:** create Org + first Manager (OWNER role assignment) + send invite email. The only "create" verb in the console. | `provider/provider-onboarding.controller.ts:39`; `provider-onboarding.service.ts:60` |
| 9 | `POST /provider/tenants/:id/suspend` | **mutate** | **Suspend tenant** — freeze org, revoke ALL org + tenant sessions in the same audited tx. Reversible. | `provider/provider-tenant-suspension.controller.ts:56`; service `provider-tenant-suspension.service.ts:46` |
| 10 | `POST /provider/tenants/:id/reactivate` | **mutate** | **Reactivate tenant** — clear suspension flag (does NOT un-revoke sessions; re-login required). | `provider-tenant-suspension.controller.ts:69` |
| 11 | `GET /provider/audit` | **read** | Cross-tenant search of customers' `audit_log` (orgId / action prefix / date range, cursor). SA-4: must scope by orgId or ≤31-day window. | `provider/provider-audit.controller.ts:42` |
| 12 | `GET /provider/audit/self` | **read** | The provider team's OWN action log (`provider_audit_log`) — "who on our team accessed customer X, when, why". | `provider-audit.controller.ts:57` |
| 13 | `GET /provider/system-health` | **read** | Gauges: pg-boss queue counts, DB pool stats (app+provider), R2 error counter. 30s cache. **No actions.** | `provider/provider-system-health.controller.ts:33`; service `provider-system-health.service.ts:101` |

**Backend mutation surface, in total: exactly 3 domain actions** — onboard tenant, suspend tenant, reactivate tenant (`provider.module.ts:57` comment confirms: "4 read (D.37) + 1 write surface (D.49)"). Everything else is read.

**No backend controller exists for:** backups/restore, provider-team (staff) management, plans/billing, tenant user account recovery, impersonation, cross-tenant user/owner search, or tenant plan/quota changes. (Confirmed: `provider_users` is referenced only in the auth path — `provider-auth.service.ts`, `provider-me.controller.ts` — there is no CRUD controller for it.)

---

## 2. Frontend provider pages — what each exposes & whether it's wired

Pages live under `apps/web/src/app/[locale]/(dashboard)/provider/`. The whole subtree is guarded by `layout.tsx` (tier check + `AccessReasonGate` — the operator must type an investigation reason per tab before anything renders).

| Page | Route | Shows | Buttons / actions | Wired? |
|---|---|---|---|---|
| Dashboard home | `/provider` (`page.tsx`) | One overall health badge (ok/warn/crit) + 3 quick-link buttons | Links to tenants/audit/system-health | Wired (reads `GET /provider/system-health`). **Note: shows ONE health dot — no platform metrics** (no active-tenant count, growth, usage). |
| Tenants list | `/provider/tenants` (`tenants/page.tsx`) | Org list, counts, suspended/archived badges, name search | "Create tenant" link → onboard; rows link to detail/users | Wired (`GET /provider/tenants`). |
| Tenant detail | `/provider/tenants/[id]` (`[id]/page.tsx`) | Counts grid + masked sample owners + suspension panel | **Suspend / Reactivate** (real writes), "view users", "view audit" links | Wired. The only place with real per-tenant actions. |
| Tenant users | `/provider/tenants/[id]/users` | Masked members, role, status, last-login | **None — READ-ONLY** (file docstring: "no member actions … Gate-6") | Wired read; **zero action buttons**. |
| Onboard | `/provider/onboard` (`onboard/page.tsx`) | Create-org form (orgName/managerName/managerEmail) | **Submit** → creates org + invites manager; one-shot invite token shown in dev | Wired (`POST /provider/tenants`). |
| Audit (cross-tenant) | `/provider/audit` (`audit/page.tsx`) | Customer audit_log search w/ filters | Search / reset (read only) | Wired (`GET /provider/audit`). |
| Self-audit | `/provider/audit/self` | Provider team's own action log | Read only | Wired (`GET /provider/audit/self`). |
| System health | `/provider/system-health` (`system-health/page.tsx`) | Queue/pool/R2 gauges | **Refresh** (re-fetch only) | Wired read. File: "No interactive controls — pure read view." **Status readout only — no alert→action path.** |
| Backups | `/provider/backups` (`backups/page.tsx`) | **Static documented posture** (Neon PITR, RTO/RPO constants, runbook path) | **None** | **NOT a backend call.** File docstring: "no backend call and no new infra … we do not pretend to have data we don't." **Restore is NOT wired — it's a documentation page.** |

### The sidebar — 8 wired, 7 padlocked stubs

`apps/web/src/app/[locale]/(dashboard)/_components/pc-sidebar.tsx:99-121` defines 14 nav items. Stubs render as non-focusable `<span aria-disabled>` with a 🔒 Lock icon and a "planned" tooltip (`stubHint`):

| Item | Group | Status |
|---|---|---|
| overview, orgs, users, health, backups, audit, selfAudit | overview/ops | **Wired** (8 incl. users→tenants?view=users) |
| **plans** (תוכניות ומחירון) | biz | 🔒 stub, `href: null` |
| **billing** (חיובים ומנויים) | biz | 🔒 stub |
| **support** (תמיכה ופניות) | biz | 🔒 stub |
| **roles** (תפקידים והרשאות) | ops | 🔒 stub |
| **integrations** (אינטגרציות) | ops | 🔒 stub |
| **staff** (צוות EMAPP — provider team) | admin | 🔒 stub |
| **settings** (הגדרות פלטפורמה) | admin | 🔒 stub |

These 7 are **honest placeholders**, not broken buttons. They are non-clickable, visually dimmed, and labelled as future. (The owner's "some inactive buttons" instinct = these 7 padlocks — intentional, not bugs.)

---

## 3. Capability matrix (operator toolkit vs. reality)

| Capability | BE endpoint? | FE surface? | Wired & working? | Read-only or actionable? |
|---|---|---|---|---|
| List tenants (cross-tenant) | ✅ `GET /tenants` | ✅ tenants list | ✅ | read |
| Tenant detail + counts | ✅ `GET /tenants/:id` | ✅ detail | ✅ | read |
| **Create tenant + invite admin** | ✅ `POST /tenants` | ✅ onboard | ✅ | **actionable** |
| **Suspend tenant** | ✅ `POST /:id/suspend` | ✅ panel | ✅ | **actionable** |
| **Reactivate tenant** | ✅ `POST /:id/reactivate` | ✅ panel | ✅ | **actionable** |
| Offboard / delete / purge tenant | ❌ (explicitly out of scope, D.49) | ❌ | ❌ | — |
| Change tenant plan / quotas / limits | ❌ | 🔒 stub (plans) | ❌ | — |
| Tenant notes / flags | ⚠️ partial (`suspended_reason` only) | ⚠️ suspend note | ⚠️ | actionable, but only as a suspend side-effect |
| List a tenant's users | ✅ `GET /:id/users` | ✅ users page | ✅ | **read only** |
| **Reset / unlock a tenant user** | ❌ | ❌ | ❌ | — |
| **Reset a user's MFA** | ❌ | ❌ | ❌ | — |
| **Force password reset** | ❌ | ❌ | ❌ | — |
| **Resend invite** | ❌ | ❌ | ❌ | — |
| **Deactivate a tenant user** | ❌ | ❌ | ❌ | — |
| Support impersonation / "view as tenant" | ❌ | ❌ | ❌ | — |
| Cross-tenant user/owner/org search | ⚠️ org-name search only | ⚠️ tenants search box | ⚠️ | read; no user/owner search |
| Cross-tenant audit search | ✅ `GET /audit` | ✅ audit page | ✅ | read |
| Provider self-audit | ✅ `GET /audit/self` | ✅ self page | ✅ | read |
| **Provider team mgmt (invite/list/disable admins)** | ❌ | 🔒 stub (staff) | ❌ | — |
| **Provider MFA enrol / reset** | ❌ (TOTP seeded directly in DB) | ❌ | ❌ | — |
| Plans / pricing | ❌ | 🔒 stub | ❌ | — |
| Billing / subscriptions | ❌ | 🔒 stub | ❌ | — |
| Support ticketing | ❌ | 🔒 stub | ❌ | — |
| System health gauges | ✅ `GET /system-health` | ✅ health page | ✅ | **read only** (no alert→action) |
| Backups posture | ❌ (no endpoint) | ✅ static doc page | ✅ (static) | read only (docs) |
| **Restore from backup** | ❌ | ❌ (runbook pointer only) | ❌ | — |
| Platform usage / growth metrics | ❌ | ❌ (one health dot only) | ❌ | — |

---

## 4. What a Provider Admin CAN do today

- **Log in securely** with password + mandatory TOTP MFA (`provider-auth.service.ts`).
- **See the whole customer base**: list every org with counts, search by org name, drill into per-org counts and a few masked sample owners.
- **Onboard a new customer end-to-end**: create the org and email the first manager an invite (the manager sets their own password — provider never sees it).
- **Suspend a misbehaving / non-paying tenant** (instantly freezes all org + resident sessions) and **reactivate** it later.
- **Investigate**: cross-tenant audit search over customer activity, plus the provider team's own access log ("who looked at customer X and why") — every provider action is itself audited and gated behind a typed access-reason.
- **Read operational health**: queue depth, DB pool saturation, R2 errors; refresh on demand.
- **Read the backup/DR posture** (documented Neon PITR, RTO/RPO, runbook link).

## 4b. What a Provider Admin CANNOT do today

- **Help a locked-out customer** in any way: cannot reset/unlock a user, reset their MFA, force a password reset, resend an invite, or deactivate a user. The users page is **look-but-don't-touch**. This is the **#1 real support task and it is entirely absent.**
- **Reproduce a customer bug**: no impersonation / "view as tenant" read-only access exists.
- **Find a person across tenants**: search is org-name only; you cannot look up a user/owner by email/phone/national_id across the platform.
- **Off-board / delete a tenant**: suspend is reversible-only; no purge/offboard (explicitly deferred, D.49).
- **Change a plan, quota, or limit** (no billing/plans concept exists at all).
- **Manage the provider team**: cannot invite another provider admin, list them, disable one, or reset a provider admin's MFA from the console. New provider admins + their TOTP secrets are seeded **directly into the DB** (no enrolment flow — `provider-auth.service.ts` only *verifies* `mfaSecretEncrypted`).
- **Act on a health alert**: system-health is a gauge readout; there is no "drain queue", "kill connection", "retry failed jobs" action.
- **Restore a backup** from the console: the backups page is documentation; restore lives in a runbook, not a button.
- **See platform business metrics**: the dashboard shows a single health dot — no active-tenant count, signups/growth trend, or per-tenant usage.

---

## 5. Prioritized gap list

### P0 — operator-critical (you will hit these in week one of running the platform)
1. **Tenant user account recovery.** No reset/unlock, no MFA reset, no force-password-reset, no resend-invite, no deactivate. When a customer's only manager loses their MFA device or gets locked out, the Provider Admin currently **cannot fix it through any UI or API** — only a direct DB intervention. This is the single biggest gap. (Today: users page is read-only — `provider-tenant-users.controller.ts`, `[id]/users/page.tsx`.)
2. **Provider team management + provider MFA reset.** Adding/removing a colleague provider admin, or resetting one's MFA, requires manual DB seeding (`provider_users` has no controller). For a tier whose CLAUDE.md mandate is "MFA mandatory, audited," the absence of a self-service enrol/reset flow is an operational hole. (Sidebar "staff" is a 🔒 stub.)
3. **Cross-tenant user/owner search.** Support starts with "a user emailed us" — there is no way to find which org they belong to. Only org-name search exists.

### P1 — strongly needed for real operations
4. **Support impersonation / read-only "view as tenant."** Required to reproduce and diagnose customer-reported bugs without asking for screenshots.
5. **Tenant offboarding** (controlled delete/export-then-purge). Suspend is not a lifecycle end-state; customers do churn.
6. **Actionable system health.** At minimum a "retry failed jobs" / queue drain affordance; today failed-job counts are visible but un-actionable.
7. **Platform metrics dashboard.** Active tenants, new-signups trend, per-tenant usage — the home page currently surfaces one health dot only.

### P2 — nice-to-have / explicitly-deferred future surface
8. Plans / pricing / quotas (🔒 stub — intentional future).
9. Billing / subscriptions (🔒 stub).
10. Support ticketing (🔒 stub).
11. Roles & integrations management (🔒 stubs).
12. Self-service **backup restore** trigger (today: runbook-only; reasonable to keep manual given blast radius).
13. Tenant notes/flags as first-class fields (today only a suspend-time `suspended_reason`).

---

## 6. Honest verdict

**Could a Provider Admin actually run the platform with this today? Partially — they can *onboard and observe*, but they cannot *support*.** What exists is genuinely built, audited, and secure: real cross-tenant visibility, a working onboarding flow, a working suspend/reactivate kill-switch, and a strong forensic-audit spine where every provider action is reason-gated and logged. The buttons that are present are wired and work; the 7 padlocked sidebar items are honest "coming later" placeholders, not dead wiring. **But the console is built around *watching and gatekeeping tenants*, not *operating on the humans inside them*.** The entire account-recovery toolkit — the daily bread of any SaaS operator (unlock a user, reset MFA, resend an invite, impersonate to reproduce a bug, find a person across tenants) — is missing at every layer, and the provider team itself is managed by hand-editing the database. So: not a thin shell, but a **half-built console** — the "platform governance" half is real and solid; the "customer support / account operations" half does not yet exist. Until at least the P0 items land, the first real lockout support ticket will require a developer with DB access, not the Provider Admin.
