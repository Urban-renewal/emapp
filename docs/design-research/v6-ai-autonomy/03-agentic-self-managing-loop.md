# 03 — The Agentic Self-Managing Loop + Autonomy Levels

> **Front:** the deterministic OBSERVE → DECIDE → PROPOSE → ACT → NARRATE → LEARN loop that
> makes EMAPP "a system that manages by itself" — and the per-action **autonomy levels** the
> manager dials. **Author:** AI/autonomy synthesis seat, 2026-06-18. Feeds the v6 synthesis.
>
> **The one-sentence thesis.** The entire loop runs on **deterministic rules with the LLM
> absent**. The LLM is a **swap-in enhancement of exactly ONE step (DECIDE)** plus an optional
> nicety on NARRATE. Pull the LLM and the loop keeps observing, deciding (by rules), proposing,
> acting, narrating (templated), and learning — **identical behaviour, dumber ranking**. This is
> the dual-mode law made concrete: AI never sits on a load-bearing path.
>
> **Grounding (verified in code, not aspirational).** This design adds NO net-new infra. It
> composes what already runs:
> - `apps/worker/src/main.ts` — pg-boss cron worker with **3 live sweeps** (reaper hourly,
>   audit-retention daily, signature-expiry hourly), the **concurrency-1 + two-step
>   register-then-schedule** pattern, and graceful SIGTERM drain. The loop is a **4th consumer**.
> - `packages/db/src/helpers/signature-expiry-sweep.ts` — the canonical **cross-org system
>   sweep**: BYPASSRLS `providerDb`, ONE atomic data-modifying-CTE statement, **one
>   `audit_log` row PER affected org** with `actor_type='system'`, `actor_id NULL`,
>   integer-count-only metadata (NO PII). The loop's ACT/LEARN writes copy this convention exactly.
> - `packages/shared-types/src/notification.ts` — the notification contract (**8 kinds today**;
>   none of `expiring`/`stalled`/`threshold_reached` exist yet — B3 adds them). User+org RLS scoped.
> - The build plan (`v4-readiness/00-FINAL-BUILD-PLAN.md`): **B1** = the pulse (OBSERVE aggregate),
>   **B3** = the cron consumer + 3 notification kinds (DECIDE/ACT/NARRATE skeleton), **M2** = the
>   one-tap chase (`resendSignatureRequest`, idempotent, 409-guarded), **M5** = campaign + preview
>   + failed-surface (ACT with dry-run). The **action-queue** ("what the system plans" + explain-chip
>   + undo + 'המערכת' actor badge) is the PROPOSE control surface.

---

## 0. Why this front exists, and the hard line it must not cross

The North Star doctrine is explicit: *"the system does the work; the developer just approves."*
Principle 2 — *"Act in the background; notify, don't task. Routine chasing runs automatically on
a cadence; only the true exceptions that need a human surface. The machine handles the 95%, hands
up the 5%."* That sentence **is** an agentic loop. This document specifies it as engineering.

The hard line, stated once and enforced everywhere below:

> **The deterministic core — every fact, every rule, the whole loop, all CRUD, the action-queue,
> the audit spine, the notification emission — runs with the LLM physically absent.** The LLM is
> reachable through ONE seam (`IDecisionProvider`, §6) wired into ONE step (DECIDE). It is wrapped
> in timeout + circuit-breaker + a Noop impl. When it is down / slow / rate-limited / mis-keyed /
> returns garbage, the loop **falls through to the rule-based ranker** and behaves identically but
> with dumber prioritization — **invisibly to the user**. No core flow may break, hang, or fail.

Three properties make this non-negotiable here specifically:
1. **The consent % is a LEGAL number** (build-plan A.1). The LLM is NEVER in the path that
   computes it, gates `approved`, or prints the committee record. AI may *narrate around* the
   number; it may never *produce or gate* it.
2. **PII is pgcrypto-encrypted and never logged** (`national_id`, `phone`, signatures). The LLM
   seam receives **derived signals only** (counts, days-stalled, status enums, ids) — never raw PII.
   See §7.
3. **The loop ACTS** (sends reminders, emits notifications). An autonomous action that fires
   wrongly is a real-world event (an owner gets a duplicate SMS). So ACT is governed by
   **autonomy levels** (§5) and is **idempotent + reversible + audited** by construction.

---

## 1. The loop at a glance — every stage maps to a REAL signal/endpoint

```
                 ┌──────────────────────────────────────────────────────────────┐
                 │  pg-boss cron consumer  (4th sweep; concurrency-1; BYPASSRLS) │
                 │  agentic-loop:tick   — runs on a cadence, per-org, idempotent  │
                 └──────────────────────────────────────────────────────────────┘
   OBSERVE  ──▶  read the deterministic world-state for the org
                signals = signature_requests.{signedAt,expiresAt,status,createdAt}
                          + ownerships.share + projects.status + reminder-memory (A1)
                source: the B1 pulse aggregate (projects.service.ts:537-581 orgStats CTE)

   DECIDE   ──▶  score each candidate action against RULES → a ranked list
                rankActions(signals) → Candidate[]  (pure, deterministic, testable)
                ░░ THE ONE LLM SEAM ░░  IDecisionProvider.rerank(Candidate[], context)
                                        → reordered/annotated Candidate[]   (OPTIONAL)

   PROPOSE  ──▶  write the chosen candidates into the ACTION QUEUE (proposed state)
                action_queue rows: {kind, target, payload, rationale, autonomy_level, state}
                surfaced in the FE "what the system plans" panel + explain-chip + undo

   ACT      ──▶  execute per the action's AUTONOMY LEVEL (§5)
                L0 wait for tap · L1 wait for tap · L2 auto + undo-window · L3 auto now
                real endpoints: resendSignatureRequest (M2), signature-campaign (M5),
                notification emit (B3). Idempotent + 409-guarded + audited.

   NARRATE  ──▶  tell the human, in plain Hebrew, what IT did / plans
                emit notification (B3 kinds) + the home "pulse sentence" + the daily digest
                templated copy by default; ░░ LLM may polish the prose ░░ (OPTIONAL)

   LEARN    ──▶  record the outcome on the action + reminder-memory; feed next OBSERVE
                action_queue.outcome {acted/undone/ignored/failed} + last_reminded_at (A1)
                deterministic feedback: cooldowns, undo-demotes-autonomy, score decay
```

Every arrow is a real artifact that the build plan already ships or front-loads. The LLM appears
in exactly **two optional spots** (DECIDE rerank, NARRATE polish), both behind the §6 seam.

---

## 2. OBSERVE — the deterministic world-state (no AI, ever)

OBSERVE is pure reads of facts the DB already holds. It NEVER calls the LLM (observing reality is
not a judgement call). It reuses the **B1 pulse aggregate** so OBSERVE and the FE home see the
same numbers — one source of truth.

**Signals (all already derivable; B1 pins the join):**

| Signal | Derivation | Source (verified) |
|---|---|---|
| `pendingCount` | `COUNT signature_requests WHERE status='pending'` per project | `signature_requests.status` |
| `nextExpiryAt` | `MIN(expires_at) WHERE status='pending'` | B1 `ProjectPulseRow.nextExpiryAt` |
| `stalledDays` | `now − MAX(signed_at)` per project | B1 `ProjectPulseRow.stalledDays` |
| `signedThisWeek` | `COUNT signed_at within 7d` | B1 `ProjectPulseRow.signedThisWeek` |
| `consentShare` | share-weighted CTE (B0 `ConsentCalcService`) | `ownerships.share_*` |
| `metThreshold` | B0 boolean (share-basis) | B0 |
| `lastRemindedAt` | per signature_request reminder-memory | A1 column |
| `projectStatus` | the D.18 enum | `projects.status` |

**Tenancy + cross-org.** The loop is a SYSTEM sweep across ALL orgs, exactly like the existing
expiry sweep. It connects via the **BYPASSRLS `providerDb` maintenance pool** (the documented,
bounded exception — `withTenant(orgId)` is per-org and physically cannot see the whole table).
But — critically — when the loop ACTS or NARRATES *for one org*, it does so under that org's
context so RLS-scoped rows (notifications are user+org scoped) land correctly. The pattern: the
cron tick reads cross-org cheaply, then **fans out per-org work units**, each executed in the
right tenant context.

**Dual-mode here: trivial — there is no AI in OBSERVE.** If the LLM is down, OBSERVE is byte-for-byte
identical. This is the foundation of the whole guarantee: *the system always knows the true state*.

---

## 3. DECIDE — the rule ranker IS the system; the LLM only re-ranks

This is the **only** stage the LLM touches, and it touches it as a **pure re-order of an already-
complete list**. The deterministic ranker produces a full, valid, ordered set of candidate actions
on its own. The LLM, if present, may reorder/annotate them. If absent, the rule order ships.

### 3.1 The deterministic rule ranker (the load-bearing default — A2 in the plan)

A pure function `rankActions(signals): Candidate[]`. No I/O, no AI, fully unit-testable. Each
candidate is a concrete, backable action (never a fabricated signal — build-plan A.2 register):

```ts
type Candidate = {
  kind: 'remind_holdout' | 'launch_campaign' | 'flag_expiring' | 'flag_stalled'
      | 'celebrate_threshold' | 'nudge_objection_followup';
  target: { projectId: string; signatureRequestId?: string; apartmentId?: string };
  rationale: RationaleCode;        // ENUM, not free text → templated Hebrew (NARRATE)
  score: number;                   // deterministic priority
  autonomyLevel: 0 | 1 | 2 | 3;    // resolved from org default + per-project override (§5)
  eligibility: 'reversible' | 'irreversible' | 'legal';   // gates max autonomy (§5)
};
```

**The scoring rules (illustrative, all deterministic):**
- `flag_expiring`: score rises as `nextExpiryAt` approaches (e.g. ≤72h = high). Eligibility
  `reversible` (it's just a notification).
- `remind_holdout`: eligible only if `lastRemindedAt` is outside the **cooldown** (e.g. >5 days —
  honours A1 reminder-memory so we never double-nudge). Score by `stalledDays`.
- `flag_stalled`: `stalledDays > threshold` AND `signedThisWeek == 0`.
- `celebrate_threshold`: client/edge-diff of `metThreshold` false→true. Eligibility `reversible`
  (a notification) — but the legal % itself is B0's, untouched.
- `launch_campaign`: many pending + none ever invited. Eligibility `irreversible` (sends real SMS)
  → capped at L1 (§5).

The ranker's output is **the product**. Everything downstream consumes `Candidate[]` whether or
not the LLM ran.

### 3.2 The LLM swap (the ONLY place AI plugs in)

```ts
interface IDecisionProvider {
  // Re-rank/annotate an ALREADY-VALID candidate list. MUST NOT invent
  // candidates, MUST NOT drop the deterministic fallback, MUST return a
  // permutation of the input ids (validated — see §6 guardrails).
  rerank(candidates: Candidate[], context: OrgDecisionContext): Promise<RerankResult>;
}
```

What the LLM *adds* when present: smarter prioritization ("this project has 3 holdouts but one is
an estate in probate — deprioritize the legal-blocked one, push the two reachable ones up"),
better cross-project triage at scale ("focus the manager on the 2 projects that will cross the
threshold this week if nudged, over the 5 that are stuck regardless"). It is **judgement
enhancement**, never fact production.

What it is structurally forbidden from doing (enforced in code, §6): inventing a candidate the
ranker didn't produce, changing a `target`, changing an `eligibility`, changing an
`autonomyLevel`, or touching the consent number. It returns **a permutation + optional score
nudges + an optional one-line rationale string**, validated by Zod against the input set. Anything
out of contract → **discard the LLM output, ship the rule order**.

### 3.3 Dual-mode proof for DECIDE

| LLM state | Behaviour |
|---|---|
| Healthy, in-contract | Ranker runs → LLM reorders → validated → **enhanced order** ships |
| Down / timeout / 5xx | Circuit-breaker open → **rule order ships**, identical loop, dumber priority |
| Returns invalid/garbage | Zod-validate fails → **discard, rule order ships** |
| Not configured (Noop) | `NoopDecisionProvider.rerank` returns input unchanged → **rule order ships** |

**The user never sees a difference in capability** — only (when AI is on) a slightly smarter
ordering of the same proposals. The action-queue, the chase, the celebration all work with the LLM
unplugged. This is the dual-mode law satisfied at the exact step where AI lives.

---

## 4. PROPOSE → ACT → NARRATE → LEARN (deterministic execution)

### 4.1 PROPOSE — the action queue (the control surface)

Each chosen candidate is written as an `action_queue` row in **`proposed`** state. This is the
"what the system plans" panel: each row renders plain-Hebrew rationale (templated from
`RationaleCode`), an **explain-chip** ("למה זה? → חסרה חתימה אחת, פג תוקף בעוד יומיים"), the
**'המערכת' (the system) actor badge**, and — depending on autonomy level — either an approve tap,
a countdown-to-auto with undo, or a past-tense "done" line. **PROPOSE never calls the LLM** (the
rationale is a templated enum, not generated prose, so it's honest and offline-safe).

Schema (mirrors the system-audit convention — integer/enum metadata, no PII):
```
action_queue (
  id, org_id, kind, target_json, rationale_code, autonomy_level, eligibility,
  state ENUM('proposed','approved','acting','acted','undone','ignored','failed'),
  proposed_at, decided_at, decided_by NULL=system, outcome_json, dedupe_key
)
```
`dedupe_key` = `(org, kind, target, observation-window)` → **idempotent proposing**: a re-tick
that re-observes the same holdout does NOT create a second proposal (`ON CONFLICT DO NOTHING`, the
proven pattern). This is what makes "runs on a cadence" safe.

### 4.2 ACT — execute per autonomy level, idempotent + reversible + audited

ACT calls **real existing endpoints**, never new magic:
- `remind_holdout` → `resendSignatureRequest` (M2): `postIdempotent` over
  `POST /signature-requests/:id/resend` — already audited, already 409-guarded
  (`recipient_not_associated`). The optimistic-snapshot IS the undo.
- `launch_campaign` → `POST /projects/:id/signature-campaign` (M5) — gated by the
  `CAMPAIGN_SEND_ENABLED` kill-switch (N15) and the M5 preview/dry-run.
- `flag_*` / `celebrate_*` → emit a B3 notification kind (`expiring`/`stalled`/`threshold_reached`).

Every ACT writes an `audit_log` row with `actor_type='system'`, `actor_id NULL`, action like
`agentic.remind_holdout`, **integer/enum metadata only (no PII)** — copying
`signature-expiry-sweep.ts` exactly. The action_queue row transitions `proposed→acting→acted`
(or `failed` with a reason code) **atomically with** the audit write, same single-statement
discipline as the expiry sweep.

**ACT never calls the LLM.** Executing a decision is deterministic plumbing.

### 4.3 NARRATE — templated by default, LLM-polished optionally

The honest default is **templated Hebrew** keyed off `RationaleCode` + counts:
*"כמעט שם — חסרה חתימה אחת, של דירה 7. שלחתי תזכורת אתמול."* (note: holdout NAME only once B4
ships the PII-gated read; until then "דירה 7" — build-plan A.2). Channels: the B3 notification, the
home pulse sentence, the daily digest.

The LLM's *optional* second touch: rewrite the templated sentence into warmer/clearer prose. Same
seam discipline — if it's down or returns junk, **the template ships**. Crucially the LLM here
receives **already-composed, PII-free templated text + counts**, never raw owner data, and its
output is **display-only** (it cannot change what was done — ACT already happened). A nicer
sentence is the *only* thing at stake, so an LLM failure is invisible.

### 4.4 LEARN — deterministic feedback, no AI

LEARN records outcomes that shape the next OBSERVE/DECIDE:
- `action_queue.outcome` = `acted | undone | ignored(expired) | failed`.
- **Reminder-memory (A1)**: a successful `remind_holdout` stamps `last_reminded_at` → the cooldown
  rule in §3.1 suppresses re-proposing for N days. **This is learning without an LLM** — the system
  measurably stops nagging.
- **Undo as a signal**: if a manager repeatedly UNDOES an auto-action for a project, the loop
  **auto-demotes that action's autonomy level** for that project (e.g. L2→L1) and records why. A
  deterministic "the user disagrees with me here, ask first" rule.
- **Ignored proposals**: expire out of the queue and lower that candidate kind's score via a simple
  decay — no model required.

The LLM could *later* enhance LEARN (spot patterns across orgs), but that is explicitly **out of
v6 scope** and would still be advisory over a deterministic feedback store. v6 LEARN is 100% rules.

---

## 5. AUTONOMY LEVELS — the manager's dial (the core deliverable)

The manager dials **how much the system may do on its own, per action kind**, with an org default
and per-project override. Four levels:

| Level | Name | Behaviour | UX |
|---|---|---|---|
| **L0** | **Suggest-only** | Loop OBSERVEs/DECIDEs/PROPOSEs; ACT requires an explicit tap. | Action-queue row with an "approve" button. The dumbest-safe default. |
| **L1** | **One-tap-approve** | Same, but the proposal is pre-composed (recipients/message/timing all defaulted). One tap acts. | "שלח תזכורת לדירה 7?" → tap. The doctrine's "propose, don't ask." |
| **L2** | **Auto-with-undo-window** | Loop ACTS automatically, but holds a **visible undo window** (e.g. 60 min) before the effect is irreversible-ish. | Toast/queue row: "שלחתי תזכורת — בטל" with a countdown. Undo over confirm (doctrine #6). |
| **L3** | **Full-auto-audited** | Loop ACTS immediately, no window. Surfaces only in the digest + audit. | Past-tense narration only: "נשלחו 4 תזכורות הבוקר." Every one audited. |

### 5.1 Eligibility caps (which actions may reach which level)

The action's `eligibility` (computed deterministically, NOT by the LLM) **caps** the maximum
selectable autonomy. The manager can dial *down* but never *above* the cap:

| Eligibility | Examples | Max autonomy | Why |
|---|---|---|---|
| **reversible** | flag_expiring, flag_stalled, celebrate_threshold (notifications); a reminder resend | **L3** | A duplicate notification / reminder is low-harm and idempotent-guarded. |
| **irreversible** | launch_campaign (real SMS fan-out to many owners), first-contact send | **L1** | A mass SMS can't be unsent; a human taps. The M5 preview shows who-gets-it first. |
| **legal** | mark `approved`, anything touching the consent % / committee record | **L0 only** | Build-plan B5: `approved` needs `metThreshold` + a human. The system NEVER auto-crosses a legal line. |

This table is the safety spine: **the most autonomous the loop can ever be on a legal action is
"suggest"**, and the LLM can't change that (eligibility is set by the ranker, validated against
LLM output). Reversibility, not capability, sets the ceiling.

### 5.2 Defaults + override resolution

- **Org default** (a settings row): conservative out of the box — `reversible → L1`,
  `irreversible → L0`, `legal → L0`. Zero-setup doctrine: it works on day one with no config,
  purely suggest/one-tap, and the manager *opts into* more autonomy as trust grows.
- **Per-project override**: a project can raise reversible actions to L2/L3 (e.g. a hot project the
  manager wants chased aggressively) or lower everything to L0 (a sensitive project).
- **Resolution**: `effectiveLevel = min(eligibilityCap, override ?? orgDefault)`. Pure, testable,
  one function. Stored as plain config rows; **no AI involved in resolving autonomy** — a hard
  requirement (you must be able to reason about what the system is allowed to do without a model
  in the loop).

### 5.3 Dual-mode + autonomy interaction

Autonomy levels are **fully independent of the LLM**. With AI off, the loop still proposes (rule
order), still auto-acts at L2/L3 within caps, still narrates (templated). The LLM only changes
*which* proposals rank highest — never *whether* the loop is allowed to act. So a manager who set
"reversible → L2" gets auto-reminders whether or not Gemini is reachable; AI just makes the
*choice of who to remind first* smarter when it's up.

---

## 6. The seam — `IDecisionProvider`, circuit-breaker, Noop (dual-mode in code)

Mirrors the existing DI provider seams (`IEmailProvider`, `ISMSProvider`, `IExtractionProvider`/
`StubExtractionProvider` via `extraction-provider.factory.ts`). A new
`decision-provider.factory.ts`:

```ts
// The contract (pure; no Nest/env in shared-types).
interface IDecisionProvider {
  rerank(candidates: Candidate[], ctx: OrgDecisionContext): Promise<RerankResult>;
}

// Default wiring:
//   NoopDecisionProvider     — returns input unchanged. The dual-mode floor.
//   GeminiDecisionProvider   — calls Gemini (Infisical-keyed, as the owner already runs elsewhere),
//                              wrapped in the breaker below. Lands as a LATER wave.
```

**The breaker wrapper (the dual-mode guarantee in one place):**
```ts
class GuardedDecisionProvider implements IDecisionProvider {
  async rerank(c, ctx) {
    if (this.breaker.open) return { order: c };            // fast-path to rules
    try {
      const out = await withTimeout(this.inner.rerank(c, ctx), 2000);   // hard 2s cap
      const validated = RerankResultSchema.safeParse(out);              // Zod contract
      if (!validated.success || !isPermutationOf(validated.data, c)) {  // structural guard
        this.breaker.recordFailure();
        return { order: c };                                            // rules win
      }
      this.breaker.recordSuccess();
      return validated.data;
    } catch {
      this.breaker.recordFailure();   // timeout / 5xx / network
      return { order: c };            // rules win — INVISIBLE soft-degrade
    }
  }
}
```

Guarantees baked in: **hard timeout** (the loop never hangs waiting on Gemini — it's a background
cron, but still bounded), **circuit-breaker** (after K failures, stop calling for a cooldown — no
cost/latency storm), **structural validation** (LLM can only ever return a permutation of the
ranker's own candidates — it cannot inject, retarget, or escalate), and a **Noop floor** (unkeyed
env = full function). Cost is bounded because the LLM sees **small derived candidate lists, not
documents** — a few hundred tokens per org per tick, and the breaker caps spend on failure.

---

## 7. Safety, PII, cost, latency — honest risk register

| Risk | Mitigation (engineering-real) |
|---|---|
| **PII to the LLM** | The seam receives `Candidate[]` = counts, days, status enums, project/apartment **ids** — **never** `national_id`/`phone`/signature/name. NARRATE polish gets templated PII-free text. A static guard asserts the `OrgDecisionContext` type excludes PII fields. The pino redact list already strips PII from worker logs. |
| **LLM fabricates a decision** | Structurally impossible by §6: output is validated as a **permutation of the ranker's candidates**. It cannot invent an action, a recipient, or a number. |
| **LLM touches the legal consent %** | The consent number is computed by B0 `ConsentCalcService` and never passes through the seam as a writable field. `legal`-eligibility actions are L0-capped (§5.1). The LLM literally has no path to it. |
| **Auto-action fires wrongly (duplicate SMS)** | `dedupe_key` + `ON CONFLICT DO NOTHING` proposing; ACT calls 409-guarded idempotent endpoints (M2/M5); irreversible actions capped at L1 (human taps); L2 gives an undo window. The `CAMPAIGN_SEND_ENABLED` kill-switch (N15) + org-suspend are the hard stops. |
| **Cost / token spend** | Small candidate lists, not documents; breaker caps spend on repeated failure; the loop runs on a cadence (hourly-ish), not per-request. Estimable and bounded; the Noop floor means $0 if AI is off. |
| **Latency / hang** | Hard 2s timeout + breaker. The loop is background cron, so even the worst case never touches a user request. |
| **Runaway autonomy** | Eligibility caps + conservative org defaults + per-project override + the undo-demotes-autonomy LEARN rule + full `actor_type='system'` audit trail. Every autonomous act is reconstructable from `audit_log`. |
| **Concurrency / double-tick** | Concurrency-1 consumer (the proven worker pattern) + idempotent dedupe_key + single-statement atomic ACT+audit, exactly like the 3 existing sweeps. |

---

## 8. Sequencing — AI-ready NOW, AI lands as a clean later wave

The build plan already front-loads the entire **deterministic skeleton**; this front needs no
new infra, only the action-queue table + the seam stub.

**Foundation (already in the plan — ship these and the loop runs deterministically):**
- **B1** — pulse aggregate = OBSERVE.
- **B3** — the 4th cron consumer + the 3 notification kinds = the loop's heartbeat + NARRATE channel.
- **M2 / M5** — the idempotent ACT endpoints (+ M5 preview/kill-switch).
- **A1 / A2** — reminder-memory + rule ranker = LEARN + DECIDE(rules).
- The **action-queue** control surface (explain-chip + undo + 'המערכת' badge) = PROPOSE.

**This front adds (deterministic, no AI):**
- `action_queue` table + the proposing/dedupe logic.
- The **autonomy-level config** (org default + per-project override + eligibility caps + resolver).
- The `decision-provider.factory.ts` seam shipping **`NoopDecisionProvider` only** — so the loop is
  **AI-ready** but ships fully functional with zero AI.

**The later AI wave (clean swap, isolated):**
- `GeminiDecisionProvider` behind `GuardedDecisionProvider` → DECIDE re-ranking.
- Optional NARRATE prose polish.
- Both are pure additions behind the seam; removing them reverts to the v6-shipped behaviour. No
  core code changes — the dual-mode law is what makes the AI wave low-risk.

---

## 9. The doctrine check (every surface answers the rubric)

- **Propose, don't ask** ✓ — the action-queue pre-composes; the manager approves (L1) or watches (L2/L3).
- **Act in the background; notify, don't task** ✓ — the cron loop is the background; NARRATE is the
  notify; the 5% (objections, legal) surface as L0 proposals.
- **Zero-setup smart defaults** ✓ — conservative org defaults work on day one, no config.
- **One tap** ✓ — L1 is literally one tap; the chase reuses M2's `<RemindHoldoutButton>`.
- **Speak like a competent assistant reporting what IT did** ✓ — templated past-tense Hebrew,
  LLM-polished only as a nicety.
- **Reversible by default, undo over confirm** ✓ — L2 undo window; irreversible capped at L1;
  legal capped at L0.
- **Never a dead-end** ✓ — failed actions surface a reason code + a remedy, never a bare error.
- **Never fabricate** ✓ — proposals are backed by real signals; the LLM can only permute, never
  invent; future-nudge copy waits for B3 (A.2).

---

## 10. Open decisions (for synthesis / owner)

1. **Loop cadence** — hourly (aligns with the existing expiry/reaper ticks) vs a tighter cadence
   for hot projects. Recommendation: hourly base, with a same-tick "act now" path for L1 taps.
2. **Default autonomy posture** — ship org default at `reversible→L1` (recommended) or the even-
   more-conservative `reversible→L0` (pure suggest) for the very first customers. Owner call.
3. **Undo-window length** for L2 (proposed 60 min) — must exceed SMS-send latency so "undo" is real.
4. **Whether the AI wave is a launch requirement or post-MVP** — per the build plan, B3 (the
   deterministic loop) is the gate; the LLM swap is explicitly post-MVP unless the owner wants
   AI-smart triage at launch. The loop is fully valuable **without** it.
5. **Per-action-kind vs per-eligibility-class autonomy granularity** — recommend per-eligibility-
   class for v6 (simpler mental model), per-kind later if managers want it.
