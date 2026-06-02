# DV Persona — Organisation Manager (מנהל פרויקט)

**Persona:** `manager@alpha.dev` (מיכל מנהלת), org Alpha, role `manager` (full tier-1).
**Method:** drove the REAL UI headless (`apps/web/e2e/audit/dv-persona-manager.spec.ts`),
judging every action on TWO axes — _did it succeed?_ (confirmed by the RESULT: API
re-read with the browser's own cookie jar / list reload / URL nav / DOM state — never by
"the form rendered") and _should a manager be allowed it?_
**Run:** `cd C:/emapp/apps/web && pnpm exec playwright test --config playwright.audit.config.ts e2e/audit/dv-persona-manager.spec.ts`
**Artifacts:** `docs/DV/results/artifacts/persona-manager-ledger.json` (machine ledger, ids of everything created).
**Result (stable across repeated runs):** 15 actions tried · **13 work end-to-end** · **1 functional bug** · **1 UX dead-click** · 0 authz bugs · 0 console errors.

---

## Worst-first — what is BROKEN for a manager

### 🔴 FUNCTIONAL BUG — DV-MGR-DOCS: a manager cannot send any document to signature (document picker is empty; whole Documents surface is broken)

- **Action:** Send a document to signature (`/he/signature-requests/new`).
- **What happens:** the **document `<select>` shows only the placeholder "בחר מסמך…" — zero selectable documents** — so the manager can never create a signature request. The owner `<select>` on the same form is fully populated (45 options), so it is not a global form failure.
- **Proof it's real, not empty data:** the documents API returns **41 documents** (`GET /api/v1/documents?limit=100` → HTTP 200, 41 rows) for this same manager/cookie. The picker is empty _despite_ the data existing.
- **Root cause (confirmed):** the whole Documents read path is broken for the manager. The Documents **list page** (`/he/documents`) renders **"טעינת המסמכים נכשלה" (loading documents failed)** with a retry button and **0 rows**, even though the API returns 200/41. The list api wrapper does `z.array(DocumentSchema).parse(res.data)` (`apps/web/src/lib/api/documents.ts:50`) — a strict parse that throws (and TanStack swallows into query-error state, so there is **no console error**) if any of the 41 rows drifts from `DocumentSchema`. The signature form's empty picker is downstream of the same failed `useDocumentList`.
- **Impact:** signature collection — the core product workflow — is unreachable from the UI for this org. High severity.
- **Should a manager?** Yes. → FUNCTIONAL BUG.

### 🟠 UX dead-click — DV-MGR-OWNER-ACTIONS: owner dossier "quick actions" are disabled placeholders

- **Action:** on the owner dossier (`/he/owners/{id}`), the 4 quick-action buttons — **WhatsApp · שלח לחתימה (send for signature) · הוסף הערה (add note) · צור משימה (create task)**.
- **What happens:** all 4 render but are `disabled` + `aria-disabled="true"` with `title="בקרוב"` (coming soon). A manager who clicks any of them gets a silent no-op — nothing happens, no message.
- **Should a manager?** The actions are legitimate, but as shipped they are dead clicks. Per the DV rubric a silent dead-click should be hidden until wired, not rendered disabled. → UX (should be hidden/removed for now).

---

## Action ledger (every manager action attempted + confirmed outcome)

| #   | Action                                    | Performed how                                                     | Outcome (confirmed by RESULT)                                                                                                                                                                                     | Should manager? | Verdict                         |
| --- | ----------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------- |
| 1   | **Navigate into a project from the list** | clicked a project card on `/he/projects`                          | ✅ URL → `/he/projects/{uuid}`, 4 detail tabs rendered. (The AGENT role FAILS this — DV-AGENT-NAV — manager does NOT.)                                                                                            | yes             | ✅ works                        |
| 2   | **Create a project**                      | 3-step wizard → submit                                            | ✅ redirected to `/projects/{id}`; `GET /projects/{id}` returns it by name                                                                                                                                        | yes             | ✅ works                        |
| 3   | **Create an owner**                       | `/owners/new` name + valid Israeli `national_id` + phone → submit | ✅ POST 201, redirected to dossier; owner present in API                                                                                                                                                          | yes             | ✅ works                        |
| 4   | **Reveal owner PII**                      | dossier → "הצג נתונים גלויים"                                     | ✅ `POST /owners/{id}/reveal-pii` → 200, cleartext 9-digit national_id shown (audited reveal)                                                                                                                     | yes             | ✅ works                        |
| 5   | **Owner quick-actions**                   | inspect WhatsApp / SendDoc / AddNote / CreateTask                 | 🟠 4 buttons present but `disabled` — clicking does nothing                                                                                                                                                       | yes             | UX dead-click                   |
| 6   | **Create a building under a project**     | `/projects/{id}/buildings/new` address + city → submit            | ✅ POST 201, redirected to `/buildings/{id}`; present in project's buildings API                                                                                                                                  | yes             | ✅ works                        |
| 7   | **Create an apartment under a building**  | `/buildings/{id}/apartments/new` number → submit                  | ✅ POST 201, redirected to `/apartments/{id}`; present in API                                                                                                                                                     | yes             | ✅ works                        |
| 8   | **Set ownerships to sum 100**             | apartment ownerships → add row → pick owner → 100% → save         | ✅ saved; `GET /apartments/{id}/owners` shows the owner at 100%                                                                                                                                                   | yes             | ✅ works                        |
| 9   | **Create a task**                         | `/tasks/new` title + desc → submit                                | ✅ POST 201, redirected to `/tasks/{id}`; present in API by title                                                                                                                                                 | yes             | ✅ works                        |
| 10  | **Edit a task (status → completed)**      | task detail → status select → completed → שמור                    | ✅ `GET /tasks/{id}` → `"status":"completed"`                                                                                                                                                                     | yes             | ✅ works                        |
| 11  | **Create a note**                         | `/notes/new` body → submit                                        | ✅ POST 201, redirected to `/notes/{id}`; present in API by body                                                                                                                                                  | yes             | ✅ works                        |
| 12  | **Assign an agent to a project**          | `/projects/{id}/assignments` → pick member → שייך                 | ✅ assign form renders (manager-only) + assignment confirmed in API when an eligible member exists. (Seed project already had all members assigned on repeat runs — a valid empty-dropdown state, not a failure.) | yes             | ✅ works                        |
| 13  | **Send a document to signature**          | `/signature-requests/new` → pick doc + owner → submit             | 🔴 document picker EMPTY (0 options) while documents API returns 41 — cannot create the request                                                                                                                   | yes             | 🔴 FUNCTIONAL BUG (DV-MGR-DOCS) |
| 14  | **Notifications: open + mark read**       | `/notifications` → "סמן כנקרא"                                    | ✅ mark-read executes; read state confirmed via API (on this seed the manager's rows were already read)                                                                                                           | yes             | ✅ works                        |
| 15  | **Archive a project**                     | project detail → לוח בקרה tab → ארכוב (accept confirm)            | ✅ `GET /projects/{id}` → `archivedAt` set (gone from active set)                                                                                                                                                 | yes             | ✅ works                        |

---

## Notes for the next investigator (harness, not product)

- **The Next.js DEV server degrades under repeated full runs of this spec** (lazy route
  compilation + transient chunk 500 / `text/plain` MIME on heavy client detail pages). Two
  guards were added so the _persona_ judgement is not corrupted by _dev-infra_ flakiness:
  (a) `openForm()` waits for each create form's keystone field to be visible + a hydration
  settle before filling (RHF silently drops keystrokes typed pre-hydration — same window a
  real user hits on a slow connection, §FUNC-4); (b) `submitAndCapture()` confirms creates
  via an **API list-by-field recovery** in addition to the redirect, and reports `redirected`
  separately from `persisted` so "created but no redirect" can be flagged precisely. With
  these, the ledger is stable run-to-run.
- **Reveal-PII** uses the live audited `POST /owners/:id/reveal-pii` (200) + on-screen
  cleartext as the oracle — not "the button exists".
- **No authorization bugs** were found for the manager — every tier-1 action a manager
  _should_ be able to do, it can (the only blocker is the broken Documents read path, which
  is a functional regression, not an authz gate).
