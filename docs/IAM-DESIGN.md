# EMAPP — Enterprise IAM design (proposal — supersedes D.17 fixed-role model)

> **Status:** PROPOSAL for owner approval (Gate-6 — changes authz + schema). No
> code until approved. Goal: a full **enterprise** IAM model, built SOLID, with
> only the **load-bearing foundation** implemented for MVP so nothing breaks
> later. Everything else layers on additively. **v2 — fresh-eyes gaps G1–G7
> folded in (marked).**

## 0. Principles

- **Permission-based, not role-hardcoded.** Today `policy.ts` holds catalog +
  roles + mapping all in code → an org can't change who-does-what without a
  deploy (SMB, not enterprise). We move **roles + assignments to the DB**.
- **One enforcement engine** (SOLID, single-responsibility): every authz
  decision flows through `can(user, permission, scope)`. No `role === 'x'`
  scattered (today: 15 BE files + 19 FE files do exactly that — all removed).
- **Build the foundation now, defer the features** (§9).

## 0.5 Scope & tier boundary — [G1]

This model governs the **Org tier only** (the role taxonomy below). The other
tiers stay deliberately separate (the isolation the DV verified — do NOT merge):

- **Provider tier** keeps its OWN model (`PROVIDER_POLICY`, audience
  `emapp-provider`, its own guard). The permission engine here never touches it.
- **External parties (contractor / future lawyer / bank / municipality /
  surveyor):** TARGET = **real users with a system role (`External-Read`) at
  `scope=project`**, authenticated via their share/magic-link. **MVP keeps the
  share-token** but models its grant as a project-scoped read assignment →
  converting a contractor to a full user later is additive, not a rebuild.
- **Resident/tenant** stays OTP-token, own-record-only (D.47) — a data subject,
  not an org actor; not in the role model.

## 1. The three layers (answers "managed in a file?")

| Layer                  | What                                                                       | Lives in               | Why                                                                    |
| ---------------------- | -------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------- |
| **Permission catalog** | atomic actions the app can check (`project.create`, `owner.reveal_pii`, …) | **CODE** (typed const) | each binds to a real enforcement point — can't invent one without code |
| **Roles**              | named bundles of permissions (system + custom)                             | **DB**                 | admin builds/edits roles, no deploy                                    |
| **Assignments**        | which user holds which role, on which scope                                | **DB**                 | `(user × role × scope)` is data                                        |

## 2. Permission catalog (code) + implications — [G3]

`*` = read · create · update · archive.

- **projects · buildings · apartments**: `*`
- **owners**: `*`, **reveal_pii** (discrete, audited cleartext access)
- **ownerships**: read, set (atomic 100%, D.25)
- **documents**: `*`, download · **signature_requests**: read, send, cancel
- **tasks · notes · contractors**: `*` · **shares**: create, revoke
- **imports**: read, run, cancel, map · **mapping_templates**: read, manage
- **export**: **run** (bulk data leaves system — gated + audited)
- **stats**: read · **audit**: read
- **members**: read, invite, update, remove · **roles**: read, assign, revoke, manage _(admin)_
- **org.settings**: read, update · **org.security_policy**: manage · **org.billing**: manage · **org**: transfer*ownership, delete *(owner)\_

**Permission implications (declared in code, expanded by the resolver):**
`reveal_pii ⇒ owner.read` · `view_owner_pii ⇒ view_owners` (D.54 invariant) ·
`export.run ⇒ <resource>.read` · `*.create/update/archive ⇒ *.read`. The
resolver computes the transitive closure once — you can never hold an
implied-parent-less permission.

## 3. DB schema (load-bearing data model)

```
roles             (id, org_id NULL=system, key, name, description, is_system)
role_permissions  (role_id, permission)
role_assignments  (id, user_id, role_id, scope_type, scope_id,
                   granted_by, granted_at, expires_at NULL)
                   scope_type in {org, project}   scope_id = org_id | project_id
users  += external_id NULL, idp NULL, provisioning_source(local|scim|sso)   -- SSO/SCIM readiness
audit_log  += role.assigned / role.revoked / role.changed (append-only — schema now)
```

- `role_assignments` = source of truth (backfilled from `membership.role`).
- `project_assignments` subsumed → `(user, Agent, scope=project)`.
- All under RLS / `withTenant`; system roles `org_id IS NULL`.

## 4. System roles (seeded; un-deletable) + defaults — [G7]

| Role              | Default scope         | Holds                                                                          | NOT                                                |
| ----------------- | --------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------- |
| **Owner**         | org                   | everything incl. billing, transfer, delete-org                                 | —                                                  |
| **Admin**         | org                   | members, roles, settings, security_policy, ALL operational, reveal_pii, export | billing / transfer / delete-org                    |
| **Manager**       | org (future: project) | ALL operational on scope, reveal_pii, export                                   | members, roles, billing, security_policy           |
| **Agent**         | project (assigned)    | read + scoped writes per grant; reveal_pii iff granted                         | project.create, owner.create, members, export(off) |
| **Viewer**        | org or project        | read only, **PII masked**                                                      | every write, reveal_pii                            |
| **External-Read** | project               | read of the shared subset (NO owner PII)                                       | everything else (contractor/stakeholder)           |

**`reveal_pii` + `export` are DISCRETE, revocable permissions** — on Manager/Admin
by default for MVP usability, but **removable per-org** (least-privilege on
national-ID is now expressible + audited, not a hardcoded blanket). Each actual
reveal/export stays a per-access audited action.

## 5. Enforcement engine (SOLID) — incl. perf [G5] + escalation [G2]

- `PermissionService.can(user, permission, scope): boolean` — the single source;
  replaces the `policy.ts` matrix + the 15 scattered role-checks.
- **[G5] Resolution = per-request, ONCE, cached — NOT in the JWT.** First authz
  check of a request runs ONE query (inside `withTenant`) resolving
  assignments→roles→permissions filtered by scope, expands implications, caches
  on the request context. **Not in the token** → role revocation is immediate
  (matches the contractor live-read pattern). Respects the locked ≤3-round-trip
  floor (PERF-1) — does NOT add a round-trip per check.
- **[G2] Anti-escalation on `role.assign`:** a user may assign/revoke a role ONLY
  if its permission-set ⊆ the assigner's own effective permissions on that scope;
  **only an Owner may grant Owner or Admin.** No self-escalation. Service-enforced
  - test-pinned (§6).
- `@RequirePermission('owners.reveal_pii')` replaces `@AuthzResource`. Record-level
  scoping becomes the assignment scope.
- `GET /me` returns the user's **effective permission-set + scopes** (§8).

## 6. Testing — the safety net [G6]

- **Authz matrix test** (rebuilds `policy.spec.ts` + `agent-capabilities.spec.ts`):
  every system-role × permission × scope pinned — red on any drift.
- **Escalation test** [G2]: assigner can't grant above self / self-grant Owner.
- **Implication test** [G3]: `reveal_pii` without `read` impossible.
- **Shadow-equivalence test** (cutover): the new engine returns the SAME decision
  as old `policy.ts` for every (role, resource, action) before cutover.
- **DV personas** = behavioral regression — the "30 dead controls" → ~0.

## 7. Scope model + resolution — [G4]

`scope = org | project`.

- **org-scope ⊇ every project** (a `(Manager, org)` sees all projects);
  `project`-scope is the subset. Resolution unions all assignments whose scope
  **covers** the target resource.
- **Default-deny:** no covering assignment → denied (no implicit access from
  membership alone).
- "Manager of project X" = `(user, Manager, project:X)` — zero migration.

## 8. FE gating — the DV-ORG-9 / dead-buttons fix

The FE renders a control **only if** `me.permissions` includes its permission
(scoped). Viewer lacks `project.create` → no button. The correct fix for
DV-ORG-9 / DV-AGENT-CREATE / dead owner-actions — through the engine, not
role-hardcoded (19 FE files cut over). Not-yet-built placeholders hidden
separately (ship-or-hide). Re-test = re-run `dv-persona-*`.

## 9. Load-bearing NOW vs additive LATER

|       | Build now (foundation)                                                                                  | Defer (additive)                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **A** | permission contract: `/me` perms; FE+BE gate on permissions; per-request resolution [G5]                | —                                                                                                               |
| **B** | `role_assignments (user×role×scope)`; subsume project_assignments; scope resolution + deny-default [G4] | custom-role **builder UI**                                                                                      |
| **C** | SSO/SCIM **identity columns**                                                                           | SSO/SCIM **flow**                                                                                               |
| **D** | authz-change audit; anti-escalation [G2]; implications [G3]                                             | access-reviews / recertification                                                                                |
| **E** | Owner/Admin/Manager/Agent/Viewer/External-Read taxonomy [G1]                                            | security-policy enforcement · maker-checker · export-DLP · API keys · time-bound/delegation · lifecycle-locking |
| **F** | authz **matrix + escalation + shadow tests** [G6]                                                       | —                                                                                                               |

## 10. Migration path (non-breaking — shadow cutover)

1. Add tables + identity columns. Seed the 6 system roles + permission sets.
2. Backfill: `membership.role` → `(user, role, org)`; `project_assignment` → `(user, Agent, project)`.
3. **Shadow mode:** new engine runs alongside `policy.ts`; equivalence test (§6) asserts identical decisions. No behavior change.
4. Cut over: `/me` returns permissions; FE gates; guards use `@RequirePermission`.
5. Remove `policy.ts` matrix + `membership.role` read-path once green (catalog const stays).
   Each step = own slice + reviewers + CI; policy/migration slices = Gate-6.

## 11. Decisions (recommendation — adjust freely)

1. **Owner vs Admin:** seed **both** now; MVP first-user = Owner (⊇ Admin).
2. **`role_assignments` = source of truth** via backfill (single-source, gradual cutover §10).
3. **Custom roles:** data model now; builder UI deferred.
4. **[G1] External parties:** model as `External-Read` project-scoped users now; **keep the share-token as MVP delivery**, convert to full users later.
5. **[G7] reveal_pii/export default:** ON for Manager/Admin in MVP, but a discrete removable permission (not a blanket).

## Appendix — implementation surface (grounded count)

22 `@AuthzResource` uses · 15 BE role-check files · 19 FE role/profile files · 2 authz test files · + schema/migration/seed/engine ≈ **~60 touchpoints**. ~95% mechanical (decorator + gate swaps); de-risked by the shadow cutover (§10) + the matrix/persona tests (§6) → **the live system is never broken**. ~6 slices, days–two weeks.
