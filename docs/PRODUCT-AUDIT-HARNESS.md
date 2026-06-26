# Product audit harness — every page × every role × at fleet-scale, through the technophobe's eyes

The owner's problem: "I walk every page as a technophobe and don't connect with what I see — but I don't know
what to change." This is the REPEATABLE MECHANISM that finds it for you: exhaustive coverage (no page missed),
a fixed technophobe + fleet-scale + role lens (not vibes), and a prioritized "what to change and how" plan.
Run it whenever the product changes. It feeds the build-parallel/verify-serial loop.

## Why a mechanism (not another ad-hoc pass)

Ad-hoc walks miss pages, judge by vibes, and ignore the under-served roles. A mechanism guarantees: (1)
**coverage** — derived from the code, so nothing is skipped; (2) **consistency** — the same rubric on every
surface; (3) **role completeness** — every page walked AS every role that reaches it; (4) **scale** — every
surface judged at the org-of-many-projects level, not one project.

## Step 1 — Coverage inventory (no page missed — derived from code, not memory)

Regenerate the surface list mechanically: `apps/web/src/app/**/page.tsx`, then cross with the 6 roles
(D.17/D.20) by route-group. Current inventory (~67 pages):

| Route group                     | Roles that reach it                                                                   | # pages | State today                                            |
| ------------------------------- | ------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------ |
| `(dashboard)/**`                | **Manager** (full), **Agent** (assigned-projects, PII-masked), **Viewer** (read-only) | ~55     | rich, but manager-centric + many per-project not fleet |
| `(dashboard)/provider/**`       | **Provider Admin** (cross-tenant, MFA)                                                | ~9      | admin subtree                                          |
| `(contractor)/contractor/share` | **Contractor** (external, share-based)                                                | **1**   | ⚠️ one-page stub                                       |
| `(tenant)/portal`               | **Tenant** (resident, SMS-OTP, own record)                                            | **1**   | ⚠️ one-page stub                                       |
| `sign/[token]`                  | public signer (no auth)                                                               | 1       | public surface                                         |
| `(auth)/**`                     | unauth (login/signup/reset/invite/tenant+provider login)                              | ~8      | entry surfaces                                         |

The matrix is **(page × role-that-reaches-it × the actions on it)**. The 3 org roles share the dashboard
pages but experience DIFFERENT data/scope/masking/empty-states — so each must be walked SEPARATELY as that role.

## Step 2 — The lens (the fixed rubric — score every page × role the same way)

For each (page × role), score each axis **PASS / WEAK / FAIL** with a one-line finding + the concrete fix
(reuse the canonical seam, P1). This codifies the technophobe + scale + role experience so it isn't vibes:

- **A1 Situation-picture-at-a-glance (AT SCALE):** open it imagining 100+ projects / thousands of rows. In ONE
  glance, does THIS role grasp the whole state — what's fine, what needs them, what's next — without hunting,
  scrolling a wall, or decoding? (north-star)
- **A2 Fleet / multi-project level:** does the surface aggregate across the org's MANY projects (a fleet view),
  or is it stuck at single-project granularity that an org with 100 projects can't use? _(the owner's named gap)_
- **A3 One-click decision legibility:** for each pending decision — is the state + what's happening + WHY I see
  it + what the action will DO spelled out so a non-technical person decides + acts in ONE click, zero jargon?
- **A4 Errors / empty / loading:** plain-language, never a dead-end, a raw error, or a silent nothing?
- **A5 Role-fit:** is this the RIGHT surface for THIS role's job + mental model? (a contractor sees a different
  world than a manager; a tenant sees only their own record; an agent sees only assigned projects, PII-masked)
- **A6 Autonomy / minimum-actions:** does the system PROPOSE / auto-assign / chase so the user confirms in one
  click — or does it make them hunt + do manual per-item steps?
- **A7 Outcome legibility:** after an action, does the situation VISIBLY change for every affected party (not
  just a 2xx)?

## Step 3 — Fan-out evaluation (exhaustive, parallel, role-aware — read-only = free)

One READ-ONLY audit agent **per role** (manager · agent · viewer · contractor · tenant · provider · public
signer). Each walks EVERY page its role reaches, in the owner's real Chrome AS that role, **seeding/imagining
100 projects**, scores the full rubric per page, and returns STRUCTURED findings: `{page, role, axis, verdict,
finding, fix(seam), severity}`. Read-only agents need no worktree/disk → fan them out without limit (the host
cost is ~0). This is the "look at every page from the technophobe POV, miss nothing" engine — N agents, each
blind to the others, exhaustive together.

## Step 4 — Synthesis → the prioritized change plan ("what to change and how")

Dedup + rank all findings into ONE plan, grouped by **role** and by the **fleet-scale axis (A2)**, each item:
the technophobe-POV problem → the concrete fix (named seam) → severity (BLOCKER/MAJOR/MED) → est. size. The
under-served roles (contractor/tenant one-page stubs) and the missing fleet views surface here as the top items.

## Step 5 — Build (the existing loop)

Feed the ranked plan into build-parallel/verify-serial: capped disjoint builders → each verified by the
INDEPENDENT red-team + the DEEP technophobe walk (numbers-vs-DB, per-role, at scale) BEFORE merge (P2/P3 +
§2 playbook). One module = one PR.

## How to RUN it (repeatable)

1. `Glob apps/web/src/app/**/page.tsx` → regenerate the coverage matrix (Step 1).
2. `bash scripts/dev/preflight.sh`; bring up the env (local-pg API + dev-bypass web); seed ~100 projects if possible.
3. Dispatch the per-role read-only audit agents (Step 3) — in parallel.
4. Synthesize (Step 4) → write the dated change plan (e.g. `docs/PRODUCT-AUDIT-<date>.md`).
5. Build the top items (Step 5); re-run this harness after each wave until a technophobe walk of every
   role's pages, at fleet scale, returns no FAIL.

This is the standing answer to "the system isn't what I wanted but I don't know what to change": the harness
tells you, exhaustively, per page × role × scale — and converges.
