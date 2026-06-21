# EMAPP — OWASP Top 10 (2021) Baseline Scorecard

**Date:** 2026-06-18
**Scope:** whole system — apps/api (NestJS+Fastify), apps/web (Next.js 15), apps/worker, packages/db (Postgres 16 + RLS + pgcrypto), packages/config.
**Method:** READ-ONLY source trace. Every defense claim cites a real file:line.
**Companion audits (referenced, not duplicated):** docs/SECURITY-VALIDATION-AUDIT.md (A03 Zod/injection depth), docs/SECURITY-UPLOAD-AUDIT.md (untrusted-file / upload pipeline depth).

---

## TL;DR for the owner

The honest answer to 'is there optimal protection for the OWASP Top 10 as a baseline?' — **Yes, the baseline is strong-to-excellent.** This is not a checklist app; access control, crypto, auth, and misconfiguration are **architecturally** enforced (RLS FORCE, an import-time tenant-isolation ratchet, a controller-auth ratchet, alg-pinned JWTs, nonce+strict-dynamic CSP, argon2id, refresh rotation+reuse-detection, append-only audit via a DB trigger). The norms are turned into **mechanisms** that fail the build.

The real gaps are at the **operational edges**, not the architecture:
1. **MIME type-spoofing on the documents path** (no magic-byte check) — the single highest-value cheap hardening (detail in the upload audit, A03 below).
2. **ClamAV host not yet confirmed wired in Infisical** — prod refuses to boot without it, but go-live readiness is unverified (upload audit).
3. **PII encryption keys not yet provisioned in staging/prod Infisical** (dev only) — a deployment-readiness gap, not a code gap (MEMORY / D.19).
4. **Export rate-limit fails OPEN** and a couple of CSRF / SameSite-Lax nuances that are defensible but worth a conscious sign-off.

Scorecard at the bottom; top-5 prioritized hardening last.

---

## A01 — Broken Access Control

**Defenses (verified):**

- **Tenant isolation is the only path to customer data.** Every read/write goes through withTenant(orgId, fn) (packages/db/src/wrappers/with-tenant.ts:29) or withProvider(providerUserId, reason, fn) (with-provider.ts:73). withTenant drops to the restricted app_user role (SET LOCAL ROLE app_user, with-tenant.ts:48) which does **not** have BYPASSRLS; withProvider uses the BYPASSRLS pool but is **audit-first** — the audit row is committed in an autonomous transaction on a separate connection BEFORE the work runs (with-provider.ts:108-153), so a crafted-failure inside fn can never suppress the audit (SA-7 closure).
- **RLS is FORCED, not just enabled.** packages/db/migrations/0004_rls_policies.sql declares ENABLE + **FORCE ROW LEVEL SECURITY** on 36 tables (:2 'even table owner respects policy'), with tenant_isolation policies keyed on app.organization_id. An IDOR fetch of another org record by id returns **zero rows** at the database layer regardless of application bugs.
- **The honor system is now a wall (ratchet #1).** apps/api/src/architecture/tenant-isolation.guard.ts scans apps/api/src/modules and FAILS the build if any new module file imports the raw db/providerDb/pool client (catches both named AND namespace imports, :65). The frozen allowlist is exactly **7 files** (tenant-isolation.guard.spec.ts:24-36), all pre-tenant-context. I verified each: portal.service.ts uses withTenant for ALL owner data and only touches session/audit infra raw; export-rate-limit.service.ts only touches cache_kv via parameterized SQL — neither reads cross-tenant data.
- **Default-deny authorization engine.** AuthorizationGuard (apps/api/src/common/authz/authorization.guard.ts:43) is **fail-closed**: a handler with neither @RequirePermission nor @TenantScoped returns 403 (:68-72); missing user/org returns 403. One RLS-scoped resolve query per request.
- **Every controller is authenticated (ratchet #2).** apps/api/src/architecture/controller-auth.guard.ts fails the build if a new controller ships without an auth guard (forgotten @UseGuards = silently public endpoint). Frozen public allowlist is the deliberate surface.
- **Tier isolation, client + server.** FE apps/web/src/middleware.ts gates /provider, /portal, dashboard on tier-specific cookies (:262-312); the **authority** is BE JWT **audience** verification — emapp-api / emapp-provider / emapp-tenant are structurally distinct (auth.guard.ts:37, provider-auth.guard.ts:30, otp.service.ts:42).
- **Record-scoped checks** (agent to assigned project, note author, self-scoped notifications) enforced in-service (authorization.guard.ts:24-29).

**Rating: STRONG.** Best-defended category. Access control is enforced at four layers (DB RLS FORCE, wrapper, build-time ratchet, request-time engine), each of which would independently block a cross-tenant read.

**Gaps:**
- The controller-auth ratchet is **file-level**: a controller with a class guard but a method that drops it, or a new @Public() method, is not caught (documented self-limit, controller-auth.guard.ts:27-39).
- Record-scope IDOR lives in services and is **not** ratcheted — relies on review + RLS as the backstop.

**Hardening (P1):** add a finer ratchet over new @Public() additions (diff-visible, CODEOWNERS-reviewed); add a method-level auth-coverage check.

---

## A02 — Cryptographic Failures

**Defenses (verified):**

- **PII encrypted at rest via pgcrypto.** national_id, phone, signature blobs are stored encrypted; decrypt happens **in-SQL** under the session GUC app.encryption_key set by the wrapper (with-tenant.ts:63, portal.service.ts:44-47 shows pgp_sym_decrypt). The key never appears in query logs — parameter-bound (with-tenant.ts:56-73).
- **Sensitive documents: EMAPPENC AES-GCM envelope** at rest (MEMORY project_doc_envelope_encryption; key DOC_ENCRYPTION_KEY).
- **Password hashing: argon2id, OWASP params** — m=19456 KiB, t=2, p=1 (apps/api/src/modules/auth/password.ts:6-10).
- **Refresh tokens SHA-256-hashed at rest**, raw value only in the httpOnly cookie (session.repository.ts:7), rotated + reuse-detected (see A07).
- **Key shape validated at boot.** PII_ENCRYPTION_KEY / PII_HASH_KEY / DOC_ENCRYPTION_KEY are z.string().length(44) (32 bytes base64, packages/db/src/env.ts:46-53); verifyEncryptionStartup() is a fail-fast boot preflight (main.ts:227).
- **Key management = Infisical only.** docs/SETUP-EXTERNAL-SERVICES.md:13; runtime injection via infisical run (apps/api/CLAUDE.md:14).
- **Cookies: httpOnly + secure + sameSite=lax** (auth.service.ts:88-89, provider-auth.controller.ts:13, otp.controller.ts:52-54).
- **TLS** at Cloudflare/Railway edge; **HSTS** preload via Helmet (main.ts:166-170, maxAge 1y + includeSubDomains + preload).

**Rating: STRONG (code) / ADEQUATE (operational readiness).**

**Gaps:**
- **PII encryption keys provisioned in DEV Infisical only** — staging/prod pending (MEMORY project_pii_keys_and_doc_bugs; D.19). Boot guard fails loud, but go-live is blocked on this.
- sameSite lax (not strict) — defensible, conscious sign-off item.
- No documented **key rotation** procedure for PII_ENCRYPTION_KEY (R2 creds have a SIGHUP reload at main.ts:245; the pgcrypto key does not).

**Hardening (P0):** provision PII/DOC keys in staging+prod Infisical and verify verifyEncryptionStartup() passes. **(P1):** document a PII key-rotation runbook.

---

## A03 — Injection

**Defenses (verified):**

- **Drizzle parameterized by construction.** I grepped all of apps/api/src + packages/db/src for raw SQL with user-input interpolation. The only sql.raw / template-interpolation sites are **not** user-controlled: imports.service.ts:844 interpolates the CANCELLABLE **constant ReadonlySet** (:103); reap-expired-rows.ts:150 uses sql.identifier over an **internal const table list** (:102-105); provider-audit.service.ts:213 uses a **tagged sql template** (affectedOrgId bound as a parameter). No user string reaches a query unparameterized.
- **Zod validation on every endpoint** via ZodValidationPipe (apps/api/src/common/pipes/zod-validation.pipe.ts:41; e.g. apartments.controller.ts:50,60,76, path UUIDs via z.string().uuid()). Full coverage: see **docs/SECURITY-VALIDATION-AUDIT.md**.
- **XSS:** zero dangerouslySetInnerHTML with user/API content in apps/web/src. **Bidi spoofing** defended: NameDisplay strips U+202E/2066/2067 AND bdi-isolates (apps/web/src/components/ui/name-display.tsx:3-39). FE CSP nonce+strict-dynamic (A05) prevents injected inline-script execution.
- **Command injection:** no exec/spawn with user input; upload filenames never touch a shell/path (server-minted randomUUID keys — upload audit threat #0); Content-Disposition header injection defended (threat #6).
- **Untrusted-file injection** (zip-bomb, formula injection, type spoofing): fully traced in **docs/SECURITY-UPLOAD-AUDIT.md**.

**Rating: STRONG (code injection) / GAPS (file-type spoofing — upload audit).**

**Gaps:** documents-path **MIME type-spoofing** — client-declared MIME trusted end-to-end with no magic-byte check (SECURITY-UPLOAD-AUDIT.md threat #3). Contained by AV scan + separate R2 serving origin, but highest-value cheap fix.

**Hardening (P1):** add magic-byte verification on the documents upload path.

---

## A04 — Insecure Design

**Defenses (verified):**

- **Anti-enumeration designed in.** Login pre-computes an argon2 dummy hash at module load and verifies against it on the unknown-user branch for constant timing (password.ts:16,34-40). OTP verify returns generic on expired/wrong/exhausted with **no oracle** (otp.service.ts:153,170-208).
- **Step-up auth** for PII unlock (step-up.service.ts); **MFA mandatory** for Provider (D.21).
- **Threat decisions documented and locked** (D.21 owned auth, D.29 tier audiences, D.37 provider audit, D.47/D.49/D.50 PII masking/export fidelity, D.12 signature encryption).
- **Privilege-confusion designed out:** distinct JWT audiences are structurally rejected cross-tier (provider-auth.service.ts:25-28).
- **TOCTOU designed out** of refresh rotation via conditional WHERE revoked_at IS NULL flip (auth.service.ts:503-513).

**Rating: STRONG.** Deliberate threat modeling; structural (not patch) mitigations.

**Gaps:** none structural. Fail-OPEN choices (export rate-limit) are conscious availability trade-offs to record.

**Hardening (P2):** record documented fail-open choices in a single risk register.

---

## A05 — Security Misconfiguration

**Defenses (verified):**

- **CSP strict in production.** FE prod script-src = self + nonce + strict-dynamic — **no unsafe-inline / unsafe-eval** on deployed traffic (apps/web/src/lib/csp.ts:48-52; per-request nonce middleware.ts:182). Plus frame-ancestors none, base-uri self, form-action self, object-src none (csp.ts:55-72). unsafe-* is dev-only and enforced-tested.
- **Helmet on the API** with CSP, HSTS preload, objectSrc none, frameAncestors none, baseUri self (main.ts:143-172).
- **CORS strict allowlist** — exact prod origin, regex-pinned preview origins, dev localhost; bounded methods + headers (main.ts:17-27,180-208).
- **trustProxy 1** closes the X-Forwarded-For spoof of the audit IP (main.ts:36-50, CC-1).
- **DEV_AUTH_BYPASS prod-impossible AND fail-fast.** Double-gated pure gate PLUS a boot guard that **crashes** if DEV_AUTH_BYPASS=1 with NODE_ENV=production (common/dev-auth-bypass.ts, called first in bootstrap, main.ts:32).
- **No stack traces / schema leak to client.** GlobalExceptionFilter returns a generic 'Internal server error' for 5xx (http-exception.filter.ts:145-156); the pg-cause debug chain is exposed ONLY when AUTH_DEBUG_ERRORS=1 AND NODE_ENV is not production (:143-144); pg detail/hint (column VALUES / PII) scrubbed before Sentry (:93, fail-closed). 404 returns generic not_found, no path echo (:120).
- **No default creds**; retired Better-Auth cookie secret removed (main.ts:137-141).

**Rating: STRONG.** Production CSP is genuinely strict (rare for Next.js App Router); dev-bypass / error-leak guards are prod-structural.

**Gaps:**
- API Helmet script-src self (main.ts:146) has no nonce — fine for a JSON API, but diverges from the FE CSP; worth a comment so a future HTML-serving route is not accidentally lax.
- CSP style-src unsafe-inline (accepted, bounded).

**Hardening (P2):** none urgent; keep FE<->API connect-src lock-step honored (csp.ts:25).

---

## A06 — Vulnerable & Outdated Components

**Defenses (verified):**

- **CI audit job** runs pnpm audit --audit-level=high (.github/workflows/ci.yml:224) — a HIGH advisory fails CI.
- **pnpm overrides actively maintained** — newest main commit is 'bump tmp override to >=0.2.7 fixes high advisory (#404)'; Dependabot grouped bumps (#397) in the log.
- **Single lockfile** (pnpm-lock.yaml) is the supply-chain pin.

**Rating: ADEQUATE.**

**Gaps:**
- Gate is --audit-level=high, so **moderate** advisories pass silently (documented at ci.yml:223).
- No separate prod-only audit (--prod); dev+prod deps share one gate.
- No lockfile provenance / signature verification.

**Hardening (P1):** add an informational pnpm audit --prod --audit-level=moderate job; consider Dependabot patch auto-merge to shrink the exposure window.

---

## A07 — Identification & Authentication Failures

**Defenses (verified):**

- **argon2id** OWASP params (password.ts:6-10).
- **Refresh rotation + reuse-detection.** Replay of a rotated token revokes the whole session family + audits (auth.service.ts:459-492, refresh_reuse_detected, flushSessionCache); rotation TOCTOU-safe via conditional flip (:503-513).
- **Stateless-JWT revocation hole closed:** AuthGuard checks isOrgSessionActive(sid) per request (auth.guard.ts:58).
- **JWT verification hardened:** algorithms HS256 pinned (rejects alg:none / RS-HS confusion), issuer + audience checked (auth.guard.ts:33-38), payload.type not access rejected (:51).
- **MFA mandatory for Provider** (D.21).
- **Rate limiting:** global 100/min (app.module.ts:44-46) + per-route login 5/600s, OTP-request 10/60s, refresh 30/60s, others 5/900s and 10/900s (auth.controller.ts:53,86,108,129,151); per-email cap below per-IP for reset (password-reset.repository.ts:24).
- **OTP hardening:** 5-min TTL, 5 attempts, rate-limited, generic responses, tenant access TTL 10 min (otp.service.ts:32-40,170-208).
- **No session fixation:** server-minted opaque sessions; httpOnly cookies.

**Rating: STRONG.** A genuinely well-built owned auth stack (D.21).

**Gaps:**
- No user-facing **device/session list + remote revoke** (reuse-detection purge-all is the safety net).
- Throttler tracker is per-IP (throttler.guard.ts:36) — shared-NAT users share a bucket; the per-email cap mitigates credential-stuffing.

**Hardening (P2):** add a user-facing active-sessions list with per-session revoke.

---

## A08 — Software & Data Integrity Failures

**Defenses (verified):**

- **Append-only audit log enforced at the DB.** BEFORE UPDATE OR DELETE trigger trg_audit_log_immutable RAISES for **all** roles incl. table owner (packages/db/migrations/0003_overjoyed_sentinels.sql:400-410), with one narrow retention-prune exception (0060_audit_log_retention_prune_exception.sql); app_user grants revoked (0009_app_user_table_grants.sql).
- **Provider audit suppression-proof** — autonomous-tx insert before work (with-provider.ts:108-153, SA-7).
- **Migration integrity guards.** assertJournalIntegrity runs as migrate preflight #0 and fails CI (packages/db/src/migrations/journal-integrity.ts) — closes the silent-skip hole (MEMORY project_migration_silent_skip_M1).
- **JWT signature + audience verified** with alg pinning (A07).
- **No insecure deserialization:** JSON only; the empty-body parser is a deliberate empty-object fallback (main.ts:93-108).
- **Supply chain:** single pnpm-lock.yaml; CI audit (A06).

**Rating: STRONG.**

**Gaps:** the audit log is tamper-**evident** (trigger) but not cryptographically **chained** (no per-row prev-hash) — a privileged DB actor who disables the trigger could rewrite history without a detectable hash break. Acceptable for the MVP threat model; note it.

**Hardening (P2):** consider a hash-chained audit if regulatory tamper-proofing is required.

---

## A09 — Logging & Monitoring Failures

**Defenses (verified):**

- **Sentry** wired (instrument.ts, main.ts:1); 5xx reported with pg PII scrubbed first, fail-closed (http-exception.filter.ts:93-100).
- **pino redaction comprehensive** (apps/api/src/logging/log-redact.ts): redacts authorization, cookie, referer/referrer (reset-token carrier, SEC M-2), password, token, **national_id, phone**, params.token, signatureSvg; /sign/<jwt> URL censor strips just the token segment (:17-48). Unit-tested.
- **Security events audited:** refresh_reuse_detected (auth.service.ts:483), failed/expired OTP with reason (otp.service.ts:182,208), provider access (every withProvider), step-up unlocks (step-up.service.ts:215). Audit log append-only (A08).
- **No console.log in prod code** (DoD; the SIGHUP console logs keys only, never values, main.ts:253).

**Rating: STRONG.**

**Gaps:**
- **Failed org-tier login** attempts are anti-enum-generic on the wire (good) but I did not find a dedicated login_failed audit_log row like the OTP path — failed password attempts rely on the throttler + pino request log rather than a structured security event.
- **Export rate-limit fails OPEN** and only logs (export-rate-limit.service.ts:90-97) — a cache_kv outage silently lifts the throttle; the composer audit row is the fallback. Conscious; flag it.

**Hardening (P1):** add a structured audit_log event for org-login failure/lockout so brute-force is queryable, not just rate-limited.

---

## A10 — Server-Side Request Forgery (SSRF)

**Defenses (verified):**

- **selfOrigin() host-allowlist on every server-side self-fetch.** Server helpers (apps/web/src/lib/server-api.ts:40-63, auth.ts:128, provider-auth.ts:137) resolve the target origin from the request Host header but **refuse** any host not in STATIC_ALLOWLIST / localhost / EMAPP_ALLOWED_ORIGINS (server-api.ts:40-52) returning null (no fetch). Blocks the Host-header-rewrite SSRF.
- **No user-URL server-side fetch in the API.** Grep for fetch in apps/api/src returns no business-logic fetch of a user-supplied URL; outbound integrations are fixed-host (Resend, R2/S3 SDK, Sentry, SMS) wired from config.
- **Parcel/GovMap provider deferred** and seam-isolated (IParcelDataProvider); no live user-URL fetch (MEMORY project_parcel_lookup_deferred_postprod). No webhook-receiver or avatar/image-from-URL fetch exists.
- **R2** reached via server-minted presigned URLs to a fixed host pattern.

**Rating: STRONG.** Classic SSRF vectors are absent or allowlisted.

**Gaps:** when the GovMap/parcel provider is wired post-prod, its outbound URL construction must be allowlist-bounded.

**Hardening (P2):** pre-commit an allowlist requirement into the IParcelDataProvider implementation note.

---

## Summary scorecard

| # | Category | Rating | One-line basis |
|---|----------|--------|----------------|
| A01 | Broken Access Control | **STRONG** | RLS FORCE + wrapper + 2 build-ratchets + fail-closed authz engine + tier audiences |
| A02 | Cryptographic Failures | **STRONG** (code) / **ADEQUATE** (ops) | pgcrypto PII, argon2id, SHA-256 refresh, AES-GCM docs, boot key-verify — but prod keys unprovisioned |
| A03 | Injection | **STRONG** (code) / **GAPS** (file type-spoof) | Drizzle parameterized, Zod DTOs, no dangerouslySetInnerHTML, bidi defense; MIME spoof gap (upload audit) |
| A04 | Insecure Design | **STRONG** | constant-time anti-enum, step-up, documented threat decisions, structural mitigations |
| A05 | Security Misconfiguration | **STRONG** | strict prod CSP (nonce+strict-dynamic), Helmet/HSTS, CORS allowlist, dev-bypass prod-crash, no error leak |
| A06 | Vulnerable & Outdated Components | **ADEQUATE** | CI pnpm audit --audit-level=high + active overrides; moderate advisories pass |
| A07 | Identification & Auth Failures | **STRONG** | argon2id, rotation+reuse-detection, immediate revocation, alg-pinned JWT, MFA, granular throttle |
| A08 | Software & Data Integrity | **STRONG** | DB-trigger append-only audit, autonomous provider audit, migration journal guard, alg-pinned JWT |
| A09 | Logging & Monitoring | **STRONG** | comprehensive pino redaction, Sentry w/ PII scrub, security events audited |
| A10 | SSRF | **STRONG** | selfOrigin() Host allowlist, no user-URL server fetch, fixed-host integrations |

**No category rates Weak.** A03 only gap is file-type-spoofing (upload audit). The two real readiness blockers (A02 prod keys, upload-audit ClamAV wiring) are **operational**, not design.

---

## Top-5 prioritized hardening (cross-category)

1. **[P0 - A02] Provision PII/DOC encryption keys in staging + prod Infisical** and confirm verifyEncryptionStartup() passes there. Keys exist in dev only; #1 go-live blocker (boot guard fails loud, so prod will not start until done). (MEMORY project_pii_keys_and_doc_bugs.)

2. **[P0 - A03/upload] Confirm the ClamAV host is wired in Infisical, then add magic-byte MIME verification on the documents upload path.** Prod refuses to boot without a scanner but the wiring is unverified; the type-spoofing gap is the highest-value cheap hardening. (docs/SECURITY-UPLOAD-AUDIT.md threats #2, #3.)

3. **[P1 - A09] Add a structured audit_log event for org-login failure / lockout.** Brute-force is rate-limited + request-logged but not a queryable security event the way OTP failures are.

4. **[P1 - A06] Split the dependency-audit gate:** add an informational pnpm audit --prod --audit-level=moderate job; consider Dependabot patch auto-merge to shrink the advisory window.

5. **[P1 - A01] Tighten the auth ratchets:** add a method-level auth-coverage check and a diff-visible ratchet over new @Public() additions (the current controller-auth ratchet is file-level by its own documented admission).

**Honorable mentions (P2):** PII key-rotation runbook (A02); user-facing active-sessions list with per-session revoke (A07); hash-chained audit if regulatory tamper-proofing is required (A08); record the documented fail-open choices in a single risk register (A04/A09).
