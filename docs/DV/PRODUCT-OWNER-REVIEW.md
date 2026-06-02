# EMAPP — Product-Owner Review (ship decision)

> **Author's seat:** product owner of EMAPP, deciding whether to put this in
> front of a _paying_ urban-renewal developer whose field teams, residents, and
> managers will live in it daily. The bar is not "does the button work" — it is
> **"would this customer abandon us, never sign, or churn?"**
>
> **Basis:** the gated `docs/DV/results/VERIFICATION-LOG.md` (orchestrator-confirmed
> findings — trusted over individual agent files), the per-role + cross-entity
> ledgers, and my own headless walk of the manager's first five screens
> (`docs/DV/results/artifacts/owner-shots/01-04*.png`). Date: 2026-06-03.

---

## 1. SHIP / NO-SHIP verdict

**NO-SHIP for a paying customer today — but a _narrow, nameable_ no-ship, not a
"the product is broken" no-ship.** With one functional fix + one product
decision + a production-build demo, this is days from demo-ready, not weeks.

**The single biggest reason not to ship: `DV-MGR-DOCS` — the manager cannot send
any document to signature.** Signature collection IS the product. The document
picker on `/he/signature-requests/new` is empty (0 selectable docs) and the
Documents surface renders _"loading documents failed"_ — while the API is
returning 200 with 41 rows. Root cause is a taxonomy collision: the backend
stores `documents.type` as free text and seeds the _real_ urban-renewal types
(`agreement` / `blueprint` / `regulation`), but the frontend `DocumentTypeEnum`
is a disjoint generic set (`contract`/`permit`/`id_document`/`floor_plan`/…), so
the strict `z.array(DocumentSchema).parse` throws on _every_ row and TanStack
swallows it into a silent error state. A customer onboarded from a seed/import/
migration sees their entire document library vanish with no error — and cannot
reach the one workflow they bought us for. **You cannot demo signature
collection over this.**

The second reason is operational, not a feature: **you cannot reliably demo in
`next dev`.** The dev server lazy-compiles routes and 500s/deadlocks under load
— it produced two _false_ "nothing works" owner reports (agent role, provider
console) that both **refuted cleanly** on re-run, and it timed out my own
`/he/documents` capture. A live demo on the dev server will look broken even
where it isn't. **Any demo must be a production build (`next build && next
start` + `nest build`).**

**Everything else that's wrong is polish or a product decision — not a blocker.**
And the core the customer actually evaluates us on — **cross-entity sync — works
end-to-end** (see Strengths). My own visual walk supports a _good_ first
impression: clean RTL, real Heebo typography, coherent shell, PII masked at the
wire on the owners list. This looks like a finished product with three sharp
defects, not a prototype.

### Genuine strengths (state these — a loss analysis that only lists negatives isn't trusted)

- **The synchronized core works end-to-end.** All 5 cross-entity ripples sync,
  0 desync: a resident's single signature moves the manager's request status,
  the assigned agent's record view, the contractor's aggregate (+1), and the
  resident portal — confirmed _on the affected side_, reproduced ≥2×. This is
  the owner's top-priority dimension and it is real.
- **Security / authz is clean across every role.** Viewer: 20/20 writes
  BE-blocked 403, project-count invariant 13→13. Agent: least-privilege, masked
  PII, off-scope project → 404 (no leak). Contractor: PII structurally
  unrepresentable in the tier, IDOR-safe, revocation immediate. Provider:
  Access-Reason gate enforced, suspend kills the live session org-wide. **0
  authz bugs found in the entire pass.**
- **PII is masked at the wire**, not just in the DOM — confirmed visually on the
  owners list (`51•••••••`, phone `4567•••••`) and in the contractor body scan.
  For an Israeli national_id / signature product this is the trust foundation,
  and it holds.
- **The provider console functions** — onboard creates an org (201, appears in
  tenants), suspend/reactivate flip `suspendedAt`, every live tab loads real
  data. The owner's "nothing works" claim here was dev-server noise.
- **RLS tenant isolation holds** across org boundaries (Alpha/Beta separation,
  cross-audience token rejection).
- **The UI is professional.** Coherent dashboard with real KPIs, a clean 3-step
  project wizard defaulting to תמ"א 38/2, correct RTL throughout. Not jank.

---

## 2. Customer-loss-risk ranking (by business impact, not code severity)

Ranked by _what a customer does when they hit it_. Account-killers first.

### 🔴 #1 — DV-MGR-DOCS: "I can't collect a single signature." (ACCOUNT-KILLER)

**Business impact:** the customer bought a signature-collection platform and the
signature-collection workflow is unreachable from the UI. Documents page shows
"failed", the send-to-signature picker is empty. **A customer who hits this in a
trial does not subscribe; a customer who hits it post-sale escalates and
churns.** This is also a _latent prod landmine_: any org whose docs arrive via
import/migration/seed (i.e. most real onboardings) trips it silently with no
error UI. Highest business risk in the product. _Caveat that lowers prod
probability but not demo/onboarding probability:_ a doc created _through the UI_
uses a valid FE enum and parses — so a hand-built org may not trip it, but a
_seeded/imported_ one always will.

### 🔴 #2 — Dev-server instability (PERF-2): "Every other click fails." (DEMO-KILLER)

**Business impact:** if anyone demos or pilots on `next dev`, the customer
experiences random 500s and dead actions and concludes the product is unstable —
_regardless of whether the feature works_. It already manufactured two false
"nothing works" reports internally. **A prospect who sees this in a demo walks.**
Mitigation is free (production build) but it is a hard gate: never show a
customer the dev server.

### 🟠 #3 — DV-ORG-2: the headline KPI is wrong. (TRUST-EROSION)

**Business impact:** "פרויקטים פעילים" (active projects) counts cancelled +
completed projects — it filters only `archived_at`, not `status`. The number a
manager sees first, every morning, on the dashboard is _inflated and wrong_. A
customer who notices (and an urban-renewal PM tracking their portfolio _will_)
stops trusting every other number on the screen. One wrong KPI poisons the whole
dashboard's credibility. Cheap fix (`AND status NOT IN ('cancelled','completed')`),
disproportionate trust damage.

### 🟠 #4 — Empty signature-progress everywhere: "It can't tell me where my projects stand." (VALUE-GAP)

**Business impact:** on the projects list every card shows `חתימות 0/0` and
`גוש/חלקה —`; the agent's per-project KPI grid renders `—` placeholders. The
_one number_ an urban-renewal operator lives by — how close each project is to
the signing threshold — is absent or zeroed at the surface they look at most.
The product _has_ the signature data (cross-entity proves it) but doesn't
_surface progress_ where decisions are made. A customer doesn't churn over this,
but it caps perceived value: "nice CRM, but it doesn't actually run my deal."

### 🟡 #5 — DV-ORG-1: dev jargon leaks into the customer's home screen. (CREDIBILITY)

**Business impact:** the manager dashboard literally reads _"תצוגת יומן מלאה
תיחבר ב-A.S12 (Calendar + ICS)"_ and _"צ'אט נוסף בשלב מאוחר יותר (Phase 2)"_.
Internal slice/phase codenames on the _first screen the customer sees_. It
doesn't break anything, but it screams "unfinished internal build" and
undermines the otherwise-professional impression. First-impression tax.

### 🟡 #6 — DV-ORG-9 / dead controls: "I keep clicking things that do nothing." (FRICTION)

**Business impact:** ~30 write controls across 12 surfaces render for roles that
can't use them (viewer gets a full create-project wizard behind a guaranteed
403; agent sees "פרויקט חדש"; owner dossier has 4 disabled "בקרוב" quick-actions
incl. send-to-signature and WhatsApp). **Confirmed NOT a security issue** — every
write is BE-blocked, nothing persists. But a viewer who fills a whole form and
gets a silent 403, or an agent whose entire job (chase a signature via WhatsApp/
send-link) is a row of dead "coming soon" buttons, feels the product is broken or
that they lack access they were promised. Friction, support tickets, erosion —
not a breach.

### 🟡 #7 — DV-PROV-AUDIT: operator can't review their own audited actions. (COMPLIANCE-GAP, internal)

**Business impact:** affects _us_ (the SaaS operator), not the paying customer
directly. The whole provider-tier security story is "every provider action is
audited," yet `provider_audit_log` has no read endpoint — an operator who
suspends a customer cannot later review their own audited actions in-product.
A compliance/DPA reviewer or a "who suspended us and why?" customer dispute
exposes this. Medium, deferred-by-design, but it's a hole in our own story.

### ⚪ #8 — locked provider scaffold (9/13 nav items): forward-looking, low risk.

9 of 13 provider-console nav items are locked scaffold (billing, plans, roles,
integrations, backups…). It's honest scaffolding with lock glyphs, not dead
controls. Decide ship-or-hide, but low business risk.

> **Note on seed pollution (cosmetic, not a bug):** the live projects/owners
> lists are currently littered with `DV Persona Proj …`, `rp owner`, `probe
owner` records the audit runs created. Not a product defect — but reset the
> demo DB before any customer sees it.

---

## 3. The QUESTIONS / DECISIONS the owner must make BEFORE fixing

These are **product decisions, not bug tickets.** Each blocks or shapes a fix.

### Q1 — What is the document taxonomy? (blocks DV-MGR-DOCS _and_ the core signature doc)

The bug is a taxonomy collision, but the fix direction is a _product_ call:

- **Option A (recommended):** adopt the real urban-renewal vocabulary as the
  canonical enum — `agreement` (הסכם — the core signature doc), `blueprint`
  (תוכנית/בלופרינט), `regulation` (תקנון), plus a small `other`. Make it a real
  DB/BE enum (kill the free-text `text` column) and align the FE picker to it.
- **Option B:** keep the generic FE enum and remap on read.
- **Recommendation: A.** It fixes the parse crash, makes the column type-safe so
  drift can't recur, _and_ it puts **"agreement" — the document residents
  actually sign — back in the picker** (it's currently missing entirely, so even
  a working picker couldn't offer the core signature doc). This is the one
  decision that unblocks the headline workflow. Option B fixes the crash but
  leaves the product gap.

### Q2 — Ship-or-hide the dead controls? (DV-ORG-9 + owner quick-actions + locked nav)

- **Option A (recommended):** _hide_ every control a role can't complete and
  every "בקרוב" placeholder until it's wired. Role-gate the FE off the existing
  capability model (the sidebar already does this for Members/Audit).
- **Option B:** leave them visible as a roadmap signal (disabled + "בקרוב").
- **Recommendation: A for everything pre-sale.** A read-only viewer should never
  get a create form; a field agent should never see "פרויקט חדש"; an owner
  dossier should not show 4 dead actions. Visible-but-dead reads as broken, not
  as roadmap. The provider locked-scaffold (Q-adjacent) is the _one_ place B is
  acceptable — operators tolerate "coming soon" in an internal console — but the
  customer-facing org UI should hide.

### Q3 — Is a field agent with no home/worklist + no mobile signing acceptable for MVP?

The agent role is _secure and functional_ but **structurally read-with-no-do**:
no "my route / who's-left-to-sign" worklist, no per-project signature progress
(grid shows `—`), and the only way to act on an owner (WhatsApp / send signing
link) is the dead quick-actions. Signing happens on a phone at a kitchen table;
the surfaces are desktop grids.

- **Option A:** ship MVP with the agent as a read/triage role; defer the field
  worklist + mobile signing to v-next; sell it as "managers drive, agents
  observe."
- **Option B:** treat the agent worklist + a mobile send-link flow as MVP-blocking
  because _field signature collection is the daily job we're sold on._
- **Recommendation: A _only if_ the manager can fully drive signing** (which
  requires Q1 fixed first). If the customer's value prop is "my field team
  collects signatures in the app," then B — but be explicit with the customer
  about the v1 boundary. Do not silently ship dead field controls.

### Q4 — Should progress show consent-vs-legal-threshold, or raw counts? (DV-CON-1)

Today the contractor (and the project cards) show raw `signed/total`. תמ"א 38/2
& פינוי-בינוי go/no-go decisions turn on **% signed vs the statutory majority**,
assessed _per building_ — the contractor's actual decision input.

- **Option A:** add consent-vs-threshold + per-building breakdown as the headline
  metric (raw counts secondary).
- **Option B:** keep raw counts for MVP.
- **Recommendation: A is the single highest-leverage _value_ feature** (distinct
  from the _bugs_ above). It's additive, no PII, no boundary change. If we want
  the customer to feel the product _runs their deal_ rather than _stores their
  data_, this is the feature. Reasonable to phase: ship raw counts at MVP, commit
  threshold to the next slice — but decide now, because #4 in the loss ranking
  is the same gap surfaced on the manager/agent side.

### Q5 — Production build for any demo/pilot? (the dev-server instability)

- **Option A (recommended, non-negotiable):** every demo and pilot runs on a
  production build (`next build && next start`, `nest build`) against a real DB.
  Re-run the deep-verification HIGH findings once on prod build to separate
  remaining real bugs from dev-server artifacts.
- **Option B:** demo on dev.
- **Recommendation: A.** B has already cost us two false "nothing works"
  reports. The dev server is not the product; never let a customer see it.

---

## 4. WHAT'S MISSING — capabilities a real urban-renewal customer expects

Distinct from bugs: these _don't exist_ and a real customer will ask for them.

1. **Field-agent worklist / "my route."** No focused agent home: _my assigned
   projects, per-project signed-vs-needed, who's-left-to-sign today._ The agent
   lands on the same generic manager dashboard. (persona-agent §MISSING.)

2. **Mobile signing flow for the field.** Signature collection happens on a phone
   at a kitchen table; the surfaces are desktop grids. No mobile-first
   send-link / on-site signing affordance.

3. **Consent-vs-legal-threshold + per-building progress.** The go/no-go number
   for תמ"א/פינוי-בינוי (% vs statutory majority, per building, velocity) is
   absent everywhere — contractor, manager cards, agent grid. The product shows
   raw counts, never "are we past the threshold?" (DV-CON-1 + the empty card
   columns.)

4. **"Agreement" document type in the picker.** The core _signature_ document
   type is not selectable at all — even once DV-MGR-DOCS is fixed, the taxonomy
   decision (Q1) must _add_ it.

5. **In-product provider audit-read.** The operator can't review their own
   audited actions; `provider_audit_log` has no read path. (DV-PROV-AUDIT.)

6. **Realtime / notifications of cross-entity events.** All sync is pull-based
   (correct on next read, ~30s staleTime). A manager watching the dashboard sees
   a new signature only on refetch, not live. Acceptable for MVP, but a customer
   expecting "ping me when someone signs" will ask. No push/realtime invalidation.

7. **"Resend my pending signature link" on the resident portal.** The portal is
   read-only (D.40); a resident who loses the emailed `/sign/:token` link has no
   in-portal path back to their pending signature (the token is
   non-retrievable by design). A real resident WILL lose the link.

8. **FE write-gating off the capability model.** The UI has no signal of what a
   given role/agent can do — it shows controls it can't use and gives no
   "request access" affordance. A user can't tell a permission wall from a bug.

---

## Bottom line

A **professional, secure, correctly-synchronized product** with **one
account-killing functional bug** (signature workflow unreachable — DV-MGR-DOCS),
**one demo-killing operational constraint** (never demo on the dev server), and
**a wrong headline KPI** that erodes trust. Fix those three, decide the document
taxonomy (Q1) and ship-or-hide policy (Q2), demo on a production build (Q5) — and
this is a credible paid pilot. Ship as-is today and the customer never reaches
the one workflow they bought, on a server that looks broken. **NO-SHIP today;
days-from-ready, not weeks.**
