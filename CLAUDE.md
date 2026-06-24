\# EMAPP — Claude Code Instructions

\## What this is

B2B SaaS for Israeli urban renewal (תמ"א 38, פינוי-בינוי). Manages

apartment-owner signature collection. 2-developer team.

\## Stack (final — never suggest alternatives)

\- Backend: NestJS 11 + Fastify

\- ORM: Drizzle (NOT Prisma)

\- Validation: Zod everywhere

\- DB: PostgreSQL 16 + RLS + pgcrypto (Neon)

\- Auth: OWNED stack (D.21 — supersedes "Better Auth"). argon2id hashing,

&#x20; domain-DB sessions (auth_sessions, SHA-256-hashed refresh, rotation +

&#x20; reuse-detection), atomic signup via withBootstrap. MFA mandatory for

&#x20; Provider Admin. Better Auth is NOT in the auth path. See docs/DECISIONS D.21.

\- Cache: PostgresCacheProvider (cache_kv) in MVP — no Redis

\- Storage: Cloudflare R2 (S3-compatible)

\- Frontend: Next.js 15 App Router + shadcn/ui + TanStack Query

\- Hosting: Railway (BE+Worker) + Cloudflare Pages (FE)

\- Email: Resend (via IEmailProvider)

\- SMS: Israeli provider 019/Inforu (via ISMSProvider) — MVP, Tenant OTP

\- Monitoring: Sentry

\- Monorepo: Turborepo + pnpm

\## The 6 MVP roles (3 tiers) — locked, decisions D.17 + D.20

\- Tier 1 Org users: Manager (full) / Agent (assigned projects) / Viewer (read-only)

\- Tier 2 External: Contractor (share-based, JSONB perms) /

&#x20; Tenant (resident, SMS OTP, own record only)

\- Tier 3 Provider: Provider Admin (cross-tenant, MFA, audited)

\## Hard rules (non-negotiable)

\- Every DB read goes through withTenant(orgId, fn) or

&#x20; withProvider(providerUserId, reason, fn). Direct db.query is FORBIDDEN.

\- No `any`. No `unknown` without z.parse().

\- Every endpoint receives a Zod-validated DTO. No raw body.x access.

\- API paths are prefixed /api/v1/ — always. (Decision D.10)

\- API responses wrapped in { data }. Lists add

&#x20; { page: { limit, cursor, has_more } }.

&#x20; Errors: { error: { code, message, details? } }. (Decision D.16)

\- Soft delete = archivedAt (NOT deletedAt). UI verb = "ארכוב".

\- Entity is "apartment" (NEVER "unit"). Hebrew UI: "דירה".

\- National ID field = national_id (NOT tz). PII. (Decision D.19)

\- Project status enum: planning | gathering_signatures | approved |

&#x20; in_construction | completed | cancelled. (Decision D.18)

\- PII (national_id, phone, signatures) encrypted via pgcrypto.

&#x20; Never logged, never in error messages.

\- Hebrew names sort with COLLATE he_il_icu.

\- Dates: store UTC, display Asia/Jerusalem.

\- Tenant auth = SMS OTP via Israeli provider behind ISMSProvider.

&#x20; NoopSMSProvider is dev/test only. (Decision D.20)

\## When unsure

Read the relevant doc in docs/ before guessing.

Phase tasks: docs/03-mvp-roadmap.html. DB: docs/04c-phase-1-database.html.

Security: docs/07-security-playbook.html. Auth/API flows: docs/08-auth-api-flows.html. API reference (generate from schema, see Doc 09 §0.4): docs/09-api-reference.html. FE security DoD: docs/10-frontend-security.html. Sync mechanism (shared-types + CI enforcement): docs/11-sync-mechanism.html. Decisions: docs/DECISIONS.html.

\## V11 IN FLIGHT (2026-05-26 → ~2026-06-30)

If you are a new agent joining the team during V11 (Design Re-skin + Calendar + Tenant Portal + Export):

\- **Read first:** `docs/MASTER-PLAN-V11.md` (single source of truth for tracks/slices/gates).

\- Then: `docs/V11-BROWSER-SMOKE.md` (the smoke standard — mandatory after every slice).

\- Then: `docs/MEAPP_DESIGN_INDEX.md` (the partner's design folder map — only read MVP-relevant files).

\- Then: `docs/DECISIONS.html` D.38 + D.39 + D.40 (the V11 scope decisions).

\- Per-track entry point: `docs/V11-AGENT-PROMPT-A.md` (Design Re-skin) or `docs/V11-AGENT-PROMPT-B.md` (BE Specialist).

\- Smoke (G4) is non-negotiable — no PR merges without per-role 4-axis evidence in the PR description.

\## Definition of Done for any task

TypeScript passes, lint passes, tests green, no console.log,

diff reviewed, CLAUDE.md updated if a new pattern emerged.

\## Definition of Done for FE slices that add interactive UI

In addition to the above, for any slice that adds or changes UI interaction
(form / button / link that changes state / navigation):

1. The 4-axis browser smoke (Network / URL / Cookies / Redirect) per
   &#x20; `docs/DOD-BROWSER-SMOKE.md` — manual in real browser OR Playwright test
   &#x20; that covers the same 4 axes IN THE SAME SLICE (NOT deferred).

2. The static check `apps/web/src/app-forms-no-get-fallback.spec.ts` stays
   &#x20; green (every &lt;form&gt; has `method="post"`). Enforced by `pnpm test`.

3. View-source self-check before the slice closes — open `view-source:` on
   &#x20; every page touched; if a &lt;form&gt; lacks `method="post"` AND inline
   &#x20; onSubmit/preventDefault, it's a GET-fallback credential leak. Fix it.

Trigger: this DoD was added after S1 shipped a login form that submitted
credentials via GET URL because the SSR HTML had no `method="post"`. RTL
unit tests passed; the bug was caught by user inspection of view-source.

\## ===== STANDING DELIVERY GATES (every implementation — never skip, never forget) =====

These are NON-NEGOTIABLE and apply to EVERY slice / feature / fix / refactor — forever,
not per-task. A task is "done" ONLY when ALL of these pass; NEVER report "done" or merge
before they do. They are anchored HERE (not in memory) so no agent — including future
ones — re-derives or forgets them. Cross-ref: `docs/MASTER-PLAN-INDEX.md` §2.5 (the
per-slice gate table) + `docs/ENGINEERING-CHARTER.md`.

\### G-QA — Manual real-browser QA (every browser-observable change)

Before "done"/merge, the change is WALKED in the owner's REAL Chrome (Claude-in-Chrome
MCP) against the running app, AS the actual role — NOT headless, NOT Playwright, NOT MSW,
NOT unit-green. Those are "code green" ONLY; they are NOT acceptance. The real-browser
walk IS the gate: dev-login as the role, exercise the interaction, confirm the 5 axes
(Network all 2xx / URL / Cookies / Redirect / **Latency <1s warm**), the rendered result,
and a clean console (dev-HMR noise excepted). A subagent only produces code-green; the
real-Chrome walk is MANDATORY before merge and is the owner's standard. This SUPERSEDES the
"OR Playwright" option in the FE DoD above — Playwright is a regression net, not the
acceptance gate.

**LATENCY IS A FIRST-CLASS ACCEPTANCE AXIS (owner 2026-06-23, anchored — "otherwise we lose
the customer").** EVERY browser-observable action — navigation, click, submit — MUST complete
in **under 1 second warm**. MEASURE it on every walk (Chrome Network timing / API
`responseTime` in the boot log), never by feel. A warm interaction ≥1s is a **FAIL** that
blocks merge — root-cause it (host disk full → even /health 0.9s; dev→Neon RTT → run
`DB_TARGET=local`; redundant/duplicate FE fetches; N+1 queries) and fix before merge. ONE
cold first-hit webpack-compile spike is the only excepted case, and it MUST be explicitly
distinguished from a warm regression (re-hit the route and confirm the 2nd call is <1s) — do
NOT wave a slow interaction away as "compile" without re-measuring. Report the measured ms
per interaction in the walk evidence, not "felt fast". (Backup: memory
`feedback_sub_second_interaction_budget`.)

**OUTCOME, NOT MECHANICS — acceptance is the real-world EFFECT, end-to-end (owner 2026-06-23,
anchored).** A 2xx + optimistic UI update + a refetch is the ACTOR's MECHANICAL confirmation;
it is NOT acceptance. For ANY state-changing action, the walk MUST verify the action's PURPOSE
actually happened, end-to-end, for EVERY party it affects — generically, for every action:

1. **Propagation to the affected party.** If approving a proposal reissues a signature request
   to an apartment owner, LOG IN AS that owner (or inspect their real surface) and confirm they
   ACTUALLY received it. "The actor saw 201" proves the API ran — NOT that the recipient got
   anything. Verify the downstream artifact exists where the affected party would see it.
2. **Notifications actually fire.** If an action should alert a party (bell, SMS, email,
   inbox), confirm the alert REALLY appears for the recipient (check the bell as them; check
   the outbound/notification record). A silent state change that should have notified is a FAIL.
3. **Effect legibility — the situation picture must VISIBLY change.** After the action a human
   must grasp the NEW state AT A GLANCE. If "everything looks the same" and the only evidence
   the action happened is a network 201, **the UI FAILED — that's a blocker, not a pass.** State
   changes must be visible, distinguishable, and self-explaining (what changed, why I'm seeing
   it, what's next), per the per-role situation-picture-at-a-glance north-star.
4. **Verify the negative / no silent half-apply:** the actor's view, the affected party's view,
   and the counters/ledgers/notifications all moved CONSISTENTLY — not one without the others.

**SCALE-READY, MODERN COLLECTIONS (owner 2026-06-23, anchored).** Any list/collection of domain
entities (signatures, projects, owners, documents, proposals) MUST be designed for HIGH SCALE
from the start — NOT a flat, undifferentiated "wall" of rows/cards that only reads at demo size.
At hundreds/thousands of items it must stay scannable + prioritized: grouping, what-needs-
attention-first, at-a-glance status, progressive disclosure / zoom-in, sort/filter — consistent
with the situation-picture-at-a-glance north-star (calm, system-manages-by-rules, one-click-
confirm, zoom-in). A "flat wall" that works only at demo scale is a FAIL, even if every row is
individually correct.

**NO FLAT/STATIC SURFACE ANYWHERE — EVERY flow is a situation-picture (owner 2026-06-23,
hardened). The era of flat/static is OVER, for documents AND every other process in the system.**
Generalizes the rule above to ALL flows. Design EVERY surface for the org-customer at REAL scale —
100 projects, 100 contractors, thousands of items — and ask "what does this look like with 100 of
them?" before calling anything done:

- **NO secondary flat-list escape hatch.** An "all items / forensic" view that is itself a flat wall
  (e.g. the documents "כל המסמכים" tab) is a FAIL — it too must be a situation-picture (grouped,
  attention-first, searchable, drill-down), never a dumb scroll.
- **AUTONOMOUS-MINIMUM-ACTIONS.** The system PROPOSES, AUTO-ASSIGNS, and CHASES; the user confirms in
  one click. An uploaded document MUST auto-associate to the exact relevant party/project/entity (the
  system knows the category → it knows where it belongs); actions are GENERIC or SMART-tailored
  ("upload what's missing here"), never rigid per-file/per-type buttons. Minimize manual steps to
  near zero — that IS "autonomous managing system."
- **COLLABORATION is first-class.** Work/documents flow BETWEEN parties (owner ↔ עו״ד ↔ קבלן ↔ עירייה
  ↔ שמאי): sharing, hand-off, who-needs-what-from-whom. Design the cross-party flow, not one silo.
- **WALK DEEPLY, never shallowly.** A real-Chrome "PASS" requires: test at SCALE (seed/imagine 100s),
  ENTER the sub-surfaces (open files, drill into entities, switch every view), and VERIFY THE
  NUMBERS/DATA ARE CORRECT — a "0 מתוך X" while documents exist is a FAIL the render-check missed.
  "It rendered" is NOT "it passes"; declaring PASS on a shallow render is a logged mistake.
- **DESIGN CUSTOMER PROCESSES WITH A COUNCIL FIRST.** For any org-customer-facing process, convene a
  multi-agent COUNCIL to design the holistic full experience (scale, parties/entities, categorization,
  auto-assignment, sharing, autonomy, the situation-picture) BEFORE building — don't patch a flat
  surface into existence. The customer is an ORGANIZATION; design the whole process they live in.

\### G-RT — Red-team THROUGHOUT + loop-until-closed (every security-sensitive change; default-on for any non-trivial implementation)

An INDEPENDENT red-team (NOT the builder, NOT the builder's own @security PASS) tries to
BYPASS the change from every angle. It runs THROUGHOUT the implementation and RE-RUNS
after EVERY fix, looping UNBOUNDED — as many rounds as it takes — until the red-team
confirms the issue is closed from ALL directions (the owner: "infinite loop is fine by me
until the solution is found"). The builder's self-review is necessary, NEVER sufficient
(fox guarding the henhouse). A red-team can ALSO over-state — verify its claim against the
real code/contract before fixing. Only after the red-team can no longer break it does the
work go to the owner for HIS final acceptance (he is the LAST gate, not the first). Report
the attack matrix tried-and-failed, not just "fixed".

\### G-WHOLE — Verify yourself + the big picture

Own holistic quality on EVERY change: SOLID/seams, sub-second latency, error-handling +
fail-closed, observability, generic-not-special-cased, root-cause-not-plaster. Don't make
the owner find the gap. These are the flow — re-derive nothing.

**ONE SOURCE OF TRUTH + REUSE THE CANONICAL FLOW, NEVER RE-IMPLEMENT (owner 2026-06-23, hardened —
this is the ROOT of the bugs we keep hitting). SOLID makes this not-hard.** Every concept has ONE
source of truth; every operation routes through ONE canonical implementation; the lead VERIFIES it.

- **Divergent parallel implementations of the same thing are THE recurring defect.** The "0 מתוך X"
  board bug = TWO unaligned queries computing the same party's numbers (no single source of truth).
  The reissue consent-bypass = `reissueAndDeliver` RE-IMPLEMENTED the send instead of routing through
  the consent seam `sendGovernedReminder` uses. Both are the SAME mistake: a second implementation
  that drifted from the canonical one. Stop creating second implementations.
- **A new capability that RESEMBLES an existing one MUST be built ON the existing generic flow
  (compose/extend), not re-coded.** Document sharing → reuse `external_share` + `decideExternalPartyAccess`
  - `OutboundGovernor` (NOT a new share path). Any new outbound → `governOutboundSend`. Any new
    autonomous behavior → register a recommender on the existing engine (no new engine part). Any new
    list/board → the situation-picture primitives. Any new auth/token → the existing token-tier pattern.
    If you find yourself writing logic that already exists elsewhere, STOP and route through the existing
    seam — that IS the SOLID design.
- **Operations stay SYNCHRONIZED to the one source.** A read and the action that changes it, or two
  surfaces showing the same fact, must derive from ONE computation/seam — never two that can drift.
- **LEAD DUTY (owner: "כמנהל אתה חייב לוודא מימוש נכון ותקין"):** every dispatch brief NAMES the
  canonical seam to reuse; every review VERIFIES reuse-not-reimplement + single-source-of-truth + sync,
  not just code-green. Flag any re-implementation in G-RT and route it back through the canonical path.

\### Dispatch rule (so agents don't forget)

EVERY build/fix agent dispatch MUST carry G-QA + G-RT in its brief. When you spawn a
builder, YOU own running the independent red-team (G-RT) after it AND the real-browser
walk (G-QA) before merge — a dispatched task is NOT complete on the agent's word alone.
The agent reports code-green; YOU close the gates.

\## ===== EXECUTION POSTURE (bias to action — do NOT be over-cautious; the plan is CLOSED, BUILD it) =====

The STANDING DELIVERY GATES above are about QUALITY (never lower the bar). This is about
VELOCITY (never stall). The owner's repeated #1 frustration: stopping / parking / waiting for
approval when the right move is to keep building. Anchored HERE (not memory) so it isn't forgotten.

1. **BIAS HARD TO ACTION.** If something is built + gate-passed (G-RT CLOSED + CI green + G-QA
   where applicable), MERGE it — do not park it for "final approval." A red-team-CLOSED, CI-green
   PR has NO open ends; merging it IS the instruction, not a decision to defer to the owner.
2. **KEEP THE PIPELINE FULL.** Never end a step with "done, awaiting you" when the plan has a next
   buildable slice. The moment one slice merges, dispatch the next — no idle gaps. A heartbeat tick
   that finds buildable work BUILDS it; it does not just report status.
3. **ONLY genuinely-irreversible INFRA/LEGAL/DEPLOY actions wait for the owner:** prod deploy
   timing, prod data backfills / migrations on live data, KMS / secret provisioning, R2 bucket
   config, DPO / legal sign-offs, sending real outbound to real recipients. For THOSE: PREPARE
   everything (runbook, the exact command/PR) so it's one-click for him — don't perform the
   irreversible act, but never leave it un-prepared either.
4. **The plan is CLOSED** (`docs/MASTER-PLAN-INDEX.md` — 85/85 + the design-readiness corrections).
   The job now is to IMPLEMENT it **systematically + thoroughly**, slice by slice in dependency
   order, running independent tracks **in PARALLEL to shorten total time** — WITHOUT lowering the
   quality gates. Shorten wall-clock via parallelism + tight pipelines, never via skipped gates.
5. **Distinguish "over-cautious parking" (forbidden) from "genuinely owner-gated" (#3 only).** When
   unsure which, default to ACTION for anything reversible/buildable; reserve waiting for the true
   infra/legal/deploy set. Do NOT invent justifications to wait. If you catch yourself explaining
   why a merge/build is "probably fine but I'll wait" — that's the bug; proceed.

6. **A PR PROCESS IS NOT DONE UNTIL IT IS MERGED (owner 2026-06-23, anchored — recurring failure).**
   Opening a PR + walking away is the SAME bug as parking. When you open a PR, you OWN it to a
   terminal state: drive it to MERGE (rebase/update-branch when BEHIND, FIX it when CI fails — a
   failing PR is never "ignore it", it's "fix or close it"), or deliberately CLOSE it with a reason,
   or — only for the genuinely deploy-gated #3 set — leave it open with an explicit "owner-gated
   because X" note. NEVER leave a PR open-and-failing-and-ignored. A backgrounded merge-watcher is
   NOT a terminal state — CONFIRM the merge landed (the detached `( … ) &` subshell pattern dies
   with its parent and silently fails to merge; poll until `state==MERGED` or merge inline). Sweep
   open PRs (`gh pr list`) at the start of an autopilot stretch and resolve every stale one.

7. **FEWER, COARSER PRs (owner 2026-06-23) — the merge UNIT is coarser than the BUILD unit.** One PR
   per coherent, independently-shippable feature; build a BE contract + its FE consumer on ONE branch
   → ONE PR (also dodges the stale-main dependency). Parallel agents still build in worktrees; combine
   their cohesive output. CONDITION: gates stay per-CHANGE (G-RT every security-sensitive change,
   G-QA real-Chrome walk every browser-observable change, CI green) — a coarser PR = one thorough pass
   over more, never a skipped pass. Only batch COHESIVE work (never couple an unrelated/independently-
   risky change); if a change is too big to red-team well, split it. Quality > raw PR-count.

8. **ANTI-PARK MECHANISM (owner 2026-06-23, after repeated park-then-apologize — the #1 recurring
   failure). This is MECHANICAL, not aspirational — it removes the discretion that keeps getting abused:**
   - **The phrases "I'll do it next turn" / "on fresh context" / "later" / "deferring to" for work that
     is ALREADY code-green are BANNED.** Ready work is driven to MERGE in the SAME turn it becomes ready.
     Context-thinness is NEVER a defer-reason — if genuinely near the limit, the FINAL action of the turn
     is the merge (or the next concrete step), never a PROMISE to act next turn.
   - **STOP APOLOGIZING. "You're right, I apologize" / "you're right, that's the bug" is FORBIDDEN as a
     response** — it costs a turn, signals contrition instead of change, and is exactly what frustrates
     the owner. Replace every would-be apology with the executed action (the merged PR, the dispatched
     builder). SHOW, don't say. If you catch yourself typing an apology, delete it and run the command.
   - **TURN-START RITUAL (every heartbeat + every post-builder turn): DRAIN FIRST.** Before any analysis
     or status report, the FIRST actions are: `gh pr list` → merge every green PR, collect every finished
     builder → commit/walk/merge it. Only THEN start or report new work. NEVER write a status update while
     a green PR sits unmerged or a finished builder sits uncommitted.
   - Reports are for EVIDENCE of action taken (merged #X, walked Y), never for narrating what you WILL do.
     Wall-clock spent reporting/analyzing instead of merging IS the bug.

\## ===== AUTOPILOT PROTOCOL =====

\### Multi-agent heartbeats (per-track, append-only)

`PROGRESS.md` is a **generated artifact** as of 2026-05-27. The active
"Heartbeat (latest)" section between `<!-- BEGIN AGENT HEARTBEATS -->`
and `<!-- END AGENT HEARTBEATS -->` markers is regenerated from
per-track files under `docs/heartbeats/track-{a,b}/YYYY-MM-DD.md`.

Agents MUST:

1. Write new heartbeat bullets to `docs/heartbeats/track-<your-track>/<today>.md`
   (create the daily file if it doesn't exist). NEVER write directly inside
   the `BEGIN/END AGENT HEARTBEATS` block — those edits will be overwritten
   on the next `pnpm gen:progress`.
2. Run `pnpm gen:progress` after adding a heartbeat (also runs in CI;
   `pnpm gen:progress:check` will fail the PR if the files diverge).
3. Commit BOTH the new heartbeat file AND the regenerated `PROGRESS.md`
   in the same commit.

Cross-track writes are forbidden: a Track B agent NEVER writes to
`docs/heartbeats/track-a/`, and vice versa. The directory naming IS the
ownership rule. See `docs/heartbeats/README.md` for the full convention.

The `## Legacy heartbeats` section in `PROGRESS.md` is frozen at the
2026-05-27 migration point and preserved for historical context — do not
add new bullets there.

\### On every session start

1\. Read PROGRESS.md → identify Current Position + Next task.

2\. Read GATES.md → know if the next task is a critical gate.

3\. State to the user: "אני ב-Phase X, משימה הבאה PX.Y. ממשיך."

&#x20; Then proceed WITHOUT waiting (unless it's a gate — see below).

\### The task loop (repeat automatically per task)

For the Next task (e.g., P0.4):

1\. Read docs/DECISIONS.html (D.01-D.20 are law — national_id not tz, {data} envelope, status enum, 6 roles, /api/v1/). Then read the task from its source doc:

&#x20; - Phase 0 → docs/04b-phase-0-foundation.html, find PX.Y

&#x20; - Phase 1 → docs/04c-phase-1-database.html, find PX.Y

&#x20; - Phase 2+ → docs/03-mvp-roadmap.html, the matching phase section

2\. Extract: goal, files, dependencies, required tests (TX.Y),

&#x20; Definition of Done.

3\. Verify dependencies are done (check PROGRESS.md). If a dependency

&#x20; is missing → STOP, write Blocked in PROGRESS.md, tell the user.

4\. Implement the task.

5\. Run the task's tests: pnpm test (+ the specific TX.Y).

&#x20; - Fail → fix → re-run. Loop until green. Max 5 attempts, then

&#x20; STOP, mark Blocked, explain.

6\. Run: pnpm lint \&\& pnpm typecheck. Must pass.

7\. Commit (semantic message): git add . \&\& git commit

8\. Push: git push

9\. Update PROGRESS.md: Next task, Task Log line, checkbox.

10\. Move to the next task automatically. Do NOT ask permission

&#x20; between tasks within a phase.

\### When to STOP and wait for the user (the ONLY stop conditions)

\- End of a Phase: all tasks done →

&#x20; a) ensure all phase tests green + Definition of Done met

&#x20; b) open a PR (see PR protocol below)

&#x20; c) update PROGRESS.md (phase checkbox, status: awaiting_approval)

&#x20; d) tell the user: "Phase X הושלם. PR פתוח: <url>. ממתין לאישור."

&#x20; e) STOP. Do not start the next phase until the user says continue.

\- A critical gate (GATES.md): stop even mid-phase, per GATES.md.

\- Blocked: dependency missing, test fails 5x, doc unclear, or a

&#x20; decision needed that isn't in DECISIONS.html → STOP, write Blocked

&#x20; + question in PROGRESS.md, ask the user.

\- Security-sensitive task (PII/auth/RLS): after implementing, BEFORE

&#x20; commit, run "@security-reviewer review the diff". Fix CRITICAL

&#x20; before commit. (Internal — does not stop for the user.)

\### PR protocol (end of each phase)

1\. Branch at phase start: git checkout -b phase-X

2\. At phase end: git push -u origin phase-X

3\. gh pr create --title "Phase X — <name>" --body "<summary>"

&#x20; Body lists: tasks completed, tests passing, Definition of Done

&#x20; checklist, what the reviewer should focus on.

4\. Tell the user the PR URL. STOP.

5\. User merges = approval. User comments = fix and update the PR.

6\. After merge: git checkout main \&\& git pull, next phase = new branch.

\### Never

\- Never skip a test to "make progress".

\- Never start the next phase before PR merge.

\- Never proceed past a Blocked state silently.

\- Never modify GATES.md or this protocol without the user.
