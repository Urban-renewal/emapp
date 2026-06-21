# 00 — EMAPP AI-NATIVE PLAN (v6 synthesis: self-managing, AI-native, DUAL-MODE)

> **Role:** AI/Architecture Lead synthesis of the four v6 fronts
> (`01-ai-architecture-seam.md` · `02-ai-usecases-ranked.md` ·
> `03-agentic-self-managing-loop.md` · `04-ai-safety-trust.md`) into ONE buildable
> answer, folded into `v4-readiness/00-FINAL-BUILD-PLAN.md` **without delaying Wave 0**.
> **Status:** DEFINITIVE design proposal for the v6 AI/autonomy wave. READ-ONLY — no app
> code changed by this document. Author: AI/Architecture Lead seat, 2026-06-18.
>
> **The owner's bar (the thing this plan must satisfy):** *"EMAPP is NOT a system that
> stores files or documentation — it is a system that MANAGES BY ITSELF. In the future
> there will also be an AI connection like GEMINI."* And the elevated, non-negotiable
> constraint: **the system MUST work FULLY both WITH and WITHOUT the AI layer.** AI is a
> strictly OPTIONAL enhancement of a single step, never a load-bearing dependency.
>
> **The one-sentence synthesis.** EMAPP becomes self-managing through a *deterministic*
> agentic loop (OBSERVE→DECIDE→PROPOSE→ACT→NARRATE→LEARN) that already has its skeleton in
> the build plan; the LLM plugs into exactly ONE step (DECIDE) of that loop plus a handful
> of single-step *enhancements* (extract / draft / digest), each behind a DI seam with a
> circuit-breaker, a Noop default, and a deterministic fallback that **is already the
> current shipping path** — so deleting the LLM is a no-op for correctness, only quality
> changes.

---

## 1. AI-READINESS VERDICT

**Verdict: `AI-READY-BY-CONSTRUCTION, AI-ABSENT-BY-DEFAULT`.** The foundation is genuinely
AI-ready *today*; the AI wave is gated almost entirely on a **legal/DPA decision** (the
first real PII egress), not on engineering. That is the correct place for the gate to sit.

The evidence, grounded in real code (verified across the four fronts):

- **The seam pattern already exists and is proven.** EMAPP ships five substitutable DI
  provider seams — `IEmailProvider`, `ISMSProvider`, `IExtractionProvider`
  (`extraction-provider.factory.ts` → today a `StubExtractionProvider`), `IFileScanProvider`,
  `IParcelDataProvider` — each a **token + factory + interface + Noop/Stub default**. The
  AI layer is *the same pattern, twice* (`IAiProvider` low-level gateway + `IDecisionProvider`
  decision seam). No new architectural concept is required.
- **The flagship AI win is one drop-in away.** The tabu (נסח-טאבו) extraction lifecycle —
  staging table (`tabu_extraction_rows`), pgcrypto encryption, the D.7c mandatory
  human-confirm review, atomic `confirm()` commit with hash-match dedup — is **fully built**
  and runs on a deterministic Stub today. A `GeminiExtractionProvider` is a drop-in behind
  `IExtractionProvider.extract()`; nothing downstream changes.
- **The agentic skeleton is in the plan and adds no net-new infra.** The pg-boss worker
  already runs 3 live cron sweeps; the loop is a **4th consumer**. `audit_log` already
  carries `actor_type='system'` rows. The build plan front-loads B1 (the pulse = OBSERVE),
  A2 (the rule ranker = DECIDE-by-rules), B3 (the cron consumer + 3 notification kinds =
  the heartbeat + NARRATE), M2/M5 (the idempotent ACT endpoints), A1 (reminder-memory =
  LEARN), and the action-queue (PROPOSE).
- **The safety discipline is built and proven.** `runExtraction()→stage→encrypt→human
  confirm→deterministic commit` is the exact firewall shape every future AI feature reuses;
  pino PII-redaction is already the egress wall on worker logs.

**What "AI-ready" does NOT mean (honest):** the seam does not make EMAPP "AI-native" by
itself — it makes it **AI-capable-on-a-config-flip**. The self-managing value lands when the
deterministic loop ships (it is valuable with zero AI); the AI enhances that value later
without ever becoming a dependency.

---

## 2. THE ARCHITECTURE — TWO SEAMS + A DECISION SEAM + THE DATA-EGRESS BOUNDARY

### 2.1 Two seams, and why two

```
   HIGH-LEVEL (domain)   IDecisionProvider  — "what should we do, in what order?"
   the DECIDE step       RuleDecisionProvider   (default, FOREVER fallback = the A2 ranker)
                         GeminiDecisionProvider  (later; wraps IAiProvider; delegates to Rule on ANY failure)
                                        │
                                        ▼
   LOW-LEVEL (gateway)   IAiProvider  — "talk to an LLM, safely, PII-free"
                         NoopAiProvider     (default; every run() → AiFailure('disabled'))
                         GeminiAiProvider   (Infisical-keyed; = circuit-breaker + egress-scrub + Zod-validate)
```

- **`IAiProvider`** — a low-level, capability-typed LLM gateway with ONE method,
  `run<TOut>(req): Promise<AiResult<TOut> | AiFailure>`, across capabilities
  `extract | draft | summarize | answer | classify`. Cost / latency / circuit-breaker /
  redaction / Zod-validation live in **one place**. Lives at
  `packages/db/src/providers/ai/ai.interface.ts`; token + factory at
  `apps/api/src/modules/ai/ai-provider.factory.ts` (+ a worker-side mirror).
- **`IDecisionProvider`** — a high-level *decision seam* that puts the loop's DECIDE step
  behind its own interface (`rankActions()` / `rerank()`). `RuleDecisionProvider` is the
  forever-fallback (it **is** the A2 next-best-action ranker, useful day one);
  `GeminiDecisionProvider` is a thin wrapper over `IAiProvider`.

**Why split them:** keeping DECIDE behind its *own* interface means the agentic loop depends
on `IDecisionProvider`, **not on the LLM**. Removing Gemini reverts DECIDE to rules
automatically, zero changes to OBSERVE/PROPOSE/ACT/NARRATE. The low-level seam is reused by
the *non-loop* features (tabu extract, draft, digest) that never go through DECIDE.

### 2.2 The type encodes the dual-mode contract

```ts
// run() returns a FAILURE, it does not throw for an AI fault.
export interface AiFailure {
  ok: false;
  reason: 'disabled' | 'circuit_open' | 'timeout' | 'rate_limited'
        | 'invalid_output' | 'provider_error';   // PII-free by construction; safe to log/audit
}
export interface IAiProvider {
  run<TOut>(req: AiRequest<TOut>): Promise<AiResult<TOut> | AiFailure>;
  status(): { enabled: boolean; circuit: 'closed' | 'open' | 'half_open' };
}
```

Three decisions baked into the type:
1. **`run()` never throws for an AI fault** — a caller cannot accidentally let an LLM outage
   bubble as a 500. The *only* throw is the PII-egress guard (a programmer-error, fail-closed).
2. **`schema` is mandatory** — there is no "give me the raw string" method. Output is always
   `z.parse()`'d (satisfies CLAUDE.md "no `unknown` without z.parse()"), so a hallucination
   that breaks the schema is an `AiFailure('invalid_output')` → fallback, never a bad write.
3. **`promptId` + structured `input`, not free text** — prompts are **versioned in-repo
   templates**, bounding prompt-injection surface; user questions enter as a *redacted input
   variable* into a fixed template, never as the system prompt.

### 2.3 The factory — no production fail-fast (AI is fail-OPEN)

`aiProviderFactory()` returns `GeminiAiProvider` only when `AI_PROVIDER=gemini` **and**
`GEMINI_API_KEY` (Infisical, never `.env`); otherwise `NoopAiProvider`. **Unlike SMS/scan,
there is NO production fail-fast** — absence of AI is a legitimate production default (mirrors
the extraction/parcel factories). A deploy with no AI creds is a fully-functional product
identical to today.

### 2.4 The PII / data-egress boundary (the most important section)

**Hard rule (CLAUDE.md, non-negotiable):** `national_id`, `phone`, signatures are PII,
pgcrypto-encrypted, **never logged, never in error messages — and never sent to the LLM**
except the one owner-gated, audited multimodal case.

| Data | To the LLM? | How |
|---|---|---|
| `national_id` | **NEVER** on the text path | the loop/draft/digest reason over counts/days/status-enums/ids only |
| `phone` | **NEVER** | resolved deterministically at send time by `ISMSProvider`, after human approval |
| signature blobs | **NEVER. No exception.** | non-repudiation evidence; never any prompt, embedding, or log |
| owner **name** | **only via an opaque token** (`OWNER_1`/`APT_7`), re-substituted in-process after the model returns | tokenize-by-default for drafting; real name never crosses the network unless org opts into personalization |
| aggregates: counts, `stalledDays`, `signedThisWeek`, urgency, share-weighted % | **YES** | the *only* thing DECIDE/summarize/digest see — PII-free by construction |
| apartment **labels** ("דירה 7") | **YES** | apartment numbers are not PII; names are |
| the tabu **PDF bytes** (contains national_id) | **YES — the ONE exception** | `extract` capability only; owner-gated `ai_extraction_enabled` + DPA; finalized + AV-clean; re-encrypted on return; audited (`engineId`+`byteCount`, never content) |

Two enforcement layers make this structural, not aspirational:
- **A fail-closed `PiiRedactor` egress scrub** sits between every draft/explain/rank call and
  the network (it does NOT sit on the tabu-extract path, where the document content *is* the
  payload by design). It tokenizes names/phones by default and **throws** on any string
  matching an Israeli national_id (9-digit Luhn) or a signature marker — the AI-layer analogue
  of the pino redact wall. **The prompt body is NEVER logged** — the audit row records only
  `{ promptKind, tokenCount, redactedFieldKinds, model, engineId }`.
- **AI does not bypass RLS.** Worker AI jobs run inside `withTenant(orgId, fn)` using a system
  principal exactly like the existing cron sweeps; the LLM call is a leaf that receives only
  the already-redacted aggregate. No AI code path touches `db.query` directly. Every AI call
  is audited under a distinct **`actorType:'ai'`** actor (a one-line CHECK-constraint migration
  widening `actor_type IN ('user','system','provider')` → `+'ai'`) with the **'עוזר AI' badge** —
  never attributed to a human or to 'המערכת'.

---

## 3. THE DUAL-MODE GUARANTEE (each feature's concrete non-AI fallback)

**The governing law (owner-elevated, first-class):** the deterministic CORE — facts, rules,
the entire agentic loop, all CRUD, the action-queue — runs WITHOUT the LLM. The LLM only
ENHANCES a step. An AI-layer failure (down / slow / rate-limited / mis-keyed / garbage /
cost-cap-hit) is an **invisible soft-degrade**, never an outage, never a hang, never a
corruption. The mechanism: **timeout + three-state circuit-breaker + a Noop impl** in `GeminiAiProvider`
so a Gemini outage costs ~0 ms (the breaker short-circuits, no pile of timeouts).

The enumerated degrade matrix — **in every row, a core flow continues:**

| Failure mode | What the seam does | What the user sees |
|---|---|---|
| No creds / `AI_PROVIDER` unset | `NoopAiProvider`, every `run` → `disabled` | identical to today's product; rule-ranker + manual everywhere |
| Gemini down / timeout | breaker trips → `circuit_open` immediately | slightly plainer Hebrew phrasing; everything works; calm "העוזר לא זמין כרגע" chip |
| Rate-limited / over-concurrency | `rate_limited` | this loop tick uses the rule-ranker; next tick retries |
| **Monthly cost-cap hit** | provider returns `disabled` until period reset | whole product reverts to no-AI; owner notified; **no surprise bill** |
| Malformed / hallucinated output | `zod.parse` fails → `invalid_output` | fallback path; **no bad data written** (schema + domain rules block fabrication) |
| Request still contains PII (a bug) | egress scrub **throws** (fail-closed) | that one AI call fails → fallback; **PII never leaves**; alert fires |

**Each feature's non-AI fallback (the "AI OFF" column — the most important column):**

| AI feature | Non-AI fallback (ALREADY the shipping path where noted) |
|---|---|
| **Tabu/נסח extraction** | `StubExtractionProvider` (deterministic, no external call) → **manual owner/share entry** (N11). The mandatory D.7c human-confirm flow is unchanged. *(Already ships today.)* |
| **AI-drafted messages** | the seam's default impl is a **deterministic Hebrew template** with the same data slots; identical send flow, less polished prose. The number-echo validator runs in BOTH paths. *(The copy the product ships today.)* |
| **"While you were away" digest** | the assembler produces a **structured object first**; AI only smooths it. Render the **deterministic bulleted version** of the same object. *(Pure cosmetic uplift — the strongest dual-mode case.)* |
| **DECIDE / next-best-action rank** | `RuleDecisionProvider` (the A2 deterministic ranker) — the load-bearing default; the LLM only re-orders an already-complete candidate list. |
| **NARRATE prose** | templated past-tense Hebrew keyed off a `RationaleCode` enum; the LLM polish is display-only and cannot change what ACT already did. |
| **NL assistant** | the normal UI — project page, the "מי תקוע" list, global search (S4), the reminder button. The assistant routes to deterministic search + deep-links when AI is off. |
| **Committee / lawyer pack** | the **C1 print-of-record** (deterministic, basis-labeled legal artifact) + the `export` xlsx/pdf. AI writes only a prose preamble; the legally-load-bearing content is NEVER AI-generated. |

---

## 4. RANKED USE-CASES + THE FIRST WAVE

Scored `(Value × Feasibility) ÷ Risk`, grounded in real code. The **AI-OFF column** decides
the ranking: a use-case without a fully-usable non-AI fallback does not ship.

| # | Use-case | Score | Wave |
|---|---|:-:|:-:|
| **1** | **Tabu/נסח PDF extraction → owners+shares** | **12.5** | **W1** |
| **2** | **AI-drafted messages** (reminder / committee paragraph) | **10.0** | **W1** |
| **3** | **"While you were away" digest** | **8.0** | **W1** |
| 4 | NL assistant ("מה מצב הרצל 42?" / "מי לא חתם") | 5.0 | W2 |
| 5 | Committee / lawyer summary pack | 5.3 | W2 |
| 6 | Insight / anomaly (cohort recovery) | 2.7 | W3 |
| 7 | Predictive — who will delay / object | 0.6 | **DEFER** (profiling/PII wall; the deterministic ranker is the *correct* design, not a degraded one) |
| 8 | AI objection-response drafting | 0.75 | **BLOCKED on B2** (no `decline_reason` field exists today) |

**The first AI wave = #1, #2, #3** — chosen specifically because each one's non-AI fallback
*is already the current shipping path*, so dual-mode is proven before a single Gemini call is made:

1. **Tabu extraction** — drop-in behind `IExtractionProvider`; the confirm gate, encryption,
   and audit are already built. Smallest effort, biggest "it did the work" payoff. **Start here.**
2. **AI-drafted reminders + committee paragraph** — rides messaging/reminder rails; manager
   approves; numbers injected as ground truth + a shared **number-echo validator** rejects any
   draft whose numbers don't match the facts.
3. **"While you were away" digest** — safest data path (aggregates + audit, no raw PII); pure
   phrasing over B1 + audit.

**Why not the NL assistant first** (despite Value 5): it depends on B1 *and* carries the
"...ולמה?" fabrication trap (needs B2's objection field to answer honestly) plus a tool-calling
+ prompt-injection hardening cost. It is the right *second* wave, with the normal UI as its
standing fallback. Its hard architecture rule: **tool-calling over RLS-scoped reads, never raw
table-to-prompt.**

---

## 5. THE AGENTIC LOOP + AUTONOMY LEVELS

The loop runs as a **4th pg-boss cron consumer** (alongside the 3 live sweeps), reusing the
proven concurrency-1 / BYPASSRLS-cross-org-read / single-statement-atomic-ACT+audit pattern.
Every stage maps to a real signal/endpoint, and **the LLM plugs into exactly ONE step (DECIDE)**
plus an optional NARRATE polish:

```
OBSERVE  ──▶  B1 pulse aggregate (counts/days/status, PII-free)            [no AI, ever]
DECIDE   ──▶  rankActions(signals) → Candidate[]  (pure, deterministic = A2)
             ░ the ONE LLM seam: IDecisionProvider.rerank() — a Zod-validated PERMUTATION only ░ [optional]
PROPOSE  ──▶  action_queue rows (proposed) + explain-chip + undo + 'המערכת' badge  [no AI]
ACT      ──▶  existing idempotent 409-guarded endpoints: M2 resend / M5 campaign / B3 emit  [no AI]
NARRATE  ──▶  templated Hebrew (RationaleCode enum) via B3 kinds + digest   [LLM polish optional]
LEARN    ──▶  A1 reminder-memory cooldowns · undo-demotes-autonomy · score decay  [zero AI]
```

The LLM is **structurally forbidden** (enforced in code) from inventing a candidate, changing
a `target`/`eligibility`/`autonomyLevel`, or touching the consent number. It returns a
permutation + optional score nudges; anything out of contract → **discard, ship the rule order**.
The guard wrapper: hard 2s timeout + circuit-breaker + `isPermutationOf()` structural check +
Noop floor — a Gemini fault produces the *exact deterministic output* the loop would have used.

**Autonomy levels — the manager's dial, per action kind, hard-capped by deterministic eligibility:**

| Level | Behaviour | Eligibility → max cap |
|---|---|---|
| **L0 — Suggest-only** | propose; ACT needs an explicit tap | **legal** (mark `approved`, consent %) → **L0 ONLY** |
| **L1 — One-tap-approve** | pre-composed proposal; one tap acts | **irreversible** (mass SMS campaign) → **L1 MAX** |
| **L2 — Auto-with-undo-window** | auto-acts; visible undo window (60 min) | **reversible** (notifications, a reminder resend) → up to **L3** |
| **L3 — Full-auto-audited** | acts immediately; surfaces in digest + audit | reversible only |

Resolution is `effectiveLevel = min(eligibilityCap, override ?? orgDefault)` — **a pure
function with NO AI in the resolver** (you must be able to reason about what the system is
allowed to do without a model in the loop). **Reversibility, not capability, sets the ceiling.**
Conservative zero-setup org defaults (`reversible→L1`, everything else `L0`) so it works fully
on day one and the manager opts into more autonomy as trust grows.

**The loop runs identically-but-dumber without the LLM:** with AI off it still observes, decides
(by rules), proposes, auto-acts within caps, narrates (templated), and learns — only *which*
proposals rank highest changes. The autonomy machine is entirely LLM-independent.

---

## 6. THE BINDING AI-SAFETY CONTRACT

**The contract in one sentence:** the deterministic system owns every FACT (consent %, who
signed, thresholds, legal status, share fractions, the chase decision); the LLM owns only
DRAFTS (extract-for-confirm, draft, explain, rank). It may never originate a number, a legal
claim, or an objection, and it can never reach a fact column except through an audited
human-confirm gate.

Six binding rules — add to the universal Definition of Done (A.3); a slice that cannot meet
all six ships the Stub/deterministic path and defers the AI behind the seam:

1. **Fabrication firewall.** LLM output is advisory + Zod-validated at the trust boundary;
   written ONLY to a staging table, NEVER to a fact column (consent/status/share/signed_at)
   except through an audited human-confirm method. *Enforced by a firewall guard test*
   (mirroring `app-no-new-inline-colors.spec.ts`): no LLM-provider output reaches a fact column
   in the same call frame without a human-confirm method. **The invariant, stated negatively:**
   *there exists NO code path in which a value originating from an LLM provider call is written
   to a fact column without an intervening human-confirm action that writes an audit row.*
2. **PII boundary.** No `national_id`/signature reaches a draft/explain/rank provider
   (regex fail-closed); the tabu-extract egress is gated on `ai_extraction_enabled` +
   DPA-consent + finalized+clean; the `PiiRedactor` tokenizes names/phones by default; the
   prompt body is NEVER logged.
3. **Audited + attributed.** Every AI call + every human accept/reject writes an append-only
   audit row with `actorType:'ai'`; the 'עוזר AI' badge renders on the surface. No AI action is
   attributed to a human or to 'המערכת'.
4. **Reversible / gated.** Reversible AI actions use undo (M0 toast); irreversible or
   legal-fact AI actions ALWAYS require the human confirm, with the rationale + `sourceSignals`
   (the deterministic facts behind the suggestion) shown IN the confirm dialog — AI-originated
   + irreversible is the highest-gate class.
5. **Degrades safely.** With the engine absent/erroring/rate-limited, the feature falls back to
   the deterministic system with ZERO feature loss; a hard timeout + per-org circuit-breaker +
   per-org token budget are in place.
6. **Never fabricates.** No AI-originated number/legal-claim/objection is rendered as fact; the
   consent % is **handed to the explain provider as the rendered number, never the raw rows**,
   so it is structurally un-fabricatable; the consent % always carries the deterministic basis
   label (A.1); the DO-NOT-FABRICATE register (A.2) is honored.

**The human-in-the-loop gates (non-negotiable):** tabu-extract→ownerships needs human review
(PII-unlock) + confirm; message-draft→send needs human approve; objection/status suggestion
needs human confirm of the deterministic flip; campaign draft needs the M5 dry-run preview.

---

## 7. HOW THIS FOLDS INTO THE BUILD PLAN

**The principle: minimal AI-ready foundation NOW (non-blocking, no LLM), the dedicated AI wave
LATER (owner/DPA-gated). Step 5 below changes NO caller.**

### 7.1 NOW — the minimal AI-ready foundation (deterministic, zero AI, does NOT delay Wave 0)

This is a small slice that rides the deterministic skeleton the plan already front-loads. It
adds **no LLM, no PII egress, no cost** — and most of it is already in the plan under different
names:

- `IAiProvider` + `NoopAiProvider` + token + `aiProviderFactory` (Noop default).
- `IDecisionProvider` + `RuleDecisionProvider` — **this IS the A2 ranker** the plan already
  builds; useful immediately.
- The `CircuitBreaker` + `PiiRedactor` egress-scrub + Zod-pipeline helpers (testable with
  Noop/fakes).
- The `action_queue` table + dedupe/proposing logic + the **autonomy-level config**
  (org default + per-project override + eligibility caps + resolver) = the PROPOSE surface.
- The `actorType:'ai'` CHECK-constraint migration + the `ai.invoke` audit action + the
  cost-meter `cache_kv` keys.

**Critically, this does NOT touch Wave 0.** Wave 0's hard ordering gate (S0-SEC before
B0/B1/B4/B5) and the PERF gate are untouched. The AI-ready foundation slots **after** the
deterministic loop foundation (B1/A1/A2/B3 + the action-queue) lands — i.e. it is a *tail*
addition to the autonomy story, not a precondition for any existing gate. The existing plan
already front-loads everything the loop needs; this front adds only the seam stub + the
autonomy config, both deterministic.

### 7.2 LATER — the dedicated AI wave (owner/DPA-gated, clean swap, isolated)

Gated almost entirely on the **legal/DPA decision** (first real PII egress), not engineering:

5. `GeminiAiProvider` (Infisical-keyed) behind the factory branch — **changes no caller.**
6. `GeminiDecisionProvider` wrapping `IAiProvider`, delegating to `RuleDecisionProvider` on
   any failure → DECIDE re-ranking + optional NARRATE polish.
7. Wire `EXTRACTION_ENGINE=gemini` into the existing `extractionProviderFactory` (the factory
   already documents this exact seam) → use-case #1.
8. The `draft` + `summarize` capabilities → use-cases #2 + #3, each with its deterministic
   default already shipped.

The pre-go-live gates for the AI wave (HONEST, flagged not hand-waved): a **DPA + zero-retention
/ no-train** posture on the Gemini account (verify it applies to the chosen tier), a per-org
token budget modeled against the worst case (a 200-apartment פינוי-בינוי), and the
`ai_extraction_enabled` legal flag per org. Removing the AI wave is the same config flip in
reverse — which is what makes it low-risk.

---

## 8. THE DOCTRINE CHECK (the owner's bar, answered)

- *"manages by itself, not a file store"* ✓ — the deterministic agentic loop chases, proposes,
  acts, and narrates on a cadence; the manager approves. The system does the work.
- *"in the future, an AI connection like GEMINI"* ✓ — the seam is a config flip; Gemini drops in
  behind `IAiProvider`/`IExtractionProvider` exactly like the owner already runs it elsewhere.
- *"works fully WITH and WITHOUT the AI"* ✓ — every AI feature degrades to a deterministic
  fallback that is *already the shipping path*; deleting the LLM is a no-op for correctness.
- *legal/non-repudiation safety* ✓ — the consent % is never produced or gated by the LLM; PII
  never egresses except the one DPA-gated, audited, human-confirmed tabu path; the fabrication
  firewall is a guard test, not a promise.
