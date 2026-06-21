# EMAPP — Gemini / AI Use-Cases, Ranked + Their Non-AI Fallbacks (V6 AI-Autonomy front)

> **Front:** Ranked Gemini use-cases for this product, each paired with its **concrete
> without-AI fallback** so no feature can ever break when the LLM is down.
> **Status:** design proposal for the v6 AI/autonomy wave. READ-ONLY — no app code changed here.
> **Author:** AI-autonomy seat, 2026-06-18. Feeds the v6 synthesis.
> **Doctrine:** `docs/DESIGN-NORTH-STAR.md` ("the system does the work; the developer just
> approves") + the DO-NOT-FABRICATE register (`v4-readiness/00-FINAL-BUILD-PLAN.md` §A.2).
> **Grounding:** verified against the real code, not aspirational.

---

## 0. The governing constraint — DUAL-MODE (non-negotiable)

The system MUST work **fully** both WITH and WITHOUT the AI layer. **AI is a strictly OPTIONAL
enhancement of a single step, never a load-bearing dependency.** If Gemini is down, slow,
rate-limited, mis-configured, or errors, **no core flow may break, hang, or fail** — it degrades
to the deterministic/manual path, invisibly where possible. The seam carries this in code:

- **One provider seam per capability** (mirrors the existing `IExtractionProvider` /
  `ISMSProvider` / `IStorageProvider` pattern) — Gemini sits behind it; a **Noop/deterministic
  default** is the always-present fallback.
- **Every Gemini call is wrapped** in: a **timeout** (≈3–5s), a **circuit-breaker** (open after N
  consecutive failures → stop calling for a cool-down window), and a **catch → fallback** branch
  that returns the deterministic result. An AI-layer failure is a *soft-degrade*, never an outage.
- The **deterministic core** — facts, rules, the entire agentic loop, all CRUD, the action-queue
  (doc 03) — runs WITHOUT the LLM. The LLM only ENHANCES a step (extraction parse → manual entry;
  draft → template; digest → deterministic bullets; assistant → the normal UI; ranked NBA →
  the rule-based ranker).

The **"AI ON/OFF" column in §1's table is therefore the most important column.** A use-case
without a fully-usable non-AI fallback does not ship.

---

## 1. Grounding — what is REAL today (verified in code)

Every ranking below is anchored to seams and data that **exist now**, so the sequencing is honest.

| Asset | Where | State |
|---|---|---|
| **`IExtractionProvider` seam** | `packages/db/src/providers/extraction/extraction.interface.ts` | Real interface. Default `StubExtractionProvider` (deterministic line-parse, **no external call**). Factory `apps/api/src/modules/tabu/extraction-provider.factory.ts:30` already documents the `EXTRACTION_ENGINE=gemini` + `GEMINI_API_KEY` branch — the swap point is **pre-wired**, and the Stub is explicitly a *fully-functional offline default*. |
| **Tabu extraction lifecycle + human-confirm gate** | `apps/api/src/modules/tabu/tabu-extractions.service.ts` | Real. `runExtraction()` reads doc bytes → provider → **encrypts** name+national_id (pgcrypto) into `tabu_extraction_rows` → human reviews (`listRows`, PII step-up gated) → `confirm()` commits ownerships **atomically** with hash-match dedup. The D.7c "auto-parse → human confirms before commit" gate is **built**. |
| **Audit log with `actor_type='system'`** | `packages/db/src/audit/audit.service.ts`; CHECK `actor_type IN ('user','system','provider')` (`schema/artifacts.ts:299`, migration `0014`) | Real. Append-only, `beforeState`/`afterState`/`metadata`. The "המערכת did X" actor badge has a real backing column. |
| **Signature-pulse aggregate** | Build plan **B1** (`v4-readiness/00-FINAL-BUILD-PLAN.md:137`): `GET /api/v1/org/signature-pulse` → `lastSignatureAt`, `signedThisWeek`, `stalledDays`, `nextExpiryAt`, buckets `{active,pastThreshold,inWork,stuck}`. | **Planned, contract pinned, NOT yet built.** Derives from `signature_requests.{signedAt,expiresAt,status,createdAt}` via `documents.project_id`. The NL-assistant and digest read THIS. |
| **Autonomy worker (cron consumer + notif kinds)** | Build plan **B3** (`:151`). Scheduler already runs **3 live sweeps** (`apps/worker/src/main.ts`); B3 adds 1 pg-boss cron consumer + 3 kinds `expiring`/`stalled`/`threshold_reached` + auto-reminders. | **Planned (re-scope: consumer, not scheduler).** The agentic skeleton the AI layer rides. |
| **`signature_requests` model** | `packages/db/src/schema/artifacts.ts` | Real. Status enum = **`pending \| signed \| cancelled \| expired`** ONLY. **There is NO objection/decline/reason field today** (B2 plans to add `decline_reason` + `'declined'`). ← the single biggest honesty constraint (§2 #4/#8). |
| **Notification kinds** | `packages/shared-types/src/notification.ts:12` | Exactly 8 kinds; **none** of `expiring`/`stalled`/`threshold_reached` exist yet (added by B3). The drafted-message + digest use-cases have a delivery rail; the autonomy narration kinds do not exist until B3. |
| **Messaging domain** | `apps/api/src/modules/messaging` | Real domain → a delivery rail for AI-drafted messages. |

**Hard PII boundary (from `CLAUDE.md` + `db/CLAUDE.md` + the service):** `national_id`, `phone`,
signatures are pgcrypto-encrypted and **never logged, never in errors, never in audit metadata**.
Any AI use-case that needs PII in its prompt is a red-flag and must justify why decrypted PII
crosses the process boundary to a third party (Gemini), under what DPA, with what minimization.
**Most use-cases below are deliberately designed to send derived signals, not raw PII.**

---

## 2. The ranking — Score = (Value × Feasibility) ÷ Risk

Scored 1–5 each. Higher score = ship sooner. The **AI OFF** column is the dual-mode fallback in one line.

| # | Use-case | Val | Feas | Risk | **Score** | Wave | **AI OFF → degrades to** |
|---|---|:-:|:-:|:-:|:-:|:-:|---|
| **1** | **Tabu/נסח PDF extraction → owners+shares** | 5 | 5 | 2 | **12.5** | **W1** | **`StubExtractionProvider`** (no-call) + the **manual owner/share entry** form (N11). Already the default today. |
| **2** | **AI-drafted messages** (reminder / committee paragraph) | 4 | 5 | 2 | **10.0** | **W1** | **Deterministic Hebrew templates** with slots filled from real data (the copy the product ships today). |
| **3** | **"While you were away" digest** | 4 | 4 | 2 | **8.0** | **W1** | **Deterministic bulleted digest** — same numbers, plain string-assembled sentences (no prose-smoothing). |
| **4** | **NL assistant** ("מה מצב הרצל 42?" / "מי לא חתם") | 5 | 3 | 3 | **5.0** | W2 | **The normal UI** — project page, the "מי תקוע" list, global search (S4). The assistant is a shortcut, never the only path. |
| **5** | **Committee / lawyer summary pack** | 4 | 4 | 3 | **5.3** | W2 | **C1 print-of-record** (deterministic, basis-labeled tally) + the existing `export` xlsx/pdf. AI only writes the prose preamble. |
| **6** | **Insight / anomaly** ("stalls like 3 that recovered") | 4 | 2 | 3 | **2.7** | W3 | **The deterministic analytics signal itself** (cohort + N + band) shown as a plain stat; AI omitted = the number stands alone. |
| **7** | **Predictive — who will delay / object** | 3 | 1 | 5 | **0.6** | **DEFER** | **The deterministic ranker** (stalledDays / nextExpiryAt distance — doc 03 DECIDE). No per-person prediction at all. |
| **8** | **AI objection-response drafting** | 3 | 1 | 4 | **0.75** | **BLOCKED on data (B2)** | **Manual reply** + (post-B2) the same templates as #2. Blocked until the `decline_reason` field exists. |

> Scores cluster into tiers, not a strict order. **First AI wave = #1, #2, #3** (ride existing
> seams, no new sensitive flow beyond the parse, human-gated by construction, and each has a
> fully-usable AI-OFF path that is *already what ships today*). See §4.

---

## 3. Per use-case — value · data (honesty) · risk+guard · effort · slot · **NON-AI FALLBACK**

### #1 — Tabu/נסח PDF extraction → owners + shares  ⭐ FIRST WAVE
- **User value.** The single most painful, most error-prone onboarding step: typing dozens of
  owners + exact ownership fractions off a Hebrew נסח טאבו PDF. Gemini reads Hebrew + scanned PDFs
  well. ~30 min of error-prone transcription → a 30-second review. The flagship "the system already
  did the work" moment.
- **Data — exists? (honest).** **Yes, fully.** The envelope, the encrypted row store, the review
  screen, the confirm/commit, and the **seam itself** all exist. `StubExtractionProvider` returns a
  deterministic parse of a `name|nationalId|num/den` line format. A `GeminiExtractionProvider` is a
  *drop-in* behind `IExtractionProvider.extract({bytes, mimeType, text})` →
  `{rows:[{name?,nationalId?,shareNumerator?,shareDenominator?,confidence}], rawText?, engineId}`.
  Nothing downstream changes.
- **Fabrication / PII risk + guard.**
  - **PII leaves the process** — the ONE use-case where decrypted PII (names + national_id)
    legitimately reaches Gemini, because the נסח *is* the PII source. Guards: (a) the **mandatory
    human-confirm gate already exists** — `confirm()` is the only writer of ownerships from a parse;
    (b) per-row `confidence` is stored + surfaced — low-confidence rows flag for scrutiny; (c) a
    **DPA + zero-retention** requirement on the Gemini call; (d) parsed PII is encrypted at rest the
    instant it returns (`encryptField`) — never logged/audited as a value (audit carries
    `rowCount`+`engineId` only, already implemented).
  - **Fabrication** — an LLM can hallucinate a name or fraction. Guard: the confirm path
    **re-validates** every committed row has identity + share and fractions sum to exactly 1
    (deferred-sum trigger). A hallucinated fraction breaking the sum surfaces as a clean 400, not a
    silent bad commit.
- **Rough effort.** **Small.** One `GeminiExtractionProvider` class + a strict-JSON prompt
  ("extract owners + ownership fractions from this Hebrew נסח טאבו; return strict JSON; do not
  invent"), a Zod parse of the model JSON into `ExtractionResult`, Infisical creds, and the 3-line
  factory branch. Everything else is reuse.
- **Slot.** `extractionProviderFactory()` — already the documented swap point. Zero new endpoints.
- **🟢 NON-AI FALLBACK (already built).** Two layers: (1) **`StubExtractionProvider`** runs offline
  if no engine creds — a real deterministic parse, no external call; (2) the **manual owner/share
  entry** path (build-plan **N11** ships labeled manual-entry regardless). On a Gemini timeout /
  circuit-open, `runExtraction()` falls back to the Stub or returns an empty draft, and the review
  screen becomes a blank-but-fully-usable manual grid. **The onboarding flow never blocks on AI.**
  This is the cleanest first LLM win in the product *because* its fallback is the current shipping path.

### #2 — AI-drafted messages (reminders, committee paragraph)  ⭐ FIRST WAVE
- **User value.** The יזם is a domain expert, not a copywriter. "Propose, don't ask": the system
  pre-writes the reminder SMS / committee-update paragraph in tone-appropriate Hebrew; he taps
  approve or lightly edits. Removes the blank-page tax from every outreach.
- **Data — exists? (honest).** **Yes, as derived context.** A reminder draft needs owner
  display-name (or neutral "בעל/ת הדירה"), apartment label, days-since-request, expiry date — all
  from `signature_requests` + `apartments` + B1. A committee summary needs project name,
  signed/total, momentum, nearest expiry — all real.
- **Fabrication / PII risk + guard.**
  - **Minimize PII in the prompt.** Never send `national_id` or phone to Gemini for drafting — they
    add nothing to copy. Send **first name only** if personalization is wanted, or a role token.
    Counts/dates are not PII.
  - **Human-approval gate mandatory** — the draft is a *proposal*; the manager approves before send.
    Never auto-send AI copy unreviewed.
  - **Tone / legal drift.** Numbers/% are **injected as ground-truth** the model must echo verbatim
    (template-with-slots, not free generation of numbers); a post-generation **number-echo
    validator** rejects any draft whose numbers don't match the injected facts.
- **Rough effort.** **Small–medium.** A new `IMessageDraftProvider` seam (mirror
  `IExtractionProvider`) + a draft endpoint that assembles grounded context, calls Gemini, returns
  the draft to the approval UI. Rides existing messaging / reminder rails for delivery.
- **Slot.** New thin `draft` provider seam; producer in `messaging` / signature-reminder flow;
  output → the existing approve-and-send UI.
- **🟢 NON-AI FALLBACK.** The seam's **default impl is a deterministic Hebrew template** with the
  same data slots ("שלום, טרם נחתם המסמך עבור דירה {N}. נשמח אם תחתום/תחתמי עד {date}."). On a
  Gemini failure the draft endpoint returns the template-filled message — **identical send flow,
  just less polished prose.** The manager still approves-and-sends. The number-echo validator runs
  in BOTH modes, so the template path is the safer one. **Outreach never depends on AI.**

### #3 — "While you were away" digest  ⭐ FIRST WAVE
- **User value.** "Speak like a competent assistant reporting what IT did" (North Star #5). He opens
  the app after 3 days and reads two plain sentences: *"בזמן שלא היית: נחתמו 4 דירות (הרצל 42 כמעט
  שם — חסרה חתימה אחת), ושלחתי 6 תזכורות. דירה אחת פגה — כדאי לחדש."* Pure relief.
- **Data — exists? (honest).** **Yes, and it's the safest source.** The digest is written over the
  **audit log** (incl. `actor_type='system'` rows — what the machine did) + the **B1 pulse**. Both
  are derived, count-level, non-PII signals.
- **Fabrication / PII risk + guard.**
  - **Lowest PII exposure of all.** Feed the model **aggregates + event types**, not raw rows —
    "4 signed, 6 reminders sent, 1 expired" + project labels. No national_id/phone/signature ever
    enters the prompt.
  - **Fabrication.** Pass a **closed, structured digest object**; the model's job is **phrasing
    only**. The number-echo validator confirms every number in the prose appears in the source
    object.
  - Read-only, informational, no action committed → blast radius is just wrong wording, caught by
    the number-check.
- **Rough effort.** **Small.** A digest assembler (query audit + B1 over the since-last-seen window)
  → Gemini for phrasing → cache. Rides B1 + audit; no new sensitive data path.
- **Slot.** Home / mission-control (E2.1). Composes B1 + audit; AI is the phrasing layer only.
- **🟢 NON-AI FALLBACK.** The digest assembler produces a **structured object first**; AI only
  smooths it into prose. On a Gemini failure (or AI-disabled org), render the **deterministic
  bulleted version** of the *same object*: "• נחתמו 4 דירות • נשלחו 6 תזכורות • דירה 1 פגה". Same
  facts, same numbers, list instead of paragraph. **The home surface is fully informative without
  AI** — the LLM is pure cosmetic uplift here, the strongest dual-mode case in the set.

### #4 — Natural-language assistant ("מה מצב הרצל 42?" / "מי לא חתם ולמה?")
- **User value.** Very high — a conversational control surface over real signals, with one-tap
  actions ("שלח תזכורת לאורי"). The "it gets me" peak.
- **Data — exists? (honest, with a sharp caveat).**
  - **"מה מצב הרצל 42?"** → **Yes** (project status, signed/total, momentum, nearest expiry from
    B1 + project reads).
  - **"מי לא חתם?"** → **Yes** (`signature_requests WHERE status='pending'` joined to
    owners/apartments).
  - **"...ולמה?"** → **⚠ NO. The "why" does not exist** today — status is
    `pending|signed|cancelled|expired` only; **no reason field** (B2 plans `decline_reason`). The
    North Star itself flags this gap. **The assistant must NOT fabricate a reason** — it says *"אורי
    מדירה 7 עדיין לא חתם — 9 ימים, תזכורת אחרונה אתמול. סיבה לא תועדה."* until B2 ships.
- **Fabrication / PII risk + guard.**
  - **Architecture guard (mandatory): tool-calling / retrieval, NOT free-form DB-to-prompt.** The
    assistant answers ONLY from **whitelisted, tenant-scoped, RLS-enforced query tools** (the same
    `withTenant` reads the UI uses) — never raw table access. The model phrases tool results; it
    does not retrieve freely. This preserves RLS, masking, and the no-fabrication boundary.
  - **PII.** Tool results are already role-masked (`resolveOwnerPiiFidelity`); no national_id in
    answers; names only if the caller is unmasked.
  - **Prompt-injection** from any owner-supplied free text → treat tool inputs as untrusted; the
    model cannot escalate beyond its whitelisted tools.
  - **One-tap actions** route through existing approval-gated endpoints (send-reminder etc.), never
    an AI auto-action.
- **Rough effort.** **Medium–large.** Tool/function-calling layer with ~6–10 whitelisted read tools,
  action tools deferring to approval endpoints, conversation state, prompt hardening.
- **Slot.** New `assistant` module; tools wrap existing services. **Depends on B1 + ideally B2.**
- **🟢 NON-AI FALLBACK.** The assistant is a **convenience layer over the normal UI, which fully
  exists** — the project page answers "מה מצב הרצל 42?", the "מי תקוע" list answers "מי לא חתם?",
  global search (S4) finds the building, the reminder button does the action. When AI is
  down/disabled, the assistant input simply **routes the query to deterministic search + deep-links
  to those screens** (or hides the chat affordance entirely). **No user is ever stranded** — every
  answer the assistant gives has a clickable non-AI screen behind it.

### #5 — Committee / lawyer summary pack (AI-written, exportable)
- **User value.** A formal, shareable Hebrew summary for the תמ"א committee / lawyer: project,
  building, consent %, who signed, timeline of system actions — generated, not hand-assembled.
- **Data — exists? (honest).** **Mostly yes.** Counts, consent %, signed list, audit timeline are
  real. **Caveat:** consent % is a **LEGAL number** — it must come from the canonical computation
  (B0 `ConsentCalcService`), injected as ground truth, never "estimated" by the model.
- **Fabrication / PII risk + guard.**
  - The consent % is non-repudiation-grade — the model must **echo the injected canonical value
    verbatim**; reject any output where it differs. Same number-echo guard, legal stakes → Risk 3.
  - Owner names may legitimately appear in a committee pack — gate behind the same PII unlock + role
    fidelity; national_id must NOT appear. Carries the A.1 basis label.
  - Export ties into the existing `export` module; keep AI prose + hard numbers as separately
    verifiable blocks.
- **Rough effort.** **Medium.** Grounded-context assembler + Gemini phrasing + export integration.
- **Slot.** `export` module + a summary assembler. Rides #3's phrasing pattern.
- **🟢 NON-AI FALLBACK.** The **C1 print-of-record** (build-plan go-live blocker) is the
  deterministic, basis-labeled legal artifact — it exists independent of AI. The xlsx/pdf `export`
  module produces the hard tally. AI only adds a **prose preamble/narrative**; on failure the pack
  ships with the **deterministic tally + a templated header**, no preamble. The legally-load-bearing
  content is NEVER AI-generated, so an AI outage cannot affect the legal artifact at all.

### #6 — Insight / anomaly ("this stalls like 3 others that recovered when you did X")
- **User value.** High *if real* — turns the product from reactive to advisory: pattern-match the
  current project's trajectory against historical recoveries and recommend the lever that worked.
- **Data — exists? (honest).** **Partially, and thinly.** Derivable from history
  (`signature_requests` timelines + audit of preceding actions), BUT: (a) a 2-dev MVP has **little
  historical volume** — "3 others that recovered" may not exist yet; (b) causal attribution
  ("recovered *when you did X*") is a strong claim the data rarely supports. High fabrication risk
  if the model asserts causation from coincidence.
- **Fabrication / PII risk + guard.** Danger = **confident-but-false causal claims**. Guard: compute
  the pattern-match + candidate action in **deterministic code** (cohort of similar-trajectory
  projects, what action correlated with recovery, with N + a confidence band); the model only
  *phrases* it, and only when N is above a floor. Below the floor, say nothing. PII risk low
  (aggregate cohorts).
- **Rough effort.** **Large.** Real analytics (cohorting, trajectory features) before any AI
  phrasing. The AI is the smallest part.
- **Slot.** New analytics service feeding home/insight. WAVE 3.
- **🟢 NON-AI FALLBACK.** The **deterministic analytics signal is the product** — the cohort match,
  N, and confidence band are computed without AI and shown as a plain stat ("מצב דומה ל-3 פרויקטים;
  ב-2 מתוכם חידוש בקשה הזיז קדימה"). AI only rephrases it conversationally. When AI is off, the stat
  stands alone. And below the N-floor, **both modes say nothing** — the fallback is silence, never a
  guess.

### #7 — Predictive — who will delay / object  (DEFER)
- **User value.** Attractive in theory (chase likely-stallers first).
- **Data — exists? (honest).** **No usable label, and a hard ethics/PII wall.** Predicting a
  *person's* future behavior from PII-adjacent features on a legal signature process is (a)
  data-poor at MVP scale, (b) a **profiling** activity with real GDPR / Israeli-privacy exposure on
  PII subjects, (c) high reputational risk if a wrong prediction shapes how a real owner is treated.
- **Fabrication / PII risk + guard.** **Risk 5.** The use-case most likely to fabricate a harmful
  signal about a real person. No guard makes it MVP-safe.
- **Rough effort.** Large + legal review. **DEFER.** If ever built: aggregate/anonymized only, never
  per-named-owner.
- **🟢 NON-AI FALLBACK (and the preferred path).** The **deterministic ranker** (doc 03 DECIDE step)
  already orders chase priority by *observed* signals — `stalledDays`, `nextExpiryAt` distance,
  reminder-count — **with zero prediction about a person**. This is not a degraded fallback; it is
  the *correct* design. We ship the ranker and do NOT predict per-person behavior.

### #8 — AI objection-response drafting  (BLOCKED on data)
- **User value.** Draft a tailored Hebrew response to an owner's objection.
- **Data — exists? (honest).** **No.** Same root cause as #4's "why": there is **no objection text /
  reason field** today. With no objection captured, there is nothing to respond to. **Blocked until
  build-plan B2** adds `decline_reason` + `'declined'`.
- **Risk + guard.** Once unblocked, identical guards to #2 (human-approval, no legal promises,
  minimize PII). Risk 4 — objection content may itself be sensitive + prompt-injection-bearing.
- **Effort.** Small *after* the data exists. Sequenced behind B2.
- **🟢 NON-AI FALLBACK.** Manual reply via the normal messaging flow (today's path), and post-B2 the
  same deterministic templates as #2 keyed off the recorded `decline_reason`. **The objection
  workflow is fully usable by hand without AI.**

---

## 4. The first AI wave — name the 2–3

**Ship these three first** (highest score, ride existing seams, human-gated by construction, and —
decisively — **each one's AI-OFF fallback is already the current shipping path**, so dual-mode is
proven before a single Gemini call is made):

1. **#1 Tabu/נסח extraction (Gemini provider).** Drop-in behind `IExtractionProvider`; the
   human-confirm gate, encryption, and audit are already built. **Fallback = the `StubExtractionProvider`
   + manual entry that ship today.** Smallest effort, biggest "it did the work" payoff. **Start here.**
2. **#2 AI-drafted reminders + committee paragraph.** Rides messaging/reminder rails; manager
   approves; numbers injected as ground truth. **Fallback = deterministic Hebrew templates.**
   Compounds "propose, don't ask" immediately.
3. **#3 "While you were away" digest.** Safest data path (aggregates + audit, no raw PII), pure
   phrasing over B1 + audit. **Fallback = the deterministic bulleted digest of the same object.**

**Why not the NL assistant first** (despite Value 5): it depends on B1 *and* carries the "...ולמה?"
fabrication trap requiring the B2 objection field to answer honestly, plus a tool-calling +
prompt-injection hardening cost. It's the right *second* wave — once B1 is live and B2 exists, it
becomes the showcase, with the normal UI as its standing fallback.

---

## 5. Cross-cutting decisions / recommendations (feed synthesis)

1. **Build the seam dual-mode FIRST, AI second.** For every capability, ship the provider seam +
   its deterministic default (Stub/template/bulleted-digest) **before** wiring Gemini. The
   capability is then fully usable from day 1; the Gemini provider is a later, reversible config
   swap. This is exactly why #1 is cheap — its non-AI default already shipped.
2. **Wrap every Gemini call in timeout + circuit-breaker + catch→fallback.** A standardized
   `withAiFallback(deterministicFn, aiFn, {timeoutMs, breaker})` helper makes an AI-layer failure an
   invisible soft-degrade, org-wide kill-switchable (`AI_ENABLED` env, mirroring
   `CAMPAIGN_SEND_ENABLED`). No service calls Gemini directly.
3. **Add an `IMessageDraftProvider` seam now, mirroring `IExtractionProvider`.** Keeps Gemini behind
   one swap point per capability and lets drafting ship with a deterministic template stub first.
   Don't let AI calls leak into services ad-hoc.
4. **The number-echo validator is a shared, reusable guard.** #2/#3/#5 all need "every number in the
   AI prose must appear verbatim in the injected ground-truth object." Build it once — it runs in
   BOTH the AI and template paths and is the cheapest defense against the most damaging failure (a
   wrong consent %).
5. **PII-minimization is a design rule, not a per-feature afterthought.** Only **#1** legitimately
   sends decrypted PII to Gemini (the נסח *is* PII). #2–#6 send **derived signals + first-names-at-
   most**, never national_id/phone/signatures. Require a **DPA + zero-retention** config on the
   Gemini account before #1 ships.
6. **The NL assistant must be tool-calling over RLS-scoped reads, never raw table-to-prompt** — the
   architectural decision that keeps tenant isolation, masking, and no-fabrication intact when the
   model becomes conversational.
7. **Honor the DO-NOT-FABRICATE register at the AI layer: never invent the "why".** The
   `signature_requests` status enum has no reason field; sequence build-plan **B2** as the unblock
   for #4's "...ולמה?" and #8 — until it lands, the assistant says "סיבה לא תועדה," never a guess.
