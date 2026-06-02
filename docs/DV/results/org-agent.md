# DV results — Org / agent — role-diff coverage

> Spec: `apps/web/e2e/audit/dv-org-agent.spec.ts` (Playwright headless, audit
> config). Headline = the **role-diff** vs the manager column: agent must see
> ONLY assigned projects and must NOT have members/audit/settings nav.
> Continues finding IDs from DV-ORG-5 (DV-ORG-1..4 are in `org-manager-coverage.md`).

## RUN STATUS — behavioral evidence PENDING (stack was down)

At investigation time the local dev stack on `http://localhost:3001` was **not
listening** (`net::ERR_CONNECTION_REFUSED` on every `page.goto`), and starting
servers is out of scope for the read-only investigator (the start script needs
`-ExecutionPolicy Bypass`, which the harness blocks). The spec is **written,
lint-clean, and ready**; it produces the full artifact bundle the instant the
stack is up:

```powershell
# bring up the stack (owner / a non-read-only role):
powershell -ExecutionPolicy Bypass -File .\start-dev-local.ps1
# then, from apps/web:
pnpm exec playwright test --config playwright.audit.config.ts dv-org-agent.spec.ts
```

Evidence rollups it writes: `artifacts/org-agent-evidence.json` (per-page DOM
text + network + console + form methods) and `artifacts/org-agent-nav.json`
(the sidebar role-diff probe). Screenshots `artifacts/org-agent-*.png`.

## Oracle (the expected agent state)

From `apps/api/src/common/authz/policy.ts` (the locked D.17 matrix) + D.46:

- **Read = ALL org roles**, BUT the agent is **scoped per-record in the service
  layer** to **assigned projects** (`project_assignments`) — NOT a global read.
  So the agent's projects list must be a **STRICT SUBSET** of the manager's 7,
  and entity detail pages for unassigned projects/owners/docs must 404/403, not
  render.
- **Writes**: manager-or-agent on buildings/apartments/owners(edit)/documents/
  tasks/imports/notes — all **fine-gated** per-assignment in the service. Owner
  **CREATE stays manager-only**. `members`, `audit`, `settings`,
  `project_assignments` writes = **manager only**.
- **Nav**: `sidebar.tsx` pushes members/audit/settings **only when
  `role === 'manager'`** → agent must NOT see those three nav items.

## Findings

| ID       | Sev                | Axis             | Page(s)                                                      | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                           | Status                               |
| -------- | ------------------ | ---------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| DV-ORG-5 | INFO (oracle)      | scoping/security | sidebar                                                      | **Agent nav-gating is correct in code**: `apps/web/src/app/[locale]/(dashboard)/_components/sidebar.tsx` L116-120 pushes `members`/`audit`/`settings` ONLY inside `if (role === 'manager')`. Agent gets the base 10-item nav. The spec's `org-agent-nav.json` probe asserts `seesMembers/seesAudit/seesSettings === false`.                                                                                                                       | static-confirmed, behavioral PENDING |
| DV-ORG-6 | HIGH (if it fails) | scoping/security | projects-list, project-detail, owner-detail, document-detail | **IDOR probe**: the spec navigates the agent to the manager-owned seed IDs (`PROJECT_ID`, `OWNER_ID`, `DOCUMENT_ID`, …). Per D.46 these must be **per-record gated to assigned projects** — an unassigned target must return 403/404, NOT render owner PII or project data. `evidence.json.failed4xx5xx` + `bodyText` per page are the oracle. If a body renders cross-scope data with no 4xx, that is a **cross-scope leak** → escalate to HIGH. | behavioral PENDING                   |
| DV-ORG-7 | MED (if it fails)  | scoping          | projects-list                                                | **Subset assertion**: agent projects list must be a strict subset of the manager's 7 (assigned only). The walk records `projects-list.bodyText`; reconcile the rendered project count against the agent's `project_assignments`. Manager saw all 7 (incl. the cancelled demo project). Agent seeing 7 = leak; agent seeing its assigned N (< 7) = correct.                                                                                        | behavioral PENDING                   |

## Verdict (pending behavioral run)

- **Scoping (code-level): CORRECT by construction** — nav gating is role-checked;
  record scoping is service-layer per-assignment (D.46). The behavioral run must
  CONFIRM no cross-scope render slips through (DV-ORG-6) and the projects subset
  holds (DV-ORG-7).

## Coverage (agent column)

Spec walks: dashboard · projects (list/new/detail/assignments/buildings/shares) ·
building-detail · apartment-detail · owners (list/new/detail) · documents
(list/detail) · signature-requests (list/detail) · contractors (list/detail) ·
tasks (list/detail) · notes-list · notifications · imports-list · **members /
audit / settings (admin surfaces — expected denied/redirected for agent)**.
