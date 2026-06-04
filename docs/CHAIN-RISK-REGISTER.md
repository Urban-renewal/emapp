# Chain-risk register + structural prevention

A "chain-risk" is any place where the same fact has TWO representations that can
diverge, or where an authoritative store / derived value isn't maintained by all
its write-paths, or where one layer strictly validates data it doesn't control.
Every incident this round (provisioning gap, Viewer over-reach, PII split-brain,
DV-MGR-DOCS) was an instance of ONE of **five classes**. This file is the result
of a systematic sweep of all five — the answer to "did we cover everything, and
are there others?".

**Headline:** the chain-risks are **concentrated + identified**, not scattered.
There is **one** real open cluster (the un-retired legacy authz, Class 2). Every
other class came back clean OR already-fixed, because the codebase mostly uses
the right structural protections (pgEnum, CHECK constraints, tolerant schemas) —
the `document.type` bug was the one place a protection was missing.

## The five classes — sweep result

### Class 1 — authoritative store with incomplete write-path coverage

_(the provisioning gap)_ — the engine reads `role_assignments`; every path that
should maintain it must.

- **Production paths: COVERED** — signup / invite / updateRole / revoke /
  provider-onboard all maintain it (fixed this round), enforced by the
  `iam-provisioning.spec` + `provider-onboarding-provisioning.spec` RED→GREEN
  tests.
- **Open:** `seed-dev.ts` / `seed-volume.ts` create memberships without
  assignments — **DEV tooling only** (a fresh re-seed would brick seed users; the
  current seeded DB is fine via the 0043/0044 backfill). Documented; post-MVP.

### Class 2 — dual source-of-truth (legacy ⟷ engine) — **THE ONE OPEN CLUSTER**

The slice-5a cutover was a PARTIAL strangler: it added the engine but left the
legacy in parallel. Three facets of the SAME cluster:

1. **`user.role` record-scoping** — ~37 BE service sites scope records by the
   legacy JWT role, not assignments. Safe today (role aligns with the assignment
   for all current users); reachable once custom roles exist.
2. **PII capability vs permission** — the BE reveal gate reads
   `memberships.capabilities.view_owner_pii` (legacy); the engine
   `owners.reveal_pii` is seeded-but-inert. The FE was re-pointed to
   `/me.view_owner_pii` (mirrors the BE) to kill the split-brain symptom; the
   root (two stores) remains.
3. **Project membership** — the live flow writes the legacy `project_assignments`
   table; engine project-scope `role_assignments` exist only from the backfill.

- **Disposition:** documented (D-D/D-E). **Fixed by completing the strangler**
  (below). Bounded + not yet reachable (no custom roles).

### Class 3 — FE gate vs BE gate divergence

_(the PII split-brain)_ — FE gates on X, BE on Y, X≠Y.

- **Swept all 23 FE `useHasPermission` gates + the role/capability-based ones.**
  Only remaining instance: `tasks/[id]/page.tsx` gates add/remove-assignee +
  archive on the `/members`-200/403 proxy (`isManager`) instead of the precise
  permission — **PRE-EXISTING, safe direction (under-shows), DV-ORG-9 class.**
  Documented; FE-polish follow-up. No NEW divergence.

### Class 4 — denormalized / derived state not maintained

_(cached counts, aggregates, triggers)_.

- **Verified by the DV cross-entity sync pass: all 5 ripples sync, 0 desync**
  (signature→roles, assignment, archive, share-revoke, provider-suspend). The DB
  triggers found are `updated_at` setters (benign). **Clean.**

### Class 5 — strict validation of data the layer doesn't control

_(the DV-MGR-DOCS document-type bug)_ — a FE strict `z.enum` over a value the BE
owns. **Swept all 14 shared-types enums vs their DB backing:**
| FE enum | DB backing | Verdict |
|---|---|---|
| Project/Apartment/Task/Notification status+type, OrgRole | **pgEnum** (DB-constrained) + FE matches | SAFE |
| `signature_requests.status` | free `text` **+ CHECK `IN (pending,signed,cancelled)`** = FE enum | SAFE |
| audit `action` (87 values) | free `text` — but FE parses it as **`z.string()`** (tolerant) | SAFE |
| audit `actorType` | free `text` — BE writes only user/system/provider = FE enum | SAFE |
| **`documents.type`** | free `text`, **NO constraint**, FE enum was disjoint | **WAS THE BUG → FIXED** (tolerant `z.string()` read + real types) |

- **Result:** `document.type` was the ONLY unprotected instance. Everything else
  is protected by a pgEnum, a CHECK, or a tolerant schema.

## The deep fix to the open cluster (Class 2) — complete the strangler

Collapse to single-source (engine), with the parallel-run + equivalence-proof
discipline so it can't create a new chain. (Full plan: see the chat / the
role-administration slice.) 0. **Parallel-write** project-scope `role_assignments` from the project-assignment
flow + backfill → both representations agree.

1. **Equivalence proof** — a single `resolveAssignedProjects(user)` engine helper
   - a shadow proof that engine-scope == legacy-scope for every user.
2. **Cut the ~37 service sites** over to the helper, one at a time, suite green.
3. **PII unification** — per-assignment `owners.reveal_pii` grant; migrate the
   capability data; BE reveal gate reads the engine; retire the capability flag.
4. **Remove the legacy** — JWT `role` becomes display-only; delete `policy.ts`.

## Structural prevention — make the whole class CI-enforced (so it can't recur)

The protections that already work become **enforced invariants** (tests):

- **Class 2 invariant** — a source-scanner test (like the existing
  `agent-capability-guard.ts`) that FAILS if any request-time authz decision
  reads `user.role` / `capabilities.view_owner_pii` / imports `policy.ts`.
- **Class 1 invariant** — a test that every membership-creating path produces a
  resolvable assignment (the provisioning specs already do this; extend to any
  new path).
- **Class 5 invariant** — a test/lint that FAILS if a shared-types field is a
  strict `z.enum` over a DB column that is free `text` with NO CHECK (forces
  either a CHECK, a pgEnum, or a tolerant `z.string()`).
- **Class 3 invariant** — assert FE gate-permission == BE `@RequirePermission`
  for each gated action (extend the conformance proof).
- **Class 4** — the cross-entity sync e2e already guards the ripples; keep it.

With these, a future change CANNOT silently re-introduce a dual-system / an
unmaintained store / an unprotected enum — the CI goes red. That is the real,
deep fix to the _class_, not just the instance.
