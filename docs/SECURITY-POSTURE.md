# EMAPP — Consolidated Security Posture

**Date:** 2026-06-18
**Status:** Authoritative. Supersedes the three component audits as the single
posture-of-record (they remain the evidence appendix).
**Scope:** whole system — `apps/api` (NestJS 11 + Fastify), `apps/web` (Next.js 15),
`apps/worker`, `packages/db` (PostgreSQL 16 + RLS + pgcrypto), `packages/config`.
**Method:** consolidation of three READ-ONLY source-traced audits. No code changed.

**Source audits (evidence appendix — every `file:line` lives here):**
- `docs/SECURITY-VALIDATION-AUDIT.md` — input/DTO validation coverage + completeness
- `docs/SECURITY-UPLOAD-AUDIT.md` — untrusted-file / upload + import threat model
- `docs/SECURITY-OWASP-TOP10.md` — OWASP Top 10 (2021) scorecard

---

## 1. Executive headline

The security foundation is genuinely strong and **architectural, not checklist**.
Tenant isolation is enforced at four independent layers — `FORCE ROW LEVEL
SECURITY` on ~36 tables, the `withTenant`/`withProvider` wrappers, two build-time
ratchets that fail CI on a raw-`db` import or an un-guarded controller, and a
fail-closed default-deny authorization engine — so a cross-tenant read returns
zero rows at the database even if the application layer has a bug. PII
(`national_id`, `phone`, signature blobs) is pgcrypto-encrypted at rest with the
key set as a session GUC and never logged; sensitive documents add an AES-256-GCM
`EMAPPENC` envelope. Auth is an owned argon2id stack (OWASP params) with SHA-256
refresh hashing, rotation + reuse-detection, alg-pinned JWTs with distinct tier
audiences, and mandatory Provider MFA. The edge is hardened: strict production CSP
(nonce + strict-dynamic, no `unsafe-inline`), Helmet/HSTS, a CORS allowlist, an
SSRF host-allowlist on every server-side self-fetch, append-only audit via a DB
trigger, real fail-closed ClamAV (prod refuses to boot without a scanner host),
server-minted `randomUUID` storage keys, a hand-rolled zip-bomb preflight, and a
server-side `national_id` check-digit refine on every write path. **The one
systemic gap is structural, not a live hole:** there is **no global validation
pipe and no CI coverage guard**, so input validation is 100% present *today by
per-endpoint convention*, not *by construction*. Nothing mechanically stops the
next controller from shipping a bare `@Body()` that trusts the wire. Closing that
— a global `APP_PIPE` + an `input-validation-coverage` CI guard — is the P0 work.
The remaining blockers are operational (provision prod/staging PII keys; confirm
the ClamAV host is wired), not design defects.

---

## 2. Posture by domain

| Domain | Status | Evidence (one line) | Residual risk | Audit |
|---|---|---|---|---|
| **Access control (A01)** | **Excellent** | RLS `FORCE` on ~36 tables + `withTenant`/`withProvider` wrappers + tenant-isolation & controller-auth build ratchets + fail-closed default-deny authz engine + tier-distinct JWT audiences | Controller-auth ratchet is file-level (a method dropping its class guard, or a new `@Public()`, isn't caught); record-scope IDOR lives in services, not ratcheted — RLS is the backstop | OWASP A01 |
| **Validation / input** | **Strong (by convention)** | 100% of input-bearing endpoints validate via `ZodValidationPipe`; all body DTOs `.strict()`; NUL/invalid-UTF-8 fail-closed scan in the pipe; `national_id` check-digit refined on every write path | **No global pipe / no CI guard** → coverage is discipline, not construction; query schemas `.strip()` not `.strict()`; OTP phone refined in service not at schema boundary | Validation |
| **File upload** | **Strong** | Server-minted `randomUUID` keys (no traversal/collision); MIME allow-list excludes `text/html`+`svg`; default `attachment`; separate R2 serving origin; zip-bomb preflight (50MB cap, ZIP64 + formula reject) in worker; header-injection-safe filenames | **MIME type-spoofing on the documents path** — client MIME trusted end-to-end, no magic-byte check (🔄 in flight); doc scan runs inline in `finalize` (latency, not safety) | Upload |
| **Crypto / PII** | **Strong (code) / Adequate (ops)** | pgcrypto PII at rest (key via session GUC, never logged); AES-256-GCM `EMAPPENC` doc envelope; argon2id (m=19456,t=2,p=1); SHA-256 refresh hashing; boot-time key-shape verify (`verifyEncryptionStartup`) | **PII/DOC keys provisioned in DEV Infisical only** — staging/prod pending (go-live blocker, boot fails loud); no documented PII key-rotation runbook; `sameSite=lax` (conscious sign-off) | OWASP A02 |
| **Auth / session** | **Strong** | Owned argon2id stack; refresh rotation + reuse-detection (revokes session family + audits); per-request session-active check closes stateless-JWT revocation hole; alg-pinned HS256 + issuer/audience; Provider MFA; granular per-route throttle | No user-facing device/session list + remote revoke; throttler tracker per-IP (shared-NAT share a bucket; per-email cap mitigates) | OWASP A04/A07 |
| **Injection** | **Strong** | Drizzle parameterized by construction (only `sql.raw` sites use internal constants, not user input); Zod DTOs everywhere; zero `dangerouslySetInnerHTML`; bidi-spoof defense in `NameDisplay`; no `exec`/`spawn` with user input | File-type-spoofing (tracked under File upload above); otherwise none at code level | OWASP A03 |
| **Config / headers** | **Strong** | Strict prod CSP (nonce + strict-dynamic, no `unsafe-inline`/`eval`); Helmet + HSTS 1y preload; CORS exact-allowlist; `trustProxy=1`; `DEV_AUTH_BYPASS` prod-crash guard; generic 5xx (no stack/schema leak); pg detail scrubbed pre-Sentry | API Helmet `script-src self` has no nonce (fine for JSON API, comment it before any HTML route); `style-src unsafe-inline` (accepted, bounded) | OWASP A05 |
| **Logging / monitoring** | **Strong** | Comprehensive pino redaction (`national_id`, `phone`, tokens, reset-token referer, `/sign/<jwt>` URL censor); Sentry with PII scrub fail-closed; security events audited (reuse-detect, OTP fail, provider access, step-up); DB-trigger append-only audit | No structured `login_failed` audit event for org-tier (relies on throttler + request log); export rate-limit **fails OPEN** and only logs (conscious availability trade-off) | OWASP A08/A09 |
| **Dependencies** | **Adequate** | CI `pnpm audit --audit-level=high` fails on HIGH; pnpm overrides actively maintained; single `pnpm-lock.yaml` supply-chain pin | `--audit-level=high` → **moderate advisories pass silently**; no separate `--prod` audit; no lockfile provenance/signature | OWASP A06 |

Legend: **Excellent** = multi-layer architectural enforcement · **Strong** =
solid, residual edges only · **Adequate** = acceptable baseline with known
loosenings · **Gap** = a live hole (none rate Gap today).

---

## 3. Unified remediation plan (de-duplicated across all three audits)

Each item: **effort** (S ≤½ day · M 1–2 days · L >2 days) · **risk if skipped** ·
**gate** (owner/deploy-gated or pure-engineering).

### P0 — un-skippable correctness (do first)

| # | Item | Effort | Risk if skipped | Gate |
|---|---|---|---|---|
| P0.1 | **Global `APP_PIPE` (`GlobalZodValidationPipe`)** + `@ZodBody`/`@ZodQuery` metadata decorators + explicit `@RawBody`/`@NoValidation` opt-out markers for the 4 intentional exceptions (documents `:id/content` raw bytes; auth + provider-auth `refresh`/`logout` cookie-only). A DTO arg with no schema metadata throws fail-closed. Net runtime cost ≈ 0 (same parse, no option to skip). | M | A future endpoint silently trusts the wire; the NUL/UTF-8 guard only protects opt-in routes | Engineering |
| P0.2 | **CI guard `input-validation-coverage.spec.ts`** — static text scan of every `*.controller.ts` (no imports), asserts each `@Body`/`@Query`/`@Param` is pipe-bound or on a justified `ALLOWLIST`; fails the build otherwise. Modeled exactly on `api-docs-coverage.spec.ts`; runs in `pnpm test`. | S | P0.1 has no regression net; a route can be added before the pipe metadata is wired | Engineering |
| P0.3 | **Regression assertion** that `CreateOwnerDto.safeParse({national_id:'123456789'})` fails (invalid checksum). The refine already ships; this locks it (`owners-adversarial.spec.ts` already covers the valid case). | S | A future refactor silently drops the check-digit refine | Engineering |
| P0.4 🔄 | **Magic-byte verification on the documents upload path + `nosniff` on download.** Sniff first ~16 bytes in `scanGate`/`uploadContent` (bytes already in memory), reject when sniffed type ≠ declared MIME allow-list entry; add `X-Content-Type-Options: nosniff` to the presigned download. **IN FLIGHT** as a separate agent on `fix/document-magic-byte-verification` — do **not** duplicate; track to merge. | M | Type-confusion (renamed exe/polyglot ClamAV may not flag); contained today by AV + R2 origin separation, so not a live hole | Engineering (in flight) |

### P1 — strictness + semantic depth

| # | Item | Effort | Risk if skipped | Gate |
|---|---|---|---|---|
| P1.1 | **`.strict()` on the ~13 `List*Query` schemas** (+ `SubmitMapping` columns record). Enforce via a static guard asserting every exported `*Query`/`Create*`/`Update*` ends `.strict()`. | S | Unknown query keys silently dropped (low risk — no nested-object/proto vector on flat query strings); breaks the "every input schema is strict" invariant | Engineering |
| P1.2 | **`isValidIsraeliPhone` into `OtpRequestSchema`/`OtpVerifySchema`** at the boundary (service normalization stays — defense-in-depth). | S | OTP phone rejected only downstream in `otp.service.ts`, not at the schema gate (functionally safe today) | Engineering |
| P1.3 | **Normalize provider controllers' `ParseUUIDPipe` → the project `UuidParam` Zod pipe** for one convention (lets the P0.2 guard check a single pattern). | S | Cosmetic inconsistency; not a hole | Engineering |
| P1.4 | **Structured `audit_log` event for org-login failure / lockout** so brute-force is queryable like the OTP path (today: throttler + request-log only). | M | Brute-force is rate-limited but not a queryable security event | Engineering |
| P1.5 | **Split the dependency-audit gate** — add an informational `pnpm audit --prod --audit-level=moderate` job; consider Dependabot patch auto-merge. | S | Moderate advisories pass silently; longer exposure window | Engineering |
| P1.6 | **Tighten the auth ratchets** — method-level auth-coverage check + a diff-visible ratchet over new `@Public()` additions (current controller-auth ratchet is file-level by its own admission). | M | A method dropping its class guard or a new `@Public()` route isn't caught at build time | Engineering |

### P2 — bounds / payload shedding / residual edges

| # | Item | Effort | Risk if skipped | Gate |
|---|---|---|---|---|
| P2.1 | **Per-field `.max()` array-length caps** on list-bearing bodies (bulk ownership/assignment writes) — today only the 1MB body limit bounds them. | S | Large-array abuse within the 1MB ceiling | Engineering |
| P2.2 | **Tighter per-route `bodyLimit`** (a few KB) on OTP/login/forgot-password — sheds abuse before the 1MB JSON default. | S | Oversized small-route payloads accepted up to 1MB | Engineering |
| P2.3 | **`.max()` on the public-sign `:token` param** — reject obviously-oversized garbage before JWT verify. | S | Oversized token strings reach JWT verify (verify still rejects them) | Engineering |
| P2.4 | **Move the document AV scan inline→worker** — finalize already commits `scan_status='pending'`; enqueue a `document_scan` pg-boss job instead of inline `scanGate`. Mirrors the import pipeline. **Latency/availability, not safety** (download gate already fail-closed on `clean`). | M | Finalize blocks on R2-read + clamd round-trip; clamd slowness can 503 an upload | Engineering |
| P2.5 | **PII key-rotation runbook** for `PII_ENCRYPTION_KEY` (R2 creds already SIGHUP-reload; pgcrypto key does not). | S | No documented rotation procedure if a key is compromised | Owner (procedure) |
| P2.6 | **Single risk register** for the conscious fail-open choices (export rate-limit) + `sameSite=lax` sign-off; hash-chained audit only if regulatory tamper-proofing is later required. | S | Documented trade-offs stay tribal knowledge | Owner (sign-off) |

---

## 4. Owner / deploy checklist (pre-go-live)

These are **operational** blockers — the code is ready; the secrets and services
are not yet confirmed in staging/prod. Boot guards fail loud, so prod will not
start until the crypto items are done, but a *healthy* dependency cannot be
self-asserted by the boot guard.

- [ ] **Provision `FILE_SCAN_CLAMAV_HOST` (+ `_PORT`)** pointing at a running
  `clamd` reachable from the API, daemon `StreamMaxLength ≥ 50 MB`. ClamAV is
  **real + fail-closed** — prod **won't boot** without a host (`scan-provider.factory`
  throws). The boot guard cannot tell you the host you set is *healthy* — so:
- [ ] **EICAR deploy smoke** — upload the EICAR test string → expect a `409`
  `document_scan_rejected`. Proves the wire end-to-end. No code, no UX cost.
- [ ] **Provision PII keys in staging + prod Infisical** —
  `PII_ENCRYPTION_KEY`, `PII_HASH_KEY` (currently DEV-only). #1 crypto go-live
  blocker; `verifyEncryptionStartup()` must pass there.
- [ ] **Provision `DOC_ENCRYPTION_KEY` in staging + prod Infisical** — required
  for the sensitive-document AES-GCM envelope; boot-verified (`z.string().length(44)`).

---

## 5. What is explicitly NOT a vulnerability (do not re-litigate)

- **Magic-byte is a cheap sanity filter, NOT the security boundary.** The real
  type-confusion defense is *inert serving* (default `attachment` + MIME
  allow-list excluding `text/html`/`svg` + separate R2 origin so any polyglot
  runs in R2's sandbox, never against app cookies/DOM) **+ async ClamAV scan +
  sandboxed worker parse**. Magic-byte (P0.4) is defense-in-depth on top of an
  already-contained path — valuable and cheap, but not load-bearing.
- **Client-side validation is UX-only; the server is the gate.** Client Luhn /
  format checks improve the form experience. The authoritative rejection always
  happens server-side at `/api/v1/*` against a hand-crafted attacker request.
- **`national_id` IS server-validated.** The shared `regex(/^\d{9}$/)` in
  `packages/shared-types` is *structural shape only*; the **BE DTO**
  (`owners/owner.dto.ts`) layers `.refine(isValidIsraeliId)` (check-digit) and the
  controller binds the *refined* `CreateOwnerDto` — the import worker
  (`row-validator.ts`) does the same. A check-digit-invalid id is rejected with
  `validation_error`. The owner's instinct about the *risk* was right; the *fix
  already shipped*.
- **The `pending` scan window is intentional and safe** — downloads are gated on
  `scan_status='clean'`; a pending or infected doc cannot be downloaded.
- **The Noop (always-clean) scanner in dev/test is intentional** — prod fail-fast
  prevents it shipping.
- **Storing the cleartext filename in the DB while sanitising the wire + audit**
  is intentional (uploader UX + forensics); the key is always a server-minted UUID.
- **ZIP64 rejection in the xlsx preflight is intentional** (a 50MB xlsx never
  needs it) — not a compatibility bug.
- **`sql.raw` / template-interpolation sites are not injection** — every one
  interpolates an internal constant (cancellable-status set, internal table list)
  or binds user values as parameters; no user string reaches a query
  unparameterized.

---

## Appendix — traceability

| This doc | Drawn from |
|---|---|
| §2 Access control, Auth, Config, Logging, Injection, Dependencies | `SECURITY-OWASP-TOP10.md` (A01–A10) |
| §2 Validation/input; §3 P0.1–P0.3, P1.1–P1.3, P2.1–P2.3 | `SECURITY-VALIDATION-AUDIT.md` |
| §2 File upload; §3 P0.4, P2.4; §4 ClamAV/EICAR; §5 magic-byte / pending / filename / ZIP64 | `SECURITY-UPLOAD-AUDIT.md` |
| §3 P1.4–P1.6, P2.5–P2.6; §4 PII/DOC keys | `SECURITY-OWASP-TOP10.md` (A02, A06, A09 hardening) |

All `file:line` evidence lives in the three source audits — this document
consolidates conclusions and does not restate line references.
