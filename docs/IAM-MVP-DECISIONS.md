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
  **FE half (DV-ORG-9 dead-control killed).** The assignments page gated its
  write controls on `isManager = membersQuery.isSuccess` — TRUE for a Viewer
  (holds `members.read` → `/members` 200s) who lacks `project_assignments.manage`
  → Viewer saw a form that 403s on submit (dead control). Pre-existing, but only
  now fixable because the BE exposes the precise permission. The page now gates
  writes on `useHasPermission('project_assignments.manage')` (slice-5b
  single-source FE gate), keeping `/members` only for the dropdown/name lookup
  (Manager reaches it via the `export.run ⇒ members.read` closure). Manager sees
  the form; Viewer/Agent do not. web typecheck + eslint clean; FE assignment
  specs (20) + no-GET-fallback DoD green; code-reviewer **PASS**.

### D-G — Assignment PROVISIONING gap (CRITICAL — found + fixed this round)

**Problem (production-breaking).** The slice-5a cutover made the engine
(`AuthorizationGuard` ⋈ `PermissionService`) the live authorization gate on all
27 org controllers — it resolves permissions from `role_assignments`. A one-time
migration backfill (0043/0044) created assignments for users that existed THEN,
but **no application code path created/updated/removed a `role_assignments`
row** — not signup, not member-invite, not invite-accept, not role-update, not
revoke. So in production: every NEW signup is locked out of their own org; every
newly-invited member is locked out (403 everywhere) even after accepting; role
changes don't take effect (engine resolves the STALE set); revoked members could
retain grants. The pre-existing test suite passed because those specs SEED
`role_assignments` themselves via raw SQL — a setup biased toward the author,
which masked the gap.

**How it was caught (methodology — owner's anti-bias requirement).** Author/
reviewer/fixer were SEPARATE agents: (1) a test agent wrote 5 RED lifecycle tests
that drive the REAL service methods (`signup`/`create`/`acceptInvite`/`updateRole`
/`revoke`) and assert effective permissions THROUGH THE ENGINE, never seeding an
assignment; (2) an INDEPENDENT reviewer adversarially verified the tests are
honest, complete, and non-vacuous (esp. the revoke test asserts a non-empty set
BEFORE revoke so it can't pass trivially) — PASS; (3) a different agent wrote the
fix; (4) code + security reviewers passed it. The 5 tests fail RED on the old
code (engine resolves `[]`) and GREEN on the fix.

**Fix.** Provision org-scope `role_assignments` in all four lifecycle paths,
atomic with the membership op, audited (`role.grant`/`change`/`revoke`, no PII):
signup → OWNER (D-A); invite → the role-matched system role; updateRole →
retarget the assignment; revoke → delete the user's assignments.

**Hardening from review (2 findings, both fixed + re-reviewed PASS).**
(a) `updateRole`'s retarget set excludes Owner/Admin (`manageableRoleIds` =
manager/agent/viewer only) so a member role-change can never strip/clobber an
Owner/Admin grant, and the defensive insert fires only when the target has NO
org-scope system assignment (no double-grant). (b) `revoke` now deletes ALL the
user's assignments in the org (org + project scope) via a `user_id` predicate
scoped by the `tenant_isolation` RLS USING clause (can't reach another org), so a
project-scope leftover can't re-grant on rejoin.

**Verified.** 5/5 provisioning tests GREEN; full `@emapp/api` suite green on the
local DB; typecheck + eslint clean; spec byte-identical through the fix (the fix
author did not weaken the tests). code-reviewer + security-reviewer **PASS** (the
original CRITICAL + both MEDs resolved; 0 open findings).

**Follow-up NIT (non-blocking, both reviewers agreed):** the Owner-preservation
(updateRole can't strip an Owner) and project-scope-revoke behaviors are
DEFENSIVE for scenarios UNREACHABLE in MVP (no app path mints a 2nd Owner/Admin;
no app path creates a project-scope `role_assignments` row at runtime — the live
project-assignment flow writes the legacy `project_assignments` table, see D-D).
They are provably correct by code inspection but not end-to-end testable without
biased seeding. Add the regression tests alongside the role-administration slice
(below), when those scenarios become reachable.

### D-G.2 — Second provisioning instance: PROVIDER ONBOARDING (found by audit + fixed)

After fixing signup/invite, a SYSTEMATIC AUDIT of every membership-creation site
(reconciled against every `role_assignments` mutation) found a SECOND instance of
the same class: **`ProviderOnboardingService.onboard`** (a Provider Admin creating
a tenant org) created the org + first-manager membership but NO assignment → the
onboarded manager would be locked out on accept. Fixed identically: an org-scope
**OWNER** grant for the founding user, inside the same `withProvider` (BYPASSRLS)
tx, `grantedBy: null` (provider-initiated; the FK references org users and the
actor is a `provider_user`, mirroring `invitedBy: null`). Same anti-bias flow: a
LOCKED RED test (`provider-onboarding-provisioning.spec.ts`) drives the real
`onboard()` and asserts the OWNER set through the engine (never seeds an
assignment); fix by a separate agent (spec byte-identical); code + security
reviewers **PASS** (0 findings). Verified: provisioning spec GREEN; full provider
suite (133) green; typecheck + eslint clean.

**Audit result — the class is now closed for PRODUCTION paths:** the only
remaining membership-creators are the **seed scripts** (`seed-dev.ts`,
`seed-volume.ts`) — DEV/DEMO tooling, not production. They insert memberships
without assignments, so a FRESH re-seed of a dev DB would leave seeded users with
zero engine permissions (the current local/seeded DBs are fine — the 0043/0044
backfill covered them at migration time). Fixing the seeds is a low-priority
DEV-tooling follow-up (no production impact). `members.service.updateCapabilities`
(membership `capabilities` JSONB) is orthogonal to the role/permission set (the
legacy D.54 PII-reveal flag, see D-D) — not a provisioning gap.

**Surfaced future slice (NOT a gap in current behavior):** there is **no
org-role administration API** yet (assign/revoke org roles, create Admins,
custom roles). `canAssignRole` (the anti-escalation tier guard) exists but has no
caller. Role administration is currently only the member-invite/role-update
surface (capped at manager/agent/viewer). Building the Admin/custom-role
administration API — with `canAssignRole` wired + the D-G defensive tests — is
the natural next enterprise slice.

### D-H — Pre-merge ADVERSARIAL audit (3 fresh-eyes reviewers): findings + fixes

Before opening the merge PR, three independent adversarial reviewers were run on
the whole stack (RLS/migrations, auth-core correctness, cross-cutting/legacy-
coexistence), each with a "try to break it" mandate. The auth DECISION logic
came back clean (no fail-open, no wrong-allow/deny, honest equivalence proof,
complete cutover, expired-grant exclusion in the single decision path). Two real
issues were found that the per-slice reviews had missed — both fixed via the same
test→fix→review flow, both re-reviewed:

**D-H.1 — 2× CRITICAL: cross-tenant DELETE of SYSTEM roles (RLS) — FIXED.**
In 0043, the `roles` + `role_permissions` `tenant_isolation` policies used a
single `FOR ALL` policy whose `USING` admitted system rows (`org_id IS NULL`)
cross-org (so every tenant can READ the seeded roles). The Postgres gotcha:
**DELETE is authorized by `USING` only** (`WITH CHECK` does not apply to DELETE),
so any tenant's `app_user` could `DELETE` a system role / its permissions —
wiping them GLOBALLY for every org (proven live: rowCount=64). INSERT/UPDATE were
correctly blocked; only DELETE leaked. Not reachable via the current API (no
endpoint DELETEs roles), but a genuine breach of the RLS last-line boundary that
becomes reachable with custom-role management. **Fix:** migration `0046` splits
each policy — a `FOR ALL` policy scoped to own-org (governs INSERT/UPDATE/DELETE)
plus a `FOR SELECT` policy re-adding the cross-org system read (permissive
policies OR per command). RED probe-based tests (throwaway never-assigned system
roles, non-destructive) added to `iam-foundation-schema.spec.ts` assert the
cross-tenant DELETE removes 0 rows. Verified: 21/21 green (DELETE blocked, cross-
org SELECT preserved, custom-role isolation + UPDATE-blocked intact). Both
reviewers PASS; both independently swept all migrations and found NO other table
with this pattern. Gate-6 (migration) — owner sign-off = the merge approval.

**D-H.2 — MEDIUM: owner-PII reveal FE/BE split-brain — FIXED.**
The BE reveal endpoint gates on the LEGACY capability model (`resolveOwnerPiiFidelity`:
manager always · agent iff its `view_owner_pii` capability · viewer never), and
`/me` exposes `view_owner_pii` computed by that same logic. But slice 5b had
switched the FE reveal button to `useHasPermission('owners.reveal_pii')` (the
engine permission) — which an agent granted the capability does NOT hold (the
engine agent role excludes `reveal_pii`; no per-assignment grant path exists
yet). So an org could grant an agent PII access and the new FE would silently
HIDE the button (direction = UNDER-exposure / dead control — NOT a leak; the BE
remained authoritative). **Fix:** the FE button now gates on `/me.view_owner_pii`
(the field that mirrors the BE authority), so FE === BE across all roles;
forward-compatible (when `reveal_pii` migrates to a per-assignment engine grant,
`/me.view_owner_pii` moves with the BE gate). code-reviewer PASS. This corrects
the D-D framing, which had understated the reveal-gate divergence.

**Documented NITs from the audit (non-blocking):** orphan `role_assignments`
rows on org/project hard-delete (`scope_id` has no FK — but orphans never resolve:
a deleted org has no RLS context, a deleted project is never a check target);
roster/engine drift if an Owner is demoted via the member surface (safe direction,
documented); test-factory orgs created without an Owner assignment (fixture drift,
not production — real orgs get an Owner via signup/onboard).

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
- **Full `@emapp/api` suite on local: 80 files, 983 passed, 199 skipped, 0
  failed** (56s) — includes the historically-flaky specs (provider-audit,
  imports.s8, export.s10); the ERROR lines in the log are synthetic test
  scenarios, not failures.
- FE: web typecheck clean; eslint clean on the changed page; FE assignment
  adapter+api specs (20) green; `app-forms-no-get-fallback` DoD check green.
- typecheck (`@emapp/api` + `@emapp/web`) + eslint (changed files) — clean.
- Reviewers: code-reviewer PASS (BE + FE); security-reviewer CRITICAL fixed +
  re-verified.

## What remains before the owner's final merge

1. Owner's examination + merge of `iam/fixes` → `main` (no auto-merge). The
   integration branch carries the full verified stack (slices 1-5b → 0044 Owner
   backfill → project-assignment BE+FE → this decisions doc).
2. Post-MVP (additive, non-breaking, documented above): D-C caching (with
   Redis), D-D record-scoping → assignment-model, D-E `policy.ts` removal.
