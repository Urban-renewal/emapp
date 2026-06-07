# EMAPP — complete 6-persona gap catalog (2026-06-07)

Honest answer to "are these all the gaps?": the earlier 22-item catalog was **one
persona (Manager) only**. EMAPP has 6 roles; each experiences a different product.
This is the result of walking ALL SIX as that role (code-grounded, file:line).
The Manager sweep MISSED every blocker below because the Manager holds every
capability and sees org-wide data. Lesson: a single-persona sweep is a half-sweep.

Personas swept: Manager (prior) · Agent · Viewer · Contractor · Tenant/Resident · Provider-Admin.

---

## 🔴 NEW BLOCKERS (a role genuinely cannot do its core job)

- **B-AGENT-1 — Every agent WRITE control is a dead button / mid-flow 403.** The FE
  gates agent write controls on `/me.permissions` (the engine ROLE layer, which
  grants agents nearly all writes), but every write SERVICE enforces the
  per-membership capability flags (default ALL OFF except view_owners). So a normal
  freshly-assigned agent sees New Task / Upload Import / Send-for-Signature / Edit
  Apartment / Archive Owner all ENABLED, clicks, and 403s on essentially everything,
  with a generic error. `/me` loads capabilities but emits only view_owner_pii
  (auth.service.ts:610,646). **Fix:** surface the 7 capabilities on `/me`; have
  `useHasPermission` intersect role-permission ∧ capability for agents (one fix
  collapses dead-controls across imports/tasks/documents/signatures/buildings/
  apartments/owner-archive). FE gates: imports/tasks/documents/signature-requests/
  buildings/apartments/owners pages; BE gates: requireAgentCapability across those
  services.
- **B-AGENT-2 — projects.update/archive is a PHANTOM grant.** `/me` grants agents
  projects.archive so the FE shows the project "ארכוב" button, but the service is
  `requireManager` (projects.service.ts:456,496) → permanent 403 no capability can
  unlock. **Fix:** drop projects.update/archive from the AGENT seed set
  (system-roles.ts:96) OR add a real agent path. (Confirms the H1 residue.)
- **B-RESIDENT-1 — A resident who lost/expired their link has NO self-service way
  back in.** The 7-day single-use signing link is delivered only out-of-band; after
  it lapses the portal SHOWS the pending request but offers no resend (portal has
  zero write endpoints, portal.controller.ts:23). Resend is manager-only
  (signature-requests.controller.ts:142). The resident's only recovery is "phone the
  developer" — defeating the portal's entire stated value. **Fix:** tenant-scoped
  `POST /portal/signatures/:id/resend` (own-record, throttled, re-mints + re-SMS) +
  a "resend my link" button per pending row. (P5 added manager-side resend — this is
  the resident-side gap.)
- **B-PROVIDER-1 — Sole-provider-admin lockout has NO recovery.** No in-product MFA
  reset / add-admin; the bootstrap script HARD-ABORTS if the email exists
  (bootstrap-provider-admin.ts:38-41), so it can't even re-provision. Lose the TOTP
  device + 8 recovery codes → platform console permanently unreachable without DB
  surgery. **Fix (MVP, CLI):** a `--reset-mfa <email>` mode + a documented runbook.
- **B-PROVIDER-2 — The provider's OWN audit log is write-only, never readable
  in-product.** Every cross-tenant access is recorded to provider_audit_log, but no
  endpoint SELECTs it (GET /provider/audit reads the CUSTOMERS' audit_log, not the
  provider's — provider-audit.service.ts:33,111). The core D.37 accountability
  question ("who on our team accessed customer X, and why?") is unanswerable without
  DB access. **Fix:** `GET /provider/self-audit` over provider_audit_log.

## 🟠 HIGH (per role)

**Agent**

- org-wide KPIs for a scoped agent (org-stats.controller.ts:31 — no assignment
  scoping → agent sees all-org numbers that contradict their 1 project + leaks scale).
- sidebar nav not capability-gated (Owners shown to an agent without view_owners →
  403; sidebar.tsx:103-119).
- tasks scoped by task-ASSIGNEE not assigned-PROJECT (tasks.service.ts:246-257) —
  inconsistent with every other entity; an agent can't see tasks on their own
  project, and a task they create vanishes from their own list.
- 403 indistinguishable from a network error on every scoped list (list-page-shell).

**Viewer**

- 3 detail pages render WRITE buttons ungated → a read-only viewer sees + clicks
  them, then 403s: apartment Archive (apartments/[id]/page.tsx:112), document
  Download+Archive (documents/[id]/page.tsx:98,103), signature Cancel
  (signature-requests/[id]/page.tsx:117). **Fix:** gate each on its permission.
- export accepts viewer at the BE (export.controller.ts:75,86 — projects.read +
  viewer in the allowlist) → UI-safe (FE button gates on export.run) but the wire is
  open to a hand-rolled GET. (= the M2 item; the clean fix is export.run.)

**Contractor** (no PII leak — structural exclusion verified clean)

- 4 dead share permissions (tenants/notes/team/documents.upload) grant NOTHING —
  the manager believes they shared owner contacts/upload rights; the contractor sees
  none of it (share.ts:17-41; contractor-read never reads them). (= A3.)
- national_id PII toggle in the share form is a footgun (implies you can expose
  Israeli IDs to an external party; share.ts:23). (= A3.)
- shares.lastAccessedAt is NEVER written (contractor-auth.guard) → the manager can't
  tell if the partner ever opened the link. NET-NEW.
- project status/type fetched but never rendered on the contractor page
  (page.tsx:87) → contractor sees only a name + bar, not the lifecycle stage D.46
  promised. NET-NEW.

**Provider-Admin**

- suspended orgs invisible in the tenant list (suspendedAt only on the detail
  schema, not the list — provider.ts:34-47) → an operator can't see which orgs are
  frozen without opening each.
- no search/filter on the tenant list (limit+cursor only) → find-one-org is blind
  paging.
- no audit EXPORT for a compliance request (cursor JSON only).

**Resident**

- no-phone resident can never log in (OTP resolves by phoneHash) AND can't sign if
  also no email/WhatsApp → invisible-to-themselves.
- multi-org resident hits the silent "≥2 → no SMS" path; org_slug is a raw text
  field they won't know (otp.service.ts:101-110; login form). **Fix:** deep-link
  tenant login with the slug pre-filled from the SMS.
- no inline document preview on /sign — the resident is asked to draw a signature
  for a legal doc they may never have opened (sign/[token]/page.tsx:219). Trust +
  legal-soundness.

## 🟡 MEDIUM / LOW (condensed — see per-persona detail in git history of this file)

- Resident: dead-link screen has no recovery CTA; dead SMS gateway silent (log-only);
  can't self-update contact info; 10-min session expiry kicks them out with no
  message; portal doc download deferred; canvas-only signing (a11y).
- Contractor: share token rides in the URL (referrer/log/history leak — 30-day);
  no majority-threshold context on the progress bar; no onboarding/expiry-visibility/
  revocation-feedback; no progress-report export; no milestone notifications.
- Provider: no impersonation/view-as for support; no billing/quota/plan; no
  GDPR-style export/delete for a departing customer (D.49 defers purge); 9/13
  PCSidebar items are locked stubs; /provider/onboard reachable only via a button;
  access-reason gate is sessionStorage-soft (BE re-validates, so not a hole).
- Agent: no agent home / "my assignments" surface; capabilities global-per-membership
  not per-project (known); contradictory {view_owners:false, view_owner_pii:true}
  silently inert.

## Cross-cutting themes (the real lessons)

1. **The agent authorization model is split-brain** (role-layer grants vs capability
   enforcement) and the FE reads the wrong half → dead controls everywhere. (Biggest
   single fix: B-AGENT-1.)
2. **The product is built for the MANAGER**; every other role gets manager screens
   with some buttons that 403 (viewer, agent) or read-only dead-ends (resident,
   contractor) instead of a role-shaped experience.
3. **Write buttons are gated inconsistently** — some pages gate on permission, three
   viewer pages and several agent paths don't. There is no lint/test that every
   mutating control is permission-gated.
4. **External tiers (resident, contractor) hit dead-ends with no recourse** the
   moment their happy-path link fails.

## Status vs the existing backlog

- Confirms/overlaps: A3 (dead share perms + national_id footgun), M2 (export-viewer),
  H1-residue (agent phantom grant = B-AGENT-2).
- NET-NEW blockers: B-AGENT-1, B-RESIDENT-1, B-PROVIDER-1, B-PROVIDER-2.
- These re-order the queue: B-AGENT-1 (split-brain authz) and B-RESIDENT-1 (resident
  self-resend) are now top-tier alongside the SMS/signature Tier-0 work already done.
