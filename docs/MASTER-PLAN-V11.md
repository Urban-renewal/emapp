# MASTER PLAN V11 — Design Re-skin + Calendar + Tenant Portal + Export

> **Status:** Locked · **Started:** 2026-05-26 · **Target:** 5 weeks
> **Single source of truth.** Any drift between this doc and reality → update this doc.

---

## §1. Mission (one paragraph)

Take the working MVP (Phase 0-7 + Phase 4a-g + V10) and reskin it to match the partner's design (`MEAPP_design/`), while adding three deferred-but-MVP features: **Calendar with ICS email** (D.38), **Tenant Portal** (D.40 — own apartment + docs + signatures), and **Export** (Excel + PDF per Phase 7). The product runs end-to-end on a staging URL by week 5 and looks like the partner's design.

---

## §2. The four tracks + ownership boundaries

| Track | Owner | Scope | Boundaries |
|---|---|---|---|
| **A — Design Re-skin** | New agent (FE lead) | All FE work during V11: tokens · shell · reskin every existing page · add new FE features (Calendar UI, Tenant Portal FE, Export FE wiring) · bug fixes · Sidebar/Topbar shared components | Never touches `apps/api/**` · Never invents BE — STOPs and reports missing endpoints to Track B · Never changes `apps/api/src/common/authz/policy.ts` or migrations |
| **B — BE Specialist** | New agent (BE lead) | All BE additions during V11: schema migrations (D.39) · Calendar service + ICS generator + Resend integration · Tenant Portal endpoints · Export service (xlsx + PDF) | Never touches `apps/web/**` · Never changes auth flows or Provider tier (V10 owns) · Never reorganizes existing controllers |
| **C — FE Continuous (existing)** | Active agent | Finishes V10-S3..S6 (Provider auth flow) and **STOPs** | Doesn't start anything new in V11. After V10-S6 merges → STOP message + standby |
| **D — Playwright (existing)** | Active agent | Wave 1 leftover (J5/J7/J12/J15) → Wave 2 after Track A surfaces re-skinned → Wave 3 for Calendar/Portal/Export | Touches `apps/web/e2e/` only — no app code |

---

## §3. Seven milestones + git tags

Each milestone tag = a clean rollback point.

| Tag | What it includes | ETA |
|---|---|---|
| `v11.0-foundation` | tokens.css → tailwind config · Shell (Sidebar + TopBar + AppShell) · LoginScreen reskin · Canary tasks merged from both A and B | End week 1 |
| `v11.1-schema` | Building sections + apartment.unit_type migration (D.39) · tasks-extended migration · tenant_portal tables | End week 1 |
| `v11.2-reskin-core` | Manager surface reskinned (Home/Projects/ProjectPage/Owners/Documents/TenantPanel-drawer) | End week 2 |
| `v11.3-tenant-portal` | Tenant logs in via OTP → sees own apartment + own documents + own signatures (D.40 scope) | End week 3 |
| `v11.4-calendar` | Manager creates task → ICS email sent via Resend → recipients add to their calendar app | End week 3 |
| `v11.5-export` | Manager downloads project as Excel or PDF (Hebrew RTL preserved) | End week 4 |
| `v11.6-platform-console` | Provider Admin reskinned: PCSidebar 13 nav (3 wired: orgs/audit/health, 10 placeholders) | End week 4 |
| `v11.0-mvp-complete` | All above + staging deploy + Playwright Wave 3 green | End week 5 |

Commands:
```bash
git tag v11.X-<name>
git push origin v11.X-<name>
gh release create v11.X-<name> --title "V11.X — <name>" --notes "..."
```

---

## §4. Slice breakdown (one line per slice)

### Track A — Design Re-skin (15 slices)

| ID | Slice | Depends on | Days |
|---|---|---|---|
| A.S1 | **Canary:** tokens.css → tailwind config + reskin Login screen end-to-end | — | 2 |
| A.S2 | Shell — Sidebar + TopBar + AppShell + notifications bell | A.S1 | 1 |
| A.S3 | ManagerHome (KPIs + 2 action buttons, Calendar/Conversations empty states) | A.S2 | 1 |
| A.S4 | ProjectsList (cards/table toggle) | A.S2 | 1 |
| A.S5 | ProjectPage with tabs (דיירים+מסמכים+פרטים+יומן+משימות) | A.S2 | 2 |
| A.S6 | AddProjectModal 3-step wizard | A.S2, **B.S2** | 3 |
| A.S7 | TenantPanel (drawer slide-in) | A.S2 | 1 |
| A.S8 | DocsPage (Documents + Signatures unified) | A.S2 | 1.5 |
| A.S9 | TeamPage (Members + Assignments) | A.S2 | 1 |
| A.S10 | SettingsPage (basic) | A.S2 | 0.5 |
| A.S11 | NotificationsPanel + ManagerNotificationsPage | A.S2 | 0.5 |
| A.S12 | WeekCalendar UI | A.S2, **B.S6, B.S7** | 2 |
| A.S13 | Platform Console reskin (PCSidebar 13 nav, 3 wired) | A.S2 | 2 |
| A.S14 | Tenant Portal FE (TenantPortal hero + apartment + docs + sigs) | A.S2, **B.S4** | 3 |
| A.S15 | Export FE wiring (download button on ProjectPage + toast UX) | A.S2, **B.S10** | 1 |

**Track A total: ~22 days**

### Track B — BE Specialist (10 slices)

| ID | Slice | Depends on | Days |
|---|---|---|---|
| B.S1 | **Canary:** migration `building_sections` + `apartment.unit_type` (D.39) + 1 test | — | 1.5 |
| B.S2 | Service: project create with sections expansion (transaction + RLS + tests) | B.S1 | 1.5 |
| B.S3 | Migration: tenant_portal tables (own-data view; D.40) | — | 1 |
| B.S4 | Endpoints: `/api/v1/portal/me`, `/portal/apartment`, `/portal/documents`, `/portal/signatures` (emapp-tenant audience) | B.S3 | 2 |
| B.S5 | Migration: tasks-extended (`scheduled_at`, `duration_minutes`, `task_type`, `location`, `attendees`) | — | 1 |
| B.S6 | Service: Calendar event manager + ICS generator (`ical-generator` lib, RFC 5545) | B.S5 | 2 |
| B.S7 | Resend integration: task create/update/cancel → email with .ics attachment to attendees | B.S6 | 1.5 |
| B.S8 | Export service: project → Excel (xlsx streaming) | — | 2 |
| B.S9 | Export service: project → PDF (puppeteer + Heebo font for Hebrew RTL) | — | 2 |
| B.S10 | Endpoints: `GET /api/v1/projects/:id/export?format=excel|pdf` + audit + throttle | B.S8, B.S9 | 1 |

**Track B total: ~16 days**

### Dependency arrows

```
B.S1 → B.S2 ──┐
              ▼
              A.S6 (AddProject wizard needs sections)

B.S3 → B.S4 ──┐
              ▼
              A.S14 (Tenant Portal FE needs Tenant BE)

B.S5 → B.S6 → B.S7 ──┐
                     ▼
                     A.S12 (Calendar UI needs Calendar BE + ICS service)

B.S8 + B.S9 → B.S10 ──┐
                      ▼
                      A.S15 (Export FE needs Export BE)

All A.SX (X≥2) depend on A.S1 (foundation: tokens + shell)
```

---

## §5. Quality gates (only the 4 that matter)

Every PR must pass before merge — **no exceptions**:

| Gate | Check | Enforcement |
|---|---|---|
| **G1** | CI 100% green (`gh pr checks <PR>`) | Automated |
| **G2** | Diff < 2000 lines net | Manual review (or split slice) |
| **G3** | DoD↔Test ID mapping table in PR description (D.33) | Manual review |
| **G4** | Browser smoke evidence in PR description per `docs/V11-BROWSER-SMOKE.md` (all 4 axes × all relevant roles, all passing) | Manual review — **blocker** |

If G4 evidence is missing or weak → PR is not mergeable until fixed. No "we'll catch it later."

---

## §6. The canary pattern (MANDATORY for both new agents)

**Before either new agent ships more than one PR**, they ship their **canary** — a designated minimum-scope slice that exercises the entire pipeline end-to-end:

| Agent | Canary | Why this canary |
|---|---|---|
| Track A (Design Re-skin) | **A.S1**: tokens.css → tailwind config + reskin Login screen | Exercises: tokens conversion · global CSS strategy · component reskin pattern · form interactivity preservation · cookies/auth flow unchanged · browser smoke for all 4 roles · §P0-3 console-clean. If this works, every subsequent reskin works. |
| Track B (BE Specialist) | **B.S1**: migration `building_sections` + `apartment.unit_type` + 1 test | Exercises: drizzle migration up/down · RLS adjustment · service implication · test pattern · CI green. If this works, every subsequent BE addition works. |

**Self-verification:** The canary's smoke evidence is the proof. The agent does the smoke, posts evidence in the PR description, and **continues to the next slice without waiting for user approval** (assuming G1-G4 all pass).

If the canary's smoke fails any axis → fix root cause → re-run smoke → 5 attempts max → STOP + report.

---

## §7. Autonomous operation (no waiting between slices)

Once the canary passes its own smoke and G1-G4:

```
loop {
  pick next slice from §4 (in dependency order)
  read relevant code + design files (investigate before code)
  implement
  run pnpm lint && pnpm typecheck && pnpm test (all packages)
  full browser smoke per V11-BROWSER-SMOKE.md
  post evidence in PR description
  open PR with conventional commit message
  if CI green && G2-G4 pass → push heartbeat to PROGRESS.md → continue to next slice on new branch from main
  else → fix → re-smoke → max 5 attempts → STOP + report
}
```

PRs accumulate. User merges in batches (or enables GitHub auto-merge). Agent never waits.

---

## §8. STOP conditions (only these — everything else, the agent solves)

| Trigger | What the agent does |
|---|---|
| Gate-6 architectural decision needed (not in `docs/DECISIONS.html`) | Draft D.NN proposal, post in `OPEN-ITEMS-v8.md`, STOP |
| Security CRITICAL finding (in own smoke or otherwise) | Stop work, post finding, await user response |
| Blocked (missing BE endpoint, missing schema, missing file from partner's design) | Post issue with concrete description, switch to next non-blocked slice |
| Migration / RLS change / `apps/api/src/common/authz/policy.ts` change | Require user pre-approval before push |
| 5 smoke-fix loops on the same slice without resolution | STOP, document attempts, await user |
| External resource needed (Resend domain, R2 bucket, new env secret) | Post request, STOP |

Everything else: the agent decides, executes, moves on.

---

## §9. Rollback playbook

Four levels, from cheapest to most invasive:

1. **Single PR revert:** `gh pr revert <num>` (creates revert PR, merge, done)
2. **Slice revert:** revert all PRs of one slice (typically 1-3 PRs)
3. **Milestone revert:** `git revert <milestone-tag-commit>..HEAD` (cuts everything since the tag)
4. **Schema rollback:** every B.SX migration has a `down()`. Run `infisical run --env=dev -- pnpm --filter @emapp/db db:rollback`

For schema migrations: never push without proven `down()` migration that's been tested locally.

---

## §10. Tracker (updated weekly — replace this table)

| Track | Slice | Status | PR | Tag | Merged |
|---|---|---|---|---|---|
| A | S1 (canary) | 📋 planned | — | — | — |
| A | S2 | 📋 planned | — | — | — |
| ... | | | | | |
| B | S1 (canary) | 📋 planned | — | — | — |
| ... | | | | | |

(populated by agents via PROGRESS.md heartbeat — this table mirrors it weekly)

---

## §11. Communication

- **Daily heartbeat** in `PROGRESS.md` (one line per active agent per day):
  > `2026-05-27 — Track A: A.S3 ManagerHome in progress (canary A.S1 merged ✓). Track B: B.S4 tenant portal endpoints, 2/4 done.`
- **STOP escalations** post in chat (you respond when you can)
- **D.NN drafts** open as PR comments on PROGRESS.md, awaiting your approval before merging into `docs/DECISIONS.html`

---

## §12. DECISIONS in play

- **D.38** — Calendar in MVP (was Phase 2 — promoted by user direction)
- **D.39** — Building sections + `apartment.unit_type` schema (needed for AddProject wizard per partner design)
- **D.40** — Tenant Portal MVP scope (own apartment + own documents + own signatures only; no milestones/FAQ/benefits/questions — those stay Phase 2)

Drafts live in `docs/DECISIONS.html`. Any scope change beyond these requires a new D.NN entry before code.

---

## §13. References

- Browser smoke standard: `docs/V11-BROWSER-SMOKE.md`
- Design files index: `docs/MEAPP_DESIGN_INDEX.md`
- Partner's design source: `MEAPP_design/design_handoff/source/`
- Track A agent prompt: `docs/V11-AGENT-PROMPT-A.md`
- Track B agent prompt: `docs/V11-AGENT-PROMPT-B.md`
- Existing project laws: `docs/DECISIONS.html` (D.01-D.40)
- Functionality inventory: `docs/TEST-COVERAGE-MATRIX-V2.md`

---

**Updated when reality drifts from this doc. Source of truth — period.**
