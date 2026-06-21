# 02 — PRECISION / EXECUTION-READINESS (v8 final-verification front)

> **Front:** Precision / execution-readiness — *is every slice buildable autonomously,
> WITHOUT mid-build clarification?*
> **Mandate:** rate every slice in the consolidated set (v4's 41 + v7's Wave-5 FLOW/X/DOM
> + the v5/v6 additions) **READY / NEEDS-DETAIL / OWNER-GATED**; name the under-specified
> slices; produce the definitive list of legitimate STOP-points for the autonomous run.
> **Method:** every load-bearing feasibility claim re-grounded against the real tree
> (`apps/api/src/modules/**`, `apps/web/src/**`, `packages/**`) at `file:line`. Skeptical
> by construction — a slice is READY only if the WHAT is concrete, the FILES/ENDPOINTS are
> named, the GATE/DoD is explicit, and no hidden owner/legal decision sits mid-build.
> **Author:** v8 precision-verification seat, 2026-06-18. READ-ONLY — no app code changed.

---

## 0. VERDICT (one line)

**`precise-enough-to-run-autonomously` — with 9 hard STOP-points and 11 NEEDS-DETAIL
slices that must be specified at wave entry, not mid-build.** The 41+ slice plan is the
most execution-ready planning body I have verified: ~30 of 41 v4 slices are READY as
written, every CRITICAL slice names the exact `file:line` it edits, and every code claim
I spot-checked held. The risk is **not** scope discovery mid-build — it is (a) a small set
of slices whose **WHAT is a decision, not a spec** (the OWNER-GATED set), and (b) a
slightly larger set whose **contract is named but not pinned** (NEEDS-DETAIL). The
autonomous run is safe **if and only if** it treats the 9 STOP-points as hard pauses and
resolves the 11 NEEDS-DETAIL contracts at wave entry. Left to "decide mid-build," the
OWNER-GATED slices would hit a legal/ops wall the agent cannot resolve.

---

## 1. CODE-GROUNDING — every load-bearing claim re-verified (this is what earns the verdict)

The plan's precision rests on its `file:line` anchors being **true**. I re-ran them. All held:

| Claim (plan cites) | Verified in tree | Result |
|---|---|---|
| `projects.update()` `status` is any→any, no transition guard | `projects.service.ts:773` `if (input.status !== undefined) patch.status = input.status;` | ✅ CONFIRMED (N2) |
| `projects.update()` UPDATE has no `updatedAt`/version predicate | `projects.service.ts` `tx.update(projects).set(patch).where(eq(projects.id, id))` — no version clause | ✅ CONFIRMED — silent last-write-wins (N1) |
| consent is binary by-heads, no `ownerships.share_*` | `projects.service.ts:~420` `consentedPct = apartmentsConsented/totalApartments`; `metThreshold = consentedPct >= targetSignaturePct`; CTE counts owners, never shares | ✅ CONFIRMED (N4/B0) |
| portal denominator reads links-sent, not apartments | `apps/web/src/adapters/portal.ts:327-328` `signedPct = signaturesSigned/signaturesTotal` | ✅ CONFIRMED — second wrong number (N4 portal half) |
| notification.ts has exactly 8 kinds, none of expiring/stalled/threshold | `packages/shared-types/src/notification.ts:13-21` — 8 kinds, none present | ✅ CONFIRMED (B3) |
| scheduler already runs 3 sweeps | `apps/worker/src/main.ts:245/274/309` `boss.schedule(REAPER/AUDIT_RETENTION/SIGNATURE_EXPIRY)` | ✅ CONFIRMED — B3 is "add a 4th consumer," not "build a scheduler" |
| tabu extraction is a stub | `extraction-provider.factory.ts:36` `return new StubExtractionProvider();`; gemini branch commented at `:33-34` | ✅ CONFIRMED (N11) |
| no `reminder_count`/`last_reminded_at` | `packages/db/src/schema/artifacts.ts` — absent | ✅ CONFIRMED (A1 one-column unlock) |
| DSAR/RTBF routes exist, no UI | `owners.controller.ts:128 @Get(':id/data-export')` + `:139 @Post(':id/erase')` | ✅ CONFIRMED (N6/C16 blocker) |
| campaign computes per-owner `failed`+reason, UI drops it | `signature-requests.service.ts:482-493` outcome `created\|skipped_existing\|failed`+reason | ✅ CONFIRMED — N7 is a UI-presentation gap, data is on the wire |
| member-overrides PUT/DELETE exist, no UI | `member-overrides.controller.ts:47 @Put / :57 @Delete` | ✅ CONFIRMED (C16) |
| B1 pulse + B4 holdout routes do NOT exist | grep `signature-pulse\|holdouts` across `modules/**` = 0 hits | ✅ CONFIRMED — both net-new |
| renter is a dead no-op | `ownership.ts:23 RelationshipSchema = z.enum(['owner'])` | ✅ CONFIRMED (C10/G10) |
| SSE 30-stream cap | `imports.controller.ts:291 MAX_ACTIVE_STREAMS = 30` | ✅ CONFIRMED (N17) |
| board returns bare null on error | `signature-progress-board.tsx:36 if (isError || !data) return null;` | ✅ CONFIRMED (C2) |
| no global validation pipe | `main.ts` / `app.module.ts` — no `APP_PIPE`/`GlobalZodValidationPipe` | ✅ CONFIRMED (S0-SEC net-new) |
| `CAMPAIGN_SEND_ENABLED` kill-switch | grep across `apps/api/src` = 0 hits | ✅ CONFIRMED — N15 net-new (1-line) |
| FE primitive layer thin | `components/ui/` = button · list-page-shell · list-skeleton · name-display · status-badge — **no ConfirmDialog, no toast** | ✅ CONFIRMED — the v5 "real surprise" |

**Two DRIFT findings the autonomous run must reconcile (cite, do not silently trust the plan):**

1. **ConfirmDialog status is INCONSISTENT across the planning body.** v5
   (`02-puzzle-vs-rebuild`) and the v3 matrix §0 both say it **already exists** on the
   unmerged branch `fix/styled-confirm-dialog` (commit `becce1d`, fully a11y-correct) —
   I confirmed the branch exists (`git branch -a` → `fix/styled-confirm-dialog` local +
   remote) but it is **NOT in the working tree** (`find apps/web/src -iname '*confirm*'`
   returns only `step-up-unlock.tsx`). So the correct task is **"rebase/land the existing
   PR," not "build from scratch"** — yet the v4 FINAL-BUILD-PLAN's Wave-0 DoD speaks of
   building the primitive. **This must be pinned at Wave-0 entry**, else two agents build
   the same modal twice.
2. **`window.confirm` count drifted 17→13.** The v3 matrix cites "exactly 17 live
   `window.confirm`"; the working tree now has **13** (`grep -rl window.confirm` = 13
   files). Whoever sequences the confirm-migration must re-baseline, not trust "17."
   Also `M0b live-region "shipped as PR #413"` (FINAL-BUILD-PLAN §E) is **unverified in
   the working tree** — no `live-region`/`action-toast` file exists; the M0+G6 primitive
   is genuinely net-new, reinforcing v5's "harden the FE primitive layer as a Wave-0
   prerequisite" correction.

> **Net:** the plan's `file:line` precision is real and trustworthy on the *defects*. The
> drift is on the *remedies already in flight* (ConfirmDialog branch, M0b, the 17→13
> count) — a stale-inventory class of error, credibility-only, but it must be re-baselined
> at Wave-0 entry so the autonomous run does not duplicate or under/over-scope.

---

## 2. PER-SLICE READINESS RATING

Legend: **READY** = WHAT concrete + files/endpoints named + DoD explicit + no mid-build
decision. **NEEDS-DETAIL** = real spine, but a contract/baseline must be pinned at wave
entry before an agent can build without guessing. **OWNER-GATED** = a legal/ops/scope
decision sits inside the slice; the agent MUST pause (a STOP-point) — building "a guess"
is unsafe.

### Wave 0 — Foundation + security/perf gate (9 slices)

| Slice | Rating | Why |
|---|---|---|
| **S0-SEC** global pipe + coverage guard | **READY** | Files named (`main.ts`, `app.module.ts`, every `*.controller.ts`, new `input-validation-coverage.spec.ts`); the 4 `@RawBody`/`@NoValidation` exceptions enumerated; modeled on the existing `api-docs-coverage.spec.ts`. Concrete. |
| **PERF** cache + seeded-50-project gate | **NEEDS-DETAIL** | The WHAT is clear (read-through `cache_kv` over `orgStats`+`signatureProgress`, invalidation on writes), but **the cache-key shape + the exact invalidation write-set + the "seeded 50-project / warm 200ms" pass-threshold are not pinned**. An agent can build a cache; it cannot know which writes invalidate which keys without a spec. Pin the invalidation matrix at entry. |
| **E2.0** tokens | **READY** | Exact bugs named (`bg-card` ×41, `--r-lg` 12-vs-8, `borderRadius.lg`); additive; existing ratchet proves it. |
| **E2.0-GUARD** class-leak guard | **NEEDS-DETAIL** | The guard regex is given, but the slice's own gate says "**RE-MEASURE the baseline across the FULL tree FIRST** incl. provider subtree" — i.e. the floor is **unknown until measured**. That measurement IS the missing detail; do it at entry or the ratchet starts from a false floor. |
| **E2.0b** StatusPill + statusColor→intent | **READY** | Every VM/adapter/spec listed (`project.vm.ts:28`, 6 adapters, 3 specs); rename guarded by `adapters/*.spec.ts`. |
| **M0+G6** live-region primitive | **NEEDS-DETAIL** | Net-new primitive (confirmed not in tree); the contract (ESC/trap/roles via `ConfirmDialog` precedent) is named but the **~11 bespoke "saved" sites must be enumerated** (the slice says "enumerate ALL"). Enumerate at entry. Also reconcile with the unmerged ConfirmDialog branch (§1 drift). |
| **M1** motion tokens | **READY** | Token list explicit; `prefers-reduced-motion` guard concrete. |
| **P-TZ-1** relative-time fix | **READY** | `format.ts` + 18 adapters; the test (UTC instant near IDT boundary) specified. |
| **C2** DataState contract | **READY** | Concrete: kill `signature-progress-board.tsx:36` bare null; 4 states named; wires M0/G6. |

### Wave 1 — Structural + consent + integrity (6 slices)

| Slice | Rating | Why |
|---|---|---|
| **B0** share-weighted consent | **OWNER-GATED** (build behind A.1) | The *engineering* is READY (CTE re-author at `:355-431`, portal fix at `portal.ts:327`, extract `ConsentCalcService`, wire-contract pinned). But the **exact statutory % (66/67/pre-2023 80% grandfathering) + partial-share counting (OD-3) + SHELL-owner denominator** are a **lawyer decision (OD-1)**. D.1 locks share-weighted as the basis so the build is **not blocked** — it ships behind the A.1 interim basis-label. **STOP-point = the legal % confirmation only**, not the slice. |
| **B5** state-machine + optimistic-concurrency | **READY** | Both halves named with `file:line` (`:773` transition map; `:803` If-Match/`updatedAt` precondition → 409 `stale_write`); per-edge tests enumerated. No migration. The single most execution-ready CRITICAL slice. |
| **E2.2-S1** board-first tabs | **READY** | Scope fenced to tab DEFAULT+ORDER (`project-detail.client.tsx:79`); merger explicitly deferred. |
| **E2-IA-S2** sidebar 14→5 | **READY** | `sidebar.tsx:113-145` regroup, keep all routes; S4 co-ships (D.4). |
| **S4** global search omnibox | **READY** | Reuses `owners.controller.ts:72 POST /owners/search`; PII-in-body, no `?q=`. |
| **C13** auth/onboarding re-skin | **READY** | 7 pages listed; keep `method="post"` + GET-fallback guard. No auth-path logic change. |

### Wave 2 — Backend-gated surfaces (6 slices)

| Slice | Rating | Why |
|---|---|---|
| **B1** pulse endpoint | **READY** | Net-new but the **row contract is PINNED** (`ProjectPulseRow` fields + the exact join math for `signedThisWeek`/`stalledDays`/`nextExpiryAt`); reuses `orgStats` CTE + agent-scope. Exemplary spec. *(Caveat: A2's `rankAttention()` ordering is undefined — see §3.)* |
| **B4** holdout-name read | **READY** | Concrete route + shape given; mirrors `owners/:id/reveal-pii` gate/audit; `view_owner_pii`-gated, no national_id/phone. |
| **E2.1** home mission-control | **READY** | Files named; Viewer-routing break called out; Pattern-A migration specified; empty-org state required. |
| **E2.2-S3** board-first content | **READY** | Real `ThresholdProgress` + basis label; never-null (C2); apartment-grained until B4. |
| **M2** the one chase loop | **READY** | `resendSignatureRequest` over `:142` (audited/409-guarded); optimistic undo via `prev`; `recipient_not_associated` 409 envelope specified. |
| **E2-list** projects-list full-power | **READY** | Sort-by-distance zero-BE now; momentum sort gated on B1 (sequenced). |

### Wave 3 — Movie + autonomy (4 slices)

| Slice | Rating | Why |
|---|---|---|
| **M3** wow 1+2 | **READY** | Client-cache edge-diff of `metThreshold`; inherits A.1/B0 correctness gate; reconcile count-up vs LCP (G-MOTION-PERF) — noted, not blocking. |
| **B3** autonomy worker | **OWNER-GATED** (infra) | Engineering READY (add 1 pg-boss consumer mirroring the 3 proven sweeps + 3 notification kinds + `notification-links.ts` targets + FE deep-links; idempotency/locking pattern named). **STOP-point = owner approval to run a recurring autonomous consumer** (the autonomy copy stays off until then). Blocker only if autonomy is a launch requirement. |
| **M5** campaign narration + preview + failed-surface | **READY** | `failed` surface is cheap (data at `:482-534`); new `preview` route specified; the ONE justified confirm. Depends on ConfirmDialog (§1 — land the branch). |
| **B2** "why" layer + withdrawn | **OWNER-GATED** (Gate-6 migration + legal) | Migration spec is concrete (`ADD COLUMN decline_reason` + widen status CHECK to `'declined'`, mirror 0063; CHECK-ripple budget enumerated). **STOP-point = (a) Gate-6 migration approval + (b) owner/legal call on whether `withdrawn` (N13) is in MVP scope.** The `declined` half is buildable on migration approval; the `withdrawn` half is a scope decision. |

### Wave 4 — Completeness + operator control (16 slices)

| Slice | Rating | Why |
|---|---|---|
| **C1** committee print-of-record | **OWNER-GATED** (artifact) | **STOP-point = print-stylesheet vs server-rendered audited PDF.** v5 downgrades it to PARTIAL (reuse `pdf-signed-document.renderer.ts`) — but the FE-vs-BE fork is a net-new BE slice on one branch and not the other. Owner must pick before build. Go-live blocker. |
| **C12b** provider operator console (recovery) | **OWNER-GATED** (scope) | **STOP-point = confirm the MFA-reset/unlock/resend-invite subset as the go-live-blocker boundary** (the rest post-MVP). Net-new full-stack (`provider-tenant-users.controller.ts:59` is read-only today — confirmed). The single biggest rebuild; the subset boundary is an owner call. |
| **C16** headless-route surfacing | **OWNER-GATED** (DSAR scope + confirm design) | DSAR/RTBF routes exist (confirmed); the **erase confirm-design (irreversible) + the DSAR-scope boundary** are owner decisions. **STOP-point = confirm DSAR/RTBF UI is the go-live subset.** member-overrides PUT/DELETE surfacing is READY underneath. |
| **C5** wizard + persist-or-drop | **NEEDS-DETAIL** (+ N16 decision) | Re-skin is READY; but **N16 — persist `unitType`/`areaSqm` (schema/Gate-6 migration) vs stop collecting** — is a fork the agent cannot pick alone (persist = migration). Pin the decision at entry; "must close before prod." |
| **C8** import re-skin + SSE reconcile | **READY** | Files named (`use-import-progress.ts`, 11 refs); N17 noted as a known ceiling (LISTEN/NOTIFY post-MVP). No mid-build decision. |
| **C7** contractor share view | **READY** | `contractor/share/page.tsx` leak lines listed; "restore dropped lifecycle status"; reconcile `external_read` vs cookie path (G9) named. |
| **C14** tenant portal + OTP | **READY** | Leak lines listed; P1.2 OTP phone-refine into schema specified; portal % fixed in B0 not here (noted). |
| **C15** messages topbar | **READY** | 6 `messaging.controller.ts:34-73` routes; `notification-links.ts:26` deep-link survival. |
| **C12** provider visual re-skin | **READY** | 8 pages + `pc-sidebar.tsx:99-121` listed; hardcoded `bg-emerald/amber/red` named; P1.3 ParseUUIDPipe→Zod. |
| **C17** list-level control: bulk + saved views | **NEEDS-DETAIL** | Net-new bulk routes on `projects.controller.ts` (single-`:id` today — confirmed); but **the bulk-verb contract (partial-failure semantics, idempotency, max batch size) + saved-view persistence model are not pinned.** Depends on B1 + E2-list. Pin the bulk-failure envelope at entry. |
| **N11** tabu honesty gate | **OWNER-GATED** (decision) | **STOP-point = labeled manual-entry NOW vs build the real נסח parser.** The stub is confirmed (`:36`). The whole review apparatus is built; only the engine-vs-label decision blocks. Go-live honesty gate. |
| **C10** discovery/field-work FE | **OWNER-GATED** (scope) | **STOP-point = E2 scope vs post-MVP.** Plus the renter no-op (`RelationshipSchema`) needs a shared-types migration. Owner-scoped. |
| **C11** populated calendar | **OWNER-GATED** (scope) | **STOP-point = E2 scope vs post-MVP;** `GET /calendar` is net-new BE if pulled in (a `CalendarService` ICS generator exists but no feed route). |
| **M6** StepUpDialog a11y retrofit | **NEEDS-DETAIL** | The a11y add is concrete; but "**reconcile owner-PII reveal: same gate as documents? (C-f)**" is an open design decision inside the slice. Pin it. |
| **C-c** milestone overlay | **NEEDS-DETAIL** | Literally "decide the overlay" — one decision line, no concrete spec. Trivial, but not buildable as written. |
| **C-d** member-permission override surface | **NEEDS-DETAIL** | "Name the override engine in the Access tab" + "**reconcile with C16's member-overrides surfacing**" — an overlap that must be de-conflicted before build (who owns the surface?). |
| **C-l** correct stale inventory numbers | **READY** (doc-only) | Mechanical doc edit. (Ironically, §1's 17→13 drift is a fresh instance — fold it in.) |

### Wave 5 — v7 document FLOW + external exchange (FLOW-0..4 · X1..X5 · DOM)

| Slice | Rating | Why |
|---|---|---|
| **FLOW-0** additive parenting (`documents.{owner_id,building_id}`) | **READY** | One additive migration, no backfill; the matcher/lens dependency is named. Concrete. |
| **FLOW-1** requirement spine + template | **NEEDS-DETAIL** | The `document_requirements` schema is fully specified (good), but the **§2.3 per-entity template is domain IP that must be owner-validated** (it encodes which docs are `required`/`conditional` per תמ"א/פינוי-בינוי party) — and "**seeded-but-editable per-org**" means the seed content is a domain decision. Pin the template content at entry (lean toward OWNER-GATED for the *catalogue*, READY for the *table*). |
| **FLOW-2** fulfillment matching + roll-up | **NEEDS-DETAIL** | The suggest-confirm matcher is described conceptually; the **matching rule precision (doc_type compatibility map, the subject-join tie-break, the auto-confirm threshold setting) is not pinned.** This is "the only genuinely new logic" (v7's words) — it needs a concrete spec, not a paragraph. |
| **FLOW-3** missing → chase | **OWNER-GATED** (enum migration) + NEEDS-DETAIL | `tasks.requirement_id`/`owner_id` FKs concrete; but **2 new notification enum values + the overdue-sweep cadence** = a Gate-6 CHECK-ripple migration (STOP for migration approval) and the sweep cadence is unpinned. |
| **FLOW-4** the three lenses (FE) | **READY** | Read-models over the spine; component family named (the rebuilt Owners table). Buildable once FLOW-1/2 land. |
| **X1** external_parties + external_exchanges | **READY** | Mirrors `contractors` + `shares`; `defaultExternalScope(kind)` mirrors `defaultSharePermissions()`; RLS-isolation spec gate named. |
| **X2** RECEIVE viewer | **READY** | Generalize `ContractorReadService` to a doc-SET scope; IDOR + no-PII spec + "walk as a real שמאי" gate. |
| **X3** PROVIDE upload-back | **OWNER-GATED** (🔒 security-sensitive) | The FIRST external write tier. **STOP-point = `@security-reviewer` before commit** (per CLAUDE.md PII/auth protocol) — this is an *internal* gate, not an owner gate, but it is a mandatory pause. `expected_types` allow-list + DB rate-limit + the system/exchange-actor model are specified. Buildable, but gated on the security review landing. |
| **X4** package builder + send + receipt | **NEEDS-DETAIL** | `PackageTemplateService` reverses the §2.3 template — so it **inherits FLOW-1's template-content decision.** The composite route + preview/receipt are concrete; the **per-kind expected-set content (וועדה/bank) is the unpinned domain part.** |
| **X5** actor_type='external' migration + watermark + OTP-default + secret split | **OWNER-GATED** (owner/legal) | **STOP-point = watermark legal text + OTP channel (SMS vs email) + the `SHARE_TOKEN_SECRET`/`EXCHANGE_TOKEN_SECRET` split (a new boot env var).** The audit-CHECK migration (`artifacts.ts:299 IN ('user','system','provider')`) is concrete; the rest are owner decisions. |
| **DOM-PKG** filing-package generator | **OWNER-GATED** (scope) + leans on C1+X4 | Blocker-adjacent; depends on the C1 artifact decision + the X4 mechanism. Not buildable until both upstream decisions land. |
| **DOM-1** estate/POA/multi-heir | **OWNER-GATED** (scope, post-MVP) | Genuine net-new domain model; the legal representation rules (who may sign for a share) are a lawyer-shaped decision. |
| **DOM-2** retention/legal-hold | **NEEDS-DETAIL** (post-MVP) | Retention classes by legal class = a policy decision; the cron precedent exists. |
| **DOM-3/4/5/6** deal-terms · permit · relocation · second-signing | **OWNER-GATED** (post-MVP scope) | All explicitly post-MVP, owner-scoped. Listed for completeness; not in the autonomous-run critical path. |

### The v5/v6 additions (A1–A8 · W2/W4 · the AI foundation)

| Addition | Rating | Why |
|---|---|---|
| **A1** reminder memory (`reminder_count`+`last_reminded_at`) | **OWNER-GATED** (Gate-6 migration) | One additive migration (confirmed absent). **STOP = Gate-6 approval** (trivial, mirrors 0063/0065). Must land before B3 so cadence doesn't over-nudge. |
| **A2** next-best-action ranker (`rankAttention()`) | **NEEDS-DETAIL** | Pure scoring function over B1's row — but **the ranking weights/formula are undefined** ("show the 5 that need you with no ranking is just 5 rows sorted by one column" — v5's own critique). Pin the scoring spec; it is the B1 contract's missing half. |
| **A3** "while you were away" digest | **NEEDS-DETAIL** | Needs a `last_seen_at` per user (or reuse session last-activity — pick which) + a digest assembler. Pin the source-of-last-seen at entry. After B3. |
| **A4** bulk-by-intent campaign | **READY** (rides M5+C17) | Recipient resolver exists; cross-project stalled query is the thin add. |
| **A5** anticipatory `expires_at` cards | **READY** | Pure read-only arithmetic; honesty caveat pinned (present/future tense, never "נזכיר"). |
| **A6/A7/A8** propose-build · finish-coach · auto-triage | **NEEDS-DETAIL** | Compositions of B4/B2/`signatureMilestones`; slots must be designed now so deps land into a frame (v5's sequencing). No new data, but the panel specs are unwritten. |
| **W4** composite `build-from-parcel` | **READY** | Wraps existing `parcel-setups.controller.ts:81` composite tx. Highest wow-per-effort net-new. |
| **v6 AI foundation** (IAiProvider/IDecisionProvider/NoopAiProvider + action_queue + autonomy config + `actorType:'ai'` migration) | **OWNER-GATED** (DPA, at the LATER wave only) | The **NOW foundation is READY** (deterministic, Noop default, no PII egress, no LLM, does not touch Wave 0 — mirrors 5 existing seams). The **LATER GeminiProvider wave is OWNER/DPA-gated** (first PII egress). **STOP = the DPA/zero-retention legal decision** before any real LLM call. The split (foundation now, engine later) is correctly sequenced so the autonomous run can build the entire foundation without pausing. |

---

## 3. THE UNDER-SPECIFIED SLICES (NEEDS-DETAIL before they can run)

These have a real spine but a contract/baseline that an agent would otherwise **guess** —
guessing here produces silent rework, not a build failure, which is worse. Resolve each at
**wave entry**, not mid-build:

1. **PERF** — the cache-key shape + the exact invalidation write-set + the pass-threshold.
   *(This gates B0 — the highest-stakes slice — so its vagueness is the highest-priority detail to close.)*
2. **E2.0-GUARD** — the true full-tree leak baseline (incl. provider subtree) must be
   **measured** before the ratchet can start; the slice says so itself.
3. **M0+G6** — enumerate the ~11 bespoke "saved" sites; reconcile with the unmerged
   ConfirmDialog branch (§1).
4. **A2 / B1.rankAttention()** — the ranking formula/weights are undefined; B1 ships a row
   but not an order. This is the single most consequential under-spec: the entire "it's
   managing it" home (E2.1) renders off this order. **Pin the scoring spec with B1.**
5. **A3 digest** — pick the `last_seen_at` source (new column vs session last-activity).
6. **C5 / N16** — persist-vs-drop is a fork (persist ⇒ migration); pin the decision.
7. **C17** — the bulk-verb partial-failure envelope + max-batch + saved-view persistence model.
8. **M6 / C-f** — owner-PII-reveal gate parity decision.
9. **C-c** — the milestone-overlay is one undecided line, not a spec.
10. **C-d ↔ C16 overlap** — de-conflict who owns the member-overrides surface.
11. **FLOW-1 template content + FLOW-2 matching rule** — the domain catalogue (which docs
    are required per party) + the doc_type-compatibility/auto-confirm matcher are the
    genuine net-new logic and are described, not pinned. **X4 inherits the template
    decision.** This is the v7 wave's keystone detail.

> Plus the two **DRIFT re-baselines** from §1 (ConfirmDialog = land-the-branch not build;
> `window.confirm` 17→13; M0b PR-#413 unverified) — mechanical, but must be reconciled at
> Wave-0 entry so no work is duplicated.

---

## 4. THE DEFINITIVE STOP-POINT LIST (where the autonomous run MUST pause)

These are **legitimate, enumerated, non-silent** pauses — a decision the agent cannot and
must not make. The plan's great strength is that **every one is known in advance and each
slice ships behind an interim-safe rule or an explicit gate**, so the run never *discovers*
a wall mid-build — it *arrives* at a known gate. Ordered by wave:

| # | STOP-point | Slice | The decision (owner/legal/ops/internal) | Can build proceed behind it? |
|---|---|---|---|---|
| **1** | **OD-1/OD-3 statutory consent %** | **B0** | Exact % (66/67/pre-2023 80%) + partial-share counting + SHELL-owner denominator. **LEGAL.** | ✅ YES — D.1 locks share-weighted; ship behind the A.1 basis-label. STOP is the *legal % only*, not the slice. |
| **2** | **A1 / B2 / FLOW-3 Gate-6 migrations** | A1, B2, FLOW-3 | Schema-migration approval (`reminder_count`; `decline_reason`+`'declined'`; requirement enum values). **Gate-6.** | ⚠️ PARTIAL — the engineering is ready; the migration cannot run without Gate-6 sign-off. |
| **3** | **B2 `withdrawn` (N13) MVP scope** | B2 | Is post-signature withdrawal in MVP? **OWNER/LEGAL.** | ✅ YES — `declined` ships without it; `withdrawn` is the scoped half. |
| **4** | **B3 recurring-consumer approval** | B3 | Approve a recurring autonomous worker. **OWNER (infra).** | ✅ YES for everything else; autonomy *copy* stays off (A.2) until approved. Blocker only if autonomy is a launch requirement. |
| **5** | **C1 print vs server-PDF** | C1, DOM-PKG | Print stylesheet vs audited server-rendered PDF. **OWNER (artifact).** Go-live blocker. | ❌ NO — the fork changes whether C1 is FE-only or a net-new BE slice. Must decide first. |
| **6** | **C12b / C16 go-live subset boundary** | C12b, C16 | Confirm MFA-reset/unlock/resend (C12b) + DSAR/RTBF (C16) as the go-live subset; rest post-MVP. **OWNER (scope).** | ✅ YES for the subset (it's the blocker); the fuller set is explicitly post-MVP. |
| **7** | **N11 tabu honesty** | N11 | Labeled manual-entry NOW vs build the real נסח parser. **OWNER (decision).** Go-live honesty gate. | ⚠️ The *honest manual-entry* path ships without a decision; shipping "extraction" over the stub is FORBIDDEN — so the STOP protects against the unsafe path. |
| **8** | **C10 / C11 / DOM-1/3/4/5/6 E2-vs-post-MVP scope** | C10, C11, DOM-* | In E2 scope or post-MVP? **OWNER (scope).** | ✅ YES — these are sequenced-out by default; the STOP only fires if the owner pulls them in. |
| **9** | **External-exchange legal/ops gates** | X3, X5 | (X3) `@security-reviewer` mandatory pre-commit — **INTERNAL**, fail-closed. (X5) watermark legal text + OTP channel (SMS/email) + `EXCHANGE_TOKEN_SECRET` split (new boot env). **OWNER/LEGAL + OPS.** | ⚠️ X1/X2/X4 build behind these; X3 cannot commit without the security review; X5 cannot ship without the owner/ops decisions. |
| **OPS** | **Deploy-time secrets** (cross-cutting, not a slice) | Wave-0 tail / pre-prod | `FILE_SCAN_CLAMAV_HOST`+EICAR · PII keys staging/prod · `DOC_ENCRYPTION_KEY` staging/prod · `ALERT_WEBHOOK_URL`+boot assertion (N14 fails-open today) · P0.4 magic-byte (in flight). **OWNER-DEPLOY.** | ✅ Build proceeds; these are **go-live** gates, not build gates — but they MUST be tracked or alerting/PII/encryption silently no-op in prod. |
| **v6-AI** | **DPA / zero-retention legal posture** | v6 LATER wave only | First real PII egress to an LLM. **OWNER/LEGAL.** | ✅ YES — the entire deterministic AI *foundation* builds without it; only the GeminiProvider wave pauses here. |

**Crucial precision property:** **every STOP-point above is a DECISION, not a discovery.**
None is "the agent found a missing endpoint" or "the contract was wrong." The plan's
interim-safe rules (A.1 basis-label, the A.2 DO-NOT-FABRICATE register, the dual-mode AI
guarantee, the "ship the stub honestly" gates) mean the build **continues productively up
to each gate** rather than blocking on it. That is exactly what makes a large autonomous
run safe: the pauses are scheduled, labeled, and each has a defined "build-behind-it" path.

---

## 5. THE ONE STRUCTURAL RISK TO THE AUTONOMOUS RUN (beyond the slices)

The plan is execution-ready *per slice*; the residual risk is **cross-slice de-confliction**
under parallel autonomous agents:

- **Shared-primitive contention.** M0+G6 (live-region) + ConfirmDialog are depended on by
  M2/M5/C2 and most of Wave 4. If agents parallelize, the primitive must land first and its
  API freeze before consumers build. The ConfirmDialog §1 drift makes this acute — two
  agents could build the modal twice. **Mitigation: a hard "primitives-frozen" gate at end
  of Wave 0** (the plan implies it; make it explicit and enforced).
- **Surface overlap.** C-d ↔ C16 (member-overrides), C16 ↔ C10 (discovery routes), M5 ↔ A4
  (campaign preview), E2-list ↔ C17 (triage view vs action). Each is a *known* overlap the
  plan names "reconcile" — but "reconcile" is a human verb. **For an autonomous run, assign
  each overlapping surface a single owning slice at wave entry** so two agents don't both
  edit `projects-list.client.tsx`/`member-overrides` and clobber.
- **The CHECK-widen / migration ripple** (B2, FLOW-3, A1, X5 audit-actor). Each touches
  every raw-SQL test INSERT of the affected table (the schema-constraint-ripple lesson). An
  agent that adds the CHECK without sweeping the seeders breaks the full suite. **The plan
  names this for B2; make the "scan all raw seeders" step a DoD line on EVERY migration
  slice**, not just B2.

These are not scope gaps — they are **concurrency-control gaps in the build process**, and
they are the realistic way a precise plan still goes wrong under multi-agent execution.

---

## 6. VERDICT — is the plan precise enough to run autonomously, and where must it stop?

**YES — precise enough, with the 9 STOP-points as hard pauses and the 11 NEEDS-DETAIL
contracts pinned at wave entry.** The grounding is the strongest I have verified: every
`file:line` defect anchor held under re-check, every CRITICAL slice (S0-SEC, B5, B0, B3)
names the exact code it edits, and the four certainty gates are genuinely buildable as
written. ~30 of 41 v4 slices are READY today; the Wave-5 FLOW/X spine is READY at the
*table/route* level and NEEDS-DETAIL only at the *domain-catalogue* level (the §2.3
template + the FLOW-2 matcher). The OWNER-GATED set is small, fully enumerated, and — the
decisive property — **every gate is a scheduled DECISION reachable behind an interim-safe
rule, never a mid-build discovery.**

**The autonomous run is GO under three conditions:**
1. **Treat the 9 STOP-points as hard pauses** — the agent surfaces the decision and waits;
   it does NOT guess B0's statutory %, C1's print-vs-PDF, N11's honesty path, or run any
   Gate-6 migration unapproved.
2. **Pin the 11 NEEDS-DETAIL contracts at wave entry** — above all **PERF's invalidation
   matrix (gates B0)**, **A2/B1's ranking formula (drives the whole home)**, and **FLOW-1's
   template + FLOW-2's matcher (the Wave-5 keystone)**.
3. **Enforce build-process concurrency control** — a "primitives-frozen" gate after Wave 0,
   single-owner assignment for the named overlaps, and a "scan-all-raw-seeders" DoD line on
   every migration slice. Re-baseline the §1 drift (ConfirmDialog = land-the-branch;
   17→13 confirms; M0b unverified) at Wave-0 entry.

Meet those three and the surprise risk is near zero — exactly as the FINAL-BUILD-PLAN
claims, and now independently re-grounded against the tree.
