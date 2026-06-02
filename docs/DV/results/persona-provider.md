# DV PERSONA — Product Admin / Provider (מנהל המוצר)

**Persona:** `provider@local.dev` (Provider Admin tier — the SaaS operator who
manages customer organisations).
**Run:** 2026-06-03, headless Chromium, against the REAL stack
(web `:3001`, API `:3000`, seed:demo). 6 Playwright tests, **all green**, **0
console errors**.
**Spec:** `apps/web/e2e/audit/dv-persona-provider.spec.ts`
**Ledger artifact:** `docs/DV/results/artifacts/persona-provider-ledger.json`
**Screenshots:** `docs/DV/results/artifacts/persona-provider-*.png`

---

## VERDICT ON THE OWNER'S CLAIM

> Owner: _"in the product-admin interface NO button or tab worked, couldn't
> create anything."_

**The owner's claim is REFUTED for the provider console.** Every operator
action I PERFORMED actually executed and the OUTCOME was confirmed by re-reading
state from the provider API with the browser's own cookie + `access_reason`
header — never by "the form rendered":

- **Onboard CREATES an org** — POST returns **201**, the success panel renders,
  and the new org is present in `GET /api/v1/provider/tenants`. Reproduced with
  **two distinct orgs** (`198cfa52-5d34-40a6-b999-63bb2b965291` + a 2nd) — both
  appear in the API. The "couldn't create anything" claim is false here.
- **Suspend WORKS** — POST **201**, `Beta.suspendedAt` flips non-null when
  re-read. **Reactivate WORKS** — POST **201**, `suspendedAt` clears. Beta was
  left **active** (verified `suspendedAt=null` at end). Alpha was never touched.
- **Every tab loads its real data** — tenants list shows Alpha + Beta; tenant
  detail opens (Alpha: 4 users / 13 projects / 54 owners, masked PII sample);
  onboard / audit / system-health all render content, not blank/error.
- **Access-Reason gate enforces** — a too-short non-ticket reason keeps submit
  disabled and the gate up; a valid ticket ref (`INC-1001`) enables it.

The prior agent's "cleanest interface" read is the _correct_ one — but now it is
backed by **performed actions + confirmed outcomes**, not render-only.

Two real gaps remain (both **MISSING**, not broken): a large slice of the
platform-console sidebar is locked scaffold, and the provider's OWN audited
actions have no in-product read path.

---

## ACTION LEDGER

| #   | action                                                               | performed                                                                                                                                                               | outcome (confirmed/failed + proof)                                                                                                                                                                                                                                 | should-provider? | verdict               |
| --- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- | --------------------- |
| 1   | Navigate every provider tab + open a tenant detail                   | goto dashboard, tenants, tenant-detail (Alpha & Beta), onboard, audit, system-health; assert oracle content rendered; reproduce Alpha detail (wait on `<h1>Alpha</h1>`) | **CONFIRMED** — `loaded={dashboard,tenants,tenant-alpha,tenant-beta,onboard,audit,system-health}` all `true`; Alpha detail shows 54 owners / 13 projects                                                                                                           | yes              | ✅ works              |
| 2   | Platform-console sidebar nav — live vs scaffold                      | count live nav items vs locked/disabled placeholders                                                                                                                    | **9 of 13** sidebar entries are **locked scaffold** (חיובים ומנויים, תוכניות ומחירון, תמיכה ופניות, תפקידים והרשאות, אינטגרציות, גיבויים ושחזור, משתמשים…) with a lock glyph + non-navigable; only 4 live (דשבורד / ארגונים / בריאות מערכת / יומן ביקורת)          | yes              | ⚠️ MISSING (scaffold) |
| 3   | Access-Reason gate enforcement                                       | enter `"hi"` (too short) → check submit disabled + gate still up; enter `INC-1001` → enabled (×2)                                                                       | **CONFIRMED** — `shortDisabled=true gateUp=true validEnabled=true repro=true`                                                                                                                                                                                      | yes              | ✅ works              |
| 4   | **Onboard a new organisation**                                       | `/provider/onboard` → fill orgName + managerName + managerEmail → submit → assert success panel + re-read tenants API (×2 distinct orgs)                                | **CONFIRMED** — `POST=201 successPanel=true org1InApi=true org1Id=198cfa52-… org2InApi=true`; both orgs appear in `GET /provider/tenants`                                                                                                                          | yes              | ✅ works              |
| 5   | **Suspend a tenant (Beta)**                                          | tenant detail → "השעה לקוח" → note → "אשר השעיה" → re-read provider detail API for `suspendedAt`                                                                        | **CONFIRMED** — `suspendPOST=201 apiSuspendedAfter=true`                                                                                                                                                                                                           | yes              | ✅ works              |
| 6   | **Reactivate a tenant (Beta)**                                       | tenant detail → "החזר לפעולה" (accept confirm) → re-read provider detail API for `suspendedAt`                                                                          | **CONFIRMED** — `reactivatePOST=201 apiSuspendedAfter=false` — Beta restored to active                                                                                                                                                                             | yes              | ✅ works              |
| 7   | Provider audit — view recent activity                                | `GET /provider/audit?fromDate=<6h>` with `access_reason` header                                                                                                         | **CONFIRMED** — org-tier `audit_log` readable, 25 rows in last 6h                                                                                                                                                                                                  | yes              | ✅ works              |
| 8   | Audit of the provider's OWN actions (onboard / suspend / reactivate) | check whether the just-performed `provider.tenant.*` writes are visible through any provider read endpoint                                                              | **MISSING** — those rows land in `provider_audit_log`, which has **no read endpoint** (`provider-audit.controller.ts`: _"surfaced separately if ever needed — out of scope"_). `/provider/audit` returns only org-tier rows. `providerTierRowsVisibleViaApi=false` | yes              | ⚠️ MISSING            |

**Totals:** 8 actions · **6 works** · **0 functional bugs** · **0 authz bugs** ·
**2 MISSING** · 0 console errors.

---

## MISSING / GAPS (not "broken", but absent)

1. **No read path for the provider's own audit trail (MISSING).**
   `provider.tenant.created` / `.suspended` / `.reactivated` / `.viewed` are all
   written (audit-first) to `provider_audit_log`, but nothing in the console or
   the API surfaces them. An operator who suspends a customer cannot later
   review _their own_ audited operator actions in-product — only the cross-tenant
   org-tier `audit_log` is exposed via `/provider/audit`. The BE controller
   comment acknowledges this is deliberately deferred. For a tier whose whole
   security story is "every provider action is audited," a missing operator-facing
   read of that audit is a notable gap.

2. **Most of the platform-console sidebar is locked scaffold (MISSING).**
   The provider shell ("קונסולת פלטפורמה") renders a rich nav — billing &
   subscriptions, plans & pricing, support & tickets, roles & permissions,
   integrations, backups & restore, users — but **9 of 13** entries are locked
   (lock glyph, non-navigable). Only 4 are live (overview / orgs / health /
   audit). This is forward-looking scaffold, not a regression; flagged so it is
   not mistaken for "working" capability. (See `persona-provider-dashboard.png`,
   `persona-provider-tenant-alpha.png`.)

---

## NOTES ON METHOD (anti-false-bug discipline)

- **Outcome, never render.** Every create/suspend/reactivate verdict is grounded
  in a fresh `GET` from the provider API (browser cookie + `access_reason`
  header), not in the form's success UI.
- **Reproduced ≥2×.** Onboard ran with two distinct orgs; the gate enforcement
  and tenant-detail open were each reproduced; suspend→reactivate is inherently
  a 2-step round-trip confirmed at both ends.
- **Hydration race avoided.** One reproduce initially flagged a phantom failure
  because `innerText()` grabbed the nav-only shell before the detail hydrated;
  hardened to wait on the `<h1>Alpha</h1>` heading. (Confirms the MEMORY note:
  a hydration-race `getByText().click()` previously produced a FALSE bug.)
- **Never left dirty.** Alpha was never mutated. Beta was suspended only inside
  the suspend/reactivate test and always reactivated; an `ensureBetaActive()`
  guard runs in `afterAll`. Final state verified: `Beta.suspendedAt=null`.
  (Onboarded DV test orgs remain in the local demo DB — expected for a
  create-confirmation test; they do not affect Alpha/Beta.)
