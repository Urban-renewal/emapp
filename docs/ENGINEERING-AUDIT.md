# EMAPP — Engineering Audit & Source-of-Truth Roadmap

> **Audience:** the owner (a domain expert in Israeli urban renewal, **not** a
> systems architect) plus the engineering team. Written by the acting CTO,
> 2026-06-13, after a full adversarial audit across 8 engineering dimensions.
> Severities and verdicts below are **post-verification** — every finding was
> re-checked against the real code, and inflated claims were downgraded.
>
> **Where this sits:** `docs/DECISIONS*` (law) → per-epic design docs (the plan)
> → **this file** (the prioritized macro→micro roadmap) → `docs/V12-SLICE-LEDGER.md`
> (the honest execution log). Numbering continues the `D.NN` decision series.
>
> **How to read it:** Section 1 is the plain-language verdict. Section 2 groups
> everything into themes you can reason about without being an engineer. Section 3
> is the actionable backlog (start at the top). Section 4 is what is genuinely
> good — read it so you know the foundation is sound.

---

## 1. Executive summary — honest health of the system

**Overall: the system is healthy and unusually disciplined for a 2-developer
team. It is production-shippable. It is not fragile.** The foundations a SaaS
lives or dies on — tenant isolation, PII encryption, validated inputs, a real
green-gate pipeline — are present and, in several places, mechanically enforced
(the build literally fails if someone breaks the most dangerous rules). The audit
found **no live data-breach, no cross-tenant leak you can reach through the
product today, and no correctness bug in the core legal invariant** (ownership
shares summing to the whole per apartment — that one is database-enforced with
exact integer math).

What the audit _did_ find is a set of **"day-2" risks**: things that are fine
while the system runs happily, but that will bite when something goes wrong, when
the data grows, or when a future change is made carelessly. These are the gap
between "it works" and "it survives in production and stays safe to change."

**The 5 biggest risks to surviving in production and being changed safely:**

1. **When something breaks, you cannot see the chain of failure.** Errors that
   happen inside a normal request are written to a server log but **never sent to
   Sentry** — the very tool you open to investigate. The background worker (which
   runs every Excel import) has **no Sentry at all**. And the breach-detection
   alarms (failed-login bursts, cross-tenant PII-access spikes) are wired to a
   **silent "no-op" sink unless one config value is set** — so a real attack may
   page no one. _You could have a recurring failure degrading a paying customer
   and your dashboards stay quiet._

2. **Authorization has two brains that can disagree.** The system runs a modern
   permission engine for the coarse "can this person reach this endpoint" check,
   but ~20 services still do the fine "which records can they see" check off an
   **older, simpler role label**. Today this fails _closed_ (safely) for the
   built-in roles — but the moment you use the **custom-roles / per-person
   override feature that is already live**, those two brains diverge: a granted
   permission may silently not work, and the screen may show buttons that then
   error. It is a correctness/usability hazard now and a security hazard if a
   future refactor flips a safe default.

3. **A security-critical rule is copy-pasted in ~16 places.** The rule "an agent
   may only see projects assigned to them" is hand-duplicated, near-identically,
   across sixteen services. Every copy is correct today — but the next person who
   copies a slightly-stale version, or forgets one clause, opens a cross-project
   data leak that no single test would catch.

4. **Encryption is a static secret, not a managed key.** All customer PII is
   encrypted under one key with no version stamp. **Rotation is impossible**
   without re-encrypting everything, **key loss is unrecoverable**, and the
   startup self-check proves the key is _internally consistent_ but **not that it
   can actually decrypt the data already stored**. A typo'd or rotated key boots
   green and then 500s on the first real read. This is the single most
   _irreversible_ risk on the list.

5. **Two silent data-correctness footguns at scale.** (a) A pagination bug
   (already diagnosed by the team, fix written but **not merged**) can silently
   drop rows when many are created in the same millisecond — exactly what bulk
   imports do — across ~22 list endpoints, in a product whose whole job is
   accounting for _every_ owner. (b) A migration-drift guard was _built_ but
   **wired nowhere**, so a database silently missing a migration would serve
   traffic against a schema it thinks is current.

None of these blocks launch. All are bounded and fixable, and the first several
are surgical (a few lines, one file). The rest of this document turns them into a
concrete, ordered plan.

---

## 2. Macro themes

Each theme groups related findings into one idea you can hold in your head, with
_where we are / where we need to be / why it matters to your product._

### Theme A — Observability & the failure chain ("can I see what broke?")

**Where we are:** the individual parts are excellent — a redacting logger, Sentry
(for the API), an append-only `audit_log` written in the same transaction as the
data it records, a pluggable metrics/alert seam, health probes. But the parts
**do not connect into one story**. In-request 500s never reach Sentry
(`http-exception.filter.ts:49-73,116-123` — no `captureException`); the worker has
no Sentry at all (`apps/worker/src/main.ts`, and `@sentry/node` isn't even a worker
dependency); breach alerts default to a silent sink
(`observability.factory.ts:31-49` — `Noop` unless two env vars are set, with no
boot warning); and there is **no correlation/request ID** tying the browser error
to the API log to the worker job to the audit row
(`app.module.ts:54-61` configures the logger with no `genReqId`).

**Where we need to be:** one request carries one ID from browser → API → worker →
audit; every caught 500 and every background-job failure reaches Sentry; and in
production the _absence_ of an alert destination is itself a loud boot failure —
mirroring the fail-fast posture the rest of the system already uses for
encryption and DB roles.

**Why it matters to your product:** your own stated fear is _"אם לקוח יחכה איבדנו
אותו"_ — if a customer's import silently fails and you get no page, they churn and
you never knew. This theme is the difference between "a customer reports a problem
and you find it in minutes" and "you grep logs by guessed timestamps and hope."

### Theme B — Authorization consistency (the strangler residual)

**Where we are:** a half-finished migration. The new permission engine answers the
coarse gate; ~20 services answer fine record-scoping off the legacy JWT `role`
enum (`authorization.guard.ts:78-82` vs `projects.service.ts:177,206,259,500`).
For the three built-in roles these stay in lockstep. But **custom roles and
per-member overrides are live and org-assignable** (`roles.service.ts:530-539`),
and they break the lockstep: the engine grants a permission the service then
ignores (a granted action silently does nothing, or the UI shows a button that
403s — `auth.service.ts:813-816` advertises the engine set the service won't
honor). The team documented this residual honestly
(`architecture/authz-single-source.spec.ts:21-24`) but the spec pins only 2 core
files, not the 20 services.

**Where we need to be:** one source of truth for an authorization decision.
Record-scoping derived from the engine, not a denormalized role copy; `/me`
advertising exactly what the server will enforce; the legacy `policy.ts` +
equivalence map retired once the last `user.role` branch is gone.

**Why it matters to your product:** you are building a _manager-controlled
capability matrix_ (D.46/D.54) as a headline feature. Right now that feature is
partly non-functional and inconsistent the moment a manager strays from the three
presets — and authorization bugs in a PII-heavy product are the worst kind: silent.

### Theme C — Change-safety hotspots (duplication of load-bearing logic)

**Where we are:** the dangerous-to-change logic is duplicated rather than shared.
The agent-visibility JOIN is copy-pasted across ~16 services
(`buildings.service.ts:72`, `parcel-setups.service.ts:146`,
`documents.service.ts:219` — byte-identical). The Excel-import worker re-implements
find-or-create for buildings/apartments/owners parallel to the API's domain
services (`import-job.handler.ts` vs `owners.service.ts:444`). The document
at-rest crypto is hand-rolled inline in a 1280-line service instead of behind the
project's own provider seam (`documents.service.ts:977,995`).

**Where we need to be:** each security-critical or domain-shaping rule lives in
**one** place with **one** test pinning it, so a change is surgical (touch one
module) instead of shotgun surgery across 16.

**Why it matters to your product:** this is the "can we change it safely over
time" axis. Today a rule change ripples; tomorrow someone copies a stale variant
and ships a leak. Extracting these is mechanical, high-leverage, and converts
"16-site ripple" into "1-site change."

### Theme D — Encryption key lifecycle & migration drift (irreversible / invisible)

**Where we are:** encryption is modeled as a single static secret. No key-id/
version column on any encrypted row (`env.ts:34`, `projects.ts:225-239`); the
startup probe round-trips a _fresh_ value, never an at-rest one
(`startup-check.ts:18-32`); the document envelope writes a `keyId` byte it never
reads back (`documents.service.ts:95,1014`). Separately, the migration-drift
primitive `findUnappliedMigrations` exists and is unit-tested but is **called at
no boot path** (`journal-integrity.ts:169-177`, zero call sites in `apps/`).

**Where we need to be:** the boot self-check proves it can decrypt _real_ stored
data (a canary row); a key-id column + small keyring lets two keys live at once
(the precondition for any rotation); and boot refuses to start if the live DB is
missing a migration the journal says should be applied.

**Why it matters to your product:** these are the two failure modes you cannot
walk back. Key loss = the entire customer PII corpus is mathematically gone. A
silent missing migration = bad data lands with no error. Both are surgical to
_detect_ loudly (the canary check and the drift check are ~20 lines each); the
full rotation capability is larger but can follow.

### Theme E — Pagination & data-volume correctness

**Where we are:** the pagination _shape_ is correct (createdAt DESC, id DESC
tie-break), but the cursor serializes timestamps at millisecond precision against
microsecond DB columns (`keyset-cursor.ts:16-20` vs `_common.ts:5`). The team
already diagnosed this (memory `project_keyset_cursor_microsecond_bug`), wrote the
fix (`fix/keyset-cursor-ms-precision`, commit `04190a8`) with a deterministic RED
test — but it is **not merged to main**, so the silent row-skip is live across
~22 endpoints.

**Where we need to be:** the fix branch landed, the cursor lossless against the
column's real precision, the RED test guarding it.

**Why it matters to your product:** the trigger (≥3 rows in one millisecond) is
exactly what your bulk Excel imports produce. A signature or owner silently
missing from a paginated scan — in a product whose entire purpose is _accounting
for every owner's signature_ — is a correctness defect, not a cosmetic one.

### Theme F — Test authenticity & green-gate integrity

**Where we are:** the DB-real test layer genuinely "simulates truth" (RLS
isolation, share-fraction BigInt math, OTP replay, worker data-loss recovery — all
against real Postgres, with teeth). The weaknesses are concentrated and specific:
the Playwright journey specs are **author-graded round-trips** (the test writes the
fake BE response _and_ asserts against it — `j4-signature-lifecycle.spec.ts:49,231`)
and aren't schema-validated, so they can't catch BE contract drift; one signature
**functional** suite is wired _out_ of the only CI job that boots a real API
(`ci.yml` conformance runs only `contract.spec`, missing
`phase5-signatures.functional.spec.ts`); the worker test job rides on
`--passWithNoTests` so a glob typo silently deletes 33 specs from the gate; and a
couple of "known flakes" are actually load-dependent _and_ weak completeness
assertions.

**Where we need to be:** e2e stubs validated against the shared-types schema; the
critical signature journeys run against the real API in CI; no runner treats
"found nothing" as success; flakes root-caused, not rerun.

**Why it matters to your product:** the charter's quality bar is "tests simulate
truth, author ≠ code-author, no green-by-construction." These gaps are exactly the
places where a future refactor stays green while breaking production — and they
cluster on the **signature flow**, your core legal artifact.

### Theme G — UI automation ("does the system set things up for the user?")

**Where we are:** the discipline is strong (clean `api → adapters → models → hooks`
pipeline, Zod on every response, shared list states) and there is one genuinely
smart north-star flow — the Phase-3 parcel auto-setup with city pre-fill and a
floors×apartments generator. But that automation is **islanded**. Everywhere else
is single-record toil: apartments created one-at-a-time outside parcel-setup
(`buildings/[id]/apartments/new`); the import mapping wizard makes the manager
**retype column index numbers from memory** even though the parsed headers are
already stored server-side (`imports/[id]/mapping/page.tsx:48-53`); ownership
splits among N owners must be hand-computed to sum to 100 (no "split equally");
signature-request creation uses flat, truncated, unscoped dropdowns. Cross-cutting:
**zero optimistic UI** (every action waits a full round-trip) and no shared toast/
dialog primitives (each component re-invents feedback).

**Where we need to be:** the auto-setup pattern extended — bulk apartment
generation, header-name dropdowns the user _confirms_ instead of _transcribes_,
equal-split, context-scoped pickers — plus optimistic updates on the hot mutations.

**Why it matters to your product:** the charter names "the system sets up the
project" as the north star and "manual toil the user shouldn't be doing is a UX
defect." None of these are correctness bugs, but they are precisely the toil you
want automated, and they compound as data volume grows.

### Theme H — Architecture seams & enforcement (mostly strength, two gaps)

**Where we are:** this is largely a _strength_ (see Section 4) — but two enforcement
gaps. (a) Auth-presence on controllers is **honor-system**: there's no global
default-deny guard and no architecture test, so one forgotten `@UseGuards` ships a
fully-public domain controller (`app.module.ts:128-134` — only the throttler is
global). (b) The excellent tenant-isolation ratchet only scans _named_ `@emapp/db`
imports, so a namespace/barrel import could puncture RLS undetected
(`tenant-isolation.guard.ts:47`).

**Where we need to be:** a `@Public()`-aware global auth guard (the decorator
already exists) plus an architecture ratchet asserting every domain controller is
authenticated — converting "forgot a guard" from a silent prod exposure into a
build failure, consistent with the RLS ratchet the team already built.

**Why it matters to your product:** the system's whole security philosophy is
fail-closed and _mechanically enforced_. These two gaps are the only places the
philosophy is "by convention," and convention is what the GET-fallback login
incident (#377's cousin) taught you not to trust.

---

## 3. Prioritized micro-slice backlog

Ordered by **(impact × risk) / effort**. Every slice runs the full green-gate:
**independent test-author writes RED → builder makes it GREEN → manager verifies →
code-review + (security-sensitive) security-review → live browser QA for any
user-facing change → CI green → merge-on-green.** The first ~8 are immediately
actionable and mostly surgical.

| #      | Theme | Slice — what + why                                                                                                                                                                                                                                                                                                                                 | Macro need served                                        | Affected area                                                                                                          | Effort |
| ------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------ |
| **S1** | A     | **Caught-500s → Sentry.** Add `Sentry.captureException` to the `status>=500` branch of the global exception filter (or wire `@sentry/nestjs` `SentryGlobalFilter`), scoped with route/user/org. Today every in-request 500 is invisible to Sentry.                                                                                                 | Observability: errors reach the alerting tool            | `apps/api/src/common/filters/http-exception.filter.ts`                                                                 | S      |
| **S2** | A     | **Worker Sentry parity.** Add `@sentry/node` + a worker `instrument.ts` (DSN-guarded init + pool observer), import it first in `main.ts`, capture in crash handlers + the pg-boss retry branch (tag jobId/attempt/org). Every import/reaper failure is currently invisible.                                                                        | Observability parity across processes                    | `apps/worker/src/{main,bootstrap}.ts`, `pg-boss-adapter.ts`, new `instrument.ts`                                       | S      |
| **S3** | A     | **Fail-loud on missing alert/metrics config.** Add `ALERT_WEBHOOK_URL` + `METRICS_BACKEND` to `env.ts` with a production `superRefine` (or a `verifyObservabilityStartup` boot probe) mirroring `verifyProviderPoolRole`; add to RUNBOOK. Today breach alerts silently hit a no-op sink.                                                           | Observability: alerts have a destination                 | `apps/api/.../observability.factory.ts`, `packages/db/src/env.ts`, `RUNBOOK.md`                                        | S      |
| **S4** | D     | **At-rest decryption canary at boot.** Extend `verifyEncryptionStartup` to decrypt one persistent canary ciphertext written under the live key, so a changed/lost/typo'd PII key fails **loud at boot** instead of per-read in prod. Highest-value first step on the irreversible risk.                                                            | Key lifecycle: prove decryptability, not consistency     | `packages/db/src/startup-check.ts` (+ canary seed)                                                                     | S      |
| **S5** | D     | **Wire the migration-drift guard at boot.** Call the existing, unit-tested `findUnappliedMigrations` against live `__drizzle_migrations` in API + worker boot; refuse to start on drift. Primitive exists; just connect it.                                                                                                                        | Fail-fast on stale schema (M-1 runtime half)             | `packages/db/src/migrations/journal-integrity.ts` callers, `apps/api/src/main.ts`, worker boot                         | S      |
| **S6** | E     | **Land the keyset ms-precision fix.** Review + merge `fix/keyset-cursor-ms-precision` (`04190a8`) — shared `keysetCondition`/`keysetOrderBy` using `date_trunc('ms', …)` on filter + order-by, sweeping all ~22 sites, with the deterministic RED test. Stop the silent row-skip.                                                                  | Pagination correctness at data volume                    | `apps/api/src/common/keyset-cursor.ts` + ~22 list services                                                             | M      |
| **S7** | C     | **Extract the agent-visibility helper.** Lift `assertProjectVisible`/`assertApartmentVisible`/`assertBuildingVisible` into `common/authz/visibility.ts` `(tx, user, id)`, unit-test the agent/non-agent/unassigned branches once, replace all ~16 inline copies (keep no-oracle 404). 16-site ripple → 1-site change.                              | Change-safety: one home for the D.17 invariant           | `apps/api/src/modules/*` (16 services) + new `common/authz/visibility.ts`                                              | M      |
| **S8** | H     | **Global default-deny auth guard + ratchet.** Promote `AuthGuard` (+ TenantGuard) to a `@Public()`-aware `APP_GUARD`, annotate the ~4 genuinely-public controllers, and add an architecture spec asserting every domain controller is authenticated. "Forgot a guard" becomes a build failure.                                                     | Secure-by-default enforcement                            | `apps/api/src/app.module.ts`, `architecture/`, ~4 controllers                                                          | M      |
| S9     | F     | **Re-wire the signature functional suite into the live gate.** Broaden the conformance job filter to `contract.spec\|functional.spec` and add `REQUIRE_LIVE=1` that converts the LIVE skip into a hard failure, so `phase5-signatures.functional.spec.ts` actually runs against the booted API.                                                    | Green-gate integrity on the core flow                    | `.github/workflows/ci.yml`, the LIVE gate helper                                                                       | S      |
| S10    | F     | **Schema-validate e2e stubs.** Wrap Playwright `route.fulfill` bodies in a typed helper that `Schema.parse()`s against shared-types before fulfilling (drift detector), and promote 2-3 critical journeys (create-signature, public-sign) into the live conformance job.                                                                           | Test authenticity: stubs bound to the real contract      | `apps/web/e2e/*`, conformance job                                                                                      | M      |
| S11    | F     | **Remove `--passWithNoTests` from the worker** (it always has specs) or add a meta-spec asserting ≥N worker specs are discovered, so a glob break fails CI instead of passing silently.                                                                                                                                                            | Fail-loud on missing coverage                            | `apps/worker/package.json`, `vitest.config.ts`                                                                         | S      |
| S12    | B     | **Stop the authz split-brain at the source (interim).** Refuse to assign a custom-role/override to a member whose `memberships.role` would skip record-scoping, OR map custom-role holders onto the agent record-scoping path (fail-closed); add a spec asserting no service record-scopes off `user.role` for an engine-grantable permission.     | Authorization consistency (containment)                  | `apps/api/src/modules/roles/`, `members/`, `architecture/`                                                             | L      |
| S13    | B     | **Finish the strangler (the real fix).** Introduce an engine-derived `effectiveScope(user, resource)` predicate; replace `user.role === 'agent'`/`!== 'manager'` record-scope branches service-by-service behind it; make `/me` derive permissions + `view_owner_pii` from the engine for **all** roles; retire `policy.ts` + the equivalence map. | Single source of truth for access                        | `common/authz/*`, ~20 domain services, `auth.service.ts` getMe                                                         | XL     |
| S14    | C     | **Promote the document envelope to a provider seam.** Move `encryptEnvelope`/`decryptEnvelope`/`docEncryptionKey` into an `IDocumentEnvelopeCipher` in `packages/db` with its own spec, inject by token. Pairs with S15. Restores seam consistency; makes the crypto unit-testable.                                                                | SOLID seam culture, no exceptions                        | `documents.service.ts`, `packages/db/src/providers/encryption/`                                                        | M      |
| S15    | D     | **Real keyring for the document envelope.** Make `decryptEnvelope` resolve the key by the stamped `keyId` against a small env keyring (id→key); default `0x0001` to today's key so existing docs keep decrypting. Today rotating `DOC_ENCRYPTION_KEY` silently bricks all stored docs. Until shipped, RUNBOOK must say "never change in place."    | Key lifecycle: rotation actually safe                    | `documents.service.ts`, `env.ts`, `RUNBOOK.md`                                                                         | M      |
| S16    | D     | **Versioned PII keyring + rotation runbook.** Add a `key_id` column to every pgcrypto-encrypted table + a `{key_id→key}` map so two keys can be live during rotation; document + test a re-encrypt backfill. The structural fix behind S4.                                                                                                         | Key lifecycle: zero-downtime rotation                    | `packages/db/src/helpers/owners.ts`, encrypted-table schemas, migration                                                | L      |
| S17    | A     | **Request-correlation ID end-to-end.** FE mints/forwards `X-Request-Id`; API `genReqId` honors it + stamps every log line + echoes it as `error.requestId` on the 500 envelope; thread it into the import job payload + `audit.metadata`. One ID FE→API→worker→audit.                                                                              | Observability: stitch the hops                           | `apps/web/src/lib/api-client.ts`, `app.module.ts`, filter, jobs, audit                                                 | M      |
| S18    | A     | **Session id on audit rows + count swallowed failures.** Thread the JWT `sid` into a shared `buildAuditDefaults(user)` helper used at all ~40 call-sites; emit a metric counter + Sentry breadcrumb in the worker's best-effort audit/R2-purge `catch` blocks so audit gaps are alertable, not buried.                                             | Observability: forensic completeness                     | `packages/db/src/audit/`, ~40 call-sites, `import-job.handler.ts`                                                      | M      |
| S19    | G     | **Import mapping wizard: confirm-the-guess, not blind transcription.** Surface the already-stored `parsed_headers` on the mapping read model; replace the 6 blind numeric column inputs with header-name dropdowns auto-matched to canonical fields. Eliminates a high-error PII-alignment toil path.                                              | UI automation: don't re-enter known data                 | `packages/shared-types/src/import.ts`, imports serializer, `imports/[id]/mapping/page.tsx`                             | M      |
| S20    | G     | **Extend the apartment generator beyond parcel-setup** — add the floors×per-floor generator (and/or paste-list) to the building's add-apartment screen, reusing the proven materialization path.                                                                                                                                                   | UI automation: extend the north star                     | `buildings/[id]/apartments/new/page.tsx`, parcel-setup generator                                                       | M      |
| S21    | G     | **"Split equally" (חלוקה שווה) on the ownerships editor** — distribute 100% across owner rows (remainder to last); pure client-state. Kills the most common inheritance-case arithmetic rejection.                                                                                                                                                 | UI automation: smart defaults                            | `apartments/[id]/ownerships/page.tsx`                                                                                  | S      |
| S22    | G     | **Optimistic UI on the 4-5 hottest mutations** (archive, create-in-list, set-ownerships, mark-task) via `onMutate`/rollback; leave PII/conflict-prone ones invalidate-only. The cheapest "feels fast" win.                                                                                                                                         | UI: perceived performance                                | `apps/web/src/hooks/*`                                                                                                 | M      |
| S23    | G     | **Shared toast + confirm-dialog primitives** (shadcn) and migrate components off inline string-state feedback. Consistent UX; cheaper future slices.                                                                                                                                                                                               | UI: design-system feedback layer                         | `apps/web/src/components/`, opportunistic adopters                                                                     | S      |
| S24    | G     | **Context-scope the signature-request create flow** — drive from project/apartment context with owner pre-population, project filter + typeahead, remove the silent 100-item cap.                                                                                                                                                                  | UI: context-aware, no silent truncation                  | `signature-requests/new/page.tsx`                                                                                      | M      |
| S25    | C     | **Extract shared find-or-create domain primitives** for building/apartment/owner that both `owners.service` and the import worker call; decompose `import-job.handler` into parse/resolve/persist/summarize stages.                                                                                                                                | Change-safety across api/worker boundary                 | `apps/worker/src/handlers/import-job.handler.ts`, `apps/api/src/modules/{owners,apartments,buildings}`, new shared pkg | L      |
| S26    | F     | **Harden two weak/flaky tests into real ones.** Make the provider-audit cursor walk deterministic (unique action-prefix partition, walk to `has_more=false`); add a DB-real keyset spec seeding N rows at one fixed `createdAt` and asserting exact-once delivery (covers the never-exercised tie-break branch).                                   | Test authenticity on shared state + critical branch      | `provider-audit.spec.ts`, new keyset spec                                                                              | S      |
| S27    | H     | **Close the RLS-ratchet namespace hole** — extend `findRawClientImporters` to flag `import * as X from '@emapp/db'` and aliased re-exports / `.connect(`/`.query(` on a db namespace. Last gap in the strongest safety net.                                                                                                                        | Fitness-function completeness                            | `architecture/tenant-isolation.guard.ts`                                                                               | S      |
| S28    | C/D   | **Fix `PostgresCacheProvider.incrementCounter`** (`CAST(jsonb AS integer)` is invalid → 500 on first conflict) to match the proven `value::text::int` cast in the export limiter; add a 2-increment test, or delete + consolidate. Latent loaded gun for the next limiter author.                                                                  | No untested code paths drifting from working siblings    | `packages/db/src/providers/cache/postgres.provider.ts`                                                                 | S      |
| S29    | D     | **DB CHECK constraints on `apartments.unit_type` + `building_sections.kind`** (`NOT VALID` then `VALIDATE`) to match the belt-and-suspenders pattern newer tables already use.                                                                                                                                                                     | Integrity: DB is the last line, not the Zod edge         | new migration                                                                                                          | S      |
| S30    | D     | **Co-tenancy constraint on `ownerships`** — a constraint trigger (or denormalized `org_id` + CHECK) asserting the apartment's org and owner's org match, so cross-tenant binding is a DB invariant, not an emergent property of single-org sessions.                                                                                               | Tenant isolation on join tables by constraint            | `ownerships` schema, migration                                                                                         | M      |
| S31    | H     | **Behavioral test matrix for agent-write endpoints** (capability-off agent → 403) so the D.54 guarantee survives a refactor that defeats the source-text guard's regex.                                                                                                                                                                            | Defense-in-depth: runtime check, not just text heuristic | `apps/api/src/modules/*` agent-write specs                                                                             | M      |

**Watch-items (no action now, documented ceilings):** the large-but-cohesive
services (`imports`/`signature-requests`/`documents`) — decompose opportunistically
when touched, the export module shows the team can; `withTenant` connection-per-read
and the in-memory export/decrypt buffering — fine for MVP scale, add a concurrency
semaphore before raising the apartment/doc-size caps; `AccessTokenPayload` living in
the heavy auth service — move to a leaf module when S13 reshapes it into a richer
Principal.

---

## 4. What is already strong (the foundation is not broken)

A fair audit names the genuinely good patterns. These are real and load-bearing —
the owner should know the system is built on solid ground.

- **Tenant isolation is mechanically enforced, not honor-system.** Every customer
  DB read goes through `withTenant`/`withProvider`, and a **build-time ratchet**
  (`tenant-isolation.guard.ts`) fails CI if a module imports the raw DB client.
  RLS is `FORCE`'d on every tenant table. This is the single most important
  property for a multi-tenant SaaS, and it is _enforced_, not just intended.

- **The core legal invariant is database-enforced with exact math.** Ownership
  shares summing to the whole per apartment is guaranteed by a deferred constraint
  trigger using exact integer cross-multiplication (no `33.33×3=99.99` float
  drift), correctly excluding renters, with an O(apartments) per-transaction memo
  (`migrations/0065`, `0030`). It took 3 review rounds to ship correctly — and it
  _is_ correct. Treat it as a frozen, test-pinned asset.

- **The provider seams are exemplary and real.** Ten `I*Provider` interfaces
  (SMS, storage, email, file-scan, parcel, extraction, realtime, metrics, alert,
  encryption) — each interface-first in `packages/db`, DI-injected, resolved by a
  single factory with the _correct_ fail-fast-vs-fail-open policy (SMS/scan throw
  in prod; parcel/extraction fall open as enrichment). These are backed by real
  engines (Inforu SMS, R2, ClamAV, Resend, LocalMapi, SSE, Prometheus), not stubs.
  **You can genuinely swap a provider without touching service code** — exactly the
  change-safety the charter demands.

- **The tabu-extraction envelope template is a reusable, proven pattern.** Used 3×
  (tabu, step-up posture, parcel) — the established template for new auto-setup
  flows. The Phase-3 parcel auto-setup built on it is the UI north star, and it
  works live end-to-end.

- **The DB-real test layer simulates truth and has teeth.** RLS cross-tenant
  isolation, share-fraction BigInt boundary math, OTP replay/lockout, worker
  data-loss recovery, signature-token crypto isolation, migration journal
  integrity — all against real Postgres, real triggers, real pgcrypto. The
  green-gate is real for the BE contract because a dedicated CI job boots the
  compiled API and runs the contract suites against it.

- **The security baseline is the product of repeated hardening.** Audience-separated
  JWT tiers (token-confusion structurally blocked), single-sourced PII masking,
  no-oracle/anti-enumeration public endpoints, httpOnly+secure+sameSite cookies
  with path-scoped refresh, concurrency-correct idempotency, textbook public-sign +
  OTP + step-up flows (CSPRNG, hashed codes, atomic single-use, session-bound
  unlock), and the D.54 agent-capability fail-open CI wall.

- **The migration discipline already anticipated its own footgun.** The team
  diagnosed the drizzle silent-skip from the ORM source and shipped a static
  journal-monotonicity guard (the M-1 work). The runtime half is built and just
  needs wiring (S5) — the hard diagnostic work is done.

The themes in Section 2 are about taking a system that is _already safe and
disciplined_ and closing the day-2 gaps so it stays that way under production
stress and continued change. That is a strong position to be in.
