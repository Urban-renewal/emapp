# EMAPP — full system situational picture (2026-06-06)

Honest answer to "do we have a full picture?": **before today, no.** This is the
result of 5 independent read-only audits across the key risk axes (authz/RLS,
tenant-isolation/PII, the 6-role capability matrix, time/lifecycle + data
integrity, test-coverage + error/auth). It is the most systematic picture we
have — evidence-backed (file:line) — but it is still a sweep, not a proof:
treat the "verified clean" sections as high-confidence, not absolute.

## TL;DR posture

- **Tenant isolation + PII at-rest/on-wire: strong, no confirmed leak.** RLS is
  FORCE everywhere + a CI ratchet fails the build on raw-db use. Cross-org,
  provider-audit, contractor/tenant narrow scopes all verified clean.
- **The sweep found real issues we'd missed — but also over-claimed two of its four
  HIGHs.** After file:line re-verification (2026-06-06): H1 (agent over-permissioning)
  is **REFUTED** — those writes are manager-only via `requireManager`, the audit missed
  the guard. H2 (calendar duplicate-send) is **partially real** (sends-in-tx + spurious
  re-send), partially overstated (no idempotency/rollback bug). H3 (un-audited provider
  login failure) was **real and is now FIXED**. H4 (no scheduler → PII-byte retention
  leak) stands. Lesson logged: verify the service body, not just the catalog.

## CONFIRMED issues — ranked (NEW unless noted)

### 🔴 HIGH

- **H1 — ❌ REFUTED (FALSE FINDING, 2026-06-06).** The capability-matrix audit claimed
  agents could update/archive projects, set ownerships, and manage contractors/shares
  with no gate. **This was wrong — the audit agent saw the coarse engine grant + the
  absent `requireAgentCapability` call, but MISSED that every one of these write methods
  calls `this.requireManager(user)`, a STRICTER gate that blocks agents entirely.**
  Verified file:line: `projects.service.ts` update:456 / archive:496 → requireManager;
  `ownerships.service.ts` set:242 → requireManager; `contractors.service.ts`
  create:101/update:146/archive:193 → requireManager (def:48); `shares.service.ts`
  create:193/update:242/revoke:280 → requireManager (def:73). The `if(role==='agent')`
  blocks the audit pointed at are SCOPE checks in READ/assert methods (→404 on
  unassigned), not the write gates. Net effect: these writes are **manager-only today**,
  exactly as D.17 intends. The only real (LOW) residue: the engine coarse grant is
  _wider than the effective permission_ (redundant, not exploitable — the service
  hard-gates). No code change. Lesson: an authz audit MUST trace the service body, not
  just the permission catalog + divergence map.
- **H2 — ⚠️ PARTIALLY REAL (re-verified 2026-06-06; original framing overstated).**
  What's REAL: (a) the external Resend sends run inside the _calendar service's own_
  withTenant tx (calendar-email.service.ts:199-257) → a pooled DB connection is held
  across N external round-trips (perf/pool concern); (b) `'update'` fires on ANY edit
  of an already-scheduled task (tasks.service.ts:482, the was-scheduled∧is-scheduled
  branch), incl. edits that change no calendar field → spurious re-sends. What's
  OVERSTATED: the send is NOT inside the _task-update_ tx — `fireCalendarEmail` is
  `void`-dispatched AFTER that tx closes (tasks.service.ts:206,476, fire-and-forget
  `.catch(()=>{})`). `ics_sent_at` written-never-read is NOT an idempotency bug — an
  ICS UPDATE re-send is the _intended_ calendar semantic (clients refresh on SEQUENCE);
  the column is an audit/"did-we-email" marker, and CREATE fires once on the not→set
  transition. "Rollback re-sends on retry" — there is no retry mechanism. Recommended
  (deferred, not yet done): move the Resend loop OUTSIDE the calendar tx (read in tx1
  → send → stamp ics_sent_at in tx2), and gate `'update'` on a real calendar-field
  delta (scheduledAt/title/attendees changed) to suppress spurious sends.
- **H3 — ✅ FIXED (2026-06-06).** The failure path (provider-auth.service.ts) bumped
  `failedLoginCount`/`lockedUntil` but wrote no `provider_audit_log` row — only success
  did. Now both failure branches (already-locked window + verify) write a best-effort
  `login_failed` audit row via a shared `recordLoginFailure` helper. `metadata` carries
  `{ passwordValid, locked, phase }` — `passwordValid` distinguishes a stolen-password +
  MFA-block (high signal) from a wrong-password spray WITHOUT storing the password; no
  client oracle leaks (the thrown `invalid` is byte-identical for every branch); the
  count-bump (the brute-force security control) is NOT gated on the audit write. Zero
  schema change (`action_type` free-text matches the 0034 CHECK). Test coverage: blocked
  on the same gap as M4 — no in-suite provider-user seed exists (provider users only via
  bootstrap-provider-admin.ts), so a verifying black-box test is env-gated/CI-skipped.
  Code mirrors three existing audited paths exactly (success insert + org + tenant tiers).
- **H4 — No scheduler exists → the "orphan-sweeper" referenced 6× is fiction →
  PII-bearing import R2 bytes whose purge failed are NEVER retried (retention leak),
  and a re-enqueue-failed import sits `queued` forever.** (Known #4; reconfirmed with
  6 call-sites.) imports.service.ts:786,1159,1250; import-job.handler.ts:709.

### 🟠 MEDIUM

- **M1 — otp_codes has NO RLS but a full app_user DML grant + an org_id column.**
  0020_otp_codes.sql:23-24. Latent cross-org read inside any withTenant tx. Unexploited
  today (rows are HMAC-only; the OTP service uses the BYPASSRLS pool pre-auth), but it's
  the one customer-adjacent table breaking the FORCE-RLS-org-scoped invariant. Fix: add
  a tenant_isolation policy + FORCE, or REVOKE app_user DML.
- **M2 — ⚠️ RECLASSIFIED (2026-06-06): a multi-layer policy INCONSISTENCY, NOT a clean
  bug — needs an OWNER decision, do NOT flip the gate.** The endpoint gates on
  `projects.read` (export.controller.ts:75), which Manager+Agent+Viewer all hold. The
  obvious "fix" (tighten to `export.run`) is a TRAP: the engine catalog excludes
  `export.run` from Agent (system-roles.ts:92), BUT D.54 + B.S10 + the composer unit
  tests (export.s10.spec.ts 2c:335, "agent WITH assignment composes the project";
  376 "agent without view_owner_pii exports MASKED") + the controller comment (82-84)
  all treat **agent-scoped masked export as INTENDED**. Tightening to `export.run` would
  403 the agent HTTP path while those composer tests stay GREEN (they call the service
  directly, bypassing the controller guard) — silent breakage, false test confidence.
  Layered contradictions found: (a) role catalog says agent≠export, D.54 says agent=masked-
  export; (b) the FE button gates on `export.run` (export-xlsx-button via projects/[id]/
  page.tsx:65) so it's hidden from Agent AND Viewer, yet the controller comment says
  "FE shows it to manager+agent" (stale). The ONLY clear-cut part: Viewer (pure read-only)
  exporting contradicts the role model — but even that is masked-PII, not a cleartext leak.
  REQUIRED DECISION (owner): is agent-scoped masked export in/out? is viewer export in/out?
  Then align catalog + controller + FE + D.54 to ONE answer. No code change made.
- **M3 — Import ownership SET-REPLACE silently end-dates ALL pre-existing active owners
  of any touched apartment.** import-job.handler.ts:1670-1689. By-design (D.25) + soft
  (ended_at), but a re-import of one apartment ends owners not in the new file — a footgun.
  (This is exactly why the import UNDO is risky; the preview now mitigates it.)
- **M4 — Security-critical auth paths are UNDER-TESTED in CI:** provider login/rotation/
  reuse is CI-skipped without env vars (auth.contract.spec.ts:612); tenant OTP rate-limit/
  attempt-lockout/replay-after-use/real-success untested; refresh reuse-detection
  chain-purge-of-other-sessions unverified; concurrent double-refresh TOCTOU untested.
- **M5 — ❌ REFUTED (FALSE FINDING, 2026-06-06).** Claimed Owner/Admin have "no backfill"
  so members._ is "grantable by nobody", the Manager sees a members nav where every action
  403s, and /settings is unreachable for all. **Every clause is contradicted by code:**
  (1) signup atomically grants the creator an org-scope OWNER role_assignment alongside the
  membership — auth.service.ts:169-199, comment "never an org with no admin"; (2) migration
  0044 backfilled each existing org's PRIMARY manager → Owner (0044:11-16), and 0043
  backfilled all other memberships → same-named system roles; (3) Owner holds members._ +
  org.settings._ (system-roles.ts:62), so the Owner CAN invite/manage members, and the
  invite helper assigns each invited member's system role at invite time
  (helpers/members.ts:90-107); (4) the FE sidebar gates the members / audit / settings nav
  on `members.read` / `audit.read` / `org.settings.read` (sidebar.tsx:92-129, "IAM slice
  5b") — a non-Owner manager doesn't SEE the members nav, so there is no "403 on every
  action" screen. Member provisioning WORKS (via the org Owner = its primary manager).
  Only genuine residue (LOW, by-design): (a) the engine `Admin` role is unreachable today
  (no `roles.assign` endpoint) but is not needed — Owner covers governance, and Admin is
  not one of the 6 MVP roles; (b) non-primary managers lack members._ (governance) — the
  intended one-Owner-per-org model (Decision §11.1 / 0044), NOT a bug. Widening governance
  to all managers would be a deliberate policy change, not a fix. No code change.
- **M6 — import start/submitMapping/confirm commit `queued` then producer.send OUT of tx**
  → send-failure leaves a stuck `queued` row; `start()` lacks even the retry wrapper the
  other two have. Recovery depends on the non-existent sweeper (H4).

### 🟡 LOW (latent / by-design / growth)

- L1 — provider audit metadata.url would capture PII if a future provider endpoint took
  PII in a query param (none do today). Add a param scrub.
- L2 — stale "cleartext national_id" JSDoc in export.service.ts:36,56,113 (code MASKS).
- L3 — stale "only edit_project_data is enforced" comment in member.ts:26-28 (6 of 7 now
  enforced — a false-safe doc).
- L4 — share schema defines unused `tenants{fields.national_id}`/`notes`/`team` perms
  (dead, but a national_id field in a contractor-grant schema is a footgun).
- L5 — unbounded table growth (no reaper): auth_sessions, tenant_sessions, otp_codes,
  cache_kv (its cleanup() is dead code), notifications. All lazy-expiry-correct, just unpruned.
- L6 — signature_requests have no `expired` status/transition/notify → a lapsed link reads
  as `pending` forever in the manager list (known #4 sibling).
- L7 — tasks `dueAt`/overdue computes a badge but nothing fires; notifications have no digest.
- L8 — AUTH_DEBUG_ERRORS can echo pg detail/hint to clients in staging (prod fail-closed).

## CORRECTION to an earlier finding

- **QA-SESSION-1 (mid-action logout) was mis-attributed.** The apiClient refresh-on-401 IS
  method-agnostic (api-client.ts:119-132) — POST/PATCH/PUT/DELETE ARE refreshed+replayed on
  `token_expired`. So the logout I hit during the long walkthrough was almost certainly BOTH
  tokens expired (the 30-day refresh also lapsed in that session), NOT a code bug. Residual
  (real, smaller): the mutation-replay path is UNTESTED (M4), and `apiClient.post` (non-
  idempotent) carries no Idempotency-Key, so a future endpoint that 401s AFTER mutating could
  double-execute on replay. Pin it with a test + key.

## Verified CLEAN (high confidence)

- Tenant↔tenant isolation (FORCE RLS + ratchet test + verified inArray/join scoping).
- PII at rest (pgcrypto everywhere, no plaintext column), masked-by-default reads, single
  audited reveal path, NO PII in logs/errors/audit-JSONB, export masks PII.
- Contractor tier (owners table never queried — PII structurally absent) + Tenant tier
  (every query scoped by JWT sub, no caller-controlled id).
- Provider tier reads all audited (autonomous-commit-before-work) + access-reason-gated.
- Error envelope D.16 consistent; no-oracle on login/OTP/sign/reveal/cross-org; no stack leak.
- FE security DoD: no GET-form leak, no PII-in-URL, no localStorage tokens, no dangerouslySetInnerHTML.
- Auth session rotation + reuse-detection LOGIC correct (just under-tested per M4).
- Every org-domain endpoint has a permission/scoped decorator; AuthorizationGuard fails closed.

## Residual unknowns (not covered even by this sweep)

- Performance/load behavior under real volume; Neon connection-pool exhaustion edge cases.
- Real R2/Resend/SMS provider failure modes (only Fake-provider + synthetic-outage tested).
- The V11 design-reskin surfaces (calendar/tenant-portal/export) beyond what the audits touched.
- Migration replay/rollback safety on the shared Neon (we apply forward-only).
