# EMAPP — Autonomous System Master Plan

> Produced 2026-06-22 by a 9-agent planning council (7 domain teams + systems architect + chair),
> grounded in the real codebase + `docs/PROCESS-MAP.md` (85 processes). The vision: EMAPP runs the
> urban-renewal signature campaign largely by itself; the technophobic manager stays in control by
> confirming with one click. Builds on the interaction-doctrine audit (passive→one-click) — this adds
> the deeper PROACTIVE/agentic layer.

## North-star
EMAPP runs the campaign largely by itself: from a single address it fetches the parcel, parses the נסח,
and drafts the building/owner/ownership structure; it classifies and dedupes every document and tracks
per-project completeness; it ranks holdouts by leverage, schedules reminder cadences by rule,
expires-and-re-issues stale links, detects anomalies, and continuously re-ranks the fleet by attention.
The system PROPOSES and DRAFTS the next move into one calm **Approval Inbox**; the manager confirms with
one click ("המערכת תזמנה 12 תזכורות · [אשר הכל]"). Anything outbound, legal, PII-exposing, or irreversible
is human-confirmed; only safe, reversible, internal reconciliation runs unattended — and every autonomous
act is reversible, rate-limited, consent-respecting, and audited as `actorType='system'`.
**Autonomous EMAPP is never unaccountable EMAPP.**

## Autonomy doctrine (extends the 6 interaction principles with the proactive layer)
1. **Situation-first → self-updating**: the board is a persisted, scheduler-refreshed `fleet_attention`
   snapshot (extends `rank-attention.ts`), not recompute-on-read. The human opens an already-current picture.
2. **Ranked-not-rostered → proactive**: the same `rankItems` scorer orders the Approval Inbox — the
   highest-leverage proposal surfaces first, not a flat list of everything possible.
3. **One-click-confirm → the APPROVE verb**: `RowAction` (confirm-dialog + action-toast) applied to a
   *proposal* exactly as to a record. APPROVE / ADJUST / DISMISS — zero new vocabulary.
4. **System-acts-by-rule → proactive-by-rule**: a policy layer ticks on schedule + on events, DRAFTS the
   next action fully-resolved, and the human's job shrinks to confirm.
5. **Calm-by-default preserved**: actionable proposals are visually distinct from FYI digests; `dedup_key`
   prevents re-nagging; `expires_at` retires stale proposals so the inbox never accumulates noise.
6. **Consistency**: every autonomous behavior reuses an EXISTING gated service method verbatim at execute
   time — a proposal can never do something a human couldn't do through the normal UI.
7. **PROPOSE-FREELY / EXECUTE-NARROWLY** (the agentic axiom): the system may DRAFT/PROPOSE anything; it may
   EXECUTE autonomously ONLY when internal AND reversible AND non-PII AND non-outbound. This single
   boundary makes "autonomous" compatible with legally-binding signatures + national_id PII.
8. **RE-EVALUATE-AT-EXECUTE**: APPROVE replays the real gated path under RLS and re-checks the gate at
   click time (threshold still met? kill-switch on? concurrency?). A proposal is advisory evidence, never
   a pre-authorization; a stale one is rejected cleanly.
9. **EVERY-ACT-AUDITED-AND-UNDOABLE**: every act writes `audit_log` with `actorType='system'` + proposal
   id + policy decision; reversible executions return an undo token. Irreversible acts carry no undo and
   are exactly the ones pinned to human-confirm with step-up.

## The autonomy engine (7 thin parts on mostly-existing substrate)
1. **Policy/RuleEngine** (`AutonomyPolicy`, NEW, pure Zod taxonomy in `packages/jobs`) — `classify(action)
   → {autoExecute | proposeConfirm | humanOnly}` + reversibility/PII/outbound/consent/rate flags + cadence
   rules. The guardrail charter AS CODE; hard-pins outbound/legal/PII/irreversible to confirm.
2. **Scheduler/Orchestrator** (EXISTING substrate, new consumers) — pg-boss cron consumers, each a verbatim
   copy of the proven `signature-expiry.handler.ts`, that tick policies per-org and emit proposals — never send.
3. **Event bus** (NEW, lightweight) — NestJS EventEmitter2 + an outbox row; write paths (public-sign
   completion, document.finalized, the existing `invalidateStats` consent-epoch flip) publish typed events.
4. **Proposal/Approval queue** (NEW table + producer) — one `proposals` table + `emitProposal()` extending
   `NotificationsProducerService` (reuses its recipient-scoped withTenant insert + PII-free-title contract).
5. **Next-best-action recommenders** (NEW thin wrappers) — over analytics that ALL exist today:
   `rankAttention`, `leverage()`, `holdouts()`, `documentChecklist`, `dedupCheck`, `fingerprintHeaders`.
6. **Executor + Audit + Undo** (`POST /proposals/:id/approve|adjust|dismiss`) — replays EXISTING gated
   methods, re-checks the gate at execute time (expectedUpdatedAt concurrency), writes system-audit, returns undo.
7. **OutboundGovernor** (NEW + `outbound_ledger`) — wraps `IEmailProvider`/`ISMSProvider` + the existing
   `CAMPAIGN_SEND_ENABLED` kill-switch + throttles; per-org/recipient/project ceilings, consent, quiet-hours
   (Asia/Jerusalem), fail-safe PAUSE-only circuit-breaker; writes a ledger row BEFORE every send.

## Approval Inbox lifecycle
rule-tick/event **DRAFTS** → `emitProposal()` writes a `pending` row (type, fully-resolved action JSONB,
evidence snapshot, reversible flag, dedup_key, expires_at, org+recipient scope, PII-free title) →
manager sees it in the Approval Inbox (distinct from FYI notifications) → three one-click verbs:
**APPROVE** (replays the gated path, re-checks the gate under RLS) · **ADJUST** (edit recipients/copy then
approve) · **DISMISS** (records dedup_key so it's not re-proposed). Bulk **[אשר הכל]** approves same-type
proposals. Every transition audited `actorType='system'`. Reversible executions return an undo token;
irreversible ones carry none and require step-up.

## Guardrail charter (non-negotiable)
1. **THE ONE BOUNDARY** — auto-execute ONLY when internal AND reversible AND non-PII AND non-outbound
   (pending→expired flip, attention re-rank, non-sensitive classify-tag, exact-hash dedup auto-archive,
   scan re-reject, breach throttle, tabu PARSE into draft). Everything outbound/legal/PII/irreversible is
   propose-then-confirm or human-only. Hard-pinned in `AutonomyPolicy`; no config can auto-send a signature
   or auto-reveal a national_id.
2. **Reversibility by construction** — every auto act is provably reversible + exposes undo. No auto path
   does a physical delete or one-way disclosure.
3. **Audit-every-act** — `actorType='system'` (the union already exists) + the normal domain audit; append-only.
4. **Consent + quiet-hours** — the OutboundGovernor checks per-owner opt-out + consent + quiet-hours before
   any send; OTP/transactional exempt from quiet-hours but still consent+ledger checked.
5. **Rate-limit + no-nag** — per-org/recipient/project ceilings; max reminder_count cap; proposals deduped.
6. **Global kill-switch + fail-safe breaker** — `CAMPAIGN_SEND_ENABLED` pre-disables outbound; the breaker
   trips PAUSE-only; RESUME always human-confirmed. PII never in a proposal title/body/alert.
7. **Human-confirm FLOORS** (never auto regardless of config) — status→approved, tabu confirm→ownerships,
   national_id export, sensitivity-flip ON, role/Owner grant, provider freeze, the Gate-6 ~750-doc re-encrypt.

## Top autonomy wins (ranked by leverage)
1. **Reminder cadence by rule** (day 0/+3/+7/+14) — propose+confirm. The chase IS the product; today ZERO
   cadence, only a manual button. Builds the whole engine spine. *(transformational)*
2. **'→approved' threshold-crossing proposal** — the system already knows the exact moment target is met
   (every consent write hits `invalidateStats`) but never says so. Reuses `computeMetThresholdOnTx`.
3. **Auto-extraction of the נסח** — on finalize+classified=tabu, auto-parse owners into DRAFT (reversible),
   then "נסח נותח, 5 בעלים · [סקור ואשר]". Collapses the 4-click setup; legal commit stays human.
4. **Self-updating fleet attention board** — persisted snapshot, scheduled+event re-rank; the event source
   the other proposers subscribe to.
5. **Proactive leverage chase-wave** — rank below-target projects by marginal-delta, draft a targeted chase
   of top-leverage holdouts, one-click send.
6. **Per-project doc-checklist watcher** — continuously detect missing נסח etc., draft "[request]".
7. **Expiry → re-issue loop** — on the existing hourly expiry flip, draft re-issue proposals (the safest
   first producer).
8. **Exact-hash dedup auto-archive** — byte-identical dup auto-archived (reversible) — textbook safe-auto.
9. **Breach detection→response** — auto time-boxed throttle on brute-force (auto-expiring).
10. **External-share auto-expire + renewal; invite self-chase; tenant auto-onboard SMS.**
11. **Audit-anomaly sweep** — scheduled scorer over `audit_log` surfaces off-hours PII reveals etc.
12. **On-finalize server-side classify** — auto-tag non-sensitive; PROPOSE any sensitive flip.

## Phased roadmap (non-big-bang; each slice ships behind propose-not-execute)
- **Phase 0 — Guardrail charter + audit spine (safety floor FIRST):** `AutonomyPolicy` taxonomy +
  `AuditService.log(actorType='system')` wired. No behavior change — just the law + the ledger. One PR.
- **Phase 1 — Proposal queue + Inbox UI (the spine):** `proposals` table + `emitProposal()` + the
  approve/adjust/dismiss executor (replay+re-check+undo) + the Approval Inbox as a `WorkCollectionShell`.
  Seed with ONE safe producer: the expiry-sweep re-issue. End-to-end propose→approve→execute→audit→undo.
- **Phase 2 — First exemplar: signature reminder-cadence loop (PROOF):** OutboundGovernor + outbound_ledger
  + cadence policy + per-request reminder state + a cron consumer drafting the due batch. Executor reuses
  `remindProjectPending` verbatim. → "המערכת תזמנה N תזכורות · [אשר הכל]" works in the manager's real Chrome.
- **Phase 3 — Situation autonomy:** self-updating fleet snapshot + event bus (`threshold.crossed`) +
  '→approved' proposal + leverage chase-wave.
- **Phase 4 — Paperwork + data-foundation:** on-finalize classify + dedup auto-archive + checklist watcher +
  auto-נסח-extraction-to-draft + CSV mapping auto-propose.
- **Phase 5 — People-access + governance self-defense:** share/invite/tenant lifecycle ticks + breach
  response loop + audit-anomaly sweep + health self-heal.
- **Phase 6 — Tuning to 'perfect':** per-org autonomy dashboard (approve/dismiss rate = confidence signal),
  cadence/threshold tuning from real dismiss data, FYI digest, optional per-org 'auto-send within caps' opt-in.

## First exemplar to build
**The signature reminder-cadence loop** (process 36). Why: (1) it's the owner's literal example; (2) highest-
leverage transformational win — the chase IS the product and today has no cadence; (3) it forces every engine
component into existence on a real path; (4) fully reversible + rate-capped so blast radius is bounded.
Once it works in real Chrome, every other loop is "write another recommender + producer into the same queue."

## Risks (with mitigations — see council output for detail)
1. Over-trust / reflexive 'אשר הכל' → evidence snapshots + per-type (not global) bulk + step-up on high-stakes
   + dismiss-rate as the calibration signal.
2. Notification fatigue → dedup_key + expires_at + rankItems + FYI digests (tune in Phase 6 with real data).
3. Outbound send-bomb → mandatory central OutboundGovernor + ceilings + ledger-before-send + reminder cap.
4. Stale-proposal mis-apply → re-check the gate at execute with optimistic concurrency.
5. Classifier/extraction false positives → confidence floors; sensitive-flip turn-ON-only + confirm; tabu
   parse draft-only.
6. 2-dev capacity → non-big-bang; prove the first exemplar before fanning out.
7. Worker reliability → heartbeat proposal if a tick missed its window + the FYI digest.
8. Guardrail erosion → `AutonomyPolicy` is the single chokepoint; human-confirm floors pinned in code +
   Gate-2/Gate-6 protection.
9. RLS/tenant-isolation regression in shared engine code → everything inside withTenant; copy the notifications
   RLS pattern; security-reviewer before each engine slice merges.

## Gap-closure addendum (2026-06-22)

> A completeness cross-check against `docs/PROCESS-MAP.md` found 5 processes with a REAL autonomy angle that
> the original council under-addressed. Each is reconceived below WITHIN the existing framework — they are
> new **recommenders/producers** on the same 7-part engine, not new engine parts. The guardrail charter, THE
> ONE BOUNDARY (internal AND reversible AND non-PII AND non-outbound), and the human-confirm FLOORS are
> unchanged and bind every behavior here. Nothing below alters the engine design.

### G1. Tasks — the system's OWN work-tracking surface (process 50)
- **Today:** `apps/api/src/modules/tasks/tasks.service.ts` — full task CRUD + `task_assignees` + completed/due
  state + `task_assigned` notifications. Every write is `actorType:'user'`; there is ZERO system-authored task
  creation, no auto-assignment, no auto-close, and `dueAt`/overdue is stored but never acted on. Biggest gap.
- **autonomousBehavior:** A `TaskWatcher` recommender ticks on schedule + on events and reconciles a set of
  **system-owned tasks** (a new `tasks.source='system'` + nullable `origin_ref` discriminator) against detected
  work: missing נסח on a gathering-signatures project, an apartment stalled N days with no signature/contact, an
  external share expiring inside 72h. (a) **AUTO-CREATE** a system-owned task for each newly-detected condition
  (deduped by `origin_ref` so a condition yields exactly one open task). (b) **AUTO-CLOSE** (status→completed,
  `completedBy=system`) the system-owned task the instant its triggering condition resolves (נסח arrives, share
  renewed, apartment signs) — the event bus already publishes those completions. (c) Surface **overdue** system
  tasks by promoting them into the attention re-rank. Assigning a *human* to a task, or any outbound nudge derived
  from it, is NOT auto — it proposes.
- **The boundary (Approval Inbox vs task list):** these are two different surfaces and the split is the answer to
  "where does detected work live." The **task list = durable, assignable work items** a human will execute over
  days (it has assignees, due dates, completion). The **Approval Inbox = ephemeral proposals** a human confirms
  in one click and which then vanish. Rule: *creating/closing a system-owned task is auto* (internal + reversible
  + non-PII + non-outbound → passes THE ONE BOUNDARY); *attaching a human or sending anything is a proposal.* So a
  detected "missing נסח" auto-opens a system task (durable tracking) AND, when worth a person's attention, emits a
  proposal "הקצה את דנה לטיפול בנסח החסר · [אשר]" whose APPROVE replays the EXISTING `addAssignee` gated method.
  The task is the backlog; the inbox is the doorbell. Auto-close keeps the backlog honest without a human touching it.
- **mode:** create/close system-owned task = `auto-execute-safe-reversible`. Assign-human / outbound-from-task =
  `propose-then-one-click-confirm`.
- **humanConfirm:** none for create/close (system-owned, reversible: re-open = un-archive, audited undo token).
  One-click APPROVE for any human-assignment or outbound derived from a task.
- **engineCapability:** **recommender** (`TaskWatcher` over existing `documentChecklist` + attention/stall signals)
  + **producer** (`emitProposal` for the assign/nudge) + **executor** (replays `create`/`update`/`addAssignee`
  verbatim with `actorType:'system'`). No new engine part — `system` is already in the actorType union.
- **guardrail:** system tasks are a SEPARATE namespace (`source='system'`) so they can never silently mutate a
  human's task; auto-close only flips system-owned rows; `origin_ref` dedup prevents re-creation churn; titles are
  PII-free (project/apartment ids, never owner identity); every create/close audited `actorType:'system'` + undo.
- **impact:** transformational — converts a passive CRUD table into the system's self-maintained backlog; the
  manager stops manually noticing "this needs a נסח" because an auto-task already tracks it and auto-clears when done.

### G2. Notes — system-authored activity/annotation trail (process 49)
- **Today:** `apps/api/src/modules/notes/notes.service.ts` — manager/agent author free-text notes; bodies may
  carry PII (residents, money, disputes) so they are deliberately kept out of notifications. All `actorType:'user'`.
- **autonomousBehavior:** when the engine executes an autonomous act, it ALSO drops a terse **system-authored note**
  on the relevant project/apartment recording what it did — "המערכת הנפיקה מחדש 3 קישורי חתימה", "נסח נותח: 5
  בעלים זוהו (טיוטה)", "שותפות חיצונית חודשה ל-30 יום". This is the durable, in-context activity trail (the audit
  log is forensic + hidden; the note is the human-readable margin annotation on the record itself).
- **mode:** `auto-execute-safe-reversible` — a note is internal, reversible (archive), and the system controls its
  content so it is provably non-PII.
- **humanConfirm:** none. (It is FYI, not a proposal; it never appears in the Approval Inbox.)
- **engineCapability:** **producer** side-effect of the **executor** — after a successful autonomous execute, the
  executor calls `notes.create` with a `createdBy=system` sentinel. Reuses the existing gated `create`.
- **guardrail:** system notes are TEMPLATE-only (no owner free-text interpolation — only ids/counts the system
  itself generated), `source='system'` so they're visually distinct + filterable, archived-reversible, and the
  PII-free contract is enforced at the template layer (same discipline as the PII-free proposal-title contract).
  A system note never carries national_id/phone/name.
- **impact:** medium — closes the "what did the robot just do to my project" gap on the record itself; pairs with
  G3 (the per-record note is the detail; the digest is the rollup).

### G3. Messaging — proactive team digest into a conversation (process 51)
- **Today:** `apps/api/src/modules/messaging/messaging.service.ts` — member↔member threads; only humans post
  (`senderId=user.sub`, viewer-forbidden, WITH-CHECK participant-only insert). No system author.
- **autonomousBehavior:** a scheduled producer posts a **proactive daily "what I did / what needs you" digest**
  into a designated org conversation (a system-owned thread, or an opt-in existing thread) — "סיכום יומי: הנפקתי
  מחדש 4 קישורים · 12 תזכורות ממתינות לאישורך · פרויקט רחוב הרצל חצה את הסף". It is the human-readable rollup of
  the day's autonomous activity + a pointer to the Approval Inbox.
- **mode:** `auto-execute-safe-reversible` for posting the digest (internal, reversible, system-generated non-PII
  text). NOTE: this is the in-app team thread, NOT an outbound channel — it does NOT route through the
  OutboundGovernor (no email/SMS leaves the system). If a future variant emails the digest externally, THAT becomes
  outbound → propose + OutboundGovernor.
- **humanConfirm:** none for the in-app post (FYI digest). Any external/email mirror = `propose-then-one-click-confirm`.
- **engineCapability:** **producer** (a digest assembler over the day's `actorType:'system'` audit rows + pending
  proposal counts) that calls a system-author variant of `sendMessage`. Requires a `senderId=system` sentinel
  participant exempt from the human-only WITH-CHECK — the one small DB seam, modeled exactly on the existing
  system actorType.
- **guardrail:** digest body is TEMPLATE + counts only (never a thread quoting owner PII); rate-limited to one
  scheduled post per window (dedup by date key — no re-posting if the tick double-fires); the system thread is
  clearly system-owned; respects the same calm-by-default / no-nag rules (empty day → no post, or a single quiet line).
- **impact:** medium — gives the technophobic manager a single calm narrative ("here's what the system handled")
  without opening the inbox; reinforces accountability (every digest line traces to an audited system act).

### G4. RTBF / erasure — detect-and-PROPOSE compliance, never auto-erase (process 26)
- **Today:** `apps/api/src/modules/owners/data-subject.service.ts` — `dataExport` (audited PII reveal) + `erase`
  (crypto-shred PII in place, retain non-PII signature/ownership rows for legal validity). Both manager-gated,
  fully audited, IRREVERSIBLE erase. Purely reactive: a human must know an obligation exists and click.
- **autonomousBehavior:** a `RetentionWatcher` recommender ticks and DETECTS standing obligations the manager
  would otherwise miss — owners on completed/cancelled projects past a configured retention horizon, or owners
  flagged with a pending data-subject request — and PROPOSES the compliance action into the Approval Inbox:
  "3 בעלים בפרויקטים שהסתיימו חצו את חלון השמירה · [סקור למחיקה]". For a data-subject ACCESS request it may
  PROPOSE running the (reversible, audited) `dataExport`; for ERASURE it proposes ONLY — surfacing the candidates
  and the evidence.
- **What it may detect/propose vs NEVER auto-do:** MAY detect retention-horizon crossings + open requests; MAY
  propose the erasure candidate list with evidence; MAY auto-run nothing destructive. NEVER auto-erase (erasure
  is legal + IRREVERSIBLE — a hard human-confirm FLOOR, identical class to status→approved and national_id export).
  The proposal carries NO undo token (its eventual execution is irreversible) and APPROVE requires **step-up**
  (re-auth / MFA), exactly as the charter pins for irreversible acts. Detecting and proposing is safe; erasing is
  human-only with step-up.
- **mode:** detect + propose erasure = `propose-then-one-click-confirm` **with step-up + no undo** (effectively
  `human-only` at execute, machine-assisted at detect). Propose `dataExport` = propose-then-confirm (reversible).
- **humanConfirm:** mandatory, step-up. The system never crosses from "here are the candidates" to "I erased them."
- **engineCapability:** **recommender** (`RetentionWatcher` over project status + retention config + request flags)
  + **producer** (`emitProposal`). The executor for APPROVE replays the EXISTING `erase`/`dataExport` gated method
  verbatim — no new erase path, and the existing manager-tier + audit + erasure_log guarantees are inherited unchanged.
- **guardrail:** proposals list owner IDs + project context ONLY, never decrypted PII (no national_id in a
  proposal title/body — the charter's PII-free-proposal rule); step-up at APPROVE; the irreversible-no-undo pin;
  retention horizon is org-config, not hardcoded; security-reviewer required on the slice.
- **impact:** medium-high on compliance posture — turns RTBF/retention from "hope the manager remembers" into a
  watched, evidenced, one-click-but-step-up workflow, without ever risking an autonomous irreversible deletion.

### G5. Project-assignments — workload-aware agent assignment suggestion (process 17)
- **Today:** `apps/api/src/modules/project-assignments/project-assignments.service.ts` — manager manually
  assigns/unassigns agents to projects (`roleInProject`, soft `unassignedAt`). No load awareness; a new project
  sits unassigned until a human notices.
- **autonomousBehavior:** an `AssignmentRecommender` detects projects with NO active agent assignment (or a newly
  created project) and PROPOSES the best agent by **workload + scope** — fewest active assignments / lightest open
  attention load, optionally biased by geography or existing involvement: "פרויקט חדש ללא מטפל — הצע את יוסי
  (3 פרויקטים פעילים) · [אשר]". APPROVE replays the existing `create` (assign) gated method.
- **mode:** `propose-then-one-click-confirm`. Assigning a human to work is a people/responsibility decision — it is
  NOT auto even though it is internal + reversible, because it allocates a person's accountability (the charter
  treats human-assignment as propose-only, consistent with G1's task-assignment rule).
- **humanConfirm:** one-click APPROVE / ADJUST (pick a different agent) / DISMISS. Reversible (unassign) so the
  execution returns an undo token.
- **engineCapability:** **recommender** (a thin workload scorer over active `project_assignments` counts +
  attention load, reusing the `rankItems` scorer family) + **producer** (`emitProposal`) + **executor**
  (replays `create` verbatim, `actorType:'system'`).
- **guardrail:** suggests only ACTIVE org members (the existing membership validity check is re-run at execute);
  never auto-assigns; deduped per project so an unassigned project isn't re-proposed every tick; manager-only
  approve (mirrors the existing `requireManager` gate, re-checked at execute).
- **impact:** medium — removes the "new project languishes unassigned" gap and load-balances agents, while keeping
  the people-decision firmly one-click human.

### Other thin coverage (noted, kept tight)
- **Signature cancel vs resend (process ~36 family):** the plan covers expiry→re-issue and reminder cadence, but
  CANCELLING a stale/superseded signature request (vs resending) is under-addressed. Reconceive: cancel of a
  system-issued, never-signed request = `auto-execute-safe-reversible` (internal, reversible un-cancel); cancel of
  anything a human issued or that touches an owner = propose. Same producer family; one extra recommender branch.
- **Document archive / search-as-proactive (processes ~45–48 family):** search is purely pull today. A
  `DuplicateDocWatcher`/`StaleDocWatcher` could PROACTIVELY surface "2 byte-identical נסח uploads · [archive the
  dup]" (exact-hash dup auto-archive is already a charter example) and "this document supersedes an older one ·
  [archive old]" (propose). Folds into the Phase-4 dedup/checklist producers — no new mechanism.

## Design language (modern — the build standard for every autonomous surface)
Owner directive (2026-06-22): "with modern design." This is a build requirement on every new surface
(Approval Inbox, work-queue lists, situation headers, RowAction). It ELEVATES the existing token system
(`apps/web/src/app/globals.css`) — it does NOT fork it.
- **Foundation (keep):** Heebo 400/500 (no 700 in body); brand teal `--primary` (≈`#0d9488`) + navy +
  slate neutrals; `--radius-card`/`-control`; the motion tokens (`--motion-duration-fast/base/slow`).
- **Elevate (the "modern" delta):**
  1. **Generous whitespace + rhythm** — sections breathe (1.5–1.75rem); rows are airy (14–16px padding),
     never a dense spreadsheet.
  2. **Situation-first hierarchy** — the one-line living summary is the largest type on the surface (≈18px/500);
     the calm rest recedes (13–15px, `--text-muted`). The eye lands on "what's my situation" first.
  3. **Color ONLY for attention/action** — surfaces stay neutral; the teal brand accent is reserved for the
     primary CTA (the one-click [אשר]) + the brand mark; semantic bg/fg (success/warning) only on the
     attention state. No scary monospace masked-PII; no lone em-dash zero-states (use quiet "אין"/"הושלם").
  4. **Soft, friendly geometry** — cards/tiles `border-radius` 12–16px, 0.5px borders, FLAT (no heavy
     shadows); colored rounded icon-tiles (40px) lead each proposal row.
  5. **Tasteful micro-motion** — confirm = optimistic toast + a subtle `scale(.97)` press + the existing
     reduced-motion guard; progress rendered as a calm ring/sliver, not a loud bar.
  6. **One consistent component vocabulary** — the modern look ships THROUGH the shared primitives
     (WorkCollectionShell / RowAction / SituationSummary / the Approval Inbox card), so "modern" is enforced
     once and inherited everywhere, never re-styled per page.
- **Reference:** the modern Approval-Inbox mockup shown to the owner 2026-06-22 (teal CTA, ring situation
  card, airy proposal rows, calm icon tiles) is the visual target for the Phase-1 Inbox + Phase-3 board.
- **★ Voice & agency (the control law — owner-mandated, non-negotiable):** the system manages
  autonomously but the FEELING OF CONTROL stays with the USER. **NEVER system-first-person** ("הבוקר
  טיפלתי / תזמנתי / ניתחתי") — that makes the machine the hero and the user a passenger. Frame all
  autonomous work as the user's: "לפי הכללים שלך", "ממתין להחלטתך", "מוכן לאישורך", or neutral passive
  ("12 תזכורות הוכנו", "נסח נותח"). **Lead with the user's pending decisions** ("N החלטות ממתינות לך"),
  not the system's output count. CTAs stay the user's verb ([אשר]/[סקור ואשר]). Net test: does the string
  make the USER feel in command or the machine feel in charge? See [[feedback_user_keeps_control_not_system_voice]].

### Net effect on the engine
None of G1–G5 (nor the two thin-coverage notes) changes the 7-part engine. Every one is a new **recommender**
and/or **producer** that emits into the EXISTING proposal queue or executes through THE ONE BOUNDARY, reusing an
existing gated service method verbatim at execute time. The only DB seams are additive sentinels already implied by
the existing `actorType:'system'` union (`tasks.source='system'`, a system note/message author). The guardrail
charter, the human-confirm floors, and PROPOSE-FREELY/EXECUTE-NARROWLY bind them all unchanged.

---

## Design corrections — implementation-readiness red-team (2026-06-22)

> A design-quality red-team (owner-requested: *gaps in IMPLEMENTING the plan, not in going to
> prod*) reviewed the engine design against the real substrate (`autonomy-policy.ts`,
> `signature-expiry.handler.ts`, `signaturePulse`, `NotificationsProducerService`,
> `keyset-cursor.ts`, `external-shares.service.ts`). The plan is directionally sound but was
> **NOT implementation-ready as written** — failure semantics and the runtime shape of the ticks
> were under-specified. These corrections are BINDING on the build; a slice that ignores one is
> not merged. Three are MUST-FIX-before-building.

### MUST-FIX before any engine code

**M1 — Outbound is exactly-once, not "ledger-then-send" (root of duplicate-SMS).**
Every outbound carries a deterministic idempotency key = `recipient + cadence_step` (NOT
`proposal_id` — the exactly-once unit is per recipient+step, STABLE across re-proposals, so a
re-PROPOSAL of the same recipient+step collides with the parked row instead of minting a second
send; org scope comes from the `(org_id, idempotency_key)` UNIQUE half; `proposal_id` is kept only
as a non-key causal column). The `outbound_ledger` row has a UNIQUE constraint on it (proven idiom:
`import_jobs.idempotency_key UNIQUE`). Ledger row states are explicit: `pending_send -> sent ->
failed`. The OutboundGovernor
checks for a prior terminal `sent` on the key BEFORE sending; a retry after an ambiguous failure
re-checks delivery status, never blind-resends. "Ledger before send" gives attempt-durability, NOT
exactly-once — the key + UNIQUE + state machine is the root fix.

**M2 — Bulk-approve is per-item independent, NEVER atomic.**
`reminder.send` is `reversible:false`; a bulk approve of N sends cannot be one tx. Each proposal
apply is its own unit (own ledger row + idempotency key); the result is a per-item set
`{approved, failed, skipped}`; failed/unattempted proposals stay `pending` and remain actionable.
The inbox shows the partial result. Bulk-approve is presented as per-item, not transactional.

**M3 — Land the `sensitive => bytes_encrypted` DB invariant FIRST (root before symptom).**
The documents hardening currently orders read-routing (B1) before the DB constraint (B3). Reverse it:
the BEFORE-insert/update trigger that re-encrypts-or-rejects (or a deferrable CHECK within the encrypt
tx) leads, so EVERY writer — the existing three (`remediationSweep`, `update`-retype, the
`sensitive:true` setters) AND the future party-binder auto-file classifier — is structurally incapable
of producing `sensitive && !encrypted`. Read-path routing then becomes defense-in-depth, not the only
defense. Budget the raw-seeder ripple ([[project_schema_constraint_ripple]]); prefer the trigger-derive
form over a bare CHECK.

### HIGH — fix in the design before the relevant slice

**H-runtime — fleet snapshot + recommenders are SET-BASED on the maintenance pool, not per-org/per-project loops.**
`fleet_attention` recompute must be a single `GROUP BY project_id` statement (modeled on
`sweepExpiredSignatureRequests`, NOT the per-request `signaturePulse` per-project consent loop), and
**event-driven incremental** — recompute only the project whose consent epoch bumped, not the whole
fleet every tick. Recommenders (TaskWatcher/RetentionWatcher/AssignmentRecommender) **detect globally**
(one set-based query yielding `(org_id, rows)` across all orgs) and **write per-tenant** (the only
necessarily-scoped step). Never N transactions where 1 statement suffices ([[feedback_sub_second_interaction_budget]]).

**H-solid — OutboundGovernor is a gate pipeline, not a god-object.**
Decompose into composable, clock-injected gates behind `OutboundPolicy.evaluate(send) -> allow|deny|defer`:
`KillSwitchGate . ConsentGate . QuietHoursGate . RateCeilingGate . CircuitBreaker`. The Governor
orchestrates the list + writes the ledger; each gate is a pure independently-tested unit (mirrors
`AutonomyPolicy.classify` being a pure table).

**H-error — per-producer failure isolation in a multi-producer tick.**
Copying `maxRetries=0` "verbatim" from the single-statement sweep is wrong for a ~10-producer tick: one
producer throwing must NOT drop every producer's proposals. Each producer runs in its own try/catch
(like `NotificationsProducerService.emitMany`'s per-recipient isolation); a failure logs+Sentry+continues;
a missed producer recovers on its OWN next tick.

**H-generic — H1 is a contractor-portal MIGRATION, sequence it explicitly.**
"One resolver for contractor AND party" hides that the contractor portal authenticates via a flat-TTL
JWT over the legacy `shares` table, while `external_shares` has no read-consumer. Sequence H1 as: (a)
build the resolver over `external_shares`; (b) dual-write legacy contractor shares into it; (c) cut the
contractor read onto the resolver; (d) delete the legacy read + JWT-scope. Don't fold the cutover into
one roadmap letter, or you ship a THIRD path instead of unifying.

### MEDIUM — pin into the relevant slice DoD

- **Define `IRecommender` + a generic `ProposalProducer`** with a uniform dedup-key contract and three
  first-class flavors (periodic-scan . event-triggered-single-shot . batch-fan-out) — so G1–G5 are real
  drop-ins, not five bespoke wirings, and the `->approved` threshold + holdout chase-wave aren't special-cased.
- **Party is a STORED first-class axis** (`documents.party_type`, defaulted from a doc_type->party lookup
  at classify time, overridable) — not a render-time derivation. Per-party completeness + the G1
  auto-open/close task read the STORED truth, not a flag that can lie.
- **Execute-time re-check is one executor calling `classify(kind)` again** + a `kind`-registered
  revalidator registry — so "re-evaluate at execute" is structural, not per-type convention.
- **Tick non-reentrancy**: each periodic producer takes a pg advisory lock / pg-boss singleton — a tick is
  skipped if the prior is still running (prevents double-draft -> double-send, feeds M1).
- **Event bus publishes outbox-row-only** (transactional outbox); EventEmitter2 listeners only enqueue —
  no recommender logic on a request stack (esp. the unauthenticated public-sign completion path).
- **Decrypt-stream**: chunked decrypt (bound heap) + bounded concurrency (a semaphore in B1, not deferred
  to H5) + detect/abort on length-mismatch rather than silently truncating a 200.
- **All new pagination via the keyset helpers** (`keysetCondition`/`keysetOrderBy`) — never hand-rolled
  `lt(createdAt,…)`; and run `findUnappliedMigrations` against staging before shipping the ≥4 new autonomy
  migrations ([[project_migration_silent_skip_M1]]).
