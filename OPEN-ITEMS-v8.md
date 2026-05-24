# OPEN ITEMS — v8 deferrals (post-Phase-6 / pre-Phase-4 FE)

> **Status update (this commit):** the three §v8-S1/S2/S3 **P0** items
> below are now **CLOSED** on branch `v8-p0-closures` (migration 0032
>
> - 0033, +20 new tests, full test suite green). They remain documented
>   here for posterity and to mark the deferred-but-paired sub-items
>   (e.g. §v8-S2 Phase 2 LISTEN/NOTIFY).

> Items the v8 audit pass (3 independent agents) surfaced that we
> CHOSE not to close in this slice, each with a concrete plan + the
> reason. The next agent should pick from this list, NOT invent new
> work. Every item has a measurement so we know when it's done.
>
> Severity legend matches the audit agents': **P0** = customer
> notices today / regulator citation; **HIGH** = scale ceiling or
> latent defense-in-depth; **MEDIUM** = hygiene / future-proofing.

## P0 — must close before first paying customer

### §v8-S1 — R2 object retention + lifecycle (security Agent B #1)

- **Finding**: Uploaded Excel files (raw PII: national_id, phone,
  name, address in cleartext) live in `org/<id>/import/<uuid>.xlsx`
  FOREVER. No `storage.delete()` on done/failed/cancelled. No R2
  bucket lifecycle rule. Israeli privacy-law right-to-erasure +
  ISO A.18.1.4 data-minimisation both fail today.
- **Why not this slice**: Needs a schema migration (`file_deleted_at`
  on `import_jobs`), a delete trigger at terminal states, AND a
  Cloudflare R2 bucket lifecycle rule (ops change). Coordinated
  multi-system change deserves its own slice.
- **Plan**:
  1. Migration: `ALTER TABLE import_jobs ADD COLUMN file_deleted_at
timestamptz` + CHECK that `file_deleted_at IS NULL OR status IN
('done','failed','cancelled')`.
  2. Worker: after `markFailed` / `import.done`, call
     `storage.delete(fileR2Key)`, set `file_deleted_at = now()`, write
     `import.bytes_purged` audit row.
  3. Retention window: keep bytes for 30 days post-terminal to allow
     forensic re-validation; then delete. Implemented as a pg-boss
     scheduled job (mirrors the orphan-sweeper §v5-deferred).
  4. R2 lifecycle rule at `org/*/import/` prefix: hard-delete after
     90 days as defense-in-depth.
- **Acceptance**: `file_deleted_at IS NULL` returns 0 rows for every
  import with `status IN ('done','failed','cancelled') AND
finished_at < now() - interval '30 days'`. Audit log carries
  `import.bytes_purged` for every such row.

### §v8-S2 — SSE rate-limit + LISTEN/NOTIFY (security Agent B #2 + perf #2/#3/#10)

- **Finding**: `GET /imports/:id/stream` has no `@Throttle`. Polling
  every 500ms × `withTenant` (4 round-trips each) × N viewers
  saturates the 20-slot pg pool at ~41 concurrent streams. A single
  authenticated Manager can DoS the API with 10 EventSource
  connections.
- **Why not this slice**: Two parts. Part 1 (add `@Throttle({limit:5,
ttl:60_000})`) is one line — could land now. Part 2 (LISTEN/NOTIFY
  refactor) is a multi-day architectural change touching the worker
  (emit `pg_notify` in runStage UPDATE), the API (one dedicated
  LISTEN connection per process, in-memory fan-out to SSE clients),
  and the test harness.
- **Plan**:
  1. **Quick win (any next slice)**: add `@Throttle({default:{limit:
5, ttl:60_000}})` to `stream()` handler.
  2. **Real fix (Phase 7 dedicated slice)**:
     - Worker `runStage`: `await tx.execute(sql\`SELECT
       pg_notify('import_progress', ${payload.jobId})\`)` inside the
       state-flip tx.
     - API `ImportsService`: `onModuleInit` opens a single LISTEN
       connection (separate `providerPool` client kept alive). On
       NOTIFY → look up subscribers by jobId → push to their SSE
       streams.
     - Drop the 500ms polling loop entirely (only the heartbeat
       remains).
- **Acceptance**: 100 concurrent SSE streams hold 1 pg connection
  total (the LISTEN), not 100. Per-tx pool churn = 0.

### §v8-S3 — `owners.name` PII encryption (security Agent B #4)

- **Finding**: `owners.name` is stored CLEARTEXT, while `national_id`
  - `phone` are pgcrypto-encrypted. A Provider-Admin BYPASSRLS scan
    / SQL injection / wide-grant misconfig returns every owner's
    cleartext name across all orgs. Half-encrypted PII is the worst of
    both: encryption story half-applied, search story unbroken.
- **Why not this slice**: Hebrew name search uses `COLLATE he_il_icu`
  which can't operate on encrypted bytea. Encrypting `name` requires
  either (a) a `name_hash` for exact-match lookup + cleartext to the
  display layer behind a controlled accessor (NEVER `SELECT *`), or
  (b) accept that name search loses fuzziness. Design decision needs
  Manager-Owner stakeholder input.
- **Plan**:
  1. Stakeholder check: confirm name search is "starts-with" or
     "exact" only (not full-text). If yes:
  2. Migration: `ALTER TABLE owners ADD COLUMN name_encrypted bytea`
     - `ALTER TABLE owners ADD COLUMN name_hash bytea` + populate
       via background script.
  3. New helpers in `@emapp/db/helpers/owners.ts`: `encryptOwnerName`
     / `decryptOwnerName`. The display path goes through
     `decryptOwnerName(row)`; the search path uses `hashField(query)`.
  4. Drop the cleartext column after migration verified.
- **Acceptance**: `SELECT name FROM owners` returns 0 readable rows;
  `SELECT name_encrypted IS NOT NULL` returns the count of all rows.

## HIGH — close before scale

### §v8-H1 — pg-boss producer pool sharing (perf #11)

- **Finding**: Worker process holds THREE independent pg pools
  (`pool`, `providerPool`, pg-boss internal). Neon Developer plan
  caps at ~100 connections per project. 2 worker pods × 3 pools ×
  default max ≈ 60 conns just for the worker. Adds up faster than
  RAM.
- **Plan**: Lower `DB_POOL_MAX` + `DB_PROVIDER_POOL_MAX` in worker
  env (Infisical). Pass `db` option to pg-boss with an executeSql
  adapter delegating to `providerPool`. Document the math:
  `(api_pods + worker_pods) × (DB_POOL_MAX + DB_PROVIDER_POOL_MAX +
pgboss_pool_max) ≤ neon_connection_limit`.
- **Acceptance**: A 4-pod deployment (2 API + 2 worker) stays under
  60 active connections under nominal load.

### §v8-H2 — Worker audit-failure should be FATAL on state transitions (security Agent B #11)

- **Finding**: `markFailed`, `import.received`, `import.r2_downloaded`
  all use `.catch(() => {})`. A degraded audit DB → import succeeds
  silently with no forensic trail. ISO A.12.4 wants audit
  availability.
- **Plan**: Tier the audits:
  - **Best-effort** (current behaviour OK): `import.r2_downloaded`,
    `import.upload_url_minted`.
  - **Critical** (must fail loud): `import.persisted`,
    `import.done`, `import.failed`, `import.cancelled`. Wrap with
    `tx.commit` → if audit insert throws, the tx rolls back → state
    transition didn't happen → pg-boss retries.
- **Acceptance**: Inject a fake audit-failing AuditService into the
  handler; assert state transition is reverted on audit failure for
  critical transitions.

### §v8-H3 — `audit_log` RLS WITH CHECK on actor_id (security Agent B #10)

- **Finding**: Any service caller can pass `actorId: '<other user>'`
  to `auditService.log()` — the row goes through. Defense relies on
  honor-system at every call site.
- **Plan**: Migration adds RLS policy `WITH CHECK (actor_type =
'system' OR actor_id::text = current_setting('app.user_id',
true))`. `withTenant` already sets `app.user_id`; `withBootstrap`
  doesn't — needs a paired enhancement to set it OR explicit
  `actor_type='system'` requirement.
- **Acceptance**: SQL injection of `INSERT INTO audit_log (...,
actor_id, ...) VALUES (..., '<other user>', ...)` fails under
  app_user RLS.

### §v8-H4 — `withProvider` audit-FIRST tx ordering (security Agent B #12)

- **Finding**: `withProvider` writes the `provider_audit_log` row
  INSIDE the same tx as `fn`. If `fn` throws / Ctrl-C aborts, both
  roll back — provider access is unaudited but PG already streamed
  rows over the wire.
- **Plan**: Two-tx pattern. Write attempt row first (committed),
  then run `fn` in a second tx; write completion row (committed)
  after. ROLLBACK of `fn` leaves the attempt audit intact.
- **Acceptance**: ROLLBACK in `fn` still leaves a provider_audit_log
  row.

### §v8-H5 — `sanitiseUserString` name-shaped PII (security Agent B #13)

- **Finding**: Current regex `\d{7,}` catches digit-shaped PII
  (national_id, phone) but misses NAMES in Hebrew column headers.
  `parsed_headers` jsonb is itself a covert PII channel.
- **Plan**:
  - Option A: don't persist `parsed_headers` at all; recompute from
    R2 on demand for the fingerprint.
  - Option B: encrypt `parsed_headers` via pgcrypto with
    `app.encryption_key`.
  - Option C: explicit allow-list of "shape acceptable for
    fingerprint" (length cap + alphanumeric-only after sanitisation).
- **Acceptance**: A Hebrew header "דירת יעקב כהן" written to
  `parsed_headers` does not allow reverse-lookup of "יעקב כהן".

### §v8-H6 — R2 file lifetime relative to import state (security Agent B #14)

- **Finding**: pg-boss DLQ entry retried 12h later re-downloads the
  bytes long after the Manager believed the operation was final.
- **Plan**: Column `file_available_until` (default `created_at + 24h`)
  on `import_jobs`. Worker `parseStage` refuses to download if
  `now() > file_available_until` → `failed/expired`. Coordinate with
  §v8-S1's delete schedule.

### §v8-H7 — `withBootstrap` audit enforcement (security Agent B #9)

- **Finding**: The only sanctioned BYPASSRLS write path doesn't
  enforce that `fn` wrote audit rows. Honor-system only.
- **Plan**: Wrapper writes a mandatory `bootstrap.executed` audit row
  inside the tx (no caller can forget). Then `fn` runs and may write
  domain-specific rows.

### §v8-H8 — ImportJobHandler decomposition (SOLID Agent A #8)

- **Finding**: 1697 LOC, 5 responsibilities (state machine, audit,
  parser orchestration, batched DB resolvers, persist tx, failure
  compensator). Each has its own reason to change; SRP violation.
- **Plan**: Extract `ImportStateMachine`, `ImportPersister`,
  `ImportParser` classes. Handler becomes a thin orchestrator. Each
  unit-testable in isolation.
- **Risk**: large refactor → can introduce regressions. Schedule
  AFTER FE work lands so the integration test suite proves no
  observable change.

## MEDIUM — quality / future-proofing

### §v8-M1 — `withTenant` 4-round-trip overhead (perf #2)

- **Finding**: Every withTenant pays ~400ms on Neon (BEGIN + SET
  LOCAL ROLE + set_config + user query + COMMIT). The 500ms SSE
  poll multiplies this.
- **Plan**: Combine `BEGIN; SET LOCAL ROLE app_user; SELECT
set_config(...)` into a single multi-statement (saves 1 RT). For
  read-only operations consider a non-tx path. Measure first — only
  ship if savings > 200ms on the hot path.

### §v8-M2 — ExcelJS true streaming (perf #5 / §v7-E)

- **Finding**: `xlsx.load(buffer)` buffers the whole 50MB upload +
  decompressed XML + workbook in RAM. ~150MB resident per import.
- **Why not closed in v7/v8**: ExcelJS's streaming WorkbookReader
  fails on R2-body streams ("Cannot read properties of undefined
  ('sheets')") — a documented ExcelJS bug. Buffered approach is
  CORRECT given the 50MB cap + concurrency=2 budget; RAM peaks at
  ~300MB on Free Tier (well under 512MB).
- **Plan**: Either (a) wait for ExcelJS upstream fix and try
  streaming reader again, (b) switch to a different xlsx library
  (e.g. `xlsx`/SheetJS) with streaming support, or (c) tee to
  tmpfile and feed tmpfile to ExcelJS streaming reader.

### §v8-M3 — Audit logMany batching (perf #9)

- **Finding**: ~10 audit INSERTs per import = ~1s on Neon RTT. The
  `AuditService.logMany` exists but isn't used by the import flow.
- **Plan**: Accumulate per-stage audit entries in an in-memory list,
  flush once at the end of each `runStage` withTenant via
  `logMany`. Atomicity preserved (same tx).

### §v8-M4 — `idempotencyKey` UNIQUE info-leak across Managers (security Agent B #15)

- **Note**: v8 partially mitigated by tightening the format
  (16-64 chars [A-Za-z0-9_-]) — makes guessing infeasible. The
  remaining theoretical leak (UNIQUE conflict still surfaces 409 on
  cross-Manager probe) is closed at the service layer by scoping
  replay-lookup to (org, created_by, key); the UNIQUE on (org, key)
  is the race backstop.
- **Plan**: Migration to widen the partial UNIQUE to include
  `created_by` so the DB-level constraint matches the service-level
  scope. Defense in depth.

### §v8-M5 — `_ownership_sum_checked` trigger search_path (Phase-5 audit MED-2 carryover)

- **Plan**: Next ownership-trigger migration adds `SET search_path =
pg_temp, public` to the function definition. Not exploitable today
  (app_user is locked down) — defense in depth.

## LOW

### §v8-L1 — `gen-api-docs` doesn't include the `/imports/:id/stream` request schema link

- **Note**: SSE endpoints don't have a request body; the page links
  the `ImportSseEventSchema` in the response field. Good enough for
  FE handoff.

### §v8-L2 — Sentry release tagging on rotation events

- Useful but not blocking.

---

## §v8-DOC — Strategy for future audit-pass

When the next agent does v9, follow the same pattern that consistently
finds new bugs:

1. **Spawn 3 INDEPENDENT agents** (SOLID/security/perf), give them
   NO history of prior audits. Fresh eyes catch what scar-tissued
   eyes miss. Confirmed 7 audit passes running.
2. **Cross-confirm** — only treat findings that ≥2 agents independently
   surface as P0. Single-agent findings get HIGH/MEDIUM treatment.
3. **Triage by close-cost** — close everything cheap (<2hr work) in
   the same slice. Document the expensive ones with concrete plans
   here. Refuse "we'll see" deferrals.
4. **Test every closure** — every fix MUST land with a test that
   would have caught the original bug. Unit > integration > E2E (in
   that order of preference, by cost).
5. **PROGRESS.md heartbeat** — update with the slice's closures + a
   pointer to this file for deferrals.
