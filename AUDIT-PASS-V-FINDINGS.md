# Audit-pass V — comprehensive code review (COMPLETE)

**Started:** 2026-05-20 (post audit-pass IV merge-ready)
**Completed:** 2026-05-20
**Branch:** `phase-4` (PR #14)
**Method:** Doc-grounded, slice-by-slice. Every finding cites file:line + doc:section. No invented opinions.
**Status:** ✅ complete. **Verdict: ZERO new actionable findings on the deficiency axis.** All HIGH/MEDIUM gaps spec mandates were already closed in audit passes I–IV (F1, F2, B1, A1, A2, A3, G1a, G1b, G2). Remaining items are all either GOVERNED (recorded in DECISIONS D.21–D.32) or NOTE-only (no code action).

## Close-out — governed-deferral reassessment (2026-05-20, user-directed)

After the deficiency-axis sweep returned NONE, the user asked to re-examine the 14 governed deferrals — were they truly governed-correct, or was there room for improvement? Honest reassessment surfaced six items that warranted action. All six landed in isolated commits with full local verification AND CI SHA-mapped green before the next. Consolidating record at **D.32**.

| #   | Commit    | What                                                                               | Closes                     |
| --- | --------- | ---------------------------------------------------------------------------------- | -------------------------- |
| 1   | `fd0bf2a` | throttler per-user `getTracker()` override                                         | D.31 (b)                   |
| 2   | `71d119e` | documents.list EXISTS subquery for agent                                           | D.28 R5                    |
| 3   | `6afb703` | `AUTH_DEBUG_ERRORS` prod-fail-closed gate                                          | D.30 follow-up             |
| 4   | `e3bcdd6` | `IStorageProvider.head()` interface prep + 2-layer finalize                        | D.28 R1/R2 (iface)         |
| 5   | `6467ba8` | D.31 (f) password-reset → HIGH-priority pre-Gate-5 obligation                      | D.31 (f) re-class          |
| 6   | `6840bec` | Tenant-RLS design spike (Option B) — **re-scoped same day: post-Phase-5, NOT pre** | D.31 (e) future-phase prep |

**Outcome:** PR #14 (phase-4) MERGEABLE/CLEAN, all 8 CI checks SUCCESS. Phase-4 is sealed; awaiting user merge per the AUTOPILOT end-of-phase gate.

**Correction (same day, recorded so the chain holds):** improvement #6 was originally framed as a "pre-Phase-5 obligation". When the user asked for "the full picture before deciding" on Phase 5 work, re-reading docs/03 §9 surfaced that Phase 5 is the public-link JWT signing flow (no Tenant authentication), so Tenant-RLS infrastructure is NOT a Phase 5 blocker. The spike remains valid as future-phase prep but is NOT on the Phase 5 critical path. Lesson recorded inside D.32 #6.

## Top-line summary

| Slice | Module(s)                  | Result                                      |
| ----- | -------------------------- | ------------------------------------------- |
| S1    | shared-types + validators  | NONE                                        |
| S2    | packages/db                | NONE significant                            |
| S3    | apps/api/common            | NONE                                        |
| S4    | auth (security-critical)   | NONE new (governed debts only)              |
| S5    | domain batch 1 (7 modules) | NONE                                        |
| S6    | domain batch 2 (7 modules) | NONE                                        |
| S7    | cross-cutting              | NONE actionable (3 NOTE-level observations) |

**Pattern uniformity verified across all 14 domain services**: withTenant + requireManager + AuditService + Zod-strict — same shape everywhere. **Zero** `: any`, `console.*`, `TODO`, `FIXME`, `XXX` in the entire `apps/api/src` + `packages/{db,shared-types,validators}` outside `.spec.ts`.

## Conclusion

The codebase is in a healthy, audit-clean state for MVP scale. No fix-approval requested in this pass. Future-relevant items remain captured in **D.21–D.31** + **OPEN_ITEMS §5b** + the **D.31 follow-up list** (CHECK 'tenant', per-user throttle, Manager TTL, Tenant refresh, Tenant data RLS, password reset, /api/v1/docs runtime endpoint). All are pre-Gate-5 governed.

**Parallel-agent coordination note**: while this audit is active, other
agents should avoid simultaneous edits in `apps/api/src/modules/auth`,
`apps/api/src/common`, and `packages/db/src/wrappers`. Domain modules
are safe to touch in isolation. Tracker updates land here as each
slice completes.

## Findings legend

- **HIGH** — spec-mandated, real security/correctness gap.
- **MEDIUM** — spec-mandated but limited blast radius / governed-able.
- **LOW** — minor inconsistency / doc-drift / hygiene.
- **NOTE** — informational; not actionable on its own.
- **GOVERNED** — recorded earlier (D.21–D.31, F1–F2, G1a/G1b/G2/G3); no new action.

## Slice results

(populated as each slice completes — newest at top)

### S7 — cross-cutting (rate-limit / audit completeness / error catalog / runtime)

**Result: NONE actionable.** Per-route throttles cover 8 high-value endpoints (auth signup 5/10min, login 10/min, provider login 5/10min, provider refresh 20/min, OTP request 5/15min, OTP verify 10/15min, documents POST 30/min, documents GET :id/download 30/min). Audit-action inventory: 30+ distinct actions covering ALL spec-mandated authentication events (login/logout/login_failed/otp_requested/tenant_login/tenant_login_failed/first_manager_created/org_switched) PLUS every domain mutation. Error-code catalog: 30+ distinct stable codes, all conforming to D.16 envelope. **NOTE (not actionable)**: three more endpoints could benefit from a tighter per-route throttle in the future — `/owners/search` (HMAC PII lookup), `/members` (POST invite — email spam vector), `/auth/accept-invite` (token-guess) — currently all sit under the global 100/min/IP which is acceptable for MVP. Already-recorded D.31 residual: per-IP throttle vs per-user (ISO upgrade at enterprise scale).

### S6 — domain batch 2 (tasks/notifications/notes/audit/project-assignments/members/documents)

**Result: NONE.** 7 modules, zero anti-patterns. Coverage: tasks 8wT/6aud · notifications 3wT/0aud (self-scoped via RLS; mark-read intentionally not audited per docs/07 §12.3 "routine reads/UI not audited") · notes 5wT/4aud · project-assignments 3wT/3aud · members 3wT/3aud · documents 8wT/7aud (most comprehensive — every state change). audit-read 1wT (manager-only, projects only safe fields per §12 — no diff/ip/UA leak). All match spec.

### S5 — domain batch 1 (projects/buildings/apartments/owners/ownerships/contractors/shares)

**Result: NONE.** 7 modules, **zero** anti-patterns (any/console/TODO). Every service uses `withTenant(user.orgId, ..., {userId: user.sub})`, `requireManager` defense-in-depth for writes (matches D.17 + the central AuthorizationGuard), and writes `audit_log` rows for every mutation. Counts: projects/buildings/apartments/contractors/shares = 5 withTenant + 4 requireManager + 4 audit (matches list/get/create/update/archive shape); owners = 6 (extra search); ownerships = 3 (list/get/PUT atomic set-replace, D.25). Pattern uniform across all 7 — exactly what enterprise code review wants.

### S4 — apps/api/src/modules/auth (security-critical)

**Result: NONE new.** 20 files. Cookies: `httpOnly+secure(prod)+SameSite=Lax`, refresh scoped to `/api/v1/auth/refresh`. Password: argon2id OWASP params, dummy-hash pre-computed at module load for constant-time anti-enum. Provider MFA: TOTP RFC6238 (period 30, window=1) + recovery codes (consumed on use). Session-validity in-process memo + DB-truth + flush on logout/revoke. Anti-enumeration: generic `invalid_credentials` for unknown/locked/wrong (commented choice). All audit writes verified (G1a/G1b/F1). **GOVERNED (recorded earlier, deferred deliberately)**: `session.repository.ts` uses `db: any` typing — PROGRESS records this as part of the broader AuthService SRP refactor (~576 lines) scheduled as its own gated workstream because doing it immediately on freshly-CI-green auth is high blast radius for marginal gain.

### S3 — apps/api/src/common (guards/filters/pipes/interceptors)

**Result: NONE significant.** 8 files. AuthorizationGuard fail-closed (D.26). ZodValidationPipe has NUL + unpaired-surrogate guard + fail-closed at depth>8 BEFORE the DB sees input (so SQLSTATE 22021 never surfaces as 500). KeysetCursor opaque base64url JSON, safe decode (`null` on tamper) — caller surfaces 400 `invalid_cursor`. IdempotencyInterceptor UUID-validated, cross-org-isolated key, atomic claim. HTTP exception filter honours carried 4xx + AUTH_DEBUG_ERRORS opt-in for pg cause chain. ConfigurableThrottlerGuard prod-fail-closed (F1 audit-pass III). No anti-patterns. **GOVERNED**: AUTH_DEBUG_ERRORS env-only gate is deliberate (allows staging debug without exposing prod) — recorded in code comment.

### S2 — packages/db

**Result: NONE significant.** 21 migrations + clean wrappers (withTenant/withProvider/withBootstrap) + 6 provider interfaces (email/sms/storage/cache/realtime/encryption) + AuditService with typed ActorType ('user'|'system'|'provider') matching the DB CHECK. Zero `any`/console./TODO/FIXME in `packages/db/src/`. PII encryption helpers use parameterised pgp_sym_encrypt/decrypt. **NOTE (style, not defect)**: OTP/login audit writes in `apps/api` use direct `db.insert(auditLog)` rather than the AuditService — works correctly (BYPASSRLS pool, explicit org_id) but inconsistent with the AuditService pattern used by domain services. Could be unified in a follow-up; not blocking.

### S1 — packages/shared-types + packages/validators

**Result: NONE.** 17 entity schemas + 6 auth schemas + envelope.ts (D.16 ApiData/ApiList/ApiError). `.strict()` coverage matches Create/Update Input pattern (42 strict calls for 21 inputs). Only `as any` uses are in `.spec.ts` negative-input tests. Zero TODOs. Validators (`isValidIsraeliId`, `isValidIsraeliPhone`, `normalizeIsraeliPhone`) — minimal + focused.

---
