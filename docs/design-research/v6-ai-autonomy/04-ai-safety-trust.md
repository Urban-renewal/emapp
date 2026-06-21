# EMAPP — AI Safety, Trust & the Legal/Fabrication Boundary (v6 front 04)

> The binding AI-safety contract. This is the front that lets a **tech-phobic יזם**
> trust an AI acting in a **legally-sensitive, non-repudiation-grade** domain.
> Grounded in the real seams that exist today: the `IExtractionProvider` DI seam
> (`extraction-provider.factory.ts` → currently `StubExtractionProvider`), the
> pgcrypto PII flow in `TabuExtractionsService`, the append-only `AuditService`
> with `actorType: 'user' | 'system' | 'provider'`, the D.7c human-confirm review
> flow, the consent-basis-label legal rule (A.1), and the DO-NOT-FABRICATE
> register (A.2). Owner-set date: 2026-06-18.
>
> **Reading order:** §0 the one-paragraph contract · §1 fabrication firewall ·
> §2 PII boundary · §3 explainable/reversible/audited · §4 hallucination + abuse
> · §5 trust UX · §6 the DoD clause · §7 honest feasibility/risk register.

---

## §0 — The contract, in one paragraph (memorize this)

**The deterministic system owns every FACT. The LLM owns only DRAFTS.** Consent %,
who signed, thresholds, legal status, owner share fractions, the chase decision —
all computed by existing deterministic code (the share-weighted consent
computation in `ProjectsService` / migration 0065, the project status
state-machine, the B1 signature-pulse, the pg-boss cron). The LLM may only
(a) **EXTRACT** structured candidates from a document the human will confirm,
(b) **DRAFT** a message the human will approve, (c) **EXPLAIN** in plain Hebrew a
number the deterministic system already computed, (d) **RANK/SUGGEST** an action
the human will tap. The LLM **NEVER** originates a number, a legal claim, an
objection, a consent %, or a write to a fact column. Every AI output is
**advisory, Zod-schema-validated, tenant-scoped, redaction-filtered, audited
under a distinct `actorType:'ai'` actor, reversible, and — when it touches an
irreversible/legal fact — gated behind an explicit human confirm.** If the AI is
down, wrong, or rate-limited, the product **degrades to the deterministic system
with zero feature loss** (the Stub is already a fully-functional offline default).

---

## §1 — THE FABRICATION FIREWALL

### 1.1 The two-layer rule (enforced in code, not in prose)

There are exactly two kinds of value in EMAPP, and they live in two non-overlapping layers:

| | FACT layer (deterministic) | DRAFT layer (LLM-advisory) |
|---|---|---|
| **Examples** | consent % + basis, `metThreshold`, who signed, share fractions, project status, expiry dates, the chase decision, the legal tally | extracted tabu rows *pending confirm*, a reminder message body, a plain-Hebrew explanation, a next-best-action ranking, an objection-reason *summary* |
| **Origin** | `ConsentCalcService`, `ProjectsService` state-machine, `signature-pulse`, pg-boss cron, signature ledger | `IExtractionProvider` (Gemini/Claude), a future `IDraftProvider`, a future `IExplainProvider` |
| **Trust** | authoritative; can drive a legal claim | advisory; can NEVER drive a legal claim without human confirm |
| **Write target** | fact columns (`ownerships.share_*`, `projects.status`, `signature_requests.signed_at`) | staging tables only (`tabu_extraction_rows`, a `ai_drafts` table) — NEVER a fact column directly |

**The firewall is the rule that an LLM output is physically incapable of reaching
a fact column without passing through a human-confirm gate.** This is already true
for tabu: `runExtraction()` writes parsed rows to `tabu_extraction_rows` (a staging
table), and only `confirm()` — which requires `requireAgentCapability` + PII unlock
+ an explicit human action — promotes them into `ownerships` via
`replaceApartmentOwnershipSet`. **Every future AI feature reuses this exact
shape: provider → staging → human confirm → deterministic commit.**

### 1.2 How it's enforced in code (concrete)

1. **Provider seam returns a typed, bounded result — never free-form text into a
   fact path.** `IExtractionProvider.extract()` returns `ExtractionResult` with
   `rows: ExtractionRow[]` (each row: `name?`, `nationalId?`, `shareNumerator?`,
   `shareDenominator?`, `confidence: number`). A future `IDraftProvider.draft()`
   returns `{ body: string, tokensIn, tokensOut, model }` — a *string the human
   edits*, never a structured fact. A future `IExplainProvider.explain()` takes
   **already-computed deterministic facts as input** and returns prose; it is
   given the number, it does not produce the number.

2. **Zod-validate every provider output at the trust boundary** (the same way
   every DTO is Zod-validated per CLAUDE.md). The service that calls the provider
   `z.parse()`s the result before persisting. A row whose `shareDenominator <= 0`,
   whose `confidence ∉ [0,1]`, or whose `nationalId` fails the Luhn/format check is
   **rejected to the review screen as "needs human entry"**, never silently
   committed. (Today `confirm()` already throws `ROWS_INCOMPLETE` on a partial
   parse — extend this to a full Zod gate.)

3. **The LLM never computes the consent %.** This is the single most dangerous
   fabrication the product could emit (build-plan C1: "a printed legal claim with
   no denominator is the most dangerous fabrication"). The consent % is computed by
   the deterministic share-weighted query in `ProjectsService` (migration
   `0065_ownership_share_fraction`, DB-guaranteed share sum=1 via the deferred sum
   trigger) and carries the **basis label** (A.1: "לפי שיעור הבעלות"). If the AI explains a
   %, it is **handed** the deterministic number + basis and may only rephrase it;
   it is structurally forbidden from arithmetic on raw rows. Enforcement: the
   explain prompt receives the *rendered* number + basis string, never the
   underlying ownership rows, so it has nothing to recompute from.

4. **No AI write to a fact column — ever — without an audited human confirm.** A
   lint/test guard (mirroring `app-no-new-inline-colors.spec.ts` and the
   api-docs-coverage guard) asserts that no code path writes `ownerships.*`,
   `projects.status`, `signature_requests.signed_at`, or `consent_*` inside the
   same call frame as an `IExtractionProvider`/`IDraftProvider`/`IExplainProvider`
   invocation. The only sanctioned bridge is `*.confirm()` methods that already
   carry `requireAgentCapability` + an audit-first row.

5. **The LLM never invents an objection or a legal status.** This is the
   product's sharpest honesty constraint, and it is structural, not stylistic:
   `signature_requests.status` is enum `pending | signed | cancelled | expired`
   ONLY (`packages/db/src/schema/artifacts.ts:133`) — **there is NO
   objection/decline/reason field today.** So per A.2, "N בעלים מתנגדים" is
   FORBIDDEN until the backend ships a real objection field (build-plan B2). An
   AI may NOT manufacture this signal to fill the gap. If/when B2 lands and an AI
   summarizes an inbound owner message into a suggested status, that summary lands
   as a **draft suggestion on a review surface** ("המערכת חושבת שזו התנגדות —
   לאשר?"), never as a committed status flip. The flip is a deterministic human
   action against a real column that exists.

### 1.3 The invariant, stated negatively (the test we write)

> There exists NO code path in which a value originating from an LLM provider call
> is written to a fact column without an intervening human-confirm action that
> writes an audit row.

This invariant is the firewall. Everything else in §1 is how we make it true and
keep it true.

---

## §2 — THE PII BOUNDARY (what may / may-not reach the LLM)

EMAPP's PII is legally hot: `national_id`, `phone`, and **signatures** are
pgcrypto-encrypted, never logged, never in error messages (root CLAUDE.md, D.19).
When a real engine replaces the Stub, **PII will leave the process for the first
time.** This section is the contract for that egress.

### 2.1 The allow/deny matrix

| Data | May reach the LLM? | Rule |
|---|---|---|
| `national_id` | **NEVER as an output target; only as document content the human is confirming** | The tabu PDF *contains* national_ids — that is the whole point of extraction. So the **document bytes** may go to a vision model **only for the tabu-extract use case**, **only after** the doc is finalized + AV-clean, **only** for an org that opted in, and the result is **immediately re-encrypted** (`encryptField`) and never logged. The national_id is NEVER sent as a *prompt variable* for drafting/explaining/ranking. |
| **Signatures** (signature blobs) | **NEVER. No exception.** | Signatures are non-repudiation evidence. No AI use case requires them. They never enter any prompt, any embedding, any log. |
| `phone` | **Only when essential + logged** | A reminder-draft may need "send to אורי" but NOT his phone number — the phone is resolved deterministically at send time by `ISMSProvider`, after the human approves the draft. The LLM drafts the *body*, never handles the recipient PII. |
| Owner **name** | **Only when essential (drafting a personalized message) + logged** | A draft "שלום אורי, חסרה חתימתך" needs the first name. This egress is allowed, **redacted-by-default** (see 2.2), logged in the audit row's metadata (which name fields were sent — not the values), and tenant-scoped. |
| Consent %, status, dates | **Yes (already public-to-the-org facts)** | These are non-PII operational facts; they may be sent to the explain/draft provider freely. |

### 2.2 Redaction by default (the egress filter)

A single **`PiiRedactor`** sits between every draft/explain/rank provider and the
network (it does NOT sit on the tabu-extract path, where the document content IS
the payload by design):

- **Default: tokenize.** Names/phones in a prompt are replaced with stable tokens
  (`{{OWNER_1_FIRSTNAME}}`, `{{APT_7}}`) before egress; the deterministic system
  rehydrates the real values into the approved draft *after* the LLM returns. So
  the LLM drafts "שלום {{OWNER_1_FIRSTNAME}}, חסרה חתימתך לדירה {{APT_7}}" — it
  never sees the real name unless the org explicitly opts into personalized
  drafting.
- **Hard block:** a regex/format gate refuses to send any string matching an
  Israeli national_id (9-digit Luhn) or a signature blob marker to a
  draft/explain/rank provider — fail-closed, throws before the network call. (The
  tabu-extract path is exempt because the document legitimately contains them; that
  path has its own controls in §2.3.)
- **Never log the prompt body.** The audit row records `{ promptKind, tokenCount,
  redactedFieldKinds: ['firstName'], model, engineId }` — never the prompt text,
  never a PII value. This mirrors the existing tabu audit ("ids + rowCount +
  engineId ONLY, NEVER any PII value").

### 2.3 Tenant-scoping + the tabu-extract exception

- **Every AI call is tenant-scoped.** The call originates inside `withTenant(orgId,
  …)` (or `withProvider`), carries the `orgId` in its rate-limit bucket and audit
  row, and a future per-org `ai_enabled` flag gates it. No cross-tenant prompt,
  ever. A provider-admin AI action additionally requires `withProvider` +
  reason-string + MFA (D.21).
- **The tabu-extract document egress** (the one path where raw PII leaves) is
  fenced: (1) only finalized + `scan_status='clean'` docs (already enforced); (2)
  only for orgs with `ai_extraction_enabled=true` + a recorded DPA/consent that
  Gemini/Claude may process the document (a **legal-gating** flag — owner/lawyer
  confirm, see §7); (3) the source doc is auto-marked `sensitive=true` (already
  done in `create()`); (4) the egress writes an audit row
  `tabu_extraction.engine_egress` recording `{ engineId, byteCount, mimeType }` —
  never content; (5) zero-retention prompting where the provider supports it
  (Gemini/Claude both offer no-train / no-retention API tiers — verify per §7).

### 2.4 Why this is feasible today

The architecture already enforces the hard part: `runExtraction()` reads bytes
inside `withTenant`, the Stub makes **no external call** so PII never leaves in
dev/test, and the result is immediately re-encrypted. The `PiiRedactor` and the
`ai_*_enabled` flags are the only net-new pieces; the seam, the encryption, and
the audit discipline exist.

---

## §3 — EXPLAINABLE + REVERSIBLE + AUDITED

### 3.1 A distinct AI actor (the 'עוזר AI' badge)

The `AuditService` already supports `actorType: 'user' | 'system' | 'provider'`,
enforced by a DB **CHECK constraint** (`packages/db/src/schema/artifacts.ts:299`
— `actorType IN ('user','system','provider')`). **Add `'ai'`** = a one-line
migration that drops + re-adds that CHECK with the fourth value. CAVEAT (lived
lesson): a CHECK-constraint change ripples to every raw-SQL test INSERT of
`audit_log` — run the FULL suite after the migration, and prefer a single
migration over patching N seeders. The Drizzle `ActorType` union widens to match.
Every AI suggestion/draft/extraction writes an audit row with
`actorType:'ai'`, `metadata.{ engineId, model, confidence, sourceSignals }`. The
FE renders a distinct **'עוזר AI'** badge (separate from the existing 'המערכת'
system badge for cron actions) so the manager always sees *who* proposed a thing:
the deterministic system (המערכת), a human (the name), or the AI assistant (עוזר
AI). **No AI action is ever attributed to a human or to 'המערכת'.**

### 3.2 Every AI output carries its reasoning + source signals

An AI suggestion is never a bare verdict. The wire shape (extending the existing
explain-chip pattern from the action-queue) is:

```ts
interface AiSuggestion<T> {
  payload: T;                    // the draft / extracted rows / ranking
  confidence: number;           // [0,1] from the provider
  rationale: string;            // plain-Hebrew "why" (≤140 chars)
  sourceSignals: SourceSignal[];// the DETERMINISTIC facts it was given
  engineId: string; model: string;
  reversible: 'auto' | 'confirm';// the two-track flag (§3.4)
}
```

`sourceSignals` are **deterministic facts** ("חסרה חתימה אחת · נשלחה תזכורת לפני
6 ימים · התוקף פג בעוד יומיים"), so the manager can audit the AI's premises against
reality. This is the trust mechanism: the AI shows its work, and its work is made
of real numbers the system already computed, not the AI's own claims.

### 3.3 Reversible by default (undo over confirm)

Doctrine principle 6: "reversible by default, undo over confirm." Every AI action
is one of:

- **Reversible (auto-apply with undo):** a drafted reminder that was sent can be…
  well, a sent SMS can't be unsent — so a *send* is NOT auto. But an AI-suggested
  **draft populated into the compose box** is fully reversible (the manager edits
  or discards). An AI-suggested **ranking/ordering** of the action queue is
  reversible (re-sort). These auto-apply with a visible undo (the M0 ActionToast
  pattern: optimistic + `prev` snapshot IS the undo).
- **Irreversible / legal-fact (always confirm):** committing extracted ownerships,
  flipping a status, sending a campaign, marking an objection. These **always**
  require the explicit human confirm — extending the existing two-track rule.

### 3.4 The two-track rule, extended for AI

The existing rule: irreversible/legal actions need a human confirm; cheap
reversible ones use undo. **Extended:** an action that is *both* AI-originated
*and* irreversible is the **highest-gate** class — it needs the human confirm
**plus** the AI badge **plus** the rationale + sourceSignals visible **in** the
confirm dialog (so the human isn't rubber-stamping a black box). Concretely:

| Action class | Gate |
|---|---|
| AI draft → compose box | none (reversible; edit/discard) |
| AI re-rank action queue | none (reversible; re-sort) |
| AI explain a number | none (read-only, no write) |
| AI-extracted tabu rows → `ownerships` | **human confirm** + PII unlock + capability (today's `confirm()`) |
| AI suggests status='refused' | **human confirm** (deterministic flip) |
| AI drafts a campaign | **human confirm** with preview (M5 dry-run) showing who-gets-it / who-has-no-phone |

### 3.5 Everything is audited (the forensic trail)

Every AI call — suggestion, draft, extraction, explanation, **and** every
human accept/edit/reject of it — writes an append-only `audit_log` row. The
accept/reject is the **feedback signal** (§5.4) and the **accountability record**:
if a manager confirms a bad AI extraction, the trail shows the AI proposed it
(`actorType:'ai'`) and the human confirmed it (`actorType:'user'`, separate row,
audit-first). Non-repudiation is preserved because the *human* confirm is the
legally-operative act, fully attributed.

---

## §4 — HALLUCINATION, ERROR, COST & ABUSE

### 4.1 Hallucination handling (structural, not hopeful)

- **Schema validation rejects malformed output** (§1.2.2). A hallucinated extra
  field, a `confidence > 1`, a non-numeric share → rejected to "needs human entry."
- **Confidence-gated auto-surfacing.** Rows below a tuned `confidence` threshold
  are flagged on the review screen ("בדיקה ידנית נדרשת") and excluded from any
  "looks good, confirm all" affordance. The human must touch low-confidence rows.
- **The deterministic ground-truth check.** Where the AI output can be checked
  against a deterministic fact, it is: extracted share fractions must sum to 1 (the
  deferred sum trigger already enforces this at `confirm()` — a hallucinated share
  set fails to a clean 400, never a bad commit). An explanation that contradicts
  the handed-in number is impossible because the number is given, not generated.
- **No silent fallback to wrong.** If extraction confidence is uniformly low or the
  parse is empty, the screen says so honestly ("לא הצלחתי לקרוא את הנסח — נא להזין
  ידנית"), never a fabricated guess. (North Star: "never fake a signal.")

### 4.2 Error & availability (graceful degradation)

- **AI is always optional infrastructure.** The factory already returns a
  fully-functional Stub when no engine creds are present — so a deploy, an outage,
  a quota exhaustion, or a provider 500 **degrades to the deterministic system with
  zero feature loss**. Extraction falls back to manual entry; drafting falls back
  to the existing message templates; explaining falls back to the raw labeled
  number; ranking falls back to the deterministic next-best-action ranker (A2).
- **Timeout + circuit breaker.** Every provider call has a hard timeout (e.g. 15s
  for vision, 8s for draft) and a per-org circuit breaker; on trip, fall back and
  surface "העוזר לא זמין כרגע" — never block the core loop on the AI.
- **Idempotency.** Provider calls are wrapped so a retry never double-commits (the
  staging→confirm shape already gives idempotency; `confirm()` is single-claim).

### 4.3 Cost & abuse rate-limits

- **Per-org token budget + rate-limit** in `cache_kv` (the existing
  `PostgresCacheProvider`, already used for export rate-limit). A monthly/daily
  token ceiling per org; on exhaustion → graceful degrade + a manager-visible
  "מכסת העוזר הגיעה לסוף" + an upsell/quota path. This caps both cost and a
  compromised-account abuse blast radius.
- **No user-supplied free-text into an expensive model unbounded.** Draft/explain
  inputs are bounded-length, server-templated prompts — not arbitrary user prompts
  (we are not shipping a chatbot in MVP). This kills prompt-injection-for-cost.
- **Prompt-injection containment (tabu path).** A malicious PDF could carry
  injected instructions. Mitigation: (1) the extraction prompt is a fixed,
  server-controlled instruction with the document as *data*, not instruction;
  (2) the output is schema-bounded (it can only be rows), so an injected "ignore
  instructions and …" can at worst produce garbage rows that the human rejects —
  it can NEVER cause a write, a cross-tenant read, or an egress, because those are
  outside the model's reach by construction.

### 4.4 The human-in-the-loop gates (the non-negotiable ones)

| Flow | Gate (binding) |
|---|---|
| **tabu-extract → ownerships** | LLM extracts → **human reviews each row** (PII-unlock) → **human confirms** → deterministic commit. The LLM result is NEVER auto-committed. (Exists today as Stub; the gate is already built.) |
| **message-draft → send** | LLM drafts → **human reads/edits** → **human approves send**. The LLM never sends. |
| **objection/status suggestion** | LLM suggests → **human confirms** the deterministic status flip. |
| **campaign draft** | LLM drafts → **human confirms** with the M5 dry-run preview (who's excluded, who has no phone). |
| **explain** | read-only; no gate needed (no write). |
| **rank/reorder** | reversible; no gate (undo). |

---

## §5 — THE TRUST UX (how the AI earns belief)

The user is technophobic and the domain is legal. Trust is not a tone of voice; it
is **showing the work, in plain Hebrew, with an undo and a clear who-did-this.**

1. **Always attributed.** The 'עוזר AI' badge on every AI-touched surface. The
   manager never has to wonder if a number is the AI's opinion or the system's
   fact — facts wear no AI badge; only suggestions do.

2. **Always explained.** Every suggestion shows its one-line rationale +
   sourceSignals (the deterministic facts behind it). "הצעתי לשלוח לאורי תזכורת —
   חסרה חתימה אחת, הקודמת נשלחה לפני 6 ימים, התוקף פג מחר." The human sees the
   premises and can sanity-check them against reality.

3. **Propose, don't act (for anything legal).** Per the doctrine: "do this?" with
   one tap — never the AI silently changing a fact. The AI fills the box; the human
   taps yes. The relief is "it already did the thinking," not "it did things behind
   my back."

4. **The feedback loop is visible + it improves trust.** Every accept/edit/reject
   is recorded. The manager can see "מתוך 12 הצעות החודש — אישרת 10, ערכת 2." Over
   time this calibrates *his* trust honestly (and gives us the data to tune
   thresholds). We never claim an accuracy we haven't measured.

5. **Honesty about uncertainty.** Low-confidence extractions are flagged, not
   hidden. "לא בטוח" is a first-class state. An AI that admits "I'm not sure, check
   this" is trusted more than one that's confidently wrong — and it's the only
   honest design in a legal domain.

6. **The off-switch is obvious.** A per-org "כבה את העוזר" toggle. The product is
   fully usable with the AI off (graceful degradation, §4.2). A user who can turn
   it off trusts it more — and a regulator/DPA reviewer needs that switch to exist.

---

## §6 — THE BINDING AI-SAFETY CLAUSE (goes into the universal DoD)

> Add to the A.3 universal Definition of Done. Any slice that introduces or
> changes an LLM-backed capability MUST satisfy ALL of:
>
> 1. **Firewall:** the LLM output is advisory + Zod-schema-validated at the trust
>    boundary; it is written ONLY to a staging table, NEVER to a fact column
>    (consent/status/share/signed_at) except through an audited human-confirm
>    method. The firewall guard test stays green.
> 2. **PII boundary:** no `national_id`/signature reaches a draft/explain/rank
>    provider (regex fail-closed); the tabu-extract document egress is gated on
>    `ai_extraction_enabled` + DPA-consent + finalized+clean; the `PiiRedactor`
>    tokenizes names/phones by default; the prompt body is NEVER logged.
> 3. **Audited + attributed:** every AI call + every human accept/reject writes an
>    append-only audit row with `actorType:'ai'` (calls) and the 'עוזר AI' badge
>    renders on the surface. No AI action is attributed to a human or to 'המערכת'.
> 4. **Reversible / gated:** reversible AI actions use undo (M0 toast); irreversible
>    or legal-fact AI actions ALWAYS require the human confirm, with the rationale +
>    sourceSignals shown IN the confirm dialog.
> 5. **Degrades safely:** with the engine absent/erroring/rate-limited, the feature
>    falls back to the deterministic system with ZERO feature loss; a hard timeout +
>    per-org circuit breaker + per-org token budget are in place.
> 6. **Never fabricates:** no AI-originated number/legal-claim/objection is rendered
>    as fact; consent % always carries the deterministic basis label (A.1); the
>    DO-NOT-FABRICATE register (A.2) is honored.
>
> A slice that cannot meet all six does NOT ship the AI path — it ships the Stub /
> deterministic path and defers the AI behind the seam.

---

## §7 — HONEST FEASIBILITY & RISK REGISTER

| Risk | Severity | Honest assessment / mitigation |
|---|---|---|
| **PII egress to a 3rd-party LLM is a legal event** | 🔴 HIGH | First time real PII leaves the process. REQUIRES a DPA with the provider, a data-processing legal review, and an org-consent record before ANY production egress. **Owner/lawyer gate — do not ship tabu-extract-to-cloud-LLM without it.** Verify Gemini/Claude zero-retention / no-train API tiers actually apply to the chosen plan (claims vary by tier). |
| **Latency** | 🟡 MED | Vision extraction is seconds, not ms — fine for the async tabu flow (already a draft→confirm flow, not in the request hot path). Draft/explain must be <2s or it breaks the calm; budget + circuit-break, and prefer streaming the draft into the box. NEVER put an LLM call in the consent-% or board-render path (those have a 200ms warm budget — N9). |
| **Cost** | 🟡 MED | Vision tokens for a multi-page נסח are non-trivial × N apartments × N projects. Per-org token budget (§4.3) is mandatory before enabling. Model the worst case (a 200-apartment פינוי-בינוי) before turning it on. |
| **Hallucinated extraction commits bad ownerships** | 🟡 MED | Contained by the human-confirm gate + the sum=1 trigger + Zod validation + confidence flagging. The human eye (D.7c) is the firewall; the AI never auto-commits. Residual risk = human rubber-stamps — mitigated by showing confidence + forcing touch on low-confidence rows. |
| **Prompt injection via malicious PDF** | 🟢 LOW (contained) | Output is schema-bounded to rows; the model has no tool/write/read reach. Worst case = garbage rows the human rejects. No write/egress/cross-tenant path exists for it to exploit. |
| **Over-trust ("the AI said so")** | 🟡 MED | The whole §5 trust UX is calibrated to PREVENT blind trust: visible confidence, sourceSignals, the accept/reject ledger, low-confidence flagging. We design for *calibrated* trust, not maximal trust. |
| **Provider lock-in** | 🟢 LOW | The `IExtractionProvider`/future `IDraftProvider` seam means swapping Gemini↔Claude↔local is a factory change, exactly like SMS/storage. Already proven twice (parcel + extraction seams). |
| **Sequencing** | — | **AI-ready NOW** (the seam + staging + confirm + audit + redaction-points all exist or are 1 flag away). **AI lands as a clean later wave** when the DPA + creds land. The deterministic agentic skeleton (B1 pulse, A2 ranker, B3 cron, action-queue) ships first and stands alone; AI augments it without being a dependency. |

**Bottom line on feasibility:** the foundation is genuinely AI-ready — the seam is
real, the staging→confirm→audit→encryption discipline is built and proven on the
tabu path, and the deterministic system already does the self-managing work. The AI
wave is **gated almost entirely on the LEGAL/DPA decision, not on engineering.**
That is the honest, correct place for the gate to sit.
