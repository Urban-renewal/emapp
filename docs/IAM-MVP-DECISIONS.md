# IAM Enterprise Rework — MVP Implementation Decisions & Residuals

Status: **load-bearing work complete + verified on the local DB**; additive
items documented below with rationale + safety. Branch: `iam/fixes` (integration)
@ `9a0359e`. Per-slice checkpoints: `iam/project-assignment-manager`.
Nothing merged to `main` — awaiting the owner's final examination/merge.

This doc records the implementation-level decisions taken during the enterprise
IAM rework (the load-bearing model itself is `docs/IAM-DESIGN.md`). It is the
honest "what is done, what is deferred, and why" ledger the owner asked for.

The governing principle (owner's directive): **do the load-bearing architecture
NOW so nothing breaks later; defer purely-additive, non-breaking work.** Each
decision below is classified against that line.

---

## DONE + VERIFIED (load-bearing)

### D-A — Primary manager → Owner backfill (migration 0044)

**Problem.** The 0043 backfill mapped `memberships.role` → the same-named system
role, so the old enum (manager/agent/viewer) produced NO Owner/Admin. After the
slice-5a cutover moved member/role/org administration to the Admin/Owner plane,
every org was left with NOBODY able to invite members, assign roles, or
administer the org — the org was bricked.
**Decision (IAM-DESIGN §11.1).** The org's first user (its `is_primary` manager)
IS the Owner. Migration 0044 promotes each org's primary manager to Owner (org
scope) and removes the now-redundant Manager org-assignment (Owner ⊇ Manager),
so each has one canonical org role. Idempotent.
**Verified (local DB, node+pg).** `manager@alpha.dev` resolves to `owner` in
`alpha-dev`, with the redundant `manager` assignment removed. `roles`=6,
`role_assignments` populated.

### D-B — Project-assignment is OPERATIONAL (Manager), not governance

**Problem.** The cutover mapped project-assignment management (staffing an Agent
onto a project) onto org-role **governance** permissions (`roles.assign` /
`roles.revoke` / `roles.read`, Admin/Owner-only), so Managers lost the ability
to staff their own projects. The legacy oracle (`policy.ts`) was
`project_assignments: { read: ALL, create: MGR, update: MGR, delete: MGR }`.
**Decision.** Project-staffing is an **operational** act, distinct from org-role
governance. Introduced dedicated permissions:

- `project_assignments.read` — every in-org role (Owner/Admin/Manager/Agent/
  Viewer); External-Read excluded (external stakeholders must not enumerate
  internal staffing).
- `project_assignments.manage` — Owner/Admin/Manager only (NOT Agent), mirroring
  legacy MGR. `manage ⇒ read` (explicit implication; `buildWriteImpliesRead`
  only covers create|update|archive).
  This is NOT `roles.assign` and intentionally does NOT traverse the
  anti-escalation `canAssignRole` path — staffing is bounded to the agent→project
  scoping semantic and grants no arbitrary role/permission (security-reviewer
  confirmed: no escalation).
  **Files.** catalog (`permissions.ts`), role sets (`system-roles.ts` — Agent
  excludes `.manage`), controller regated, equivalence map updated and the 4 now-
  obsolete `KNOWN_DIVERGENCES` removed (the fix RESTORES exact equivalence, so the
  shadow-equivalence proof certifies engine === legacy for those cells), migration
  `0045` seeds the role_permissions, pinning tests updated (API-layer
  `permissions.spec.ts` AND DB-layer `iam-foundation-schema.spec.ts`).
  **Verified.** typecheck + eslint clean; 456 API authz tests + 19 DB-layer seed
  tests green; local DB grants confirmed (owner/admin/manager = manage+read,
  agent/viewer = read, external_read = none). code-reviewer **PASS**;
  security-reviewer found 1 CRITICAL (DB-layer pin not updated → suite red) which
  was fixed and re-verified green.

---

## DEFERRED — additive / non-breaking (documented with safety)

### D-C — Cross-request permission cache: DEFERRED to post-MVP

**Why it looks tempting.** The engine-backed `AuthorizationGuard` does ONE
`withTenant` resolve per authenticated request (vs the old in-memory role-matrix
guard which was free). Given low runtime is the owner's #1 pain, a per-request
DB hit on every endpoint is worth scrutinising.
**Why deferring is the CORRECT call (not laziness).**

1. The resolve is a **single, well-indexed query**:
   `role_assignments ⋈ role_permissions` filtered by `user_id`
   (`idx_role_assignments_user`) on `role_id` (`idx_role_permissions_role`),
   RLS-scoped — no org predicate needed. Minimal cost.
2. A cross-request cache **conflicts with a locked security invariant**:
   per-request resolution (NOT JWT-embedded) was chosen specifically for
   **immediate revocation** (IAM-DESIGN §5). The MVP stack has **no Redis**
   (Postgres-only cache_kv), so there is no cross-instance pub/sub to invalidate
   a cached permission-set on a role change. A TTL cache would therefore DELAY
   revocation across instances — trading a locked security invariant for
   marginal latency. Not a unilateral call to make.
3. A `cache_kv`-backed cache is itself a DB round-trip (single-row PK lookup
   instead of a 2-table join) — marginal, not a real win.
   **Conclusion.** The single indexed resolve is the **deliberate cost of immediate
   revocation**, not a fixable inefficiency. Caching becomes viable **when Redis /
   pub-sub is added (post-MVP)** — at which point it is transparent + additive
   (same `PermissionService.can` interface, no data/API change). Non-breaking.

### D-D — Record-scoping still reads the legacy `role`: RESIDUAL, safe for MVP

**State.** ~10 services scope records with `user.role === 'agent'` (agent →
assigned projects) rather than reading scope from `role_assignments`.
**Why it is SAFE now (verified by the model).** For every current user the JWT
`role` ALIGNS with the assignment: agent→Agent, viewer→Viewer; and the promoted
Owner (`manager@alpha.dev`) carries JWT `role='manager'` (membership.role
unchanged by 0044) while holding the Owner assignment — and Owner ⊇ Manager, so
the coarse engine gate passes and the record-scoping treats them as org-wide
(correct for an Owner). There is no user whose effective authority is
mis-scoped. It only becomes wrong when (a) custom roles ship, or (b) a user is
assigned a role ≠ their membership.role in a way that changes record scope.
**Why deferring is correct.** The load-bearing piece — the `role_assignments`
data model — already exists. Migrating 10 services' record-scoping onto it is an
internal refactor (no API/data-contract change), additive, and carries real
regression risk on a working system. Do it when custom roles are introduced.
**Follow-up trigger:** first custom-role feature, OR JWT carrying assignment-
derived scope.

### D-E — `policy.ts` removal (slice 6): DEFERRED, depends on D-D

`policy.ts` is now the **dead equivalence oracle** — no longer consulted at
request time (the engine decides). It is retained ONLY as the shadow-equivalence
proof's source-of-truth. Removing it is pure cleanup, blocked on D-D (the
equivalence proof + the record-scoping legacy reads still reference it).
Harmless to keep. Remove together with D-D.

### D-F (MED) — `requireManager` service check: fold into D-D

`project-assignments.service.ts` `requireManager` throws unless
`user.role === 'manager'` (legacy role-string). This is **fail-closed** (more
restrictive than the permission), and aligns with all current users (the
manage-capable users carry JWT `role='manager'`; a pure Agent is already 403'd
at the engine guard before reaching it). It advertises Owner/Admin manage at the
permission layer that the service-layer string-check would reject — but no such
JWT role exists yet (the legacy enum has no admin/owner). Align it when D-D
migrates the service layer off `user.role`. Non-blocking, fail-closed.

---

## Verification ledger (local DB: `postgres@localhost:5432/emapp`)

- Migrations 0043 → 0045 applied to local; `node+pg` queries (psql is NOT
  installed; inline `tsx -e` does not resolve modules in this repo — use
  `node -e` with `require('pg')` from `packages/db`).
- authz API specs: `permissions` + `policy-equivalence` + `policy` (422),
  `permission.service` + `agent-capabilities` (34) — green.
- DB-layer: `iam-foundation-schema.spec.ts` (19) — green after the 0045 pin fix.
- typecheck (`@emapp/api`) + eslint (changed files) — clean.
- Reviewers: code-reviewer PASS; security-reviewer CRITICAL fixed + re-verified.

## What remains before the owner's final merge

1. Broader regression on local (full API suite minus the known-flaky specs noted
   in MEMORY) + the DV-persona regression ("dead controls → ~0").
2. Owner's examination + merge of `iam/fixes` → `main` (no auto-merge).
