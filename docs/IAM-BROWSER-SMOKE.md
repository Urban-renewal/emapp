# IAM Browser Smoke — per-role checklist (the only remaining step before merge)

Run this against the dev app on the LOCAL DB. ~15–20 min. Aligned with the
4-axis smoke standard (`docs/DOD-BROWSER-SMOKE.md`).

## Start the dev app (local DB)

```
# API + Worker (local DB override is baked into the dev script):
./start-dev-local.ps1          # or: infisical run -- pnpm --filter @emapp/api dev
# Web (port 3001):
pnpm --filter @emapp/web dev
```

Seed users (all password-set, verified loginable on the current local DB):

- **`manager@alpha.dev`** → resolves to **Owner** (the org's primary user = Owner, D-A)
- **`agent@alpha.dev`** → Agent (scoped to assigned projects)
- **`viewer@alpha.dev`** → Viewer (read-only)
  (Dev auth bypass OTP/MFA code = `000000` where prompted.)

## Per-role expectations (the engine drives these from `/me`)

### As Owner (`manager@alpha.dev`) — should see EVERYTHING

- [ ] Dashboard loads; sidebar shows **Members**, **Audit**, **Settings** (Owner/Admin-only).
- [ ] **New Project** button visible (`projects.create`).
- [ ] **Export** available (`export.run`).
- [ ] Owner detail → **Reveal PII** button visible; clicking reveals cleartext (D-H.2 — gated on `/me.view_owner_pii`).
- [ ] A project → **Assignments** page → the **assign-agent form** is visible and works (D-B — `project_assignments.manage`).

### As Agent (`agent@alpha.dev`) — scoped writes, no governance

- [ ] **No** New Project button; **no** Members/Audit/Settings in the sidebar; **no** Export.
- [ ] Sees only **assigned** projects/buildings/apartments (record-scoping).
- [ ] On a project Assignments page: the list is visible (read) but the **assign-form is HIDDEN** (no dead control — D-B).
- [ ] Reveal-PII button HIDDEN unless this agent was granted the `view_owner_pii` capability via the Members → capabilities panel (then it SHOWS and works — the D-H.2 fix).

### As Viewer (`viewer@alpha.dev`) — read-only everywhere

- [ ] Every list/detail loads read-only; **no** create/edit/archive/assign/reveal controls anywhere (no dead controls that 403 on click).

## 4-axis check on ONE state-changing action (e.g. create a project as Owner)

- [ ] **Network:** the submit is a **POST** (not GET) — no credentials/data in the URL.
- [ ] **URL:** no PII / national_id / phone in any query string.
- [ ] **Cookies:** session is httpOnly (not readable via `document.cookie`).
- [ ] **Redirect:** success lands on the expected page; a 401 with `token_expired` silently refreshes (not a logout).

## Negative / boundary spot-checks

- [ ] Log in as Agent, then directly hit an Owner-only URL (e.g. `/members` or `/settings`) — should be denied/empty, not a crash.
- [ ] As Viewer, attempt nothing should be offered; if you force a write via devtools, the BE returns a clean `{ error: { code: 'forbidden' } }` (the engine guard is the authority).

## If anything is off

- A control that's **hidden but should show** (or shows but 403s) → an FE-gate / `/me` mismatch (note the role + control).
- A **lockout** for a freshly-invited member → would indicate a provisioning gap (this was the big find; provisioning is fixed + tested, but worth confirming live: invite a new member as Owner, accept, log in as them → they should have their role's permissions).

When this passes, the PR (#248) is ready to merge.
