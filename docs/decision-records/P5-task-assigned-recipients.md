# P5 slice 2 — task_assigned recipients via the central engine (D-O7)

`task_assigned` notifications now route through the central engine
`resolveNotificationRecipients` (`apps/api/src/modules/notifications/notification-recipients.ts`)
— the single source of truth for WHO receives a notification — instead of the
prior hand-rolled per-assignee emit loop in `tasks.service.ts`. We apply the
**D-O7 default**: recipients = the task ASSIGNEES ∪ org managers (always, D-O7
oversight) − the ACTOR. At each of the two emit sites we pass
`relevantUserIds = the assignees` and **do NOT pass `projectId`**, because
`task_assigned` is an entity/action event: it must reach only the task's
assignees plus the always-on managers, and must NOT fan out to ALL
project-assigned agents the way project-scoped events (e.g. `document_uploaded`)
do. The actor — the creator on `create`, the assigner on `addAssignee` — is
EXCLUDED via the engine's `actorUserId` rule, closing the actor-exclusion
deferred in D-O6 (a creator no longer receives "a task was assigned to you" for
their own task; a self-assigner is likewise dropped while the other managers
still receive it). The engine reads `getOrgSettings(...).notifications` as the
per-org seam, so a future per-org override is the escape hatch if managers find
the always-on routing noisy — no emit-site change will be needed. No inline
assignee/manager recipient logic remains in `tasks.service.ts` for
`task_assigned`; the never-throw best-effort contract is preserved (resolution
self-guards to `[]` inside the tx, emit is post-commit and try/caught).
