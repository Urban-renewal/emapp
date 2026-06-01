# V12 — Track D2 plan (Provider console + portals + capability UI)

> The "decide-everything-upfront" doc for D2 (the FE/architecture build that
> consumes the D1 BE). The agent runs this end-to-end; the owner verifies at the
> end (D2 is FE/lower-risk — per-slice verification reserved for Track C).
> Grounded in a survey of what already exists (much of the READ scaffold does).

## Decisions locked for D2 (read before building)

- **D.45** onboarding · **D.46** capability matrix + contractor scope · **D.47**
  resident masked PII · **D.48 + D.56** subdomain (built in-place now, cutover at
  PL) · **D.49** provider writes · **D.50** export = read projection ·
  **D.54** read-fidelity + reveal-on-demand · **D.55** 2FA (Track C, NOT here).
- **No `reset-MFA` UI, no per-customer-config UI** in D2 — their BE is deferred
  (D.55 / pending). Provider writes in D2 = **suspend / reactivate only**.

## What already exists (survey) vs the D2 gap

| Area                    | Exists                                                             | D2 builds                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider console        | login, dashboard, tenants list+detail, audit, system-health (READ) | **suspend/reactivate buttons** on tenant detail (BE done #182); access-reason prompt (component exists)                                                                                                                                                                                                                                                                        |
| Onboarding (D.45)       | only `withBootstrap` script (ARCH-2)                               | **BE endpoint** (Provider creates org + first-manager invite, audit-first `withProvider`) **+ FE form**                                                                                                                                                                                                                                                                        |
| Capability UI (D.46)    | members list/detail pages                                          | **role-presets + 6 toggles + `view_owner_pii`** on member detail (invariant pii⇒view_owners reflected); BE done #185-194                                                                                                                                                                                                                                                       |
| Reveal PII (D.54)       | endpoint built (#192)                                              | **"Reveal PII" button** on owner detail → calls `POST /owners/:id/reveal-pii`, shows cleartext (audited)                                                                                                                                                                                                                                                                       |
| Resident portal (D.47)  | base `(tenant)/portal/page`                                        | **full "everything about me"**: project progress, my signatures, documents sent to me, status — masked (D.47). **SCOPE (critical): the resident sees ONLY their own data + project progress as an AGGREGATE (%, counts) — NEVER any other resident's individual data/PII.** RLS/tenant-session scoped; `@security-reviewer` mandatory. May add BE portal-aggregation endpoints |
| Contractor scope (D.46) | contractors + shares pages                                         | **BE scope enforcement** (resolve-share per D.46: aggregate-only progress, owners-PII off, manager-selected docs, IDOR-safe download) **+ FE share-config + contractor read view**                                                                                                                                                                                             |
| admin.emapp.io (D.48)   | provider is a `/provider/*` path                                   | **deferred to PL cutover (D.56)** — NOT built in D2                                                                                                                                                                                                                                                                                                                            |

## Slice groups (sequential; the agent self-paces within)

1. **Provider writes UI** — suspend/reactivate on tenant detail (+ access-reason). FE-only (BE done).
2. **Onboarding** — BE endpoint (Gate-6: provider write + invite) **then** FE form. Owner-approval on the BE/policy touch.
3. **Capability UI** — role-presets + toggles + `view_owner_pii` on member detail (standard SaaS UX: pick role → override per person). FE-only.
4. **Reveal PII button** — owner detail. FE-only (BE done).
5. **Resident portal** — full my-view (progress/signatures/documents/status), masked. FE + any portal-aggregation BE.
6. **Contractor scope** — BE scope enforcement (resolve-share, perms-driven not role-hardcoded — D.46 + lawyer-extensibility) + FE share-config + contractor read view.

## Cadence

- Per slice: branch → test → fix → reviewers (`@code-reviewer` always;
  `@security-reviewer` on anything touching auth/PII/policy/scope) → PR with
  evidence → auto-merge (non-Gate-6) → `gh pr checks --watch` → next.
- **Gate-6 stops** (owner approval, no auto-merge): any touch to `policy.ts`,
  migrations, or `shared-types` breaking change — mainly onboarding (BE) and
  contractor-scope (BE). Most of D2 is FE → auto-mergeable.
- **FE DoD** on every interactive slice: 4-axis browser-smoke + `method="post"`
  - view-source self-check + the `app-forms-no-get-fallback` static check green.

## Quality & performance bar (required on every slice)

- **Low runtime:** every new BE endpoint is round-trip-conscious — **zero N+1**,
  one query per operation (never a query in a loop), use the existing composite
  indexes (PERF-3). All data access via `withTenant`/`withProvider` (inherits the
  locked ≤3 round-trip overhead, #173). FE: TanStack Query caching, **zero
  duplicate fetches**.
- **SOLID / professional:** follow the **existing architecture** — FE
  Wire→VM→Adapter (docs/05 §9.8); BE NestJS module/service + the wrappers.
  **No new pattern/abstraction without a documented reason.** Single-
  responsibility; dependency-injection through the existing NestJS DI.
- **Enforced by:** `@code-reviewer` (hunts N+1 / inefficiency / plaster + DoD) +
  `typecheck` (zero `any`) + `lint` — mechanical walls on every PR.

## Safe-default principle (for decisions that surface mid-build)

The owner has decided everything foreseeable. For anything **unforeseen** that
emerges from the code:

1. **Choose the more conservative / more secure option** (least-privilege,
   masked-by-default, deny-by-default, scope-checked) and **proceed** — do not
   stall the run.
2. **Flag it** in the heartbeat + the end-of-run summary for owner review.
3. **Except** — if it's a genuine architecture/policy fork (a new Gate-6-class
   decision, or it contradicts a locked DECISION), **stop and ask** (like the
   owners-scoping and cleartext-vs-reveal forks in D1).

This lets D2 run to the end without stalling, while never silently making a
risky or spec-contradicting call.

## Verification

D2 is FE / lower-risk → **owner verifies the full batch at the end** (the
per-PR `@security/@code` reviewers stay mandatory — they caught all D1 bugs).
The independent Verifier re-runs `e2e/audit/*` + the new D2 specs after the run.
The fail-open guard (#196) + the existing guards stay green throughout.
