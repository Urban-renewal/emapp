# 01 — Domain Workflow: the real יזם signature-collection job, grounded in EMAPP

> Audience: the E2 product-redesign track. Purpose: surface the NON-OBVIOUS
> domain reality a busy product owner won't think to articulate, then
> cross-check it against what EMAPP actually models today (schema + API), and
> list the gaps in priority order. READ-ONLY research doc — no code changes.
>
> Method: first-principles model of the urban-renewal signature business, then
> grounded in `packages/db/src/schema/**` + `apps/api/src/modules/**`.

---

## 0. TL;DR for the redesign

The app models the **structure** of a deal well (project → buildings →
apartments → owners → ownerships → signature_requests → signatures, with
encrypted PII, RLS, provenance, erasure). What it does **not** model is the
**human, time, and legal-counting reality** of actually *closing* a deal:

1. **Consent is counted wrong for the legal test.** The app counts
   *apartments fully signed / total apartments* — a single binary per-apartment
   measure (`projects.service.ts` `signatureProgress`, lines 363–407). The
   real תמ"א / פינוי-בינוי legal majority is computed on **multiple
   simultaneous bases** (heads of apartments, *and* registered ownership-share
   of the common property, *and* — for פינוי-בינוי — a per-*building*/per-
   complex test). The exact-fraction share is even stored
   (`ownerships.share_numerator/denominator`) but is **never used** in the
   progress math. This is the single most load-bearing domain gap.
2. **There is no "why".** The North-Star explicitly wants the human bottleneck
   ("3 בעלים מתנגדים", "אורי דירה 7 לא חתם") — but the schema has **no
   objection-reason, no holdout-type, no "who/when/next-step" contact log**.
   The only signal is the 6-value `apartment_status` enum + free-text `notes`.
3. **There is no momentum / time pressure surfaced.** `statusChangedAt` and
   `lastContactAt` exist but feed nothing; there is no "no movement 18 days",
   no permit/regulatory clock, no expiry-soon list. Signature links silently
   expire at 7 days with no built-in nudge.

The redesign's job is to turn a correct *structural CRUD* into a *deal-closing
movie*. The backend is ready for the structure; the "why/when/who" layer needs
small additive backend slices (the North-Star already flags this: "do NOT fake
it").

---

## 1. The real project lifecycle, end-to-end — what the developer actually DOES

EMAPP's status enum is `planning | gathering_signatures | approved |
in_construction | completed | cancelled` (D.18, `_enums.ts:17`). That's the
**developer's internal pipeline label**, and it is coarse. The real job inside
each phase:

### 1.1 `planning` — assembling the deal before any owner is asked
What the developer does that the app barely touches:
- **Identify the parcel and pull the נסח טאבו (land registry extract)** for
  each חלקה to learn who legally owns what, in what fraction. EMAPP models this
  (`tabuExtractions`, `parcelSetups`, `ownerships.share_numerator/denominator`,
  provenance via `source_extraction_id`) — good. But parcel *auto-lookup* is
  owner-deferred (GovMap, per memory + BACKLOG E5), so today it is manual.
- **Reconcile registry vs reality.** The נסח names a *registered* owner who may
  be deceased, may have sold informally, may be a company, may be an estate
  (עיזבון) with heirs. EMAPP has the `owner SHELL` concept (nullable
  `name_encrypted`/`national_id` for a skeleton owner to enrich later,
  `projects.ts:223`) and **discovery_records** (a field worker visits an
  apartment, records `not_visited | no_answer | spoke_to_occupant |
  owner_identified | refused`, `projects.ts:344`). This is the discovery
  reality — but it's a separate, low-surface module, not woven into the
  workflow.
- **Define the תמורה (what owners get).** Modeled additively on the project:
  `existingUnits / plannedUnits / extraAreaSqm / relocationType
  (none|rent_comp|alt_housing) / relocationNotes` (`projects.ts:54–68`). This
  is the *offer*, and it is the #1 thing owners negotiate — yet it lives as
  flat project columns with no per-owner deal terms.
- **Set the consent target.** `targetSignaturePct` defaults from project type
  (all three → 66, `PROJECT_TYPE_DEFAULT_CONSENT_PCT`,
  projects-type-consent-default.spec.ts) plus optional staged
  `signatureMilestones` (`projects.ts:49`).

### 1.2 `gathering_signatures` — the daily grind (the heart of the product)
This is where the developer/agent lives for months. The loop per apartment:
**reach the owner → meet → present תמורה → handle objection → send the link →
chase → collect signature → repeat for the co-owners.** EMAPP's primitives:
- Per-apartment `status`: `pending | contacted | meeting | signed | refused |
  unreachable` (`_enums.ts:26`). `statusChangedAt` + `lastContactAt`
  (`projects.ts:140–141`) track movement but are not surfaced.
- A **signature campaign** fans one project document out to all active owners
  (`signature-campaign.controller.ts`), or per-owner / bulk requests
  (`signature-requests.service.ts`). Each request mints a single-use JWT
  (`jti`, 7-day TTL, `signature-token.service.ts:36`), delivered by
  email/SMS/WhatsApp (`signature-link-delivery.ts`), resident signs an SVG at
  `/sign/[token]`, atomic single-use UPDATE flips `pending → signed`.
- **Resend / re-mint** exists (`resend()`, line 748 — fresh jti + new 7-day
  expiry, old link dies). This is the chase primitive. But there is **no
  reminder scheduler, no "expiring in 2 days" surface, no chase cadence**.

### 1.3 `approved` — threshold met, deal proceeds to the authority
The developer takes the signed consents (often a specific legal majority, see
§3) to the וועדה המקומית / רשות. EMAPP marks the project `approved` but does
not model the *permit/הליך* clock that starts here, nor the document set
(היתר, תב"ע) the authority needs.

### 1.4 `in_construction` → `completed`
Residents vacate (פינוי), demolition, build, hand-back. EMAPP's
`relocationType` is the only hook; there's no per-owner relocation tracking
(temp-housing address, rent-comp payments, hand-back date) — likely out of MVP
scope but worth noting it falls off a cliff after `approved`.

### 1.5 `cancelled` — the deal dies
No cancellation-reason field; just a status. Losing *why* a deal died is a
real BI loss for a multi-project developer.

---

## 2. The hierarchy + entity reality (and how EMAPP models it)

```
organization (the developer's firm — tenant boundary, RLS via org_id GUC)
  └─ project            (type: tama38_1 | tama38_2 | pinui_binui | other)
       │  developerName/CompanyId, תמורה fields, block/parcel, targetSignaturePct,
       │  signatureMilestones, status
       └─ building       (address, city, block/parcel/subparcel, aptCount,
            │             source_parcel_setup_id provenance)
            ├─ buildingSection  (D.39 — entrance × kind(residential|office|
            │                    retail|mixed) × floors × unit_count × own גוש/חלקה)
            └─ apartment  (number, floor, sizeSqm vs registered areaSqm,
                 │         rooms, unitType(apt|shop|office|mixed), entrance,
                 │         status, statusChangedAt, lastContactAt, notes)
                 ├─ ownership  (→ owner; ownershipPct AND exact fraction
                 │              share_num/den; relationship: owner|renter;
                 │              role free-text; started/ended_at history)
                 └─ discoveryRecord (field-visit log: not_visited..owner_identified|refused)
owner (org-scoped, ENCRYPTED name/national_id/phone + HMAC hashes; SHELL-able;
        erasable/crypto-shred; soft-deletable)
  └─ signature_request (→ document + owner; jti, status pending|signed|
       │                 cancelled|expired; 7-day expiry; created/signed/cancelled)
       └─ signature      (encrypted SVG blob, documentHash, signerIp/UA,
                          authMethod, signedAt — forensic, immutable)
```

**Non-obvious modeling facts the redesign must respect:**

- **A signature is against a *document*, not against an apartment or a
  project.** Consent is reconstructed by the join "owner has a `signed`
  signature_request on a document whose `project_id` = this project"
  (`projects.service.ts:386–393`). So "did apartment 7 consent" = "do ALL its
  active `relationship='owner'` owners each have such a signed request."
- **Renter vs owner is a first-class discriminator** (`ownerships.relationship`,
  D.25). Renters carry `ownership_pct = 0`, are excluded from the 100% sum
  trigger, and **do not sign**. A redesign that shows "signatures" must never
  count renters.
- **Multiple owners per apartment is the norm, not the exception.** The
  apartment is "consented" only when *every* co-owner signs. A couple owning
  50/50, or 4 heirs of an עיזבון at 1/4 each, are each a separate `owner` with
  a separate `ownership` row and a separate signature_request. The exact
  fraction (`share_numerator/denominator`, e.g. 17/240) is preserved precisely
  to handle messy real-registry splits.
- **`ownership` is temporal** (`started_at`/`ended_at`): an apartment can change
  hands mid-deal; the unique index is on *active* (`ended_at IS NULL`) rows.
- **Owner SHELL** (no name/national_id yet) is legitimate state — the board must
  not treat "owner with no PII" as broken data; it's "we know the apartment,
  we're still identifying who owns it."

---

## 3. Threshold & legal-counting reality — the BIGGEST correctness gap

EMAPP currently computes **one** number: `apartmentsConsented / totalApartments`
as a percentage, compared to a single `targetSignaturePct` (default 66 for all
three types). The real legal test is **multi-dimensional**, and the developer
genuinely needs to see each dimension:

### 3.1 What the law actually requires (domain knowledge)
- **תמ"א 38/1 (חיזוק — strengthen-in-place):** the threshold is on the
  **building's bylaws-amendment majority** — historically a special majority of
  apartment owners *and* of the registered common-property share. The reform
  lowered/clarified thresholds over the years; the "two-thirds" rubric the app
  uses (66) is a reasonable *headline* but legally it's "X% of the *רכוש
  המשותף* share-weighted owners," not "X% of apartments fully signed."
- **תמ"א 38/2 (הריסה ובנייה — demolish & rebuild):** higher bar than 38/1
  because it dissolves the existing בית משותף; counted on apartments **and**
  ownership share.
- **פינוי-בינוי:** governed by its own statute (חוק פינוי ובינוי) with a
  **special majority** that is computed **per-מתחם/per-building** and on
  **ownership share of each apartment**, plus rules for a דייר סרבן
  (recalcitrant owner) — a holdout below the majority can be sued for
  damages. Critically, the count is **NOT** "whole apartments"; a single
  hold-out co-owner in a 4-owner apartment changes the *share* math, not just a
  binary apartment flag.

### 3.2 The three counting bases the board should show
For a real developer, "where do I stand legally" needs:
1. **By apartment heads** — how many apartments are fully consented (what
   EMAPP has). Useful but insufficient.
2. **By ownership share (רכוש משותף)** — the share-weighted %, computed from
   `ownership_pct` / the exact `share_numerator/denominator` of each *signed*
   owner. **EMAPP stores this precisely and never uses it.** This is the legal
   number for most tracks.
3. **By building / מתחם** — per-building progress, because פינוי-בינוי and
   38/2 majorities are often per-building, and a developer chases one building
   at a time. EMAPP has the building hierarchy but `signatureProgress` is
   **project-aggregate only** — there is no per-building progress endpoint.

### 3.3 Concrete consequence
A project can read "64% of apartments" while the **share-weighted** consent is
already past the legal majority (because the signed apartments are the larger
ones), or vice-versa. The app cannot currently tell the developer which. The
`metThreshold` boolean (`projects.service.ts:421`) compares the binary
apartment-% to the target and can be **legally wrong in both directions.**

---

## 4. The human dynamics the UI must support (and what's missing)

This is the layer the North-Star cares about most and the schema models least.

### 4.1 The holdout / סרבן and objection TYPES
A developer's day is triage of *why people haven't signed*. The objection type
dictates the play:
- **Price / תמורה** — wants a bigger apartment, more area, a specific floor,
  parking, or cash. → negotiation, often per-owner deal terms.
- **Distrust** — doesn't believe the developer will deliver / fears delays.
  → needs references, track record, guarantees (ערבויות).
- **Attachment / age** — elderly owner, doesn't want to move (relocation fear).
  → relocation reassurance, alt-housing.
- **Disputes** — co-owner conflict, divorce, inheritance fight (עיזבון), a
  contested ownership. → blocked until the *owners* resolve it; not the
  developer's to fix but he must TRACK it.
- **Strategic holdout (סרבן)** — waiting for everyone else to sign to extract a
  premium. → the legal דייר-סרבן path eventually.
- **Unreachable** — abroad, deceased with unlocated heirs, wrong contact.
  → discovery / skip-trace, not negotiation.

**EMAPP today:** the *only* place this lives is `apartment_status` collapsing
all of it into `refused | unreachable`, plus free-text `notes` on the
apartment/owner. There is **no structured objection-reason, no per-owner status,
no "next action / next contact date", no contact-attempt log.** The
`discovery_records` module captures the *find-the-owner* half but not the
*win-the-owner* half. → This is the **#1 backend follow-up** the North-Star
predicted ("owner objection/status field — a small slice; do NOT fake it").

### 4.2 Multiple owners who must ALL sign
Covered in §2 — the board must render an apartment as "2 of 3 signed · waiting
on רחל" not just "partial". `signatureProgressApartments`
(`projects.service.ts:456`) already returns ternary
`consented | partial | none` + `totalOwners`/`signedOwners` counts per
apartment — good raw material, but it returns **no owner identity** (by design,
PII), so the FE can't say *who* is the holdout without a second authorized
call. The "אורי דירה 7 לא חתם" line the North-Star wants needs a PII-gated
per-owner status feed.

### 4.3 Inheritance / deceased / estates (עיזבון)
Real and common. The registry names a dead owner; consent must come from heirs
or an estate administrator (מנהל עיזבון), sometimes via צו ירושה. EMAPP can
represent heirs as multiple owners on the apartment, and SHELL owners for
unknown heirs — but there is **no "estate / deceased / requires probate" flag**,
so this critical blocker is invisible to the board (it hides inside `notes`).

### 4.4 Representatives / lawyers / power-of-attorney
An owner often signs via עו"ד or a ייפוי-כוח (POA), or all communication routes
through a representative. EMAPP's `ownerships.role` is a free-text column (values
like 'primary') and there's **no representative/contact-of-record concept**:
no "send the link to the lawyer, not the 90-year-old owner", no POA document
link. The signature_request always targets the `owner` directly.

### 4.5 Leasing agent vs developer vs org roles
The 6 EMAPP roles (Manager/Agent/Viewer/Contractor/Tenant/Provider Admin)
map to the *firm's* internal structure. The **Agent** is the boots-on-ground
person chasing signatures (assigned projects only, capability-gated,
`memberships.capabilities`). The redesign's "my work today" view is the Agent's
home (BACKLOG notes AgentHome is scoped — "המשימות שלי"). The **Tenant** portal
is the owner's self-service view (best-designed screen per BACKLOG). The
**Contractor** is the external builder seeing structural progress only (no PII).
This all exists; the gap is workflow choreography, not roles.

---

## 5. Deadlines & time pressure (almost entirely unmodeled)

A multi-project developer lives on clocks. EMAPP's time data:
- `signature_requests.expires_at` — 7-day link TTL
  (`signature-token.service.ts:36`), with `expired` status (migration 0063).
  **But nothing surfaces "expiring soon" or auto-reminds; a link just dies
  silently.** A developer loses momentum every time a link lapses unnoticed.
- `apartments.lastContactAt` + `statusChangedAt` — the raw material for "no
  movement in N days" / stale-lead reporting (the schema comment at
  `apartments.service.ts:258` literally says "used for stale-lead reporting
  later"). **Not yet surfaced anywhere.**
- `tasks.dueAt` (soft deadline) + `scheduledAt` (calendar event) + ICS invites
  to owners (`task_external_attendees`) — the meeting/follow-up scheduler
  exists. This is the closest thing to a "chase cadence" engine, but it's a
  generic task/calendar, not wired into the signature loop.

**Unmodeled real clocks:** permit/היתר windows, תב"ע approval timelines, the
תמ"א-38 sunset/successor-track deadline (the `'other'` enum + `type_label` was
added forward-compat for exactly this), contractor commitment dates, and
financing/ערבות expiries. These may be out of MVP scope but are the *pressure*
that makes the developer open the app at 7am.

### The daily/weekly rhythm the home must serve (North-Star principle 3 & 4)
A developer with 20 projects opens the app to answer: *"Which 3–5 deals need me
today, and what's the single next action on each?"* The signals to triage on —
all derivable from existing data, none currently surfaced:
- **Stalled:** `max(lastContactAt/statusChangedAt)` old → "אין תנועה 18 יום".
- **Momentum:** signatures gained this week (signature_requests `signedAt`
  deltas) → "זז יפה, +2 השבוע".
- **Expiring:** pending signature_requests with `expires_at` < 48h.
- **Almost-there:** `consentedPct` (or share-%) within a hair of target →
  "כמעט שם · חסרה חתימה אחת".
- **Blocked:** apartments `refused`/`unreachable` or with an (unmodeled)
  objection/estate flag → "3 בעלים מתנגדים".

---

## 6. Prioritized gap list (real-workflow need → does EMAPP model it?)

Legend: ✅ modeled & usable · 🟡 data exists but unused/unsurfaced · ❌ absent.

| # | Real-workflow need | Modeled? | Where / what's missing |
|---|---|---|---|
| **P0 — correctness & the "why"** | | | |
| 1 | **Share-weighted (רכוש משותף) consent %**, not just apartment-count | 🟡 | `ownership_pct` + exact `share_num/den` stored (`projects.ts:288–299`) but `signatureProgress` uses binary apartment count only (`projects.service.ts:419`). `metThreshold` can be legally wrong. Add a share-weighted progress calc. |
| 2 | **Per-building / per-מתחם progress** (פינוי-בינוי & 38/2 count per building) | ❌ | Hierarchy exists; `signatureProgress` is project-aggregate only. No per-building endpoint. |
| 3 | **Objection reason / holdout type** per owner/apartment | ❌ | Only `apartment_status` (`refused`/`unreachable`) + free-text `notes`. North-Star's "3 בעלים מתנגדים" cannot be truthful. The flagged small backend slice. |
| 4 | **Per-owner signature status surfaced WITH identity** ("דירה 7 — חסר אורי") | 🟡 | `signatureProgressApartments` gives ternary + counts, **no owner identity** (PII by design). Needs a PII-gated per-owner holdout feed. |
| 5 | **Next-action / next-contact-date per apartment-owner** | ❌ | Tasks exist but aren't tied into the signature loop. No "next step" on the board. |
| **P1 — momentum & time** | | | |
| 6 | **Stale-lead surfacing** ("אין תנועה N יום") | 🟡 | `lastContactAt`/`statusChangedAt` captured (`projects.ts:140`) explicitly "for stale-lead reporting later" — never surfaced. |
| 7 | **Momentum / velocity** ("+2 השבוע") | 🟡 | Derivable from `signature_requests.signedAt`; no endpoint/widget. |
| 8 | **Expiring-link surfacing + reminders** | 🟡 | `expires_at` + `expired` status + `resend()` exist; no "expiring soon" list, no auto-nudge. Links die silently. |
| 9 | **Home triage-by-exception across many projects** | ❌ (product) | All data exists; no "the 5 that need you now" aggregate. North-Star principle 3. |
| **P2 — human edge-cases** | | | |
| 10 | **Estate / deceased / requires-probate (עיזבון, צו ירושה)** flag | ❌ | Heirs representable as multiple/SHELL owners, but no blocker flag; hides in `notes`. |
| 11 | **Representative / lawyer / POA (ייפוי-כוח) contact-of-record** | ❌ | `ownership.role` is free-text; signature_request always targets the owner directly. No "deliver link to representative." |
| 12 | **Per-owner deal terms (תמורה negotiation)** | ❌ | תמורה is flat project-level columns (`existingUnits`/`plannedUnits`/`extraAreaSqm`/`relocationType`). Price is the #1 objection but per-owner terms aren't modeled. |
| 13 | **Cancellation reason** (why a deal died) | ❌ | `cancelled` status only; BI loss for multi-project developer. |
| **P3 — lifecycle tails (likely post-MVP)** | | | |
| 14 | Permit/regulatory/contractor clocks (היתר, תב"ע, סטטוטרי) | ❌ | `'other'`+`type_label` is forward-compat for track changes; no statutory clock. |
| 15 | Per-owner relocation tracking (temp housing, rent-comp, hand-back) | ❌ | `relocationType` headline only; falls off after `approved`. |

**The redesign's center of gravity:** items **1–9** turn the existing correct
structure into the calm, exception-triage, "movie-not-photo" product the
North-Star describes. Items **1, 2, 6, 7, 8** are *mostly already in the data* —
they need aggregation endpoints + surfacing, not new capture. Item **3** (and
4-with-identity) is the one genuinely new backend slice the North-Star already
sanctioned; until it ships, the "why" line should be omitted, never faked.

---

## 7. Key file references (for the implementing slices)

- Consent counting (the binary-per-apartment calc to extend with share-weight):
  `apps/api/src/modules/projects/projects.service.ts` `signatureProgress`
  (~L355–435) and `signatureProgressApartments` (~L456+).
- Threshold defaults: `packages/shared-types/src/project.ts`
  `PROJECT_TYPE_DEFAULT_CONSENT_PCT` (all three = 66); spec
  `projects/projects-type-consent-default.spec.ts`.
- Hierarchy + exact-share model: `packages/db/src/schema/projects.ts`
  (`projects`, `buildings`, `buildingSections`, `apartments`, `owners`,
  `ownerships`, `discoveryRecords`).
- Signature loop: `packages/db/src/schema/artifacts.ts` (`signatures`,
  `signatureRequests`); `apps/api/src/modules/signatures/*`
  (`signature-requests.service.ts` create/bulk/resend, `signature-campaign.*`,
  `signature-token.service.ts` 7-day TTL, `signature-link-delivery.ts`).
- Apartment status / contact timestamps: `_enums.ts` `apartmentStatusEnum`;
  `apps/api/src/modules/apartments/apartments.service.ts` (status transitions,
  `lastContactAt`/`statusChangedAt`).
- Discovery (find-the-owner): `apps/api/src/modules/discovery/*`;
  `discoveryRecords` in `projects.ts`.
- Scheduling/chase primitives: `collaboration.ts` (`tasks`, `taskAssignees`,
  `taskExternalAttendees` ICS), calendar modules.
- Roles/capabilities: `tenancy.ts` `memberships.capabilities` (Agent matrix).
