# EMAPP — Enterprise IAM design (proposal — supersedes D.17 fixed-role model)

> **Status:** PROPOSAL for owner approval (Gate-6 — changes authz + schema). No
> code until approved. Goal: a full **enterprise** IAM model, built SOLID, with
> only the **load-bearing foundation** implemented for MVP so nothing breaks
> later. Everything else layers on additively.

## 0. Principles

- **Permission-based, not role-hardcoded.** Today `policy.ts` holds catalog +
  roles + mapping all in code → an org can't change who-does-what without a
  deploy (SMB, not enterprise). We move **roles + assignments to the DB**.
- **One enforcement engine** (SOLID, single-responsibility): every authz
  decision flows through `can(user, permission, scope)`. No `role === 'x'`
  scattered in FE or BE.
- **Build the foundation now, defer the features.** §8 splits load-bearing
  (now) from additive (later).

## 1. The three layers (this is the answer to "managed in a file?")

| Layer                  | What                                                                           | Lives in                 | Why                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Permission catalog** | the atomic actions the app can check (`project.create`, `owner.reveal_pii`, …) | **CODE** (a typed const) | each permission binds to a real enforcement point — you can't invent one without code. Declaring capabilities ≠ "managing perms in a file" |
| **Roles**              | named bundles of permissions (system + custom)                                 | **DB**                   | so an org admin builds/edits roles with no deploy                                                                                          |
| **Assignments**        | which user holds which role, on which scope                                    | **DB**                   | `(user × role × scope)` is data, not code                                                                                                  |

## 2. Permission catalog (code — the canonical list)

Grouped by resource. `*` actions: read · create · update · archive (soft-delete).
Plus the sensitive/operational ones called out explicitly.

- **projects**: read, create, update, archive
- **buildings / apartments**: read, create, update, archive
- **owners**: read, create, update, archive, **reveal_pii** (cleartext national_id/phone — discrete, audited)
- **ownerships**: read, set (atomic 100% replace, D.25)
- **documents**: read, create, update, archive, download
- **signature_requests**: read, send, cancel
- **tasks / notes**: read, create, update, archive
- **contractors**: read, create, update, archive · **shares**: create, revoke
- **imports**: read, run, cancel, map · **mapping_templates**: read, manage
- **export**: **run** (bulk data leaves the system — gated + audited, discrete)
- **stats**: read · **audit**: read
- **members**: read, invite, update, remove _(admin plane)_
- **roles**: read, assign, revoke, manage _(admin plane — create/edit custom roles)_
- **org.settings**: read, update · **org.security_policy**: manage _(admin plane)_
- **org.billing**: manage · **org**: transfer_ownership, delete _(owner plane)_

## 3. DB schema (the load-bearing data model)

```
roles                (id, org_id NULL=system, key, name, description, is_system)
role_permissions     (role_id, permission)            -- permission ∈ catalog
role_assignments     (id, user_id, role_id, scope_type, scope_id, granted_by, granted_at, expires_at NULL)
                       scope_type ∈ {'org','project'}  scope_id = org_id | project_id
-- identity readiness for SSO/SCIM (columns now, flow later):
users   += external_id NULL, idp NULL, provisioning_source ('local'|'scim'|'sso')
-- authz-change audit (append-only, can't backfill → schema now):
audit_log  already exists; add action types role.assigned / role.revoked / role.changed
```

- `role_assignments` is the **source of truth**. The current `membership.role`
  enum is **backfilled** into one `(user, role, scope=org)` assignment per
  member, then the enum read-path is removed (gradual — §9).
- `project_assignments` (agent→projects) is **subsumed**: an agent assignment
  becomes `role_assignment(user, Agent, scope=project)`.
- All tables under RLS / `withTenant` (system roles: `org_id IS NULL`, readable cross-org).

## 4. System roles (seeded; un-deletable) + default permission sets

| Role        | Scope (default)       | Holds                                                                                                                                                    | Notably NOT                                                 |
| ----------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Owner**   | org                   | everything incl. billing, transfer, delete-org                                                                                                           | —                                                           |
| **Admin**   | org                   | members, roles, org.settings, org.security_policy, ALL operational + reveal_pii + export                                                                 | billing / transfer / delete-org                             |
| **Manager** | org (future: project) | ALL operational on scope (projects/buildings/owners/docs/signatures/tasks/notes/contractors/shares/imports), reveal_pii, export                          | members, roles, billing, security_policy                    |
| **Agent**   | project (assigned)    | read + scoped writes per the grant (edit_project_data→building/apt/owner.update; manage_documents/signatures/tasks; run_imports); reveal_pii iff granted | create-project, owners.create, members, export(default off) |
| **Viewer**  | org or project        | read only, **PII masked**                                                                                                                                | every write, reveal_pii                                     |

The current D.46 agent "capabilities" become **permissions inside the Agent
role** (or custom sub-roles). The D.54 PII fidelity becomes the `owner.reveal_pii`
permission + masked-by-default rendering.

## 5. Enforcement engine (SOLID — replaces the policy.ts matrix)

- `PermissionService.can(user, permission, scope): boolean` — resolves the
  user's assignments (filtered by scope) → union of their roles' permissions →
  membership test. **Single source.** Cached per-request.
- `@RequirePermission('owners.reveal_pii')` guard decorator replaces the coarse
  `@AuthzResource` role-matrix. Record-level scoping (assigned-project) stays in
  the service but is now expressed as the assignment scope, not a special-case.
- `GET /me` returns the user's **effective permission-set + scopes** → the FE
  gates on it (§6).

## 6. FE gating — and the DV-ORG-9 / dead-buttons fix

The FE renders a control **only if** `me.permissions` includes its permission
(scoped). A viewer lacks `project.create` → the button isn't rendered. This is
the **correct fix** for DV-ORG-9 / DV-AGENT-CREATE / dead owner-actions —
done through the permission engine, NOT role-hardcoded (which would be thrown
away). Pure-placeholder controls (not-yet-built) are hidden separately
(ship-or-hide). **Re-test = re-run the existing `dv-persona-*` specs** → the
"30 dead controls" must drop to ~0.

## 7. Scope model

`scope = org | project`. An assignment grants a role over a scope. "Manager of
project X" = `role_assignment(user, Manager, project:X)`. MVP seeds managers at
`scope=org`; project-scoped managers + project-scoped viewers become expressible
with zero migration (the data model already carries scope).

## 8. Load-bearing NOW vs additive LATER

|       | Build now (foundation — breaking to retrofit)                              | Defer (additive — layers on)                                                                                                                                                |
| ----- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | permission-based contract: `/me` perms; FE+BE gate on permissions          | —                                                                                                                                                                           |
| **B** | `role_assignments (user×role×scope)` DB model; subsume project_assignments | custom-role **builder UI**                                                                                                                                                  |
| **C** | SSO/SCIM **identity columns** (external_id/idp/provisioning_source)        | SSO/SCIM **flow**                                                                                                                                                           |
| **D** | authz-change audit events (role.assigned/revoked)                          | access-reviews / recertification                                                                                                                                            |
| **E** | Owner/Admin/Manager/Agent/Viewer taxonomy seeded                           | org security-policy enforcement (MFA/IP) · maker-checker · export-DLP · API keys/service-accounts · time-bound/delegation · external-party roles · lifecycle-status locking |

## 9. Migration path (non-breaking, gradual)

1. Add tables (roles/role_permissions/role_assignments) + identity columns. Seed the 5 system roles + their permission sets.
2. Backfill: each `membership.role` → `role_assignment(user, <role>, scope=org)`; each `project_assignment` → `role_assignment(user, Agent, scope=project)`.
3. Switch the enforcement engine to read assignments; `/me` returns permissions. FE gates on permissions.
4. Remove the `policy.ts` role-matrix + the `membership.role` read-path once green. (The catalog const stays.)
   Each step is its own slice + reviewers + CI; the DV personas are the regression gate.

## 10. Decisions (my recommendation — adjust as you like)

1. **Owner vs Admin:** seed **both** as system roles now (taxonomy locked, E); in MVP the first user = **Owner** (⊇ Admin powers), Admin assignable but lightly used until the admin-console UI ships. _(Avoids re-classifying live users later.)_
2. **Replace vs add-alongside `membership.role`:** **make `role_assignments` the source of truth via backfill** (not a parallel system) — clean single-source, but cut over gradually per §9 so nothing breaks mid-flight.
3. **Custom roles in MVP:** data model yes (now); the **builder UI** deferred (additive). MVP ships the 5 system roles; orgs get custom roles when the UI lands.
