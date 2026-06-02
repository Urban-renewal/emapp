# DV results — Org / manager — full coverage (2026-06-02)

> Investigator ran `dv-org-manager.spec.ts` (Playwright headless) and captured
> **40 manager pages** → screenshots in `artifacts/org-manager-*.png` + structured
> evidence in `artifacts/org-manager-evidence.json` (per page: status, apiCalls+ms,
> consoleErrors, pageErrors, failed4xx5xx, bodyText, form methods). The agent
> CRASHED before synthesizing (root cause: my prompt told it to Read all 40 PNGs
> into one context → overflow; fixed for the next run). This is the synthesis,
> derived from the intact evidence.json. Driving was ~complete.

## Health signals (good)

- **0 console errors, 0 page errors, 0 failed 4xx/5xx** across all 40 pages.
- **0 GET-fallback forms** — no `<form>` missing `method="post"` (the CLAUDE.md DoD holds; most pages are client-handled, formCount 0).

## Findings

| ID       | Sev                         | Page(s)                                                            | Finding                                                                                                                                                                                                                                                                                                          | Evidence                                              |
| -------- | --------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| DV-ORG-1 | LOW (UX-3) — **widespread** | dashboard, projects, buildings, apartments, owner-detail, settings | Internal slice/phase jargon + dev placeholders leak to production UI: "**...יתחברו לאחר העשרת ה-API**", "**A.S12 (Calendar + ICS)**", "**(Phase 2)**", "ערכים מורחבים (גוש/חלקה/יח״ד/חתימות/סוכנים) יתחברו...". Systemic, not one screen.                                                                        | bodyText, multiple pages                              |
| DV-ORG-2 | MED — CONFIRMED             | dashboard                                                          | KPI "פרויקטים פעילים" counts cancelled+completed (`COUNT(*) WHERE archived_at IS NULL`, no status filter). seed has a cancelled project ("פינוי-בינוי — נווה שאנן (דמו) · בוטל") → it's in the "7 active".                                                                                                       | org-stats SQL + projects-list shows the cancelled row |
| DV-ORG-3 | **MED (PERF, new)**         | document-detail, documents-new, **members-list**                   | Slow document queries: `GET /documents?limit=25` = **3470 ms**; `GET /documents?limit=100` = **2890 ms fired from the MEMBERS page** (why does members fetch 100 documents?); `documents/[id]` = 2806 ms. owner pain #1. Investigate the documents query (index? over-fetch?) + the members-page document fetch. | evidence.json apiCalls ms                             |
| DV-ORG-4 | LOW (new)                   | /he/buildings, /he/apartments                                      | Bare URLs `/he/buildings` + `/he/apartments` **redirect to `/he/projects`** (no standalone list). Confirm intended (vs the registered FUNC-3 "bare-URL → 404").                                                                                                                                                  | finalUrl = /he/projects                               |

## Coverage (manager column)

**Captured (40):** dashboard · projects (list/new/detail/assignments/buildings/buildings-new/shares) · buildings (detail/apartments/apartments-new) · apartments (detail/ownerships) · owners (list/new/detail) · documents (list/new/detail) · signature-requests (list/new/detail) · members (list/new/detail) · contractors (list/new/detail) · tasks (list/new/detail) · notes (list/new) · notifications · imports (list/new) · audit · settings.

**Gaps (not reached — finish next):**

- notes-detail · imports/[id] + /errors + /mapping (need an existing import) · the **reveal-PII modal** (interaction, not a page) · **org-switcher Alpha↔Beta** (cross-tenant isolation — important) · confirm-archive modal.
- Visual review of the 40 PNGs (layout/jank/RTL) — pending selective review (NOT all-at-once).
