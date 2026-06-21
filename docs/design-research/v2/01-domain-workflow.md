# 01 — Domain & Legal-Workflow (v2): the real יזם signature-collection job, grounded in EMAPP

> **Council second pass — Domain & legal-workflow seat.** The v1 doc
> (`docs/design-research/01-domain-workflow.md`) was already well-grounded; this
> v2 *verifies* its central claims line-by-line against the real schema, services,
> wire types, and pixels, then goes deeper on the one thing a developer's TRUST
> hinges on: **how consent is counted, and how the law actually counts it.**
>
> Everything below is cited to real files. Where the law is genuinely uncertain,
> or where a choice belongs to the product owner (not the council), it is flagged
> **[OWNER DECISION]** or **[LEGAL — CONFIRM]**. Nothing is invented.

---

## 0. Executive summary (read this if nothing else)

1. **EMAPP counts consent in a way the law does not recognize, and the gap is
   load-bearing.** The product's single consent number is
   `apartmentsConsented / totalApartments` — a *binary, equal-weight,
   per-apartment headcount* (`apps/api/src/modules/projects/projects.service.ts`,
   `signatureProgress`, L363–435). The Israeli urban-renewal majority is a
   **share-weighted** test on the registered common-property שיעור
   (`רכוש משותף`), and for פינוי-בינוי it has a **per-building** component too.
   The exact registered share is **stored, integrity-guaranteed, and never read
   by any consent calc.**

2. **The exact share is not just stored — the DB GUARANTEES it sums to exactly
   1 per apartment.** `migrations/0065_ownership_share_fraction.sql` installs a
   deferred constraint trigger that rejects any commit where an apartment's
   active-owner fractions don't sum to exactly the whole (integer
   cross-multiplication, no float drift). So a share-weighted consent % would be
   computed on data that is *already legally clean*. The only missing piece is
   the SELECT that reads it.

3. **A project can be legally past its majority while EMAPP shows it short — or
   the reverse.** Because the signed apartments may be the large ones (or the
   small ones), `consentedPct` and the `metThreshold` boolean
   (`projects.service.ts` L419–421) can be wrong **in both directions**. The FE
   renders this directly to the developer as "X מתוך Y דירות הסכימו · Z% · יעד
   W%" (`projects/[id]/_components/signature-progress-board.tsx` L48–64). This is
   the single most important correctness fix in the whole redesign, because it is
   the number the developer will *check against his lawyer's number* — and the
   day they disagree, he stops trusting the app.

4. **The "default 66%" is a percentage with no denominator defined.** `66` is
   stamped from project type (`PROJECT_TYPE_DEFAULT_CONSENT_PCT`,
   `packages/shared-types/src/project.ts` L62–71) but the code measures it
   against an apartment headcount, while the statute means it as a share of
   owners *and* of common property. The number is right; the thing it's measured
   against is wrong.

5. **The redesign must surface the legal test as the developer's lawyer sees it
   — by שיעור (share), by ראשים (heads), and by building — not one blended bar.**
   The data for heads and share exists today; per-building needs an aggregation
   endpoint (the hierarchy is already there). The human "why" (objection type,
   estate/holdout, representative) is genuinely *not in the schema* and must be
   OMITTED until a small additive backend slice lands — never faked
   (North-Star: "do NOT fake it").

**[OWNER DECISION — the one that gates the redesign]:** *Which consent basis is
the developer's primary legal number?* (a) share-weighted % of registered
ownership (`רכוש משותף`) — the legal default for most tracks; (b) per-building
share for פינוי-בינוי / 38-2; (c) keep apartment-headcount as the headline.
The redesign should show **all three as plain-language lines** with the
legally-correct one as the headline, but the *threshold gate* (`metThreshold`,
the green/amber bar, "almost there") must be computed on the basis the owner
designates. Until that is chosen, the green bar is a legal claim the app cannot
back. See §3.5.

---

## 1. The real end-to-end workflow a יזם runs (verified against the model)

EMAPP's status enum is the developer's coarse internal pipeline label:
`planning | gathering_signatures | approved | in_construction | completed |
cancelled` (D.18 LAW, `packages/db/src/schema/_enums.ts` L17–24). The real job
*inside* each phase:

### 1.1 `planning` — assemble the deal before any owner is asked
- **Pull the נסח טאבו for each חלקה** to learn who legally owns what fraction.
  Modeled: `tabuExtractions` + `tabuExtractionRows` (the parse output, one row
  per owner found, PII pgcrypto-encrypted, with `share_numerator/denominator`
  and a per-row `confidence`) — `packages/db/src/schema/artifacts.ts` L375–449.
  Auto-lookup of the parcel itself (GovMap/מפ"י) is **owner-deferred**
  (memory: *parcel lookup deferred to post-prod*); manual entry is the path.
- **Reconcile registry vs reality.** The נסח names a *registered* owner who may
  be deceased, sold informally, be a company, or be an estate (עיזבון) with
  heirs. Modeled as: the **owner SHELL** (nullable `name_encrypted` /
  `national_id_encrypted`, `schema/projects.ts` L223–237) and
  **`discovery_records`** (a field worker records `not_visited | no_answer |
  spoke_to_occupant | owner_identified | refused`, `schema/projects.ts`
  L344–375). Real, but a low-surface side module — not woven into the signature
  loop.
- **Define the תמורה (what owners get).** Flat project columns:
  `existingUnits / plannedUnits / extraAreaSqm / relocationType
  (none|rent_comp|alt_housing) / relocationNotes` (`schema/projects.ts` L54–68).
  This is the *offer* and the #1 negotiation lever — yet it is project-level,
  with **no per-owner deal terms**.
- **Set the consent target.** `targetSignaturePct` defaults from type (all four
  → 66, `PROJECT_TYPE_DEFAULT_CONSENT_PCT`) with optional staged
  `signatureMilestones` (`schema/projects.ts` L45–49). The default is applied at
  create (`projects.service.ts` L600–603).

### 1.2 `gathering_signatures` — the daily grind (the heart of the product)
The per-apartment loop: **reach owner → meet → present תמורה → handle objection →
send link → chase → collect signature → repeat for every co-owner.** Primitives:
- Per-apartment `status`: `pending | contacted | meeting | signed | refused |
  unreachable` (`_enums.ts` L26–33), with `statusChangedAt` + `lastContactAt`
  (`schema/projects.ts` L140–141) captured but **not surfaced**.
- A **signature campaign** fans one project document to all active owners
  (`signatures/signature-campaign.controller.ts`), plus per-owner / bulk
  requests (`signatures/signature-requests.service.ts`). Each mints a single-use
  JWT (`jti`, ~7-day TTL), delivered by email/SMS/WhatsApp
  (`signature-link-delivery.ts`); the resident signs an SVG at `/sign/[token]`;
  an **atomic single-use UPDATE** flips `pending → signed`
  (`signatures/public-sign.service.ts` L270–301 — this is the security heart).
- **Resend / re-mint** exists (fresh `jti` + new expiry, old link dies) — the
  chase primitive. But there is **no reminder scheduler, no "expiring in 2 days"
  surface, no chase cadence**. A lapsed link dies silently.
- **[VERIFIED NEW — the "expired" status is dead]** The `signature_requests`
  status CHECK admits `pending | signed | cancelled | expired`
  (`schema/artifacts.ts` L173–176), but **nothing in the codebase ever writes
  `'expired'`.** The create/bulk dedup guards instead test `status='pending' AND
  expires_at > now()` (`signature-requests.service.ts` L315–318, L443–446) so a
  lapsed link stays `'pending'` forever with a past `expires_at`. Consequence for
  the redesign's chase loop: there is **no queryable "expired" set** to surface or
  auto-nudge — the "expiring soon / expired" triage list the North-Star wants must
  be derived from `expires_at` vs `now()` over `status='pending'` rows, OR a small
  sweep that flips lapsed rows to `'expired'` must be added. This is the central
  doctrine's "act in the background and notify" loop, and the status field it
  would naturally hang off is **present but unused**.

### 1.3 `approved` — threshold met, deal proceeds to the authority
The developer takes the signed consents (a specific legal majority) to the
וועדה המקומית / רשות. EMAPP flips `approved` but models neither the permit/היתר
clock that starts here nor the authority's document set.

### 1.4 `in_construction` → `completed`
Residents vacate (פינוי), demolition, build, hand-back. `relocationType` is the
only hook; **no per-owner relocation tracking** (temp address, rent-comp
payments, hand-back date). Likely post-MVP, but the workflow falls off a cliff
after `approved`.

### 1.5 `cancelled` — the deal dies
A bare status, **no cancellation reason** — a real BI loss for a multi-project
developer who wants to learn why deals die.

---

## 2. The hierarchy & entity reality (verified)

```
organization (the developer's firm — tenant boundary, RLS via org_id GUC)
 └─ project            type: tama38_1 | tama38_2 | pinui_binui | other
      │  developerName/CompanyId, תמורה fields, block/parcel, targetSignaturePct,
      │  signatureMilestones, status
      └─ building       address, city, block/parcel/subparcel, aptCount,
           │            source_parcel_setup_id (provenance)
           ├─ buildingSection  D.39 — entrance × kind(residential|office|retail|
           │                   mixed) × floors × unit_count × own גוש/חלקה
           └─ apartment  number, floor, sizeSqm vs registered areaSqm, rooms,
                │         unitType(apt|shop|office|mixed), entrance, status,
                │         statusChangedAt, lastContactAt
                ├─ ownership  → owner; ownershipPct (derived) AND the canonical
                │             exact fraction share_num/den; relationship:
                │             owner|renter; role free-text; started/ended_at
                └─ discoveryRecord  field-visit log
owner (org-scoped; name/national_id/phone ENCRYPTED + HMAC hashes; SHELL-able;
       crypto-shred erasable; soft-deletable)
 └─ signature_request  → document + owner; jti; status pending|signed|cancelled|
      │                 expired; ~7-day expiry
      └─ signature      encrypted SVG blob, documentHash, signerIp/UA, authMethod,
                        signedAt — forensic, immutable
```

**Non-obvious modeling facts the redesign MUST respect (all verified):**

- **A signature is against a *document*, never directly against an apartment or
  project.** Consent is *reconstructed* by the join "this owner holds a `signed`
  `signature_request` on a `document` whose `project_id` = this project"
  (`projects.service.ts` L386–393). "Did apartment 7 consent?" therefore means
  "do **all** its active `relationship='owner'` owners each hold such a signed
  request?" (L375–399).
- **Renter vs owner is a first-class discriminator** (`ownerships.relationship`,
  D.25). Renters carry `ownership_pct = 0`, are **excluded** from the 100% sum
  trigger and from every consent/owner count (the trigger and every consent
  query filter `relationship = 'owner'`), and **do not sign**. Any "signatures"
  surface that counts renters is a bug.
- **Multiple owners per apartment is the norm.** A couple at 50/50, four heirs of
  an עיזבון at 1/4 each — each is a separate `owner` + `ownership` row + separate
  `signature_request`. The exact fraction (`share_numerator/denominator`, e.g.
  17/240) is preserved precisely for messy real-registry splits. The apartment
  is "consented" only when **every** co-owner signs.
- **`ownership` is temporal** (`started_at`/`ended_at`); an apartment can change
  hands mid-deal. All consent queries scope to `ended_at IS NULL` (active).
- **Owner SHELL is legitimate state**, not broken data: "we know the apartment,
  we're still identifying who owns it." The board must render it as *discovery
  in progress*, never as a missing-signature gap.

---

## 3. Threshold & legal-counting reality — THE correctness gap (verified end-to-end)

### 3.1 What EMAPP actually computes today (traced DB → service → wire → pixel)

The **only** consent number the product produces:

```
consentedPct = round( apartmentsConsented / totalApartments * 100 )
metThreshold = targetSignaturePct != null && consentedPct >= targetSignaturePct
```

- **DB / service** — `projects.service.ts` `signatureProgress` (L363–435):
  `apartmentsConsented` = count of apartments where
  `active_owners > 0 AND active_owners = signed_owners` (L398–399). It is a
  **binary, equal-weight headcount of apartments**. The per-apartment
  drill-down (`signatureProgressApartments`, L456–526) returns the same logic as
  ternary `consented | partial | none` + raw `totalOwners`/`signedOwners`
  counts — **no owner identity** (PII by design).
- **Home KPIs** — `orgStats` (L537–581) counts `signature_requests` by status
  (`signed`/`pending`), i.e. raw *signature rows*, not apartments and not share.
- **Project-list stats** — `statsSubqueries` (L97–124):
  `signaturesPending`/`signaturesSigned` are again raw `signature_requests`
  counts.
- **Wire / VM** — `SignatureProgressViewModel`
  (`apps/web/src/models/signature-progress.vm.ts`) literally documents the field
  as *"Apartments where EVERY active owner has signed (binary per apartment)"*
  (L13) and `consentedPct` as *"round(apartmentsConsented / totalApartments *
  100)"* (L20).
- **Pixel** — `signature-progress-board.tsx` renders
  **"X מתוך Y דירות הסכימו · Z% · יעד W%"** (L48–64) with a green/amber bar driven
  by `barColor` = green once `metThreshold` (VM L26–27). The developer reads a
  green bar as *"I have the legal majority."*

**The chain is internally consistent and entirely apartment-headcount based.
Nowhere in any consent path is `share_numerator/denominator` or `ownership_pct`
read.** (Confirmed by grep across `apps/api/src/modules/**`: every hit of
`shareNumerator`/`ownershipPct` outside specs is in `ownerships.service.ts` /
`portal.service.ts` for *display* of a co-owner's "1/3" beside their row, or in
the `replaceApartmentOwnershipSet` write path — never in a progress/threshold
calc.)

### 3.2 What the law actually requires (domain knowledge — [LEGAL — CONFIRM] where noted)

Israeli urban-renewal consent is **not** "what fraction of apartments fully
signed." It is a **special majority computed on registered ownership share**,
and the basis differs by track:

- **תמ"א 38/1 (חיזוק — strengthen-in-place).** Historically the lowest bar
  (a building-bylaws / strengthening-works majority). The works are framed as an
  amendment to the בית-משותף arrangements; the count runs on **owners weighted by
  their registered share in the רכוש המשותף**, not a flat apartment headcount.
- **תמ"א 38/2 (הריסה ובנייה — demolish & rebuild).** Higher bar than 38/1 because
  it dissolves the existing בית-משותף and re-registers. Counted on apartment
  owners **and** their ownership share.
- **פינוי-בינוי (evacuation-rebuild).** Its own statute
  (חוק פינוי ובינוי / חוק הרשות הממשלתית להתחדשות עירונית). The special majority
  is computed on **ownership share of each apartment** AND has a
  **per-מתחם / per-building** component (a single building inside a complex has
  its own threshold), plus the דייר-סרבן (recalcitrant-owner) machinery: a
  holdout below the majority can be sued for the damage they cause the others.
  Critically, **a single hold-out co-owner in a 4-owner apartment changes the
  *share* math, not just one binary apartment flag.**

**[LEGAL — CONFIRM] the exact percentages.** The code comment in
`packages/shared-types/src/project.ts` (L38–60) records the post-2023
*חוק ההסדרים תשפ"ג* harmonisation that lowered the demolish-rebuild tracks from
80% toward two-thirds, and **explicitly flags that sources vary between 66% and
67%** for "two-thirds" and that pre-2023 80% agreements may grandfather. The
council should treat the *number* as owner-/lawyer-confirmable config (it already
is — `PROJECT_TYPE_DEFAULT_CONSENT_PCT` + per-project override + per-org
`ConsentSettingsSchema`, `shared-types/src/org-settings.ts` L118–125). **The
council's concern is the *denominator*, not the percentage.**

**[VERIFIED NEW — config gap] The per-org consent default is un-overridable for
`'other'`-type projects.** `ConsentSettingsSchema` (`org-settings.ts` L118–125)
defines keys for **only three** types — `tama38_1 / tama38_2 / pinui_binui` — but
the project-type enum has **four** values (`'other'` was added in migration 0062,
`_enums.ts` L9–14). So an `'other'`-track project's create-time consent default
falls through to the hardcoded `PROJECT_TYPE_DEFAULT_CONSENT_PCT.other = 66`
(`project.ts` L70; applied at `projects.service.ts` L600–603) with **no per-org
override path**. Minor today (`'other'` is forward-compat for the post-תמ"א
successor track) but it will silently mis-default the moment a real `'other'`
project exists. A one-line additive fix (add the `other` key) — flagged so the
share-weighted slice doesn't inherit the same three-key blind spot.

### 3.3 The data is ready — the integrity is already guaranteed

The redesign does not need new capture to compute a share-weighted number:

- Every active owner ownership carries `share_numerator / share_denominator`
  (`schema/projects.ts` L289–299), and `ownership_pct` is a derived 2-decimal
  display value kept in sync on every write.
- **`migrations/0065_ownership_share_fraction.sql` installs a DEFERRED CONSTRAINT
  TRIGGER (`trg_ownerships_sum_check`) that REJECTS any commit where an
  apartment's active `relationship='owner'` fractions don't sum to *exactly* 1**
  — computed by integer LCM cross-multiplication, with a numeric fallback, no
  float drift (L72–215). A faithful thirds split (1/3+1/3+1/3) is accepted; a
  9000/10000 split is rejected.
- This means: **for every apartment, the signed owners' shares are a clean,
  exact subset of a denominator the DB guarantees sums to 1.** A share-weighted
  consent % is a pure read over trustworthy data. (`ownerships-fidelity.spec.ts`
  and `share-fraction-product-path.spec.ts` exercise this.)

### 3.4 The three counting bases the board SHOULD show (plain Hebrew, not a blended bar)

For "where do I stand legally," a real developer's lawyer looks at each of:

1. **לפי שיעור הבעלות / רכוש משותף (by ownership share)** — the share-weighted %:
   `Σ(signed owners' share) / Σ(all active owners' share, = 1 per apartment, so =
   apartments)`. **This is the legal number for most tracks. EMAPP stores it
   precisely and never computes it.** Derivable today from the exact fraction.
2. **לפי ראשי דירות (by apartment heads)** — how many apartments are fully
   consented. *This is what EMAPP has.* Useful as a secondary, intuitive line
   ("23 דירות מתוך 40 חתמו במלואן"), but legally insufficient alone.
3. **לפי בניין / מתחם (by building)** — per-building progress, because
   פינוי-בינוי and 38/2 majorities are often per-building and the developer
   chases one building at a time. **EMAPP has the building hierarchy but
   `signatureProgress` is project-aggregate only — no per-building endpoint.**
   This needs a small additive aggregation slice (the JOIN already exists in
   `signatureProgress`; it just needs a `GROUP BY building`).

The North-Star's "plain Hebrew, numbers serve words" principle fits this exactly:
the headline should read like a sentence the developer would say to his lawyer —
e.g. *"68% מהבעלות חתמה · עברת את הרוב הדרוש (66%)"* with *"23 מתוך 40 דירות"* as
the supporting head-count line, and a per-building breakdown one tap deeper
(progressive disclosure / North-Star principle 1).

### 3.5 The concrete consequence (why trust breaks without this)

A project can read **"64% of apartments"** while the **share-weighted** consent
is already **past** the legal majority (the signed apartments are the larger
ones), or read a comfortable green bar while it is legally **short** (the signed
apartments are small studios and the two un-signed פנטהאוזים carry most of the
share). `metThreshold` (`projects.service.ts` L421) — the boolean that turns the
bar green and will eventually drive "almost there" / "you can file" — can be
**legally wrong in both directions.** The first time the developer's lawyer says
"you're not actually at majority yet" while the app shows green, the app is dead
to him. This is the trust fulcrum of the entire product.

---

## 4. The domain "truths" the redesign must honor for the developer to TRUST it

These are the non-negotiables a domain-literate developer will judge the app by:

1. **Consent is share-weighted, and the app must say which basis it's showing.**
   Never present one bare "%" without naming its denominator. Show
   *לפי שיעור הבעלות* as the headline; *לפי ראשי דירות* as support; *לפי בניין*
   one tap deeper. (§3.4)
2. **An apartment with co-owners is "done" only when ALL co-owners sign.** The
   board must read "דירה 7 — 2 מתוך 3 חתמו" not a binary tick. The raw counts
   already exist (`signatureProgressApartments`); the identity of the missing
   co-owner needs a PII-gated feed (§4 below / handled in the IA seat).
3. **Renters never count and never sign.** Filter `relationship='owner'`
   everywhere a "signature" or "owner" number appears.
4. **Owner SHELLs are discovery-in-progress, not gaps.** Render them as "מזהים
   בעלים" (identifying owner), distinct from "טרם חתם" (hasn't signed yet).
5. **The exact fraction is sacred (17/240 means 17/240).** Show "1/3", not
   "33.33%", where the developer is reading registry truth — the app already
   surfaces both (`ownerships.service.ts` L294–297). Rounding the legal number is
   a trust leak.
6. **A signature is forensic and immutable.** Once signed, the row pins the
   document hash, IP/UA, and timestamp (`signatures` table). The UI should convey
   permanence ("חתום · 14.6.2026") — never imply a signature can be casually
   undone.
7. **Status labels are the developer's pipeline, not the legal state.**
   `approved` is *his* internal flip, not a regulator's approval. Don't let UI
   copy imply statutory approval was granted.

---

## 5. The human "why" layer — present in the workflow, ABSENT in the schema

This is the layer the North-Star cares about most and the schema models least.
**It must be OMITTED from the redesign until a backend slice lands — faking it
would violate the North-Star and mislead a developer making legal decisions.**

- **Objection type / holdout reason.** A developer's day is triage of *why*
  people haven't signed — price/תמורה, distrust, attachment/age, co-owner
  disputes (divorce, עיזבון), strategic holdout (סרבן), unreachable. **EMAPP has
  none of this structured.** The only signal is `apartment_status` collapsing it
  all into `refused | unreachable` + free-text `notes`. The North-Star's
  "3 בעלים מתנגדים" line **cannot be truthful today.** This is the **#1 additive
  backend slice** the council should request (a small per-owner
  objection-reason + next-action enum + next-contact date).
- **Estate / deceased / requires-probate (עיזבון, צו ירושה).** Real and common;
  the registry names a dead owner; consent must come from heirs or a
  מנהל עיזבון. Representable as multiple/SHELL owners but **no blocker flag** — it
  hides in `notes`, invisible to the board.
- **Representative / lawyer / POA (ייפוי-כוח).** Owners often sign via עו"ד or a
  representative. `ownerships.role` is free-text; there is **no
  contact-of-record / "send the link to the lawyer, not the 90-year-old owner"**
  concept — the `signature_request` always targets the owner directly.
- **Per-owner deal terms (תמורה negotiation).** Price is the #1 objection, yet
  תמורה is flat *project-level* columns with no per-owner terms.

**Honest-data rule for the redesign:** the "why" line on any card must be
*derived from data that exists* (status, last-contact age, signed/total counts)
OR omitted. "אין תנועה 18 יום" is honest (from `lastContactAt`); "3 בעלים
מתנגדים" is **not** honest until the objection slice ships.

---

## 6. Prioritized gap list (real-workflow need → does EMAPP model it?)

Legend: ✅ modeled & usable · 🟡 data exists but unused/unsurfaced · ❌ absent.

| # | Real-workflow need | Modeled? | Where / what's missing |
|---|---|---|---|
| **P0 — legal correctness & trust** | | | |
| 1 | **Share-weighted (רכוש משותף) consent %** as the headline legal number | 🟡 | Exact fraction stored & DB-guaranteed to sum to 1 (`schema/projects.ts` L289–299; `migrations/0065`); **no consent calc reads it** (`projects.service.ts` L419). `metThreshold` can be legally wrong both ways. **Add a share-weighted progress calc.** |
| 2 | **Per-building / per-מתחם progress** (פינוי-בינוי & 38/2 count per building) | ❌ | Hierarchy exists; `signatureProgress` is project-aggregate only. Add a `GROUP BY building` endpoint (the JOIN is already in the existing query). |
| 3 | **Name the denominator in the UI** ("לפי שיעור הבעלות" vs "לפי דירות") | ❌ (product) | Today one bare "%" with no basis label. Pure FE/copy + the calc from #1. |
| 4 | **Objection reason / holdout type** per owner/apartment | ❌ | Only `apartment_status` + free-text `notes`. North-Star "3 בעלים מתנגדים" cannot be truthful. **The one sanctioned new backend slice.** |
| 5 | **Per-owner signature status WITH identity** ("דירה 7 — חסר אורי") | 🟡 | `signatureProgressApartments` gives ternary + counts, **no owner identity** (PII by design). Needs a PII-gated per-owner holdout feed. |
| **P1 — momentum & time (mostly already in data)** | | | |
| 6 | **Stale-lead surfacing** ("אין תנועה N יום") | 🟡 | `lastContactAt`/`statusChangedAt` captured (`schema/projects.ts` L140), never surfaced. |
| 7 | **Momentum / velocity** ("+2 השבוע") | 🟡 | Derivable from `signature_requests.signedAt`; no endpoint/widget. |
| 8 | **Expiring-link surfacing + reminders** | 🟡 | `expires_at` + `resend()` exist, BUT the `'expired'` status (CHECK-allowed, `artifacts.ts` L173–176) is **never written** — lapsed links stay `'pending'` with a past `expires_at` (`signature-requests.service.ts` L315–318). No "expiring soon" list, no auto-nudge, no queryable expired set — links die silently. The doctrine's "act in background + notify" loop must derive from `expires_at` vs `now()` or add a sweep. |
| 9 | **Home triage-by-exception across many projects** | ❌ (product) | All data exists; no "the 5 that need you now" aggregate. North-Star principle 3. |
| **P2 — human edge-cases (need new capture)** | | | |
| 10 | **Estate / deceased / requires-probate** flag | ❌ | Heirs representable as multiple/SHELL owners; no blocker flag — hides in `notes`. |
| 11 | **Representative / lawyer / POA contact-of-record** | ❌ | `ownership.role` is free-text; `signature_request` always targets the owner. |
| 12 | **Per-owner deal terms (תמורה negotiation)** | ❌ | תמורה is flat project columns; price is the #1 objection. |
| 13 | **Cancellation reason** | ❌ | `cancelled` status only; BI loss for multi-project developers. |
| **P3 — lifecycle tails (likely post-MVP)** | | | |
| 14 | Permit/regulatory/contractor clocks (היתר, תב"ע) | ❌ | `'other'`+`type_label` is forward-compat for track changes; no statutory clock. |
| 15 | Per-owner relocation tracking (temp housing, rent-comp, hand-back) | ❌ | `relocationType` headline only; falls off after `approved`. |

**Center of gravity:** items **1–3** are the *trust* fix and are *almost entirely
in the data already* — they need a share-weighted calc + a per-building GROUP BY
+ honest basis-labeling, not new capture. Item **4** is the one genuinely new
backend slice the North-Star already sanctioned; until it ships, the "why" line
is omitted, never faked. Items **6–9** turn correct structural CRUD into the
calm, exception-triage, "movie-not-photo" home the North-Star describes.

---

## 7. The exact owner-decisions to surface

1. **[OWNER DECISION — gating] Primary legal consent basis.** Make the headline
   number, and the threshold gate (`metThreshold` / green bar / "almost there"),
   compute on: (a) **share-weighted % of ownership (רכוש משותף)** — recommended
   default, legally correct for most tracks; (b) **per-building share** for
   פינוי-בינוי / 38-2; or (c) keep apartment-headcount. The council recommends
   (a) as headline with heads + per-building as supporting lines. *This blocks
   making the bar a legal claim.* (§0, §3.5)
2. **[LEGAL — CONFIRM] The exact statutory percentages** per track (66 vs 67;
   pre-2023 80% grandfathering; the per-building threshold for פינוי-בינוי). The
   *mechanism* is already config (`PROJECT_TYPE_DEFAULT_CONSENT_PCT` + per-project
   + per-org `ConsentSettingsSchema`); only the *values* need a lawyer's sign-off.
   (`shared-types/src/project.ts` L38–60 already flags this in-code.)
3. **[OWNER DECISION] Does the threshold count a *partially*-signed apartment's
   signed-share toward the share-weighted total, or only fully-consented
   apartments?** Legally, each *signed owner's* share counts individually
   (so a 2-of-3-signed apartment contributes its signed owners' share). The
   current binary model discards this. Confirm the developer wants partial-share
   credit (legally correct) vs whole-apartment-only (what exists). (§3.4 #1)
4. **[OWNER DECISION] Approve the single additive "owner objection / next-action"
   backend slice** (per-owner objection-reason enum + next-action + next-contact
   date + optional estate/representative flags). Without it the human-"why" layer
   the North-Star wants must stay blank. (§5, gap #4)

---

## 8. Key file references (for the implementing slices)

- **Consent counting to extend with share-weight + per-building:**
  `apps/api/src/modules/projects/projects.service.ts` —
  `signatureProgress` (L355–435), `signatureProgressApartments` (L456–526),
  `orgStats` (L537–581), `statsSubqueries` (L97–124).
- **Exact-share integrity guarantee (proves the data is ready):**
  `packages/db/migrations/0065_ownership_share_fraction.sql` (deferred sum
  trigger, L72–215); schema `packages/db/src/schema/projects.ts` `ownerships`
  (L278–334).
- **Threshold defaults / legal sourcing (the in-code [LEGAL — CONFIRM] notes):**
  `packages/shared-types/src/project.ts` `PROJECT_TYPE_DEFAULT_CONSENT_PCT`
  (L38–71); per-org config `packages/shared-types/src/org-settings.ts`
  `ConsentSettingsSchema` (L110–120).
- **The pixel the developer reads today (apartment-headcount bar):**
  `apps/web/src/app/[locale]/(dashboard)/projects/[id]/_components/signature-progress-board.tsx`
  (L48–64); VM `apps/web/src/models/signature-progress.vm.ts`.
- **Signature loop & forensics:** `packages/db/src/schema/artifacts.ts`
  (`signatures`, `signatureRequests`, L86–181); `apps/api/src/modules/signatures/*`
  (`public-sign.service.ts` atomic single-use UPDATE L270–301; `signature-campaign.*`;
  `signature-requests.service.ts` create/bulk/resend).
- **Co-owner share display (where "1/3" already surfaces, no consent use):**
  `apps/api/src/modules/ownerships/ownerships.service.ts` (L247–297);
  `apps/api/src/modules/portal/portal.service.ts`.
- **Discovery (find-the-owner half):** `discoveryRecords` in
  `packages/db/src/schema/projects.ts` (L344–375);
  `apps/api/src/modules/discovery/*`.
- **Tabu extraction (registry → owners + shares):**
  `tabuExtractions` / `tabuExtractionRows` in `packages/db/src/schema/artifacts.ts`
  (L375–449); `apps/api/src/modules/tabu/*`.

---

## 9. What changed from the v1 pass (so synthesis can diff)

- **Verified** the v1 "consent counted wrong" claim end-to-end (DB→service→wire→
  pixel) and located the exact line that renders it to the developer.
- **Added** the decisive grounding the v1 doc missed: `migrations/0065` already
  *guarantees* the share data sums to 1, so a share-weighted calc is a pure read
  on legally-clean data — this removes the "but is the data trustworthy?" excuse.
- **Reframed** the gap from "add a number" to **"name the denominator"** — the
  trust failure is showing one bare % whose basis the developer can't see, not
  the absence of a second metric.
- **Sharpened** the owner-decisions into four explicit, separable calls (basis,
  exact %, partial-share credit, objection slice) instead of one vague "fix
  consent."
- **Held the honest-data line:** the human-"why" layer is genuinely absent from
  the schema and must be omitted until the sanctioned slice ships.

### v2 → v2-rev (this pass) additions
- **Re-verified all v1/v2 central claims against live code** (schema, the
  `signatureProgress`/`signatureProgressApartments`/`orgStats` SQL, the
  `signature-requests.service.ts` gates, the `signature-progress-board.tsx` pixel,
  migration 0065's deferred sum trigger header) — every claim holds; nothing was
  walked back.
- **Found two NEW grounded gaps** the prior pass missed:
  (a) `ConsentSettingsSchema` (`org-settings.ts` L118–125) has only **3** keys for
  a **4**-value type enum → `'other'` projects have no per-org consent override
  (§3.2);
  (b) the `'expired'` `signature_request` status is **CHECK-allowed but never
  written** — lapsed links sit `'pending'` forever, so the chase loop has no
  queryable expired set (§1.2, gap #8). Both are small additive fixes flagged so
  the share-weighted slice doesn't inherit the same blind spots.
