# ARCHITECTURE MAP — the layers and how they synchronize

> Companion to `ONBOARDING.md`. ONBOARDING is the tour; this is the
> reference. Use this when you're about to change something that
> spans more than one file and you want to know what else you have
> to touch.
>
> Format: every section is **(a) what the concept is → (b) which
> files in which packages manifest it → (c) the change-propagation
> rule** (if you change A, you must also touch B/C/D). Every rule
> is grounded in an actual bug from the 8 audit passes — the
> citations point at the audit finding that proved each rule.

---

## §1 — The contract layer (FE ↔ BE)

The single source of truth for every wire shape is
`packages/shared-types/src/*.ts`. The Zod schemas there are
imported by BOTH the API (as DTOs via class-validator pipes) AND
the FE (as response parsers). **Never redefine a schema in the API
or the FE.** D.16 / Doc 11.

### Manifestation

| Layer                  | File                                           | What lives there                                               |
| ---------------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| **Wire contract**      | `packages/shared-types/src/*.ts`               | Zod schemas (request DTO, response, list page, error envelope) |
| **API DTO**            | `apps/api/src/modules/*/dto/*.ts`              | THIN re-exports from shared-types + Nest pipe wiring           |
| **API service**        | `apps/api/src/modules/*/*.service.ts`          | Domain logic; takes the inferred TS type from the Zod schema   |
| **API response**       | controller method return value                 | Wrapped in `{ data: T }` (D.16); never the bare T              |
| **OpenAPI docs**       | `docs/09-api-reference.generated.md`           | Auto-generated from `apps/api/scripts/gen-api-docs.ts`         |
| **FE response parser** | `apps/web/src/lib/api/*.ts` (TBD in Phase 4)   | `Schema.parse(json.data)`                                      |
| **FE error handler**   | switch on `error.code` (NEVER `error.message`) | The catalog is in §3 below                                     |

### Change-propagation rule

**Adding a new field to a wire schema:**

1. Edit `packages/shared-types/src/<entity>.ts` — add the Zod field
2. If it's a request field: update the API service to use it
3. If it's a response field: update every `select({...})` projection in the API service
4. If it requires a new DB column: see §2 (DB schema sync)
5. Run `pnpm --filter @emapp/api gen:api-docs` — regenerate the
   markdown reference. **The `gen:api-docs --check` step in the
   build will fail CI if you skip this.**
6. Update the FE consumer + any spec that asserts the wire shape
7. Add a unit test in `imports-v8-closures.spec.ts` (or sibling)
   that pins the new schema's behavior (accepts valid, rejects
   invalid)

### Common pitfall

- **Don't add a field as `z.unknown()` or `z.any()`** — defeats
  the purpose. Use a proper type or refine.
- **Don't widen a strict schema silently** — `.strict()` is on
  every input schema by design. A field added without strict
  refinement opens an attack surface.
- **Don't return an extra field server-side without adding it to
  the response schema.** The FE parser will strip it (Zod's default
  is `.strip()`) — which means your "new feature" silently doesn't
  reach the UI.

**Audit history that proved this:** v8 SOLID-2 (sha256 prefix
ambiguity), v8 SOLID-4 (fileName PII leaked because the wire shape
wasn't updated when the audit was).

---

## §2 — The data layer (DB schema, migrations, drizzle, PII)

Postgres 16 + RLS + pgcrypto on Neon. Drizzle ORM owns the
TypeScript schema; migrations are hand-written SQL + journal
entries.

### Manifestation

| Layer                 | File                                         | What lives there                                                                                                     |
| --------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Drizzle schema**    | `packages/db/src/schema/*.ts`                | Table definitions, column types, indexes (re-exported via `index.ts`)                                                |
| **Migration SQL**     | `packages/db/migrations/NNNN_*.sql`          | The DDL change, plus any data backfill                                                                               |
| **Migration journal** | `packages/db/migrations/meta/_journal.json`  | MUST have a new entry with `when` > previous max for hand-written migrations (the migrator silently skips otherwise) |
| **Migrator wrapper**  | `packages/db/scripts/migrate.ts`             | Sets session GUCs (`app.encryption_key`, `app.pii_hash_key`) BEFORE drizzle migrate runs                             |
| **RLS policies**      | inside migration SQL                         | `CREATE POLICY ... USING (org_id = current_setting('app.organization_id')::uuid)` pattern                            |
| **withTenant**        | `packages/db/src/wrappers/with-tenant.ts`    | Sets RLS GUCs per tx (`app.user_id`, `app.organization_id`, `app.encryption_key`) and switches role to `app_user`    |
| **withProvider**      | `packages/db/src/wrappers/with-provider.ts`  | BYPASSRLS + writes `provider_audit_log` BEFORE the work                                                              |
| **withBootstrap**     | `packages/db/src/wrappers/with-bootstrap.ts` | Single sanctioned BYPASSRLS write path (signup only — D.21)                                                          |
| **Direct pool**       | `pool` / `providerDb` from `@emapp/db`       | Pre-auth reads (login / loadProfile / session-validity) ONLY                                                         |

### Change-propagation rule

**Adding a new column to an existing table:**

1. Write a hand-written migration `packages/db/migrations/NNNN_*.sql`
2. Add a journal entry to `_journal.json` with `when` > max (else
   it gets silently skipped)
3. Update the drizzle schema in `packages/db/src/schema/<file>.ts`
4. If the column is PII-bearing → see §4 (PII map)
5. Update the migration runner's GUC list ONLY if the column needs
   the encryption key for backfill
6. Run `infisical run --env=dev -- pnpm --filter @emapp/db
db:migrate` — verifies the SQL is valid against the dev DB
7. Update every `.select({...})` in every service that should now
   return the new column

**Adding NOT NULL to an existing column:**

- Two-phase: (a) ADD nullable + backfill, (b) ALTER SET NOT NULL.
  Single migration only safe in dev where downtime is acceptable.
  v8 §v8-S3 used the single-migration pattern; production should
  use two-phase. Documented in `OPEN-ITEMS-v8.md`.

**Dropping a column:**

1. Confirm via grep across the repo that nothing references it
2. Update drizzle schema (REMOVE the column definition)
3. Migration that drops it + any dependent indexes/constraints
4. Update every test that INSERTed into that column
5. Run full test suite — drizzle's TS inference will catch most
   call sites, but raw SQL INSERTs (in tests) won't typecheck;
   v8-S3 missed two of those and got caught by CI

### Common pitfall

- **Don't edit `packages/db/migrations/meta/_journal.json` by hand
  without bumping `when`.** Equal-or-lower `when` = silent skip.
- **Don't add a column to the drizzle schema without a migration.**
  Tests will pass locally because vitest applies all migrations
  including the new one, but CI fresh DB will lack the column.
- **Don't read a tenant-scoped table outside `withTenant`.**
  `pool.query()` runs as the BYPASSRLS owner role; no RLS applies.
  Hard rule in CLAUDE.md.
- **`withProvider` audit row is in the SAME tx as the work** — if
  `fn` throws, both roll back. This is a known issue (§v8-H4); the
  fix is "audit-first separate tx" — pending.

**Audit history:** v3 A4 (data-loss recovery), v8 §v7-A (payload
trust pattern), v8 §v8-S3 (encryption migration).

---

## §3 — The error catalog (the FE switches on `error.code`)

Every API error is `{ error: { code, message, details? } }` (D.16).
The FE MUST switch on `code`, never on `message`. The catalog is
auto-included in `docs/09-api-reference.generated.md` §2; the
canonical source is `apps/api/scripts/gen-api-docs.ts:ERROR_CATALOG`.

### Manifestation

| Code                                                                                                                                       | HTTP | Where thrown                                                        | What the FE does                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `validation_error`                                                                                                                         | 400  | Zod pipe in `apps/api/src/common/pipes/zod-validation.pipe.ts`      | Show field-level errors from `details`                                |
| `invalid_credentials`                                                                                                                      | 401  | `auth.service` login path (silent on bad email/password/MFA/locked) | Generic "פרטים שגויים" — NEVER distinguish reasons (anti-enumeration) |
| `missing_token` / `invalid_token` / `token_expired` / `session_revoked`                                                                    | 401  | `auth.guard`                                                        | Redirect to login                                                     |
| `invalid_refresh` / `missing_refresh_token`                                                                                                | 401  | refresh handler                                                     | Redirect to login                                                     |
| `invalid_otp`                                                                                                                              | 401  | tenant OTP verify                                                   | Show generic OTP error (anti-enumeration)                             |
| `not_member`                                                                                                                               | 401  | switch-org                                                          | Show "אינך חבר" + log out org context                                 |
| `forbidden`                                                                                                                                | 403  | AuthZ guard                                                         | Show "אין הרשאה"                                                      |
| `not_found`                                                                                                                                | 404  | every service (no oracle: cross-org id → 404 not 403)               | "לא נמצא"                                                             |
| `invalid_cursor`                                                                                                                           | 400  | keyset pagination decode                                            | Reset list, refetch from page 1                                       |
| `invalid_json`                                                                                                                             | 400  | body parser                                                         | Surface "בעיה בבקשה" — likely a bug, not user-fixable                 |
| `bad_request`                                                                                                                              | 400  | generic                                                             | Same as validation_error                                              |
| `idempotency_conflict`                                                                                                                     | 409  | concurrent Idempotency-Key                                          | Wait + retry (the request IS in flight)                               |
| `import_conflict`                                                                                                                          | 409  | `imports.create`                                                    | Different file with same uniqueness key — show conflict UI            |
| `import_not_startable` / `import_not_cancellable` / `import_already_starting` / `import_not_in_awaiting_mapping` / `import_status_changed` | 409  | imports state-machine guards                                        | Show current status (the response message has it)                     |
| `upload_size_mismatch`                                                                                                                     | 400  | `/imports/:id/start` head()                                         | Re-upload (the file was modified between create and start)            |
| `mapping_duplicate_column`                                                                                                                 | 400  | submitMapping                                                       | Highlight the duplicate column                                        |
| `storage_unavailable`                                                                                                                      | 503  | presign failure                                                     | Retry (transient infra)                                               |
| `too_many_concurrent_streams`                                                                                                              | 503  | SSE cap (§v8-S2)                                                    | Back off + retry the EventSource                                      |

### Change-propagation rule

**Adding a new error code:**

1. Service throws via Nest exception with `{ error: { code, message } }`
2. Add the code to `ERROR_CATALOG` in `apps/api/scripts/gen-api-docs.ts`
3. Regenerate `docs/09-api-reference.generated.md`
4. Add the FE display string to the i18n file (TBD in Phase 4)
5. Add a unit test in the relevant `*.s8.spec.ts` (or sibling) that
   asserts the code on the wire

### Common pitfall

- **Don't include PII in `message`** — pino redacts top-level
  paths but `error.message` is whatever the dev wrote
- **Don't expose stack traces in production** — `GlobalExceptionFilter`
  in `apps/api/src/common/filters/` strips them
- **Don't use a code without adding it to ERROR_CATALOG** — the
  next agent grep-ing for the code finds nothing, has to read
  source to learn semantics

---

## §4 — The PII propagation map

Every PII field has SIX layers it must traverse correctly. Mess up
any one and you have a leak.

| Field                      | Encrypt                                 | Hash (search)                       | Decrypt at wire                                                                     | Sanitise in audit                                                | Mask in display        | Never log             |
| -------------------------- | --------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------- | --------------------- |
| `national_id`              | `encryptOwnerPiiBatch` / `encryptField` | `hashField` (HMAC-SHA256 hex)       | `NID_MASK` SQL expression (last-2 only on wire)                                     | `sanitiseUserString` (any 7+ digit run → `[N]`)                  | "•••••••XX"            | pino redact paths     |
| `phone`                    | same                                    | same                                | `PHONE_MASK` (last-4 only)                                                          | same                                                             | "•••••XXXX"            | same                  |
| `name` (v8 §v8-S3)         | `encryptOwnerName` / batch              | `hashOwnerName` (HMAC-SHA256 bytea) | `NAME_DECRYPTED` SQL expression (full plaintext to FE — but ONLY inside withTenant) | `sanitiseUserString` (defensive — names can carry shaped digits) | full name (Manager UI) | pino redact `*.name`  |
| `signatureBlob` (SVG)      | `encryptField` with org key             | n/a (one-way)                       | presigned download URL only                                                         | n/a                                                              | n/a — view in PDF      | n/a — never in errors |
| `fileName` (Excel uploads) | n/a (cleartext)                         | n/a                                 | `sanitiseFilenameForAudit` on wire AND audit (v8 SOLID-4)                           | same                                                             | sanitised              | n/a                   |
| `parsed_headers` (jsonb)   | n/a — sanitised at write                | n/a                                 | sanitised in worker pre-persist                                                     | `sanitiseUserStrings` array                                      | n/a                    | n/a                   |

### Manifestation

| Layer                          | File                                                                                                                                     | What lives there                                                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Encrypt helpers**            | `packages/db/src/helpers/owners.ts`                                                                                                      | `encryptField`, `encryptOwnerName`, `encryptOwnerPiiBatch`, `hashField`, `hashOwnerName`                                                                          |
| **Decrypt helpers**            | same                                                                                                                                     | `decryptField`, `decryptOwnerName`, `decryptOwnerPii`                                                                                                             |
| **In-SQL decrypt expressions** | `*.service.ts` files                                                                                                                     | `sql<string>\`pgp_sym_decrypt(${...}, current_setting('app.encryption_key'))::text\``— used in`.select({})` projections so ciphertext never crosses into userland |
| **Sanitisers**                 | `apps/worker/src/security/audit-sanitiser.ts` + `mapping-resolver.ts:sanitiseUserString` + `imports.service.ts:sanitiseFilenameForAudit` | The 7+ digit-run → `[N]` regex pattern                                                                                                                            |
| **Pino redact**                | `apps/api/src/main.ts` + `apps/worker/src/main.ts`                                                                                       | Path list including `*.national_id`, `*.phone`, `*.password`, `*.signature`, `*.row`, `*.rows`                                                                    |

### Change-propagation rule

**Adding a new PII field:**

1. Migration: ADD `<field>_encrypted bytea` + `<field>_hash bytea`
   (or text, but bytea is cheaper for byte equality)
2. Update drizzle schema (drop the cleartext column LAST if
   migrating an existing field)
3. Add `encrypt<Field>` / `decrypt<Field>` / `hash<Field>` helpers
   in `packages/db/src/helpers/owners.ts` (or sibling)
4. Update `PiiFields` interface + `encryptOwnerPiiBatch` to fold
   the field in (if it's owner-borne)
5. Every `.select({...})` projection: replace the column with the
   in-SQL decrypt expression (DON'T pull ciphertext into TS)
6. Add the field's pino redact path
7. Update the wire schema in `@emapp/shared-types` (still
   `z.string()` — encryption is invisible to FE)
8. Add a unit test in `packages/db/test/owner-name-encryption.spec.ts`
   (or sibling) covering round-trip + IV-randomness + HMAC
   determinism + batch order
9. Update `OPEN-ITEMS-v8.md §v8-S3` plan acceptance criteria if
   relevant

### Common pitfall

- **Half-encryption is worse than no encryption** — v8 Sec-4 caught
  this: `name` was cleartext while `national_id` was encrypted, so
  a Provider-Admin scan got every name across all orgs anyway. Pick
  a posture and apply it consistently.
- **Don't include the encrypted column in `.select()` then decrypt
  in TS** — that pulls ciphertext into the application layer. Use
  the in-SQL `pgp_sym_decrypt(..., current_setting(...))` expression.
- **Don't `console.log` an owner row** — even after decryption the
  output is PII. Use pino with the redact list.
- **Don't add a field to audit_log without sanitising** — v6 P0
  caught Manager-named columns like `Owner_038123456_phone` landing
  in `parsed_headers` jsonb. The sanitiser pattern is `\d{7,}` →
  `[N]`.

---

## §5 — The state machine (import_jobs.status — synced across 5 places)

The `import_jobs.status` enum has to stay synchronized across the
DB CHECK constraint, the worker's forward table, the API's
cancellable set, the FE display, and the audit catalog. Any drift
= broken state machine.

| Status             | DB CHECK | worker FORWARD            | API CANCELLABLE | API TERMINAL | Audit action                                                                          | FE display                   |
| ------------------ | -------- | ------------------------- | --------------- | ------------ | ------------------------------------------------------------------------------------- | ---------------------------- |
| `queued`           | ✓        | → `parsing`               | ✓               | —            | `import.created`, `import.start_requested`                                            | "ממתין"                      |
| `parsing`          | ✓        | → `validating`            | ✓               | —            | `import.parsing`                                                                      | "מנתח"                       |
| `validating`       | ✓        | → `persisting`            | ✓               | —            | `import.validating`                                                                   | "מאמת"                       |
| `persisting`       | ✓        | → `done`                  | ✓               | —            | `import.persisting`, `import.materialised`                                            | "כותב"                       |
| `awaiting_mapping` | ✓        | (pause — handler returns) | ✓               | —            | `import.awaiting_mapping`, `import.mapping_auto_resolved`, `import.mapping_submitted` | "ממתין למיפוי" (D.34 wizard) |
| `done`             | ✓        | terminal (null)           | —               | ✓            | `import.done`, `import.bytes_purged`                                                  | "הושלם"                      |
| `failed`           | ✓        | terminal (null)           | —               | ✓            | `import.failed`, `import.bytes_purged`                                                | "נכשל"                       |
| `cancelled`        | ✓        | terminal (null)           | —               | ✓            | `import.cancelled`, `import.bytes_purged`                                             | "בוטל"                       |

### Manifestation

| Layer                         | File                                                                                    | Synced thing                           |
| ----------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------- |
| **DB CHECK**                  | `packages/db/migrations/0022_import_jobs.sql` + `0027_import_jobs_awaiting_mapping.sql` | Status enum                            |
| **Drizzle column type**       | `packages/db/src/schema/imports.ts`                                                     | `text` (no enum type — CHECK enforces) |
| **Wire enum**                 | `packages/shared-types/src/import.ts:ImportStatusEnum`                                  | Same 8 strings                         |
| **Worker FORWARD table**      | `apps/worker/src/handlers/import-job.handler.ts:FORWARD`                                | Forward transitions                    |
| **API CANCELLABLE set**       | `apps/api/src/modules/imports/imports.service.ts:CANCELLABLE`                           | Cancellable statuses                   |
| **API TERMINAL set**          | same                                                                                    | Terminal statuses                      |
| **CANCELLABLE SQL guard**     | derived from CANCELLABLE Set via `sql.raw` (v8 SOLID-14)                                | DB-side guard in cancel UPDATE         |
| **Audit catalog**             | scattered across handler + service                                                      | Every transition writes audit          |
| **file_deleted_at CHECK**     | `packages/db/migrations/0032_import_jobs_file_deleted_at.sql`                           | "Terminal-only purge"                  |
| **purge handler eligibility** | `apps/worker/src/handlers/purge-import-bytes.ts`                                        | Mirrors the CHECK                      |
| **FE status display**         | TBD in Phase 4                                                                          | Hebrew labels                          |

### Change-propagation rule

**Adding a new status:**

1. Migration: extend the CHECK constraint
2. Update `ImportStatusEnum` in shared-types
3. Decide where it fits in FORWARD (worker) — null if terminal
4. Update CANCELLABLE / TERMINAL sets in `imports.service.ts`
5. If terminal: add to the `file_deleted_at` CHECK in the migration
6. If terminal: add the purge call site in the worker handler's
   terminal-state check
7. Add the audit action(s) for the entry transition
8. Update the worker `runStage` handler that produces this state
9. Add the FE label
10. Add a worker integration test asserting the full transition
    sequence + audit row sequence

### Common pitfall

- **Adding `awaiting_mapping` to FORWARD = infinite loop** — it's
  a pause state, terminal-for-this-attempt
- **Forgetting to add to CANCELLABLE** = silent — the API will
  return 409 `import_not_cancellable` correctly, but the FE will
  appear to have a stuck row
- **Forgetting to extend file_deleted_at CHECK on a new terminal
  status** = bytes never purged
- **Hardcoding the status list as a SQL literal** — v8 SOLID-14
  caught CANCELLABLE drift between the Set and the SQL IN clause;
  derive via `sql.raw`

---

## §6 — The role/permission propagation (D.17 — 6 roles, 3 tiers)

The role enum manifests in FIVE places that must stay in sync.
Any drift = security hole.

| Role           | Tier              | Auth method                 | RLS context                           | CASL ability           | FE shell                                   | Example endpoint guard                                |
| -------------- | ----------------- | --------------------------- | ------------------------------------- | ---------------------- | ------------------------------------------ | ----------------------------------------------------- |
| Manager        | Tier 1 (org)      | password + optional MFA     | `app.organization_id` + `app.user_id` | full org access        | Manager dashboard                          | `@Roles('manager')`                                   |
| Agent          | Tier 1            | password                    | same                                  | assigned-project only  | filtered Manager dashboard                 | `@AuthzAction(...)` + project membership check        |
| Viewer         | Tier 1            | password                    | same                                  | read-only              | read-only dashboard                        | same                                                  |
| Contractor     | Tier 2 (external) | password + share-link token | scoped to share JSONB perms           | per-share grants       | Contractor portal                          | share-token guard + JSONB scope                       |
| Tenant         | Tier 2            | SMS OTP                     | scoped to own owner row               | own record only        | OTP shell + signing UI                     | OTP guard + RLS on owner.id = self                    |
| Provider Admin | Tier 3 (Provider) | password + MANDATORY MFA    | BYPASSRLS via `withProvider`          | cross-tenant + audited | Provider Admin shell (separate route tree) | `@ProviderAdmin()` + `withProvider(uid, reason, ...)` |

### Manifestation

| Layer               | File                                                                                              | Role list                                      |
| ------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **DB enum**         | role column in `memberships`, `provider_users`                                                    | text columns + CHECK constraints               |
| **Wire enum**       | `packages/shared-types/src/auth.schemas.ts`                                                       | Same strings                                   |
| **Auth payload**    | `apps/api/src/modules/auth/auth.service.ts:AccessTokenPayload`                                    | `role` field                                   |
| **CASL policy**     | `apps/api/src/common/authz/policy.ts`                                                             | Define abilities per role                      |
| **Endpoint guards** | `apps/api/src/common/authz/authorization.guard.ts` + `@AuthzResource` + `@AuthzAction` decorators | Per-endpoint requirements                      |
| **RLS policies**    | scattered in migrations                                                                           | Role-aware where needed (most use org_id only) |
| **FE shell**        | TBD in Phase 4                                                                                    | Per-tier route trees                           |

### Change-propagation rule

**Adding a new role:**

1. Migration: extend the role CHECK in `memberships` (or wherever)
2. Update the `RoleEnum` in shared-types
3. Update `AccessTokenPayload` type
4. Update CASL policy with the new role's abilities (212 tests
   in `policy.spec.ts` will catch breaking changes — add tests
   for the new role's grants)
5. Decide which endpoints the role can hit — update controller
   decorators if needed
6. Decide RLS policies — most policies are org-scoped so don't
   need role awareness; but `provider_users` and similar are
   role-specific
7. Add the FE shell + route guards
8. Add Hebrew label for UI

### Common pitfall

- **Hardcoding role strings outside the enum** — drift bait
- **Adding a role without updating CASL** — every endpoint defaults
  to "deny" so this fails CLOSED (good) but the new role can't
  do anything (bad)
- **Forgetting MFA for Provider Admin** — D.21 mandates it; the
  auth.service login path checks `mfa_enabled_at IS NOT NULL` for
  Provider role

---

## §7 — The job queue contract (API producer ↔ pg-boss ↔ worker)

Async work goes through pg-boss (D.04 — no Redis). The payload
type is the single source of truth shared across producer + worker.

| Layer                  | File                                                     | What it does                                               |
| ---------------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| **Payload schema**     | `packages/jobs/src/import-job.ts:ImportJobPayloadSchema` | Zod schema for the queue message                           |
| **Producer interface** | `packages/jobs/src/producer.ts:IJobProducer`             | Abstract `send()` API                                      |
| **Concrete producer**  | `apps/api/src/queue/pg-boss-producer.ts`                 | pg-boss adapter (BYPASSRLS pool)                           |
| **Worker adapter**     | `apps/worker/src/pg-boss-adapter.ts:registerHandler`     | Adapter that turns IJobHandler into pg-boss work() handler |
| **Worker handler**     | `apps/worker/src/handlers/*.handler.ts`                  | IJobHandler implementation                                 |
| **Payload verifier**   | `apps/worker/src/handlers/verify-job-payload.ts` (§v7-A) | Cross-checks payload.orgId against the DB row              |
| **Job context**        | `packages/jobs/src/handler.ts:JobContext`                | logger + jobId + attempt + signal                          |
| **pg-boss schema**     | `pgboss` (set in worker main.ts + producer constructor)  | Queue tables, owned by worker (migrate: false on producer) |

### Change-propagation rule

**Adding a new job type:**

1. Define payload schema in `packages/jobs/src/<job>.ts`
2. Export from `packages/jobs/src/index.ts`
3. Implement `IJobHandler` in `apps/worker/src/handlers/<job>.handler.ts`
4. Register in `apps/worker/src/main.ts` via `registerHandler({...})`
5. Producer call site in the API service via `IJobProducer.send(name, payload, opts)`
6. Add a `verifyJobPayload`-style guard at handler entry if the
   payload carries tenant context (§v7-A)
7. Worker concurrency knob if needed (default 2; env-tunable
   via `WORKER_CONCURRENCY`)
8. Audit: write `<job_name>.received` at handler entry +
   `<job_name>.<state>` per transition

### Common pitfall

- **API producer must use `migrate: false`** — only the worker
  owns pg-boss schema migrations (v5 HIGH)
- **Trusting `payload.orgId` without verification** — §v7-A
  closure; the verifier cross-checks against the DB row before
  `withTenant(payload.orgId, ...)`
- **Forgetting `singletonKey`** — a second `/start` for the same
  row should be a producer-side no-op; use the row id as the key

---

## §8 — The SSE contract (worker UPDATE → poll → wire → FE)

The Server-Sent Events stream from `/imports/:id/stream` is the
most intricate sync chain in the system.

| Layer                   | File                                                            | What flows                                                                   |
| ----------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **Worker state UPDATE** | `import-job.handler.ts:runStage`                                | Guarded UPDATE inside withTenant tx; same tx writes the audit row            |
| **API poll**            | `imports.service.ts:streamProgress`                             | Polls `import_jobs` every 500ms via `withTenant`; diff against previous view |
| **Event encoding**      | `imports.service.ts:encodeSseFrame`                             | `event: X\ndata: {json}\n\n` SSE wire format                                 |
| **Event schema**        | `packages/shared-types/src/import.ts:ImportSseEventSchema`      | Discriminated union (progress \| end \| gone)                                |
| **Controller throttle** | `imports.controller.ts:@Throttle({limit:5, ttl:60_000})`        | Per-IP open-rate cap (§v8-S2)                                                |
| **Controller cap**      | `imports.controller.ts:MAX_ACTIVE_STREAMS = 30`                 | Per-process concurrent-stream cap (§v8-S2)                                   |
| **FE consumer**         | TBD in Phase 4 — `EventSource` + `ImportSseEventSchema.parse()` | Defensive parse on every frame                                               |

### Change-propagation rule

**Adding a new SSE event variant:**

1. Add to `ImportSseEventSchema` discriminated union in shared-types
2. Update API emit sites in `streamProgress`
3. Update FE consumer switch
4. Add a unit test in `imports-sse-schema.spec.ts` (rejects unknown
   variants for safety)

### Common pitfall

- **Don't widen the schema to `data: Record<string, unknown>`** —
  v8 SOLID-1 closure; per-variant strict shapes are intentional
- **Don't poll faster than 500ms** — v8 §v8-S2 doc'd math: 30
  active streams × 4 RT per 500ms = ~5 concurrent pool clients
- **Don't add to MAX_ACTIVE_STREAMS without proportional pool
  capacity** — see the §v8-S2 inline math
- **LISTEN/NOTIFY refactor is deferred** (`OPEN-ITEMS-v8 §v8-S2 Phase 2`) — don't
  pre-implement it in Phase 4; the current cap is sufficient for
  MVP scale

---

## §9 — The R2 lifecycle (upload presign → persist → purge)

Cloudflare R2 with the IStorageProvider seam. Every byte has a
lifecycle from presigned PUT through ISO-compliant purge.

| Stage                   | Component                                                                           | What happens                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Presign**             | `apps/api/src/modules/imports/imports.service.ts:create()`                          | mints a 5-min PUT URL with ContentLength bound; audit `import.upload_url_minted`       |
| **Upload**              | FE direct to R2 (NOT through API)                                                   | XHR PUT to the presigned URL                                                           |
| **Verify**              | `imports.service.ts:start() head()`                                                 | 500ms deadline race (§v7-P0); audit `import.upload_integrity_unverified` on skip       |
| **Enqueue**             | producer.send → pg-boss                                                             | singletonKey = row id; guarded started_at flip                                         |
| **Download**            | `apps/worker/src/handlers/import-job.handler.ts:parseStage`                         | getObjectStream + `capStreamSize` (§v7 byte ceiling); audit `import.r2_downloaded`     |
| **Persist**             | persistStage                                                                        | Encrypted owner/apartment/building/ownership rows                                      |
| **Purge**               | terminal-state check + `purge-import-bytes.ts`                                      | storage.delete + file_deleted_at + audit `import.bytes_purged`/`_failed`               |
| **Singleton factory**   | `apps/api/src/modules/documents/storage.ts` + `apps/worker/src/storage-provider.ts` | One S3Client per process (v7 HIGH); `resetStorageProvider()` for SIGHUP reload (§v7-C) |
| **Tuning**              | `r2-factory.ts`                                                                     | API maxAttempts:1 (fast fail); worker default 3 (batch)                                |
| **R2 bucket lifecycle** | Cloudflare config (NOT in repo)                                                     | 90-day safety-net delete at `org/*/import/` (recorded in §v8-S1 plan)                  |

### Change-propagation rule

**Adding a new storage operation (e.g. multipart upload):**

1. Extend `IStorageProvider` interface in `packages/db/src/providers/storage/storage.interface.ts`
2. Implement in `R2StorageProvider`
3. Implement in `FakeStorageProvider` (test-only, in-memory Map)
4. Add to `R2SdkDeps` in `r2-factory.ts` (SDK constructor for the
   new command type)
5. Pass through both `apps/api/src/modules/documents/storage.ts`
   and `apps/worker/src/storage-provider.ts` factories
6. Audit any new credential-using fetch (ISO A.12.4)
7. Add unit tests in `packages/db/test/r2-factory.spec.ts` (uses
   the Fake SDK pattern — no real R2 in tests)

### Common pitfall

- **Don't construct an S3Client directly** — use the factory
- **Don't `console.log` the presigned URL** — it's a bearer
  credential
- **Don't extend the TTL beyond 5min (upload) / 2min (download)** —
  D.28 sec posture
- **Don't skip the byte ceiling on a new stream consumer** —
  use `capStreamSize` (§v7-P0)

---

## §10 — The DI seam map (Fake ↔ Real per provider)

Every external dependency has an interface, a Fake, and a Real.
The composition root wires the Real in main; tests inject the Fake.

| Concern      | Interface                      | Real                                                      | Fake                                                      | Env switch                                                          |
| ------------ | ------------------------------ | --------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------- |
| Storage      | `IStorageProvider`             | `R2StorageProvider`                                       | `FakeStorageProvider`                                     | `R2_*` env vars present → Real, else Fake (dev) or FAIL FAST (prod) |
| Email        | `IEmailProvider`               | `ResendEmailProvider`                                     | `FakeEmailProvider`                                       | `RESEND_API_KEY` present → Real                                     |
| SMS          | `ISMSProvider`                 | (Israeli provider TBD)                                    | `NoopSMSProvider` (dev/test) + `FakeSMSProvider` (record) | `SMS_*` env present → Real                                          |
| Encryption   | `IEncryptionService`           | `PgcryptoEncryptionService`                               | `FakeEncryptionService`                                   | always Real in any env with PII_ENCRYPTION_KEY                      |
| Cache        | `ICacheProvider`               | `PostgresCacheProvider` (cache_kv table — D.04, no Redis) | `FakeCacheProvider`                                       | always Real                                                         |
| Realtime     | `IRealtimeProvider`            | `SseRealtimeProvider`                                     | `FakeRealtimeProvider`                                    | always Real                                                         |
| Job producer | `IJobProducer` (`@emapp/jobs`) | `PgBossJobProducer`                                       | (test-only Fake in spec files)                            | always Real                                                         |

### Composition roots

| Process  | File                                                      | What's wired                                            |
| -------- | --------------------------------------------------------- | ------------------------------------------------------- |
| API      | `apps/api/src/modules/*/`\*.module.ts` (NestJS providers) | `useFactory` calls to the singleton factories           |
| Worker   | `apps/worker/src/main.ts`                                 | Direct `new ImportJobHandler(storage, mappingResolver)` |
| Migrator | `packages/db/scripts/migrate.ts`                          | Just the pg pool + GUC setup                            |

### Change-propagation rule

**Adding a new provider type:**

1. Define interface in `packages/db/src/providers/<concern>/interface.ts`
2. Implement Real adapter (depends on the actual library)
3. Implement Fake (in-memory, deterministic, observable for tests)
4. Re-export from `packages/db/src/index.ts`
5. Wire in API via NestJS module factory (memoize if used in
   multiple modules — v7 HIGH)
6. Wire in worker via `main.ts`
7. Add unit tests for both Real and Fake
8. Document the env-switch behavior

### Common pitfall

- **Don't import the Real class outside the composition root** —
  Real depends on `@aws-sdk/*` etc.; pulling it into a test file
  drags the whole SDK into the test bundle
- **Don't memoize the Real without a reset seam** — v7 HIGH caught
  this for storage; SIGHUP rotation (§v7-C) needs `resetStorageProvider()`

---

## §11 — Common change-propagation playbooks

The 5 most frequent multi-layer changes. Print + tape to your
monitor.

### 11.1 Add a new field to an existing wire schema

```
1. packages/shared-types/src/<entity>.ts   ← Zod field
2. drizzle schema if it maps to a column   ← packages/db/src/schema/
3. migration if a new DB column            ← packages/db/migrations/
4. API service .select() projections       ← apps/api/src/modules/
5. API service input handling              ← if a request field
6. gen-api-docs run                        ← pnpm --filter @emapp/api gen:api-docs
7. FE consumer + test                      ← apps/web (TBD Phase 4)
8. Unit test pinning the schema            ← imports-v8-closures.spec.ts pattern
```

### 11.2 Add a new endpoint

```
1. Controller method                       ← apps/api/src/modules/<m>/<m>.controller.ts
2. Zod DTO via @emapp/shared-types         ← packages/shared-types/src/
3. Service method                          ← <m>.service.ts (using withTenant)
4. Throttle + AuthGuard + AuthzAction      ← decorators
5. Audit log row inside the tx             ← AuditService
6. Add to gen-api-docs ENDPOINTS array     ← apps/api/scripts/gen-api-docs.ts
7. Service-level integration spec          ← <m>.s8.spec.ts pattern
8. Optional: contract spec                 ← <m>.contract.spec.ts (live API)
```

### 11.3 Add a new PII field

See §4 above.

### 11.4 Add a new audit action

```
1. Pick a stable name "<entity>.<verb>"    ← e.g. import.bytes_purged
2. Add the AuditService.log() call         ← inside a tx
3. Document in the audit catalog (TBD)     ← future: extract to a single source
4. Update tests asserting audit sequences  ← import-job.handler.spec.ts §11 pattern
5. Sanitise any user-derived metadata      ← sanitiseUserString
```

### 11.5 Run an audit pass

```
1. Spawn 3 INDEPENDENT general-purpose agents (SOLID + security + perf)
2. Each agent gets:
     - CURRENT code only
     - NO prior audit history (don't paste PROGRESS.md)
     - One specific lens
3. Cross-confirm findings (≥2 agents → P0; single → HIGH/MEDIUM)
4. Triage:
     - Close cheap fixes (<2hr) in the same slice
     - Document expensive items with concrete plans in OPEN-ITEMS-vN.md
5. EVERY closure ships with a test that would have caught the bug
6. PROGRESS.md heartbeat updated
7. PR opened — only then stop and wait
```

---

## §12 — The 8-audit-pass archaeology (why some code looks weird)

If you read code and think "why is this written this way?" the
answer is usually in the audit-pass history. Cross-reference:

| Pattern                                                                    | Why                                                                             | Audit ref           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------- |
| `Object.assign(payload, verified)` at worker handler entry                 | Pre-v8 we trusted payload.orgId; tampered queue rows could pivot tenant context | §v7-A               |
| `current_setting('app.encryption_key')::text` in SQL                       | In-SQL decrypt so ciphertext never crosses into the application layer           | v8-S3               |
| `sql.raw([...CANCELLABLE].map(s => \`'${s}'\`).join(','))`                 | Set + SQL literal had silently drifted across maintenance                       | v8 SOLID-14         |
| `headWithDeadline(key, 500)` with AbortController                          | head() on critical path; SDK 30s timeout was holding Fastify workers            | v7 P0 + v8 SOLID-6  |
| `Sha256HexLowerSchema = z.string().regex(/^[0-9a-f]{64}$/)` (NO prefix)    | Two clients computing "same" hash sent different strings                        | v8 SOLID-2          |
| Pre-INSERT idempotency lookup scoped to (org, created_by, key)             | Without it, browser-resubmit got 409 instead of replay                          | v8 SOLID-1          |
| `validateStage` consults `mapping_template_id` BEFORE running resolver     | Resolver could miss wizard-approved template on retry → data loss               | v8 SOLID-5          |
| `import.upload_integrity_unverified` audit row                             | `head()` skip needed evidence for ISO A.12.4.1                                  | v8 Sec-5            |
| `cancellable.has(s)` AND `created_by === user.sub` on cancel/submitMapping | Authorization parity with start()                                               | v8 Sec-8            |
| 5000-row bulk INSERT chunking                                              | drizzle param count cap (65535); 5000 × 3 = 15000 leaves margin                 | v5 P0-1             |
| `withinTx` audit row tied to state UPDATE                                  | Audit can never desync from domain state                                        | v2 C5/v2 invariants |
| `pg-boss expireInSeconds = handler.timeoutMs/1000`                         | Stuck handler must release the slot                                             | S2 audit            |
| `parseStage` does `parseExcelFull` not `parseExcelHeader`                  | L6: validateStage was re-downloading + re-parsing (~1-2s of T6.10 budget)       | v2 L6               |
| `started_at IS NULL` guard on /start UPDATE                                | Concurrent /start calls each wrote audit + called producer.send                 | v8 Sec-3            |
| Magic-byte ZIP check in `zipPreflight` BEFORE the CD scan                  | Presigned PUT doesn't bind Content-Type — ransomware can land in bucket         | v8 Sec-7/SOLID-3    |
| `WORKER_CONCURRENCY` env knob (default 2)                                  | Hardcoded 1 = each customer waits behind the previous                           | v8 Perf-4           |
| `MAX_ACTIVE_STREAMS = 30` per process                                      | 41 concurrent SSE saturates the pg pool                                         | v8 §v8-S2           |
| `file_deleted_at` + CHECK + purge handler                                  | PII bytes lived forever; ISO A.18.1.4 + Israeli privacy law                     | v8 §v8-S1           |
| All owner reads decrypt name via SQL expression                            | `name` was cleartext while id/phone were encrypted (half-encryption worst-case) | v8 §v8-S3           |
| `reloadEnv()` + SIGHUP handler                                             | Credential rotation without process restart                                     | §v7-C               |

---

## §13 — Deployment topology

You don't deploy from this branch; the user does. But you need to
know the topology to make right environmental assumptions.

| Component           | Host                                                    | Secrets via                                       | Notes                                                     |
| ------------------- | ------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------- |
| API                 | Railway                                                 | Infisical → Railway env                           | NODE_ENV=production, scaled by replicas                   |
| Worker              | Railway                                                 | same                                              | WORKER_CONCURRENCY=2 default                              |
| Postgres            | Neon (developer plan today; production plan eventually) | DATABASE_URL + PROVIDER_DATABASE_URL in Infisical | RLS via app_user role; BYPASSRLS via provider_app_role    |
| R2 storage          | Cloudflare                                              | R2\_\* in Infisical                               | Bucket `emapp-prod` (TBD); dev is `emapp-dev`             |
| FE                  | Cloudflare Pages                                        | env via Pages dashboard                           | Cloudflare custom domain for R2 (§v8-S2-deferred)         |
| Email               | Resend                                                  | RESEND_API_KEY in Infisical                       |                                                           |
| SMS                 | Israeli provider (Inforu / 019)                         | (TBD env vars)                                    |                                                           |
| Monitoring          | Sentry                                                  | SENTRY_DSN in Infisical                           | apps/api/src/instrument.ts                                |
| Secret store        | Infisical                                               | (the user's account)                              | NEVER .env in repo                                        |
| Audit log retention | Postgres `audit_log` table                              | n/a                                               | Append-only via trigger; immutability enforced by trigger |
| pg-boss schema      | Postgres `pgboss` schema                                | DATABASE_URL                                      | Worker owns DDL (migrate:true); API is migrate:false      |

### Migration rollout pattern (production)

For a non-destructive migration (ADD nullable column / ADD index):

1. Migration committed + merged to main
2. Auto-deploy applies via `pnpm db:migrate`
3. Code that uses the new column ships in the next deploy

For a destructive migration (DROP column / NOT NULL):

1. Two-phase rollout: deploy code that handles BOTH old + new
   shapes
2. Migration that drops/adds NOT NULL
3. Cleanup deploy that removes the dual-handling

§v8-S3 (owners.name encryption) used the single-migration variant
because dev is the only deployed env. Production rollout would
require the two-phase pattern.

---

## §14 — What to read first if you're about to touch:

- **A schema** → §2 (DB layer) + §4 if PII
- **An endpoint** → §1 (contract) + §3 (errors) + §6 (roles)
- **A job** → §7 (queue) + §10 (DI)
- **The import wizard** → §5 (state machine) + §8 (SSE) + §9 (R2)
- **An auth flow** → §6 (roles) + check `docs/08-auth-api-flows.html`
- **The FE** → ONBOARDING.md §5 + §1 + §3 + §6 (here)

If you're touching more than one layer, this whole document is
the reading list before you write the first line of code.

---

## §15 — When to update this document

When you introduce a new layer or a new sync rule that wasn't
captured before. This file is a living artifact; v9 onwards
should append, not replace.

Don't update it for routine changes (a new endpoint, a new
migration). Update it for **architectural** moves (a new external
provider, a new tier, a new way to do auth, a new cross-cutting
concern).
