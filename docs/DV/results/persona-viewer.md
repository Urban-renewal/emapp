# DV Persona — Viewer (צופה), the read-only Tier-1 org user

**Persona:** `viewer@alpha.dev` (ויקי צופה), org Alpha, role `viewer` (Tier-1, READ-ONLY per D.17 / `policy.ts`).
**Capabilities:** none — viewer is read-only by definition. Reads succeed (PII masked); every write must 403.
**Method:** drove the REAL UI headless (`apps/web/e2e/audit/dv-persona-viewer.spec.ts`), judging every action on
TWO axes — _did it SUCCEED?_ (confirmed by the RESULT: API re-read with the browser's own cookie jar, list
reload, URL nav, or DOM state — never "the page rendered") and _SHOULD a viewer be allowed it?_ (viewer = read-only).
**Run:** `cd C:/emapp/apps/web && pnpm exec playwright test --config playwright.audit.config.ts e2e/audit/dv-persona-viewer.spec.ts`
**Artifact:** `docs/DV/results/artifacts/persona-viewer-ledger.json` (machine ledger).
**Result (stable across 2 full spec runs + the pre-flight API ground-truth pass, each write reproduced ≥2× in-run):**
29 actions · **6 reads work** · **0 functional bugs** · **0 AUTHZ bugs** · **22 correctly-blocked** ·
**1 UX dead-control (create-project wizard renders for a viewer)** · **console errors: 0**.

---

## HEADLINE — did ANY viewer write actually succeed? **NO. Zero. Per control.**

`anyViewerWriteSucceeded = false`. Twenty distinct write actions were PERFORMED through the browser with the
viewer's own cookie jar (the same call each form makes), each reproduced **twice in-run** and again in the
pre-flight API pass. **Every single one was blocked by the BE with HTTP 403 and NOTHING persisted.** The
strongest oracle: **project count 13 → 13 unchanged** across the entire 20-write barrage.

| #   | Write action (Hebrew CTA)                      | call                                   | status (×2) | mutated?                          | verdict       |
| --- | ---------------------------------------------- | -------------------------------------- | ----------- | --------------------------------- | ------------- |
| B1  | Create project (צור פרויקט)                    | `POST /projects`                       | 403,403     | no                                | ✅ blocked_ok |
| B2  | Archive project (ארכוב)                        | `DELETE /projects/{id}`                | 403,403     | no                                | ✅ blocked_ok |
| B3  | Edit project (ערוך)                            | `PATCH /projects/{id}`                 | 403,403     | no                                | ✅ blocked_ok |
| B4  | Edit building                                  | `PATCH /buildings/{id}`                | 403,403     | no                                | ✅ blocked_ok |
| B5  | Create apartment (הוספת דירה)                  | `POST /buildings/{id}/apartments`      | 403,403     | no                                | ✅ blocked_ok |
| B6  | Edit apartment                                 | `PATCH /apartments/{id}`               | 403,403     | no                                | ✅ blocked_ok |
| B7  | Delete apartment                               | `DELETE /apartments/{id}`              | 403,403     | no                                | ✅ blocked_ok |
| B8  | Assign owner to apartment                      | `PUT /apartments/{id}/ownerships`      | 403,403     | no                                | ✅ blocked_ok |
| B9  | Create owner (הוספת בעל דירה)                  | `POST /owners`                         | 403,403     | no                                | ✅ blocked_ok |
| B10 | Edit owner                                     | `PATCH /owners/{id}`                   | 403,403     | no                                | ✅ blocked_ok |
| B11 | Delete owner                                   | `DELETE /owners/{id}`                  | 403,403     | no                                | ✅ blocked_ok |
| B12 | **Reveal owner PII (הצג נתונים)**              | `POST /owners/{id}/reveal-pii`         | 403,403     | no — **no cleartext national_id** | ✅ blocked_ok |
| B13 | Create task (צור משימה)                        | `POST /tasks`                          | 403,403     | no                                | ✅ blocked_ok |
| B14 | Create note (צור הערה)                         | `POST /notes`                          | 403,403     | no                                | ✅ blocked_ok |
| B15 | Create signature request (צור בקשה)            | `POST /signature-requests`             | 403,403     | no                                | ✅ blocked_ok |
| B16 | **Sign / cancel the sigreq (the "חתום" seam)** | `POST /signature-requests/{id}/cancel` | 403,403     | no                                | ✅ blocked_ok |
| B17 | Add contractor share (הוספת קבלן)              | `POST /projects/{id}/shares`           | 403,403     | no                                | ✅ blocked_ok |
| B18 | Create contractor                              | `POST /contractors`                    | 403,403     | no                                | ✅ blocked_ok |
| B19 | Create document (העלאת מסמך)                   | `POST /documents`                      | 403,403     | no                                | ✅ blocked_ok |
| B20 | Create import (העלאת קובץ)                     | `POST /imports`                        | 403,403     | no                                | ✅ blocked_ok |
| —   | **No-mutation invariant**                      | `GET /projects` before vs after        | 13 → 13     | **no**                            | ✅ blocked_ok |

### On the "חתום" (sign) button specifically (the DV-ORG-9 concern)

There is **no authenticated in-org `/sign` route** — signature execution for residents goes through the
**public token** controller (`POST /public-sign/:token`), not an org-user endpoint. The closest in-org
signature mutation a viewer's UI exposes is `POST /signature-requests/{id}/cancel`, which **403s for the
viewer**. So the "חתום" controls on the sigreq list are a **UX seam only** — there is no viewer-reachable
authenticated sign endpoint to abuse, and the manage/cancel seam is BE-blocked.

---

## READS — a viewer SHOULD see everything in-org (PII masked). All ✅.

| action                           | result                                               | should-viewer | verdict       |
| -------------------------------- | ---------------------------------------------------- | ------------- | ------------- |
| A1 · projects list               | 13 projects (full org scope), list rendered          | yes           | ✅ works      |
| A2 · open a project detail       | 4-tab detail rendered (`h1` = project name)          | yes           | ✅ works      |
| A3 · owners list — PII fidelity  | `national_id` MASKED (`•••••••51`), **no cleartext** | yes           | ✅ works      |
| A4 · tasks list                  | `GET /tasks` 200, rendered                           | yes           | ✅ works      |
| A5 · signature-requests list     | `GET /signature-requests` 200, rendered              | yes           | ✅ works      |
| A6 · members + audit             | `GET /members` 403 · `GET /audit` 403 (manager-only) | no            | ✅ blocked_ok |
| C1 · mark own notifications read | `POST /notifications/read-all` 200 ×2                | yes           | ✅ works      |

**C1 nuance — NOT a bug.** `POST /notifications/read-all` returns 200 for the viewer. This is the ONE write
that succeeds, and it is **by design correct**: the route is annotated `@AuthzAction('update')` with the
in-code rationale _"mark-read is a self update, allowed to any role"_ and is **RLS self-scoped to
`app.user_id`** — it touches the viewer's OWN notification state, never org data. A read-only role managing
its own inbox is legitimate least-privilege behaviour, so it scores **should-viewer = yes → ✅ works**, not an
authz hole.

---

## UX — controls shown to a read-only role that dead-end in 403 (🟠 cosmetic, NOT security)

The viewer UI renders write affordances it can never use; clicking them produces a BE 403 / `loadFailed` UI.
This is a **UX wart and a polish-debt item, not a security defect** — the BE is the authority and it blocks
every one (proven above).

- **🟠 D1 (confirmed in-browser, stable): the create-project wizard `/he/projects/new` fully RENDERS for a
  viewer** (form + inputs + submit). Submitting dead-ends in the B1 403. A read-only user should be
  redirected / shown a no-access state, not handed a create form.
- **Browser-confirmed dead create links** (caught by the spec's control counter, run-to-run): `link:/projects/new`,
  `link:/owners/new`, `link:/tasks/new` on the respective list pages.
- The spec's verb/`/new`-link counter is a **lower bound** (3–5 controls/run) — it matches `<Link …/new>` and
  exact Hebrew verb buttons but misses icon-only and `<Link>`-wrapped row CTAs. The **full inventory is already
  quantified by DV-ORG-9: ~30 mutating controls across 12 surfaces** (צור פרויקט / ארכוב / ערוך / הוספת בעל
  דירה / צור בקשה / חתום / הוספת קבלן / צור משימה / צור הערה). This run **does not re-enumerate** that count —
  it confirms that **every one of those surfaces' writes is BE-blocked**, so the entire inventory is a UX leak,
  zero of it a security leak.

**Quantified UX damage:** ~30 dead write controls (per DV-ORG-9) across 12 surfaces are shown to a role that
can use none of them — the worst single offender being the create-project wizard, which renders a full
interactive form behind a guaranteed 403.

---

## MISSING / recommendations

- **FE write-gating for the viewer is absent by design** (per `j9-viewer-readonly.spec.ts`: only the sidebar
  Members/Audit nav is cosmetically hidden; per-page create buttons are "Phase 8 polish"). The BE is the sole
  enforcement layer and it holds — but the viewer experience is misleading. Recommend gating create CTAs +
  redirecting `/*/new` routes for read-only roles (capability-driven, mirroring the sidebar gate).
- **No console errors** were produced by the legitimate reads; the only 4xx noise is the deliberate
  forbidden-write probes (expected).

## Verdict

**SECURITY: clean.** Not a single viewer write mutated org data — 20/20 writes 403-blocked, PII reveal denied,
sign/cancel seam blocked, project-count invariant held (13→13), reproduced ≥2×. The only 200 write
(`notifications/read-all`) is self-scoped and correct. **UX: ~30 dead write controls** are shown to the
read-only role across 12 surfaces (full inventory per DV-ORG-9); the cleanest confirmed instance is the
**create-project wizard rendering in full for a viewer**. Fixing this is FE polish, not a security fix.
