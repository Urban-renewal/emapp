# Manual verification — post Gate-6 merge (running report)

> Owner-authorized autonomous run, 2026-06-10. Scope: merge the 7 held Gate-6
> PRs, apply migrations to dev, restart servers, and **drive each feature in a
> real browser end-to-end** (not just "does it start" — how it ENDS, the
> security dangers along the way, and runtime/speed in ms). Plus a manager-level
> logs assessment and a sysadmin-level professionalism review.
>
> This is a RUNNING report — appended as each feature is exercised.

---

## 0. Merge + migrate + restart (DONE)

### 7 Gate-6 PRs merged to `main` (serial, each conflict resolved + CI green)

| PR   | Feature                         | Migration | Notes on the merge                                                               |
| ---- | ------------------------------- | --------- | -------------------------------------------------------------------------------- |
| #329 | Self-service org password reset | 0055      | combined auth.service constructor (password-reset deps + observability)          |
| #330 | Pluggable AV scan gate          | 0056      | registered `scanStatus` in foreign-data-enum; seeded scan_status='clean'         |
| #333 | Data-subject access + erasure   | 0057      | null-guarded national_id_hash (0057 dropped NOT NULL) in import handler          |
| #334 | PII-processing consent notice   | 0058+0059 | cause-chain assertion for drizzle-wrapped pg errors; e2e stub + optional-chain   |
| #335 | Audit-log retention             | 0060      | **trigger test was a false alarm** — see §0.1                                    |
| #338 | Per-member permission overrides | 0061      | permission.service auto-merged BOTH canAssignRole(#337) + override resolution    |
| #340 | Project renewal fields          | 0062      | classified `relocationType` in foreign-data-enum (DB CHECK + RelocationTypeEnum) |

`gh pr list --state open` → **0 Gate-6 PRs remain.**

### 0.1 — Security note: the audit-retention "recent-delete not blocked" was NOT a hole

The #335 CI failure (`audit-retention.spec.ts:267`) looked like recent audit rows
were deletable. **Verified directly it is not**: `pg_get_functiondef` confirms the
0060 carve-out trigger is the exact 3-branch contract (UPDATE→RAISE, recent
DELETE→RAISE, >24mo DELETE→RETURN OLD), and an isolated single-statement probe
showed recent deletes ARE blocked. The test failure was **transaction-abort
poisoning** — the UPDATE probe's RAISE aborted the txn, so the next probe failed
with `25P02 (transaction aborted)` instead of the immutable error, and the
`isAuditLogImmutableError` matcher returned false. Fixed by wrapping each probe in
its own SAVEPOINT. **The immutability invariant holds.**

### Migrations applied to dev (owner-authorized)

`migrate.ts` reported "applied successfully". Verified the new objects exist:
`password_reset_tokens` (0055) ✅ · erasure tables (0057) ✅ ·
`pii_processing_consents` (0059) ✅ · `member_permission_overrides` (0061) ✅ ·
`projects.relocation_type` + `developer_name` (0062) ✅.

### ⚠️ FINDING M-1 (pre-prod risk) — drizzle migrator silently skipped 0056 on dev

`documents.scan_status` (0056) was **MISSING** on dev even though `migrate.ts`
reported success and the journal lists 0056. Root cause: the drizzle migrator
applies a journal entry only if its `when` timestamp is greater than the max
already-applied `when` in the DB. On the shared dev DB, later migrations
(0057–0062) were applied during branch development with higher `when` values, so
when 0056 finally reached `main` its `when` was below the watermark and the
migrator **silently skipped it — no error**. Patched dev by running 0056's
idempotent DDL (`ADD COLUMN IF NOT EXISTS`) directly; `scan_status` +
`scan_signature` now present.

**Why this matters for production:** if migrations are ever applied out of
strict `when` order (parallel branches, cherry-picks, hotfixes), a real schema
change can be silently dropped with a green "applied successfully". **Recommend
before prod:** (a) a post-migrate assertion that every journal tag maps to a row
in `__drizzle_migrations` AND its expected schema object exists; (b) treat the
migrator's when-ordering as a hard invariant in CI (the dev DB already shows
67 recorded rows vs 63 journal entries — drift). Documented for the owner; not
self-fixed because the fix is a process/CI change, not a code bug.

### Servers restarted (clean boot)

| Server                 | Port | Result                                                                                                    |
| ---------------------- | ---- | --------------------------------------------------------------------------------------------------------- |
| `@emapp/api` (NestJS)  | 3000 | `GET /api/v1/health` → **200 in 221 ms**; startup-check (pgcrypto encryption + app_user pool role) passed |
| `@emapp/web` (Next.js) | 3001 | `/he/login` → **200 in 183 ms**; `/he` → 307 (auth gate)                                                  |

---

## 1. Feature E2E — in a real browser

### 1.1 — Login (✅ works end-to-end)

- `/he/login` renders RTL Hebrew correctly: email + password + "כניסה למערכת" +
  a **"שכחתי סיסמה"** link (the #329 password-reset entry point is present).
- Filled `qa+…@test.local` / password, submitted → `POST /api/v1/auth/login →
200`, then `GET /api/v1/me → 200` + `GET /api/v1/notifications?limit=5 → 200`,
  redirected to `/he` (dashboard "דף הבית") with nav rendered.
- ⏱️ **Runtime note (dev artifact, NOT a prod issue):** the login→dashboard
  redirect took ~18 s on the FIRST hit because Next.js dev compiles the
  `(dashboard)` route on-demand on first navigation. Subsequent navigations are
  instant. In production the route is pre-compiled — this delay does not exist.
  Flagged so it isn't mistaken for a real latency problem.

### 1.2 — Password reset (✅ request path works E2E; consumption unit-tested)

- `/he/forgot-password` renders RTL ("איפוס סיסמה" + email + "שליחת קישור איפוס").
- Logout → `POST /api/v1/auth/logout → 200`; submit email → `POST
/api/v1/auth/forgot-password → 200`.
- ✅ **Anti-enumeration (good):** the response message is "אם קיים חשבון עבור
  כתובת זו, נשלח אליו קישור..." — it does NOT reveal whether the account exists.
- ✅ **Token persisted:** verified a fresh `password_reset_tokens` row was created
  (count 1, timestamp matches the request). Backend request→persist path confirmed.
- The **consumption leg** (token → reset page → new password → login) is NOT
  browser-drivable in dev: the dev email provider is Fake and **correctly does not
  expose the raw token** (right security posture), and the token is SHA-256-hashed
  at rest (irreversible). That leg is covered by #329 unit tests.

#### ⚠️ FINDING M-2 (security, MED) — reset token leaks into logs via the `referer` header

pino redacts `cookie` / auth headers (verified: `"cookie":"[REDACTED]"` in the
request logs) **but does NOT redact `referer`**. The reset link carries the token
as a URL **query param** (`/he/reset-password?token=…`). Any request the browser
makes while on (or just after) the reset page sends that URL as `referer`, and
pino logs it verbatim — so a single-use credential lands in the server logs,
contradicting the code's stated intent (`reset-password-email.ts:42` "The token
is a credential — never logged"). Confirmed: a 64-hex reset token was present in
a logged request's `referer`. **Recommend:** (a) add `referer`/`referrer` to the
pino redact list (or strip its query string before logging); (b) have the reset
page strip the token from the URL on mount (`history.replaceState`) so it doesn't
linger in referer/history; (c) longer-term, prefer a URL fragment (`#token=`)
which is never sent to the server/referer. Single-use + TTL bound the blast
radius, hence MED not HIGH. Documented, not self-fixed (pino config + a small FE
change — wanted owner visibility on the redaction-policy choice first).

### (pending — next iterations)

- 1.3 AV-scan upload → scan verdict → download gate
- 1.4 Data-subject export + erasure
- 1.5 Consent-at-signing
- 1.6 Custom roles UI (#337)
- 1.7 Per-member overrides (#338)
- 1.8 Project renewal fields (#340)
- 1.9 Provider org-users (MFA)
- 2. Logs assessment (SaaS-grade?)
- 3. Sysadmin professionalism recommendations
