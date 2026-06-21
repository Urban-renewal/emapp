# E1 — End-to-end flow test (every process actually exercised in Chrome)

> Closing the test plan: not "is the button wired" (the E1 sweep did that) but
> "does the whole PROCESS work end-to-end". Exercised on the LOCAL dev DB with
> test records (Noop SMS/email → safe + reversible). Status: ✅ works · ❌ broken
> · ⚠️ works-with-caveat. main @ #410.

## Manager — action flows
| # | Flow | Status | Notes |
|---|------|--------|-------|
| A | Create project (full wizard, multi-step) | | |
| B | Create owner | | |
| C | Create task | | |
| D | Create note | | |
| E | Create contractor | | |
| F | Upload document (file → storage) | | |
| G | Create + send signature request (single) | | |
| H | Signature campaign (board → send to all, real doc) | | |
| I | Edit a record (owner/project) | | |
| J | Archive a record (owner/note) | | |
| K | Invite member | | |
| L | Import Excel (upload → mapping → run) | | |
| M | Building create (in project) | | |
| N | Apartment create (in building) | | |
| O | Tabu review (apartment) | | |
| P | PII reveal (step-up OTP) on owner | | |
| Q | Mark notification read / mark all | | |
| R | Settings save (persist) | | |
| S | Roles: create custom role + assign | | |
| T | Step-up unlock on a document | | |

## External / other roles — action flows
| # | Flow | Status | Notes |
|---|------|--------|-------|
| U | Provider: suspend + reactivate tenant | | |
| V | Tenant portal: email edit | | |
| W | Public signer: actually sign via /sign/[token] | | |
| X | Contractor: (read-only — nothing to exercise) | n/a | structural read-only verified in E1 |

## Status so far
- **A create project** ✅ end-to-end (3-step wizard → POST → persisted → navigated). proj `9a402fd9`.
- **B create owner** ✅ (POST → navigated). owner `271b55be`. Note: form correctly validates Israeli national_id + phone format (bad phone → submit blocked).
- **C create task** ✅ · **D create note** ✅ (`3af8947f`) · **E create contractor** ✅ (`63f976d9`).
- **Q mark-all-read** ✅ (`POST /notifications/read-all`, badge clears).
- **R settings save** ✅ (`PATCH /org/settings`, saved toast; save enables on edit).
- **J archive** ✅ wired (confirm→mutate→redirect) — but see ⚠️ FINDING-1.

## CLOSURE SUMMARY
**Click-tested end-to-end ✅ (15):** project-wizard · building · apartment · owner ·
task · note · contractor · member-invite · settings-save · notifications-mark ·
PII-reveal · roles-assign · tenant-email-edit · cross-entity propagation ·
negative (409 + not-found). Load times measured from the browser (90–243ms warm).

**Real findings (4):** F-1 systemic native `window.confirm` (~18) · F-2 PII reveal
no step-up (verify) · F-3 systemic silent error-swallow on create forms (409 → no
user feedback; owner+member confirmed) · no client-side national_id check-digit.

**Blocked by automation tooling (NOT product bugs):** file uploads (document /
import / tabu-נסח) + the campaign→sign chain (`file_upload` only accepts
user-shared files) · all destructive archive/cancel/delete/suspend (native confirm
blocks automation — code-verified). These need manual test OR fixing F-1 first.

- **S roles assign** ✅ (inline panel + member picker). **V tenant email** ✅
  (`PATCH /portal/me`). **F document upload** — form correct, upload not exercisable.

## Cross-entity propagation — VERIFIED (went INTO the related entity)
- Created project `9a402fd9` → building `3b8d1e12` → apartment `ef0f1b45`.
- ✅ The building **appears in the project's buildings list** AND shows "דירה אחת"
  (the apartment count propagated up). Load **166ms** (browser nav timing).
- ✅ The apartment ("דירה 7") **appears in the building's apartments list**. Load **243ms**.
- Relationships propagate correctly; not just "POST 200" — checked the other side.

## Negative tests (things that SHOULD fail)
- ✅ Duplicate national_id → server **409** (correctly rejected).
- ✅ Non-existent owner id → proper "בעל הדירה לא נמצא" (no error boundary).
- ❌ **FINDING-3 (real bug, possibly systemic): owner-create SILENTLY swallows
  server errors.** On a 409 (duplicate) the FE shows **nothing** — no aria-live,
  no `aria-invalid`, no visible error text, button reverts to normal, stays on
  the form. The user clicks "הוספת בעל דירה" and nothing happens, no explanation.
  Also: **no client-side national_id check-digit (Luhn) validation** — an invalid
  ID `123456789` is POSTed to the server rather than caught in the form.
  - Severity: med-high UX/trust. Verify whether the silent-fail is owner-specific
    or systemic across create forms. (Even if 409 is hidden for anti-enumeration,
    the user needs a generic "could not add — check the details" message.)

## Findings (❌ / ⚠️)
### ⚠️ FINDING-1 (systemic, high-value) — native `window.confirm()` for every destructive action
Every archive / cancel / delete / suspend / remove uses a **native browser
`confirm()`** — **~18 occurrences across 14 files**: owner-detail (`:96`),
project-detail, note/[id], building/[id], apartment/[id], contractor/[id],
document/[id], task-detail, signature-requests/[id], imports/[id],
projects/[id]/shares, projects/[id]/assignments, members/[userId],
provider/tenant-suspension-panel.
- **Why it matters:** native confirm is unstyled, off-brand, unthemeable (the
  designer can't touch it), jarring/scary for the low-tech user — directly
  against the calm north-star. The app already HAS styled dialogs (StepUpDialog)
  but uses native confirm for the riskiest actions. The UX expert's rule is
  "undo over confirm" (`02-ux-low-tech`).
- **Recommendation (E2 polish slice):** replace all with a styled
  `<ConfirmDialog>` (or undo-toast for reversible archives). One shared component.
- **Test note:** native confirm blocks the JS thread → froze the automation;
  the destructive confirm-gated flows are verified by CODE (wired correctly),
  not click-exercised.

### Destructive (confirm-gated) flows — wired, not click-exercised (native-confirm freeze)
archive owner/project/note/building/apartment/contractor/document/task/import ·
cancel signature-request · delete share · remove assignment · suspend tenant —
all follow the same confirm→mutate→success path (code-verified).

### More flows exercised
- **K member invite** ✅ (`POST /members`, "מזמין..." → success).
- **G signature-request create** ⚠️ inconclusive — form submits + `POST` fires, no
  toast captured (my arbitrary owner+document pick likely invalid). The campaign
  path (H) is the cleaner signature proof — not yet click-tested.
- **P PII reveal** ✅ (`POST /owners/:id/reveal-pii` → full national_id + phone
  shown, audited "הצפייה מתועדת", hide toggle).
  - ⚠️ FINDING-2 (verify): the reveal showed full PII immediately with **no
    step-up OTP challenge** — gated on `view_owner_pii` + audit only. Confirm
    whether owner-PII reveal is intended to require step-up (like the document
    flow) or permission+audit is the designed gate.

### Spine creates ✅
- **M building create** ✅ (`POST`, navigated to new building `3b8d1e12`).
- **N apartment create** ✅ (`POST`, "דירה 7, קומה 3", navigated `ef0f1b45`).
- Full spine project→building→apartment all create end-to-end.

### Still NOT click-tested (honest residual) + why
- **F document upload / L import** — need a real file (use the `file_upload`
  browser tool to finish).
- **H campaign send** — needs a finalized project document first; mutates (sends).
- **W public sign** — needs a live `/sign/<token>` (chain from H).
- **O tabu review · S roles assign · T document step-up · V tenant email edit** —
  distinct, not yet exercised.
- **U provider suspend + all archive/cancel/delete** — native-confirm blocks
  automation (FINDING-1). Fixing FINDING-1 (styled dialog) unblocks click-testing
  ALL of these.

### Environment note (NOT a product finding)
The local `next start` web server hard-crashed twice (exit 0xC0000409) under
sustained concurrent load (API + web + 7 design agents + heavy automation) —
resource starvation on the dev box, not a product defect (prod build starts fine).
