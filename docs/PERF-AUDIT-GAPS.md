# Perf-Audit Completeness Verification — GAPS (independent check)

The background agent covered **82 distinct actions across 5 roles** (manager,
agent, viewer, provider, tenant) + the public sign preview. Cross-checked
against `docs/PERF-AUDIT-INVENTORY.md` (105 actions), these are **NOT yet
covered** — the closing pass must exercise each (or justify N/A) until MISSING=0.

## Entirely-missing role
- **CONTRACTOR portal** (role #6): token exchange `/share/:token` → set cookie →
  `/contractor/share` page → view project (`GET /contractor/project`,
  `/progress`, `/documents`) → download doc. Agent did only the MANAGER side
  (create/list contractor, regenerate token). **0 contractor-role coverage.**

## Missing mutations / sub-flows (by area)
- **Auth/session:** logout; forgot-password (page+POST); reset-password;
  accept-invite. (signup disabled / silent-refresh automatic → mark N/A w/ note.)
- **Projects:** archive project.
- **Apartments:** get apartment (detail page); inspect tabu extraction (confirm).
- **Ownership:** list ownerships (per apartment); archive owner; revoke ownership.
- **Documents:** upload-to-R2/content path; finalize; VIEW (inline); DOWNLOAD
  (attachment); archive document. (owner reported these slow — MUST measure.)
- **Signatures:** resend; cancel; public SUBMIT (`POST /sign/:token`); signed
  confirmation. (owner named "send signatures" — cover the full lifecycle.)
- **Imports:** upload-to-R2; start; status; SSE stream; submit mapping; list
  errors. (owner named "import file" — cover the whole pipeline, not just create.)
- **Messaging:** list messages in conversation; mark read.
- **Members/IAM:** invite; get member; update role; apply preset; set override;
  clear override; resend invite; remove member.
- **Tasks/notes:** get task; update task; get note; update note; delete note.
- **Notifications:** mark notification read; notification deep-link nav.
- **Contractors:** get contractor (detail).
- **Provider:** disable/enable tenant user; force-recheck health.

## Completion gate
Closing pass must end with a printed `COVERED x / EXPECTED y` and an explicit
empty MISSING list — every item above either measured (timing + PASS/FAIL) or
marked N/A with a one-line reason. The contractor portal role must appear in
the results.
