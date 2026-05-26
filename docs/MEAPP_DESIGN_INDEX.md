# MEAPP Design — File Index

> Map of the partner's `MEAPP_design/` folder. **MVP-relevant only** files are required reading. Skip the rest until needed.
> Source of truth: `MEAPP_design/design_handoff/source/` is the official handoff; root-level files are the partner's extended canvas (more screens, more variations).

---

## Required reading for V11 (≤2 hours)

1. **`MEAPP_design/design_handoff/README.md`** — partner's overview, screens, RTL rules, design tokens, component library names
2. **`MEAPP_design/design_handoff/source/tokens.css`** — the entire design system (port to `tailwind.config.ts`)
3. **`MEAPP_design/design_handoff/source/shell.jsx`** — Sidebar + TopBar + AppShell layout pattern
4. **`MEAPP_design/EMAPP.html`** — root file routing all screens (see what's wired to what)
5. **`MEAPP_design/data.jsx`** — sample data shapes (especially `BUILDINGS_P7` + `TENANTS_P7` for sections + unit_types model)

---

## Path convention — which copy is authoritative

The folder has **two** copies of several files (`screens-manager.jsx`, `shell.jsx`) at different paths:

- **`MEAPP_design/design_handoff/source/<file>`** — the **trimmed, frozen handoff**. Authoritative for visual + interaction reference. Use this when both exist.
- **`MEAPP_design/<file>`** at the root — the partner's **working file**, larger, often includes experiments, in-progress variants, and screens not in MVP. Read **only** when the handoff copy is missing the function/screen you need (e.g. WeekCalendar is in root `screens-manager.jsx` only, not in handoff).

Below, every row marks which path applies. If both are listed, the handoff path is canonical and the root path is supplementary.

## Track A files (Design Re-skin) — read per slice

| Slice                  | Files in `MEAPP_design/`                                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A.S1 Login             | **`design_handoff/source/screens-manager.jsx`** (16KB — LoginScreen, canonical) · `tokens.css` · `design_handoff/screenshots/01-login.png`                                                           |
| A.S2 Shell             | **`design_handoff/source/shell.jsx`** (canonical) · `shell.jsx` (root, 25KB — reference only for any extra NotificationsPanel detail handoff lacks)                                                  |
| A.S3 ManagerHome       | **`design_handoff/source/screens-manager.jsx`** (ManagerHome if present) · `screens-manager.jsx` (root, 46KB — fall back here if handoff lacks it) · `dashboard-cards.jsx` (KPI variants, root only) |
| A.S4 ProjectsList      | `screens-projects.jsx` (root, 147KB) — ProjectsList function                                                                                                                                         |
| A.S5 ProjectPage       | `screens-projects.jsx` — ProjectPage function · `project-tasks-tab.jsx` · `project-dashboard.jsx`                                                                                                    |
| A.S6 AddProject wizard | `screens-add-project.jsx` (38KB — the wizard) · `screens-modals.jsx` (root, 44KB) — ModalShell, AddProjectModal, AddAddressModal                                                                     |
| A.S7 TenantPanel       | `screens-projects.jsx` — TenantPanel function                                                                                                                                                        |
| A.S8 DocsPage          | `screens-team.jsx` (root) — DocsPage function (yes, named that despite filename)                                                                                                                     |
| A.S9 TeamPage          | `screens-team.jsx` (root, 38KB) — TeamPage · AgentProfile                                                                                                                                            |
| A.S10 SettingsPage     | `screens-settings.jsx` (41KB)                                                                                                                                                                        |
| A.S11 Notifications    | `shell.jsx` — NotificationsPanel + ManagerNotificationsPage (already in shell)                                                                                                                       |
| A.S12 WeekCalendar     | `screens-manager.jsx` (root only — WeekCalendar is NOT in the handoff trim) · `calendar-variations.jsx` (root, 5 variants) · `expanded-calendar-modal.jsx` (root)                                    |
| A.S13 Platform Console | `org-admin.jsx` (82KB) — PCSidebar + PCTopBar · `org-admin-tabs.jsx` (Org Detail tabs) · `org-admin-data.jsx` (sample data) · `org-admin-screens-ext.jsx`                                            |
| A.S14 Tenant Portal    | `screens-tenant.jsx` (47KB) — TenantPortal · TenantNav · TenantHero · ApartmentPanel · DocumentsSection                                                                                              |
| A.S15 Export FE        | (no specific design file — use existing button patterns + toast from shadcn)                                                                                                                         |

---

## Track B files (BE Specialist) — read per slice

| Slice                             | Files in `MEAPP_design/`                                                                                                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B.S1 sections+unit_type migration | `data.jsx` (shapes: BUILDINGS_P7, TENANTS_P7 with sections + unitType) · `EMAPP - Spec for Backend.html` (partner's BE spec, find "section" + "Apartment" sections) |
| B.S2 project create service       | `screens-add-project.jsx` (the wizard's data flow shows what BE consumes)                                                                                           |
| B.S3 tenant_portal tables         | `screens-tenant.jsx` (what tenant sees → what BE projects out) · `EMAPP - Spec for Backend.html` (find "TenantPortal" section)                                      |
| B.S4 portal endpoints             | `screens-tenant.jsx` (data shape per section: hero, apartment, documents, signatures)                                                                               |
| B.S5 tasks-extended migration     | `data.jsx` (TASKS shape: day/hour/duration/agentId/type) · `screens-manager.jsx` (WeekCalendar consumption)                                                         |
| B.S6 Calendar + ICS               | (no design file — RFC 5545 + ical-generator npm)                                                                                                                    |
| B.S7 Resend ICS email             | (no design file — existing Resend integration in apps/api)                                                                                                          |
| B.S8 Export Excel                 | (no design file — use existing xlsx generation pattern if any; otherwise greenfield)                                                                                |
| B.S9 Export PDF                   | (no design file — puppeteer + Heebo font from existing FE setup)                                                                                                    |
| B.S10 Export endpoints            | (no design file — endpoint conventions from existing controllers)                                                                                                   |

---

## NOT in MVP (skip until partner ships)

These files are part of the partner's full canvas but **outside V11 MVP scope**. Don't read unless explicitly building for them.

| File                                                                                                                                                                                                                                                              | Why it's deferred                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `screens-mobile.jsx` (root + handoff) — MobileAgentHome, MobileFieldTask, MobileApartmentForm                                                                                                                                                                     | Mobile agent shell — Phase 2 of product                                   |
| `agent-screens.jsx`, `agent-screens-2.jsx`, `agent-shell.jsx`, `screens-agent.jsx`, `screens-agent-tasks-chat.jsx`, `screens-agent-field.jsx`, `screens-agent-projects.jsx`, `screens-agent-tenant.jsx`, `screens-agent-calendar.jsx`, `screens-agent-modals.jsx` | Agent desktop+mobile surface — Phase 2                                    |
| `screens-contractor.jsx` (94KB)                                                                                                                                                                                                                                   | Contractor portal (Tier 2) — BE shares exist, FE deferred                 |
| `conversation-drawer.jsx`, `floating-chat-button.jsx`                                                                                                                                                                                                             | Chat/conversations — Phase 2 (docs/03 §1.2)                               |
| `dashboard-drilldown.jsx`                                                                                                                                                                                                                                         | Manager Dashboard with 4 drill-downs — Phase 2                            |
| `personal-tasks.jsx`                                                                                                                                                                                                                                              | Personal tasks drawer — Phase 2                                           |
| `screens-tenants.jsx` (78KB) — tenant questions inbox / portal config                                                                                                                                                                                             | Phase 2 (D.40 explicitly out of scope)                                    |
| `screens-tenants-directory.jsx`                                                                                                                                                                                                                                   | Phase 2                                                                   |
| `login-illustrations.jsx`, `login-promo-reel.jsx`                                                                                                                                                                                                                 | Login illustrations — Phase 8 polish                                      |
| `tweaks-panel.jsx`                                                                                                                                                                                                                                                | Dev-only runtime tweaks panel — never ship                                |
| `ios-frame.jsx`                                                                                                                                                                                                                                                   | iOS device preview frame — design-only, never ship                        |
| `mock-ui.jsx`                                                                                                                                                                                                                                                     | Mock UI host for design previews — design-only                            |
| `design-canvas.jsx`                                                                                                                                                                                                                                               | Design canvas for the partner's own use — never ship                      |
| `unit-edit-drawer.jsx`, `screens-unit.jsx`                                                                                                                                                                                                                        | Apartment edit drawer — may overlap with TenantPanel; reference if needed |
| `lifecycle.jsx`, `status-picker.jsx`                                                                                                                                                                                                                              | UI primitives — pull patterns ad-hoc if needed                            |
| `screens-manager-v2.jsx`                                                                                                                                                                                                                                          | Alt ManagerHome — only if A.S3 variant chosen                             |
| `projects-overview.jsx`                                                                                                                                                                                                                                           | Alt ProjectsList — only if A.S4 variant chosen                            |
| `screens-share.jsx`                                                                                                                                                                                                                                               | Share-with-contractor modal — Phase 2                                     |
| `org-admin-data-ext.jsx`, `org-admin-actions.jsx`                                                                                                                                                                                                                 | Platform Console extras — Phase 2                                         |
| `screens-add-project.jsx` (38KB)                                                                                                                                                                                                                                  | Already listed for A.S6 above — this is the wizard, in scope              |

---

## Spec documents

| File                                       | What it is                                                                                        | When to read                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `EMAPP - Spec for Backend.html` (183KB)    | Partner's BE spec v0.2 (multi-tenancy, roles, permissions, data model, API contract, JSON shapes) | BE Specialist: per-slice grep for the relevant feature. Don't read end-to-end. |
| `ORG Admin - Spec for Partner.html` (86KB) | Partner's spec for the Platform Console (Tier 3)                                                  | Track A.S13 only                                                               |
| `ORG Admin (standalone).html` (1.4MB)      | Full standalone preview render                                                                    | Reference only — open in browser to see live                                   |
| `Sketch - Project Page.html`               | Single-page sketch of ProjectPage                                                                 | Reference for A.S5                                                             |
| `calendar-variations.html`                 | Calendar variants preview                                                                         | Reference for A.S12                                                            |

---

## Uploads folder

`MEAPP_design/uploads/` contains pasted screenshots (PNGs) and reference docs (PDFs, Excel, Docx). These are **input data** the partner used — not design output. Mostly useful when debugging "what did the partner mean by X" — open the latest screenshots only when needed.

---

## How to use this index

1. **Start of V11:** read the 5 "required" files above (~2 hours).
2. **Per slice:** before writing code, read only the files in your slice's row in the table above.
3. **When unsure if a file is relevant:** check this index first. If marked "NOT in MVP" → don't read.
4. **When the partner ships an updated design:** re-generate this index (it's based on the snapshot at 2026-05-26).

---

**Lesson learned:** Reading all 50 jsx files takes a day and burns context. This index turns it into 2 hours of targeted reading.
