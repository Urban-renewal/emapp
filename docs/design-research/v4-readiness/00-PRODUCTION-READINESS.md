# 00 — PRODUCTION READINESS: The Certainty Gate (v4 synthesis)

> **What this is.** The senior-engineering-lead synthesis of the four v4 readiness fronts
> (`01-api-action-map`, `02-long-flows`, `03-engineering-quality`, `04-scale-control-redteam`),
> reconciled against the approved build plan (`v3-coverage/00-FINAL-ROADMAP.md`) and
> **re-grounded in the real code** at the highest-stakes claims (every one re-verified at
> `file:line` below, against the ACTUAL tree `apps/api/src/modules/**`, not the abbreviated
> paths the fronts cite).
> **This is the owner's go/no-go certainty document — written for honesty, not comfort.**
> Author: Senior Engineering Lead seat, 2026-06-18. READ-ONLY — no app code changed.

---

## 0. THE HEADLINE (read this first)

**The plan is DESIGN-complete and the engineering substrate is genuinely production-grade.
It is NOT yet CONTROL-complete — and the build plan is control-AWARE but control-INCOMPLETE.**

The product you have today is, on the inside, much better than the lead's pessimistic
diagnosis: tenant isolation is enforced at four independent layers, the API surface is 100%
Zod-validated/permission-gated/RLS-scoped/audited/idempotent, the forensic + non-repudiation
spine is self-verifying, the kill-switch (org-suspend) works atomically, and — the single
biggest correction — **a real pg-boss cron scheduler is live and running three sweeps.** The
lead's "no scheduler/cron at all" premise is **factually wrong** and all four fronts independently
refute it.

But "certainty that every corner is closed" is NOT yet earned. The substrate gives *control
primitives*; the product does not yet give the *manager* control at 50-customer scale. The clock
**cleans up but never chases**. The legal consent number is **binary by-heads, not share-weighted**
(`metThreshold` can be legally wrong). Project status is **any→any with no guard and no concurrency
check** (silent last-write-wins on a 2-dev-team-per-org product, and `approved` is a *legal* state).
The long flows **silently drop the failures the backend already computed**. There is **no operator
recovery console** (first MFA lockout = a developer with raw DB access). And **15 live API routes
have no screen** — including the legally-mandatory GDPR DSAR/RTBF pair.

None of these is a live security hole. Every one is a *control* gap that bites precisely when
"50 customers + many projects" turns minimal-actions-doctrine into per-row drudgery, or turns a
silent failure into a customer escalation. The plan names most of them (S0-SEC, B0, B5, B3) — but
**under-weights three** (concurrency on `update()`, the operator-recovery half, list-level triage)
and **mis-scopes one** (B3 is "add a consumer + 3 notification kinds," NOT "build a scheduler").

**Verdict: `material-control-gaps` — production-ready AFTER a bounded set of additions, all small,
all unblocked, all named below.** This is a strong product two well-scoped waves away from being
genuinely autonomous and genuinely controllable. It is not chaos. It is not done.

---

## 1. FOUR-FRONT READINESS SCORECARD

| Front | Verdict | One-line | The decisive gap |
|---|---|---|---|
| **01 — API → one-click action map** | **AMBER-leaning-GREEN** | 44 controllers / 158 routes, all guarded/validated/audited; ~90% have a roadmap home | 15 routes with NO UI home (incl. GDPR DSAR/RTBF); no campaign dry-run; 2 roadmap-critical endpoints (B1 pulse, B4 holdout) don't exist |
| **02 — Long multi-step flows** | **AMBER** (design-complete, control-incomplete) | Flows built + several genuinely well-engineered (campaign, import, tabu lifecycle) | No proactive chase cron; failures silently dropped at the UI; portal consent % legally misleading; tabu parser is a STUB |
| **03 — Engineering quality** | **production-ready foundation, control-incomplete** | RLS-FORCE × 4 layers, owned auth, atomic idempotency, real metrics+breach detector, real scheduler | `projects.update()` = no transition guard AND no optimistic concurrency; no global validation pipe/CI guard; hot aggregations uncached |
| **04 — Scale control red-team** | **`control-PARTIAL`** | Forensic/kill-switch/per-recipient-outcome spine is BETTER than the roadmap claims | No operator-recovery half (unlock/MFA-reset); no list-level triage/bulk/saved-views; status guard; concurrency; chase-output |

**Cross-front agreement is total on the three things that matter most:**
1. **The scheduler EXISTS** (all 4 fronts refute the lead) — it just doesn't *chase*.
2. **`projects.update()` is the single highest-impact integrity defect** (fronts 02·03·04 all rank it P0/CRITICAL) — and the plan (B5) only covers HALF of it (transition guard, not concurrency).
3. **The consent number is the most dangerous OUTPUT** (fronts 02·04) — binary by-heads, not share-weighted; drives the load-bearing `metThreshold` boolean and the printed legal tally.

**Re-verified against real code (the abbreviated paths in the fronts all resolve to `apps/api/src/modules/**`):**
- `projects.service.ts` (modules/projects) **`:773`** `if (input.status !== undefined) patch.status = input.status;` — confirmed any→any, no state machine. **`:767–803`** the `UPDATE … WHERE id` has **no** `updatedAt`/version predicate — confirmed silent last-write-wins.
- consent: **`:419–421`** `consentedPct = apartmentsConsented/totalApartments`; `metThreshold = consentedPct >= targetSignaturePct` — confirmed binary by-heads, **no `ownerships.share_*` anywhere in the CTE** (lines 390–406 count owners, not shares).
- `packages/shared-types/src/notification.ts` — confirmed **exactly 8 kinds** (`task_assigned`, `apartment_status_changed`, `document_uploaded`, `signature_received`, `note_added`, `share_revoked`, `mention`, `message_received`); **no `expiring`/`stalled`/`threshold_reached`.**
- `packages/db/src/helpers/signature-expiry-sweep.ts` — confirmed "**ONE SQL statement** … the bulk UPDATE … Nothing else on the rows changes" — **zero notification/email/SMS emission.**
- `apps/worker/src/main.ts` — confirmed 3 cron schedules wired (`AUDIT_RETENTION_CRON_DAILY`, `REAPER_CRON_HOURLY`, `SIGNATURE_EXPIRY_CRON_HOURLY`). **The scheduler is real.**
- `owners.controller.ts` — confirmed `@Get(':id/data-export')` + `@Post(':id/erase')` exist (GDPR DSAR/RTBF) — and have **no UI home** per front 01.
- campaign: confirmed the service DOES compute per-owner `created`/`skipped_existing`/`failed`+reason outcomes (`signatures/signature-requests.service.ts:482–534`) — so the "failed dropped" defect is a **UI presentation gap, not a backend gap** (the honesty data exists; the surface discards it).

---

## 2. CONSOLIDATED NEW-GAP REGISTER (de-duplicated, ranked, roadmap-slotted)

These are gaps **beyond** the 33 already in the v3 coverage matrix — i.e. the production/control/
engineering issues this audit surfaced that the design coverage did NOT. De-duplicated across all
four fronts (the fronts overlap heavily: status-guard appears 4×, concurrency 3×, chase-output 4×,
consent-basis 3×). Ranked by production impact at 50 customers.

| # | NEW gap (deduped) | Sev | What + where | Why it bites at scale | Roadmap home |
|---|---|---|---|---|---|
| **N1** | **`projects.update()` has NO optimistic-concurrency** (distinct from the status guard) | **CRITICAL** | `projects.service.ts:767–803` — `select before` then `UPDATE … WHERE id` with no `updatedAt`/version predicate | 2 managers (or manager+agent) edit one project → silent last-write-wins, no 409, audit `beforeState` records only what THIS tx read. Corrupts legal/business state with **zero detection**. | **EXTEND B5** (plan only does the state machine) — add an `If-Match`/`updatedAt` precondition + a calm 409. The plan ASSUMES a 409 the code does not emit. |
| **N2** | **No project-status transition guard** | **CRITICAL** | `projects.service.ts:773` any→any; `approved` reachable below threshold | A project jumps `planning→approved` at 3% signed; `approved` is the legal "you can file" state. Status becomes untrustworthy; pulse/momentum derivations corrupt. | **B5** (already named) — add `metThreshold` precondition for `approved`. *In the SAME slice as N1.* |
| **N3** | **The clock CHASES nothing** — scheduler exists, emits no nudge | **CRITICAL** (autonomy) | `signature-expiry-sweep.ts` flips status only; `notification.ts` has no `expiring`/`stalled`/`threshold_reached` kind | The doctrine "the system does the work" has **no backend**. Every reminder is a manual single-id `resend`. A 50-customer book cannot be chased by hand. | **B3 — RE-SCOPE** from "build a scheduler" (wrong) to "add 1 cron consumer + 3 notification kinds + FE deep-links." Materially smaller; de-risks the whole autonomy story. |
| **N4** | **Consent % is binary by-heads, not share-weighted** — drives the legal boolean | **CRITICAL** (legal) | `projects.service.ts:419–421`; `metThreshold` is THE UI boolean; portal diverges further (`adapters/portal.ts` = signed/links-sent → reads 100% when 10/35 signed) | A printed tally to a וועדה/lawyer can be **legally wrong** — the single most dangerous output the product emits. Two different wrong numbers (board vs portal). | **B0** (already scoped, share-weighted CTE) — but ALSO **fix the portal denominator in the same wave** (front 02 G3; roadmap currently scopes only the board). |
| **N5** | **No operator-recovery console** (the support half) | **P0** (ops) | `provider-tenant-users.controller.ts:59` read-only; unlock / MFA-reset / resend-invite / deactivate / cross-tenant person-search **absent at every layer** | First MFA-lockout ticket (weekly at 50 customers) = a developer with raw DB access. Operational AND security-blast-radius problem. | **C12b** (already named, owner-gated scope) — **promote out of "P1–P2 owner call" to a go-live blocker** for the MFA-reset + unlock subset at minimum. |
| **N6** | **15 API routes have NO UI home** — incl. GDPR DSAR/RTBF | **P0** | `owners/:id/data-export` + `owners/:id/erase` (legally mandatory, no screen); `member-overrides` PUT/DELETE; `discovery-records` CRUD; `tasks/:id/assignees` | Invisible, uncontrolled actions reachable by cookie+permission with no operator surface. The DSAR/RTBF pair is a **compliance liability** (a regulator/owner request has no UI path). | **NEW SLICE `C16` — "headless-route surfacing"**: a minimal admin surface for DSAR/RTBF + member-overrides; discovery → C10; assignees → tasks slice. |
| **N7** | **Long flows silently DROP `failed`** the backend computed | **HIGH** (honesty) | `signature-campaign-action.tsx` shows `{created, skipped}` only; service returns per-owner `failed`+reason (`:482–534`) but the toast discards it | Manager runs a 35-owner campaign (28 created · 5 skipped · **2 failed**), sees "28 sent · 5 skipped," never learns 2 owners got nothing. Doctrine's inverse ("always show a failure the backend DID detect") is violated. | **M5** (campaign confirm) — **widen scope**: surface `failed` count + a drill-down. Cheap (data already on the wire). |
| **N8** | **No campaign preview/dry-run** before fan-out | **HIGH** | `signature-campaign.controller.ts:32` — one POST fans to ALL owners, no "who gets this / who's excluded / who has no phone" preview | "You texted the wrong 40 people" is the #1 escalation generator. One click + zero foresight. | **NEW BE endpoint** `POST /projects/:id/signature-campaign/preview` (or `?dryRun=1`) — fold into **M5**. Net-new but small (reuses the existing recipient-derivation gate). |
| **N9** | **Hot aggregations uncached + share-weighted CTE is HEAVIER** | **MEDIUM-HIGH** (perf) | `orgStats` (`:537–581`) + `signatureProgress` (`:363–407`) recomputed per request; `cache_kv` wired ONLY for export rate-limit; B0 ADDS GROUP BY + share math | "stays sub-second at 50 customers" is **UNPROVEN** — no caching on the two hottest reads, no load-tested evidence, and B0 makes them heavier. | **NEW eng slice (Wave 0 tail or before B0):** cache layer on the two reads + a **seeded 50-project perf gate** that B0 must pass before merge. |
| **N10** | **No list-level triage / bulk ops / saved views / batch pulse** | **MEDIUM-HIGH** | `projects.controller.ts` = single `@Post`/`@Patch(:id)`/`@Delete(:id)`; no bulk archive/status/resend; no cross-project "expiring this week" aggregation | At 200 projects, a manager can't triage or act on 30 stalled projects at once. Calm-minimal-actions **inverts** into per-row drudgery. "Where do my 5 projects stand RIGHT NOW" = N separate aggregation calls. | **B1 pulse endpoint** (already named) covers the *aggregation*; **NEW slice `C17` — bulk-ops + saved-views** for the *action* half. Partly E2-list (front-end triage), partly net-new BE bulk verbs. |
| **N11** | **Tabu extraction is a STUB** — no real נסח parser | **HIGH** (honesty) | `extraction-provider.factory.ts:36` `return new StubExtractionProvider();` — deterministic fake | The whole human-review apparatus exists but produces fake rows in prod unless a real engine is wired. | **Decision** (already out-of-scope per roadmap `05:168`) — **make it HONEST**: ship manual entry as the labeled path, OR build the engine. Do NOT ship "extraction" over a stub. |
| **N12** | **No global validation pipe + no CI coverage guard** | **HIGH** (structural) | `main.ts`/`app.module.ts` no `APP_PIPE`; `input-validation-coverage.spec.ts` doesn't exist. 100% validated TODAY by convention | One missed DTO on the next route = trust-the-wire on a PII write path. Must land BEFORE the 4 new BE surfaces (B0/B1/B4/B5). | **S0-SEC** (already named, correctly sequenced FIRST) — no change, just enforce the ordering. |
| **N13** | **No post-signature consent-REVOCATION lifecycle** (distinct from erasure) | **P1** | Erasure (crypto-shred) exists + is strong; but "I signed, now I withdraw" has only the nuclear path; no auditable "withdrawn" state | An owner who revokes post-signature forces nothing-happens or full GDPR shred. No middle. Related to B2 `declined` but that's PRE-signature objection. | **EXTEND B2** — add a `withdrawn` lifecycle alongside `declined`, or a NEW micro-slice. Owner/legal call on whether withdrawal is in MVP scope. |
| **N14** | **Alerting fails OPEN; system-health is read-only** | **P1** | `WebhookAlertSink` → Noop if `ALERT_WEBHOOK_URL` unset; `provider-system-health` has no drain/retry/kill | If the webhook isn't provisioned, breach signals + failed-login bursts go to a Noop. Operator SEES queue depth but can't act. | **Ops checklist** (provision `ALERT_WEBHOOK_URL` + a boot assertion) + fold "job-retry/drain affordance" into **C12b**. |
| **N15** | **No feature-flags/kill-switches below org-suspend** | **P2** | Only runtime kill-switch is whole-org suspend | If campaign-send misbehaves (email-bomb / bad provider), the only instrument is suspending a whole customer. No surgical disable. | **Post-MVP** (acknowledge explicitly) — but a single env-gated `CAMPAIGN_SEND_ENABLED` platform kill is a 1-line cheap insurance worth doing now. |
| **N16** | **New-project wizard DROPS captured data on the wire** | **MEDIUM** | `projects/new/page.tsx:273` — section `unitType`/`areaSqm` collected + shown in review, then discarded (Gate-6 TODO) | User enters data that silently evaporates — erodes trust on the יזם's first deep interaction. | **C5** (wizard re-skin) — either persist (schema/Gate-6) or STOP collecting. Must close before prod. |
| **N17** | **SSE import-progress doesn't scale (30 streams/pod cap, no server-push)** | **MEDIUM** | `imports.controller.ts:291 MAX_ACTIVE_STREAMS=30`; LISTEN/NOTIFY admitted as the real fix, not built | At many concurrent imports → 503. | **C8** (import re-skin) — note as a known ceiling; LISTEN/NOTIFY is a post-MVP perf slice unless concurrent-import volume is expected at launch. |

**De-dup note:** N1+N2 are ONE slice (extend B5). N3 is one re-scoped slice (B3). N4 is one wave (B0 + portal). N5+N6(partial)+N14 cluster into the operator surface (C12b + C16). The "16 gaps" collapse to **~7 actual units of work**, of which 4 are CRITICAL and all 7 are bounded and unblocked.

---

## 3. COMPLETE API → ACTION COVERAGE STATEMENT

**Literal answer: YES, every CRUD verb the UI needs exists, and the API surface is complete,
consistent, and uniformly guarded** (Zod-validated · permission-gated · `withTenant`/`withProvider`
RLS-scoped · throttled · audited · `{data}` envelope). 44 controllers / 158 routes enumerated from
real code (front 01, re-verified). There is **no missing action** in the literal sense.

**The exceptions — every endpoint that does NOT have a clean one-click home today — are named:**

1. **15 routes have no UI screen** (front 01 "NO UI HOME"): GDPR `owners/:id/data-export` +
   `owners/:id/erase`; `member-overrides` GET/PUT/DELETE; `discovery-records` GET/POST/PATCH;
   `tasks/:id/assignees` GET/POST/DELETE; and partial-UI `members/:userId/capabilities` +
   `apply-capability-preset`. → **N6 / new slice C16.**
2. **2 roadmap-critical endpoints don't exist yet**: `GET /org/signature-pulse` (B1) and the
   holdout-name read (B4). The new home + the flagship drill-down are un-backed until built.
3. **4 long flows are multi-POST, not one click**: campaign (1 POST but no preview — N8);
   new-project build (3–5 sequential POSTs, no composite tx); import (4-POST wizard + SSE);
   tabu (3 POSTs, and the engine is a stub — N11).
4. **6 destructive/governance writes have no confirm/undo design**: `owners/erase`,
   `members DELETE`, `shares revoke`, `roles assignments`, `PUT ownerships` (full-set replace,
   no diff preview). M5 covers only campaign. → fold into the relevant Admin/Access slices.
5. **`GET /org/stats`** fate unstated (kept/retired/superseded by B1) — one-line decision in E2.1.

Everything else (~90% of routes) has a named wave home in the roadmap. **The API is not the risk.
The risk is that ~10% of live actions have no operator surface, and the 4 long flows + the chase
loop are not yet "one calm click."**

---

## 4. CONTROL-AT-SCALE ASSESSMENT (50 customers · many projects)

**This is NOT beautiful chaos. It is a strong governance/forensic CORE with a missing OPERATIONS
half.** The decisive split (front 04, confirmed):

**What gives real CONTROL today (give credit — it changes the verdict):**
- **Non-repudiation is self-verifying:** signature row + IP/UA + SHA-256 of the exact notice text
  + append-only `pii_processing_consents` (UPDATE/DELETE revoked) + dual forensic audit rows.
  "I never signed" is fully answerable.
- **The kill-switch works:** org-suspend atomically revokes both org + tenant sessions in one
  audited tx.
- **Per-recipient honesty exists in the BACKEND:** bulk/campaign reports created/skipped/failed+reason
  per owner — no silent fan-out *at the service layer*.
- **Fail-closed security:** ClamAV + magic-byte fail-closed; prod refuses to boot without a real
  scanner or PII keys.
- **The clock IS running:** idempotent, concurrency-1 cron sweeps across deploys.
- **Bad imports are controlled with discernment:** per-row structured errors, partial success,
  cancellable preview gate.
- **Signature-link leak/expiry is fully controlled:** atomic single-use, no-oracle responses,
  token never logged.

**Where it tips toward CHAOS at scale (the decisive factors):**
- **The clock destroys but never chases (N3)** — autonomy is half-wired; the manager hand-chases
  N projects × 35 owners.
- **Failures are computed but not surfaced (N7)** — "sent" silently means "2 got nothing."
- **Status is a free-for-all (N2) + edits clobber silently (N1)** — legal/business state corrupts
  with no detection; the "calm 409" the roadmap assumes does not exist for project edits.
- **No list-level triage / bulk / saved-views (N10)** — minimal-actions inverts into per-row
  drudgery; "where do my 5 projects stand" needs N separate heavy aggregations.
- **No operator-recovery half (N5)** — the first MFA lockout needs a developer with DB access.
- **The legal number can be wrong (N4)** — and it's the load-bearing output.

**Net:** at 50 customers the manager has **discernment** (forensics, audit, per-owner outcomes
exist) and **recovery for the catastrophic cases** (suspend, erase, resend) — but lacks
**proactive control** (the system won't drive work forward), **bulk control** (can't act on many
at once), **operational recovery** (can't unlock a user), and **honest surfacing** (failures hide).
That is the precise line between "control" and "chaos," and it is **closable** with the ~7 units
of work in §2.

---

## 5. THE HONEST SENIOR-ENGINEER VERDICT

**`material-control-gaps` — a genuinely strong, well-architected product that is two well-scoped
waves of CONTROL work away from being production-grade end-to-end and honestly autonomous.**

I would not let this ship to 50 paying customers as-is — not because it's badly built (it is the
opposite: the isolation, auth, idempotency, forensic, and fail-closed engineering is better than
most Series-A SaaS I've reviewed), but because the **control surface lags the data surface.** The
system *knows* more than it *shows* and *can do* less *proactively* than the doctrine promises. At
demo scale that's invisible; at 50-customer scale it manifests as: silent mis-sends, a legal number
that's wrong, status corruption with no audit of the corruption, a manager drowning in per-row
chasing, and a support queue with no operator tools.

The four CRITICAL items (N1 concurrency + N2 status guard = one slice; N3 chase-output = one
re-scoped slice; N4 share-weighted consent = one wave) are the certainty gate. They are all small,
all unblocked, and the cron/idempotency/audit infrastructure to build them already exists and is
proven. The plan already *names* most of this — its real flaw is **under-weighting concurrency**
(it builds the state machine but not the optimistic-lock), **mis-scoping B3** (it thinks it's
building a scheduler that already exists), and **deferring the operator-recovery half** that should
be a go-live blocker, not a P1-P2 owner call.

Close those, surface the failures the backend already computes (N7, nearly free), give the manager
list-level triage + bulk (N10), put a perf gate in front of the heavier consent CTE (N9), and prove
it in a real browser per role — and this is a production-grade, genuinely autonomous, genuinely
controllable system. The certainty the owner wants is **achievable and bounded**, not open-ended.
