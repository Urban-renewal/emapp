# Documents layer remediation — "catastrophe" → north-star bar

Owner 2026-06-23: clicked the document buttons, "complete mess" — fails situation-picture-at-a-glance,
order/organization at high scale, and autonomous-manages-in-one-action. Three read-only audits
(board/scale · detail/interactions · upload/checklist/autonomy) converged on ONE root cause:

**The documents layer copied the north-star's LOOK but not its DATA MODEL, and leaves built
primitives/facts unrendered.** Evidence:

- **Board** (`documents-list.client.tsx`): counts, gists, search, and the whole party zoom-in derive
  from ONE 25-doc keyset page (L105/131/145-160) while only completeness badges are server-side →
  counts lie, paginating reshuffles the board, a party with >25 docs is silently truncated. ZERO
  actions on the surface (pure navigator). Only axis = party; the project axis (a multi-project
  manager's mental model) is absent. Search filters only the loaded 25 (a real `GET /documents/search`
  exists, unwired).
- **Detail** (`documents/[id]/page.tsx`): wire `DocumentSchema` omits `sensitive`/`scanStatus`/parent
  names → near-blank card; View/Download succeed with ZERO on-page feedback ("fired but shows
  nothing"); archived doc = dead-end (all buttons vanish, no restore). Security gating itself: PASS.
- **Project docs tab** (`project-detail.client.tsx:286`): the per-project checklist is fully built
  (`GET /projects/:id/document-checklist` + `useDocumentChecklist` hook + adapter + VM) but the tab is
  a hardcoded empty placeholder that bounces out to `/documents`. DEAD CODE.
- **Upload** (`documents/new`): blind 19-option type dropdown; BE classifier (`POST /documents/classify`)
  - dedup probe exist, FE never calls them; both upload paths hardcode `type:'agreement'` (mislabels);
    global upload creates project-orphan docs; checklist not invalidated on upload.
- **Autonomy:** NO document proposal kind exists (only signature_request.reissue + reminder.send) — no
  "system proposes the missing doc → confirm in one click."

## Collision-free build order (owner's hard condition: NO collisions)

Many slices share files (`document.ts`, `documents.service.ts`, `use-documents.ts`, `document.vm.ts`,
adapter). So partition by FILE-OWNERSHIP, not by audit: shared foundation FIRST (one owner), then
disjoint UI components in parallel.

**PHASE 1 — Foundation (ONE builder, serial; security-sensitive → G-RT). The shared contract + data layer.**
Files: `packages/shared-types/src/document.ts` (+ `sensitive`, `scanStatus`, resolved `projectName`/
`apartmentName` on the doc read shape; per-party `total`/`latestCreatedAt`/`latestType` on
BoardCompleteness/new board-summary; `party`/doc_type filter on DocumentSearchQuery) ·
`apps/api/.../documents.service.ts` + controller (project the new cols + resolve parent names; server
board-summary counts; party-scoped search — same PII envelope: counts/keys only, no PII widening) ·
`apps/web/src/lib/api/documents.ts` + `hooks/use-documents.ts` + `use-documents.keys.ts` (board-summary
hook, `useDocumentSearch`, checklist invalidation on upload) · `adapters/document.ts` +
`models/document.vm.ts` (surface new fields). ONE PR. Unblocks all of Phase 2.

**PHASE 2 — UI (parallel; each owns a DISJOINT component; all consume Phase 1; worktree-isolated). he.json/en.json additive-only per distinct namespace; merge sequentially.**

- 2a **Board rewrite** — `documents-list.client.tsx`: server-backed counts, rank unmet-first, view toggle
  `לפי גורם | לפי פרויקט | כל המסמכים` (mirror the signatures 3-tier board + reuse `board-primitives`/
  `DataState`), server search, server-paginated zoom-in, one-click "העלה {missing}" deep-link + per-row
  download/archive.
- 2b **Detail legibility** — `documents/[id]/page.tsx`: metadata block (sensitive badge, scan indicator,
  parent link), `role="status"` success line for View/Download + popup-blocked detection, archived
  download/restore affordance.
- 2c **Project docs tab** — `project-detail.client.tsx` + new `_components/project-document-checklist.tsx`:
  render `useDocumentChecklist` (present/missing per type + completion%), the project's own docs, upload.
- 2d **Upload guidance** — `documents/new/page.tsx` + `project-document-upload.tsx`: call classifier on
  file-pick (pre-select type) + dedup-check (offer link-to-existing); project picker; drop hardcoded
  `agreement`; accept `?type=&party=` deep-link; route back to project + toast new completeness.

**PHASE 3 — Document autonomy (serial; spans jobs+api+FE; G-RT). The one-click chase.**
`packages/jobs/src/autonomy-policy.ts` (new `document.request`/`document.chase` kind, outbound/
human-confirm, NEVER auto-execute) → `proposals.service.ts` executor → watcher emitting one deduped
proposal per (project, missing required doc) from the checklist `missingTypes` → surfaces in the
existing Approval Inbox.

## Gates per slice (never lowered)

Each PR: G-RT (every security-sensitive change, esp. Phase 1 PII envelope + Phase 3) + real-Chrome walk
(the 5 G-QA axes + OUTCOME + LEGIBILITY + SCALE-READY, AS the role) before merge. Phase-2 builders are
code-green only; the owner-standard real-Chrome walk + red-team loop-until-closed is the orchestrator's.
Coarser PRs where cohesive (couple a contract + its consumer) per the fewer-PRs rule.
