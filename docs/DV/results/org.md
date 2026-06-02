# DV results — Interface 1 (Org)

> Artifact log. Each item: what was driven, the captured evidence, assertion vs
> oracle, status, findings. Live-driven via Claude-in-Chrome against
> `localhost:3001` (local DB, seed:demo), main @ #229.

## CALIBRATION — item #1: manager / dashboard (`/he`)

**Driven:** login (manager@alpha.dev) → landed `/he`. Read DOM text + network.
**Evidence captured:**

- Network: `POST /api/v1/auth/login → 200` · `GET /api/v1/notifications?limit=5 → 200`. KPIs are SSR'd (no client `/org/stats` fetch observed).
- DOM (KPIs): פרויקטים פעילים **7** · דיירים במערכת **43** · חתימות שהתקבלו **24** · ממתינים לטיפול **5**. Org badge: Alpha (1 notification).
- Actions present: "פרויקט חדש", "משימת שטח".
- ⚠️ **Screenshot: FAILED** — Claude-in-Chrome `Page.captureScreenshot` CDP timeout (30s) ×3, environmental (not page-specific). Visual artifact not capturable via this tool → see capture-vehicle decision.

**Status: 🟧 works-with-findings**

### Findings (calibration)

| ID       | Sev                            | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                    | Evidence               |
| -------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| DV-ORG-1 | LOW (UX-3, confirmed live)     | Internal slice/phase jargon leaks to production UI: **"תצוגת יומן מלאה תיחבר ב-A.S12 (Calendar + ICS)"** and **"צ'אט נוסף בשלב מאוחר יותר (Phase 2)"** on the manager home. User-facing strings carry dev references.                                                                                                                                                                                                                      | DOM text of `/he`      |
| DV-ORG-2 | **MED — CONFIRMED (real bug)** | KPI **"פרויקטים פעילים" (active) = 7**, but the count is `SELECT COUNT(*) FROM projects WHERE archived_at IS NULL` (`projects.service.ts` orgStats, line 284) — it filters **only `archived_at`, NOT status**, so **cancelled + completed projects are counted as "active."** seed:demo has all 6 statuses → 7 includes terminal projects. **Root fix:** add `AND status NOT IN ('cancelled','completed')` (or relabel). Oracle caught it. | org-stats SQL vs label |

### Tooling finding (blocks the capture standard)

- **TOOL-1:** Claude-in-Chrome screenshot capture freezes (CDP timeout) in this env — 3/3, login + dashboard. Functional driving works (navigate/find/click/type/read-text/network). **Visual artifact requires a different capture vehicle (Playwright).**
- **FUNC-4 reproduced live:** first fast-fill+submit on `/login` was a silent no-op (hydration race); second attempt (post-hydration) succeeded. Confirms the registered FUNC-4. (Login out-of-scope, but the race affects any fast-driven form → another reason for Playwright auto-wait.)
