# NEXT SESSION — START HERE (read this BEFORE changing anything)

You are picking up a long autonomous gap-closing run. **Do not touch code until you
have read this whole file + the "read order" below.** The most dangerous next task
(owner/renter) alters a LOCKED, high-blast-radius DB trigger — understanding-first is
not optional.

---

## 1. The big picture in 60 seconds

EMAPP = B2B SaaS for Israeli urban renewal (תמ"א 38 / פינוי-בינוי) — apartment-owner
signature collection, MVP-scoped, 6 roles / 3 tiers. The previous session closed ~14
gaps (all blockers + clear highs) found via a 6-persona walkthrough. The product is
now "ready to connect accounts" for the blocker/high tier — what remains is feature
work that needs a clean context (this doc exists because the prior session ran deep).

**Your job this session:** build **Feature A (owner / renter distinction + inline
person entry)**, then **import-complete** + the **remaining notification types**. All
are designed/decided already — see the read order.

## 2. READ ORDER (do not skip — in this order)

1. **`CLAUDE.md`** (repo root) — stack (NestJS+Fastify, Drizzle, Next 15, RLS+pgcrypto),
   the HARD RULES (withTenant/withProvider for every read; no `any`; Zod DTOs; /api/v1;
   `{data}` envelope; `national_id` not `tz`; PII encrypted+never-logged; soft-delete=
   archivedAt), the 6 roles, and the autopilot/DoD protocol.
2. **`docs/DECISIONS.html`** — the LOCKED decisions (D.01–D.54+). **D.25** (ownership sum
   = 100% trigger) is the one you're about to touch — read it.
3. **`docs/FEATURE-owner-renter-design.md`** — the implementation-ready plan for Feature
   A (migration SQL + trigger change + service + signature-flow + FE inline). Follow it.
4. **`docs/DECISIONS-FOR-OWNER.md`** — the owner's decisions from last session. The ones
   that gate your work: **D-O7** (notification routing) + the owner/renter answers in
   §"this doc top". Confirmed: **renter ownership_pct = 0** (column stays NOT NULL; the
   trigger sums only `relationship='owner'`); **renter counts as a "resident" in display
   counts but NEVER in the consent math** (only owners sign / are counted toward 66/80%).
5. **`docs/PERSONA-GAP-CATALOG.md`** — the full gap picture + what's already closed.
6. The auto-loaded **MEMORY** (shows at session start) — RLS/pool model, migration
   gotchas, known flaky tests. Trust it.

## 3. Architecture you MUST hold before editing

- **RLS / pools:** raw `db` connects as a BYPASSRLS role. `withTenant(orgId, fn)` runs
  `SET LOCAL ROLE app_user` + sets the org GUC → RLS-subject. `withProvider(...)` =
  BYPASSRLS (provider tier). `withBootstrap` = signup only. A drizzle NESTED tx
  (SAVEPOINT) does NOT preserve `SET LOCAL ROLE app_user` — never rely on it for RLS.
- **Authz is layered (don't re-introduce the split-brain):** coarse engine
  (`AuthorizationGuard` + `@RequirePermission` + `PermissionService.can()`) AND fine
  service gates (`requireAgentCapability` / `requireManager`). `/me` emits the agent's
  EFFECTIVE permissions (role ∧ capability) via `agent-effective-permissions.ts` — a
  drift-guard test pins it. If you add an agent-write permission, add it to that map or
  the build fails (by design).
- **Owners/renter model:** `owners` table = the person (name/national_id/phone encrypted).
  `ownerships` = person↔apartment link with `ownership_pct` + a free-text `role`. You are
  ADDING `relationship: owner|renter`. The D.25 trigger `trg_ownerships_sum_check`
  enforces sum∈{0,100} per apartment — change it to sum WHERE relationship='owner'.
- **Signatures/SMS:** signature link = single-use 7-day JWT (jti unique). SMS is behind
  `ISMSProvider` (Noop in dev — the OTP/link code prints to the API console; Inforu in
  prod once keys land). Renters must NOT receive signature requests.

## 4. ⚠️ DANGER ZONES (where prior sessions got bitten)

- **The D.25 trigger migration is high blast radius** (every apartment). Hand-author the
  `.sql` + a `_journal.json` entry (`when` = prev max + 86400000); `drizzle-kit generate`
  is unusable here. **VERIFY ON A LOCAL Postgres FIRST** (the migrator defaults to
  `DATABASE_MIGRATE_URL`=Neon — override to local). Prove: existing apartments still
  validate; a renter (pct 0) doesn't break a 100% apartment; owners summing to 90 still
  REJECT. Get a security review on the trigger before merge.
- **Adding a REQUIRED field to a shared-types schema cascades** to every FE mock/fixture
  (MSW samples, e2e `mock-backend.ts` `SEED_*`, unit-spec fixtures). Sweep them all (the
  suspended-badge + document-notify PRs are the template) or CI typecheck/e2e fails.
- **`gen:api-docs --check` is a BUILD GATE** — after any endpoint/schema change run
  `infisical run --env dev -- pnpm --filter @emapp/api gen:api-docs` and commit the
  regenerated `docs/09-api-reference.generated.md`.
- **The `app-forms-no-get-fallback` static check** greps for the literal `<form` — don't
  even put it in a comment. Every real `<form>` needs `method="post"`.
- **Adding a notification ENUM value (import-complete) is a migration** — `ALTER TYPE
notification_type ADD VALUE 'import_completed'` (+ shared-types + db enum). Additive,
  low-risk, but still a migration → verify locally.
- **Known flaky tests** (rerun, don't debug, when your diff doesn't touch them):
  `signature-progress-perf` (planner index choice — already de-flaked to accept either
  status index), provider-audit / self-audit (shared-DB row pollution — seed far-future
  timestamps + assert by id), imports.s8 (R2 purge timing).

## 5. The discipline (non-negotiable — the owner explicitly asked)

- **SOLID + DRY + NO PLASTER (D.51):** fix the root cause, not the symptom. No
  org-wide-then-filter-in-JS, no swallowed errors, no magic constants. One definition,
  reused.
- **builder ≠ test-author ≠ reviewer:** after building, dispatch a SEPARATE test-author
  agent (real-DB, adversarial) and a SEPARATE security-reviewer agent. They have caught
  real bugs every time. The human is the final gate.
- **Verify before you "fix":** the prior session twice found a flagged "gap" was actually
  a documented decision (agent task-by-assignee). Read the code's intent first.
- **Per-PR loop:** branch → build → typecheck+lint → separate test-author → security
  review → fix findings → commit → push → PR → watch CI green → self-merge → sync main.
  NEVER push to `main` directly (the prior session slipped on this twice — always
  `git branch --show-current` before committing).
- **Paid APIs (SMS/domain):** build to the API-KEY boundary, stub (Noop/env), document
  the go-live steps. Never block on a real key — that's prod-only.

## 6. The task list (in order)

1. **Feature A** — owner/renter + inline entry, per `FEATURE-owner-renter-design.md`.
   Schema → migration (the careful part) → service → signature-flow (exclude renters) →
   FE (owner/renter toggle + inline create). Tests + security review on the trigger.
2. **import-complete** — `notification_type` enum add + emit on import finish to the user
   who ran it.
3. **Remaining notification types** (per D-O7): apartment_status_changed + note_added →
   project's assigned agents (reuse the `document_uploaded` pattern in
   `documents.service.ts`); share_revoked → the manager who revoked; mention → skip (MVP).
4. (optional) per-project agent capabilities — a bigger data-model change; confirm with
   the owner first (it's the only remaining "manager grants permissions" enhancement; the
   per-entity-TYPE grant already works via members → capabilities).

Open the run with: _"Read docs/NEXT-SESSION-HANDOFF.md, then start Feature A."_
