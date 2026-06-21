# 01 — Domain / Job-to-be-Done Completeness Audit (the "how do I KNOW nothing's missing" answer)

> **Front:** Real-world urban-renewal signature-collection job-to-be-done completeness.
> **The owner's certainty question this answers:** every prior audit was *CODE*-coverage —
> "is every route mapped to a screen?" (v4 = AMBER-green: 158 routes, 15 headless). That audit
> can be 100% green while the **product still cannot finish the job**, because the job has steps
> the code never modelled. This is the missing audit type: **REAL-WORLD-JOB coverage** — does the
> system cover the full end-to-end job of a יזם collecting owner signatures for a תמ"א 38 /
> פינוי-בינוי project, for **ALL** stakeholders, including legal/regulatory needs and competitive
> feature-parity — surfacing what SHOULD exist but DOESN'T.
> **Method:** walked the real job END-TO-END and mapped each step to a system capability, grounding
> every "COVERED" claim in real code (`file:line`) or a planned slice in `00-FINAL-BUILD-PLAN.md`.
> Skeptical by construction: a capability is COVERED only if the code or a planned slice actually
> does the real-world job, not merely names it. Verified against `packages/db/src/schema/**` +
> `apps/api/src/modules/**` on 2026-06-18.
> **Author:** Domain-completeness seat, 2026-06-18. Feeds the v7 synthesis (`00`).

---

## VERDICT (one line)

**The system is a genuinely complete and well-built `signature-collection ENGINE`, but it is NOT
yet the complete `urban-renewal-project JOB`.** The signature core — collect, chase (post-B3),
threshold, committee print-of-record — is COVERED or planned-with-a-home. The should-exist gaps
cluster in **five job-areas a real יזם cannot finish the job without, but which the product today
treats as out-of-scope or models only as inert stubs**:

1. **The document layer is the connective tissue of the entire job, and it does not exist as such.**
   Today documents are a flat, org-internal upload/download list (`documents` table with `projectId`
   + `apartmentId` links, `artifacts.ts:23-81`), and external sharing is *contractor-only,
   project-level, all-or-nothing, no time-limit, no watermark* (`shares` + `_share-permissions.ts`).
   The real job is a **per-entity, two-sided document FLOW** (every party PROVIDES some docs and is
   OWED others; the MISSING state drives the chase). This is the owner's own ask and the
   highest-leverage gap — and ~60% **puzzle** (it generalizes the proven `shares` JSONB +
   contractor-portal + documents spine). Detailed in the sibling docs `02-document-management.md` /
   `03-external-sharing.md`.
2. **The legal consent number is computed WRONG for the statutory test** — binary by-heads, not
   share-weighted, with no per-building basis (`projects.service.ts:419-421`). The exact fractions
   are *stored* (`ownerships.share_numerator/denominator`, sum-trigger-guaranteed) but never read by
   the progress math. The build plan homes this as **B0** (⭐CRITICAL, D.1 locked share-weighted).
3. **Deal-terms / consideration / estate-POA / renter reality is stubbed, not modelled.** The תמורה
   lives as flat project columns (`projects.developerName/existingUnits/plannedUnits/relocationType`,
   `projects.ts:54-68`) with no per-owner deal terms; estates (עיזבון), powers-of-attorney
   (ייפוי כוח), companies, and minors have no first-class representation; the renter was *demoted to
   a discovery source* (`discovery_records`, `projects.ts:344`) but is never tracked as a party owed
   relocation.
4. **The legal-record completeness beyond the consent tally is missing** — no objection/withdrawal
   register, no retention schedule, no signed-package manifest (the artifact the וועדה/lawyer actually
   receives). The committee print-of-record is planned (**C1**, a go-live blocker) but unbuilt.
5. **The post-`approved` lifecycle falls off a cliff** — no relocation tracking, no second 100%
   signing round, no permit/הליך clock, no cancellation-reason. Likely out of MVP, but it means the
   product stops at "threshold met," not at "deal done."

Of these, **#1 (the document FLOW) is the most puzzle-not-new and the owner's stated priority**; **#2
(B0) is the single most dangerous defect already homed**; **#3–#5 are honest net-new scope decisions**
that should be made explicitly, not by omission.

---

## A. HOW THIS AUDIT IS DIFFERENT (and why it's the certainty answer)

A code-coverage audit asks *"is every route mapped to a screen?"* and can be green while the product
cannot do the job — because the job has steps the **code never modelled**, so there is no route to
map. This audit inverts the lens: it starts from the **real-world job-to-be-done** of a יזם and his
ecosystem, walks every step, and asks *"does a real capability complete this step?"* A gap here is
not a missing screen for an existing endpoint — it is a **missing part of the job**.

Three lenses, applied at every step:
- **Stakeholder completeness** — for EVERY party (יזם, the 3 org roles, owner, renter, שמאי/appraiser,
  אדריכל/architect, עו"ד/lawyer, bank, contractor, וועדה/committee), is their need served — and
  critically, is the **document exchange** (what they PROVIDE and what they are OWED) modelled?
- **Legal / regulatory completeness** — majority rules (the statutory %), non-repudiation, the
  Israeli Privacy Protection Law (notice + DSAR/erasure), retention, the committee record.
- **Competitive parity** — the patterns the incumbents (DocuSign/PandaDoc recipient pipeline; a
  lawyer's structured deal folder; the spreadsheet+WhatsApp status quo) already solved.

---

## B. THE JOURNEY × CAPABILITY MATRIX

Legend: **✅ COVERED** (real code does the job — cited) · **🟡 PARTIAL** (primitive exists but the job
isn't finished, or it's a stub) · **❌ GAP** (the job step has no capability) · **📋 PLANNED** (homed in
`00-FINAL-BUILD-PLAN.md` but unbuilt). The **DOC EXCHANGE** column makes the document-flow model
explicit at each step: who PROVIDES → who RECEIVES.

### Phase 0 — `planning`: the יזם's first day → finding the building & owners

| Job step | Status | Grounding (code / slice) | DOC EXCHANGE (provides → receives) |
|---|---|---|---|
| Identify a parcel (גוש/חלקה) | ✅ | `projects.block/parcel/subparcel` (`projects.ts:71-74`); `parcel_setups` + `parcel_lookup` (`artifacts.ts:478-549`, P3a/P3b) | — |
| Pull the נסח טאבו (land-registry extract) | 🟡 | Manual upload + auto-parse: `tabu_extractions` envelope → `tabu_extraction_rows` (`artifacts.ts:375-449`); auto-lookup (GovMap) **owner-deferred** (BACKLOG E5) | טאבו office → יזם (the FIRST inbound doc; today: just a `documents` row, no "expected" slot) |
| Materialize building/apartment skeleton | ✅ | `parcel_setups` confirm → buildings+apartments atomically (`artifacts.ts:451-517`); `building_sections` for sectioned bldgs (`projects.ts:178`) | — |
| Reconcile registry vs reality (deceased / sold / estate / company owner) | 🟡 | `owner SHELL` (nullable `name_encrypted`/`national_id`, `projects.ts:223-237`) + `discovery_records` (`not_visited\|no_answer\|spoke_to_occupant\|owner_identified\|refused`, `projects.ts:344`). **No estate/POA/company entity type.** | probate / POA → יזם (**❌ no expected-doc slot per owner**) |
| Define the תמורה / offer | 🟡 | Flat project columns: `developerName`, `existingUnits/plannedUnits/extraAreaSqm`, `relocationType (none\|rent_comp\|alt_housing)` (`projects.ts:54-68`). **No per-owner deal terms.** | — |
| Set the consent target | ✅ | `targetSignaturePct` (defaults 66 per type), `signatureMilestones` (`projects.ts:45-49`) | — |
| Find / contact the owners | 🟡 | `owners` (encrypted PII, HMAC lookup) + `discovery_records`; CSV import (`imports/`). **No contact log / next-step.** | — |

### Phase 1 — `gathering_signatures`: the daily grind (the heart of the product)

| Job step | Status | Grounding | DOC EXCHANGE |
|---|---|---|---|
| Per-apartment status pipeline | ✅ | `apartment_status` enum `pending\|contacted\|meeting\|signed\|refused\|unreachable` (`_enums.ts:26`); `statusChangedAt`/`lastContactAt` (`projects.ts:140-141`) | — |
| Distinguish **Viewed-but-not-Signed** (the killer chase signal) | ❌ | `signature_requests.status` is `pending\|signed\|cancelled\|expired` (`artifacts.ts:148-150`) — **no `viewed` state**. Competitive parity gap (DocuSign/PandaDoc §06). | — |
| Send the consent doc (campaign / bulk / per-owner) | ✅ | `signature-campaign.controller.ts` (fan-out to all active owners); `signature-requests.service.ts` (per-owner/bulk); single-use JWT `jti`, 7-day TTL (`artifacts.ts:133-181`) | יזם → owner (the agreement to sign — the canonical OWED-inbound doc; today a `documents` row + `signature_request`, not a per-owner "expected" checklist) |
| Deliver the link (email/SMS/WhatsApp) | ✅ | `signature-link-delivery.ts`; tenant auth = SMS OTP (D.20) | — |
| Resident signs (SVG, provenance captured) | ✅ | `/sign/[token]` → atomic single-use UPDATE; `signatures` (encrypted SVG blob, `signerIp`/`signerUserAgent`/`authMethod`, `artifacts.ts:86-114`); `pii_processing_consents` records notice-ack (`artifacts.ts:206-236`) | owner → יזם (the signed consent — the canonical PROVIDED-outbound doc) |
| **Chase** the holdouts (reminder cadence, expiry-before-it-lapses) | 🟡📋 | `resend()` re-mints jti (the chase primitive) exists; but the expiry sweep emits **ZERO** notifications today (`signature-expiry-sweep.ts`). Homed as **B3** (1 cron consumer + 3 kinds `expiring`/`stalled`/`threshold_reached`) + **M2** (one-tap remind). | — |
| Capture the **"why"** — objection reason / holdout type | ❌📋 | No objection-reason, holdout-type, or contact-log column anywhere. Only the status enum + free-text `notes`. Homed as **B2** (objection register) — **FORBIDDEN to surface counts until then**. | — |
| Surface the holdout's NAME ("מי תקוע → אורי דירה 7") | 🟡📋 | Gated PII read homed as **B4** (`/holdouts`, `view_owner_pii`, audited); until then apartment-grained only. | — |
| Per-owner co-signature handling (an apartment has N owners) | ✅ | `ownerships` (N owners per apartment, exact fractions, sum-trigger=1, `projects.ts:278-331`); each owner gets own `signature_request` | — |

### Phase 2 — crossing the legal threshold

| Job step | Status | Grounding | DOC EXCHANGE |
|---|---|---|---|
| Count consent **for the statutory legal test** | 🟡📋 | **WRONG TODAY:** binary by-heads — `apartments_consented/totalApartments`, `metThreshold = consentedPct >= targetSignaturePct` (`projects.service.ts:398-421`). The exact `share_numerator/denominator` (migration 0065, sum=1) is **never read**. Homed as **B0** ⭐CRITICAL (D.1 locked share-weighted + per-building `GROUP BY`). | — |
| Per-building / per-complex test (פינוי-בינוי) | ❌📋 | No per-building consent rollup today; **B0** adds `byBuilding[]`. | — |
| Partial-share credit rule (a co-owner signs but not all) | ❌📋 | Decision OD-3 inside **B0** ([LEGAL — owner/lawyer confirm]). | — |
| Non-repudiation / signature certificate | ✅ | `signatures` captures IP/UA/auth-method/timestamp; `pii_processing_consents` pins `noticeHash` (self-verifying); signed-document PDF renderer (`pdf-signed-document.renderer.ts`) | — |

### Phase 3 — assembling & FILING the package at the וועדה / lawyer

| Job step | Status | Grounding | DOC EXCHANGE |
|---|---|---|---|
| Assemble the signed-consent **package** (manifest of who signed what) | ❌ | No package/manifest entity. The signatures exist as rows; there is no "the bundle I hand to the lawyer" artifact. | יזם → עו"ד / וועדה (**❌ no package model, no two-sided slot**) |
| Committee **print-of-record** (basis-labeled tally) | 📋 | **C1** (go-live blocker): print stylesheet vs server-rendered audited PDF, MUST carry the basis label. The product's raison d'être; **unbuilt**. | system → וועדה (the consent record) |
| Send the bureaucracy "in one click" to externals (שמאי/אדריכל/עו"ד/bank) | ❌ | **No external party other than contractor exists.** `shares` links a `contractor` to a `project`, all-or-nothing, no time-limit, no watermark (`collaboration.ts:54-88`; `_share-permissions.ts`). The owner's explicit ask; detailed in `03-external-sharing.md`. | יזם → external party (provide the package) **AND** external → יזם (receive the שומה / plans / opinion) — **the two-sided FLOW is entirely absent** |
| Receive the שומה (appraisal) / plans / legal opinion back | ❌ | No inbound-document expectation/tracking for any external party. A `documents` row can be uploaded but nothing knows it was *owed*. | שמאי→יזם, אדריכל→יזם, עו"ד→יזם, bank→יזם (**❌ no "expected/received/missing" per party**) |

### Phase 4 — `approved` → `in_construction` → `completed` (post-approval)

| Job step | Status | Grounding | DOC EXCHANGE |
|---|---|---|---|
| Permit / היתר / הליך clock starts | ❌ | No permit-clock model. `approved` is a terminal-ish status label. | וועדה → יזם (the היתר) — **❌ untracked** |
| Second 100%-signing round (binding agreements post-approval) | ❌ | The signature engine could be reused, but there is no concept of a *second round* / different doc-set per phase. | יזם ↔ owner (binding contracts) — **❌** |
| Per-owner relocation tracking (פינוי: temp-housing, rent-comp payments, hand-back) | ❌ | `relocationType` is a single project-level enum (`projects.ts:64`); **no per-owner relocation record**. | landlord/יזם → renter (alt-housing docs) — **❌** |
| Cancellation reason (the deal dies) | ❌ | `cancelled` status with no reason field — BI loss for a multi-project יזם. | — |

### Cross-cutting — legal / regulatory & ops

| Job step | Status | Grounding | Notes |
|---|---|---|---|
| Tenant isolation (RLS FORCE, 4-layer) | ✅ | `withTenant`/`withProvider`/`withBootstrap`; FORCE RLS on every customer table | The substrate is genuinely production-grade. |
| PII encryption at rest (pgcrypto) + envelope-encrypted sensitive docs | ✅ | owners.*_encrypted; `documents.bytes_encrypted` AES-256-GCM (`artifacts.ts:64-69`); ClamAV scan-gate (`scan_status`, fail-closed, `artifacts.ts:48-56`) | Strong. The DMS must **preserve** this end-to-end through external sharing. |
| Privacy notice / lawful-basis acknowledgment | ✅ | `pii_processing_consents` (immutable, self-verifying, `artifacts.ts:184-236`) | — |
| DSAR / Right-to-be-forgotten (erasure) | ✅ | `owners.erasedAt` crypto-shred + `erasure_log` (`artifacts.ts:307-348`); `data-subject.service.ts` | DSAR **export** (the "give me my data" half) is less visible than the erase half — verify (G14). |
| Audit trail (forensic, append-only) | ✅ | `audit_log` (`artifacts.ts:272-305`), self-verifying spine | — |
| **Retention schedule** (auto-archive/dispose by legal class) | ❌ | Audit-retention sweep exists for `audit_log` only; **no document/owner retention policy** by legal class. | A real compliance gap once the DMS holds legal docs. |
| Operator recovery console | 📋 | **N5/C12b** — homed as a go-live blocker. | — |

---

## C. THE GAP LIST — ranked by production-essentialness

> Ranking question: *can a real יזם finish the job without this, for a real deal that reaches the
> וועדה?* P0 = the job cannot legally/practically complete or emits a dangerous output. P1 = the job
> completes but the product is materially weaker than the spreadsheet+WhatsApp+lawyer's-folder status
> quo it must replace. P2 = quality/scope decision. **Puzzle** = extends a proven mechanism; **New** =
> genuine net-new scope.

### P0 — the job cannot complete, or the product emits a dangerous output

| # | Gap | Essentialness | Puzzle vs New | Home |
|---|---|---|---|---|
| **G1** | **Share-weighted consent + per-building basis.** The legal boolean `metThreshold` rides on a binary by-heads count; the portal denominator reads 100% at 10/35 signed. A printed/displayed legal claim with the wrong denominator is the single most dangerous output the product can emit. | **P0** — the statutory number must be correct. | **Puzzle** — fractions already stored + sum-guaranteed; re-author one CTE. | **B0** ⭐ (planned, gated on PERF/N9). |
| **G2** | **Committee print-of-record** (basis-labeled consent tally). The product's *raison d'être* is the artifact the יזם hands the וועדה/lawyer. Unbuilt. A printed % with no denominator is a fabrication. | **P0** — go-live blocker. | **New** (small; precedent = signed-document PDF). | **C1** 🔒owner (planned). |
| **G3** | **The signed-consent PACKAGE / manifest.** "What exactly did I file?" There is no bundle entity tying signatures + docs + the basis tally into one immutable, exportable, hand-off-able record. | **P0** — the filing step has no artifact. | **New** (a manifest over existing rows). | Not homed — **net-new**. |
| **G4** | **Two-sided document FLOW for external parties** (שמאי/אדריכל/עו"ד/bank/וועדה): provide-AND-receive, per-party scoped permissions, time-limited, watermarked, envelope-encryption preserved. The owner's explicit ask; the connective tissue of the whole job. Today: contractor-only, flat, all-or-nothing. | **P0** for the *job* (the filing/coordination phase is otherwise off-product). | **~60% Puzzle** — generalizes `shares` JSONB + contractor-portal + documents. | Detailed in `02`/`03`; not yet a build slice. |

### P1 — the job completes but the product is weaker than the status quo

| # | Gap | Essentialness | Puzzle vs New | Home |
|---|---|---|---|---|
| **G5** | **The "why" — objection register + holdout type + contact log.** The North-Star's whole point ("3 בעלים מתנגדים"). Today only the status enum + free-text notes. | **P1** — chase is blind without it. | **New** (additive table). | **B2** (planned; gates the count-surfacing). |
| **G6** | **The chase loop actually chasing** — `expiring`/`stalled`/`threshold_reached` notifications + one-tap remind + cadence. The clock cleans up but never nudges. | **P1** — the product *promises* autonomy. | **Puzzle** — scheduler already runs 3 sweeps; add 1 consumer + 3 kinds. | **B3** + **M2** (planned). |
| **G7** | **Viewed-but-not-Signed state.** The killer triage signal (aware-and-stalling vs never-saw-it). `signature_requests` has no `viewed`. | **P1** — competitive parity (DocuSign). | **New** (one state + an open beacon). | Not homed. |
| **G8** | **Per-document expectation model ("expected / received / missing").** The MISSING state is what should DRIVE the workflow (tie a missing doc → task → chase). Today a `documents` row is either there or not; nothing is "owed." | **P1** — the document-flow model's core. | **Puzzle** — a `document_requirements` table + tie into `tasks`/`notifications`. | Detailed in `02`; net-new table. |
| **G9** | **Estate (עיזבון) / POA (ייפוי כוח) / company / minor owner representation.** A registered owner is often dead, a company, or represented. No first-class model; you can fake it in `owner SHELL` + notes but the signer-vs-represented distinction is legally load-bearing. | **P1** — a real building always has at least one. | **New** (a representation/capacity model on owners/ownerships). | Not homed. |
| **G10** | **Per-owner deal terms (תמורה).** The #1 thing owners negotiate; today flat project columns, no per-owner offer/agreed terms. | **P1** — the negotiation is the job. | **New** (a per-ownership terms record). | Deferred (build plan §G). |

### P2 — quality / explicit scope decisions

| # | Gap | Essentialness | Home |
|---|---|---|---|
| **G11** | **Retention schedule** by legal class (auto-dispose/hold). Compliance gap once the DMS holds legal docs. | **P2** (compliance hardening). | New. |
| **G12** | **Post-`approved` lifecycle** — second signing round, relocation tracking, permit clock. The product stops at "threshold met." | **P2** (explicit scope decision). | New; deferred (build plan §G). |
| **G13** | **Cancellation reason.** BI loss; trivial additive column. | **P2**. | New (one column). |
| **G14** | **DSAR export half** (the "give me my data" companion to erasure). Verify it exists; if not, it's a Privacy-Law gap. | **P2** (verify-then-decide). | Verify `data-subject.service.ts`. |

---

## D. WHAT IS GENUINELY COMPLETE (so the owner's certainty on the core is well-founded)

To be honest in both directions — the **signature-collection engine itself is production-grade and
the 41-slice plan maps it well**:

- The **structural spine** is correct and complete: project → building(+sections) → apartment(+unit
  types) → owner(+shell/erasure) → ownership(exact fractions, sum-trigger) → signature_request(single-
  use JWT) → signature(encrypted SVG, full provenance) → pii_processing_consent(self-verifying notice).
- The **security substrate** is real, not theatre: 4-layer RLS FORCE, owned auth, pgcrypto PII,
  AES-256-GCM envelope-encrypted sensitive docs, ClamAV fail-closed scan-gate, magic-byte + nosniff,
  append-only forensic audit, crypto-shred erasure with an immutable ledger, a live pg-boss scheduler.
- The **discovery → enrich → import → extract** front-of-funnel is modelled (discovery_records,
  owner shells, CSV import, Tabu auto-parse with mandatory human-confirm).

The certainty answer is therefore: **on the core engine, yes — what should be there is there.** The
gaps are not in the engine; they are in the **job around the engine** — the document FLOW, the legal
*number*, the legal *record*, and the parties + phases the engine was never extended to.

---

## E. THE DOCUMENT-FLOW MODEL — where it lives in the real process (this front's contribution)

The owner sharpened the model: documents are the **connective tissue**, organized per-project, per-
entity, **two-sided** (PROVIDE / RECEIVE), with a per-entity checklist whose **MISSING state drives the
workflow**. Walking the journey above, the document FLOW is concretely:

| Entity | PROVIDES (outbound) | Is OWED / RECEIVES (inbound) | Today |
|---|---|---|---|
| **Project** | the consent template, the תמורה brochure | the assembled package back from lawyer/וועדה | flat `documents` rows |
| **Owner** | ID/proof, probate (estate), POA | the agreement to sign, the תמורה offer, the signed copy | partial (`signature_requests` = one OWED doc; no checklist) |
| **Renter** | — | relocation / alt-housing docs | ❌ |
| **Building** | tabu נסח, sections | — | partial (`tabu_extractions`) |
| **שמאי (appraiser)** | the שומה | the building data needed to appraise | ❌ no party, no flow |
| **אדריכל (architect)** | the plans / היתר drawings | the parcel + program brief | ❌ |
| **עו"ד (lawyer)** | legal opinion, the filed package | the signed consents + owner data | ❌ |
| **bank** | financing letter | the appraisal + plans | ❌ |
| **וועדה (committee)** | the היתר (approval) | the full consent package + plans | ❌ |
| **contractor** | — (consumes) | overview / documents / signatures (read) | ✅ but flat, project-level, all-or-nothing |

**The model's verdict:** the *flat org hub* is ONE aggregate view; the canonical model is **per-project,
per-entity, two-sided, with a `document_requirements` (expected/received/missing) backbone that ties a
missing doc → a `task` → a `notification` (the agentic chase loop, applied to documents).** This EXTENDS
three proven mechanisms — `shares` JSONB scoped permissions (`_share-permissions.ts`), the
contractor-portal token + read-scoping (`contractor-portal/`), and the `documents` envelope-encryption +
scan-gate spine (`artifacts.ts:23-81`) — rather than a rebuild. The per-document and per-entity
permission grid + the time-limited, watermarked external link are the genuinely net-new pieces, designed
in the sibling docs `02-document-management.md` and `03-external-sharing.md`.

---

## F. THE CERTAINTY METHOD (so the owner can re-run this on the next feature)

How to KNOW nothing's missing, repeatably: don't audit routes — **audit the JOB**. For any candidate
feature, run the three lenses: (1) **walk the lifecycle** phase-by-phase and ask "what does the
*human* actually do here that we don't model?"; (2) **enumerate every stakeholder** and ask "what does
each PROVIDE and what is each OWED?" — the document-flow lens is a forcing function that surfaces
parties the schema forgot (it is exactly how the שמאי/אדריכל/bank gaps surfaced above); (3) **check
legal + competitive parity** — the statutory %, non-repudiation, retention, and "what did the
spreadsheet/lawyer's-folder already do?" A gap that survives all three lenses is a real should-exist
gap, not a missing screen.
