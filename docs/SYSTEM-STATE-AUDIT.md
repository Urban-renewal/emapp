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
- **But the sweep found NEW real issues we'd missed — see below.** The sharpest
  are an agent over-permissioning gap, a calendar-email duplicate-send bug, an
  un-audited provider-login-failure path, and the (already-known) absence of any
  scheduler causing a PII-byte-retention leak.

## CONFIRMED issues — ranked (NEW unless noted)

### 🔴 HIGH

- **H1 — Agent can issue/revoke contractor SHARE LINKS + update projects + replace
  ownerships with NO capability gate.** The engine-backed authz migration gave the
  Agent role `projects.update/archive`, `ownerships.set`, `contractors.*`,
  `shares.create/revoke`, `mapping_templates.manage` at the coarse layer, but those
  services have NO `requireAgentCapability` gate (unlike documents/signatures/tasks/
  imports/buildings/apartments/owners). Record-scope (assigned projects) still holds,
  so it's not cross-tenant — but WITHIN an assigned project an agent can mint an
  external contractor share link (data-egress-adjacent) and end-replace ownerships,
  which D.17 intended as manager-only. Files: services in projects/ownerships/
  contractors/shares lack capability calls; divergence map policy-equivalence.map.ts:262-386.
- **H2 — Calendar (ICS) email re-sends to every attendee on EVERY task edit; the
  `ics_sent_at` idempotency column is written but never read; sends run INSIDE the
  withTenant tx.** calendar-email.service.ts:85,199-257 (loop of external Resend
  calls inside the tx) + trigger tasks.service.ts:483. Result: apartment owners get
  duplicate/spurious calendar invites; a DB connection is held across external I/O;
  a rollback after a send re-sends on retry. The clearest integrity BUG found.
- **H3 — Provider login FAILURES are not audited.** provider-auth.service.ts:166-177
  locks after 5 failures but writes no provider_audit_log row on failure (org + tenant
  tiers DO audit failures). Brute-force/credential-stuffing against the most-privileged,
  cross-tenant, MFA-mandated actor is forensically invisible until a success.
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
- **M2 — Export endpoint gated on `projects.read`, not `export.run`** → Viewer & Agent
  can run bulk exports (export.controller.ts:75; self-acknowledged). PII is masked in the
  composer so not a cleartext leak, but contradicts "viewer = read-only, no export".
- **M3 — Import ownership SET-REPLACE silently end-dates ALL pre-existing active owners
  of any touched apartment.** import-job.handler.ts:1670-1689. By-design (D.25) + soft
  (ended_at), but a re-import of one apartment ends owners not in the new file — a footgun.
  (This is exactly why the import UNDO is risky; the preview now mitigates it.)
- **M4 — Security-critical auth paths are UNDER-TESTED in CI:** provider login/rotation/
  reuse is CI-skipped without env vars (auth.contract.spec.ts:612); tenant OTP rate-limit/
  attempt-lockout/replay-after-use/real-success untested; refresh reuse-detection
  chain-purge-of-other-sessions unverified; concurrent double-refresh TOCTOU untested.
- **M5 — Member provisioning is effectively DEAD in the MVP.** Owner/Admin system roles
  have no backfill, so `members.invite/update/remove` are grantable by nobody → the
  Manager sees a `members` nav item where every action 403s, and `/settings` is unreachable
  for all roles. Orphaned screens + can't actually add a team member via the engine path.
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
