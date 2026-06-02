# DV results — Org / viewer — read-only coverage

> Spec: `apps/web/e2e/audit/dv-org-viewer.spec.ts` (Playwright headless, audit
> config). Headline = **read-only**: NO create/edit/archive controls present or
> enabled; nav has no members/audit/settings. Finding IDs continue from DV-ORG-5
> (shared sequence; this file holds the viewer-specific ones).

## RUN STATUS — behavioral evidence PENDING (stack was down)

`http://localhost:3001` was not listening at investigation time
(`net::ERR_CONNECTION_REFUSED`); starting servers is out of the read-only
investigator's scope. Spec is written + lint-clean. Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-dev-local.ps1   # owner / non-read-only role
# from apps/web:
pnpm exec playwright test --config playwright.audit.config.ts dv-org-viewer.spec.ts
```

Writes: `artifacts/org-viewer-evidence.json` (per page: + a `mutatingControls`
array — enabled create/edit/archive/send/reveal controls reachable as viewer),
`artifacts/org-viewer-nav.json`, `artifacts/org-viewer-mutate-leaks.json` (the
flat list of any reachable mutating control = the leak headline), and
`artifacts/org-viewer-*.png`.

## Oracle (the expected viewer state)

From `apps/api/src/common/authz/policy.ts` (D.17 matrix):

- **Read = ALL** (viewer reads org-wide, NOT project-scoped like agent — viewer
  is org-wide read-only).
- **Writes: viewer is EXCLUDED everywhere.** `MA = [manager, agent]` and
  `MGR = [manager]` cells never include `V`. Notes write = manager/agent (viewer
  read-only, policy L83-85). Tasks update = manager/assigned-agent. So the
  viewer must reach **ZERO enabled mutating affordances**.
- **Reveal-PII**: `owner-pii-reveal.tsx` — `canReveal` is false for viewers; the
  BE returns 403 even if the button were forced. The reveal button must NOT
  render for viewer.
- **Nav**: members/audit/settings manager-only → viewer must not see them.

## Findings

| ID        | Sev                | Axis               | Page(s)                              | Finding                                                                                                                                                                                                                                                                                                                                                                                    | Status                               |
| --------- | ------------------ | ------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| DV-ORG-8  | INFO (oracle)      | read-only/security | sidebar                              | **Viewer nav-gating correct in code** (same `role === 'manager'` guard as agent; viewer gets base nav only). Probe `org-viewer-nav.json` asserts no members/audit/settings.                                                                                                                                                                                                                | static-confirmed, behavioral PENDING |
| DV-ORG-9  | HIGH (if it fails) | read-only/security | every list+detail                    | **Mutating-control sweep**: the walk harvests every `button`/`a[href]`/`[role=button]` whose visible text matches a Hebrew mutate verb (הוסף/צור/ערוך/מחק/ארכוב/שלח/חתום/חשוף/…) AND is **enabled**; those land in `org-viewer-mutate-leaks.json`. Oracle = the list must be **EMPTY**. Any enabled create/edit/archive/send/reveal control a viewer can reach is a read-only leak → HIGH. | behavioral PENDING                   |
| DV-ORG-10 | INFO (oracle)      | read-only/security | owner-detail                         | **Reveal-PII must be ABSENT for viewer** (`canReveal=false`, `owner-pii-reveal.tsx` L95). The viewer walk's `owner-detail` row must contain no reveal control (also covered by DV-ORG-9 via the חשוף/הצג label).                                                                                                                                                                           | behavioral PENDING                   |
| DV-ORG-11 | MED (if it fails)  | error-handling     | projects-new, owners-new, sigreq-new | **Create pages for a viewer**: the walk hits `/projects/new`, `/owners/new`, `/signature-requests/new`. A viewer reaching a populated create FORM (vs a 403/redirect/disabled submit) is a soft leak — the BE will 403 on submit, but offering the form is a UX/authz smell. `bodyText` + `formCount` per `*-new` row are the oracle.                                                      | behavioral PENDING                   |

## Verdict (pending behavioral run)

- **Read-only (code-level): CORRECT by construction** — the policy matrix excludes
  viewer from every write cell, and reveal-PII is gated off. The behavioral run
  must CONFIRM the UI offers no enabled mutating control (DV-ORG-9 = the headline
  leak check) and that create pages don't silently render a usable form
  (DV-ORG-11).

## Coverage (viewer column)

Spec walks: dashboard · projects (list/**new**/detail/assignments/shares) ·
building-detail · apartment-detail · owners (list/detail/**new**) · documents
(list/detail) · signature-requests (list/detail/**new**) · contractors
(list/detail) · tasks (list/detail) · notes-list · notifications · imports-list ·
**members / audit / settings (expected denied/redirected)**.
