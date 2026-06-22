# EMAPP — MASTER PLAN INDEX

> **One entry-point** for the whole EMAPP plan corpus. Consolidated 2026-06-22 by a coverage
> cross-check of all 85 processes in `docs/PROCESS-MAP.md` against every plan doc. This file does
> **not** duplicate plan content — it maps each process-domain to its source plan + status, presents
> the DOCUMENTS layer as one integrated plan, lists what is owner-gated, and **honestly enumerates the
> gaps**. Where a process has no dedicated plan, it is marked UNCOVERED and listed in §6 — not hidden.

---

## 0. North-star (single, shared)

EMAPP runs the urban-renewal signature campaign **largely by itself**; the technophobic manager keeps
the **feeling of control** by confirming with one click. The board is a **calm fleet situation-picture**
(all projects, ranked by attention), the system **proposes/drafts** the next move into one **Approval
Inbox**, and anything outbound / legal / PII-exposing / irreversible is human-confirmed. Documents are
organised as a **party binder** (the deal's cast, not the file count), shared by **inviting a party**
under preset ceilings, with PII **structurally** kept out of every share/proposal/title.
Sources: `docs/AUTONOMOUS-MASTER-PLAN.md` (north-star + voice law) · party-binder council (memory
`project_document_party_binder_redesign`, session task `wupkk1tnk`).

---

## 1. The plan corpus (source docs)

| Doc | Role in the plan |
|---|---|
| `docs/PROCESS-MAP.md` | **The completeness baseline** — all 85 processes (routes + jobs + seams + ops). |
| `docs/AUTONOMOUS-MASTER-PLAN.md` | **Autonomy engine** (7-part) + per-domain proactive reconception + Gap-closure addendum (tasks/notes/messaging/RTBF/assignments) + design-language + voice law. |
| `docs/DOCUMENT-SECURITY-AUDIT.md` | **Documents-layer security red-team** — access matrix, R2 retrieval, encryption coupling, temp-links, anti-overwrite, hardening roadmap (B1–B7, H1–H5). |
| party-binder council (memory `project_document_party_binder_redesign`; task `wupkk1tnk`) | **Documents-layer UX redesign** — ~8 party cards, party derived from doc_type, invite-a-party sharing, per-party completeness, auto-file autonomy, 6-slice build, 6 taxonomy gaps. |
| `docs/MASTER-PLAN-V13.md` (+ `V13-SPRINT-COMPLETION.md`, `V13-ACCEPTANCE-CHECKLIST.md`, `E2-SLICE-LEDGER.md`) | **The substrate already built** — DH1–4 doc taxonomy/checklist/classifier/dedup, NS1–8 server search, BM-1 leverage, external_share foundation, reskins. Most of the documents + search + sharing substrate the other plans build on. |
| `docs/FILE-RULES-CATALOG.md` | **Source-of-truth enumeration** of every file/document rule (classifier regexes, magic-byte, sensitivity-derive, dedup) — the ground truth the UX + security plans must respect. |
| Supporting: `docs/DECISIONS.html` (D.01–D.59 law) · `docs/IAM-DESIGN.md` · `docs/DESIGN-phase3-parcel-autosetup.md` · `docs/DESIGN-phase5-tabu-extraction.md` · `docs/DESIGN-project-model-and-autosetup.md` · `docs/FEATURE-owner-renter-design.md` · `docs/COUNCIL-DOCS-TENANTS-DECISION.html` | Per-feature design + the locked decisions every plan inherits. |
| Deferred-design (NOT yet a build plan): `docs/DESIGN-form-builder.md` (Epic F, awaiting sign-off) | Noted so it isn't mistaken for in-scope. |

---

## 2. Per-process coverage cross-check (all 85)

Legend: **AUT** = covered by the autonomy master plan · **UX** = documents party-binder redesign ·
**SEC** = document security audit · **V13** = built/planned in the V13 substrate · **OK** = a live
process with no *new* plan needed (steady-state; governed only by cross-cutting RLS/PII/audit) ·
**GAP** = no dedicated plan (see §6).

### Tier 1 — Org users

| # | Process | Coverage |
|---|---|---|
| 1 | Org signup / atomic bootstrap | OK (steady-state; auth stack D.21) |
| 2 | Login | OK |
| 3 | Token refresh | OK |
| 4 | Logout | OK |
| 5 | Switch org | OK |
| 6 | Forgot/reset password | OK |
| 7 | Accept team invite | AUT (G5-family invite self-chase, Phase 5) |
| 8 | Step-up re-auth (PII reveal) | SEC (B5 — gate step-up on `owners.reveal_pii`) |
| 9 | OTP request/verify primitive | OK |
| 10 | Current-user profile | OK |
| 11 | Org settings | OK |
| 12 | Team members CRUD + invite | AUT (tenant/member lifecycle ticks, Phase 5) |
| 13 | Member capabilities + presets | OK (IAM-DESIGN governs) |
| 14 | Member permission overrides | OK (IAM-DESIGN; anti-escalation built) |
| 15 | Roles management + assignment | OK (IAM-DESIGN) |
| 16 | Projects CRUD + status state-machine | AUT (→approved threshold-crossing proposal, Phase 3) |
| 17 | Project agent-assignments | AUT (G5 AssignmentRecommender — propose) |
| 18 | Buildings CRUD | AUT (auto-נסח-extraction drafts structure, Phase 4) |
| 19 | Apartments CRUD | AUT (same Phase-4 draft path) |
| 20 | Ownerships set-replace | AUT (tabu-confirm→ownerships; human-confirm FLOOR) |
| 21 | Owners CRUD | UX (owner = a binder party; PII roll-up) + AUT |
| 22 | CSV import (9-step) | AUT (Phase 4 — mapping auto-propose; import-job below) |
| 23 | Owner search (cross-project national_id) | V13 (NS2 — **held**, Gate-2 matrix decision) |
| 24 | PII reveal (step-up, audited) | SEC (B5) |
| 25 | Owner ↔ projects | OK |
| 26 | RTBF data-export + erase | AUT (G4 RetentionWatcher — propose, step-up, no auto-erase) + SEC (H5 hard-delete durability) |
| 27 | Document upload (create/content/finalize) | UX + SEC + V13 (DH1) — **integrated, see §3** |
| 28 | doc_type taxonomy + scope classification | UX (6 taxonomy gaps) + V13 (DH1) + FILE-RULES |
| 29 | Per-project required-docs checklist + % | UX (per-party completeness) + V13 (DH2, advisory) |
| 30 | Heuristic classify (suggest-only) | UX (auto-file ≥floor) + V13 (DH3) + SEC (never auto-classify sensitive) |
| 31 | Dedup probe (contentHash) | AUT (exact-hash auto-archive) + V13 (DH4) |
| 32 | Download (decrypt-stream for sensitive) | SEC (B1 — **launch blocker**, route on `sensitive`) |
| 33 | Document search / edit / archive | UX + AUT (Stale/DuplicateDocWatcher, thin-coverage note) |
| 34 | Remediation sweep (re-classify tabu) | SEC (B2 — re-encrypt-on-flip) + V13 (FL-5) |
| 35 | Create signature request (single/bulk/per-apt) | AUT (Phase 2 cadence engine) |
| 36 | Signature campaign + reminder + kill-switch | **AUT — the first exemplar** (reminder-cadence loop, Phase 2) |
| 37 | Public signing flow (`/sign/:token`) | SEC (B4 — **launch blocker**, public-sign plain-presigns sensitive) |
| 38 | Signature progress / consent | AUT (event source `threshold.crossed`, Phase 3) |
| 39 | Holdout detection (PII-gated) | AUT (leverage chase-wave, Phase 3) + V13 (BM-1, HB-3) |
| 40 | Cancel / resend / link sig request | AUT (expiry→re-issue Phase 1; cancel branch — thin-coverage note) |
| 41 | Signed-document retrieval (cert PDF) | SEC (freeze-on-sign immutability, H4) |
| 42 | Tabu extraction create + extract | AUT (auto-extraction Phase 4) + DESIGN-phase5-tabu |
| 43 | Tabu review + confirm (provenance) | AUT (human-confirm FLOOR) + DESIGN-phase5-tabu |
| 44 | Parcel auto-setup (GovMap) | AUT (Phase 4) + DESIGN-phase3-parcel — **GovMap owner-gated** |
| 45 | Discovery/renter records | OK (FEATURE-owner-renter-design) |
| 46 | Contractors CRUD | UX (unify into "מי רואה מה" roster) + SEC (H1 shared authz resolver) |
| 47 | Project shares (JSONB perms) | UX (invite-a-party) + SEC (H1) |
| 48 | External shares (presets/OTP/watermark) | UX (invite-a-party + ceilings) + SEC (B8/H1 — dead control surface) + V13 (X-S foundation) |
| 49 | Notes CRUD | AUT (G2 — system-authored activity note) |
| 50 | Tasks CRUD + assignees + overdue | AUT (G1 TaskWatcher — system-owned tasks; **biggest gap closed**) |
| 51 | Team messaging/chat | AUT (G3 — proactive daily digest) |
| 52 | Notifications (deep-links) | AUT (Approval Inbox is distinct from FYI notifications) |
| 53 | Mission-control home board | AUT (Phase 3 self-updating `fleet_attention`) + V13 (board-first home shipped) |
| 54 | Org signature-pulse + stats | AUT (Phase 3 substrate) + V13 (B1 endpoint) |
| 55 | Leverage scorer | AUT (chase-wave recommender) + V13 (BM-1 built) |
| 56 | Project export → xlsx | SEC (B6 — **launch blocker**, bulk PII export bypasses step-up) |

### Tier 2 — External

| # | Process | Coverage |
|---|---|---|
| 57 | Contractor portal (share-token read) | UX (folds into invite-a-party roster) + SEC (H1 shared resolver, expiry enforcement) |
| 58 | Tenant portal (SMS OTP) | AUT (tenant auto-onboard SMS, Phase 5) + V13 (FL-6 reskin shipped) |

### Tier 3 — Provider Admin

| # | Process | Coverage |
|---|---|---|
| 59 | Provider auth (MFA) + profile | OK |
| 60 | Tenant onboarding | OK |
| 61 | Tenant list/detail/users | OK |
| 62 | Tenant suspend/reactivate | AUT (provider freeze = human-confirm FLOOR) |
| 63 | Provider audit | AUT (audit-anomaly sweep, Phase 5) |
| 64 | System health | AUT (health self-heal, Phase 5) |

### Background / scheduled / async

| # | Process | Coverage |
|---|---|---|
| 65 | Reminder scheduling engine | **AUT — core of the autonomy engine** (Scheduler/Orchestrator) |
| 66 | Reminder delivery | AUT (OutboundGovernor + outbound_ledger, Phase 2) |
| 67 | Signature-request expiry | AUT (Phase 1 — the first safe producer) |
| 68 | Session/token reaper | OK (steady-state job) |
| 69 | Audit-log retention | AUT (G4-adjacent retention) + OK |
| 70 | Async CSV import processing | AUT (Phase 4 mapping auto-propose) |
| 71 | Async tabu PDF parsing | AUT (Phase 4 extraction-to-draft) |
| 72 | R2 storage purge / bytes lifecycle | SEC (H5 — hard-delete durability + legal_hold) |
| 73 | File scan on upload (magic-byte/AV) | SEC (B7 — scan-then-swap TOCTOU; finalize-once) |
| 74 | Email sending (IEmailProvider) | AUT (OutboundGovernor wraps it) |
| 75 | SMS sending (ISMSProvider) | AUT (OutboundGovernor wraps it) |
| 76 | Breach/bruteforce detection + alerting | AUT (Phase 5 breach-response loop) |
| 77 | Parcel/GovMap lookup | DESIGN-phase3-parcel — **owner-gated, deferred post-prod** |
| 78 | Prometheus metrics + Sentry | OK (steady-state; aggregate-only) |
| 79 | Real-time / SSE (IRealtimeProvider) | OK (live-update seam; import progress) |
| 80 | Cache (PostgresCacheProvider) | OK (read-through; fleet snapshot persisted in Phase 3) |

### Ops / infra / entry-point

| # | Process | Coverage |
|---|---|---|
| 81 | Liveness probe `/health` | OK |
| 82 | Readiness probe `/ready` | OK |
| 83 | BFF reverse proxy `/api/[...path]` | OK |
| 84 | Contractor share-token → cookie exchange | SEC (FL-1/FL-2 token-secret split + audience; H1 resolver) |
| 85 | Dev-only nav login `/dev-login` | OK (QA tooling; double-gated) |

**Coverage tally: 85/85 processes accounted-for.** Every process maps to either a dedicated plan
(AUT/UX/SEC/V13/DESIGN-*) or is an explicitly-justified **OK steady-state** process governed only by the
cross-cutting RLS/PII/audit law. **Zero processes are UNCOVERED in the "no idea what happens to it" sense.**
The honest caveats are in §6 — they are *aspect* gaps and *decision* gaps, not missing processes.

---

## 2.5 Cross-cutting acceptance gates (EVERY slice — not just feature coverage)

The §2 table maps WHAT each process gets built. These gates are the BAR every slice
must clear to merge, regardless of which plan it belongs to. They are enforced by the
green-gate (ENGINEERING-CHARTER §Process) + the `code-reviewer`/`security-reviewer`
agents + CI + the CLAUDE.md DoD — this section PINS them to the plan so "the feature
works" is never mistaken for "the slice is done." A slice that skips one is not merged.

This section was added 2026-06-22 after a cross-cutting audit found the plan corpus was a
coverage/coherence map that silently ASSUMED the standing charter/DoD would carry the
engineering bars. That holds for Q2/Q3/Q5/Q7/Q8/Q9/Q10 (genuinely enforced per-PR). It did
NOT for **Q1 (sub-second latency)** and the **autonomy-observability half of Q6** — no
per-slice gate touched them, and the autonomy engine (schedulers, event bus, fleet-snapshot
recompute, ranked Approval Inbox) is exactly latency-and-tracing-sensitive new surface. This
section closes those, and flags the broken **D.51** citation (Q4).

| # | Gate | Bar | Enforced by | Status |
|---|---|---|---|---|
| Q1 | **Sub-second latency** | every new click/nav warm-loads < 1s; new scheduler ticks / event-bus hops / fleet-snapshot recompute / Approval-Inbox rank carry a **measured warm number on a prod-local build** (not `next dev`) in the PR. | role-coverage e2e warm-nav capture + manual real-Chrome walk (memory `feedback_sub_second_interaction_budget`) | **per-slice — was unpinned; now a gate** |
| Q2 | **SOLID / clean seams** | surgical change, DI seam, no god-service; engine work = a new recommender/producer reusing a gated method verbatim, never a new engine part. | `code-reviewer` (Charter §quality-bar 1–2) | enforced |
| Q3 | **Generic, not special-cased** | shared resolver / single chokepoint over per-endpoint copies (docs H1 one-resolver; `AutonomyPolicy` the single boundary). | `code-reviewer` | enforced |
| Q4 | **Root-cause, not plaster** | fix the cause, not the symptom; no weakening a test to go green. | `code-reviewer` + the recurring DECISIONS "no plaster" principle (D.22/D.24/D.26). **NOTE: the "D.51/D.54/D.59" citations used in CLAUDE.md + agents are NOT present in DECISIONS.html (it ends at D.44) — reconcile the citation or commit the missing entries.** | enforced; **citation broken** |
| Q5 | **Error handling + {data}/error-code envelope, fail-closed** | D.16 envelope; security paths fail-closed (e.g. `sensitive && !encrypted` ⇒ hard 503, no `undefined=pass`). | typecheck + `code-reviewer` + `security-reviewer` | enforced |
| Q6 | **Observability / failure-chain** | structured log + correlation/request ID + Sentry + audit_log compose into a traceable story; **every autonomous tick/proposal/execute emits a correlatable log + metric** so a missed tick or mis-applied proposal is diagnosable — not only audited. | `code-reviewer` (Charter §quality-bar 3) | **autonomy-observability was unpinned; now a gate** |
| Q7 | **Test authenticity** | independent RED-author; no author-graded pass-by-construction; a flake is a defect to root-cause. | green-gate process | enforced |
| Q8 | **Security / PII fail-closed** | RLS on every read, PII encrypted + never logged/in-title, human-confirm FLOORS, step-up gated on `owners.reveal_pii`. | `security-reviewer` (mandatory on auth/PII/RLS/export slices) + independent red-team re-verify | enforced |
| Q9 | **Typing — no `any`** | no `any`; no `unknown` without `z.parse()`. | typecheck + CI | enforced |
| Q10 | **A11y / contrast** | no invisible text (bare `text-muted` ban), view-source check, palette ratchet green. | CI palette test + FE DoD | enforced (FE) |
| Q11 | **Manual real-browser QA (G-QA)** | every browser-observable change is WALKED in the owner's REAL Chrome (Claude-in-Chrome) as the role before done/merge — headless/Playwright/MSW/unit-green is "code green" only, NOT acceptance. 4-axis + interaction + console-clean. | the owner's real-Chrome walk before merge (CLAUDE.md §STANDING DELIVERY GATES G-QA) | **per-slice gate — now anchored** |
| Q12 | **Red-team throughout + loop-until-closed (G-RT)** | every security-sensitive (and non-trivial) change gets an INDEPENDENT red-team that re-runs after EVERY fix, UNBOUNDED, until it can no longer break it; builder's own @security PASS is necessary-not-sufficient; verify red-team claims vs real code. | independent red-team agent, looped (CLAUDE.md §STANDING DELIVERY GATES G-RT) | **per-change gate — now anchored** |

For Q1/Q6 to be truly enforced (not just documented), the per-slice green-gate brief must
DEMAND the number / the trace in the PR description — the same way the browser-smoke DoD
demands 4-axis evidence. This section makes them gates; the green-gate brief produces the evidence.

---

## 3. DOCUMENTS layer — one integrated plan (UX + Security + Autonomy)

The documents layer has **three plans that are COHERENT and non-contradictory.** They attack three
different axes of the same flow and reinforce each other:

- **UX (party-binder)** = how the human *sees and shares* documents (party cards, invite-a-party).
- **SECURITY** = how bytes are *stored, retrieved, and bounded* (encryption coupling, R2, anti-overwrite).
- **AUTONOMY (Phase 4)** = how the *system files and tracks* documents on its own (auto-file, dedup, checklist).

### Coherence verdict — COHERENT (3 alignments confirmed, 0 contradictions)

1. **Sharing model aligns exactly.** UX "invite a party → party_type selects PARTY_PRESET_CEILINGS
   (fail-closed, narrows-only)" IS the security audit's "ONE shared external-party authz resolver
   (scope + expiry + OTP + watermark)" (SEC H1). Same `external_share` table, same preset ceilings,
   same fail-closed/narrows-only rule. The UX layer is the FE face of the security layer's resolver.
2. **Auto-file respects the sensitivity boundary.** UX auto-files **NON-sensitive** docs on upload
   (classifier ≥ floor) and **PROPOSES** sensitive classification/share. This is identical to the
   autonomy charter's THE ONE BOUNDARY (auto only when internal + reversible + **non-PII** + non-outbound)
   AND to the security audit's "never auto-classify/auto-share sensitive; sensitive-flip must
   re-encrypt." No plan auto-shares or auto-flips a national_id-dense doc.
3. **PII never in the share path.** UX "national_id structurally never in the share path" = security
   audit's contractor-structurally-excludes-sensitive + sensitive-needs-OTP + the autonomy plan's
   PII-free-title contract. All three enforce the same structural exclusion at different layers.

### The one real SEAM to watch (not a contradiction — a build-order dependency)

The UX redesign's **slice 4 ("invite a party" share FE)** renders the `external_share` controls
(expiry / OTP / watermark / allow_sensitive). The security audit flags that **these controls are a DEAD
surface today** (`external_shares.expires_at/otp_required/allow_sensitive/watermark` are persisted +
ceiling-validated but have **NO read-consumer** — SEC blocker #8). **Therefore UX slice 4 MUST NOT ship
before SEC H1** (the shared authz resolver that actually *enforces* those fields on every request) — else
the FE would present enforced-looking controls that do nothing. This is captured in §4 build order.

Similarly, the autonomy Phase-4 **auto-file** and the UX **per-party completeness** both build on the V13
**DH1 doc_type/scope taxonomy** + the **6 taxonomy gaps** (survey/survey_map/guarantee/municipal_approval/
schedule/legal_opinion + a provider/source PARTY axis). Those taxonomy adds must land before per-party
completeness can stop lying. No contradiction — a shared prerequisite.

### Documents integrated build order

1. **DH1–DH4 taxonomy/checklist/classifier/dedup** — *built* (V13, migrations 0077–0079). Foundation.
2. **SEC launch-blockers B1–B4** (download routes on `sensitive`; public-sign sensitivity branch;
   re-encrypt-on-flip; backfill ~750 docs + DB CHECK) — **Gate-6 #486, owner-coordinated** (the
   fail-closed-vs-503 timing call). *Must precede any wider document exposure.*
3. **SEC B5–B7** (step-up→reveal_pii gate; export step-up; presigned-PUT anti-overwrite) — buildable now,
   no migration, security-reviewed.
4. **6 taxonomy adds** (UX slice 3) — tolerant-string-on-read, no migration, ripples to classifier + api-docs + seeders.
5. **UX slices 1–2** (FE party board + per-party completeness) — FE-only, killable, no migration. *Slice 1 building now.*
6. **SEC H1** (ONE shared external-party authz resolver: scope + expiry + OTP + watermark + decrypt-stream).
7. **UX slice 4** ("invite a party" share FE + "מי רואה מה" roster) — **depends on SEC H1** (the seam above).
8. **UX slices 5–6** (auto-file non-sensitive + system-owned missing-doc tasks → Approval-Inbox proposals) —
   = autonomy **Phase 4**; must respect THE ONE BOUNDARY (propose sensitive, auto non-sensitive).
9. **SEC H2–H5** (per-org DEK/KEK KMS · tighter step-up TTL · R2 Object-Lock/WORM + freeze-on-sign ·
   retention hard-delete + legal_hold) — deeper hardening, owner-gated where noted.

---

## 4. Cross-plan build sequence (autonomy + documents + security)

**No ordering contradictions found.** The three plans share one safety-first rule: *the security floor
comes before any wider exposure, and any autonomous/UX surface reuses an existing gated path verbatim.*

1. **Security floor FIRST** — SEC B1–B4 (Gate-6 #486) close the cleartext-PII launch blockers before
   documents are exposed more widely (party board, shares). SEC B5–B7 (buildable now) close the
   step-up/export/overwrite gaps.
2. **Autonomy Phase 0–1** — the guardrail charter (`AutonomyPolicy`) + audit spine + the proposal queue +
   Approval Inbox, seeded with the safest producer (expiry→re-issue). No behavior change until the law + ledger exist.
3. **Autonomy Phase 2** — the reminder-cadence loop (the first exemplar, process 36) + OutboundGovernor.
   This is the spine every later loop reuses.
4. **Autonomy Phase 3** — self-updating fleet board + event bus + →approved proposal + leverage chase-wave
   (V13 already shipped the board-first home + BM-1 leverage as the FE substrate).
5. **Documents** — the §3 order (taxonomy → UX party board → SEC H1 resolver → invite-a-party → auto-file)
   slots in as **autonomy Phase 4** for the auto-file/dedup/checklist producers.
6. **Autonomy Phase 5–6** — people/access lifecycle (shares/invite/tenant) + breach response + audit-anomaly
   + governance; then tuning to "perfect."

**One hard sequencing constraint to honor:** UX-slice-4 (share FE) **after** SEC-H1 (resolver). Flagged in
§3. Everything else is additive and independently shippable behind propose-not-execute.

---

## 5. Owner-gated items (nothing here ships without an explicit owner decision)

| Item | Plan | Why owner-gated |
|---|---|---|
| **Gate-6 #486 — sensitive doc re-encrypt + backfill** (B1–B4) | SEC | ~750 plaintext docs / 170 orgs; the fail-closed-vs-503 **timing** call (fail-closed before backfill 503s real downloads). |
| **DB CHECK coupling `sensitive ⇒ bytes_encrypted`** | SEC B3 | migration on live `documents`. |
| **NS3 saved_view + X-S4 external_share_otp/session tables** | V13 | Gate-6 migrations, parked for approval. |
| **NS2 cross-project national_id lookup** | V13 | **Gate-2 capability-matrix change** (gating *all* national_id search removes agents' in-scope search). |
| **Per-org DEK/KEK (KMS)** (H2) | SEC | infra + key-management decision; single global key is fleet-wide blast radius today. |
| **R2 Object-Lock/WORM + versioning + freeze-on-sign** (H4) | SEC | bucket reconfiguration + legal-evidence policy. |
| **RTBF hard-delete + legal_hold** (H5 / FL-4 / AUT G4) | SEC + AUT | irreversible erasure + DPO (owner) sign-off; erase stays human-only with step-up. |
| **Entitlement / share-tier unification** (contractor → external_share) | UX + SEC + V13 (X-S8) | highest-regression migration; contractor stays on its merged path until a parity-proven walk. |
| **GovMap / parcel lookup** | DESIGN-phase3 | owner deferred to post-prod ("I'll touch it after production"). |
| **prod `DOC_ENCRYPTION_KEY` + `SHARE_TOKEN_SECRET` values** | V13 FL-1/FL-3 | deploy-coordination (code ships with dev fallbacks). |
| **Per-org "auto-send within caps" opt-in** | AUT Phase 6 | crosses from propose to auto-outbound — owner opt-in only. |
| **Form-builder (Epic F)** | DESIGN-form-builder | design awaiting owner sign-off; nothing built. |

---

## 6. GAPS — honest list (under-claimed, not hidden)

These are the real holes. None is a "process with no idea what happens to it" — they are **aspect gaps,
decision gaps, and not-yet-built work** within otherwise-covered processes.

### 6a. Security holes that are PLANNED but NOT YET CLOSED (live risk today)
- **G-SEC-1 — cleartext sensitive PII served** (SEC blockers #1, #2, #3): download + public-sign route on
  `bytes_encrypted`, not `sensitive`; ~750 docs served plaintext. **Plan exists (B1–B4), held as Gate-6
  #486. Not closed.** This is the single most important open item.
- **G-SEC-2 — bulk PII export bypasses step-up** (SEC #4): export.controller emits cleartext national_id
  for every owner with no `assertPiiUnlocked`. Plan B6 buildable now; **not merged.**
- **G-SEC-3 — Viewer can self-OTP to PII** (SEC #5): step-up decoupled from `owners.reveal_pii`. Plan B5; **not merged.**
- **G-SEC-4 — presigned-PUT scan-then-swap TOCTOU + no overwrite guard** (SEC #6). Plan B7; **not merged.**
- **G-SEC-5 — external_share controls are a DEAD surface** (SEC #8): expiry/OTP/watermark persisted but no
  read-consumer. Plan H1. **This is the blocker on UX-slice-4 (§3 seam).**

### 6b. Plan-vs-plan SEAM (build-order dependency, must be honored)
- **G-SEAM-1 — UX share FE (slice 4) depends on SEC H1.** Shipping the "invite a party" sheet before the
  authz resolver enforces the fields would present fake-enforced controls. Documented in §3/§4; **not a
  contradiction, but a real ordering constraint that a naive build could violate.**

### 6c. DECISION gaps (blocked on owner, not on a plan)
- **G-DEC-1 — NS2 national_id matrix** (Gate-2): the capability-matrix change is undecided; PR held.
- **G-DEC-2 — Gate-6 #486 timing** (fail-closed vs 503 vs backfill ordering): owner timing call.
- **G-DEC-3 — entitlement unification** (contractor ↔ external_share tier): unification decision deferred (X-S8).
- **G-DEC-4 — DH2 `→approved` hard-gate wiring**: ships ADVISORY; the hard gate is a one-flag flip after
  counsel signs the doc-checklist templates (Open #2).

### 6d. Process-aspect thin spots (acknowledged inside AUTONOMOUS-MASTER-PLAN, kept tight)
- **G-THIN-1 — signature CANCEL vs resend** (process 40): expiry→re-issue + cadence are planned; *cancelling*
  a superseded request is only a "thin-coverage note" (one extra recommender branch), not a full slice.
- **G-THIN-2 — proactive document search / supersede-detection** (process 33): Stale/DuplicateDocWatcher is a
  noted folder under Phase-4 producers, not separately specced.

### 6e. Genuinely UN-planned (no dedicated plan beyond "steady-state OK")
- **G-UNPLAN-1 — `provider/backups`**: PROCESS-MAP notes this is a **FE route with NO backend** — deferred/dead,
  **not a live process and not planned**. Honestly: no backup/restore plan exists for provider data beyond
  what the DB host (Neon) provides. Flagged for owner if provider-tenant backup/restore is a requirement.
- **G-UNPLAN-2 — steady-state ops processes (68, 78–83)**: reaper, metrics, probes, BFF proxy have **no
  evolution plan** — they are correct as-is and marked OK. This is *intentional* non-coverage, listed here so
  the claim "85/85" isn't read as "85 get new work."
- **G-UNPLAN-3 — `decrypt-stream buffers full plaintext in heap`** (SEC "things owner missed"): a DoS/
  availability angle noted in the audit but **bounded only in H5's tail**, not separately scheduled.

---

## 7. Verdict (the honest bottom line)

- **Coverage: 85/85 processes accounted-for** — each maps to a dedicated plan (autonomy / documents-UX /
  security / V13-substrate / per-feature design) or to an explicitly-justified steady-state **OK**. **No
  process is silently uncovered.** What remains are the §6 gaps: **5 planned-but-unclosed security holes**
  (G-SEC-1..5, the most material being the cleartext-PII Gate-6 #486), **1 build-order seam** (UX-slice-4 →
  SEC-H1), **4 owner-decision gaps**, **2 thin spots**, and **3 genuinely-unplanned items** (provider backup/
  restore being the only one an owner might consider a true requirement gap).
- **Documents-layer coherence: COHERENT, 0 contradictions.** UX invite-a-party ≡ SEC shared-resolver +
  preset-ceilings; UX auto-file respects SEC never-auto-sensitive ≡ autonomy THE ONE BOUNDARY; PII
  structurally excluded in all three. The single seam (UX share FE must follow SEC H1) is an ordering
  dependency, captured in §3/§4 — not a contradiction.
- **Build sequence: coherent, security-floor-first**, no ordering conflicts beyond the one honored
  UX-slice-4 → SEC-H1 dependency.

> This index points to source docs; it does not restate them. Update it when a plan doc changes a domain's
> status or when a §6 gap is closed.
