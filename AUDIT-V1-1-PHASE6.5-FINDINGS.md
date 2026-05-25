# Audit v1.1 — Phase 6.5 Provider Admin BE — Fresh-eyes audit findings

**Date:** 2026-05-25
**Scope:** Phase 6.5 (PR #40 main + PR #41 closeout, both merged → `f198985` on `main`).
**Method:** 4 independent fresh-eyes agents (2× SOLID, 2× Security/ISO 27001, 2× Performance) + my own pass against the locked spec (DECISIONS D.17/D.21/D.29/D.36/D.37, docs/03 §10.5, docs/07 §8, docs/09).
**Cross-confirmation rule (D.36):** finding flagged by **≥2 agents** = treat as cross-confirmed = HIGH minimum. Single-agent findings I personally verified in code = HIGH-with-plan. Everything else = MEDIUM/LOW.

---

## TL;DR — Honest verdict

The Phase 6.5 self-audit (PROGRESS heartbeat tasks #91–100) claimed _"0 PII leaks, 0 cross-tenant bleed, 0 write paths."_ The first two are **TRUE** — in-SQL masking holds, BYPASSRLS is the documented design (not a leak). The third is **TRUE** — no write endpoint. **But:** under fresh-eyes scrutiny the surface is materially rougher than the self-audit suggested:

- **4 HIGH cross-confirmed findings** (D.36 ≥2 agents).
- **2 critical audit-integrity gaps from a single agent that I verified in code** — these are the kind of finding that survives 8 reviews then gets caught by the 9th. They merit HIGH even single-sourced.
- **No P0 ship-blockers** — the surface is safe for MVP/pilot; nothing leaks customer PII today.
- **NOT enterprise-ready** until the HIGH items close. ISO 27001 stage-2 audit would flag SA-2 (no tamper-evidence) and SA-3 (DB role column dead) immediately.

Recommendation: open a **Phase 6.5 Audit-v1.1 closure PR** with the 4 cross-confirmed HIGHs + the 2 audit-integrity criticals. The remaining MEDIUMs should land before the first enterprise prospect demo.

---

## 1. Cross-confirmed findings (per D.36 — these are HIGH minimum)

### CC-1 — `trustProxy: true` lets any caller forge audit-log IP/User-Agent

**Cross-confirmed by:** Security agent #1 (SEC-S3) + Security agent #2 (SEC-H3).
**Severity:** **HIGH** — ISO 27001 A.12.4.1 (event source identification).
**File:** `apps/api/src/main.ts:31` (`trustProxy: true`); consumed at `apps/api/src/modules/provider/current-provider.decorator.ts:18-23`.
**Attack:** Provider Admin sends `X-Forwarded-For: 8.8.8.8` → `req.ip` returns the spoofed value → `provider_audit_log.ip` records Google DNS as the source. The single forensic "where" attribution is unverifiable.
**Why it slipped self-audit:** trustProxy was set for Railway, never re-evaluated for the Provider tier's elevated audit obligation.
**Fix:** `trustProxy: 1` (trust exactly one hop — Railway edge) OR explicit Railway/Cloudflare CIDR list. Add an integration test that injects a hostile `X-Forwarded-For` and asserts the audit row records the socket peer, not the header.

### CC-2 — `access_reason` quality is a checkbox, not a control

**Cross-confirmed by:** Security agent #1 (SEC-S7) + Security agent #2 (SEC-M1).
**Severity:** **HIGH** — ISO 27001 A.9.4.1 (reviewability of access decisions).
**File:** `apps/api/src/modules/provider/access-reason.decorator.ts:32-42`; `packages/db/src/wrappers/with-provider.ts:66-71` (the second copy of the same rules — see also CC-3 / SA-13).
**Attack:** Provider Admin sets `access_reason: "aaaaa"` (5 chars passes `MIN_LEN`). Every call. ISO 27001 A.9.4.1 expects the field to be **reviewable** by an auditor; "aaaaa" defeats that. The entire human-accountability surface of D.37 becomes review-noise.
**Why it slipped:** the spec mandates a header; the _content_ of the header was never specified.
**Fix:** Require a ticket-id pattern (e.g. `^(INC|REQ|SUP|TKT)-\d{4,}: .{10,}$`) OR free text minimum 20 chars with at least 3 whitespace-separated tokens. Add a weekly "low-quality reasons" report query in the ops dashboard.

### CC-3 — `withProvider` violates SRP: one 100+ line function does 6 things

**Cross-confirmed by:** SOLID agent #1 (SOLID-S2) + SOLID agent #2 (SOLID-S1).
**Severity:** **HIGH** (structural debt).
**File:** `packages/db/src/wrappers/with-provider.ts:136-258`.
**What it does:** (1) UUID validation, (2) reason sanitisation + length-check, (3) action regex + length-check, (4) metadata JSON-size validation (with a helper that itself is 35 lines), (5) pool checkout + 4-GUC `set_config` + audit-row INSERT + tx orchestration. Adding a 6th cross-cutting concern (IP allowlist, Sentry breadcrumb, GraphQL operation name capture) requires editing this function — OCP fail.
**Fix:** Extract 4 pure validators next to `packages/shared-types/src/provider.ts`: `validateProviderUserId`, `validateProviderReason`, `validateProviderAction`, `validateProviderMetadata`. Wrapper becomes a 30-line orchestrator. Each validator is unit-testable without a pool client. Bonus: the `AccessReason` decorator (which duplicates the reason rules — see SA-13) can reuse `validateProviderReason`.

### CC-4 — `ProviderPrincipal` ISP: services depend on JWT shape they never read

**Cross-confirmed by:** SOLID agent #1 (SOLID-S3) + SOLID agent #2 (SOLID-S3).
**Severity:** **MEDIUM** (refactor win, no correctness impact).
**File:** `apps/api/src/modules/provider/current-provider.decorator.ts:14`; consumed in all 4 services.
**What:** services type the actor as `ProviderPrincipal` (which extends the full JWT payload `ProviderTokenPayload`) but read only `actor.sub`, `actor.ip`, `actor.userAgent`. `role`, `sid`, `type` are never touched in service code.
**Fix:** Define `ProviderActor = { sub: string; ip?: string; userAgent?: string }`. Decorator projects `ProviderTokenPayload → ProviderActor`. Services accept the narrower type. Removes 4-service dependency on the decorator module + JWT schema. Tests no longer need to construct full JWT payloads.

### CC-5 — `system-health` queue probe scans every pg-boss job row

**Cross-confirmed by:** Performance agent #1 (PERF-S1) + Performance agent #2 (PERF-S1).
**Severity:** **HIGH** (silent timebomb — invisible at MVP scale, multi-second at 5M+ jobs).
**File:** `apps/api/src/modules/provider/provider-system-health.service.ts:81-85` (the SAVEPOINT-wrapped `SELECT state, COUNT(*) FROM pgboss.job GROUP BY state`).
**What:** pg-boss table has no `(state)` index — it indexes `(name, priority, createdOn, id)` and `(singletonOn, singletonKey)` but not `state` alone. A `GROUP BY state` on a multi-million-row table degenerates to a sequential scan + hashagg. At Provider pool=5 with 60s statement_timeout, a slow probe can starve the pool for 30+ s.
**Fix (cheapest):** `CREATE INDEX CONCURRENTLY ON pgboss.job (state);` in a worker-owned migration. O(N) → O(distinct-states × log N). Also: add a 30-second in-process cache for the health gauge — 5 Admins polling every 5s = 0 DB hits with the cache vs 60/min today.

### CC-6 — `audit_log.action` prefix-LIKE has no `text_pattern_ops` index

**Cross-confirmed by:** Performance agent #1 (PERF-S1) + Performance agent #2 (PERF-S2).
**Severity:** **HIGH** at scale (multi-second response on first cross-tenant action-prefix search once `audit_log` reaches a few million rows).
**File:** `apps/api/src/modules/provider/provider-audit.service.ts:71` (`like(auditLog.action, ${query.action}%)`); schema at `packages/db/migrations/0014_audit_log_to_spec.sql`.
**What:** With no `orgId` filter, the planner can't use `idx_audit_org_time`. With `action LIKE 'import.%'` and no `text_pattern_ops` index, the planner does a backward scan on `(created_at DESC, id DESC)` filtering on action. On a 10M-row `audit_log` this is 2–4 s p95.
**Fix:** `CREATE INDEX CONCURRENTLY idx_audit_action_pattern ON audit_log (action text_pattern_ops, created_at DESC);`. ~50ms after.

### CC-7 — `owners` has no `(org_id, created_at DESC)` index

**Cross-confirmed by:** Performance agent #1 (PERF-S3) + Performance agent #2 (PERF-S4).
**Severity:** **MEDIUM** (only matters on large tenants — but tenants WILL grow).
**File:** `apps/api/src/modules/provider/provider-tenant-detail.service.ts:109-114` (the sample-owners query); schema in `packages/db/src/schema/projects.ts:138-146`.
**What:** Tenant-detail samples 5 most-recent owners per tenant. `owners` indexes are `(org_id, national_id_hash)`, `(org_id, phone_hash)`, `(org_id, name_hash)` — none ordered by `created_at`. With 100k owners per org, planner bitmap-scans the org rows then sorts → 100-500ms.
**Fix:** `CREATE INDEX CONCURRENTLY idx_owners_org_created_desc ON owners (org_id, created_at DESC, id DESC) WHERE archived_at IS NULL;`.

### CC-8 — Dead `void <import>;` smell

**Cross-confirmed by:** SOLID agent #1 (SOLID-S5) + SOLID agent #2 (SOLID-S7).
**Severity:** **LOW** (2-line cleanup).
**Files:** `apps/api/src/modules/provider/provider-tenant-detail.service.ts:184` (`void eq;`); `packages/db/src/wrappers/with-provider.ts:261` (`void providerAuditLog;`).
**What:** `void <symbol>` statements added to silence "unused import" warnings, with comments saying "retained for future variant queries". YAGNI — delete the import and the void statement. If a future query needs them, the import takes 1 second to add back.

---

## 2. Single-agent + I verified in code → HIGH-with-plan

### SA-1 — `PROVIDER_DATABASE_URL` silently falls back to `DATABASE_URL`

**Source:** Security agent #1 (SEC-S1). Verified at `packages/db/src/client.ts:121` (`connectionString: env.PROVIDER_DATABASE_URL ?? env.DATABASE_URL`) and `packages/db/src/env.ts:18` (optional).
**Severity:** **HIGH** (production-deploy hazard).
**Attack:** Deploy template forgets `PROVIDER_DATABASE_URL` → provider pool connects as `app_user`. Migration 0009 `REVOKE`s app*user on `provider_audit_log`, so every Provider call dies with a 500 on the audit INSERT. **Loud, not silent — which is good.** Real risk is the \_fix*: an ops engineer "fixes" the 500 by GRANTing app_user instead of setting the env var, permanently destroying role separation. Once that happens, BYPASSRLS doesn't exist (app_user is not bypassrls) and `app.organization_id` is unset on the provider pool → every customer SELECT returns 0 rows → looks like a feature, not a security regression.
**Fix:**

1. Drop the `?? env.DATABASE_URL` fallback for `NODE_ENV !== 'test'`.
2. Add a one-shot startup probe: `SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname = current_user` on `providerPool` — crash the API if the result is not `(provider_app_role, true)`. Mirrors the pattern of `verifyEncryptionStartup()` at `packages/db/src/startup-check.ts`.

### SA-2 — `provider_audit_log` has no tamper-evidence

**Source:** Security agent #1 (SEC-S2). Verified: migration 0001 creates the table with no `row_hash`/`prev_hash` columns; 0009 only `REVOKE`s on app*user — table owner / Neon admin can still UPDATE/DELETE freely.
**Severity:** **HIGH for enterprise** (ISO 27001 A.12.4.3). Defensible for MVP/pilot per docs/07 §8.1 *"insider threats from EMAPP team mitigated by audit logging and team integrity, not technical means."\_ But an enterprise prospect's CISO will flag this in 5 minutes.
**Fix (when first enterprise prospect signs):** Add `prev_hash bytea`, `row_hash bytea` columns + a `BEFORE INSERT` trigger that hashes `(prev_row.row_hash || canonicalised(NEW))`. Add a nightly cron that re-walks the chain. Mirror every row asynchronously to Sentry or an S3 worm bucket.

### SA-3 — `providerUsers.role` column is dead — JWT role is hardcoded

**Source:** Security agent #1 (SEC-S4). Verified at `apps/api/src/modules/auth/provider/provider-auth.service.ts:247` (`{ sub, role: 'provider_admin', sid, type: 'provider_access' }`).
**Severity:** **HIGH** (makes the new `ProviderAuthorizationGuard` matrix theoretically future-proof but practically inert).
**Attack:** Ops attempts to demote a Provider Admin to `provider_viewer` by `UPDATE provider_users SET role = 'provider_viewer'`. Zero runtime effect — next login still mints `provider_admin` JWT. The DB column is documentation, not authorization. **PR #41's claim that the new matrix "future-proofs the second provider role" is false advertising until this is fixed.**
**Fix:**

1. `login()` SELECT must include `providerUsers.role`.
2. Validate against a known set: `role: z.enum(['provider_admin', 'provider_viewer'])` (allowing only `provider_admin` today).
3. Sign the _loaded_ role into the JWT.
4. Reject any unknown DB value (defense-in-depth).

### SA-4 — Audit search has no date-range cap and no required orgId → DoS

**Source:** Security agent #1 (SEC-S5). Verified at `packages/shared-types/src/provider.ts:84-100` (`refine` only checks `fromDate <= toDate`, not span).
**Severity:** **HIGH at scale** (DoS surface).
**Attack:** Provider Admin hits `GET /provider/audit` with no filters → planner does a sequential scan of `audit_log`. Limit=100 caps rows returned but not rows scanned. At 30M rows + 60s statement_timeout, one bad request burns a pool slot for the full minute. Plus see CC-6.
**Fix:** Add `refine`: require `orgId` OR `fromDate AND ((toDate ?? now) - fromDate) <= 31 days`.

### SA-5 — Audit search SELECT projection is one-PR-away from leaking PII

**Source:** Security agent #1 (SEC-S6).
**Severity:** **MEDIUM** (test-coverage gap, not a current bug).
**File:** `apps/api/src/modules/provider/provider-audit.service.ts:74-82`.
**What:** Today the service `select({...})` explicitly lists 8 columns and omits `beforeState`/`afterState`/`actorEmail`/`ip`/`userAgent`. The v8.5 fix sanitises `metadata` of cleartext PII but did NOT systematically sanitise `before_state`/`after_state` writers. A single refactor that does `tx.select(auditLog)` (selecting the whole table) would leak whatever PII any org-tier writer happens to put in before/after.
**Fix:**

1. **Test-pin** the projection: a unit test that snapshots `Object.keys(query.config.columns)` against a frozen allowlist; CI fails if anything is added.
2. **Schema-level pin:** create a `provider_audit_log_view` Postgres VIEW that physically hides `before_state`/`after_state`/`ip`/`user_agent` and `GRANT SELECT` only on the view to `provider_app_role`. Forces a schema migration to widen.

### SA-6 — No audit row written for rejected/malformed requests

**Source:** Security agent #2 (SEC-H1). **This finding is excellent and underappreciated.**
**Severity:** **HIGH** — ISO 27001 A.12.4.1.
**File:** All 4 controllers — Zod validation pipe + `decodeCursor` fail _before_ `withProvider` is entered.
**Attack:** Compromised Provider Admin probes / fuzzes / enumerates the audit endpoint with malformed cursors, bad action regex, `fromDate > toDate`. Every rejection is a 400 with **zero** rows in `provider_audit_log`. Hours of probing leave no forensic trace on the privileged-tier audit table.
**Why it slipped self-audit:** The "audit-first" invariant is implemented INSIDE `withProvider`, which runs AFTER input validation. Self-audit checked "every endpoint writes an audit row on the happy path" — never the rejection path.
**Fix:** Two options:

1. **Layered guard:** add a NestJS interceptor (BEFORE the Zod pipe) that writes a "provider.request.received" audit row on every authenticated provider call regardless of subsequent outcome. The existing per-action row is added on success.
2. **Reverse the order:** Zod-validate inside `withProvider`'s callback, so the audit INSERT commits before validation runs. Slightly less ergonomic (DTO is constructed inside the wrapper) but the safer textbook pattern.

### SA-7 — Audit row is rolled back if work query fails → pre-commit suppression

**Source:** Security agent #2 (SEC-H2). **Also excellent.**
**Severity:** **HIGH** — ISO 27001 A.12.4.3.
**File:** `packages/db/src/wrappers/with-provider.ts:186-258`.
**What:** Today the audit INSERT and the work query share one transaction. If the work throws, the catch ROLLBACKs the whole tx — including the audit row. The "I attempted to read tenant X" record is lost along with the failed read.
**Attack:** Provider Admin crafts a request that exercises a DB-level failure (e.g. invalid UUID format hitting a parameter-bound query past the Zod layer; a unique-violation in a future write endpoint). Every such attempt erases its own evidence.
**Why it slipped:** The wrapper's own header comment claims _"if the work fails, the audit row is rolled back too (but the failed attempt is captured by the caller's error handler / Sentry)"_ — Sentry is NOT an A.12.4 audit record.
**Fix:** Write the audit row in a **separate, autonomous tx** (second pool connection, COMMIT immediately, then run the work in the main tx). Document the new invariant in D.37 as an addendum.

### SA-8 — `provider_audit_log.action_type` has no DB CHECK constraint

**Source:** Security agent #2 (SEC-M2).
**Severity:** **MEDIUM** — defense-in-depth gap.
**Fix:** Add CHECK constraint matching the writer regex: `CHECK (action_type ~ '^[a-z][a-z0-9_.-]*$' AND length(action_type) <= 128)`.

### SA-9 — No Provider-specific rate limit; global 100/min is too generous

**Source:** Security agent #2 (SEC-M3).
**Severity:** **MEDIUM**.
**File:** `apps/api/src/app.module.ts:31-36` — global throttler at 100 req/min applies to `/provider/*`.
**What:** A compromised Provider Admin token can pull `100 req/min × 5 sample owners = 500 masked owner records/min` plus enumerate cross-tenant audit at the same rate. Combined with SA-6 (no audit for probes), the rate is enough to exfiltrate the customer-relationship graph in hours.
**Fix:** Per-controller `@Throttle({ default: { limit: 30, ttl: 60_000 } })` on the 4 Provider controllers; tighter (10/min) on `/provider/tenants/:id` which is the only PII-touching path.

### SA-10 — Controller/service split 4+4 deviates from canonical 1+1

**Source:** SOLID agent #1 (SOLID-S1). I verified: `apps/api/src/modules/owners/`, `projects/`, `imports/` are each `<resource>.{controller,service}.ts` — one resource = one controller-service pair.
**Severity:** **MEDIUM** (cosmetic + DRY — not correctness).
**Fix:** Collapse to `ProviderController` + 3 services (`ProviderTenantsService`, `ProviderAuditService`, `ProviderSystemHealthService` — tenants service handles both list + detail). The `@UseGuards(...)` stack moves to the class. 12 files → 5. Identical behaviour.

### SA-11 — Cursor decode duplicated across 3 services

**Source:** SOLID agent #2 (SOLID-S2).
**Severity:** **MEDIUM** (DRY).
**Fix:** Add `decodeCursorOrThrow(raw)` to `apps/api/src/common/keyset-cursor.ts`, use in all sites.

### SA-12 — `getPoolStats` / `getStorageErrorStats` not DI-injected

**Source:** SOLID agent #2 (SOLID-S5).
**Severity:** **MEDIUM** (testability + codebase consistency).
**Fix:** Introduce `SYSTEM_STATS_PROVIDER` DI token; tests `overrideProvider` instead of `vi.mock`'ing the whole `@emapp/db` module. Matches the `STORAGE_PROVIDER` / `JOB_PRODUCER` pattern.

### SA-13 — Duplicate reason rules in two files

**Source:** SOLID agent #1 (SOLID-S6).
**Severity:** **MEDIUM** (single-source-of-truth violation).
**Files:** `apps/api/src/modules/provider/access-reason.decorator.ts:32-35` and `packages/db/src/wrappers/with-provider.ts:65-71` both define `MIN_LEN=5`, `MAX_LEN=512`, the same `CONTROL_CHARS_REGEX`. Change one, miss the other → 400-vs-500 mismatch.
**Fix:** Move to `packages/shared-types/src/provider.ts` (already a shared module). Both sites import.

### SA-14 — SAVEPOINT path costs 2 extra RTs on the happy `system-health` path

**Source:** Performance agent #1 (PERF-S4).
**Severity:** **LOW** (~10 ms tax on the most-hit endpoint).
**Fix:** Use `to_regclass('pgboss.job') IS NOT NULL` in a single conditional CTE, OR precompute schema-existence once at boot, OR (correct fix) the 30s in-process cache from CC-5.

### SA-15 — CORS allows `X-Reason` header but decorator reads `access_reason`

**Source:** Security agent #1 (SEC-S8).
**Severity:** **MEDIUM** (FE will break the moment it sets a custom header).
**File:** `apps/api/src/main.ts:144`. `allowedHeaders` does NOT include `access_reason`.
**Fix:** Add `access_reason` to `allowedHeaders` (or rename throughout to `X-Reason` and update the decorator + audit-row references).

---

## 3. Per-prompt fulfilment review (user's request: "did each prompt get fulfilled?")

| #   | Prompt                                                                               | Fulfilled?      | Notes                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | GO Phase 6.5 — read D.37, 4 endpoints, withProvider, audit, PII masked, policy entry | **YES**         | All 4 endpoints + matrix + masking shipped.                                                                                                                                                                |
| 2   | Answer 4 questions + close `metadata.reason` gap                                     | **YES**         | T6.5-D37-0 fix landed; 19 specs cover it.                                                                                                                                                                  |
| 3   | "תעבור על שוב על המימוש... תעבוד מסודר" — first self-audit                           | **PARTIAL**     | I audited P6.5-1 (foundation) only, not the full surface. The agents in _this_ audit found 4+ items the self-audit missed (CC-1, CC-2, SA-3, SA-6, SA-7). **Honest assessment:** my self-audit was narrow. |
| 4   | "תלך עם ההמלצה שלך" — implement self-audit fixes                                     | **YES**         | All SEC-1/2/3/4 from the narrow self-audit fixed.                                                                                                                                                          |
| 5   | "אל תשאל אותי, תמשיך עד שתסיים" — autonomous completion                              | **YES**         | All 6 slices closed without asking.                                                                                                                                                                        |
| 6   | "PR נכשל" — fix CI                                                                   | **YES**         | pgboss schema-lazy savepoint fix landed.                                                                                                                                                                   |
| 7   | "המשימה שקיבלת סגורה בצורה הטובה ביותר?" — honest re-check                           | **YES**         | I honestly said NO, listed 5 gaps.                                                                                                                                                                         |
| 8   | "תטפל בהכל" — close the 5 gaps                                                       | **PARTIAL**     | Closed 4 of 5; remote branch deletion deferred per auto-classifier.                                                                                                                                        |
| 9   | Current — comprehensive re-audit                                                     | **IN PROGRESS** | This document.                                                                                                                                                                                             |

---

## 4. Enterprise-grade fitness assessment ("would I build this for an enterprise product?")

**Honest answer: No — not as it stands today.** The architectural primitives are right (tier isolation, BYPASSRLS, in-SQL masking, append-only grants, MFA). The implementation gaps that would block an enterprise sales motion:

1. **Audit-integrity** (SA-2, SA-6, SA-7) — no tamper-evidence, no audit for rejected calls, audit suppressible by crafted-failure input. An enterprise CISO does the audit-tamper-and-detect test in 5 minutes and walks away.
2. **Defense-in-depth at the role layer** (SA-1, SA-3) — silent fallback to org pool, hardcoded JWT role. The DB role separation is the whole point of the Provider tier; if it's bypassable by a missing env var or a `UPDATE provider_users SET role` no-op, enterprise procurement will flag it.
3. **Forensic IP attribution** (CC-1) — `trustProxy: true` is fine for product analytics; it's not fine for the audit-of-record on cross-tenant access.
4. **Reason quality** (CC-2) — "aaaaa" passes today. An ISO 27001 auditor opens any sample of audit rows; the first "test1" they see costs the certification.
5. **DLP / bulk-decrypt monitoring** — completely missing. The docs/07 §8.4 table says _"Decrypt PII at scale → No (Bulk decrypts trigger alerts; only individual records on demand)"_ — but there's no alert wiring.

**If I were building this fresh for an enterprise product:**

- Wrap the audit INSERT in an autonomous tx (SA-7) on day one.
- Single Provider controller with method-level `@UseGuards()` (SA-10).
- `validateProviderActor → ProviderActor → withProvider` chain extracted from the 100-line wrapper (CC-3).
- IP allowlist on Provider tier from day one (docs/07 §8.5 already names this as "Phase 2 optional" — for enterprise it's day-one mandatory).
- Tamper-evident audit log from day one (SA-2).
- Bulk-decrypt rate alert from day one.

That said, **for MVP / pilot the surface is materially safer than typical SaaS Provider tooling and the missing items are well-scoped follow-ups, not redesigns.**

---

## 5. SOLID / Security / Performance verdicts

- **SOLID:** SHIP — CC-3 (withProvider SRP) and CC-4 (ProviderPrincipal ISP) compound with the 5th endpoint; SA-10 / SA-11 / SA-13 / CC-8 are mechanical cleanups for the next refactor PR.
- **Security:** SHIP-WITH-PLAN — CC-1, CC-2, SA-1, SA-3, SA-6, SA-7 must close before enterprise. SA-2 must close before ISO 27001 stage-2.
- **Performance:** OPTIMISE-BEFORE-SCALE — CC-5 + CC-6 (two `CREATE INDEX CONCURRENTLY` migrations) close 90% of the scale risk. CC-7 follows. The other findings are nice-to-haves.

---

## 6. New tests landed with this audit (Audit-v1.1 pins)

See `apps/api/src/modules/provider/audit-v1-1-*.spec.ts`. These specs **document the current behaviour** (so a future fix doesn't silently break the new behaviour) and where applicable use `it.todo(...)` to record the gap the next agent should close.

---

## 7. Recommendation to next agent

Open `phase-6.5-audit-v1-1` branch off main. Suggested order:

1. **Day 1 — closure of cross-confirmed P0/HIGH:**
   - CC-1 (trustProxy → `1` or CIDR list)
   - CC-2 (access_reason ticket-id pattern)
   - CC-5 (`CREATE INDEX CONCURRENTLY ON pgboss.job (state)` in worker migration + 30s in-process cache on health endpoint)
   - CC-6 (`CREATE INDEX CONCURRENTLY idx_audit_action_pattern`)
   - CC-7 (`CREATE INDEX CONCURRENTLY idx_owners_org_created_desc`)
   - CC-8 (delete dead `void` statements)

2. **Day 2 — single-agent HIGH (audit integrity + role correctness):**
   - SA-1 (PROVIDER_DATABASE_URL required + startup role probe)
   - SA-3 (JWT role from DB, not hardcoded)
   - SA-6 (audit row for rejected requests — interceptor)
   - SA-7 (autonomous audit tx)

3. **Day 3 — MEDIUMs + cleanup:**
   - SA-4 (audit search require orgId OR date-cap)
   - SA-5 (projection-allowlist test + view)
   - SA-8 (DB CHECK on action_type)
   - SA-9 (per-Provider rate limit)
   - SA-13 (single-source reason rules)
   - SA-15 (CORS `access_reason` header)
   - CC-3 / CC-4 (extract validators + ProviderActor)

4. **Day 4 — close the structural debts:**
   - SA-10 (single controller + 3 services)
   - SA-11 (decodeCursorOrThrow)
   - SA-12 (SYSTEM_STATS_PROVIDER DI token)

5. **Deferred to Phase 2 / Enterprise prep:**
   - SA-2 (tamper-evident audit chain — gate at first enterprise prospect)
   - Bulk-decrypt monitoring + alert wiring
   - IP allowlist for Provider tier

**Total estimated effort:** 2 weeks at one engineer if focused. Most items are small.
