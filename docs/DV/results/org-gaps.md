# DV results — Org / manager gaps (org-switcher · reveal-PII · confirm-archive)

> Spec: `apps/web/e2e/audit/dv-org-gaps.spec.ts` (3 tests). Closes the
> non-page surfaces the manager walk left open (`org-manager-coverage.md`
> §Gaps). Finding IDs continue the DV-ORG-5 sequence.

## RUN STATUS — behavioral evidence PENDING (stack was down)

`http://localhost:3001` was not listening at investigation time
(`net::ERR_CONNECTION_REFUSED`); starting servers is out of the read-only
investigator's scope. Spec is written + lint-clean. Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-dev-local.ps1   # owner / non-read-only role
# from apps/web:
pnpm exec playwright test --config playwright.audit.config.ts dv-org-gaps.spec.ts
```

Writes `artifacts/org-gaps-evidence.json` (the 3-part rollup) + screenshots
`org-gaps-isolation-alpha.png`, `org-gaps-isolation-beta.png`,
`org-gaps-pii-masked.png`, `org-gaps-pii-revealed.png`,
`org-gaps-archive-dialog.png`.

## (a) Org-switcher / cross-tenant isolation

| ID        | Sev                | Axis       | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Status             |
| --------- | ------------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| DV-ORG-12 | INFO (design note) | ergonomics | **There is NO in-session org-switcher.** Confirmed from source: `topbar.tsx` renders `organization.name` as a **static label** (no dropdown); `sidebar.tsx` has no org control. An org user (`getMe()`) is bound to **one** org; "switching Alpha↔Beta" = a **separate login** (`manager@alpha.dev` vs `manager@beta.dev`). The INVENTORY listed an org-switcher as a surface-to-verify — it does not exist. Isolation is therefore enforced by **separate accounts + RLS**, not a switcher. The spec records `isolation.hasOrgSwitcherUi` (expected `false`). NOT a defect — log so the INVENTORY row is marked "not user-reachable / N/A". | static-confirmed   |
| DV-ORG-13 | HIGH (if it fails) | security   | **Cross-tenant isolation** is instead verified by dual-context login: Alpha manager and Beta manager in separate `BrowserContext`s; their `/he/projects` and `/he/owners` rendered titles must be **DISJOINT**. Oracle = `isolation.overlap` and `isolation.ownerOverlap` must be **empty**. Any shared project title or owner name across orgs = an RLS/`withTenant` leak → HIGH.                                                                                                                                                                                                                                                           | behavioral PENDING |

## (b) Reveal-PII modal

| ID        | Sev                | Axis           | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Status             |
| --------- | ------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| DV-ORG-14 | HIGH (if it fails) | security/audit | On owner `דנה כהן` detail: national_id/phone must be **MASKED before** any click (no 9-digit cleartext in the DOM), and cleartext appears **only after** clicking "הצג נתונים גלויים", which fires `POST /owners/:id/reveal-pii` (BE-audited `owner.pii_revealed`, per `owner-pii-reveal.tsx`). The spec captures: `revealPii.maskedBefore` (asserts no `\d{9}`), `revealPii.revealRequest` (the POST + 2xx = the implied audit row), `revealPii.cleartextDiffersFromMask`. A visible 9-digit id BEFORE the click, or a reveal with no POST, = leak/missing-audit → HIGH. | behavioral PENDING |

> NOTE on audit-row verification: the DV-PLAN §11 wants the **actual audit row**
> read, not just the UI. The reveal POST returning 2xx is the _implied_ evidence
> here; a follow-up adversarial/DB pass should confirm an `owner.pii_revealed`
> row lands (the investigator is FE-only). The POST request capture is the
> strongest FE-reachable proxy.

## (c) Confirm-archive modal

| ID        | Sev               | Axis           | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Status             |
| --------- | ----------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| DV-ORG-15 | MED (if it fails) | error-handling | Archive must be **two-step** (open a confirm `[role=dialog]`/`alertdialog`, never one-click destroy). The spec finds the archive trigger ("ארכוב"/"העבר לארכיון") on owner detail, opens it, screenshots the dialog, then **CANCELS** (seed data preserved). Oracle: `archiveModal.dialogOpened === true` and `archiveModal.networkAfterCancel` contains **no archive mutation** after cancel. If the trigger destroys without confirmation, or cancel still fires a mutation, → MED. If no archive trigger is present on owner detail, that is recorded (not a failure — archive may live elsewhere; widen in a follow-up). | behavioral PENDING |

## Verdict (pending behavioral run)

- **Org-switcher**: does not exist by design (DV-ORG-12) — isolation is by account
  - RLS, to be CONFIRMED disjoint by the dual-login check (DV-ORG-13).
- **Reveal-PII**: masked-by-default + POST-on-reveal is the contract (DV-ORG-14);
  behavioral run confirms no pre-reveal cleartext + the audited POST.
- **Confirm-archive**: expected two-step with a cancellable dialog (DV-ORG-15).
