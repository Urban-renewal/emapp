# 02 — Interactions Coverage Audit (writes / mutations / forms / dialogs / buttons)

> Dimension: **every write/interaction** — mutation hooks, forms, submit/action
> buttons, confirm/step-up dialogs, toggles, filters, the import wizard, campaign
> send, sign, suspend/reactivate, archive, status updates, share links.
>
> Method: enumerated the REAL code via Glob/grep (`apps/web/src/hooks/use-*.ts` →
> every `useMutation`; every `<form>`; every `window.confirm`; every
> `ConfirmDialog`/`StepUpDialog` usage) and cross-checked each against the v2 plan
> (`00-MASTER-PLAN-V2.md` + `06-interaction-motion.md` primarily). Skeptical pass:
> the plan's own inventory was treated as a claim to verify, not ground truth.
>
> **48 mutation hooks + ~40 interactive form/dialog surfaces inventoried.**

---

## GAP SUMMARY (ranked by impact on the one-shot-implementation goal)

The plan's interaction work (doc 06 + master C0–C8/M0–M6) is genuinely deep on the
**chase loop, ActionToast primitive, optimistic signature mutations, and motion
tokens**. But it scopes its migration/feedback work around a **handful of named
sites** and an under-counted confirm inventory. The following are real GAPs that
will surface mid-implementation if not folded in now:

1. **G1 — The `window.confirm` inventory is WRONG by ~17×, and the migration slice
   doesn't enumerate them.** Doc 06 §2.1/§7-D5 and the `ConfirmDialog` header claim
   it "replaced ~18 native-confirm call-sites." **Reality: 17 live `window.confirm`
   call-sites remain in production code** (archive apartment/building/contractor/
   document/note/owner/project/task, cancel import, cancel signature-request, revoke
   member, revoke share, unassign assignment, remove task-assignee, reactivate
   tenant). The plan's §2.1 decision table says "archive → optimistic + undo toast,
   NOT confirm" but **M0/M5 only name campaign + tabu-review + suspension panel for
   migration.** The 8 archive flows + cancel/revoke/unassign confirms — the literal
   bulk of the "confirm trains this user to fear his clicks" anti-pattern (doc 02
   §2.5) — are **not in any slice's file list.** A one-shot build will leave ~14
   native `window.confirm()` dialogs intact, contradicting the plan's own doctrine.
   Cite: `apartments/[id]/page.tsx:86`, `buildings/[id]/page.tsx:42`,
   `contractors/[id]/page.tsx:49`, `documents/[id]/page.tsx:119`,
   `notes/[id]/page.tsx:120`, `owners/[id]/owner-detail.client.tsx:96`,
   `projects/[id]/project-detail.client.tsx:100`,
   `tasks/[id]/task-detail.client.tsx:150,172`, `imports/[id]/page.tsx:75`,
   `signature-requests/[id]/page.tsx:114`, `members/[userId]/page.tsx:125`,
   `projects/[id]/shares/page.tsx:99`, `projects/[id]/assignments/page.tsx:147`,
   `provider/tenant-suspension-panel.tsx:72`.

2. **G2 — The non-dismissing inline-"toast" / "saved" migration is under-counted.**
   Doc 06 §2.3 names "~4 bespoke call-sites" (campaign, tabu-review, suspension).
   The REAL count of lingering `role="status"`/`role="alert"`/`saved`-flag feedback
   lines is **at least 11 more**: all 6 settings config forms
   (`branding/consent/limits/localization/notifications-config.tsx` each render a
   non-dismissing `{t('saved')}` + `role="alert"` error), the role-editor inline
   error (`role-editor.tsx:81`), member-capabilities-panel `savedOk`
   (`member-capabilities-panel.tsx:259`), owner-pii-reveal inline error, the
   messages error line, and the portal contact/resend feedback. The plan's M0
   migration list doesn't reach them → a one-shot pass ships ActionToast but leaves
   ~11 hand-rolled feedback lines using the old idiom (double-announce + lingering
   bug the plan set out to kill).

3. **G3 — Eight whole settings/admin config forms have ZERO interaction-redesign
   coverage.** `settings/_components/{branding,consent,limits,localization,
   notifications}-config.tsx`, `roles/_components/role-editor.tsx`,
   `members/member-capabilities-panel.tsx`, `members/member-overrides-panel.tsx`.
   The master plan demotes `/settings`+`/members` to the "Admin" group (§2.2) but
   **no slice addresses their form interaction/feedback/optimistic/error handling**.
   They carry the same non-dismissing-saved papercut AND hardcoded color leaks
   (`text-emerald-700`, `bg-emerald-100/text-emerald-800`, `bg-red-100/text-red-800`
   in `member-*-panel.tsx`) that the token-leak sweep (§3.5) scoped to adapters but
   not these panels. Manager + Provider-Admin hit these daily; left untouched, they
   are visibly "old app."

4. **G4 — The messages / conversations surface (send, create, mark-read) is
   interaction-invisible to the plan.** `useSendMessage`, `useCreateConversation`,
   `useMarkConversationRead` (`use-conversations.ts`). `messages/page.tsx` is a live
   chat surface (it's even cited as "live conversations panel" in doc 06 §4) yet has
   NO optimistic send (it restores draft on failure via try/catch, no optimistic
   bubble), NO toast, and a bare `role="alert"` error line. No slice plans its
   send/feedback interaction. For a "movie not photo" redesign this is the most
   real-time-feeling surface and it's unaddressed.

5. **G5 — Owner/apartment PII reveal (`useRevealOwnerPii`) interaction is half-
   covered.** The StepUp a11y retrofit (M6) covers the *document* step-up dialog, but
   `owner-pii-reveal.tsx` reveals PII via a plain button + inline `setError`, NOT
   `StepUpDialog` — it has no step-up gate at all on the owner surface. Doc 06's
   decision table §2.1 says "PII reveal → StepUpDialog (already correct flow)" — that
   is TRUE for documents but FALSE for owners. The plan assumes one consistent
   step-up reveal flow; there are two divergent ones. Reconcile before build.

6. **G6 — Toggles/filters interaction unscoped.** Member capability toggles
   (`useUpdateMemberCapabilities`, `useApplyCapabilityPreset`), override grant/deny
   toggles (`useSetMemberOverride`/`useClearMemberOverride`), and every list filter
   (owners archived toggle, list `q`/cursor filters). Master C6 ("scale-at-N / sort
   by expiring-soonest") covers list TRIAGE sort, but the per-row/per-toggle
   interaction feedback (optimistic toggle, undo) is not specified. These are writes
   with no optimistic/undo plan.

7. **G7 — Parcel-setup & tabu-extraction multi-step write flows partially covered.**
   `useCreateParcelSetup`/`useSaveParcelSetupPayload`/`useConfirmParcelSetup` and
   `useCreateTabuExtraction`/`useRunTabuExtraction` are confirm-gated multi-step
   flows (`parcel-setup-section.tsx` uses ConfirmDialog; `tabu-review-section.tsx`
   uses the inline-status idiom). C8 covers the *import* approve/confirm pause as the
   precedent but doesn't extend that "approve, don't construct" idiom to the
   parcel/tabu confirm flows, which are the same shape. Left inconsistent.

8. **G8 — Provider onboard-org wizard + audit filter forms unscoped.**
   `useOnboardOrg` (`provider/onboard/page.tsx` form) creates a whole tenant org;
   `provider/audit` + `audit/self` are filter forms. No slice addresses the
   Provider-Admin write/feedback surface. (Lower impact — single role — but it's a
   real form with no plan.)

Everything else (the chase loop M2, ActionToast M0 core, optimistic signature
mutations §5, campaign confirm M5, motion tokens M1, StepUp-document a11y M6) is
**COVERED well**. The gaps are all **breadth gaps**: the plan picked exemplar sites
and the doctrine, but did not enumerate the full write surface — exactly the
"discover a missed screen mid-implementation" risk the owner wants closed.

---

## INVENTORY — Mutation hooks (every `useMutation`)

| Item | file:line | Purpose | Plan status | Note |
|---|---|---|---|---|
| useCreateApartment | use-apartments.ts:69 | create apartment | AS-IS-OK | create form; re-skin sweep covers visuals, interaction unchanged |
| useArchiveApartment | use-apartments.ts:79 | archive (soft) | GAP (G1) | `window.confirm` at apartments/[id]/page.tsx:86; plan §2.1 says undo-toast but no slice migrates it |
| useUpdateApartmentStatus | use-apartments.ts:97 | status flip | COVERED | the optimistic precedent (E.2); §5 extends it; the `prev` snapshot IS the undo |
| useCreateProjectAssignment | use-assignments.ts:62 | assign agent to project | GAP (G6) | assignments form; no interaction/feedback spec |
| useUnassignProjectAssignment | use-assignments.ts:75 | unassign | GAP (G1) | `window.confirm` at assignments/page.tsx:147; not in migration list |
| useCreateBuilding | use-buildings.ts:63 | create building | AS-IS-OK | create form |
| useArchiveBuilding | use-buildings.ts:73 | archive building | GAP (G1) | `window.confirm` at buildings/[id]/page.tsx:42 |
| useCreateContractor | use-contractors.ts:62 | create contractor | AS-IS-OK | C7 covers contractor SHARE VIEW, not the create form (fine) |
| useUpdateContractor | use-contractors.ts:70 | edit contractor | GAP (G2) | no feedback/optimistic spec |
| useArchiveContractor | use-contractors.ts:79 | archive contractor | GAP (G1) | `window.confirm` at contractors/[id]/page.tsx:49 |
| useCreateConversation | use-conversations.ts:49 | start 1:1 chat | GAP (G4) | messages surface; isError-only, no toast |
| useSendMessage | use-conversations.ts:59 | send message | GAP (G4) | no optimistic bubble; restores draft on catch only |
| useMarkConversationRead | use-conversations.ts:73 | mark read | GAP (G4) | not optimistic (cf. notifications which IS) |
| useUploadDocument | use-documents.ts:74 | upload doc | AS-IS-OK | content-path upload; create form |
| useArchiveDocument | use-documents.ts:84 | archive doc | GAP (G1) | `window.confirm` at documents/[id]/page.tsx:119 |
| useDownloadDocument | use-documents.ts:100 | signed-url download (mutation) | COVERED | gated by StepUp (M6 a11y retrofit covers the doc dialog) |
| useUploadImport | use-imports.ts:80 | upload import file | COVERED | C8 import flow (live SSE) explicitly in scope |
| useCancelImport | use-imports.ts:112 | cancel import | PARTIAL/GAP (G1) | C8 covers flow but cancel uses `window.confirm` at imports/[id]/page.tsx:75 (also has a ConfirmDialog import — verify which fires) |
| useConfirmImport | use-imports.ts:122 | confirm import (the approve-pause) | COVERED | C8 names this as the "approve, don't construct" precedent |
| useSubmitMapping | use-imports.ts:132 | submit column mapping | PARTIAL (C8/G2) | mapping form; C8 covers flow, feedback line not specified |
| useCreateMember | use-members.ts:92 | invite member | AS-IS-OK | create/invite form |
| useResendInvite | use-members.ts:110 | resend invite | GAP (G2) | a "remind" cousin of the chase loop; no toast/undo plan |
| useUpdateMemberRole | use-members.ts:120 | change role | GAP (G3) | members admin; no feedback spec |
| useUpdateMemberCapabilities | use-members.ts:136 | toggle caps | GAP (G3/G6) | non-dismissing `savedOk` + hardcoded emerald; not migrated |
| useApplyCapabilityPreset | use-members.ts:165 | apply preset | GAP (G3/G6) | toggle interaction unspecified |
| useRevokeMember | use-members.ts:176 | revoke member | GAP (G1) | `confirm()` at members/[userId]/page.tsx:125 |
| useSetMemberOverride | use-members.ts:204 | grant/deny override | GAP (G3/G6) | hardcoded red/emerald pills; no optimistic/undo |
| useClearMemberOverride | use-members.ts:214 | clear override | GAP (G3/G6) | same |
| useCreateNote | use-notes.ts:65 | create note | AS-IS-OK | create form |
| useUpdateNote | use-notes.ts:75 | edit note | GAP (G2) | no feedback spec |
| useArchiveNote | use-notes.ts:85 | archive note | GAP (G1) | `window.confirm` at notes/[id]/page.tsx:120 |
| useMarkNotificationRead | use-notifications.ts:76 | mark read | COVERED | the 2nd optimistic precedent (E.1); plan cites it as template |
| useMarkAllNotificationsRead | use-notifications.ts:98 | mark all read | COVERED | optimistic (applyMarkAllRead) |
| useUpdateOrgSettings | use-org-settings.ts:27 | save org settings | GAP (G2/G3) | the 6 config forms all funnel here; non-dismissing saved |
| useCreateOwner | use-owners.ts:93 | create owner | AS-IS-OK | create form |
| useArchiveOwner | use-owners.ts:103 | archive owner | GAP (G1) | `window.confirm` at owner-detail.client.tsx:96 |
| useRevealOwnerPii | use-owners.ts:122 | reveal cleartext PII | GAP (G5) | plain button + inline error, NOT StepUpDialog (plan assumes step-up flow) |
| useSetOwnerships | use-ownerships.ts:88 | set co-owner shares | GAP | ownerships editor form; no feedback/optimistic spec; ties to consent-basis denominator (§6.1) |
| useCreateParcelSetup | use-parcel-setups.ts:25 | start parcel setup | PARTIAL (G7) | multi-step; ConfirmDialog used; not in interaction slices |
| useSaveParcelSetupPayload | use-parcel-setups.ts:32 | save parcel payload | PARTIAL (G7) | same flow |
| useConfirmParcelSetup | use-parcel-setups.ts:38 | confirm parcel | PARTIAL (G7) | confirm-pause shape like import; not reconciled with C8 idiom |
| useResendPortalSignature | use-portal.ts:125 | tenant self-resend | COVERED (D.1) | doc 06 D.1 explicitly notes `resendForOwner` rotates the same clock |
| useUpdatePortalContact | use-portal.ts:139 | tenant updates phone/email | GAP | tenant portal form; no feedback/toast spec (C11 mentions tenant outcome vaguely) |
| useCreateProject | use-projects.ts:139 | create project (1468-line wizard) | COVERED | C5 explicitly names the project-creation wizard |
| useArchiveProject | use-projects.ts:149 | archive project | GAP (G1) | `window.confirm` at project-detail.client.tsx:100 |
| useSuspendTenant | use-provider.ts:150 | suspend tenant | COVERED | suspension panel named in M0 migration |
| useReactivateTenant | use-provider.ts:164 | reactivate tenant | PARTIAL (G1) | `window.confirm` at tenant-suspension-panel.tsx:72; panel named but the confirm itself not addressed |
| useOnboardOrg | use-provider.ts:186 | provider creates tenant org | GAP (G8) | provider/onboard form; unscoped |
| useCreateRole | use-roles.ts:49 | create custom role | GAP (G3) | role-editor; inline error idiom |
| useUpdateRole | use-roles.ts:57 | edit role | GAP (G3) | same |
| useDeleteRole | use-roles.ts:65 | delete role | GAP (G3) | hard delete — needs a confirm/undo decision; unspecified |
| useAssignRole | use-roles.ts:73 | assign role to user | GAP (G3/G6) | toggle; no feedback spec |
| useRevokeRole | use-roles.ts:84 | revoke role | GAP (G3/G6) | same |
| useCreateProjectShare | use-shares.ts:46 | create contractor share | PARTIAL (C7) | C7 covers share VIEW; create/feedback not specified |
| useUpdateShare | use-shares.ts:57 | edit share perms | PARTIAL (C7) | JSONB perms toggle; interaction unspecified |
| useRevokeShare | use-shares.ts:65 | revoke share | GAP (G1) | `window.confirm` at shares/page.tsx:99 |
| useMintShareLink | use-shares.ts:76 | mint share link | GAP | the "share link" action; no copy-to-clipboard/feedback spec in plan |
| useCreateSignatureRequest | use-signature-requests.ts:74 | create sig request | CHANGED (§5) | plan extends to optimistic (currently invalidate-only, E.3) |
| useRetrieveSignatureLink | use-signature-requests.ts:94 | fetch link | COVERED | template for the new resend hook (§3.1) |
| useCreateSignatureCampaign | use-signature-requests.ts:112 | campaign send (fan-out) | COVERED | M5 — wrap in ConfirmDialog + narrate `נשלח ל-N` + migrate lingering line |
| useCancelSignatureRequest | use-signature-requests.ts:123 | cancel request | CHANGED (§5/G1) | plan §5 wants optimistic cancel; BUT `window.confirm` at signature-requests/[id]/page.tsx:114 not migrated |
| **useRemindSignatureRequest (MISSING)** | does not exist | one-tap holdout chase | COVERED-as-NEW | the keystone M2 — endpoint exists (BE `resend()`), FE wrapper+hook to build |
| useCreateTabuExtraction | use-tabu-extractions.ts:36 | create tabu extraction | PARTIAL (G7) | tabu-review-section inline-status idiom; named in M0 migration but flow not specified |
| useRunTabuExtraction | use-tabu-extractions.ts:46 | run extraction | PARTIAL (G7) | same |
| useCreateTask | use-tasks.ts:74 | create task | AS-IS-OK | create form |
| useUpdateTask | use-tasks.ts:84 | edit task | GAP (G2) | no feedback spec |
| useArchiveTask | use-tasks.ts:94 | archive task | GAP (G1) | `window.confirm` at task-detail.client.tsx:150 |
| useAddTaskAssignee | use-tasks.ts:128 | add assignee | GAP (G6) | toggle; no feedback spec |
| useRemoveTaskAssignee | use-tasks.ts:141 | remove assignee | GAP (G1) | `window.confirm` at task-detail.client.tsx:172 |

## INVENTORY — Forms (every `<form>`) not already covered above

| Form | file | Plan status | Note |
|---|---|---|---|
| login / provider login / tenant login | (auth)/login, provider/login, tenant/login | AS-IS-OK | DoD-browser-smoke `method="post"` rule governs; redesign re-skin only |
| signup | (auth)/signup | AS-IS-OK | re-skin |
| forgot-password / reset-password | (auth)/* | AS-IS-OK | re-skin; no mutation-feedback gap |
| accept-invite | (auth)/accept-invite/[token] | AS-IS-OK | re-skin |
| 6 settings config forms | settings/_components/*-config.tsx | GAP (G2/G3) | non-dismissing saved + role=alert; no slice |
| role-editor | settings/roles/_components/role-editor.tsx | GAP (G3) | inline error idiom |
| member-capabilities-panel / overrides-panel | components/members/*.tsx | GAP (G3/G6) | hardcoded emerald/red; non-dismissing saved |
| provider onboard | provider/onboard/page.tsx | GAP (G8) | org-creation wizard, unscoped |
| provider audit / audit self | provider/audit*/page.tsx | GAP (G8) | filter forms |
| ownerships editor | apartments/[id]/ownerships/page.tsx | GAP | share editor; ties to consent denominator |
| parcel-setup-section | projects/[id]/_components/parcel-setup-section.tsx | PARTIAL (G7) | ConfirmDialog flow |
| messages composer | messages/page.tsx | GAP (G4) | no optimistic send |
| tenant portal contact form | (tenant)/portal/page.tsx | GAP | update-contact + resend feedback |
| access-reason-gate | components/provider/access-reason-gate.tsx | AS-IS-OK | provider gate; functional |

## INVENTORY — Dialogs / step-up

| Item | file | Plan status | Note |
|---|---|---|---|
| ConfirmDialog primitive | components/ui/confirm-dialog.tsx | COVERED | gold-standard a11y contract; M0/M5 build on it |
| ConfirmDialog @ imports/[id] | imports/[id]/page.tsx | COVERED | C8 |
| ConfirmDialog @ parcel-setup | parcel-setup-section.tsx | PARTIAL (G7) | not in interaction slices |
| StepUpDialog primitive | components/step-up-unlock.tsx | COVERED | M6 a11y retrofit (ESC/trap/aria-describedby) |
| StepUp @ document detail | documents/[id]/page.tsx | COVERED | M6 |
| StepUp @ tabu-review | apartments/[id]/_components/tabu-review-section.tsx | PARTIAL (G7) | inline-status migration named, dialog flow not |
| owner-pii-reveal (NO step-up) | components/owners/owner-pii-reveal.tsx | GAP (G5) | plan assumes step-up reveal; this one is plain button |
| 17× `window.confirm` | (see G1 list) | GAP (G1) | the core un-enumerated migration |
