# P4 / D-O6 DECISION RECORD — auto-assign the task creator (risk: low)

**Decision:** On task CREATE, automatically add the creating user to the task's assignee
set. Chosen option **(b)** from D-O6 (`docs/DECISIONS-FOR-OWNER.md`).

**Problem.** Task READ visibility is **assignee-based by design** (`tasks.service.ts` — an
agent sees tasks where they hold a `task_assignees` row; this is intentional and distinct
from the write/manage path which is project-capability-scoped). The friction: an agent
**creates** a task on their project and it immediately **vanishes from their own list**,
because the creator was not auto-added as an assignee. That is surprising and breaks the
"I just made this, where did it go?" expectation.

**Options considered.**

- (a) Keep as-is — rejected: the vanish is a real, confusing gap.
- **(b) Auto-add the creator as an assignee on create** — CHOSEN. The creator is implicitly
  a stakeholder in the task they just made. This **preserves the assignee-based read model**
  (no change to how reads are scoped) and removes the vanish with a one-line, additive change.
- (c) Re-scope agent task reads to "all tasks on my assigned projects" — rejected for this
  slice: it changes the documented read model (a bigger product decision, more blast radius).
  Left open as a future option if the org ever wants project-wide task visibility.

**Why (b) is safe / non-deviating.** It does not touch the read-scoping model, RLS, or the
write-authz path. It only widens the assignee SET at creation — and the create path already
builds `assigneeIds` as a de-duplicated `Set`, so a creator who ALSO appears in the explicit
`assigneeIds` yields exactly one `task_assignees` row (no duplicate). The creator is, by
construction, a valid org member, so it passes the existing assignee-membership validation.

**Verification (mandatory).** Real-DB: a freshly-created task appears in the creator's own
assignee-scoped list; an explicit `assigneeIds` set still produces exactly those + the
creator with no duplicate row when the creator is also listed; the existing explicit-assignee
behavior for other users is unchanged; no RLS/authz regression.
