# EMAPP — MASTER BACKLOG (single source of truth, 2026-06-07)

Everything remaining, consolidated from ALL sources (6-persona catalog, per-org-policy
sweep, decisions-for-owner, code-debt sweep, audit backlog, design analysis). This is THE
list — stop discovering piecemeal; it's all here. Honest caveat: this consolidates every
finding from the SYSTEMATIC sweeps (code-grounded). Real live-usage could still surface
edge cases, but nothing systematic is hidden from this list.

Legend: 🔴 blocker · 🟠 high · 🟡 med · ⚪ low · 🔒 decision-needed · 🌐 external/paid ·
💤 deferred-out-of-MVP. Effort: S(hours) M(day(s)) L(week-ish).

---

## ✅ DONE this session (~16 PRs — context, so you see the ground covered)

SMS provider + signature-SMS + bulk-send + manager-resend (P1/P2/P3/P5) · B-AGENT-1
(agent effective-permissions, killed the split-brain) · viewer/agent dead-controls · M2
export-gate · B-RESIDENT-1 resident self-resend · B-PROVIDER-1 --reset-mfa ·
contractor lastAccessedAt + status/type render · provider suspended-badge + name-search ·
agent KPI scoping · functional project-types (consent threshold) · B-PROVIDER-2 provider
self-audit · document_uploaded notification · perf-gate de-flake · P9 (verified already
done) · the 6-persona catalog + the per-org-config architecture docs.

---

## 🔒 A. DECISIONS FOR YOU (unblock the rest — pick & I/the-fresh-session proceed)

- **D-O6 — agent task visibility.** Today assignee-based (documented). Pick: (a) keep ·
  (b) auto-assign creator on create [recommended, small] · (c) project-scope agent task
  reads [model change]. → governs the "agent can't see tasks on their project" HIGH.
- **D-O1..D-O5 confirmations** (I shipped a default; confirm or override — none blocks):
  D-O1 SMS=Inforu · D-O2 always-SMS-when-phone · D-O3 bulk token in WhatsApp deeplink ·
  D-O4 bulk dedup-race deferred · D-O5 export=Manager-only.
- (D-O7 notifications + the owner/renter answers + import-complete = ALREADY DECIDED.)

## 🟢 B. PHASE 0 — READINESS FOUNDATIONS (build FIRST; enable everything else)

- **OrgSettings config resolver** 🟠 S — typed Zod `OrgSettings` (defaults) +
  `getOrgSettings(tx,orgId)` over the existing `organizations.settings` jsonb (NO
  migration). The one seam every per-org policy reads.
- **Design-token single-source posture** 🟡 S — make `globals.css` tokens canonical; add a
  "no new inline hex/HSL" rule (lint guard); inline→classes migrates incrementally.

## 🟠 C. FEATURES (the data/logic track)

- **Feature A — owner/renter + inline entry** 🟠 L — per `FEATURE-owner-renter-design.md`.
  Schema + the D.25 trigger migration (HIGH-RISK, verify-locally + security-review) +
  service + signature-flow (exclude renters) + FE toggle + inline-create. (Closes your
  concern #2.)
- **Notifications engine (config-driven) + remaining types** 🟠 M — build
  `resolveNotificationRecipients` (default=D-O7: managers-always + scope); RETROFIT
  document_uploaded (#274, currently agents-only) onto it; wire apartment_status_changed +
  note_added (→ project) + share_revoked (→ manager). mention=skip MVP.
- **import-complete** 🟡 M — new `notification_type` enum value (small migration) + emit on
  import finish to the runner (+ managers via the engine).

## 🟣 D. PER-ORG CONFIGURABLE DOMAINS (the spine instances — default = today's behavior)

Each: config key under `organizations.settings` + read via `getOrgSettings`, UI later.

- **Messaging templates** 🟡 M — 11 hardcoded Hebrew templates (signature invite
  email/SMS/WhatsApp, signed-confirm, manager-notify, member invite, OTP SMS, calendar
  emails) → per-org overridable copy.
- **Sender identity** 🟡 S — "EMAPP" name in SMS/email → per-org brand name.
- **Locale + timezone** 🟡 S — `he` / Asia/Jerusalem defaults → per-org.
- **Signature link TTL** ⚪ S — 7d default → per-org.
- **Signature delivery channels** (D-O2) 🟡 S — which/order, per-org.
- **Per-org consent-threshold defaults** ⚪ S — per-type default map → per-org override.
- **Limits** ⚪ S — bulk cap (200), list page-size → per-org.
- **Security controls — TIGHTEN-ONLY** ⚪ M — OTP/lockout/throttles configurable but
  clamped ≤ secure default; token TTLs LOCKED. (See the security-floor caveat.)
- _Incremental:_ capability presets · per-project caps (catalog #8) · per-org default share
  template · custom task/doc types · apartment/project status automation.

## 🟠 E. GAP-CATALOG REMNANTS (the per-persona tail — see PERSONA-GAP-CATALOG.md)

**Agent**

- 🟠 sidebar nav not capability-gated (Owners shown to an agent without view_owners → 404).
  S. (B-AGENT-1 fixed /me; the sidebar item still needs gating.)
- 🟠 tasks-by-assignee-not-project → governed by **D-O6** above.
- 🟡 403 indistinguishable from a network error on scoped lists (list-page-shell). S.
- 🟡 no agent "home / my assignments" surface. M.
- ⚪ contradictory {view_owners:false, view_owner_pii:true} silently inert (validate at PATCH). S.

**Resident**

- 🟠 no-phone resident can't log in OR sign (no fallback). M. (Needs a product call: require
  phone, or add an email/manual path.)
- 🟠 multi-org resident hits silent "≥2 → no SMS"; deep-link tenant login with org slug
  pre-filled from the SMS. M.
- 🟡 no inline document preview on /sign (signs a legal doc maybe unread). M.
- 🟡 dead-link screen has no recovery CTA. S.
- 🟡 can't self-update own phone/email (wrong number = locked out). M.
- ⚪ 10-min session expiry kicks them out with no message. S.
- ⚪ portal document download deferred (list-only). M.
- ⚪ canvas-only signing (a11y — no typed-name/upload fallback). M.
- ⚪ dead SMS gateway is silent (log-only) — add ops alerting. M.

**Contractor**

- 🟠 4 dead share permissions (tenants/notes/team/upload) + the **national_id footgun** =
  **A3** below. (Migration to strip the dead keys + remove the toggles.)
- 🟡 no majority-threshold context on the CONTRACTOR progress bar (the functional-types work
  added it to the MANAGER project detail; surface it on the contractor view too). S.
- 🟡 share token rides in the URL (referrer/log/history leak; 30-day) → exchange for an
  httpOnly cookie on first load. M.
- ⚪ no onboarding / expiry-visibility / revocation-feedback. M.
- ⚪ no progress-report export for the contractor. M.
- ⚪ no milestone notifications. M.

**Provider-Admin**

- 🟠 no audit EXPORT for a compliance request (cursor JSON only) → CSV/NDJSON stream. M.
- 🟡 perf: add a `(started_at desc, id desc)` index for the self-audit before the table
  grows (sec-review MED follow-up). S (migration).
- ⚪ 9/13 PCSidebar items are locked stubs; /provider/onboard reachable only via a button. S.
- ⚪ access-reason gate is sessionStorage-soft (BE re-validates — not a hole). S.
- 💤 impersonation / view-as for support · billing/quota/plan · GDPR export/delete (D.49
  defers purge) — post-MVP, your call when revenue/compliance demands.

## 🟡 F. AUDIT / TECH-DEBT BACKLOG

- **A3 — dead share perms + national_id footgun** 🟠 M — strip tenants/notes/team/upload
  from `SharePermissionsSchema` + the FE form; needs a JSONB-cleanup migration for existing
  rows (do it RIGHT, not a UI-only plaster). (= the Contractor HIGH above.)
- **A2 — tests for under-tested auth paths** 🟡 M — coverage-add (test-author task).
- **A4 — export.service national_id JSDoc** ⚪ — VERIFIED already clear; mark closed.
- **Minor code follow-ups** (low) — metrics pool-counter (`instrument.ts:26`); buildings
  read-vs-write call-site split; provider-me follow-up; policy.ts owners-scoping; D-O4
  partial-unique-index for bulk dedup-race.

## 🎨 G. DESIGN TRACK (parallel, non-blocking; activates when a design arrives)

- Token consolidation + re-skin per `ARCHITECTURE-fe-design-tokens.md` (re-theme one screen
  → expand; inline→classes per screen; then per-org branding overrides the tokens).

## 🌐 H. EXTERNAL DEPENDENCIES (paid / prod-only — code is ready, needs the account/key)

- **SMS account (Inforu/019)** — open it; put `SMS_PROVIDER_USER/TOKEN/SENDER` in Infisical.
  Until then prod refuses to boot (fail-fast) so SMS never silently no-ops. (D-O1 checklist.)
- **Email provider (Resend)** — wire the real provider in prod (Fake in dev today).
- **Domain** — deploy-time config; `PUBLIC_APP_URL` / CORS origins set to the real domain.

---

## How I'd run it (sequencing)

Fresh session: **Phase 0 (B)** → **Feature A (C)** → **notifications engine + import-complete
(C)** → **per-org domains by value (D: messaging/sender/locale first)** → **gap tail by
severity (E, then A3 in F)**. Design track (G) runs in parallel when a design lands.
External (H) is yours to action anytime. Decisions (A) unblock the fastest — answer D-O6.
