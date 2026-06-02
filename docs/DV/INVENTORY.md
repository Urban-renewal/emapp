# DV — INVENTORY (the closed checklist)

> Mechanically extracted from `origin/main @ 9121361` (2026-06-02). The closed
> set of everything DV must cover. **"Covered" = has an artifact bundle** (DV-PLAN
> §6), never "✓". Status legend: ⬜ untouched · 🟩 works · 🟥 broken · 🟧 janky ·
> 🐢 slow. Per-item detail + artifact links live in `results/<interface>.md`.
> Per-element rows (every button/field) are populated during discovery from the
> **component-tree** extraction and validated by the completeness-critic (§7).

---

## Interface 1 — Org `(dashboard)/*` · roles: manager / agent / viewer

> Run each role separately — the same pages render differently (agent = assigned
> projects only; viewer = read-only, no create/edit; manager = full). The diff
> IS the correctness axis.

### Non-page surfaces (apply to every page)

| Surface                       | Per-role expectation                                                                                                                            | Status |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Sidebar nav                   | base: home·projects·owners·imports·documents·signature-requests·notifications·tasks·contractors·notes; **manager-only** +members·audit·settings | ⬜     |
| Org-switcher (Alpha↔Beta)     | switching shows ONLY that org's data (cross-tenant isolation)                                                                                   | ⬜     |
| Modals                        | confirm-archive · reveal-PII (capability-gated) · confirm dialogs                                                                               | ⬜     |
| Toasts / inline errors        | clear Hebrew, no stack leak                                                                                                                     | ⬜     |
| Search / filters / pagination | on every list                                                                                                                                   | ⬜     |
| `<form method="post">`        | every state-changing form (24 forms in repo) — GET-fallback = leak                                                                              | ⬜     |

### Pages × entities

| Entity                | Routes                                                                                          | manager | agent | viewer |
| --------------------- | ----------------------------------------------------------------------------------------------- | ------- | ----- | ------ |
| Dashboard/KPIs        | `/`                                                                                             | ⬜      | ⬜    | ⬜     |
| Projects              | `/projects` · `/[id]` · `/new` · `/[id]/assignments` · `/[id]/buildings(/new)` · `/[id]/shares` | ⬜      | ⬜    | ⬜     |
| Buildings             | `/buildings` · `/[id]` · `/[id]/apartments(/new)`                                               | ⬜      | ⬜    | ⬜     |
| Apartments            | `/apartments` · `/[id]` · `/[id]/ownerships`                                                    | ⬜      | ⬜    | ⬜     |
| Owners (PII + reveal) | `/owners` · `/[id]` · `/new`                                                                    | ⬜      | ⬜    | ⬜     |
| Documents             | `/documents` · `/[id]` · `/new`                                                                 | ⬜      | ⬜    | ⬜     |
| Signature-requests    | `/signature-requests` · `/[id]` · `/new`                                                        | ⬜      | ⬜    | ⬜     |
| Members (staff)       | `/members` · `/[userId]` · `/new`                                                               | ⬜      | n/a   | n/a    |
| Contractors (mgmt)    | `/contractors` · `/[id]` · `/new`                                                               | ⬜      | ⬜    | ⬜     |
| Tasks                 | `/tasks` · `/[id]` · `/new`                                                                     | ⬜      | ⬜    | ⬜     |
| Notes                 | `/notes` · `/[id]` · `/new`                                                                     | ⬜      | ⬜    | ⬜     |
| Notifications         | `/notifications`                                                                                | ⬜      | ⬜    | ⬜     |
| Imports               | `/imports` · `/[id]` · `/[id]/errors` · `/[id]/mapping` · `/new`                                | ⬜      | ⬜    | ⬜     |
| Audit                 | `/audit`                                                                                        | ⬜      | n/a   | n/a    |
| Settings              | `/settings`                                                                                     | ⬜      | n/a   | n/a    |

---

## Interface 2 — Provider `(dashboard)/provider/*` · provider_admin

| Entity                    | Routes / surface                                        | Status |
| ------------------------- | ------------------------------------------------------- | ------ |
| Access-Reason gate (D.37) | blocks every tab until ticket/≥20-char reason           | ⬜     |
| Tenants (customers)       | `/provider/tenants` · `/[id]`                           | ⬜     |
| Suspend / reactivate      | on tenant detail → org goes inert (D.49) + audit        | ⬜     |
| Onboarding                | `/provider/onboard` (create org + first-manager invite) | ⬜     |
| Audit (cross-tenant)      | `/provider/audit`                                       | ⬜     |
| System-health             | `/provider/system-health`                               | ⬜     |

---

## Interface 3 — Resident `(tenant)/portal` · tenant (own-record only)

| Entity               | Surface | Expectation                                    | Status |
| -------------------- | ------- | ---------------------------------------------- | ------ |
| Project progress     | portal  | aggregate %, **never another resident's data** | ⬜     |
| My signatures        | portal  | requests sent to me; sign action               | ⬜     |
| Documents sent to me | portal  | only mine                                      | ⬜     |
| My data              | portal  | own PII **masked** (D.47)                      | ⬜     |

---

## Interface 4 — Contractor `(contractor)/contractor/share/[token]` · read-only

> Precondition: a **manager** generated a share-link (`/projects/[id]/shares`).
> Focus: **urban-renewal-relevant statistics**, NO owner PII.

| Entity               | Expectation                                                                                                       | Status |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- | ------ |
| Project overview     | name/status/type + structural buildings/apartments                                                                | ⬜     |
| Signature statistics | aggregate consent — **and does it surface consent-vs-threshold? per-building? velocity?** (missing-feature check) | ⬜     |
| Shared documents     | project-level only; per-owner agreements excluded; IDOR-safe download                                             | ⬜     |
| PII boundary         | NO national_id / phone / per-resident data anywhere                                                               | ⬜     |

---

## Cross-interface lifecycles (DV-PLAN §10) — synchronization layer

| ID  | Flow                                                                                       | Status |
| --- | ------------------------------------------------------------------------------------------ | ------ |
| L1  | full signature cycle (manager → resident sign → agent/manager sync → contractor aggregate) | ⬜     |
| L2  | import flow (upload → mapping → errors → commit)                                           | ⬜     |
| L3  | ownerships set-replace (sum=100 invariant, D.25)                                           | ⬜     |
| L4  | provider cross-tenant suspend/reactivate (audited)                                         | ⬜     |

## State matrix (per key screen) — DV-PLAN §9

| State               | Screens to check                                                      | Status |
| ------------------- | --------------------------------------------------------------------- | ------ |
| empty               | projects / owners / documents / tasks (and agent with no assignments) | ⬜     |
| loading             | skeleton vs text-only (UX-2)                                          | ⬜     |
| error               | 500 / 403 / 404 / network-down → graceful message                     | ⬜     |
| large list          | pagination + perf at volume                                           | ⬜     |
| RTL / Hebrew / date | layout + Asia-Jerusalem display                                       | ⬜     |

## Behavioral (beyond the screen) — DV-PLAN §11

| Check                                                                       | Status |
| --------------------------------------------------------------------------- | ------ |
| Audit rows: reveal-PII · provider-access · suspend · share-mint · signature | ⬜     |
| Notifications generated for the right party (cross-interface)               | ⬜     |
| Exported xlsx/PDF opened + viewed (masked PII, no formula injection)        | ⬜     |
| Email/SMS payloads read from Noop log                                       | ⬜     |

## Reconciliation (completeness gate) — DV-PLAN §7

| Check                                                                     | Status |
| ------------------------------------------------------------------------- | ------ |
| Every FE route visited (0 unvisited)                                      | ⬜     |
| Every API endpoint hit by ≥1 UI action OR marked not-user-reachable       | ⬜     |
| Completeness-critic: 0 items without artifact, 0 code-paths without a row | ⬜     |
