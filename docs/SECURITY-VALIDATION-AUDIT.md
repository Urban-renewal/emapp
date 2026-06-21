# Server-Side Input-Validation Coverage & Hardening Audit

**Date:** 2026-06-18
**Scope:** `apps/api/src/modules/**` (NestJS 11 + Fastify), `packages/shared-types/src/**`, `packages/validators/src/**`
**Posture:** READ-ONLY audit. No code was changed.
**Thesis (owner's framing, confirmed correct):** client validation is UX only; the server is the gate. An attacker hits `/api/v1/*` directly with hand-crafted params. This audit asks two questions for every input surface: *(1) is it validated at all?* and *(2) does that validation enforce real semantics + reject unknown keys?*

---

## TL;DR — headline findings

1. **The premise's "concrete gap" does NOT exist in the live path.** The owner-create endpoint *is* check-digit-validated server-side. The structural `regex(/^\d{9}$/)` in `packages/shared-types/src/owner.ts:103` is only the *shared* shape; the **BE DTO** (`apps/api/src/modules/owners/owner.dto.ts:24`) wraps it with `.refine(isValidIsraeliId)`, and the controller binds the *refined* `CreateOwnerDto` (`owners.controller.ts:86`), not the raw `CreateOwnerInput`. A check-digit-invalid id like `123456789` is rejected with `validation_error`. Same for the import path (worker `row-validator.ts:21,80` uses `isValidIsraeliId` + `normalizeIsraeliPhone`). **Verdict: this specific field is hardened. The owner should know his instinct was right about the *risk*, but the *fix already shipped* for national_id.**

2. **Per-endpoint coverage is actually complete today** — every controller method that takes a body/query/param validates it (table below). There are **zero truly-unvalidated input endpoints**. The two "bare `@Body()`" cases are deliberate raw-byte / cookie-only paths, not gaps.

3. **The real systemic exposure is structural, not a current hole:** validation is opt-in per route (`new ZodValidationPipe(Schema)`), there is **no global pipe** and **no CI guard**. Nothing *mechanically prevents* the next controller from shipping a bare `@Body() dto: SomeType` that silently trusts the wire. Coverage is 100% by *discipline*, not by *construction*. That is the gap to close (P0).

4. **Completeness is strong but not uniform:** all Create/Update **body** schemas are `.strict()` (mass-assignment defense holds). **Query** schemas are *not* `.strict()` (they `.strip()`), and semantic refines (`isValidIsraeliId`/`isValidIsraeliPhone`) live only in `owners/owner.dto.ts` + the worker — every *other* phone-bearing schema (OTP) relies on downstream service normalization rather than a schema-level reject.

---

## 1. Coverage map — every input endpoint

Method used: static tally of `@Body(`, `@Query(`, `@Param(` vs `ZodValidationPipe` per `*.controller.ts`, then manual inspection of every non-1:1 case. Pattern in this codebase: each controller defines `const UuidParam = new ZodValidationPipe(z.string().uuid())` and binds inline `@Body(new ZodValidationPipe(Schema))` / `@Query(new ZodValidationPipe(Schema))` / `@Param('id', UuidParam)`, or method-level `@UsePipes(new ZodValidationPipe(Schema))`.

### 1a. Verdict per controller

| Controller | Bodies validated? | Query validated? | Params validated? | Notes |
|---|---|---|---|---|
| apartments | ✅ | ✅ | ✅ UuidParam | |
| audit | n/a | ✅ | n/a | read-only |
| auth/auth | ✅ `@UsePipes` (signup/login/forgot/reset/switch-org) | n/a | n/a | `refresh`/`logout` cookie-only — **no body by design** (main.ts empty-body→`{}`) |
| auth/me, auth/provider-me, org-stats, metrics, provider-system-health | n/a | n/a | n/a | no input |
| auth/provider-auth | ✅ `@UsePipes(ProviderLoginSchema)` | n/a | n/a | refresh/logout cookie-only |
| auth/step-up | ✅ | n/a | n/a | |
| auth/tenant/otp | ✅ `@UsePipes` (request/verify) | n/a | n/a | |
| buildings | ✅ | ✅ | ✅ | |
| contractor-portal/contractor-read | n/a | n/a | ✅ | read-only share path |
| contractors | ✅ | ✅ | ✅ | |
| discovery | ✅ | ✅ | ✅ | |
| documents | ✅ (create/finalize/update) | ✅ | ✅ UuidParam | `POST :id/content` takes `@Body() body: unknown` — **raw bytes, validated by integrity gate**, see §1b |
| export | n/a | ✅ | ✅ | |
| imports | ✅ (mapping submit) | ✅ | ✅ | file rows validated in worker, §1b |
| members/accept-invite | ✅ | n/a | n/a | |
| members/member-overrides | ✅ | n/a | ✅ | |
| members | ✅ | ✅ | ✅ | |
| messaging | ✅ | ✅ | ✅ | |
| notes | ✅ | ✅ | ✅ | |
| notifications | n/a | ✅ | ✅ | |
| org/org-settings | ✅ | n/a | n/a | |
| owners | ✅ (Create/Update/Search refined DTOs) | ✅ | ✅ | national_id checksum ✅ |
| ownerships | ✅ | ✅ | ✅ | |
| parcel-setups | ✅ | ✅ | ✅ | |
| portal | ✅ | n/a | ✅ | |
| project-assignments | ✅ | ✅ | ✅ | |
| projects | ✅ | ✅ | ✅ | |
| provider/provider-audit | n/a | ✅ | n/a | |
| provider/provider-onboarding | ✅ | n/a | n/a | |
| provider/provider-tenant-detail | n/a | n/a | ✅ `ParseUUIDPipe` | Nest built-in UUID pipe (not Zod, still validated) |
| provider/provider-tenant-suspension | ✅ | n/a | ✅ `ParseUUIDPipe` | |
| provider/provider-tenant-users | n/a | ✅ | ✅ `ParseUUIDPipe` | |
| provider/provider-tenants | n/a | ✅ | n/a | |
| roles | ✅ | n/a | ✅ | |
| shares | ✅ | ✅ | ✅ | |
| signatures/public-sign | ✅ (claim body) | n/a | `@Param('token')` **unvalidated string** — verified by JWT decode downstream, §1b | public unauth link |
| signatures/signature-campaign | ✅ | n/a | ✅ | |
| signatures/signature-requests | ✅ | ✅ | ✅ | |
| tabu/tabu-extractions | ✅ | ✅ | ✅ | |
| tasks | ✅ | ✅ | ✅ | |

### 1b. The "bare input" cases — each examined, none is a real gap

| Location | Shape | Why it's safe |
|---|---|---|
| `documents.controller.ts:135` | `@Body() body: unknown` on `POST :id/content` | Raw upload bytes via the `application/octet-stream` parser (main.ts) with a dedicated 52 MB `bodyLimit`. Raw bytes are un-Zod-able by nature; validation is the **integrity gate** — `Buffer.isBuffer` + non-empty check here, then size+SHA-256 match against the create-declared values in the service. Acceptable. |
| `auth.controller.ts` `refresh`/`logout`, `provider-auth` `refresh`/`logout` | no `@Body` at all | Cookie-only POSTs. main.ts deliberately maps an empty JSON body to `{}` so these reach the handler. No attacker-supplied body is trusted. |
| `public-sign.controller.ts:31,41` | `@Param('token') token: string` (no pipe) | The signing token is an HS256 JWT in the path. It is *cryptographically* validated by JWT verify in the service. A raw `z.string()` adds nothing the verify doesn't already enforce. (Minor: a `.max()` length cap would shed obviously-oversized garbage earlier — see P2.) |
| `provider/*` params | `ParseUUIDPipe({version:'4'})` | Nest's built-in UUID pipe — validated, just not Zod. Inconsistent with the rest (which use the local `UuidParam` Zod pipe) but **not a hole**. Worth normalizing for one convention. |

**Coverage conclusion:** 100% of input-bearing endpoints validate their input *today*. The risk is that this is enforced by convention, with no backstop — see §4.

---

## 2. Completeness map — every write-path schema

Scope: `Create*`/`Update*`/`*Input`/`*Query` schemas in `packages/shared-types/src/**` plus the BE-layered DTOs in `apps/api`.

### 2a. `.strict()` (mass-assignment / over-posting / prototype-pollution defense)

Counted `.strict()` vs `.passthrough()` across all 31 schema files. **No file uses `.passthrough()` anywhere** — good. Body schemas are strict; the only non-strict write surfaces are **list-query** schemas:

| Strictness | Schemas |
|---|---|
| ✅ `.strict()` body DTOs | owner (Create/Update/Search), apartment, building, project (9), member (7), share (8), parcel-setup (6), document (5), import (5), signature-request (5), role (4), conversation (4), contractor (2), discovery-record (2), note (2), ownership (2), org-settings (7), data-subject (2), provider (3), portal (2), capability-presets (2), task (3), project-assignment (1), auth (1) |
| ⚠️ **NOT strict** (`.strip()` default) | `ListApartmentsQuery`, `ListAuditQuery`, `ListBuildingsQuery`, `ListContractorsQuery`, `ListMembersQuery`, `ListNotesQuery`, `ListNotificationsQuery`, `ListOwnersQuery`, `ListOwnershipsQuery`, `ListProjectAssignmentsQuery`, `ListProjectsQuery`, `ListTenantsQuerySchema`, `ListTenantUsersQuerySchema`, `SubmitMapping` columns record |

**Risk read:** the unknown-key risk on query schemas is *low* (query strings can't carry nested objects → no prototype-pollution vector; `__proto__` as a flat query key is inert), but unknown keys are *silently dropped* rather than rejected. For defense-in-depth + a uniform "every input schema is strict" invariant (which a CI guard can enforce), these should be `.strict()`. This is **P1**, not P0.

### 2b. Semantic validation (type/shape is not enough)

| Field class | Where validated | Verdict |
|---|---|---|
| **national_id (check-digit)** | `owners/owner.dto.ts:18,24` (`isValidIsraeliId` refine on Create/Update/Search); worker `row-validator.ts:21,80` for imports | ✅ **Hardened on every write path.** The shared `regex(/^\d{9}$/)` at `owner.ts:103` is structural only — the semantic refine is layered in the BE DTO the controller actually binds. |
| **phone (Israeli format)** | `owner.dto.ts:19` (`isValidIsraeliPhone` refine); worker `row-validator.ts` (`normalizeIsraeliPhone`); `owners.service.ts:521,549` normalizes to E.164 | ✅ for owners/imports. ⚠️ **OTP** (`auth.schemas.ts:79,86` `OtpRequestSchema`/`OtpVerifySchema`) validates phone only as `z.string().min(9).max(20)` — the *semantic* Israeli check happens in `otp.service.ts` via `normalizeIsraeliPhone` (invalid → anti-enumeration no-op). Functionally safe, but the **schema** does not reject; defense-in-depth would add the refine at the boundary too. |
| **email** | `member.ts:90,109`, `contractor.ts:12,25` (`z.string().email()`); `owner.ts:104` | ✅ |
| **enums vs free strings** | `ProjectStatusEnum` (D.18, `project.ts:124`), `ProjectTypeEnum`, `RelocationTypeEnum`, `ImportStatusEnum`, role/capability enums, `CanonicalFieldsEnum` | ✅ enums used consistently; no free-string status fields found |
| **UUID params** | local `UuidParam = new ZodValidationPipe(z.string().uuid())` per controller, or `ParseUUIDPipe` (provider) | ✅ |
| **bounded lengths** | names `.min(1).max(100)`, notes `.max(2000)`, templateName `.max(120)`, etc. | ✅ broadly applied on strings |
| **bounded numbers / pagination** | `limit: z.coerce.number().int().min(1).max(100)`, mapping column index `.int().min(0).max(1023)` | ✅ |
| **ownership_pct** | `ownership.ts` — server **never trusts** caller pct; derives num/den, refines pct>0 | ✅ strong |
| **NUL / invalid-UTF-8** | `zod-validation.pipe.ts:9-48` `stringIsUnstorable` fail-closed scan on every parse | ✅ single choke-point, defense-in-depth |
| **array max-length** | — | ⚠️ **No global cap on array fields.** Bounded by the 1 MB body limit but not per-field. P2. |

**Completeness conclusion:** semantic depth is genuinely good. The two gaps worth closing: (1) the OTP phone schema doesn't reject at the boundary (relies on service), (2) query schemas aren't strict.

---

## 3. Defense-in-depth inventory

| Layer | Status | Evidence | Gap |
|---|---|---|---|
| **Body size limit (JSON)** | ✅ Fastify default **1 MB** for all JSON routes | main.ts comment at line ~113: "every JSON route keeps Fastify's default 1MB ceiling" | No *per-route* tighter limit (e.g. an OTP request need not accept 1 MB). Minor. |
| **Body size limit (upload)** | ✅ Dedicated **52 MB** (`CONTENT_UPLOAD_BODY_LIMIT_BYTES = 52_428_800`) scoped to `application/octet-stream` only | main.ts:118; `documents.controller.ts` `CONTENT_UPLOAD_BODY_LIMIT_BYTES` | Correctly scoped — does not widen the JSON ceiling. |
| **Rate limit / throttler** | ✅ Global `APP_GUARD` = `ConfigurableThrottlerGuard`, 100 req/60 s, **per-user when authed, per-IP/per-owner fallback**, prod fail-closed | `app.module.ts:44,135`; `common/guards/throttler.guard.ts:20-60` | Single global bucket; sensitive routes (login/OTP) have tighter `@Throttle` overrides already. Adequate. |
| **Helmet** | ✅ CSP (`default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`), HSTS 1y preload | main.ts:143-175 | Solid. |
| **CORS** | ✅ Allowlist by env, regex preview, credentialed, explicit header allowlist | main.ts | Solid. |
| **maxParamLength** | ✅ 1500 (for path-JWT signing links) | main.ts FastifyAdapter | OK |
| **trustProxy** | ✅ `1` (single hop — anti-IP-spoof) | main.ts | OK |
| **Invalid-JSON handling** | ✅ Custom parser → stable `invalid_json` 400, never a framework 500 | main.ts:90-108 | OK |
| **NUL/UTF-8 guard** | ✅ In the pipe, fail-closed | `zod-validation.pipe.ts` | OK — but only runs on routes that *use the pipe* (another argument for a global pipe). |
| **withTenant / RLS backstop** | ✅ Every DB read scoped (CLAUDE.md hard rule) — even if validation slipped, data is org-scoped | project-wide | This is the real safety net: a validation bypass leaks *shape* errors, not cross-tenant data. |

**Defense-in-depth conclusion:** the boundary is well-defended. The notable gaps are (a) no per-route body limits and (b) **the NUL/UTF-8 guard and Zod parse only protect routes that opt into the pipe** — fixed by a global pipe.

---

## 4. Recommended mechanism — un-skippable, zero-runtime-cost

The current state is "100% coverage by discipline." Convert it to "100% coverage by construction" with four pieces:

### (a) Global Zod validation pipe (`APP_PIPE`) — makes unvalidated impossible

A NestJS global pipe runs on **every** handler argument. Wire `ZodValidationPipe` (already written, already does the NUL/UTF-8 guard) so that:

- Controllers attach the schema via metadata (a small `@ZodBody(Schema)` / `@ZodQuery(Schema)` decorator) instead of `new ZodValidationPipe(Schema)` inline; the global `APP_PIPE` reads the metadata and parses.
- A handler argument that is typed as a DTO **but has no schema metadata** → the pipe **throws at startup/first-hit** (fail-closed), so a forgotten schema is a loud error, not a silent passthrough.
- Raw-byte and cookie-only exceptions (documents `:id/content`, auth refresh/logout) are explicitly opted out via a `@RawBody()` / `@NoValidation()` marker — making the exception *auditable* instead of invisible.

Register in `app.module.ts` providers: `{ provide: APP_PIPE, useClass: GlobalZodValidationPipe }`. This is the single highest-leverage change: after it lands, *no future endpoint can ship unvalidated* without an explicit, greppable opt-out marker.

### (b) CI/lint guard — fails the build on any unvalidated input

Model it exactly on the existing `apps/api/src/architecture/api-docs-coverage.spec.ts` (static scan of every `*.controller.ts`, allowlist `Set`, vitest, reads files as text — **does not import** controllers). New spec `apps/api/src/architecture/input-validation-coverage.spec.ts`:

1. Statically scan every `*.controller.ts`.
2. For each `@Body(`/`@Query(`/`@Param(` occurrence, assert it is one of: bound to a `ZodValidationPipe`/`UuidParam`/`ParseUUIDPipe`, OR the method carries `@UsePipes(new ZodValidationPipe(...))`, OR the argument is on an `ALLOWLIST` (documents `:id/content` raw body; public-sign `:token`; cookie-only auth routes — each with a one-line justification, same style as the api-docs `ALLOWLIST`).
3. **Fail** if any input decorator is unaccounted for.

This is the regression net that makes (a) durable and catches the case where someone adds a route before the global pipe metadata is wired. Runs in `pnpm test`, mirroring the `app-forms-no-get-fallback` precedent (CLAUDE.md FE DoD).

### (c) shared-types convention — `.strict()` + semantic validators, enforced

Add a second guard (or extend (b)) that statically asserts every exported `Create*`/`Update*`/`*Input` schema in `packages/shared-types/src/**` ends in `.strict()`. Plus a one-line convention in the shared-types README: *body DTOs are `.strict()`; any field that is a national_id/phone/email gets the semantic validator layered in the BE DTO (the `owner.dto.ts` pattern is canonical).* Backfill the OTP schema's phone with `isValidIsraeliPhone` at the boundary (defense-in-depth).

### (d) Why the runtime cost is negligible (the owner's "no runtime cost" requirement)

- Zod `safeParse` on a flat ≤4-level body is **single-digit microseconds** — orders of magnitude below the request's DB round-trip (which the perf memory shows dominates).
- The global pipe runs the *same* parse the inline pipes already run today — it **adds no work**, it just removes the *option to skip* it. Net runtime delta ≈ 0.
- **Reject-early** compounds the win: the 1 MB `bodyLimit` discards oversized payloads before Zod ever sees them, and the NUL/UTF-8 scan short-circuits on the first bad codepoint.
- `.strict()` is *cheaper* than `.strip()` in the reject case (it stops at the first unknown key instead of building a stripped copy).

Net: this is a pure-safety change with no measurable latency cost.

---

## 5. Prioritized hardening plan

### P0 — un-skippable mechanism + close any genuine hole (do first)
- **P0.1** Global `APP_PIPE` (`GlobalZodValidationPipe`) + `@ZodBody`/`@ZodQuery` decorators + explicit `@RawBody`/`@NoValidation` opt-out for the documents-content and cookie-only routes. *(§4a)*
- **P0.2** CI guard `input-validation-coverage.spec.ts` (static scan, allowlist, fails build) modeled on `api-docs-coverage.spec.ts`. *(§4b)*
- **P0.3** national_id server-side check: **already shipped** (`owner.dto.ts` + worker `row-validator.ts`). Action = add a regression assertion that `CreateOwnerDto.safeParse({national_id:'123456789'})` fails (the adversarial spec at `owners-adversarial.spec.ts:298` already exercises a *valid* id — add the invalid-checksum case to lock it).
- **P0.4** Truly-unvalidated endpoints: **none found.** No action beyond the allowlist entries in P0.2 that document the 4 intentional exceptions.

### P1 — strictness + semantic depth everywhere
- **P1.1** Add `.strict()` to all 13 `List*Query` schemas + `SubmitMapping`'s columns record (§2a). Enforce via the (c) guard.
- **P1.2** Layer `isValidIsraeliPhone` into `OtpRequestSchema`/`OtpVerifySchema` at the boundary (defense-in-depth; service normalization stays). *(§2b)*
- **P1.3** Normalize provider controllers' `ParseUUIDPipe` to the project's `UuidParam` Zod pipe for one convention (cosmetic-but-consistent; lets the guard check one pattern).
- **P1.4** shared-types README convention note + the strict-enforcement guard from §4c.

### P2 — bounds / array-limits / payload shedding
- **P2.1** Add `.max()` per-route array-length caps on any list-bearing body (e.g. bulk ownership/assignment writes) — today only the 1 MB body limit bounds them.
- **P2.2** Tighter per-route `bodyLimit` on small-payload routes (OTP, login, forgot-password) — a few KB instead of the 1 MB default, shedding abuse earlier.
- **P2.3** Add a `.max(2000)` (or similar) to the public-sign `:token` param so obviously-oversized garbage is rejected before JWT verify.

---

## Appendix — key file references

- Pipe: `apps/api/src/common/pipes/zod-validation.pipe.ts` (NUL/UTF-8 guard + `safeParse` → `validation_error`)
- Bootstrap (no global pipe; body parsers; helmet; cors): `apps/api/src/main.ts`
- Throttler global guard: `apps/api/src/app.module.ts:44,135`, `apps/api/src/common/guards/throttler.guard.ts`
- national_id semantic refine (the live fix): `apps/api/src/modules/owners/owner.dto.ts:18-30`, bound at `owners.controller.ts:86`
- Import row semantics: `apps/worker/src/validation/row-validator.ts:21,80`
- Semantic validators: `packages/validators/src/israeli-id.ts`, `packages/validators/src/israeli-phone.ts`
- Existing CI-guard precedent to copy: `apps/api/src/architecture/api-docs-coverage.spec.ts`, `apps/web/src/app-forms-no-get-fallback.spec.ts`
- Owner shared schema (structural-only `regex`, by design): `packages/shared-types/src/owner.ts:103`
