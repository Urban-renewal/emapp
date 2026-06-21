# 01 — The AI Architecture Seam: `IAiProvider`, Dual-Mode, the PII Boundary

> **Front:** the DI seam that lets a real LLM (Gemini) plug into EMAPP exactly like
> `IEmailProvider` / `ISMSProvider` / `IExtractionProvider` already do — and that
> makes AI **strictly optional**: provider-absent, flag-off, or circuit-open all fall
> back to the deterministic/manual path with **no error surfaced to a core flow**.
> **Status:** design proposal for the v6 AI/autonomy wave. READ-ONLY — no app code changed here.
> **Author:** AI-architecture seat, 2026-06-18. The foundation doc; feeds 02 (use-cases),
> 03 (agentic loop), 04 (safety/trust), and the v6 synthesis.
>
> **The doctrine this serves** (`docs/DESIGN-NORTH-STAR.md`): *the system does the work;
> the developer just approves.* AI raises the **quality** of the work (better Hebrew
> phrasing, a parsed נסח, a ranked queue) — it is **never load-bearing**. If Gemini is
> down, slow, rate-limited, mis-keyed, or returns garbage, every core flow still runs on
> the deterministic-or-manual path, invisibly where possible.
>
> **DUAL-MODE is the headline, not a footnote.** This document's central engineering
> claim is that the seam is built so that **deleting the LLM is a no-op for correctness** —
> only quality changes. Every section below shows the without-AI path explicitly.

---

## 0. One-paragraph thesis

EMAPP already has five substitutable provider seams — `IEmailProvider`,
`ISMSProvider`, `IExtractionProvider` (today a `StubExtractionProvider`),
`IFileScanProvider`, `IParcelDataProvider` — each a **token + factory + interface + a
Noop/Stub default** (`apps/api/src/modules/*/...-provider.factory.ts`,
`packages/db/src/providers/*`). The AI layer is **the same pattern, twice**:
(1) **`IAiProvider`** — a low-level, capability-typed LLM gateway (`extract` / `draft` /
`summarize` / `answer` / `classify`) with a `NoopAiProvider` default and a
`GeminiAiProvider` concrete impl, selected by `aiProviderFactory()` on Infisical creds;
and (2) **`IDecisionProvider`** — a high-level *decision seam* (the action-queue ranker)
whose `RuleDecisionProvider` is the forever-fallback and whose `GeminiDecisionProvider`
is a thin wrapper over `IAiProvider`. The first one swaps *one step* of an existing flow
(tabu parse, draft text). The second one swaps the *DECIDE step* of the agentic loop
(03) **rules→LLM without a rewrite**. The genuinely-new code is small: one interface
file, one Gemini client, one factory, one config block, a Zod schema per capability, and
a `CircuitBreaker` + redaction helper. Everything else — where calls run (mostly the
pg-boss worker), how `withTenant`/RLS/audit apply, the PII boundary — reuses substrate
that already ships.

---

## 1. The two seams (and why two)

```
                         ┌───────────────────────────────────────────────┐
   HIGH-LEVEL (domain)   │   IDecisionProvider  — "what should we do?"    │
   the DECIDE step (03)  │   RuleDecisionProvider (default, forever)      │
                         │   GeminiDecisionProvider ──┐ (wraps IAi)       │
                         └────────────────────────────┼──────────────────┘
                                                       ▼
                         ┌───────────────────────────────────────────────┐
   LOW-LEVEL (gateway)   │   IAiProvider  — "talk to an LLM, safely"      │
                         │   NoopAiProvider (default)                     │
                         │   GeminiAiProvider (Infisical-keyed)           │
                         │   = circuit-breaker + redaction + Zod-validate │
                         └───────────────────────────────────────────────┘
```

**Why split them.** `IAiProvider` answers *"send this PII-free prompt to an LLM and give
me a Zod-valid object or fail safely."* `IDecisionProvider` answers *"given the pulse,
which actions, in which order, phrased how?"* — a **domain** question that has a perfectly
good deterministic answer (the rule-ranker). Keeping DECIDE behind its **own** interface
means the agentic loop (03) depends on `IDecisionProvider`, **not** on the LLM: removing
Gemini reverts DECIDE to rules automatically, with zero changes to OBSERVE/PROPOSE/ACT/
NARRATE. The low-level seam is reused by the *non-loop* AI features too (tabu extract,
draft a reminder message, summarize a project) which don't go through DECIDE at all.

---

## 2. `IAiProvider` — the low-level seam

Mirrors `IExtractionProvider` exactly (one capability-typed method instead of five
separate providers, so cost/latency/circuit-breaker/redaction live in **one** place).
Lives at `packages/db/src/providers/ai/ai.interface.ts`; token + factory at
`apps/api/src/modules/ai/ai-provider.factory.ts` (and a worker-side mirror, like
`storage-provider.ts` in the worker).

```ts
// packages/db/src/providers/ai/ai.interface.ts
export type AiCapability = 'extract' | 'draft' | 'summarize' | 'answer' | 'classify';

/** EVERY field here is PII-free by construction (see §6). The caller is
 *  responsible for redaction BEFORE handing a request to the provider; the
 *  GeminiAiProvider additionally runs a defense-in-depth egress scrub (§6.3). */
export interface AiRequest<TOut> {
  capability: AiCapability;
  /** Stable id of the prompt template (versioned, in-repo) — NOT free text from a user. */
  promptId: string;
  /** Structured, redacted variables interpolated into the template. No raw PII. */
  input: Record<string, unknown>;
  /** The Zod schema the model output MUST satisfy. Output is z.parse()'d; a parse
   *  failure is treated as a provider failure → degrade path. NEVER trust raw text. */
  schema: ZodType<TOut>;
  /** For multimodal (tabu PDF): the bytes + mime. national_id IS in these bytes —
   *  this is the ONE allowed-egress case, owner-gated + audited (§6.4). */
  media?: { bytes: Buffer; mimeType: string };
  /** Hard wall-clock cap; defaults from config. The breaker also enforces it. */
  timeoutMs?: number;
  /** Tenant + correlation for audit/metrics/rate-limit bucketing. No PII. */
  ctx: { orgId: string; correlationId: string; actorType: 'system' | 'user' };
}

export interface AiResult<TOut> {
  ok: true;
  data: TOut;                 // already Zod-validated
  meta: { engineId: string; model: string; latencyMs: number;
          tokensIn: number; tokensOut: number; costMicros: number };
}
export interface AiFailure {
  ok: false;
  reason: 'disabled' | 'circuit_open' | 'timeout' | 'rate_limited'
        | 'invalid_output' | 'provider_error';
  // NEVER carries prompt/PII; safe to log + audit.
}

export interface IAiProvider {
  /** NEVER throws for an AI-layer fault — returns AiFailure so callers branch to
   *  the deterministic/manual fallback. Throws ONLY on a programmer error
   *  (e.g. a request that still contains PII — fail-closed, see §6.3). */
  run<TOut>(req: AiRequest<TOut>): Promise<AiResult<TOut> | AiFailure>;
  /** Cheap, cached health for the FE "AI on/off" affordance + the breaker UI. */
  status(): { enabled: boolean; circuit: 'closed' | 'open' | 'half_open' };
}
```

**Design choices baked into the type:**

- **`run()` returns a failure, it does not throw for an AI fault.** This is the dual-mode
  contract *in the type system*: a caller cannot accidentally let an LLM outage bubble as a
  500. The only throw is the **PII-egress guard** (a bug, fail-closed) — never an outage.
- **`schema` is mandatory.** There is no "give me the raw string" method. Output is always
  `z.parse()`'d; **never trust raw model text** (CLAUDE.md: "No `unknown` without z.parse()").
  An invalid parse is an `AiFailure('invalid_output')` → fallback, never a crash, never a
  malformed write.
- **`promptId` + `input`, not free text.** Prompts are **versioned templates in the repo**,
  not user-supplied strings — this bounds prompt-injection surface and makes every call
  auditable/reproducible. The `answer` (NL-assistant) capability still passes the user's
  question as a *redacted input variable* into a fixed template, never as the system prompt.

### 2.1 The Noop default (dual-mode at the boot layer)

```ts
// packages/db/src/providers/ai/noop.provider.ts
export class NoopAiProvider implements IAiProvider {
  readonly engineId = 'noop' as const;
  async run<TOut>(): Promise<AiFailure> { return { ok: false, reason: 'disabled' }; }
  status() { return { enabled: false, circuit: 'closed' as const }; }
}
```

`NoopAiProvider` returns `disabled` for everything. **Because every caller already handles
`AiFailure` by taking the deterministic/manual path, an EMAPP deploy with no AI creds is a
fully-functional product** — identical to today. This mirrors `StubExtractionProvider` /
`StubParcelDataProvider`: the no-AI default is a **legitimate production default**, so —
unlike SMS/scan — **there is NO production fail-fast** in `aiProviderFactory` (§4). AI is
enrichment; absence is fail-open.

### 2.2 The factory (the single config-swap point)

```ts
// apps/api/src/modules/ai/ai-provider.factory.ts
export const AI_PROVIDER = 'AI_PROVIDER';

export function aiProviderFactory(): IAiProvider {
  if (process.env['AI_PROVIDER'] === 'gemini' && process.env['GEMINI_API_KEY']) {
    return new GeminiAiProvider({
      apiKey: process.env['GEMINI_API_KEY']!,          // Infisical (Gate-4 SECRETS LAW)
      model: process.env['AI_MODEL'] ?? 'gemini-2.5-flash',
      timeoutMs: Number(process.env['AI_TIMEOUT_MS'] ?? 15_000),
      maxConcurrent: Number(process.env['AI_MAX_CONCURRENT'] ?? 4),
      monthlyCostCapMicros: Number(process.env['AI_MONTHLY_COST_CAP_MICROS'] ?? 0), // 0 = uncapped
    });
  }
  // Unset / dev / test → Noop. NO production fail-fast: AI is enrichment, absence
  // is fail-open (mirrors extraction/parcel factories, NOT sms/scan).
  return new NoopAiProvider();
}
```

This is byte-for-byte the governance of `extractionProviderFactory` /
`parcelDataProviderFactory`: token stays fixed, only the concrete class changes, creds in
Infisical, **never `.env`** (MEMORY: *Always use Infisical, never .env*).

---

## 3. Where calls run — sync vs the pg-boss worker

**Rule of thumb: almost all AI is async, on the worker.** The worker already runs three
live cron sweeps (`apps/worker/src/main.ts`: signature-expiry, reaper, audit-retention)
with `actor_type='system'` audit rows, pino PII-redaction, and graceful SIGTERM drain — it
is the natural home for slow, retryable, cost-bearing LLM calls.

| Feature | Where | Why | Without-AI fallback |
|---|---|---|---|
| **Tabu extract** (`IExtractionProvider`) | **worker job** | a PDF + vision call is 2–10 s; must not block an HTTP request; retryable | `StubExtractionProvider` (deterministic line-parse) → manual entry in the 7c review screen. The mandatory human-confirm flow is **unchanged**. |
| **DECIDE / rank** (`IDecisionProvider`) | **worker cron** (the loop tick, 03) | runs per-org on a cadence, never user-facing latency | `RuleDecisionProvider` (deterministic ranker, A2) |
| **Draft a reminder/objection message** (`draft`) | **worker**, when a `proposed_action` is materialized | pre-compute so the manager's approval is instant | a fixed **template** with `{name}`/`{apartment}` slots filled deterministically |
| **Summarize a project** (`summarize`) | **worker**, cached on the pulse row | digest-time, not click-time | the deterministic plain-Hebrew pulse sentence (north-star principle 5) |
| **NL-assistant** (`answer`) | **sync HTTP**, hard 8 s timeout, streaming | the ONLY truly interactive case; user is waiting | a "search/UI couldn't be reached by AI — here's the normal filter UI" graceful message; the deterministic search still works |
| **Classify** (e.g. doc-type, objection sentiment) | **worker** on upload/event | non-blocking enrichment | the field stays "unset"/manual-select; nothing breaks |

**Latency budget.** Sync `answer` is capped at 8 s with a streamed-first-token target; if
the breaker is open or the timeout trips, the FE shows the deterministic path immediately.
All worker calls are bounded by `AI_TIMEOUT_MS` (default 15 s) and the breaker.

---

## 4. Cost / latency / rate-limit control

All centralized in `GeminiAiProvider` so no caller can bypass them:

1. **Concurrency gate** (`AI_MAX_CONCURRENT`, default 4) — a semaphore; the worker
   processes the loop/extract queue with bounded parallelism. Over-limit → `rate_limited`
   failure → deterministic path (the loop tick simply uses the rule-ranker this cycle).
2. **Monthly cost cap** (`AI_MONTHLY_COST_CAP_MICROS`) — a running cost meter in
   `cache_kv` (the existing `PostgresCacheProvider`, no Redis). When the cap is hit, the
   provider returns `disabled` for the rest of the period → **the whole product silently
   degrades to no-AI**, no outage, no surprise bill. Owner sees it in the system-health
   surface.
3. **Per-org rate bucketing** — `ctx.orgId` keys a token-bucket so one large tenant can't
   starve others or blow the cap.
4. **Caching** — `summarize`/`classify` results are content-addressed (hash of the
   redacted input) in `cache_kv`; identical inputs don't re-spend. The pulse summary is
   cached on the pulse row and only recomputed on a material delta.
5. **Model tiering** — default `gemini-2.5-flash` (cheap, fast) for ranking/drafting;
   the heavier model only for tabu-vision, set per-capability in config.

---

## 5. Retries, timeout, circuit-breaker, structured output

### 5.1 Timeout + retry
Every call is wrapped in `AbortController(timeoutMs)`. Retries: **at most one**, only for
transient classes (`429`, `503`, network), with jittered backoff — kept tiny because the
worker job itself is retryable by pg-boss and the fallback is always available. A
non-transient error (4xx auth, invalid output) is **not** retried → immediate failure →
fallback.

### 5.2 Circuit-breaker (the dual-mode safety valve)
A standard three-state breaker per provider instance:

```
CLOSED ──(N consecutive failures within window)──► OPEN
OPEN ──(cooldown elapsed)──► HALF_OPEN ──(1 probe ok)──► CLOSED
                                        └─(probe fails)─► OPEN
```

- **OPEN** = `run()` returns `circuit_open` **immediately** (no network, no latency) →
  every caller takes the deterministic/manual path. A Gemini outage thus costs ~0 ms, not
  a pile of 15 s timeouts.
- The breaker is the mechanism that turns "Gemini is having a bad day" into an **invisible
  soft-degrade**: the agentic loop keeps ranking with rules, tabu keeps offering manual
  entry, the digest keeps using deterministic sentences. The owner sees breaker state in
  system-health; the *manager* sees nothing different except slightly plainer phrasing.
- `status()` exposes breaker state so the FE can render an honest, calm "AI assist is
  paused" chip where it matters (never a red error).

### 5.3 Structured output — Zod, always
The model is asked (via `responseSchema` / JSON mode) to return JSON; the raw text is then
**`schema.parse()`'d in our code regardless** — we never trust the model's claim of
validity. Pipeline: `raw text → JSON.parse (guarded) → zod.safeParse → AiResult | AiFailure('invalid_output')`.
A schema miss is a *failure*, not an exception, so it degrades like any other fault. This
also hard-stops **fabrication writes**: a hallucinated `national_id` or an out-of-enum
status can't reach the DB because the schema (and downstream domain validation) rejects it.
Honors the DO-NOT-FABRICATE register — the LLM proposes, the schema + domain rules dispose.

---

## 6. The PII boundary — the most important section

**Hard rule (CLAUDE.md, non-negotiable):** `national_id`, `phone`, and signatures are PII,
pgcrypto-encrypted, **never logged, never in error messages** — and here, **never sent to
the LLM** except the one owner-gated, audited multimodal case (§6.4).

### 6.1 What may and may not egress

| Data | To the LLM? | How |
|---|---|---|
| `national_id` | **NEVER** (text-prompt path) | not in any prompt; not in pulse summaries; the loop reasons over counts/days, never identities (03 §1.1) |
| `phone` | **NEVER** | same |
| signature blobs | **NEVER** | same |
| owner **name** | **Only via a per-call token**, never raw, unless owner-gated reveal | drafting "שלחתי תזכורת ל-{owner}" interpolates a **placeholder token** at egress; the real name is re-substituted **after** the model returns, in our process (§6.2) |
| aggregates: counts, `stalledDays`, `signedThisWeek`, urgency, share-weighted % | **YES** | these are the *only* thing DECIDE/summarize see — PII-free by construction |
| project/apartment **labels** (e.g. "דירה 7") | YES (non-PII) | apartment numbers are not PII; names are |
| the tabu **PDF bytes** (contains national_id) | **YES — the one exception** | extract capability only, owner-gated flag, audited, §6.4 |

### 6.2 Tokenization / re-substitution (so names never leave)
For `draft`/`narrate`, the caller builds the prompt with **opaque tokens** (`OWNER_1`,
`APT_7`) and a local `Map<token, realValue>`. The LLM sees `"נסח את התזכורת ל-OWNER_1
בנוגע ל-APT_7"`; it returns Hebrew text containing `OWNER_1`; we **re-substitute** the real
name in-process before the message is stored/sent. The owner's name **never crosses the
network**, yet the output reads naturally. This is the default for all generative text.

### 6.3 Defense-in-depth egress scrub (fail-closed)
Even though callers redact, `GeminiAiProvider` runs a **last-line PII scanner** over the
serialized request before it hits the wire: the same regex family as the pino redact list
(`apps/worker/src/main.ts`) — Israeli national_id (9-digit + Luhn), phone patterns. **A
hit `throw`s** (the only throw in the seam): a request that still contains PII is a
*programmer error*, fail-closed — we would rather break that one feature than leak PII.
This is the AI-layer analogue of the pino redact wall.

### 6.4 The one allowed egress: the tabu PDF (and how it's bounded)
The נסח **is** PII (names + national_id verbatim). Sending its bytes to Gemini for
extraction is the single legitimate egress, and it is **already gated by the existing
review architecture (D.7c)**:
- **Owner-gated flag** (`AI_PROVIDER=gemini` + an explicit `EXTRACTION_ENGINE=gemini`),
  provisioned only after the owner accepts the data-processing posture. Default stays Stub
  → **zero egress**.
- **Audited**: the existing `tabu_extraction.run` audit row already records `engineId` +
  `sourceDocumentId` (never PII values). With Gemini, `engineId='gemini'` makes every
  off-process extraction **forensically visible**.
- **Human-confirm unchanged**: the parsed rows still land encrypted (pgcrypto) and **still
  require the mandatory 7c review + PII-step-up-unlock + explicit confirm** before any
  ownership is written. The LLM never commits — it proposes; a human approves.
- **Fallback intact**: flag off, Gemini down, or breaker open → `StubExtractionProvider` →
  manual entry. The whole 7c pipeline runs identically.
- **Data-handling posture to verify before go-live:** Gemini API retention/training
  settings must be set to no-retention/no-train for this path (flagged HONESTLY as an
  owner pre-go-live gate, like the parcel-lookup ToS gate).

### 6.5 `withTenant` / RLS / audit on AI calls
- **AI does not bypass RLS.** Worker AI jobs run inside `withTenant(orgId, fn)` using a
  **system principal** exactly like the existing cron sweeps (`signature-expiry-sweep`):
  the loop reads the pulse, ranks, and writes `proposed_actions` all under tenant RLS. The
  LLM call itself is a leaf inside that tx context; it receives only the already-redacted
  aggregate. No AI code path ever touches `db.query` directly (CLAUDE.md hard rule).
- **Every AI call is audited** with `actor_type='system'`: a new `ai.invoke` action row
  carrying `{ capability, promptId, engineId, model, tokensIn, tokensOut, costMicros,
  outcome, correlationId }` — **never the prompt content, never PII** (the `AiFailure`/meta
  types are PII-free by construction, §2). This gives the owner a complete, honest ledger of
  what the AI did and what it cost, satisfying the המערכת-actor-badge transparency the
  doctrine requires.

---

## 7. The decision seam — `IDecisionProvider` (rules → LLM, reversible)

The DECIDE step of the agentic loop (03) sits behind its **own** interface so the loop
never depends on the LLM:

```ts
// packages/db/src/providers/decision/decision.interface.ts
export interface IDecisionProvider {
  /** input.pulse is the PII-FREE B1 aggregate; policy = per-action autonomy levels;
   *  memory = last-nudge state. Returns ranked, phrased candidate actions. */
  rankActions(input: DecisionInput): Promise<CandidateAction[]>;
}
```

- **`RuleDecisionProvider`** (ships first, **forever fallback**): ordered deterministic
  rules over the pulse — *"`nextExpiryAt` < 72h AND pending → resend, urgency=high"*. Zero
  cost, zero latency, zero PII-egress. This **is** the A2 next-best-action ranker the build
  plan already describes; it is genuinely useful on day one.
- **`GeminiDecisionProvider`** (later wave): same signature, wraps `IAiProvider.run({
  capability:'classify'|'draft', schema: CandidateAction[] })`. It is handed the **PII-free**
  pulse summary and asked to *rank + phrase*; it returns the **same** `CandidateAction[]`
  shape. **If `IAiProvider` returns any `AiFailure`, `GeminiDecisionProvider` delegates to
  an injected `RuleDecisionProvider` and returns its result** — so a Gemini fault is not
  just non-fatal, it produces the *exact deterministic output* the loop would have used
  anyway. The catalog of possible actions is **fixed code**; the LLM only reorders and
  rephrases, never invents an action.

**The reversibility property (the design's spine):** the loop's DECIDE call is
`decisionProvider.rankActions(...)`. The factory picks `Rule` or `Gemini`. **Flipping the
flag off, or Gemini failing, reverts DECIDE to rules with no code change and no structural
difference** — same `proposed_actions` rows, same autonomy gates, same audit. That is what
"the seam makes AI optional" means concretely.

---

## 8. End-to-end request flow (a generative example: drafting a reminder)

```
worker cron tick (withTenant, system principal)
  └─ OBSERVE: read B1 pulse (SQL, RLS)                         [no AI]
  └─ DECIDE: decisionProvider.rankActions(pulse, policy, mem)
        ├─ RuleDecisionProvider → ordered candidates           [no AI]
        └─ GeminiDecisionProvider
              ├─ build PII-FREE summary {counts, days, urgency}
              ├─ tokenize labels (OWNER_1, APT_7)              [§6.2]
              ├─ aiProvider.run({capability:'draft', promptId, schema})
              │     ├─ breaker OPEN? → AiFailure(circuit_open) ─┐
              │     ├─ egress scrub (fail-closed throw on PII)  │
              │     ├─ Gemini call (timeout, semaphore, cost)   │
              │     ├─ JSON.parse → zod.parse                   │
              │     └─ AiResult | AiFailure(invalid_output) ────┤
              └─ on ANY AiFailure → delegate to RuleDecisionProvider  ◄┘  [degrade]
  └─ re-substitute tokens → real Hebrew text                   [in-process]
  └─ PROPOSE: write proposed_actions row (rationale + signals) [SQL, RLS]
  └─ AUDIT: ai.invoke {capability, engineId, tokens, cost}     [actor_type='system', no PII]
```

The manager later sees the action-queue card and taps "yes" — the **ACT** step calls the
*existing* resend endpoint. The AI touched exactly one leaf (phrasing); everything else is
deterministic substrate.

---

## 9. The explicit degrade-path matrix

| Failure mode | What the seam does | What the user sees |
|---|---|---|
| No creds / `AI_PROVIDER` unset | `NoopAiProvider`, every `run` → `disabled` | identical to today's product; rule-ranker + manual everywhere |
| Flag on but Gemini down/timeout | breaker trips → `circuit_open` immediately | slightly plainer Hebrew phrasing; everything works; calm "AI paused" chip in system-health |
| Rate-limited / over-concurrency | `rate_limited` | this loop tick uses the rule-ranker; next tick retries |
| **Monthly cost cap hit** | provider returns `disabled` until period reset | whole product reverts to no-AI; owner notified; **no surprise bill** |
| Malformed / hallucinated output | `zod.parse` fails → `invalid_output` | fallback path; **no bad data written** (schema + domain rules block fabrication) |
| Request still contains PII (a bug) | egress scrub **throws** (fail-closed) | that one AI call fails → fallback; **PII never leaves**; alert fires |
| Tabu Gemini path off/failed | `StubExtractionProvider` | manual entry in the unchanged 7c review flow |

**In every row, a core flow continues.** That is the dual-mode guarantee, enumerated.

---

## 10. Honest risk register

- **Gemini data retention.** The tabu-PDF egress sends real PII off-process. Mitigation:
  owner-gated flag (default off = zero egress), audited, and a **pre-go-live gate** to
  confirm no-retention/no-train API settings. Flagged honestly, not hand-waved.
- **Cost unpredictability.** Mitigated by the hard monthly cap that degrades to no-AI, the
  concurrency gate, content-addressed caching, and flash-tier defaults. Worst case is
  *plainer phrasing*, never an outage or a runaway bill.
- **Latency on the one sync path (`answer`).** 8 s cap + breaker; the deterministic search
  UI is always present, so a slow LLM never blocks the user.
- **Prompt injection** (esp. tabu text, NL-assistant). Mitigated by versioned in-repo
  prompt templates (no user-controlled system prompt), Zod-validated structured output (a
  prompt-injected free-form response can't satisfy the schema), and the human-confirm gate
  on anything that writes (tabu, proposed_actions).
- **Over-trust / automation bias.** Out of scope here (see 04 safety/trust), but the seam
  supports it: every AI output is `decided_by='gemini'` stamped + explain-chip + undo +
  audited, so the human always sees "the machine proposed this" and can reverse it.
- **Won't pretend:** the seam does **not** make EMAPP "AI-native" by itself — it makes it
  **AI-ready**. The value lands only when 02's use-cases and 03's loop ship on top of it.
  This doc's job is to guarantee that when they do, AI is an *enhancement that can be
  removed*, never a dependency that can break.

---

## 11. Build sequence (foundation now, AI later — cleanly)

**Now (AI-ready, ~1 small slice, no LLM):**
1. `IAiProvider` + `NoopAiProvider` + token + `aiProviderFactory` (Noop default).
2. `IDecisionProvider` + `RuleDecisionProvider` (the A2 ranker — useful immediately).
3. The `CircuitBreaker` + egress-scrub + Zod-pipeline helpers (testable with Noop/fakes).
4. The `ai.invoke` audit action + cost-meter `cache_kv` keys.

**Later wave (owner-gated, the LLM lands):**
5. `GeminiAiProvider` (Infisical-keyed) behind the factory branch.
6. `GeminiDecisionProvider` wrapping `IAiProvider`, delegating to `RuleDecisionProvider` on
   any failure.
7. Wire `EXTRACTION_ENGINE=gemini` into the existing `extractionProviderFactory` (the
   factory already has the documented seam comment for exactly this).

Step 5 changes **no caller**. That is the whole point: the foundation is shaped so the AI
features are a config flip + a new concrete class, and removing them is the same flip in
reverse.
