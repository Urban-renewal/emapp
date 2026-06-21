# 00 — DOMAIN COMPLETENESS + THE PER-ENTITY DOCUMENT-FLOW (the v7 synthesis)

> **Status:** DEFINITIVE v7 synthesis. The merge of the three v7 fronts into one
> answer for the owner's two asks. READ-ONLY planning doc; no app code changed
> here. Author: v7 LEAD synthesis seat, 2026-06-18. Supersedes the earlier draft
> of this file, which was written against the pre-sharpening hub framing
> (`02-document-management.md` / `03-external-sharing.md`). The owner then
> **sharpened** the model to a *per-project, per-entity, two-sided document FLOW*;
> the authoritative fronts are now `02-document-flow-model.md` and
> `03-external-exchange.md`, and this synthesis is rebuilt around them.
>
> **The owner's two asks this answers:**
> 1. **The certainty question** — "how do I KNOW everything that SHOULD be in the
>    system is actually there?" Every prior audit was *code-coverage* (route→screen).
>    This adds the missing audit type: *real-world-job coverage*, and — more
>    importantly — a *repeatable method* the owner can re-run forever.
> 2. **The document layer, as sharpened** — NOT a flat file list. A document FLOW,
>    organized **per project**, **per entity** (project · building · apartment ·
>    owner · renter · contractor · team-member · each external party), **two-sided**
>    (what each entity PROVIDES vs what it is OWED / RECEIVES), where the **MISSING
>    state drives the workflow** (documents as the connective tissue; the agentic
>    chase loop applied to documents), with precise per-entity/per-document
>    permissions and envelope encryption preserved end-to-end, and a secure two-way
>    external exchange ("send the bureaucracy in one click").
>
> **The one-line answer.** The signature-collection **engine** is genuinely
> production-grade and the 41-slice plan maps it well — so the owner's certainty on
> the *core* is well-founded. What it is NOT yet is the complete *urban-renewal
> JOB*, and the reason no prior audit caught the gap is structural: every prior
> audit asked "is every route mapped?" while these gaps are *missing parts of the
> job, not missing routes* — and the system's single missing organ is the
> **expectation layer**: today a document row exists only *after* an upload; there
> is no way to represent a document that *should* exist but doesn't. The whole
> document-FLOW model is **~55% puzzle** — it generalizes three already-shipping,
> production-grade mechanisms (the `documents` envelope-encryption + scan-gate
> spine, the `tasks`/`notifications`/`audit` chase rails, and the contractor-share
> token + RLS-scoped read tier) — and the net-new is essentially **one additive
> table** (`document_requirements`), a per-entity-type template, a matching rule,
> the two-way external exchange, and read-model lenses.

---

## PART 1 — THE CERTAINTY QUESTION (how to KNOW nothing's missing)

### 1.1 Why no prior audit could have answered this

A **code-coverage** audit asks *"is every route mapped to a screen?"* The v4 answer
was AMBER-green (158 routes, 15 headless). **That audit can be 100% green while the
product still cannot finish the job** — because the job has steps the code never
modelled, and a route-map can only see steps that exist as routes. The owner's
instinct is exactly right, and his own live proof is the document need: the *missing
document* was invisible to every route-map because **there is no route for a
document that does not yet exist.** The absence was the point.

### 1.2 The method — this is the durable certainty answer (re-runnable forever)

The certainty does not come from a one-time verdict; it comes from a **repeatable
method** the owner can re-run whenever the real world reveals a new requirement (as
it just did with the document flow, and as it will the moment a project has a
deceased owner or a שמאי who never returned the שומה). The method, exactly as the
domain front (`01`) executed it:

1. **Walk the canonical lifecycle** end-to-end — the real job a יזם physically
   performs over the 18–36 months of a project: first day → discovery/נסח → build the
   structure → reach owners → collect → handle holdouts/estates/renters → cross the
   legal threshold → assemble + FILE the וועדה package → approval → construction →
   post-approval. The real process, **independent of the code**.
2. **Enumerate every stakeholder** and, for each, ask the **two-sided document
   question**: *what does this party PROVIDE, and what is it OWED?* This is the
   forcing function — it is exactly how the שמאי / אדריכל / bank / וועדה gaps
   surfaced, because the schema simply forgot those parties existed.
3. **Enumerate the legal/regulatory obligations** — the statutory consent %,
   non-repudiation, DSAR/RTBF, retention, chain-of-custody, the committee record.
4. **Enumerate competitive table-stakes** — what a יזם runs today (Excel + WhatsApp
   + a lawyer's Dropbox) and what a best-in-class product must beat.
5. **Mark each COVERED / PARTIAL / GAP**, grounding every "COVERED" in real code
   (`file:line`) or a planned slice — **skeptical by construction**: a capability is
   COVERED only if the code or a planned slice does the *real-world job*, not merely
   names it.

The **ranked GAP register is the answer** (§1.5). It is exhaustive *over the real
job*, not over the code — which is precisely why it surfaces what route-maps cannot.
**The document-flow lens (step 2) is the sharpest blade in this method**: forcing
every entity to declare what it provides and what it is owed is what makes the
"should-exist-but-doesn't" set visible, because a thing that is *owed but absent* has
no row, no route, and no screen today.

### 1.3 The verdict — engine vs job

**The system is a genuinely complete and well-built signature-collection ENGINE, but
not yet the complete urban-renewal-project JOB.** The certainty on the core is real
and grounded: the structural spine (project → building(+sections) → apartment →
owner → ownership with exact sum-to-1 fractions → single-use-JWT signature_request →
encrypted-SVG signature with full provenance → self-verifying PII-notice consent) is
correct and complete; the security substrate is real, not theatre (4-layer RLS
FORCE, owned auth, pgcrypto PII, **AES-256-GCM envelope-encrypted sensitive docs with
a fail-closed ClamAV scan-gate** — verified at `artifacts.ts:48-69`, correcting the
v4 long-flows audit's WRONG "no AV scan" claim; magic-byte real-type pre-filter +
nosniff on the most recent commit of this branch; append-only forensic audit;
crypto-shred erasure with an immutable ledger; a live pg-boss scheduler).

The gaps cluster in **five job-areas a real יזם cannot finish the job without, but
which the product today treats as out-of-scope or models only as inert stubs**:

1. **The document layer is the connective tissue of the entire job, and it does not
   exist as such.** Today `documents` is a flat, org-internal upload/download list
   (`artifacts.ts:23-81`, parented by a flat 3-way nullable FK: project OR apartment
   OR org-level; `type` free text; **no `owner_id`/`building_id` link**), and a row
   exists *only after* an upload. The real job is a **per-entity, two-sided document
   FLOW** where every party PROVIDES some docs and is OWED others, and the **MISSING
   state drives the chase**. This is the owner's own sharpened ask and the
   highest-leverage gap — **~55% puzzle**.
2. **The legal consent number is computed WRONG for the statutory test** — binary
   by-heads, not share-weighted, with no per-building basis (`projects.service.ts:
   419-421`: `metThreshold = consentedPct >= targetSignaturePct`, where `consentedPct
   = apartmentsConsented / totalApartments`). The exact fractions ARE stored
   (`ownerships.share_numerator/denominator`, sum-trigger=1) but **never read** by the
   progress math. Homed as **B0** ⭐CRITICAL.
3. **Hard-case people are stubbed, not modelled** — estate (עיזבון) / POA (ייפוי כוח)
   / company / minor owner representation has no first-class model; the renter was
   demoted to a discovery source (`discovery_records`) and is never tracked as a party
   owed relocation; deal-terms (תמורה) live as flat project columns with no per-owner
   record.
4. **The legal-record completeness beyond the tally is missing** — no objection /
   withdrawal register, no retention schedule, no signed-package manifest (the
   artifact the וועדה/lawyer actually receives). The committee print-of-record is
   planned (**C1**, a go-live blocker) but unbuilt.
5. **The post-`approved` lifecycle falls off a cliff** — no relocation tracking, no
   second 100% execution-signing round, no permit/היתר clock, no cancellation reason.
   Likely post-MVP, but it means the product stops at "threshold met," not "deal done."

Of these, **#1 (the document FLOW) is the most puzzle-not-new and the owner's stated
priority**; **#2 (B0) is the single most dangerous defect already homed**; **#3–#5
are honest net-new scope decisions** that should be made explicitly, not by omission.

### 1.4 Stakeholder coverage (the second axis — and the forcing function)

The two-sided document question, applied to every party. The pattern is stark and is
itself the finding: **the internal stakeholders are covered; the external parties —
the entire right side of the bureaucracy — are not modelled at all.**

| Stakeholder | PROVIDES → / ← RECEIVES (is OWED) | Status | Note |
|---|---|---|---|
| יזם / org manager | the consent template, the package → ← the assembled package back | 🟡 | Core covered; gaps in package-filing, per-owner deal-terms, operator console. |
| Team — agent / viewer | (actors, not parties owed docs) | ✅ | project-assignments + capability gates; they appear as fulfiller/assignee. |
| Apartment owner | ID/proof, נסח-בעלות, POA → ← the agreement to sign, התקנון, נספח-דירה, signed copy | 🟡 | Sign + portal covered; the per-owner doc **checklist** (provides/receives) does not exist. |
| **Renter / occupant** | חוזה-שכירות → ← הודעת-פינוי / relocation docs | ❌ | Discovery-source only; no party owed relocation. |
| **שמאי / appraiser** | **the שומה** → ← נסח · plans · אומדן-בסיס | ❌ | No external-party entity; no two-way flow. **(Owner's live example.)** |
| **אדריכל / architect** | plans · היתר drawings → ← נסח · תב"ע · מדידה | ❌ | No party; no upload-back. |
| **עו"ד / lawyer** | חוו"ד · נוסח-הסכם · the filed package → ← all signatures · התצהירים · נסח | ❌ | No lawyer party; no package-share. |
| **bank / financier** | מכתב-ליווי → ← השומה · התקנון · aggregate tally | ❌ | No party; sensitive-doc external share blocked today. |
| **וועדה / committee** | אישור/החלטה · היתר → ← **the full bureaucracy package** | 🟡 | C1 print planned; the assembled bundle is a GAP. |
| Contractor (builder) | (ערבויות/ביטוח post-MVP) → ← project overview · shared docs | ✅ | The one fully-built external tier — but flat, project-level, all-or-nothing, read-only. |
| Provider Admin | cross-tenant ops, recovery | 🟡 | C12b recovery subset is a go-live blocker. |

### 1.5 THE SHOULD-EXIST GAP REGISTER — ranked, each slotted

Ranked by essentialness to a real production product. "Puzzle" = extends a proven
mechanism; "New" = genuine net-new scope. "Slot" = the v7 slice (§4) or existing
build-plan slice that homes it.

**P0 — the job cannot legally/practically complete, or the product emits a dangerous output:**

| # | Gap | Puzzle vs New | Slot |
|---|---|---|---|
| **G1** | **The per-entity, two-sided document FLOW** — the expectation layer (`document_requirements`: every entity's PROVIDE/RECEIVE checklist, `missing` until fulfilled), the matching rule, the missing→chase tie-in. The owner's #1 ask; the connective tissue of the whole job. | **~55% Puzzle** (generalizes `documents` + `tasks`/`notifications`/`audit` + the share tier). One additive spine table + a template + a matcher. | **FLOW-1..4** (§4.2). |
| **G2** | **Share-weighted consent + per-building basis.** The legal `metThreshold` rides on a binary by-heads count; a printed/displayed % with the wrong denominator is the single most dangerous output the product can emit. | **Puzzle** — fractions already stored + sum-guaranteed; re-author one CTE. | **B0** ⭐ (planned). |
| **G3** | **Committee print-of-record + the filing PACKAGE / manifest.** The product's raison d'être — the basis-labeled tally AND the immutable bundle (signatures + תצהירים + שומה + plans + נסח) the יזם hands the וועדה/lawyer. | C1 = **New** (small); package = **New** (a manifest over existing rows, leans on the export composer). | **C1** + **DOM-PKG** / **X4** (§4.2). |
| **G4** | **Secure two-way external exchange** (שמאי/אדריכל/עו"ד/bank/וועדה): generic external party + document-set-scoped grant + the PROVIDE upload-back + time-limited + OTP-for-sensitive + watermark + per-access receipt. Today: contractor-only, project-level, all-or-nothing, **read-only**. | **~60% Puzzle** on the receive half; the **provide upload-back** + the **package builder** are the genuine net-new (both bolt onto existing seams). | **X1–X5** (§4.2). |

**P1 — the job completes but the product is weaker than the spreadsheet+WhatsApp+lawyer's-folder status quo:**

| # | Gap | Puzzle vs New | Slot |
|---|---|---|---|
| **G5** | **Objection register + holdout type + contact log** ("3 בעלים מתנגדים"). Today only the status enum + free-text notes. | New (additive table). | **B2** (planned; gates count-surfacing). |
| **G6** | **The chase loop actually chasing** — `expiring`/`stalled`/`threshold_reached` + one-tap remind. The scheduler runs but emits zero notifications. | Puzzle — add 1 consumer + 3 kinds. | **B3** + **M2** (planned). |
| **G7** | **Viewed-but-not-Signed state.** The killer triage signal; `signature_requests` has no `viewed`. | New (one state + an open beacon). | Not yet homed. |
| **G8** | **Estate / POA / company / minor owner representation.** A real building always has at least one; the signer-vs-represented distinction is legally load-bearing. Ties the `conditional` POA requirement in the flow template. | New (a representation/capacity model). | **DOM-1**. |
| **G9** | **Per-owner deal terms (תמורה).** The #1 thing owners negotiate; today flat project columns. | New (a per-ownership terms record). | **DOM-3** (post-MVP). |
| **G10** | **Renter axis made real** (retire the dead `RelationshipSchema = z.enum(['owner'])`; build the discovery FE; the renter's relocation RECEIVE checklist). | Partial→build. | **C10** (extend) + shared-types migration. |

**P2 — quality / explicit scope decisions (long tail):**

| # | Gap | Slot |
|---|---|---|
| **G11** | **Document retention / legal-hold** by legal class (the audit-retention cron is the precedent). A real compliance gap once the DMS holds legal docs. | **DOM-2** (folds near the C16 compliance cluster). |
| **G12** | **Signer-identity at sign-time** — is OTP-to-phone a legally sufficient תמ"א signature? | **OD-7** legal gate; ship the engine behind it. |
| **G13** | **Post-`approved` lifecycle** — permit/decision entity, relocation/rent-comp ledger, second execution-signing round. | **DOM-4/5/6** (post-MVP). |
| **G14** | **Cancellation reason** (one column) · **DSAR export half** (verify `data-subject.service.ts`). | Trivial / verify-then-decide. |

### 1.6 What the certainty answer PROVES

The engine is covered or homed; the 41-slice plan is a real and largely-complete map
**of the engine**. What it is not yet is a complete map **of the JOB** — and *none of
the §1.5 P0/P1 gaps correspond to a missing route*, which is exactly why no
code-coverage audit found them. The §1.2 method (especially the two-sided document
question) is the durable instrument: re-run it whenever the real world reveals a new
requirement, and it keeps surfacing the should-exist gaps a route-map cannot. The
owner can now KNOW, because (a) the core engine is exhaustively mapped and grounded in
code, and (b) the gap register is exhaustive over the *real job* and every entry has a
concrete, sequenced home.

---

## PART 2 — THE PER-ENTITY DOCUMENT-FLOW MODEL (the owner's sharpened ask)

### 2.1 The model in one picture — the expectation layer is the missing organ

The owner sharpened the model away from a flat file list to a **per-project,
per-entity, two-sided FLOW**. Documents are organized **per project** (the project is
the container/context). For EVERY entity in a project — the project itself, each
building, each apartment, each owner, each renter, the contractor, each team member,
AND each external party — there are **two sides**:

- **(A) PROVIDES (outbound)** — the docs that entity uploads/supplies (owner uploads
  ID/proof; architect uploads plans; appraiser uploads the שומה).
- **(B) RECEIVES / is OWED (inbound)** — the docs that entity needs to receive (owner
  must receive the agreement to sign; the וועדה must receive the package; the bank the
  appraisal).

So each entity has a **document checklist**: what is EXPECTED, what is RECEIVED, what
is MISSING. **The MISSING state DRIVES the workflow** — the system knows what each
entity owes/needs and chases it. The flat "org hub" is just ONE aggregate VIEW; the
canonical model is per-project, per-entity, two-sided.

```
        PROVIDES (outbound)                         RECEIVES / IS OWED (inbound)
        ──────────────────                          ───────────────────────────
 OWNER  ת"ז · נסח-בעלות · ייפוי-כוח   ──┐      ┌──  ההסכם לחתימה · התקנון · נספח-דירה · עותק-חתום
 APT    מדידה · היתר-קודם              │      │     נספח-דירה להסכם
 BLDG   נסח-מתחם · תב"ע · מפת-מדידה    │      │     —
 PROJ   תקנון · נסח-מתחם · אומדן       ├─►  DOCUMENT  ◄─┤  אישור-וועדה · היתר-בנייה
 שמאי   השומה                          │   REQUIREMENT  │  נסח · תוכניות · אומדן-בסיס
 אדריכל תוכניות · היתר                  │   (one row =   │  נסח · תב"ע · מדידה
 עו"ד   חוו"ד · נוסח-הסכם               │   one EXPECTED │  כל-החתימות · התצהירים · התקנון
 bank   מכתב-ליווי                      │    document)   │  השומה · ספירת-חתימות (aggregate)
 וועדה  אישור/החלטה · היתר              │               │  החבילה-המלאה (signed+תצהירים+שומה+תוכניות)
 contractor  (ערבויות post-MVP)        ┘               └  overview · shared docs (today ✅)
```

Every cell is a **`document_requirement`** — a row that says *"entity E, in project P,
is EXPECTED to {provide|receive} a document of type T."* The row exists from the
moment the entity exists (templated, §2.3). It is `missing` until a real `documents`
row fulfills it. **The MISSING set is the work queue.** Critically, the **same
document can fulfill a `provide` requirement on one side and a `receive` requirement
on the other** — the שומה the שמאי PROVIDES is the שומה the bank/וועדה RECEIVES: one
`documents` row, two satisfied requirements. **That duality is the connective tissue.**

### 2.2 Why the route-map could never find this (and the data-model reason)

Today a `documents` row exists **only after an upload**; the lifecycle is
*(no row) → created → uploaded → scanned → archived*. There is **no row for a document
that is owed but not yet provided**. So:

- a route-map sees no route (the document doesn't exist);
- a code-coverage audit sees no gap (there's nothing to map);
- the *missing* state — the thing that should drive the entire chase — is simply an
  **absence**, unrepresentable.

The fix is **one net-new spine table** (`document_requirements`), deliberately
*parallel* to `documents` (not a column on it), because a requirement exists **before
and independently of** any document, and one document satisfies several requirements:
a requirement has no bytes/r2_key/scan (it would violate every NOT NULL on `documents`
and pollute the ghost-guard serving paths); and a 1:1 `documents.expected=true` column
cannot model the one-doc-fulfills-many duality above.

### 2.3 THE REQUIRED-DOCUMENTS TEMPLATE (the domain IP, per entity-type)

This is the per-entity-type catalogue for תמ"א 38 / פינוי-בינוי — the owner's "what
SHOULD be in the system, per party." Each row is a **requirement template**:
`(entity_type, direction, doc_type, obligation, sensitivity)`. `obligation` ∈
`required | conditional | optional`; `direction` is **P** = PROVIDES / **R** =
RECEIVES; 🔒 = sensitive (PII/financial → envelope-encrypted + OTP). It is the
*day-one-correct structure* — and it must be **seeded-but-editable per-org** (§2.6 D5)
so the certainty method can land new real-world requirements as **data, not code**.

| Entity | PROVIDES (P) | RECEIVES / is OWED (R) |
|---|---|---|
| **PROJECT** | 🔒נסח-מתחם · תב"ע/זכויות-בנייה · מפת-מדידה/תשריט · אומדן/תוכנית-עסקית *(cond.)* · התקנון | אישור-וועדה/החלטה · היתר-בנייה *(cond. on `approved`→`in_construction`)* |
| **BUILDING** | 🔒נסח-טאבו(מבנה/חלקה) · תשריט/מפת-מדידה · תיק-בניין/היתר-קודם *(opt.)* | — |
| **APARTMENT** | נסח-דירה/רישום *(cond.)* · מדידת-דירה *(opt.)* | נספח-דירה-להסכם *(req.)* |
| **OWNER** | 🔒ת"ז(id_document) · 🔒נסח-בעלות · ייפוי-כוח *(cond. — ties DOM-1 estate/POA)* · תצהיר *(cond.)* | ההסכם-לחתימה · התקנון · נספח-הדירה · אישור-חתימה/עותק-חתום *(non-repudiation)* |
| **RENTER/OCCUPANT** | חוזה-שכירות *(opt.)* | הודעת-פינוי/הסדר-מעבר *(cond. — relocation track, DOM-5)* |
| **CONTRACTOR** | ערבויות/ביטוח/רישיון *(cond., post-MVP)* | project overview · shared docs *(TODAY's contractor-share IS this row — puzzle)* |
| **TEAM MEMBER** | — *(actors, not parties owed/owing docs; they appear as `fulfilled_by`/assignee — an honest scoping decision, do not invent member doc requirements)* | — |
| **שמאי / appraiser** | **השומה** | נסח · תוכניות/floor-plans · אומדן-בסיס · project overview |
| **אדריכל / architect** | תוכניות-אדריכליות · היתר | נסח · תב"ע · מפת-מדידה |
| **עו"ד / lawyer** | חוו"ד · נוסח-ההסכם | כל-החתימות · התצהירים · התקנון · נסח |
| **bank** | מכתב-ליווי/אישור-מימון | התקנון · השומה · ספירת-חתימות (aggregate) · מכתב-מצב |
| **וועדה / committee** | אישור/החלטת-וועדה · היתר | **החבילה-המלאה**: כל-החתימות + התצהירים + השומה + התוכניות + הנסח + הפרוטוקול |

The וועדה's RECEIVE row — "the full package" — is the **filing-package generator**
(DOM-PKG / X4): a single requirement whose fulfillment IS the assembled bundle. This
is where the two-sided model and the package mechanism meet. **Every "R" cell above is
a thing the system today CANNOT represent as owed** — each is a candidate
should-exist-but-doesn't that the route-map could never surface.

### 2.4 The data model — one net-new spine table

`document_requirements` (NET-NEW — the expectation spine), `org_id`-RLS-FORCE, parallel
to `documents`:

```
document_requirements (
  id, org_id (RLS FORCE), project_id (the flow container),
  -- WHICH ENTITY (exactly one set; a subject_xor CHECK enforces it):
  subject_type  text,  -- 'project'|'building'|'apartment'|'owner'|'renter'|'contractor'|'external_party'
  building_id?, apartment_id?, owner_id? (🔒 PII subject; externals NEVER traverse),
  discovery_id? (renter axis), contractor_id?, external_party_id? (sibling 03 table),
  -- THE TWO SIDES:
  direction     text,  -- 'provide' | 'receive'
  doc_type      text,  -- the §2.3 taxonomy (agreement·regulation·tabu_extract·blueprint·
                        --   appraisal·committee_doc·permit·financing·id_document·protocol·
                        --   power_of_attorney·other), free-text-TOLERANT reads (DV-MGR-DOCS lesson)
  obligation    text default 'required',  -- required|conditional|optional
  sensitive     boolean default false,    -- mirrors documents.sensitive; drives §2.5 gating
  -- FULFILLMENT (the missing→received transition):
  status        text default 'missing',   -- missing|received|waived|not_applicable
  fulfilled_by_document_id? -> documents(id) ON DELETE SET NULL,  -- archive reverts toward missing
  fulfilled_at?, waived_by?, waived_reason?, due_at?  (the chase deadline → §2.5 tasks),
  -- PROVENANCE: source ('template'|'manual'|'derived'), template_key (idempotent re-seed),
  created_by?, created_at, updated_at, archived_at
)
```

Key constraints (matching codebase conventions): a partial-unique
`(project_id, subject_type, COALESCE(entity FKs…), direction, doc_type) WHERE
archived_at IS NULL` (one open requirement per entity/side/type; idempotent
template re-seed — carry the migration-silent-skip + raw-seeder cautions from memory);
`idx (project_id, status) WHERE archived_at IS NULL` (the hot "what's missing here"
query); a per-owner index; closed-set CHECKs (`direction`/`status`/`obligation`) at
the DB **and** the Zod edge (belt-and-suspenders); RLS FORCE on `org_id`.

**The fulfillment-matching rule** (the only genuinely new logic): when a `documents`
row lands, match it to open requirements by `project_id` (+ roll-up), same **subject**
(`documents.owner_id == requirement.owner_id`, needs the additive `documents.owner_id`
parenting FK; or apartment/building/project match), and compatible `doc_type`.
Matching is **suggest-then-confirm by default** (the DO-NOT-FABRICATE doctrine + the
tabu auto-parse→human-confirm precedent): the system proposes "this upload looks like
owner X's נסח — confirm?" rather than silently flipping state; a manager setting can
auto-confirm exact-type matches.

### 2.5 How MISSING drives the workflow (the agentic loop) — PUZZLE on existing rails

- **Per-entity status** is a pure read-model aggregate: `expected` /
  `received` / `missing` over an entity's requirements; an entity is
  *document-complete* when `missing = 0`. Composes up the graph
  (owner→apartment→building→project). No new write path.
- **Missing → task (the chase)** — PUZZLE on `tasks` (`collaboration.ts:90`, already
  carries project/apartment/due_at/status/type). Additive: `tasks.requirement_id ->
  document_requirements` (a chase task is traceable to the exact owed document and
  auto-resolves when the requirement flips to `received`), `task.type =
  'document_chase'` (free text — no enum change), and `tasks.owner_id` (recommended —
  makes the owner the first-class subject of both docs AND chases; symmetric with the
  new `documents.owner_id`). *Net-new: 2 FKs.*
- **The RECEIVE side is fulfilled by DELIVERY, not upload** — the insight that closes
  the two-sided loop. An owner's "receive the agreement" requirement is fulfilled when
  a `signature_requests` row is sent (the signing flow is the delivery); an external
  party's "receive the package" is fulfilled when a `document_exchange` is sent (front
  `03`). This surfaces the **asymmetry the owner described**: the שומה the שמאי
  uploaded (provide ✓) is `received` for the project but the bank's *receive* is still
  `missing` until it is forwarded — "**in, but not yet forwarded to the bank.**"
- **The action-queue surface** — PUZZLE on `notifications` (+ two enum values
  `document_requested` / `document_overdue` — carry the schema-constraint-ripple
  caution, scan raw seeders) + an overdue sweep (the audit-retention cron is the
  precedent) + the org-wide "missing documents" queue (a new dashboard lens). This is
  the agentic loop's visible surface: *the system's list of what it is chasing.*

The state machine is **fail-safe**: a requirement **never silently disappears** —
archiving the fulfilling document reverts it toward `missing` (the chase re-opens),
never deletes the expectation (DO-NOT-FABRICATE: never claim a doc is on file when it
was pulled); `waived` requires an explicit user + reason (audited); `conditional`
requirements (POA-when-representative, permit-when-`in_construction`,
relocation-when-renter-relocating) only count as `missing` when their predicate is
active — tying the flow to the project/owner state machines and the DOM slices.

### 2.6 Precise permissions + encryption preserved end-to-end

The flow inherits the existing document ACL/role/PII gating and adds the
**requirement-visibility rule**:

1. **Who sees a requirement = who could see the document that would fulfill it.** A 🔒
   owner-`id_document` requirement is manager-only + PII-tier, exactly like the doc.
   The "who-can-see" surface shows the blast radius of a *missing* doc too.
2. **Who can fulfill (upload against) a requirement** = the role/capability that can
   create documents for that subject (`documents.create` + project scope + agent
   `manage_documents`). The **one genuinely new external capability** is an external
   party fulfilling its own *provide* requirement via a scoped write-back (front `03`
   FLOW-5 / X3).
3. **PII stays structurally OFF for externals** — the `owner_id` FK is the line
   externals never cross. A שמאי's "receive נסח" is satisfied by the *project/building*
   נסח, never an *owner-linked* one — the same guarantee as
   `ContractorReadService`'s "no owners table is ever queried."
4. **Encryption preserved end-to-end** — a requirement carries `sensitive`; the
   fulfilling upload routes through the existing envelope-encryption + OTP-step-up gate
   **unchanged**. The flow layer adds **no new bytes path** — it points at the existing
   one. Requirement lifecycle (`requirement.create/fulfill/waive/overdue`) rides the
   existing `AuditService`.

### 2.7 The three UI lenses (the views the owner named)

All read-models over `document_requirements` + `documents` — no new write surface,
dense RTL, same component family as the rebuilt Owners table (task #29):

1. **Per-project lens — the flow board.** A matrix of **entities (rows) ×
   required-doc-types (columns)**, each cell a traffic state (received ✓ / missing ⬚ /
   waived / N-A / overdue ⚠). The single screen that answers "what does this project
   still owe/need." Click a missing cell → the chase action.
2. **Per-entity lens — the checklist (the owner's/apartment's binder).** A two-column
   **PROVIDES | RECEIVES** checklist for one owner/apartment/external party — the
   literal artifact the owner described ("each entity has a document checklist"), with
   upload/send/chase inline.
3. **Org-wide aggregate — the missing-docs queue.** Every `status='missing'` required
   requirement across all projects, grouped + sorted by due date — the operator's
   "what is the system chasing right now" cockpit. (The flat hub is ONE tab of this
   cockpit; the requirement aggregate is the other.)

---

## PART 3 — THE SECURE TWO-WAY EXTERNAL EXCHANGE ("send the bureaucracy")

### 3.1 The headline: extend the contractor tier, don't rebuild (~60% puzzle)

EMAPP **already operates a production-grade external read tier** (the contractor
share). It is the natural thing to generalize — the owner's instinct is correct.
Verified puzzle pieces:

- **Share-as-grant + `.strict()` scoped JSONB perms** (`shares` +
  `_share-permissions.ts`): fail-closed (unknown keys rejected), `revoked_at`/
  `revoked_by` lifecycle (not delete), `last_accessed_at` telemetry, partial-unique
  active-share index — already hardened, just shaped for a contractor.
- **The external auth tier**: a dedicated JWT audience `emapp-share`
  (token-confusion-proof — a share token can't authenticate any other audience);
  30-day TTL but **revocation is immediate** because the guard re-checks `revoked_at`
  every request under the token's org-RLS, refusing missing/revoked/org-suspended
  (D.49).
- **The structurally-narrow read view** (`ContractorReadService`): the `owners` table
  is **never queried** (PII OFF is *structural*, not a flag); signatures are
  aggregate-only (`'individual'` is type-unrepresentable); the download gate
  fail-closes on `uploaded_at IS NOT NULL AND scan_status='clean' AND sensitive=false`
  + an explicit IDOR check. **This is the exact template for a secure external document
  view — it just needs scoping to a document SET instead of a whole project.**
- **The serving spine**: `EMAPPENC` AES-256-GCM at rest, decrypt-STREAM egress (never
  a presigned ciphertext URL), ClamAV scan-gate, magic-byte + nosniff, ghost-guard.
- **The package precedent**: the export composer (binary bundle under `withTenant`,
  per-call audit, DB-backed cross-replica rate limit, client-disconnect→Abort,
  Hebrew-safe RFC-5987) — the package-render spine; it just lacks recipient-addressing.
- **Audit + suspend + notification** spine, reused verbatim.

### 3.2 The three genuine net-new pieces (each bolts onto an existing seam)

1. **A GENERIC external-party entity.** Today the only external party is `contractors`
   (a business partner with an aggregate *project* read; the share row hard-binds
   `contractor_id`; perms are `overview/documents/signatures`). A שמאי is a
   *single-document-job vendor* — forcing it through `contractors` over-grants the
   whole project and mis-models the party. **Net-new:**
   - **`external_parties`** (org-scoped, RLS FORCE — mirror `contractors`):
     `(id, org_id, project_id, kind, display_name, contact_email?, contact_phone?,
     archived_at)`. `kind` = closed enum + CHECK `appraiser|architect|lawyer|bank|
     committee|other` (Hebrew labels in the UI layer only). Contact PII kept OUT of
     notification bodies, never logged.
   - **`external_exchanges`** (the grant — `shares` generalized): adds **`expires_at`**
     (the contractor share has no native expiry) and **`direction`** (`receive|provide|
     both`), plus a **document-SET-scoped** `.strict()` `scope` JSONB
     (`{ documents:{items|bundleId, download, view_only, watermark}, provide:{allowed,
     expected_types[]}, otp_required }`) with role-typed defaults per `kind`
     (`defaultExternalScope(kind)`, mirroring `defaultSharePermissions()`).
2. **THE PROVIDE / upload-back path** — the biggest net-new, since every external
   endpoint today is `@Get`-only. The appraiser returns the שומה; it must land as a
   **received** document on the project flow and flip the party's outbound-expected
   checklist item missing→received (the join to the §2.5 chase loop). Design: the
   FIRST `@Post` on the external tier (`/exchange/documents` → `/:id/content` raw
   octet-stream, same 50 MB ceiling → `/:id/finalize`), a **thin external-auth wrapper
   over the existing `DocumentsService.uploadContent` + `finalize`** — **no new crypto,
   no new scanner**: every byte goes through ClamAV scan → `scan_status` gate →
   AES-256-GCM envelope encrypt → ghost-guard → magic-byte + nosniff. It lands with
   `uploaded_by` = a **system/exchange actor** (the external party is not a `users`
   row), pinned to the providing party, immediately a *received* doc with provenance
   "הועלה ע"י <party> דרך קישור מאובטח". Safety on the write path: `scope.provide.
   allowed` + not revoked/expired + org not suspended; `expected_types` allow-list
   (a שמאי uploads `appraisal`, not arbitrary types); a tight DB-backed rate limit
   (leaked link ≠ bulk malware vector); the write path **cannot read** anything it
   didn't just upload; audit `exchange.document.provided`.
3. **THE PACKAGE — one-click "send the bureaucracy."** A `PackageTemplateService`
   that, given `(project, kind)`, resolves the *expected document set* — **the §2.3
   per-entity required-docs model read in REVERSE** (what the *recipient* is owed):
   וועדה = consents tally + תצהירים + שומה + plans; bank = שומה + financials. It
   **surfaces missing items before send** ("השומה עדיין לא הותקבלה — לא ניתן לשלוח
   חבילה מלאה לוועדה") — the missing-state driving the workflow, exactly the owner's
   framing. The composite (`POST /projects/:id/packages` with `{recipientPartyId,
   templateKind}`): resolve the set → verify each `clean`+finalized+in-scope →
   create/refresh a scoped `external_exchange` (`direction: receive`, `expires_at`,
   `otp_required` per sensitivity) → mint the signed link → deliver via
   `IEmailProvider`/`ISMSProvider` → write the **receipt** (a `packages` row +
   `package.sent` audit recording recipient, item list, hashes, sent-at). One click,
   **full foresight**: the preview shows who / what N documents / what's missing /
   what's sensitive before fire (mirrors the campaign dry-run pattern).

### 3.3 The honest security posture (state plainly in the UI)

- **Scoped** ✅⊕ — RLS + `.strict()` perms exist; tighten from project-overview to a
  **document-set** scope; the viewer never joins `owners` (the structural-narrowing
  principle carried forward). RLS/tenant isolation maintained on every path.
- **Time-limited** ⊕ — add explicit **`expires_at`** on the exchange, checked in the
  guard alongside `revoked_at`. A שמאי link expiring in 14 days is the norm.
- **`sensitive`-in-scope is a deliberate widening** over the contractor tier's hard
  exclusion (the שומה / financial pack ARE sensitive and ARE the point), safe **only**
  behind: **OTP-at-link-open** (reuse the tenant SMS-OTP spine; default
  `otp_required=true` whenever the scope contains a sensitive doc) + **decrypt-stream**
  (never presigned ciphertext) + `expires_at` + per-access audit + optional
  **view-only** (inline, no download URL) + **watermark** (party-id + timestamp,
  PDF-only — can't watermark arbitrary binaries; never *claim* one it can't burn).
- **Revocable in one click** ✅ — `revoked_at` + guard re-check → immediate kill; reuse
  `SharesService.revoke` (fires a `*_revoked` notification).
- **Per-doc view/download counts + receipt** ⊕ — new audit verbs
  (`exchange.document.viewed/downloaded`) over append-only `audit_log`; the receipt is
  the artifact that lets a non-technical יזם **prove to the וועדה** what was sent and
  received.
- **The one non-trivial migration:** add `'external'` to the audit `actor_type` CHECK
  (confirmed `IN ('user','system','provider')` at `artifacts.ts:299`) so the forensic
  spine attributes external access as a first-class actor (and closes a latent gap: the
  contractor guard writes `last_accessed_at` but emits no per-read audit row — fix both
  tiers). Carry the schema-constraint-ripple caution.

### 3.4 Open decisions for the owner/legal

- **Token audience split** (🔒 PL) — keep `emapp-share` for both, or split to
  `emapp-exchange` for blast-radius isolation (+1 boot env var + secret split).
  Recommend split at X5.
- **OTP channel** for sensitive exchange — SMS (reuse tenant spine) vs email (Resend);
  default `otp_required=true` when any scoped doc is sensitive.
- **Package completeness** — advisory not blocking by default: preview WARNS on missing
  items, send is allowed with an explicit "שליחה חלקית" acknowledgment (audited), never
  silently.
- **The external party is not a `users` row** — confirm the system/exchange actor model
  so provenance reads "via secure link," not a fake user.

---

## PART 4 — HOW IT ALL FOLDS INTO THE BUILD PLAN

### 4.1 The principle — a coherent new wave, NOT a Wave-0 delay

The v4 plan front-loads the certainty/consent/security gates (Waves 0–3) and pushes
completeness to Wave 4. **None of this v7 work touches that critical path.** The
document-flow + external-exchange work depends only on **Wave 0** (S0-SEC global
validation pipe + PERF cache) and the additive per-entity parenting; it is otherwise
independent of Waves 1–3. It slots as **Wave 5** plus a small set of domain (DOM)
slices that home the §1.5 hard-case/people/legal gaps. **Wave 0 is not delayed; the 4
CRITICAL slices (S0-SEC → B5 → B0 → B3) and the go-live blockers keep their order.**

### 4.2 Wave 5 — the document FLOW + the external exchange

Every slice carries the universal DoD (typecheck/lint/test + the input-validation
guard for new endpoints + 4-axis Chrome verify per role + perf budget + North-Star
check + a `gen-api-docs` registry entry).

**The FLOW sub-wave (the expectation layer — the keystone net-new):**
- **FLOW-0 — additive parenting** *(BE, one migration)*: `documents.{owner_id,
  building_id}` FKs (unlocks the per-owner lens + the matcher's subject join). No
  backfill.
- **FLOW-1 — Requirement spine + template** *(BE, one migration)*:
  `document_requirements` + RLS FORCE + the §2.3 template **seeded-but-editable
  per-org**, materialized per-project/per-entity on entity creation (idempotent —
  the system-folder-seeding hook is the precedent) + the Zod contract + CRUD.
- **FLOW-2 — Fulfillment matching + status roll-up** *(BE)*: the suggest-confirm
  matcher (doc-upload → requirement), the per-entity status read-model, the
  RECEIVE-via-signing/sharing fulfillment hooks (§2.5).
- **FLOW-3 — Missing → chase** *(BE)*: `tasks.requirement_id` + `tasks.owner_id` FKs,
  `document_chase` task minting + auto-close, the 2 notification types + the overdue
  sweep. 🔒 enum migration → schema-constraint-ripple scan.
- **FLOW-4 — The three lenses** *(FE)*: per-project flow-board · per-entity checklist ·
  org-wide missing-queue.

**The external-exchange sub-wave (X1–X5; the owner's "send the bureaucracy"):**
- **X1 — `external_parties` + `external_exchanges` + `scope` Zod** *(BE, one
  migration, RLS FORCE)*: the generic entity + the grant + `defaultExternalScope(kind)`;
  reuse the share token/guard (extended with `expires_at` + `direction`). Gate: RLS
  isolation spec (other-org party invisible).
- **X2 — RECEIVE viewer (scoped read)** *(BE+FE)*: generalize `contractor-read` to a
  document-SET scope; view-only vs download; sensitive-in-scope behind OTP. Gate: IDOR
  + no-other-entity-PII spec; browser walk as a real שמאי (sees only the שומה pack).
- **X3 — PROVIDE upload-back** *(BE+FE, 🔒SECURITY-SENSITIVE)*: the external write tier
  over the existing scan+encrypt spine; `expected_types` allow-list; DB-backed rate
  limit; lands as a *received* doc pinned to the party; fires missing→received
  (ties to FLOW-2/3). `@security-reviewer` before commit; malware-rejected + IDOR-on-write
  + "external can't read org docs via the write tier" specs.
- **X4 — Package builder + one-click send + receipt** *(BE+FE)*: `PackageTemplateService`
  (וועדה/bank templates as the §2.3 required-set reversed) + `POST /projects/:id/packages`
  composite + **preview/dry-run** (who/what/missing/sensitive) before fire + the receipt.
  Reuses the export composer + notification + email/SMS providers. Gate: "missing-item
  warns before full package" spec; receipt audit spec.
- **X5 — `actor_type='external'` migration + watermark + OTP-default + secret split**
  *(BE+FE, 🔒owner/legal-gated)*: the audit CHECK migration (`artifacts.ts:299`) + per-
  external-read audit (retrofit contractor reads too) + PDF watermark overlay +
  `otp_required` defaulting + the flagged `SHARE_TOKEN_SECRET`/`EXCHANGE_TOKEN_SECRET`
  split. Owner-gated because watermark legal text + OTP channel cost + a new boot env
  var are owner decisions.

**Sequencing rule (non-negotiable):** FLOW-0 → FLOW-1 → FLOW-2/FLOW-3 (parallel) →
FLOW-4; X1 → X2 → X3 → X4 (X4 needs the receive grant + ideally the provide side so it
can warn on still-missing items) → X5. **FLOW-5 / X3 (external write-back) is the only
security-sensitive net-new and is `@security-reviewer`-gated.** None of this touches
the v4 critical path (Waves 0–3).

### 4.3 The DOM slices (the hard-case/people/legal §1.5 gaps)

Net-new domain extensions, Wave-4-tail / post-MVP, owner-scoped:
- **DOM-PKG — Filing-package generator** (P0 G3): assemble signed docs + the
  basis-labeled tally + the owner roster + the נסח set → one immutable bundle to
  file/send. Leans on **C1** (the tally) and **X4** (the bundle/send mechanism). The
  וועדה's "receive the full package" requirement (§2.3) is fulfilled by this.
- **DOM-1 — Estate / POA / multi-heir model** (P1 G8): the #1 real-world staller; an
  estate/representation layer over `ownerships` + a signing workflow where N heirs / a
  POA-holder sign for one share. Activates the `conditional` POA/תצהיר requirements.
- **DOM-2 — Document retention / legal-hold** (P2 G11): a retention policy + legal-hold
  over documents (the audit-retention cron is the precedent); folds near the C16
  compliance cluster.
- **DOM-3/4/5/6** (P1/P2, post-MVP): per-owner deal-terms ledger · permit/decision
  entity · per-apartment relocation + rent-comp · second execution-signing round.
- **Renter axis** (P1 G10): a shared-types migration to retire `RelationshipSchema =
  z.enum(['owner'])` + build the C10 discovery FE + the renter's relocation RECEIVE
  checklist. Extends the existing C10 slice.

### 4.4 The legal gates this surfaces (new owner/lawyer decisions)

- **B0's statutory % + partial-share rule** — confirm with the owner/lawyer (the basis
  label rule applies to every % a shared package exposes).
- **OD-7 (new) — signer-identity at sign-time:** is OTP-to-phone a legally sufficient
  תמ"א signature, or is national_id challenge / ID upload / notary co-sign required?
  Ship the engine behind this.
- **External-exchange gates** (§3.4): bare-link vs OTP for non-sensitive sends; the OTP
  channel; the package-completeness "שליחה חלקית" rule; the system/exchange actor model.

### 4.5 Go-live blockers vs post-MVP

**Adds to the go-live blocker set (do NOT block Wave 0; sequence after the existing
blockers):**
- **The external exchange MVP (X1–X4)** — the owner's headline ask and a real
  competitive table-stake; the first customer who must hand the שמאי/עו"ד the
  bureaucracy needs it. *Blocker, but Wave-5, gated on FLOW-1.*
- **The filing-package generator (DOM-PKG)** — the product's raison d'être beyond the
  C1 tally; a יזם cannot "file" without it. *Blocker-adjacent.*
- **The FLOW spine (FLOW-1..3)** — without the expectation layer the product cannot
  answer "what does this owner / this וועדה / this project still owe," which is the
  owner's whole certainty ask applied to documents.

**Explicitly post-MVP (sequenced-out, not dropped):** dynamic watermark · full-text
content search · estate/POA workflow (DOM-1 — strongly desired) · per-owner deal-terms
(DOM-3) · permit/decision entity (DOM-4) · relocation ledger · second execution-signing
round · external one-time-code for PII docs · witness/notary co-sign (legal) ·
disputed-share state. MVP can ship `required`/`optional` requirements and treat
`conditional` as manager-toggled; auto-predicate activation is a fast-follow.

### 4.6 Does this change the certainty verdict?

No — it *completes* it. The build plan's verdict (`ready-to-build`, the engine is
control-complete after Waves 0–4) stands. This synthesis adds the honest second half:
the engine is complete; the **job** is complete after Wave 5 (the document FLOW + the
external exchange) + the DOM blockers (filing package, retention) land. Every
should-exist gap now has a concrete, sequenced home, and **the §1.2 method — above all
the two-sided document question — is the durable instrument** for the next requirement
the real world reveals.

---

## APPENDIX — code corrections carried from the fronts

1. The v4 long-flows audit claimed "no AV scan on documents." **WRONG.** ClamAV is
   wired fail-closed (`artifacts.ts:48-56`, `scan_status` gate; via
   `IFileScanProvider`) alongside magic-byte real-type filtering and AES-GCM envelope
   encryption (`artifacts.ts:64-69`). The document spine is production-grade; the
   missing layer is the *flow/management product* on top of it, not the security
   pipeline.
2. The legal consent number is binary by-heads at `projects.service.ts:419-421`; the
   exact `ownerships.share_numerator/denominator` are stored (sum-trigger=1) but never
   read. This is **B0**, the single most dangerous defect — a % with the wrong
   denominator is a fabrication, and a shared package would carry it externally.
3. `documents` has **no `owner_id`/`building_id`** parenting today (`artifacts.ts:
   23-31`, only `project_id`/`apartment_id` nullable FKs) — the additive FOW-0
   migration that the per-owner lens and the requirement-matcher both depend on.
