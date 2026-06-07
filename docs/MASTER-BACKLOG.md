# EMAPP — MASTER BACKLOG (single ordered execution plan, 2026-06-07)

Everything remaining, in ONE list, ordered by the **optimal fix sequence** (a professional
prioritization: launch-gate → cheap-now-expensive-later → foundations → trust → core-loop →
generic per-org → completeness → polish). **Nothing is "deferred for technical reasons"** —
the ONLY things that wait are 3 external accounts you open + 2 inputs only you provide. The
rest is all in the order below. Caveat: consolidated from systematic code-grounded sweeps;
a one-org beta will surface the real edge cases (see the beta note).

**Reconciliation note (2026-06-07):** this list was cross-checked against the project's OWN
documented-issue ledgers (OPEN-ITEMS-v8, AUDIT-V1-1, FINDINGS-REGISTER, STATE-OF-PRODUCT,
SYSTEM-STATE-AUDIT, DV-FINDINGS, V10-FE-INLINE, DECISIONS-V12, GATES, MASTER-PLAN-V11). Those
are mostly **stale ledgers**: of 14 high-impact findings re-verified against current code, **9
were already FIXED** (provider FE login, projects/documents indexes, owners.name encryption,
otp_codes RLS, trustProxy=1-hop, provider-role-from-DB, CSV formula-injection, dashboard KPIs,
R2 file_deleted_at, #227 proxy). The genuinely-open engineering items are folded in below
(Phase 3 #5a + the Pre-launch Hardening + Deferred-by-Decision registers). False findings were
dropped, not listed.

Tags: 🔴blocker 🟠high 🟡med ⚪low · effort S(hours) M(days) L(week) · 🌐external 🧩your-input

---

## ⏩ PARALLEL from day 1 (NOT code — your action; gates production)

- 🌐 **SMS account (Inforu/019)** → `SMS_PROVIDER_USER/TOKEN/SENDER` in Infisical. Prod
  fail-fast until set, so SMS never silently no-ops. _Without this the core loop is dead._
- 🌐 **Email provider (Resend) keys** → gates member invites, signature emails, AND the
  calendar `.ics` invites (calendar works with Google/Outlook/Apple via email — no Google
  API needed).
- 🌐 **Domain + deploy config** → `PUBLIC_APP_URL` / CORS to the real domain.
- 🧩 **Design artifact** (for the re-skin — Phase 10) · 🧩 **pricing model** (for billing —
  Phase 8). Provide when ready; everything else is built regardless.

## ✅ Already DONE this run (~16 PRs — context)

SMS provider + signature-SMS + bulk-send + manager-resend · B-AGENT-1 (split-brain killed) ·
viewer/agent dead-controls · M2 export-gate · B-RESIDENT-1 resident resend · B-PROVIDER-1
--reset-mfa · contractor lastAccessedAt + status/type · provider suspended-badge + search ·
agent KPI scoping · functional project-types (consent threshold) · B-PROVIDER-2 self-audit ·
document_uploaded notification · perf de-flake · P9 (verified) · the full architecture +
catalog docs.

---

# THE ORDERED PLAN (top = do first)

## Phase 1 — Foundation seams (cheap, unblock everything else)

1. **OrgSettings resolver** 🟠 S — typed `OrgSettings` Zod (defaults) + `getOrgSettings(tx,
orgId)` over the existing `organizations.settings` jsonb (NO migration). The one seam
   every per-org policy reads. _Do first — Phases 6–8 build on it._
2. **Design-token single-source posture** 🟡 S — make `globals.css` tokens canonical + a
   "no new inline hex/HSL" lint guard. Enables the re-skin + per-org branding later.

## Phase 2 — Data-model change WHILE TABLES ARE SMALL (cost-of-delay)

3. **Feature A — owner/renter + inline person entry** 🟠 L — `relationship` column + the
   D.25 trigger migration (HIGH-RISK: verify on local DB, security-review the trigger) +
   service + signature-flow excludes renters + FE toggle + inline-create. _Cheap now on
   empty tables; painful after prod data. (Your concern #2.)_

## Phase 3 — Trust & security (B2B table stakes)

4. **A3 — dead share perms + national_id footgun** 🟠 M — strip tenants/notes/team/upload
   from `SharePermissionsSchema` + the FE form (the manager must not think they can leak a
   national_id to a contractor); JSONB-cleanup migration for existing rows (root-cause, not
   UI-only).
5. **Contractor share-token URL→httpOnly cookie** 🟡 M — exchange the 30-day URL token for
   an httpOnly cookie on first load (stop referrer/history/log leakage).
   5a. **Scheduler / periodic runner (H4) — VERIFIED OPEN** 🟠 M — no `.schedule()` job exists;
   the "orphan-sweeper" referenced in code is fiction. Build one pg-boss CRON runner. It is
   foundational + carries a PII-retention angle, so it sits in the trust tier. **Unblocks
   (its tail, all VERIFIED open):** R2 PII-byte purge-RETRY on failed imports (Israeli
   privacy / right-to-erasure) · session/otp/cache_kv/notifications reapers (L5) · signature
   `expired` status + transition + notify (L6 — no `expired` enum value today) · task
   due-date / overdue firing (L7 — badge computes but nothing fires).

## Phase 4 — Core-loop correctness (the signature journey works end-to-end)

6. **Resident no-phone login/sign path** 🟠 M — today a phone-less owner can't log in OR
   sign. Decide + build the fallback (require phone, or email/manual path).
7. **Resident multi-org login** 🟠 M — deep-link tenant login with the org slug pre-filled
   from the SMS (stop the silent "≥2 orgs → no code" dead-end).
8. **Resident dead-link recovery CTA** 🟡 S — the invalid-link screen offers "request a new
   link" instead of "phone the developer".
9. **Resident self-update contact info** 🟡 M — a wrong phone/email currently locks them out
   with no self-fix.
10. **Resident inline document preview on /sign** 🟡 M — show the PDF before they draw a
    signature (trust + legal-soundness).
11. **Agent sidebar Owners gate** 🟠 S — hide the Owners nav for an agent without
    view_owners (B-AGENT-1 fixed /me; the nav item still shows → 404).
12. **Agent tasks-by-project** 🟠 M — per **decision D-O6**: recommended (b) auto-assign the
    creator on create (non-deviating); or (c) project-scope agent task reads. _Answer D-O6._
13. **Agent 403-vs-network distinction** 🟡 S — a permission 403 must look different from an
    outage on scoped lists (list-page-shell).
14. **Agent home / "my assignments"** 🟡 M — a landing surface scoped to the agent's work.

## Phase 5 — Notifications & operational visibility (build CONFIG-DRIVEN per the spine)

15. **Notification engine** 🟠 M — `resolveNotificationRecipients` reads `settings.
notifications`, default = D-O7 (managers always + scope − actor). **Retrofit
    document_uploaded (#274, agents-only today) onto it.**
16. **Remaining notification types** 🟡 M — apartment_status_changed + note_added (→
    project) + share_revoked (→ relevant + managers). mention = skip MVP.
17. **import-complete** 🟡 M — new `notification_type` enum value (small migration) + emit
    on import finish to the runner (+ managers via the engine).
18. **Dead SMS-gateway alerting** 🟡 M — page ops when the gateway rejects (today log-only).

## Phase 6 — The generic per-org system (default = today's behavior; UI incremental)

19. **Messaging templates** 🟡 M — the 11 hardcoded Hebrew templates (signature invite
    email/SMS/WhatsApp, signed-confirm, manager-notify, member invite, OTP SMS, calendar
    emails) → per-org overridable copy via `settings.messaging`.
20. **Sender identity (brand name)** 🟡 S — "EMAPP" in SMS/email → per-org name.
21. **Locale + timezone** 🟡 S — `he` / Asia/Jerusalem defaults → per-org.
22. **Signature link TTL + delivery channels** 🟡 S — 7d + channel selection → per-org.
23. **Per-org consent-threshold defaults** ⚪ S — per-type default map → per-org override.
24. **Limits** ⚪ S — bulk cap (200), list page-size → per-org.
25. **Security controls (TIGHTEN-ONLY)** ⚪ M — OTP/lockout/throttles configurable but
    clamped ≤ the secure default; token TTLs stay locked.
26. **Capability presets + per-project caps** 🟡 M — preset bundles ("field/office agent") +
    per-project capability overrides (catalog #8), as data extensions of the existing
    effective-permission resolver (don't fork it).
27. **Per-org default share template** ⚪ S — the manager's new-share baseline.
28. **Custom task / document types** ⚪ M — org-defined type lists (task type is already free
    text; doc categories map to the canonical enum).
29. **Status automation** ⚪ M — per-org on-transition actions for apartment/project status
    (the enums stay locked; the automation is configurable).

## Phase 7 — Provider / platform completeness

30. **Provider audit EXPORT** 🟠 M — CSV/NDJSON stream for a compliance request.
31. **Provider self-audit perf index** 🟡 S — `(started_at desc, id desc)` before the table
    grows.
32. **Provider impersonation / view-as** 🟡 L — time-boxed, reason-gated, audited read-only
    support access.
33. **GDPR export / delete** 🟡 L — per-org data export + hard-delete for a departing
    customer (D.49 deferred purge — now in scope).
34. **PCSidebar stubs + onboard nav** ⚪ S — wire/hide the 9 locked stubs; surface onboarding.
35. **Access-reason hardening** ⚪ S — per-action reason (today sessionStorage-soft; BE
    re-validates, so not a hole — polish).
36. **Contractor: threshold context + onboarding/expiry + progress export + milestone
    notify** 🟡 M — surface the majority-threshold on the contractor progress bar; show
    shared-by/expires; a PII-free progress export; opt-in milestone emails.

## Phase 8 — Billing / quota (when the pricing model is decided 🧩)

37. **Plans / quota / usage-metering** 🟡 L — subscription + per-org limits + overage
    signals. _Build once you define the tiers._

## Phase 9 — Polish · a11y · tests · minor debt

38. **Resident polish** ⚪ — session-expiry message; portal document download; canvas-signing
    a11y (typed-name / upload fallback).
39. **A2 — auth test coverage** 🟡 M.
40. **A4 — close** ⚪ — JSDoc already clear; mark done.
41. **Minor code follow-ups** ⚪ — metrics pool-counter; buildings read/write call-site
    split; policy.ts owners-scoping; D-O4 partial-unique-index (bulk dedup-race);
    provider-me follow-up.

## Phase 10 — Design re-skin (parallel; activates when the design artifact 🧩 arrives)

42. Token consolidation + re-skin per `ARCHITECTURE-fe-design-tokens.md` — one screen first,
    then expand; inline→classes per screen; then per-org branding overrides the tokens. The
    data layer is never touched.

---

## 🔒 PRE-LAUNCH HARDENING (Gate-5 — before prod, mostly small; from the audit reconciliation)

VERIFIED-open hardening that gates production (do alongside the Phase-0-from-day-1 externals):

- **PROVIDER_DATABASE_URL fail-fast (SA-1) — VERIFIED OPEN** 🟠 S — `client.ts:121` +
  `worker/main.ts:119` fall back to `DATABASE_URL` when unset → the provider pool silently
  loses BYPASSRLS role separation. Drop the fallback for non-test; add a boot probe asserting
  the provider role. _Deploy-safety._
- **Dedicated `SHARE_TOKEN_SECRET` (SEC-7) — VERIFIED OPEN** ⚪ S — `share-token.service.ts:65`
  reuses `JWT_SECRET` (code comments it as "PL hardening pending"). Give the contractor share
  token its own secret (mirrors the signature-token separation) so one leak ≠ all tiers.
- **Gate-5 prod-deploy checklist (GATES.md)** 🌐 — the deploy-time wiring: Resend real
  provider at the factory (= the email external) · R2 real-provider swap + the R1–R4 storage
  attestation · D.28 presigned-URL confidentiality re-check. _Owner + deploy._
- **getMe SSR self-hop (PERF-2 / D.53)** 🟡 — decided to fix at the deploy layer (direct
  server→API call + timeout) paired with DB colocation. Pre-launch (PL1).
- **3-round-trip CI gate (D.52)** ⚪ S — pin `withTenant` round-trips at the spec-safe floor of
  3 as a regression test. Pre-launch.
- **FUNC-1 owner empty-email** ⚪ S — re-verify: the create _blocker_ appears resolved
  (`owner.ts:80` `.nullable().optional()` accepts `""`); the residual is a minor data-quality
  nuance (store `""` vs `null`). Coerce `"" → undefined` in the FE form. _Low._

## 📋 DEFERRED BY DECISION (documented CHOICES, not missed gaps — listed for completeness)

These have decision records; they are intentionally not-now. Surfaced so nothing is hidden:

- **Class-2 legacy↔engine strangler** (~37 service sites still scope by legacy JWT `user.role`
  vs engine assignments; PII capability split-brain root). SAFE until custom roles exist;
  bounded; complete via parallel-write + equivalence proof + cutover. _(CHAIN-RISK-REGISTER.)_
- **Optimistic locking on PATCH races (M-7)** → V12 (no observed real-world race).
- **Provider audit tamper-evidence (SA-2)** `row_hash`/`prev_hash` chain → enterprise-prospect
  trigger (not MVP).
- **AUDIT-V1-1 provider-tier hardening cluster** — a set of MED items (SRP refactor of
  `withProvider` CC-3/SA-10/SA-11, ISP `ProviderActor` CC-4, audit-on-rejected-request SA-6,
  audit-tx-ordering SA-7, access-reason quality CC-2, audit-search date-cap SA-4, per-controller
  rate-limits SA-9). **Partly already done** (trustProxy, provider-role-from-DB, login-failure
  audit were verified FIXED) — the rest is **verify-then-fix** when Phase 7 (provider) is built,
  NOT taken on faith. _(AUDIT-V1-1-PHASE6.5-FINDINGS.)_
- **§v8 scale-tier deferrals** — `withProvider` audit two-tx ordering, `audit_log` RLS
  `WITH CHECK (actor_id)`, ImportJobHandler SRP decomposition, `withTenant` round-trip collapse.
  Pre-scale, not pre-launch. _(OPEN-ITEMS-v8.)_

## 🧪 Recommended checkpoint: ONE-ORG BETA after Phase 4

Run a focused beta with a SINGLE real org once the core loop (Phases 1–4) is solid + the SMS
account is live. Real usage surfaces the true 20% that no code sweep catches — and it's cheap
to fix with one org, not a hundred. Feed its findings back in before broad launch.

## Decisions still open (don't block, but resolve when convenient)

D-O6 (Phase-4 #12 — pick b or c) · D-O1..D-O5 (confirm-or-override the shipped defaults).
