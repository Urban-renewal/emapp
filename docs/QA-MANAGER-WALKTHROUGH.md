# Manager full-product walkthrough — as the org manager (Dana, Trial)

Driving the ENTIRE manager product surface in the browser as a real manager,
exercising every page / button / logic / data view. Goal: cover the whole
current product, find every dead button / button-without-logic /
logic-without-button gap. Owner directive: "manage end-to-end until you've
gone over everything — buttons, logics, data, the whole product."

## Legend

✅ works · ⚠️ gap/finding · ⏭️ deferred-by-design (coming-soon, not a gap)

## Coverage log

### Auth / shell

- ✅ Manager login (dana@trial.dev) → dashboard, sidebar (מנהל role): ראשי /
  פרויקטים / בעלי דירות / ייבוא / מסמכים / בקשות חתימה / התראות / משימות, +
  permission-gated members/audit/settings.

### Home (/he)

- ✅ KPIs reflect real story data: פרויקטים פעילים 3 · דיירים 6 · חתימות 2 ·
  ממתינים 0. "+ פרויקט חדש" present.
- ⏭️ "יומן השבוע" + "שיחות אחרונות" — explicit coming-soon (A.S12 calendar /
  Phase-2 chat). Deferred by design, not a gap.

### Projects

- ✅ /projects — 3 project cards, search, list/cards toggle, "צור פרויקט".
  Herzl 10 card shows 6 יח"ד · חתימות 1/1. Banner: some metrics (גוש/חלקה/
  סוכנים) "wired after API enrichment".
- ✅ /projects/[id] (Herzl 10) — header, status בתכנון, ייצוא לאקסל, KPIs
  (קבלן —, חתימות 1/1, סוכנים 1), 4 tabs.
- ✅ לוח בקרה tab — description = the story ("חלקה עם חנויות, בניין דירות,
  מפעל ומבנה מעורב"), sections: בניינים / שיוך אגנטים / שיתופי קבלנים / ארכוב.
- ✅ /projects/[id]/buildings — הרצל 10 ת"א · 6 דירות · גוש 6638 · חלקה 42;
  "הוספת בניין".
- ✅ /buildings/[id] — ארכוב + "ניהול דירות ושינוי סטטוס לכל דירה".
- ✅ /buildings/[id]/apartments — 6 apartments (1–6), all בהמתנה; "הוספת דירה".
- ✅ /apartments/[id]/ownerships — atomic D.25 editor: owner dropdown (all 7
  org owners incl. נועה גרין), %, "סך הכל 100.00%", add/remove row, save.

#### ⚠️ QA-APT-STATUS-1 — apartment status change: functionality WITHOUT a button

- BE FULLY supports it: `@Patch('apartments/:id')` + `@RequirePermission('apartments.update')`,
  `UpdateApartmentInput` includes `status: ApartmentStatusEnum`
  (vacant/pending/... per apartment_status pg enum).
- FE does NOT: `apps/web/src/lib/api/apartments.ts` has only list/get/create/
  archive — NO updateApartment; the apartment detail page (/apartments/[id])
  shows the status badge + ארכוב + ערוך חלוקה but NO status-change control.
- The building page advertises "שינוי סטטוס לכל דירה" — promise unfulfilled in UI.
- FIX (authorized): add a status-change control on /apartments/[id] wired to
  the existing PATCH endpoint. STATUS: pending fix.

### Tasks ("משימות נשלחות" — owner's emphasis)

- ✅ /tasks — empty state + "צור משימה".
- ✅ /tasks/new — title/description/priority; created a real task
  ("להחתים את בעלי הדירות בקומה 2 — מתחם הרצל 10") → redirected to detail.
- ✅ /tasks/[id] — status editor (ממתין/בביצוע/הושלם/בוטל) + description + שמור;
  assignees section with member dropdown (גלי viewer / רון agent / דנה mgr) + שייך;
  ארכוב. Assign endpoint POST /tasks/[id]/assignees → 201 works; agent רון then
  SEES the task (data ripple ✅).

#### ⚠️ QA-TASK-NOTIF-1 — assigning a task does NOT notify the assignee in-app

- Owner directive: notifications must sync to everyone before MVP. Assigning a
  task is the canonical "task sent" event. After assigning the task to agent רון,
  ron's unread-count = 0 and there is NO task_assigned notification (same
  read-only-notifications root as before: no producer for task_assigned).
- FIX (authorized): emit a task_assigned notification to each newly-assigned
  user via the NotificationsProducerService (the producer I just built).
  STATUS: pending fix.

#### ⚠️ QA-SESSION-1 (UX, MED) — mid-action hard logout on access-token expiry

- During the walkthrough (~15 min) the manager access token expired; clicking
  "שייך" (assign) 401'd and HARD-redirected to /he/login, LOSING the in-flight
  action (the assignment did not land). A working refresh-token rotation should
  silently refresh instead of bouncing a working manager to login mid-action.
  Likely same class as QA-PROV-1 dual-session / QA-TENANT-1 redirect. Needs an
  apiClient refresh-on-401 investigation. Logged; not fixed in this pass.

### Remaining surfaces — all swept (✅ render + buttons + data, as Dana)

- ✅ Owners list — 7 owners, PII masked by default (ת.ז./phone). Owner dossier:
  reveal-PII button works (click → cleartext 200000016 / +97253... + "מוצג זמנית —
  הצפייה מתועדת" + הסתר toggle; audited as pii_revealed). Archive present.
- ✅ Documents — 4 docs incl. the live one; upload button; "advanced filters after
  API enrichment" banner.
- ✅ Signature-requests — 2 signed (live + story); status filter pills; create button.
- ✅ Members — 6 members w/ role + state (פעיל/ממתין) + "מקים הארגון" founder badge;
  invite button.
- ✅ Audit — comprehensive, real-time: pii_revealed, task assign/create, signature
  signed, SR/owner/doc create, logins, share link_minted, tenant OTP. Append-only,
  who/what/when/target; IP/UA stored-not-shown.
- ⏭️ Settings — explicitly labelled scaffolding: General tab read-only (org/user/role);
  Notifications/Integrations/Security "wired in later phases". Honest coming-soon.
- ✅ Contractors — בוני הצפון בע"מ; add button.
- ✅ Notes — empty + create button.
- ✅ Imports — 2 completed (6.5KB · 3 rows).
- ✅ Project assignments — רון (agent) assigned to Herzl; assign form (role-in-project)
  - unassign. (the intra-tenant isolation mechanism.)
- ✅ Contractor shares — בוני הצפון 4/6 sections; PII-hidden-by-default with per-section
  toggles ("חתימות — אחוז מצרפי בלבד, לעולם לא מי חתם"). The PII-clean-to-contractor control.

## ════ FIXES IMPLEMENTED (both verified live) ════

### ✅ FIX A — QA-TASK-NOTIF-1: task_assigned in-app notification (BE)

- TasksService.addAssignee now emits a `task_assigned` notification to the
  newly-assigned user via NotificationsProducerService (reuses the producer),
  after the tx commits, try/catch-guarded (never fails the assignment).
  tasks.module imports NotificationsModule.
- Tests: tasks-capability TASK-N1 (emit called w/ task_assigned + recipient=assignee
  - PII-clean body) + TASK-N2 (a throwing notifier doesn't fail the assign) — 22/22 green.
- LIVE: Dana assigns Ron → Ron unread 0→1, notification "הוקצתה לך משימה" +
  body cites the task title, metadata { taskId }, PII-clean.

### ✅ FIX B — QA-APT-STATUS-1: apartment status FE control (FE)

- apps/web/src/lib/api/apartments.ts: added updateApartmentStatus(id, status) →
  PATCH /apartments/:id (BE already supported it).
- use-apartments.ts: useUpdateApartmentStatus mutation (invalidates apartments key).
- /apartments/[id]: new "סטטוס הדירה" card — a status <select> (6 enum options,
  labels from the adapter) + עדכן סטטוס button, gated on `apartments.update`,
  disabled when unchanged. he/en strings added.
- LIVE: changed דירה 3 בהמתנה → נוצר קשר; badge updated + "סטטוס שונה בדקה זו";
  audited. typecheck + lint clean.

## Verdict

Whole manager product swept end-to-end as the org manager. Everything works or is
honestly labelled coming-soon. Found 2 real gaps matching the owner's exact concerns
(notification-sync + functionality-without-a-button) — both FIXED + verified live.
1 UX item logged (QA-SESSION-1, mid-action token-expiry redirect) for a follow-up.
