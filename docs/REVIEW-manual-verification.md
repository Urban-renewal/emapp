# Manual verification — post Gate-6 merge (running report)

> Owner-authorized autonomous run, 2026-06-10. Scope: merge the 7 held Gate-6
> PRs, apply migrations to dev, restart servers, and **drive each feature in a
> real browser end-to-end** (not just "does it start" — how it ENDS, the
> security dangers along the way, and runtime/speed in ms). Plus a manager-level
> logs assessment and a sysadmin-level professionalism review.
>
> This is a RUNNING report — appended as each feature is exercised.

---

## Executive summary

All **7 held Gate-6 PRs are merged** to `main` (migrations 0055–0062), applied to
the dev DB, both servers boot clean, and the new features were **driven in a real
browser end-to-end** (not just "does it start"). No feature is broken.

**Per-feature result:**

| #   | Feature                | Result                                                           |
| --- | ---------------------- | ---------------------------------------------------------------- |
| 1.1 | Login                  | ✅ end-to-end                                                    |
| 1.2 | Password reset         | ✅ request path E2E + anti-enumeration (consumption unit-tested) |
| 1.3 | AV-scan download gate  | ✅ **infected → 409**, the gate genuinely blocks                 |
| 1.4 | DSAR export            | ✅ returns full record **and is audited**                        |
| 1.5 | Consent-at-signing     | ✅ design + security verified (atomic, hash-bound)               |
| 1.6 | Custom roles           | ✅ create + **422 fail-closed** on unknown permission            |
| 1.7 | Per-member overrides   | ✅ grant/deny + **self-lockout blocked**                         |
| 1.8 | Project renewal fields | ✅ render + full round-trip + soft-delete                        |
| 1.9 | Provider / MFA         | ⏸️ deferred (separate provider login)                            |

**Security findings (2) — documented, NOT self-fixed (owner/policy calls):**

| ID      | Sev      | What                                                                                                                                            |
| ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **M-1** | pre-prod | drizzle migrator **silently skipped 0056** on dev (when-ordering) — "applied successfully" was false; patched dev, needs a CI guard before prod |
| **M-2** | MED      | reset token leaks into pino logs via the **unredacted `referer`** header (cookie IS redacted; referer isn't)                                    |

**Logs:** SaaS-grade — structured JSON, `req.id` correlation, `responseTime`, no
national_id/phone/password in bodies, cookie redacted. Only gap = M-2.

**Plus 7 sysadmin/professionalism recommendations** (§3) — custom RTL error pages,
readiness probe, active-sessions UI, etc. — none blocking.

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

### 1.3 — AV-scan download gate (✅ the security gate genuinely blocks)

The owner asked specifically about "the security dangers along the way." This is
the one that matters most for documents, and **it holds**. Verified by driving the
real download endpoint against a document whose `scan_status` I flipped in dev:

| `documents.scan_status` | `GET /api/v1/documents/:id/download` | Body                                                                                   |
| ----------------------- | ------------------------------------ | -------------------------------------------------------------------------------------- |
| `clean`                 | **200**                              | `{ data: { url: "https://emapp-dev…r2.cloudflarestorage.com/…" } }` (presigned R2 URL) |
| `infected`              | **409**                              | `{ error: { code: "document_scan_rejected" } }`                                        |

- ✅ A non-clean document is **download-gated** — the presigned URL is never
  issued; the gate returns 409 with the D.16 error envelope and a descriptive,
  PII-free code. Restored the row to `clean` after the test (download → 200 again).
- Note: `scan_status` is (correctly) NOT exposed on the documents LIST wire
  payload — it's an internal gate concern, surfaced only through the download
  decision. The dev scanner is Noop (stamps `clean`), so the _verdict-production_
  path can't yield `infected` in dev; the _enforcement_ path is what I proved here
  by setting the column directly, which is the security-critical half.

### 1.4 — Data-subject export + erasure (✅ export works AND is audited)

- `GET /api/v1/owners/:id/data-export` → **200** (~ payload: `exportedAt`,
  `owner`, `ownerships`, `signatures` — the full data-subject record).
- The export returns the national ID **in cleartext** (`"nationalId":"123456782"`).
  This is **correct for a DSAR** (a subject-access request must return the real
  personal data, not a masked copy) — and crucially it is **audited**: a
  `owner.data_exported` row is written to `audit_log` for every export (verified
  the rows' timestamps match my two export calls exactly). The masked form
  (`•••••••82`) is what the normal list/detail views show; the DSAR export is the
  one deliberate, audited cleartext path. ✅ Good posture.
- **Audit coverage looks SaaS-grade so far:** `owner.data_exported` AND
  `document.download` both write audit rows (actor_type=`user`, target_table set).
- **Erasure NOT executed** by design — it is an irreversible tombstone and the
  only QA owner on dev would be destroyed, breaking other test data. The erasure
  tombstone behavior (name/national_id replaced, signature blob tombstoned) is
  covered by #333 unit tests. Endpoint presence confirmed; destructive path left
  to the unit suite intentionally.

### 1.6 — Custom roles (#337) (✅ create works, fail-closed on unknown permission)

Driven against `POST /api/v1/roles` (the DTO is `{name, description?, permissions[]}`,
`.strict()` — no client-supplied `key`):

| Input                                                   | Result                                                                                       |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `{name, permissions:['owners.read','apartments.read']}` | **201** — `isSystem:false` (org-custom), permissions persisted                               |
| `{name, permissions:['this.is.not.a.real.permission']}` | **422 `unknown_permission`** (fail-closed — a typo'd / future permission is never persisted) |

- ✅ Org-custom role created as non-system, then `DELETE /roles/:id` → **204**,
  list back to the 6 seeded system roles (admin/agent/external_read/manager/owner/
  viewer). Test artifact cleaned up.
- **Anti-escalation** (a grantor cannot grant a permission they don't hold;
  Owner-tier permissions are Owner-only) is enforced in the service (verified in
  source: `member-overrides.service.ts` throws `ESCALATION` / `OWNER_ONLY`) and
  covered by #337 unit tests. Couldn't trigger the subset-rejection live because
  the QA "manager" account holds a near-Owner set (66 permissions incl.
  `roles.manage`, `org.transfer_ownership`) — see the note under §3.

### 1.7 — Per-member overrides (#338) (✅ grant/deny works; self-lockout blocked)

Route is `PUT /api/v1/members/:userId/overrides` (NOT POST — a POST returns 404;
worth knowing for the FE contract). Driven against an **agent** member:

| Action                                                | Result                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `PUT {permission:'contractors.read', effect:'grant'}` | **200** effect=grant                                           |
| `PUT {permission:'owners.reveal_pii', effect:'deny'}` | **200** effect=deny                                            |
| `GET …/overrides`                                     | lists both: `contractors.read:grant`, `owners.reveal_pii:deny` |
| `PUT` an override on **my own** userId                | **400 `cannot_modify_self`** ✅                                |

- ✅ **Self-lockout guard (security):** you cannot override your own permissions —
  prevents an admin from accidentally (or an attacker from deliberately) denying
  their own governance and bricking the account.
- ✅ The engine resolves `(role ∪ grant) − deny` with DENY winning (source:
  `permission.service.ts` §4; #338 unit tests). Both test overrides cleared via
  `DELETE` (204 ×2, 0 remaining) — agent restored.

### 1.8 — Project renewal fields (#340) (✅ render + full round-trip + soft-delete)

- `/he/projects/new` renders all 0062 fields in a dedicated, well-labelled
  fieldset **"פרטי התחדשות (אופציונלי)"** with contextual help text:
  יזם/קבלן (`developerName`), ח.פ. היזם (`developerCompanyId`), יח״ד קיימות/
  מתוכננות (`existingUnits`/`plannedUnits`), תוספת שטח (`extraAreaSqm`), הסדר
  פינוי (`relocationType` select, default "לא צוין"), הערות פינוי
  (`relocationNotes`), גוש/חלקה/תת-חלקה (`block`/`parcel`/`subparcel`). Polished,
  professional, all optional. ✅
- **Full round-trip:** `POST /api/v1/projects` with all renewal fields → **201**;
  `GET /api/v1/projects/:id` → every field persisted exactly (incl. a Hebrew
  developer name with an embedded quote, `relocationType:'rent_comp'`, block/parcel/
  subparcel). ✅
- ✅ **Incidental positive:** `DELETE /api/v1/projects/:id` → **204** but the row
  is **soft-deleted** (`archivedAt` set, record still readable) — confirms the
  CLAUDE.md hard rule "soft delete = `archivedAt`, NOT `deletedAt`" / "ארכוב". The
  test project was archived (not destroyed) as cleanup.

### 1.5 — Consent-at-signing (✅ design + security verified; sign not executed)

The public signing token is a **JWT** (HS256, a dedicated `SIGNATURE_TOKEN_SECRET`,
separate from `JWT_SECRET`) — stateless, delivered to the resident by SMS, never
stored in the DB and never exposed in the management API (verified: the
`signature-requests` list does NOT surface the token). So a valid sign page can't
be loaded without minting a token, and **signing is irreversible** — I did not
execute a sign. Verified instead:

- ✅ **Anti-enumeration routing:** a malformed token → `/sign/bogus…` returns
  **307 → /he/login** (the middleware has an explicit `/sign/:path*` matcher and
  redirects malformed tokens to login rather than attempting a page render).
  Correct, intentional posture.
- ✅ **Consent notice is surfaced:** the preview returns
  `consentNotice: { text, version, requireExplicitConsent }`
  (`public-sign.service.ts`).
- ✅ **Atomic explicit-consent gate:** when `requireExplicitConsent` is on, the
  sign path throws **400 `consent_required`** unless `acknowledgeConsent === true`,
  and the status-flip + inserts are one transaction — "a consent-less sign leaves
  NO state" (rolls back). You cannot sign without recording consent.
- ✅ **Immutable, hash-bound recording:** on sign it inserts a
  `pii_processing_consents` row with `noticeHash = sha256(noticeText)` + the notice
  `version` + org/owner — so the EXACT notice the resident saw is provable forever.
  The table is append-only + tenant-isolated (#334 unit tests C1–C4).
- The visual render of the consent checkbox is gated behind a valid JWT (by
  design); the mechanism is conclusively verified by source + unit tests.

### 1.9 — Provider org-users / MFA — NOT exercised this pass

The provider tier (`emapp-provider` audience, MFA, AccessReasonGate) needs a
separate provider login + MFA enrolment not wired into this QA org session.
Deferred; its access controls are covered by the provider-audit + provider-session
suites. Noted so it isn't assumed-tested.

---

## 2. Logs assessment (MANAGER lens) — ✅ SaaS-grade, one gap

Inspected the live `@emapp/api` pino output (472 lines covering this whole E2E
session, including the PII-touching DSAR export of `national_id 123456782`).

| Property            | Result                                                       |
| ------------------- | ------------------------------------------------------------ |
| Structured JSON     | ✅ pino, one object per line                                 |
| Request correlation | ✅ `req.id` (`req-3`…`req-81`), req↔res paired               |
| Latency             | ✅ `responseTime` (ms) + `res.statusCode` on every response  |
| Levels              | ✅ 297× info(30), 2× warn(40), **0 error(50)** — clean run   |
| national_id leak    | ✅ **0** occurrences of `123456782` (export body NOT logged) |
| phone leak          | ✅ **0** occurrences                                         |
| password leak       | ✅ **0** occurrences                                         |
| cookie redaction    | ✅ 79× `"cookie":"[REDACTED]"`                               |

- The 2 warnings were `"Unsupported route path: …"` — **my own** probes of
  non-existent endpoints (e.g. `/api/v1/permissions`), benign.
- **The single gap is M-2:** `referer` is the one request header that is NOT
  redacted, and it can carry the reset token. Everything else is clean.

**Verdict:** the logging is genuinely production-grade (structured, correlated,
latency-instrumented, PII-safe in bodies). Close M-2 and it's complete.

---

## 3. Sysadmin / professionalism recommendations (for owner decision)

None of these are bugs in the merged features — they're the "make it feel like a
real product" layer. Ordered by value. **Not built** — recommendations only.

1. **Custom error pages (S-1, easy win).** `/sign/<bad>` and unknown routes render
   Next.js's default English _"404 This page could not be found."_ — jarring in a
   Hebrew RTL product. Add branded RTL `not-found.tsx` / `error.tsx` (global +
   per-segment). Low effort, high polish.
2. **Readiness vs liveness split (S-2).** `/api/v1/health` returns `{status,uptime}`
   (liveness) but does not check DB / R2 reachability. Add a `/ready` that pings
   the pool + storage so the platform (Railway) can gate traffic on real
   dependency health, not just "process up."
3. **Close M-2 — redact `referer`** in the pino config (+ `replaceState` on the
   reset page). Small, removes a credential-in-logs path.
4. **Add the M-1 post-migrate guard (S-3).** A CI/boot assertion that every
   `_journal.json` tag has a matching `__drizzle_migrations` row AND its schema
   object exists — so a silently-skipped migration fails loudly instead of
   shipping a missing column. (This run hit exactly that on 0056.)
5. **Active-sessions UI (S-4).** `auth_sessions` already does refresh-rotation +
   reuse-detection; surface a "your active sessions / sign out everywhere" screen.
   Expected of a B2B SaaS handling PII; the data model is already there.
6. **Surface rate-limit + lockout state (S-5).** Rate limiting (100/min) and
   account lockout exist server-side; expose `RateLimit-*` response headers (client
   backoff) and a clear "account temporarily locked" UX so users aren't left
   guessing on repeated 429/lockout.
7. **Confirm observability is wired for prod (S-6).** `instrument.ts` (Sentry) +
   the P0.B2 metrics/alert/breach-detection seam exist; verify the Sentry DSN,
   the Prometheus endpoint, and the webhook alert sink are configured in the prod
   environment (they're pluggable Noop by default).

---

## 4. Status

**Review complete for this pass.** All 7 Gate-6 PRs are merged, migrations are on
dev, both servers boot clean, and features 1.1–1.8 were driven in a real browser
to completion (1.9 provider/MFA deferred). Two security findings (M-1, M-2) +
seven professionalism recommendations are documented above for owner decision; no
feature is broken. All test artifacts created during verification were cleaned up
(role deleted, overrides cleared, test project archived, scanned doc restored).
