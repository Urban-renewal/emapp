# 03 — Engineering Quality Readiness (v4)

> **Front:** SOLID/architecture · perf <1s · security · error handling · observability · concurrency/integrity.
> **Method:** READ-ONLY source audit. Every claim grounded in real `file:line`, not the plan's prose.
> Author seat: Engineering-quality audit, 2026-06-18. No code changed.

---

## 0. READINESS VERDICT (one line)

**`production-ready foundation, control-incomplete` — the engineering substrate is genuinely
strong (RLS-FORCE isolation, owned auth, idempotency, a real scheduler, structured
observability), but three named gaps stand between "demo-correct" and "50-customers-in-prod-correct":
(1) no global validation pipe/CI guard — validation is by convention not construction; (2) no
project-status-transition guard + no optimistic-concurrency on `update()` — last-write-wins +
illegal state jumps; (3) the chase/notification layer is half-built (the clock exists, the
honest "expiring/stalled/threshold" notification kinds do not).** None is a live security hole;
all three are *control* gaps that bite at scale. The roadmap (`00-FINAL-ROADMAP.md`) already
names all three (S0-SEC, B5, B3) — so the plan is control-AWARE; the risk is execution-order and
two integrity items the plan under-weights (concurrency on `update()`; no caching layer on the
heavy aggregations).

---

## 1. GAP SUMMARY — ranked by production impact

| # | Gap | Dimension | Evidence | Plan home | Severity at 50-customer scale |
|---|---|---|---|---|---|
| **G1** | **No status-transition guard + no optimistic concurrency on `projects.update()`.** `patch.status = input.status` is any→any; two managers editing the same project = silent last-write-wins; a project can jump `planning`→`completed` or be marked `approved` below threshold. | Concurrency/Integrity | `projects.service.ts:773` (status), `:762–820` (no version/updatedAt guard, no `metThreshold` precondition) | B5 (guard only) | **HIGH** — corrupt legal/business state, no audit of "who clobbered whom" |
| **G2** | **No global validation pipe + no CI coverage guard.** 100% of endpoints validate *today by per-endpoint convention*; nothing mechanically stops the next of 171 routes shipping a bare `@Body()`. | Security/SOLID | `main.ts` + `app.module.ts` have no `APP_PIPE`/`useGlobalPipes`; `input-validation-coverage.spec.ts` does not exist | S0-SEC | **HIGH** — one missed DTO = trust-the-wire on a PII write path |
| **G3** | **Chase/autonomy layer is half-built.** The *clock* exists (3 cron jobs incl. hourly signature-expiry) but the *honest notification* does not: no `expiring`/`stalled`/`threshold_reached` notification kinds. The doctrine "the system keeps nudging" has no backend to emit. | Observability/Errors/Product | `apps/worker/src/main.ts:245,274,309` (real schedules) vs `packages/shared-types/src/notification.ts:12–22` (8 kinds, none is expiring/stalled/threshold) | B3 | **MEDIUM-HIGH** — the product's core promise is un-backed; operator can't see a stuck campaign |
| **G4** | **Heavy aggregations are uncached and recomputed per request.** `orgStats` + `signatureProgress` are multi-subquery CTEs with zero memoization; `PostgresCacheProvider`/`cache_kv` is wired ONLY for export rate-limiting. | Perf | `projects.service.ts:537–581` (orgStats), `:355–435` (signatureProgress) — no `cache` ref; cache used only in `export-rate-limit.service.ts` | not addressed | **MEDIUM** — home + board hit these on every load; correlated subqueries grow with project×apartment count |
| **G5** | **"Silent null on error" on the board.** The signature-progress board returns bare `null` on error → a blank surface, no retry, no diagnosis. | Errors | `projects/[id]/_components/signature-progress-board.tsx` (confirmed `return null`) | C2 (DataState) | **MEDIUM** — at scale, a transient 500 reads as "no data" to a developer |
| **G6** | **Controller-auth ratchet is file-level (by its own admission).** A method dropping its class guard, or a new `@Public()`, is not caught at build; record-scope IDOR lives in services, not ratcheted (RLS is the backstop). | Security | `SECURITY-POSTURE.md:49`; `architecture/controller-auth.guard.spec.ts` | P1.6 | **LOW-MEDIUM** — RLS is a real backstop, but defense-in-depth has a hole |
| **G7** | **Dependency audit gate is `--audit-level=high` only** → moderate advisories pass silently; no `--prod` audit. | Security/Deps | `SECURITY-POSTURE.md:57,87` | P1.5 | **LOW** — exposure-window, not a live hole |
| **G8** | **PII/DOC keys provisioned in DEV Infisical only.** Boot fails loud, so it's a deploy blocker not a hole — but it IS the #1 go-live gate. | Security/Ops | `SECURITY-POSTURE.md:52,116–121`; `main.ts:226–232` (`verifyEncryptionStartup`) | Ops checklist | **BLOCKER (ops)** — prod won't boot until done |

---

## 2. Per-dimension findings

### 2.1 SOLID / architecture — **STRONG (production-ready, minor leaks)**

- **Provider seams are real and substitutable.** `IEmailProvider`/`ISMSProvider`/`IExtractionProvider`/storage
  are honored via DI + factory + Noop dev doubles (tasks #12 `IExtractionProvider + StubExtractionProvider + token + factory`;
  worker `storageProviderFactory()` at `apps/worker/src/main.ts:156`; the campaign service takes
  `this.email`/`this.sms` by constructor). The mapping resolver is a composed chain
  (`MappingResolverChain([TemplateResolver, LegacyAliasResolver])`, `main.ts:168`) with a documented
  L3 extension point — textbook OCP.
- **Module boundaries are clean.** 41 controllers, 171 routes across 30+ feature modules; the DB-access
  invariant (`withTenant`/`withProvider`, never raw `db`) is enforced by **two build-time ratchets**
  (`architecture/tenant-isolation.guard.spec.ts`, `controller-auth.guard.spec.ts`) — architecture-as-test,
  not convention. The worker is a true composition root (`main.ts` is "wiring only, no logic" — verified).
- **The job seam is Liskov-clean.** Every job is an `IJobHandler` with a Zod payload schema, name, timeout,
  retry policy (`signature-expiry.handler.ts:37–51`); logic lives in `@emapp/db` so it's unit-testable
  without pg-boss. This is the cleanest part of the codebase.
- **FE data-path layering exists and is consistent** (wire → `lib/api/*` Zod parse → `adapters/*` VM →
  `hooks/*` → island). 30+ adapters each with a `.spec.ts`; the `statusColor` VM rename is guarded by
  adapter specs. **Leak:** the plan's own "~15 inline `var(--)` leaks in AgentHome" and the board's
  `return null` are real layering/contract violations (see G5).
- **GAP (minor):** `projects.service.ts` is becoming a god-service (signatureProgress + signatureProgressApartments
  + orgStats + create + update + archive all in one file, the consent CTE inlined as raw SQL). Not a
  blocker, but the B0/B1 share-weighted rewrite should extract a `ConsentCalcService` rather than grow it.

**Verdict: production-ready.** Seams and boundaries are architecturally enforced, not aspirational.

### 2.2 PERF — **GAP (sub-second today, unproven at scale)**

- **The heavy aggregations are correct but uncached.** `orgStats` (`:537–581`) is a single round-trip of
  4 COUNTs (good — not N+1), and `signatureProgress` (`:363–407`) is one CTE with correlated EXISTS
  subqueries per apartment. At 50 customers × many projects these are **recomputed on every home/board
  load** — `PostgresCacheProvider`/`cache_kv` is wired ONLY in `export-rate-limit.service.ts`, NOT here.
  The correlated `EXISTS(... signature_requests JOIN documents ...)` per ownership row is the shape that
  degrades as apartment×owner count grows (G4).
- **Pagination is keyset, broadly applied** (10+ services import `keyset-cursor`), and the known
  microsecond-cursor bug is documented in memory — good hygiene, but verify it's fixed on every list
  before scale.
- **No materialized view / no rollup table** for the board %. The B0 share-weighted CTE (which ADDS a
  `GROUP BY building` + share math) will be *heavier* than today's binary count. Plan B0 must not ship
  without a perf gate on a seeded 50-project org.
- The plan's own G-MOTION-PERF open question (count-up animation vs the warm-200ms LCP budget) is a real,
  un-reconciled tension flagged in `00-FINAL-ROADMAP.md:232`.

**Verdict: gap.** No query is pathological today, but "stays sub-second at 50 customers" is **unproven** —
there is no caching layer on the two hottest reads and no load-tested evidence. Add a cache + a seeded
perf gate before B0/B1.

### 2.3 SECURITY — **STRONG (one systemic structural gap, otherwise excellent)**

- Reconciled against `docs/SECURITY-POSTURE.md` (authoritative, 2026-06-18). Isolation is **4-layer**
  (RLS FORCE on ~36 tables + wrappers + 2 ratchets + fail-closed default-deny). Auth is an owned argon2id
  stack with refresh rotation + reuse-detection. Edge hardened: strict prod CSP, Helmet/HSTS, CORS
  allowlist, `trustProxy:1` (forensic IP integrity, `main.ts:50`), generic 5xx with pg-detail scrubbed
  pre-Sentry (`http-exception.filter.ts:81–98`).
- **The one systemic gap is G2** (no global pipe / no CI guard) — exactly as the posture doc states
  (`:37–39`). This is **structural, not a live hole**: validation is 100% present today. The plan's
  S0-SEC closes it and is correctly sequenced FIRST. **This must land before B0/B1/B4/B5** or the 4 new
  BE surfaces inherit the convention-not-construction risk.
- Residual edges (all named, none "Gap"-rated): file-level auth ratchet (G6/P1.6), `--audit-level=high`
  (G7/P1.5), `List*Query` schemas `.strip()` not `.strict()` (P1.1), OTP phone refined in service not at
  the schema boundary (P1.2). The magic-byte doc-path check is in flight (P0.4).
- **Ops blocker G8:** PII/DOC keys are DEV-only; prod boot fails loud (`verifyEncryptionStartup` at
  `main.ts:227`) so it's a deploy gate, not a code hole.

**Verdict: production-ready in code, gated on G2 (S0-SEC) landing first + the ops key provisioning (G8).**

### 2.4 ERROR HANDLING — **STRONG on BE, PARTIAL on FE**

- **BE is complete.** The D.16 envelope is enforced by a single `GlobalExceptionFilter` that: honors
  carried 4xx codes via an **allow-list** (never message-matches, `:40–45`), normalizes 404 to
  `{error:{code:'not_found'}}` (`:122`), emits generic 5xx, and **scrubs pg detail/hint before Sentry**
  (`:81–98`). The campaign flow has a real failure taxonomy — per-owner `owner_not_found` /
  `owner_is_renter` / `recipient_not_associated` / `skipped_existing` outcomes that **never abort the
  batch** (`signature-requests.service.ts:472–520`). The resend path returns proper 409s
  (`recipient_not_associated`, `signature_request_not_pending`, `:296,768,785`). PII-decrypt failures are
  isolated per-owner so a corrupt-ciphertext owner fails only ITS delivery (`:526` region) — genuinely
  fail-closed without blast radius.
- **FE is partial.** There is no unified `DataState` wrapper yet (does not exist in `apps/web/src`), and
  the **"silent null on error" anti-pattern is confirmed live** in `signature-progress-board.tsx`
  (`return null` — G5). At scale a transient 500 renders as "no data," which a non-technical developer
  reads as "nothing happened," not "retry." Plan C2 closes this and is correctly in Wave 0.

**Verdict: BE production-ready; FE gap (C2 must land — it's the user-facing recovery layer).**

### 2.5 OBSERVABILITY — **STRONG (better than the plan assumed)**

- Sentry is initialized in **all three** processes (`apps/api/src/instrument.ts`,
  `apps/web/src/instrumentation.ts`, `apps/worker/src/instrument.ts`) with PII scrub.
- There is a **real metrics layer**: `MetricsInterceptor` emits low-cardinality, non-PII
  `http_requests_total{method,route,status_class}` + a duration histogram, with `routeLabel()` collapsing
  ids so the series can't explode (`observability/metrics.interceptor.ts`). It **also drives a breach
  detector** — an authenticated 403 burst (over-probing/compromised session) trips a per-actor signal.
  This is a genuine SRE seam, fail-open by design (metrics fault can't break a request).
- pino redaction is comprehensive in both API and worker (`apps/worker/src/main.ts:67–85` redacts
  `national_id`/`phone`/`row`/`rows` at any depth). Audit is DB-trigger append-only.
- **GAP (the operator question — "diagnose a stuck campaign at 2am"):** the *infra* visibility is strong,
  but the **domain** visibility is thin. There is no operator view of "campaigns in flight / delivery
  failures / stuck imports" surfaced as a console — failures land in logs + per-owner `failed` outcomes,
  not a queryable operator dashboard. The provider operator console is half-built (plan C12b, owner-gated).
  And G3 (no expiring/stalled notification kinds) means a stalled campaign emits **no signal at all** —
  the clock expires the link but nothing tells anyone.

**Verdict: production-ready for infra; gap for domain/operator observability at scale (C12b + B3).**

### 2.6 CONCURRENCY / INTEGRITY — **GAP (the most under-weighted dimension)**

- **Idempotency is real and well-built.** `IdempotencyInterceptor` does an atomic claim, scopes the key
  to `org:user:POST:path:key` (no cross-endpoint/cross-tenant replay), replays the stored `{status,body}`
  on a completed key, 409s an in-flight duplicate, and **releases on failure so a failed op is retryable**
  (`common/idempotency/idempotency.interceptor.ts:64–85`). FE sends `Idempotency-Key` widely (20+ `lib/api`
  modules). This is production-grade.
- **The scheduler EXISTS — the lead's "no cron at all" is REFUTED.** The worker wires **three** recurring
  cron jobs via `boss.schedule()`: hourly reaper (`main.ts:245`), daily audit-retention (`:274`), and
  **hourly signature-expiry sweep** that flips lapsed `pending`→`expired` atomically (`:309`,
  `signature-expiry.handler.ts`). So "nothing expires on a clock" is wrong — *expiry* is clock-driven and
  idempotent. What's missing is the *chase/notify* emission on top of it (G3).
- **THE REAL INTEGRITY HOLE (G1):** `projects.update()` (`:762–820`) has **neither a status-transition
  state machine NOR optimistic concurrency**. `patch.status = input.status` (`:773`) permits any→any
  (`planning`→`completed`, or `approved` below threshold). And there is **no version/`updatedAt`
  precondition** on the `UPDATE` — two managers editing the same project is silent last-write-wins, and
  the audit `beforeState` (`:812`) records only what THIS tx read, not a conflict. At 50 customers with
  multi-user orgs this WILL produce corrupted project state with no detection. Plan B5 fixes the
  transition guard but **does NOT address the concurrent-edit race** — that's an un-named gap.
- Bulk writes (campaign, bulk-ownership) are bounded only by the 1MB body limit, not per-field `.max()`
  array caps (P2.1) — a real-but-low abuse vector.

**Verdict: gap.** Idempotency + the scheduler are production-ready; the `update()` transition+concurrency
hole is the single highest-impact integrity defect and the plan only half-covers it.

---

## 3. The owner's 6 questions, answered from this front

1. **Plan for all interfaces?** Engineering-wise yes — 65 page.tsx / 171 routes are enumerated and every
   one has a wave home. The gap is not coverage; it's that two foundation slices (S0-SEC, B5) must land
   *before* the surfaces that depend on them.
2. **Current functionality kept?** Yes — "routes are never deleted" is a binding rule; the seams make
   each action re-composable. The risk is the board's `return null` and the uncached aggregations, not lost actions.
3. **Missing actions?** The honest-chase trio (`expiring`/`stalled`/`threshold_reached` notify) and an
   **operator/domain dashboard** (stuck campaigns, failed deliveries, import state) — both half-built.
4. **SOLID/perf/security/errors?** SOLID ✔, security ✔ (gated on S0-SEC+keys), BE errors ✔; **perf
   <1s is UNPROVEN at scale** (no caching on the two hot reads) and **FE error recovery is partial** (C2).
5. **Long flows → one calm click?** The campaign flow is *already* a clean one-tx-then-chunked-delivery
   with a per-owner failure taxonomy — it's the best-engineered long flow and needs only the M5 confirm +
   M0 toast. Project-build and add-residents are heavier and gated on B5 (transition guard) to be safe.
6. **Control at 50 customers, or chaos?** **Partial control.** The substrate gives control (idempotency,
   isolation, the expiry clock, metrics+breach detection). The chaos risks are concrete and named: G1
   (concurrent edits clobber state), G3 (a stuck campaign emits no signal), G4 (the board may not stay
   sub-second), and the thin domain/operator dashboard. The lead's diagnosis is **correct in direction,
   over-stated on "no cron" — but right that CONTROL-complete is unproven.**

---

## 4. The single most important thing to close

**Make `projects.update()` both transition-guarded AND concurrency-safe (G1) — and do it WITH an
optimistic-concurrency check, not just the B5 state machine the plan scopes.** It is the one defect that
silently corrupts legal/business state at multi-user scale with zero detection, and the plan currently
only covers half of it. Pair it with landing S0-SEC first (so new write paths are validated by
construction) and adding a cache layer + seeded perf gate before B0 ships the heavier share-weighted CTE.
