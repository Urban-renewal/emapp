# DV Persona — Field Agent (סוכן שטח)

**Persona:** `agent@alpha.dev` (אבי סוכן), org Alpha, role `agent` (Tier-1, assigned-scope).
**Capabilities (this seed agent):** `view_owner_pii=FALSE`; **no D.46 agent capabilities granted**
(`edit_project_data`, `manage_tasks`, etc. all off) — so owner PII is masked and project-data
edits are denied. This is the **least-privilege agent** and the most useful boundary to probe.
**Method:** drove the REAL UI headless (`apps/web/e2e/audit/dv-persona-agent.spec.ts`), judging every
action on TWO axes — _did it succeed?_ (confirmed by the RESULT: API re-read with the browser's own
cookie jar / list reload / URL nav / DOM state — never by "the page rendered") and _should a field
agent be allowed it?_ (per D.17 + D.46).
**Run:** `cd C:/emapp/apps/web && pnpm exec playwright test --config playwright.audit.config.ts e2e/audit/dv-persona-agent.spec.ts`
**Artifacts:** `docs/DV/results/artifacts/persona-agent-ledger.json` (machine ledger).
**Result (stable across 3 repeated runs):** 14 actions tried · **7 work end-to-end** · **0 functional bugs** ·
**0 authz bugs** · **7 correctly-blocked** · 0 UX dead-clicks · console errors are only the expected
403/404 from the deliberate forbidden-action probes.

---

## Headline — the prior "agent" findings DO NOT REPRODUCE

### ✅ REFUTED — DV-AGENT-NAV ("agent cannot open its assigned projects") was a TEST ARTIFACT, not a product bug

- **Prior claim (ACTION-LEVEL-findings.md, HIGH):** clicking a project card is a dead no-op for the
  agent — "agent sees its assigned projects but can drill into none."
- **What I actually found (reproduced ≥2×, 3 runs total):** the agent **opens its assigned projects
  fine** — card click navigates to `/he/projects/{id}` with the 4-tab detail rendered (`navigated=true
tabs=4`), AND direct-URL nav renders the detail with the project name in the `<h1>` (`tabs=4
nameShown=true`). Drilling **deeper also works**: project → building (`/buildings/{id}`) →
  apartment (`/apartments/{id}`) all navigate and render.
- **Why the prior pass saw a "dead click":** the prior reality specs (`dv-reality-agent2.spec.ts`)
  used `getByText('ארלוזורוב 14').click()` — clicking the inner `<NameDisplay>` span and racing the
  client hydration of a `'use client'` page. The project card is a plain `<Link href="/projects/{id}">`
  (`projects/page.tsx:181`) with **no role gating** — there is no mechanism by which it could be dead
  for an agent but live for a manager. The dead-click was a selector/hydration artifact. The robust
  approach (scroll into view, click the `<a>` by its exact href, poll the URL for a client-nav change)
  succeeds every time.
- **Verdict:** ✅ works. **DV-AGENT-NAV should be CLOSED / downgraded to "not reproducible".**

### 🟠 DV-AGENT-CREATE — confirmed as a UX leak (control shown, BE correctly blocks), NOT a security hole

- The agent's projects list still renders the **"פרויקט חדש" (create project)** control
  (`createControlVisibleInUI=1`) — it is **not** role-gated in the UI.
- But the underlying action is **correctly blocked by the BE**: `POST /api/v1/projects` with the
  agent cookie → **HTTP 403** (POLICY `projects.create = manager-only`). Nothing is created.
- So this is the same class as the viewer write-control leak (DV-ORG-9): an unusable control is shown
  to a role that can't use it. Same-class UX defect, **no authorization bug**. → fix by hiding the
  control for agents (the sidebar already gates members/audit/settings the same way).

---

## What WORKS end-to-end for the field agent (7)

| Action                                | Confirmed by                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------ |
| See only the 3 assigned projects      | `GET /projects` (agent cookie) = 3 rows; manager sees 13. Scope is correct.    |
| Open an assigned project (card click) | URL → `/projects/{id}`, 4 detail tabs rendered.                                |
| Open an assigned project (direct URL) | 4 tabs + project name in `<h1>`.                                               |
| Drill into a building                 | building row `<Link>` → `/buildings/{id}` detail.                              |
| Drill into an apartment               | `/buildings/{id}/apartments` row → `/apartments/{id}` detail.                  |
| View owner records (list)             | `GET /owners` 200, 20 rows, all **masked** (correct for view_owner_pii=false). |
| View own tasks list                   | `GET /tasks` 200, 6 rows, list renders with no error state.                    |

## What is CORRECTLY BLOCKED (7) — every forbidden action denied

| Action                                      | Oracle                                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Members/Audit/Settings hidden from nav      | sidebar nav has none of the 3 manager-only labels.                                            |
| Reveal owner **cleartext** PII              | no reveal control offered to this no-capability agent; zero cleartext national_id on screen.  |
| Edit project data (PATCH assigned building) | `PATCH /buildings/{assigned}` → **403**; nothing persisted (agent lacks `edit_project_data`). |
| Open an UNASSIGNED project by direct URL    | API **404** + not-found UI ("הפרויקט לא נמצא"), **0 tabs** — no data leaked.                  |
| Create a project                            | `POST /projects` → **403** (UI still shows the dead control — DV-AGENT-CREATE UX leak).       |
| Manage org members                          | `GET /members` → **403**; no member roster leaked into the agent DOM.                         |
| View the audit log                          | `GET /audit` → **403**.                                                                       |

---

## Action ledger (every agent action attempted + confirmed outcome)

| #   | Action                                      | Performed how                                                           | Outcome (confirmed by RESULT)                                                  | Should agent?   | Verdict       |
| --- | ------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------- | ------------- |
| 1   | See the right project scope (only assigned) | `GET /projects` (agent cookie) + count rendered cards                   | ✅ exactly 3 assigned (manager sees 13). Scope correct.                        | yes             | ✅ works      |
| 2   | Nav hides members / audit / settings        | read sidebar nav texts                                                  | ✅ none of the 3 manager-only labels present.                                  | no (hide)       | ✅ blocked_ok |
| 3   | Open an assigned project (card click)       | scroll + click the card `<a>` by href → await `/projects/{id}` + 4 tabs | ✅ navigated, 4 tabs. **DV-AGENT-NAV refuted.**                                | yes             | ✅ works      |
| 4   | Open an assigned project (direct URL)       | goto `/projects/{id}` → 4 tabs + name in `<h1>`                         | ✅ detail rendered for the agent.                                              | yes             | ✅ works      |
| 5   | Drill into a building                       | `/projects/{id}/buildings` → click building row → `/buildings/{id}`     | ✅ building detail opened.                                                     | yes             | ✅ works      |
| 6   | Drill into an apartment                     | `/buildings/{id}/apartments` → click apt row → `/apartments/{id}`       | ✅ apartment detail opened.                                                    | yes             | ✅ works      |
| 7   | View owner records (list) — PII fidelity    | `GET /owners` (agent cookie) → assert masked                            | ✅ 20 rows, all national_id MASKED (correct for view_owner_pii=false).         | yes             | ✅ works      |
| 8   | Reveal owner **cleartext** PII              | owner dossier → look for reveal → assert no cleartext                   | ✅ no reveal control offered; no cleartext leaked.                             | no              | ✅ blocked_ok |
| 9   | Edit project data (PATCH assigned building) | `PATCH /buildings/{assigned}` notes → status + API re-read              | ✅ **403**, nothing persisted (no `edit_project_data` capability).             | no (this agent) | ✅ blocked_ok |
| 10  | Open an UNASSIGNED project by direct URL    | goto `/projects/{unassigned}` → API 404 + not-found UI                  | ✅ API 404 + not-found UI, **0 tabs** — no leak.                               | no              | ✅ blocked_ok |
| 11  | Create a project                            | `POST /projects` (agent cookie) → assert 403                            | ✅ **403**. UI still shows the "פרויקט חדש" control → DV-AGENT-CREATE UX leak. | no              | ✅ blocked_ok |
| 12  | Manage org members                          | `GET /members` + open `/he/members`                                     | ✅ **403**, no roster leaked to the agent DOM.                                 | no              | ✅ blocked_ok |
| 13  | View the audit log                          | `GET /audit` (agent cookie)                                             | ✅ **403**.                                                                    | no              | ✅ blocked_ok |
| 14  | View own tasks list (legitimate read)       | `GET /tasks` + assert `/he/tasks` renders without an error state        | ✅ 200, 6 rows, no error UI.                                                   | yes             | ✅ works      |

---

## MISSING section — what a field agent NEEDS that the UI doesn't offer

A real סוכן שטח walks buildings to collect signatures. The current agent interface is structurally
**read-with-no-do** for this seed agent, and even with capabilities the UI is missing the field
basics:

1. **No "my projects / my route" field home.** The agent lands on the same generic dashboard +
   global lists (owners, tasks, notes, documents) as a manager. A field agent needs a focused
   surface: _my assigned projects, with per-project signed/needed progress and a "who's left to
   sign" list_ — the actual day's worklist. Today there is no per-project signature progress shown to
   the agent at all (the project KPI grid renders `—` placeholders).

2. **No way to act on an owner from the field.** The owner dossier quick-actions
   (WhatsApp / send-to-signature / add note / create task) are **disabled placeholders** (carried
   over from the manager persona finding DV-MGR-OWNER-ACTIONS). For the agent these are the entire
   job — chasing a signature — and they are dead. There is no "send this owner the signing link"
   path the agent can complete.

3. **The capability model is invisible in the UI.** This agent has `view_owner_pii=false` and no
   `edit_project_data`, so it sees masked PII and gets a silent 403 if it ever reaches an edit. But
   the UI gives **no signal** about what the agent is/ isn't allowed — it shows the "create project"
   control it can't use, offers no reveal control (good) but also no "request access" affordance. A
   field agent can't tell a permission wall from a bug.

4. **No offline / mobile field affordance.** Signature collection happens on a phone at a kitchen
   table. The surfaces are desktop-grid layouts; nothing in this persona pass suggested a
   mobile-first signing flow for the agent.

---

## Notes for the next investigator (harness, not product)

- **Rendering ≠ working, AND "dead click" ≠ product bug.** Two of the three drill-in "failures" in
  the first pass of THIS spec were my own **selector artifacts** (the building-row selector matched
  the `/buildings/new` CTA; the apartment list lives at `/buildings/{id}/apartments`, not embedded in
  the building detail). Both vanished once the selector matched the uuid-suffixed row `<Link>` and the
  correct route. The prior DV-AGENT-NAV "dead click" was the same class of artifact. **Always click
  the exact `<a>` by href + poll for a client-nav URL change; never `getByText().click()` on a
  hydrating page.**
- Forbidden actions are confirmed via the **API status** (403/404) using the browser's own cookie
  jar — the authoritative oracle — not via "the page looked blocked". The 403/404 console errors in
  the run are exactly these deliberate probes (members 403, unassigned project 404), not product
  errors.
- This seed agent has **no capabilities**. To exercise the _positive_ D.46 paths (an agent that CAN
  edit assigned project data / reveal PII / manage tasks), a future pass should grant the membership
  capabilities (or use a seeded capability-bearing agent) and re-judge actions 7/9/11-class as
  should=yes — the BE enforcement (`requireAgentCapability` + assigned-project scoping) is already
  proven on the deny side here.
