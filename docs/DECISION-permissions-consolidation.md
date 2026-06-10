# DECISION — Permissions consolidation (P2 Phase 0)

> Status: **DONE / documented.** 2026-06-10. Outcome of the P2 Phase-0 investigation.
> No behavior change. No migration. The single-source consolidation already happened
> in IAM slice 5a; this records that finding + the safe cleanup.

## TL;DR

**P2 Phase 0 ("consolidate to a single source of truth, zero behavior change") is
already complete.** The investigation found the IAM engine is the live, single
authorization source; there is no residual "mess" to consolidate. The only action
taken was correcting a stale docblock and writing this record. The shadow-equivalence
proof is **retained** as a permanent guardrail (not deleted).

## The single source of authorization (LIVE)

- `PermissionService.can(user, permission, scope)` (`apps/api/src/common/authz/permission.service.ts`)
  resolves every decision from **`role_assignments ⋈ role_permissions`** + the
  implication closure (`permissions.ts`). Default-deny.
- `AuthorizationGuard` (`authorization.guard.ts`) calls `can()` for **every**
  `@RequirePermission(...)` handler. A handler with no `@RequirePermission`/`@TenantScoped`
  is fail-closed (403). This is the only coarse-authz path at request time.
- The catalog (`permissions.ts`, 53 permissions) + the 6 system roles
  (`system-roles.ts`: owner/admin/manager/agent/viewer/external_read) are seeded to the
  DB by migrations 0043–0047. They are the authoritative role→permission mapping.

## What `policy.ts` is now (NOT the enforcer)

`policy.ts` (the legacy 17×4 role→action matrix) is **not consulted at request time**.
Its only consumers are:

- `policy-equivalence.spec.ts` — the **shadow-equivalence proof**: asserts the engine's
  decision ≡ the legacy matrix for every role×permission, except a documented set of
  `KNOWN_DIVERGENCES` (12 cells, Type-A agent operational writes, capability-fine-gated).
- the D.54 architecture/fail-open scanner (`agent-capability-guard.ts`).

**Decision: KEEP `policy.ts` + the equivalence proof.** Deleting them (the notional
"slice 6") would remove a continuously-running guardrail that proves the engine still
matches the intended matrix, for zero runtime benefit (they are test/architecture
artifacts, not request-path code). Retaining them is the more professional, lower-risk
posture. `PROVIDER_POLICY` / `canProvider()` in the same file is a **separate live tier**
(D.49) and is untouched.

## The residual `user.role` reads are intentional (NOT coarse authz)

~30 service sites read `user.role`. These are **record-level scoping**, downstream of the
coarse permission gate, and are correct as-is:

- **Agent → assigned-project filtering** (apartments/buildings/documents/imports/notes/owners):
  which _rows_ an agent may see/touch, enforced against live `project_assignments`.
- **Manager-only operations with no agent path** (`requireManager()` in
  contractors/owners-create/ownerships/project-assignments/projects/shares).
- **Authorship gates** (notes: author may edit/delete own; manager any).
- **Capability fine-gates** (`requireAgentCapability` reads `memberships.capabilities`,
  D.46/D.54) — a per-assignment discretionary layer, orthogonal to the role→permission engine.

These gate on **live data** (assignments, authorship, capability flags), not on `policy.ts`,
so they are not "duplicate sources of truth" — they are a distinct, intentional scoping layer
(the documented D-D residual, pinned by `authz-single-source.spec.ts`).

## Actions taken (this slice — safe, no migration, self-merge)

1. Corrected the stale `permission.service.ts` docblock ("SLICE 2 — NOT YET WIRED" →
   the accurate "LIVE, single source since slice 5a").
2. Wrote this decision record.

## What is actually next (the real P2 value)

Phase 0 being already-done means the value is in the later phases the owner asked for:

- **Phase 1 — custom permission groups** — ✅ DONE (PR #337): org-defined roles on the
  existing engine, anti-escalation (subset + Owner-only governance), no migration.
- **Phase 2 — per-user overrides** — ✅ DONE (PR #338, Gate-6 held): grant/deny a
  permission to a member; engine resolves `(role ∪ grant) − deny`, deny-wins.
- **Phase 3 — provider parity** — **DECISION (2026-06-10): FOLD INTO P4, do not build a
  separate provider IAM.** Rationale: the provider tier (Tier-3) is small, isolated
  (`emapp-provider` audience, MFA, AccessReasonGate) and its access-control need is
  **provider sub-roles** (e.g. `provider_viewer` read-only vs full Provider Admin) — which
  is exactly the `roles`/`staff` work already scoped in `docs/PLAN-provider-console.md`
  (P4 Tier-2 #4). Building a parallel custom-role/override engine for ~a handful of
  vendor staff would be over-engineering. The org-tier engine (Phases 0–2) already gives
  the rich model where it matters (customer orgs). Provider sub-roles will reuse the same
  `roles`/`role_assignments` primitives when P4 builds them. **Net: Phase 3 closed; its
  intent is delivered as the P4 provider-sub-roles slice.**
