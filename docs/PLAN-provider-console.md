# PLAN — Provider (Product-Manager) Console: current state, required functionality, real-world model

> Status: **PLANNING** + current-state audit. The WIRED pages are built & working;
> the rest is a roadmap. 2026-06-09.

## 1. Does it work today? — YES for the wired surface

The provider console (`/he/provider/*`, Tier-3, MFA + AccessReasonGate) is
**MVP-complete and functional**. I drove it live in a real browser. The
"everything 400s" symptom you hit earlier was a **real bug** — a Hebrew
access-reason broke every page — now **fixed in PR #322** (the servers you're
testing run that fix). After the fix the org list + dashboard load correctly.

### Built & working (7 pages + write actions)

| Page                         | Route                     | Backed by                                |
| ---------------------------- | ------------------------- | ---------------------------------------- |
| Platform dashboard           | `/provider`               | system-health summary                    |
| **Organizations (tenants)**  | `/provider/tenants`       | cross-tenant list + search               |
| Org detail                   | `/provider/tenants/[id]`  | counts + ≤5 **PII-masked** sample owners |
| **Suspend / reactivate**     | (in org detail)           | D.49 write, audited                      |
| Onboard new org              | `/provider/onboard`       | create org + invite first manager        |
| System health                | `/provider/system-health` | queue / pools / R2                       |
| Cross-tenant audit           | `/provider/audit`         | audit search                             |
| **My activity (self-audit)** | `/provider/audit/self`    | PR #324 (just built)                     |

### Not built — the 9 greyed stubs (intentional post-MVP, NO backend)

`users · plans · billing · support · roles · integrations · backups · staff · settings`.
These are **placeholders with a padlock** — they were never built and have no
endpoint. They are the "90% inactive" you see. They are NOT broken; they're
unbuilt. This doc is the plan for them.

---

## 2. How a real-world vendor "admin/provider console" is built

A mature multi-tenant SaaS provider console = **two halves**:

### Half A — Functional surface (what staff DO)

1. **Tenant lifecycle** — list/search orgs, view (masked) detail, **provision** (onboard), **suspend/restore**, **offboard/delete** (with safeguards), **re-provision a locked-out admin / transfer ownership** (see PLAN-account-recovery.md). ← EMAPP has most of this.
2. **Org users management** — see users across an org, their roles, **resend invites**, **deactivate**, help with the recovery cases. ← the `users` stub. **Highest support value.**
3. **Support / impersonation** — view-as / scoped read to help a customer, ALWAYS audited + (ideally) JIT + customer-visible. ← `support` stub.
4. **Plans / billing / subscriptions** — only meaningful once there's a billing domain model (none today). ← `plans`/`billing` stubs = **net-new product**, not "wire a stub".
5. **System health / ops** — queue, pools, storage, error rates. ← EMAPP has this.
6. **Platform settings / feature flags** — e.g. signup-enabled, per-tier limits. ← `settings` stub.
7. **EMAPP staff / roles** — manage who on the vendor side has provider access + sub-roles (provider_viewer/billing). ← `staff`/`roles` stubs.

### Half B — Governance surface (HOW staff are constrained) — see PLAN there's research backing this

The non-negotiable wrapper around Half A: **isolated tier (not a super-org), MFA,
reason-for-access on every call, immutable audit, PII masking by default, and
(the bar to grow into) Zero-Standing-Privileges + Just-In-Time access + customer-
visible Access Transparency + Access Approval** (Google Access Transparency,
Microsoft Customer Lockbox). EMAPP already implements the first five; the JIT /
transparency items are the growth path.

---

## 3. Roadmap — prioritized (what to actually build)

### Tier 1 — High value, backend already exists or is small

1. **Org users management** (`users` stub). Support's #1 task. Needs `GET /provider/tenants/:id/users` (PII-masked, like the owner-sample) + an FE page. Reuses the masking + audit pattern. **Recommended first.**
2. **Customer-visible Access Transparency** (from PLAN-provider-console governance). You already log who/when/reason in `provider_audit_log`; expose a read-only "EMAPP staff accessed your org" screen to the **org Manager**. Mirrors the `self-audit` page (#324) but customer-facing. High trust ROI.
3. **Re-provision / transfer-ownership** (`users`/recovery overlap) — wire `org.transfer_ownership` + "invite a manager into an existing org" (PLAN-account-recovery R1.5). Fixes the sole-Owner-lockout without DB surgery.

### Tier 2 — Real value, more work

4. **Provider sub-roles** (`roles`/`staff` stubs) — `provider_viewer` (read-only) + the peer-disable endpoint (PLAN-account-recovery R0.2). Segregation of duties once staff > 1. The matrix is already built for it.
5. **Platform settings / feature flags** (`settings` stub) — surface signup-enabled + per-tier limits as a real config screen.
6. **Formal break-glass + JIT** (governance growth) — declared emergency mode, time-boxed per-tenant access.

### Tier 3 — Net-new product (do only when the business needs it)

7. **Billing / plans / subscriptions / support-ticketing / integrations / backups** — these have **no domain model** today (no billing tables, no ticketing). They are new product lines, not "activate a stub". Defer until billing is actually added (the existing D.16 note: "revisit when billing is added — Phase 2").

---

## 4. Bottom line

- **It works** — the wired console is functional (org mgmt, onboard, suspend, audit, health, self-audit), and the bug that broke it is fixed (#322).
- **The "inactive" feeling** = 9 deliberate stubs with no backend. The plan above turns the **high-value** ones (org-users, access-transparency, re-provision, sub-roles) into real features, and correctly **defers** the net-new ones (billing/support) until the business needs them.
- **Recommended first build:** Tier-1 #1 (org users management) — it's the support team's core task and reuses existing masking/audit. Then #2 (customer access transparency), which doubles as the governance quick-win.
