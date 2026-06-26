# Red-team ledger — email / link / cross-entity process (2026-06-25)

Standing loop-until-dry red-team (234 agents, 6 rounds, scanned 64). Each candidate FP-verified across 3 lenses (default not-real); only confirmed-real listed. **41 confirmed: 21 HIGH / 20 MED.**

Status legend: `[ ]` open · `[x]` fixed. #1 fixed in PR #560.

## token-security (3)

- [x] **HIGH** — Signature-link JWT logged in plaintext on every request — pino redacts req.params.token but NOT req.url, where the full token actually lands
  - where: `apps/api/src/logging/log-redact.ts:30-48 (LOG_REDACT_PATHS) + apps/api/src/app.module.ts:59-66 (pinoHttp config); leak site: pino-std-serializers req.url; route apps/api/src/modules/signatures/public-`
- [ ] **HIGH** — Signature-link JWT leaks to Sentry via request URL — no beforeSend/URL scrub on captureException (and 10% of /sign traces)
  - where: `apps/api/src/instrument.ts:25-31 + apps/api/src/common/filters/http-exception.filter.ts:93-100`
- [ ] **HIGH** — Signature-link JWT leaks in PLAINTEXT to Cloudflare Pages Function logs (a 2nd, unredacted sink) on every backend-fetch failure
  - where: `apps/web/src/app/api/[...path]/route.ts:238`

## delivery-outcome (7)

- [ ] **HIGH** — Per-name holdout chase toasts "signature request sent to {name}" even when delivery had no_channel (no email + no phone)
  - where: `apps/web/src/app/[locale]/(dashboard)/_components/situation-picture/board-primitives.tsx:512-518`
- [ ] **HIGH** — Signature-campaign success toast claims "{created} נשלחו" (sent) using row-insert count, not delivered count
  - where: `apps/web/src/app/[locale]/(dashboard)/projects/[id]/_components/signature-campaign-action.tsx:48`
- [ ] **HIGH** — external-share "resend" (הנפק מחדש) toasts "Access for {party} was re-issued" while the BE ships NOTHING — pure marker, party-token tier X-S4 unbuilt
  - where: `apps/web/src/messages/he.json:2163 (+ en.json:2163); apps/api/src/modules/external-shares/external-shares.service.ts:417-438`
- [ ] **HIGH** — Proposal-approve reissue launders a FAILED sms into a false "delivered via WhatsApp" + fires a false "owner received the link" notification
  - where: `apps/api/src/modules/signatures/signature-requests.service.ts:2136`
- [ ] **HIGH** — member + provider-onboarding invite emails claim "ההזמנה נשלחה" (sent) on every 2xx — a rejected/failed/threw send is swallowed and reported as delivered, while in prod the token is suppressed so the invitee can NEVER join
  - where: `apps/api/src/modules/members/members.service.ts:182-226 (sendInviteEmail) + :243/:321 (create/resend callers); apps/api/src/modules/provider/provider-onboarding.service.ts:176-204; apps/web/src/app/[l`
- [ ] **MED** — Manager single-create / chase path drops the delivery report instead of reusing the canonical no_channel legibility seam
  - where: `apps/web/src/lib/api/signature-requests.ts:167-171`
- [ ] **MED** — resident portal self-resend always shows "A fresh link was sent to your phone" regardless of the per-channel report — ignores rejected SMS / email-only / no-phone outcomes
  - where: `apps/web/src/app/[locale]/(tenant)/portal/page.tsx:109-112,517-520; apps/web/src/messages/he.json:1860 (resentHint); apps/api/src/modules/signatures/signature-requests.service.ts:1384-1463 (resendForO`

## cross-entity-authz (5)

- [ ] **HIGH** — Archiving a contractor does NOT revoke their active shares — offboarded party keeps reading for up to 30 days
  - where: `apps/api/src/modules/contractors/contractors.service.ts:261`
- [ ] **HIGH** — Archiving a project does NOT cut contractor document access — docs of an archived project remain listable + downloadable
  - where: `apps/api/src/modules/contractor-portal/contractor-read.service.ts:171`
- [ ] **HIGH** — Project-scoped external-share resolver leaks per-owner APARTMENT-level documents (isDocInShareScope project-scope ignores apartmentId)
  - where: `apps/api/src/modules/external-shares/external-party-authz.ts:174-176 (isDocInShareScope, project branch) + apps/api/src/modules/external-shares/external-shares.service.ts:495-521 (resolveDocumentAcces`
- [ ] **MED** — external-share update() scope-pivot: narrows-only id-containment guard is skipped on any scope_type change, letting a grant be silently re-pointed to a DIFFERENT project's entities
  - where: `apps/api/src/modules/external-shares/external-shares.service.ts:283-288`
- [ ] **MED** — Project-scoped external-share grant can NEVER reach any per-owner (apartment-level) document — project scope-match tests documents.project_id which is NULL for every apartment doc
  - where: `apps/api/src/modules/external-shares/external-party-authz.ts:174-176`

## error-handling (7)

- [ ] **HIGH** — Resident sign page renders transient/infra failures (503, 429, network) as a TERMINAL "link no longer valid" dead-link with misdirecting recovery copy
  - where: `apps/web/src/app/sign/[token]/page.tsx:84-100,152-181,192-215`
- [ ] **HIGH** — external-share "re-issue access" (resend) toasts "הגישה הונפקה מחדש" but the BE delivers NOTHING to the party — false success on a half-built path
  - where: `apps/web/src/app/[locale]/(dashboard)/_components/share-activity-panel.tsx:137-145 (onResend → toast resendDone); copy apps/web/src/messages/he.json:2163; BE apps/api/src/modules/external-shares/exter`
- [ ] **MED** — Contractor read-view renders a FAILED documents fetch as the "no shared documents" empty state — dishonest false-empty to the external party
  - where: `apps/web/src/app/[locale]/(contractor)/contractor/share/page.tsx:169`
- [ ] **MED** — Contractor read-view SILENTLY drops the signature-progress section on a failed progress fetch (no loading/error/empty state)
  - where: `apps/web/src/app/[locale]/(contractor)/contractor/share/page.tsx:113`
- [ ] **MED** — Tenant portal redirects a logged-in resident to /tenant/login on a 5xx infra outage (misdirecting recovery, not an auth failure)
  - where: `apps/web/src/app/[locale]/(tenant)/portal/page.tsx:146-151`
- [ ] **MED** — Resident sign page has an infinite, unrecoverable loading state — raw fetch with no timeout/abort on a hung backend or R2 presign
  - where: `apps/web/src/app/sign/[token]/page.tsx:69-106`
- [ ] **MED** — Documents cockpit + completeness board hard-code error={undefined}, so a 403 renders as a forever-retrying load error instead of the calm access-denied panel
  - where: `apps/web/src/app/[locale]/(dashboard)/documents/documents-list.client.tsx:285`

## devoutbox-bypass (5)

- [ ] **HIGH** — Boot guard assertDevBypassNotInProduction() has a blind spot that silently defeats its stated purpose on the API service (only crashes when serverEnv.NODE_ENV is exactly 'production', which the prod API image never guarantees)
  - where: `apps/api/src/common/dev-auth-bypass.ts:27-34`
- [ ] **HIGH** — OTP/MFA dev-bypass code 000000 goes LIVE in a deployed env when NODE_ENV is unset, because the runtime gate reads serverEnv.NODE_ENV which DEFAULTS to 'development'
  - where: `apps/api/src/common/dev-auth-bypass.ts:12-14 (isDevAuthBypass → computeDevAuthBypass(serverEnv.NODE_ENV, serverEnv.DEV_AUTH_BYPASS)); packages/config/src/env.ts:7 (NODE_ENV .default('development'))`
- [ ] **HIGH** — NODE_ENV gap-band silently swaps invites to a no-op FakeEmailProvider AND suppresses the token — every invite returns 201 success but is undeliverable, with the boot guard that's supposed to catch this never firing
  - where: `apps/api/src/modules/members/invite-email.ts:26-52`
- [ ] **MED** — Deploy-artifact inconsistency: API Dockerfile runner stage omits `ENV NODE_ENV=production` that web + worker images both bake in — the prod-detection of every NODE_ENV gate on the API depends entirely on an external env var that nothing in the image guarantees
  - where: `apps/api/Dockerfile:33-52`
- [ ] **MED** — RUNBOOK documents a non-existent EXPOSE_INVITE_TOKEN kill-switch — the env var is never read, so the documented way to disable invite-token exposure does nothing (silent dead control)
  - where: `apps/api/src/modules/members/invite-email.ts:26-27 (and docs/RUNBOOK.md:31)`

## otp-calendar (8)

- [ ] **HIGH** — OTP request() is a timing-based owner-enumeration oracle (SMS send awaited inline before HTTP 200)
  - where: `apps/api/src/modules/auth/tenant/otp.service.ts:137-150`
- [ ] **HIGH** — SMS provider factory FAIL-OPENS to NoopSMSProvider in production when process.env.NODE_ENV is unset — OTP + signature SMS silently no-op while reporting 'sent', zero observability
  - where: `apps/api/src/modules/auth/tenant/sms-provider.factory.ts:30`
- [ ] **HIGH** — OTP verify() brute-force lockout is a non-atomic read-modify-write — concurrent guesses bypass MAX_ATTEMPTS entirely
  - where: `apps/api/src/modules/auth/tenant/otp.service.ts:163-199`
- [ ] **HIGH** — Clearing a task's scheduled_at fires 'cancel' but sendInviteForTask skips on null scheduledAt — active external attendees keep a ghost meeting forever
  - where: `apps/api/src/modules/calendar-email/calendar-email.service.ts:134-139`
- [ ] **MED** — OTP verify() targets only the most-recent unused row by phone (no org scope) — a second OTP request for the same phone can lock out / deny an outstanding code in the multi-org case
  - where: `apps/api/src/modules/auth/tenant/otp.service.ts:163-168`
- [ ] **MED** — Calendar CANCEL is silently suppressed for an archived attendee — the owner keeps a ghost meeting in their calendar forever
  - where: `apps/api/src/modules/calendar-email/calendar-email.service.ts:157-166`
- [ ] **MED** — A failed/rejected OTP SMS still consumes the resident's 3-per-15-min request budget while the API always reports generic success — silent lock-out with no legible feedback
  - where: `apps/api/src/modules/auth/tenant/otp.service.ts:80-119,137-149`
- [ ] **MED** — OTP verify() has no transaction/row-lock between the unused-row SELECT and the attempts/usedAt UPDATE — concurrent wrong guesses race the brute-force counter past MAX_ATTEMPTS
  - where: `apps/api/src/modules/auth/tenant/otp.service.ts:163-199`

## email-content-sec (6)

- [ ] **HIGH** — Signing-link base URL fails OPEN to http://localhost:3001 — real owners get a dead, non-HTTPS sign link when PUBLIC_APP_URL is unset in prod
  - where: `apps/api/src/modules/signatures/signature-requests.service.ts:233`
- [ ] **MED** — Calendar email subject bypasses the canonical headerSafe() — user-controlled task.title reaches the mail subject with control chars unstripped
  - where: `apps/api/src/modules/calendar-email/calendar-email.service.ts:262,304-309`
- [ ] **MED** — Calendar send counts transport-'failed' as delivered and writes the ics_sent_at marker — OUTCOME-honesty divergence from the canonical taxonomy
  - where: `apps/api/src/modules/calendar-email/calendar-email.service.ts:267-298`
- [ ] **MED** — Two divergent env vars for the same public-app origin (PUBLIC_APP_URL vs APP_BASE_URL) with different defaults — guarantees inconsistent / wrong links across email types
  - where: `apps/api/src/modules/signatures/signature-requests.service.ts:233`
- [ ] **MED** — Invite-token & reset-token can leak to logs via the email-client throw path — logger.error interpolates mailErr.message (the signature path was hardened against this exact sink; invite/reset were not)
  - where: `apps/api/src/modules/members/members.service.ts:222 (and apps/api/src/modules/auth/auth.service.ts:603)`
- [ ] **MED** — member-invite (and resend) report success to the manager even when the sole-channel email is rejected/throws — silent non-delivery
  - where: `apps/api/src/modules/members/members.service.ts:205-225 (sendInviteEmail) + :243/:280 (create/resend callers)`
