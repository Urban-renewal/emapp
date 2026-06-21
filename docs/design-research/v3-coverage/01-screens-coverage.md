# 01 — Screens / Routes Coverage Audit (v3)

> Dimension: **every screen / route**. Method: enumerated the REAL route tree via
> `find apps/web/src/app -name page.tsx|layout.tsx|error.tsx|loading.tsx|not-found.tsx`
> (NOT the plan's lists), then cross-checked each against
> `docs/design-research/v2/00-MASTER-PLAN-V2.md` + `DECISIONS-LOCKED.md` +
> `CRITIQUE-completeness.md`. Author: v3 coverage seat, 2026-06-18. READ-ONLY.
>
> **Inventory:** 60 route files total — **48 `page.tsx`** (routable screens) + 7
> `layout.tsx` + 2 `error.tsx` + 3 `not-found.tsx`. (The plan repeatedly cites
> "55 page.tsx surfaces"; the real `page.tsx` count is **48**. The "55" is stale —
> a GAP in the plan's own accounting, harmless to safety but it shows the lists
> were not re-enumerated.)
>
> **Classification legend:** COVERED = plan explicitly redesigns it · CHANGED =
> plan modifies it (noted) · AS-IS-OK = plan correctly leaves it untouched · GAP =
> plan misses a screen/flow/rule it should touch (or only "keeps it responding"
> without redesigning a persona-critical surface).

---

## GAP SUMMARY (ranked by impact on the one-shot-implementation goal)

The plan's load-bearing safety claim is *"this is re-composition, not re-routing —
all surfaces keep responding"* (`00 §2.2`). True for **routing**. But "keeps
responding" ≠ "redesigned": the master plan **directly redesigns only ~10 of 48
screens**; the rest are pulled in ONLY by the completeness critique's C1–C11 bucket
(`00 §Wave 4`), which is explicitly "**slot by owner priority**" / "**P2 / scope
decision**" — i.e. NOT committed to the one-shot pass. If the owner wants
"everything closed before implementation," these are the holes:

1. **G-SIGN — the public signer page `/sign/[token]` is the SINGLE most important
   counterparty screen and the master plan never names it.** It is THE conversion
   moment (the owner actually signs here). It is outside `[locale]` (its own root
   `sign/layout.tsx`), so the token re-skin (`globals.css :root`) reaches it ONLY
   if that layout pulls the same stylesheet — UNVERIFIED by any seat. The board-first
   redesign elevates the consent number, but the screen that PRODUCES each signature
   is un-audited. Completeness mentions it once obliquely (G-TENANT-OTP "the `/sign/:token`
   flow"); the master plan's roadmap has zero slice for it. **P0.**

2. **G-PROVIDER-TIER — the entire Provider-Admin surface (10 screens) is invisible to
   the plan.** `/provider`, `/provider/audit`, `/provider/audit/self`,
   `/provider/backups`, `/provider/onboard`, `/provider/system-health`,
   `/provider/tenants`, `/provider/tenants/[id]`, `/provider/tenants/[id]/users`, plus
   `(auth)/provider/login`. The plan's nav/IA section is org-tier only; "Admin group"
   (`00 §2.2`) is the ORG admin (members/audit/settings), NOT the Provider tier. These
   screens carry raw `bg-emerald-500/bg-amber-500/bg-red-500` + `bg-emerald-50…`
   palette leaks (`provider/system-health/page.tsx:30-39`) and `bg-card`
   (`provider/page.tsx`) — i.e. they are ON the leak-sweep path the plan says it is
   closing at "true scope," yet the §3.5 "79/35" baseline never opened them. **The
   class-name guard will ratchet from a false floor again** (same failure mode the
   completeness critique flagged for project-new/imports/contractor — but for a whole
   tier). **P0 for the leak-guard honesty; P1 for the visual pass.**

3. **G-RESKIN-FLOOR (broader than the plan admits).** The plan's §3.5 re-measure list
   names exactly THREE unopened surfaces (project-new, imports, contractor-share). The
   real unopened set with palette/`var(--navy)`/`bg-card` leaks is far larger: the **10
   provider screens** (#2), **`provider/system-health`** (hard-coded emerald/amber/red
   ramps), plus every detail/new/edit form below that no seat opened (owners/new,
   contractors/new, members/new, tasks/new, notes/new, documents/new, signature-requests/new,
   buildings/[id]/apartments/new, projects/[id]/buildings/new, apartments/[id]/ownerships).
   Freezing the guard at "79/35 + 3" still ratchets from a false floor. **P0 for guard
   correctness.**

4. **G-DETAIL-FORMS — ~15 create/edit/detail forms are "kept responding" but never
   redesigned, and several are persona-critical inputs.** `apartments/[id]/ownerships`
   (the share-numerator/denominator entry — the EXACT data the share-weighted consent
   headline now depends on, DECISIONS-LOCKED §1), `signature-requests/new` (the manual
   single-send that the chase loop wraps), `projects/[id]/shares` + `assignments`
   (the Access-tab drill-downs the plan promises but doesn't redesign), all the
   `*/new` forms. The plan redesigns the surfaces that READ status; the surfaces that
   WRITE the data the new headline depends on are untouched. This is the completeness
   critique's "redesigned output, ignored input" meta-gap (`§0`) — acknowledged but
   parked in P1/P2, NOT in the one-shot core. **P1.**

5. **G-AUTH-ONBOARD — the auth/onboarding cluster (login, signup, forgot/reset-password,
   accept-invite, tenant/login) is the first-touch surface and the plan touches none of
   it.** Completeness C3/P-ONB names empty-org home + "audit signup + accept-invite," but
   the master-plan ROADMAP has no slice; it's P0-labeled in the critique yet unscheduled
   in Waves 0–3. `accept-invite/[token]` is how the developer's TEAM (agents/viewers)
   first touch the product. **P0 per the critique's own ranking, unscheduled in the plan.**

6. **G-MESSAGES-NOTIF-CALENDAR — three "demote to topbar" decisions hide real surfaces
   without redesigning them.** `/messages` (full two-pane chat, polling) is demoted to a
   topbar cluster icon but the SCREEN itself is never redesigned (still raw). `/notifications`
   loses its nav line but the full page stays (and the doctrine's "notify-don't-task"
   momentum feed — G-NOTIF-DESIGN — is named only as a P2 backlog line). The calendar STUB
   is deleted (`E2.1`) but the *populated* calendar that `tasks.due_at` could power
   (G-CALENDAR) is unscheduled. **P1.**

7. **G-TENANT-PORTAL — `(tenant)/portal` is redesigned by nobody.** It is the resident
   counterparty's home (the SMS-OTP role). The plan's IA/nav is org-tier; the tenant
   chrome+portal (its own `(tenant)/layout.tsx`) gets the token re-skin for free ONLY if
   it consumes the same Tier-2 aliases — UNVERIFIED. Its `portal.ts` adapter is on the
   `statusColor→intent` rename list (`00 §3.5` names `portal.ts` + `portal-progress.spec.ts`),
   so the leak fix touches its DATA, but the SCREEN's calm/sentence-first pass is unscoped. **P1.**

8. **G-CONTRACTOR-LAYOUT/NEW — contractor-share is in the plan (C7), but the contractor
   GROUP has two more unaddressed pieces:** `(contractor)/layout.tsx` (the external chrome —
   does it get tokens?) and `contractors/new` + `contractors/[id]` (org-side contractor CRUD,
   reached "from the Access tab" per `00 §2.2` but never redesigned). **P2.**

9. **G-COUNT-MISMATCH (meta).** The plan asserts "55 page.tsx surfaces" and "~64 routes"
   (`§2.2`, critique `§0`); the real count is **48 page.tsx**. Not a functional gap, but it
   proves the plan's surface inventory was never enumerated from the tree — which is exactly
   how screens get missed in a one-shot pass. **P2 (credibility / completeness signal).**

---

## FULL INVENTORY TABLE

Paths are relative to `apps/web/src/app/`. `[locale]/` prefix omitted in the item
column for brevity except where it disambiguates. Line cites are to the file's
purpose docblock / key line.

### Auth group `[locale]/(auth)/*` — first-touch + counterparty entry

| Item | file:line | Purpose | Plan status | Note |
|---|---|---|---|---|
| Login | `(auth)/login/page.tsx` | Org user sign-in (the view-source `method=post` DoD origin) | **GAP** | Not named in any roadmap slice. First-touch surface; gets token re-skin only if it sits under `[locale]/layout`. Critique C3/P-ONB-2 implies it; master plan unscheduled. |
| Signup | `(auth)/signup/page.tsx` | Atomic org+first-Manager signup (withBootstrap) | **GAP** | Completeness §4 (P-ONB-2) names it; master-plan roadmap has no slice. Empty-org first impression. |
| Forgot-password | `(auth)/forgot-password/page.tsx` | Public reset-request (locale-link bug history) | **GAP** | Unmentioned. Public unauth surface. |
| Reset-password | `(auth)/reset-password/page.tsx` | Token-based password reset | **GAP** | Unmentioned. |
| Accept-invite | `(auth)/accept-invite/[token]/page.tsx:1` | Public invite landing — team members + tenants set own password | **GAP** | Completeness §4 P-ONB-2 ("how the team first touches the product"); P0-ranked in critique, unscheduled in plan roadmap. |
| Tenant login | `(auth)/tenant/login/page.tsx` | Resident SMS-OTP sign-in | **GAP** | Critique G-TENANT-OTP names it as "the resident's first touch… his outcome." Not in master-plan roadmap. |
| Provider login | `(auth)/provider/login/page.tsx` | Provider-Admin MFA sign-in | **GAP** | Provider tier entirely outside the plan's IA. See G-PROVIDER-TIER. |

### Dashboard root + home `[locale]/(dashboard)/*`

| Item | file:line | Purpose | Plan status | Note |
|---|---|---|---|---|
| Dashboard layout | `(dashboard)/layout.tsx` | Org chrome: sidebar + topbar + session/tier gate | **CHANGED** | Sidebar 14→5 + topbar utility cluster (`00 §2.2`, E2-IA-S2). Core IA move. |
| Home | `(dashboard)/page.tsx` | Renders ManagerHome / AgentHome by role | **COVERED/CHANGED** | E2.1 mission-control: delete calendar stub, converge onto ActionCard, ManagerHome→Pattern A (`00 §2.4, Wave 2`). Empty-org state = GAP folded by C3. |

### Projects spine (the redesign's core)

| Item | file:line | Purpose | Plan status | Note |
|---|---|---|---|---|
| Projects list | `(dashboard)/projects/page.tsx` | All projects | **COVERED** | E2-list full-power: ProjectRow enrichment, sort-by-distance, URL-state (`00 Wave 2`). Sort-by-momentum gates B1. |
| Project detail | `(dashboard)/projects/[id]/page.tsx` | The board + tabs (the headline IA move) | **COVERED** | Board-first default+order, E2.2-S1/S3 (`00 §2.3`). The pivotal screen. |
| Project new | `(dashboard)/projects/new/page.tsx` | 1468-line creation wizard | **GAP (C5/P1)** | Largest client file; "opened by no seat" (`00 §C5`, critique §1). Master plan parks it P1 in Wave 4, NOT core. The יזם's first deep interaction. |
| Project buildings list | `(dashboard)/projects/[id]/buildings/page.tsx` | Buildings under a project | **CHANGED (drill-down)** | Becomes Structure-tab drill-down; URL kept (`00 §2.3`). Not redesigned beyond re-home. |
| Project building-new | `(dashboard)/projects/[id]/buildings/new/page.tsx` | Add building (parcel גוש/חלקה) | **GAP** | A `*/new` form; unaddressed. Parcel-setup keeps `buildings.create` gate (`00 §2.2`) but screen not redesigned. |
| Project assignments | `(dashboard)/projects/[id]/assignments/page.tsx:23` | Assign Agents to project (write=MGR) | **CHANGED (drill-down)** | Reached from Access tab; URL kept. Screen itself not redesigned. |
| Project shares | `(dashboard)/projects/[id]/shares/page.tsx:20` | Grant contractor shares (JSONB perms) | **CHANGED (drill-down)** | Access-tab drill-down (`00 §2.2`). Screen not redesigned; on leak path (StatusBadge in summaries). |

### Buildings / Apartments / Owners (the spine's lower levels)

| Item | file:line | Purpose | Plan status | Note |
|---|---|---|---|---|
| Buildings list (global) | `(dashboard)/buildings/page.tsx` | All buildings | **AS-IS-OK / GAP** | Not in nav spine; "keeps responding." Not redesigned. Low persona priority — AS-IS defensible, but unmentioned (no explicit decision). |
| Building detail | `(dashboard)/buildings/[id]/page.tsx` | One building + its apartments | **GAP** | Unmentioned. Drill-down target. |
| Building apartments | `(dashboard)/buildings/[id]/apartments/page.tsx` | Apartments in a building | **GAP** | Unmentioned. |
| Building apartment-new | `(dashboard)/buildings/[id]/apartments/new/page.tsx` | Add apartment ("דירה") | **GAP** | `*/new` input form, unaddressed. |
| Apartments list (global) | `(dashboard)/apartments/page.tsx` | All apartments | **GAP** | Unmentioned; scale-at-N (C6) implies it but no slice. |
| Apartment detail | `(dashboard)/apartments/[id]/page.tsx` | One apartment + tabu review (F3) | **GAP** | Unmentioned. Carries tabu-review flow (a write surface). |
| Apartment ownerships | `(dashboard)/apartments/[id]/ownerships/page.tsx:24` | **Set share_numerator/denominator per owner** | **GAP (HIGH)** | The screen that ENTERS the share data the new share-weighted headline (DECISIONS-LOCKED §1) depends on. Redesign elevates that number but never touches its input surface. |
| Owners list | `(dashboard)/owners/page.tsx` | Dense owner management table (cross-project) | **COVERED** | Person-axis dossier home; nav spine item (gated `owners.read`); search omnibox extends `/owners/search` (`00 §2.1, §2.4`). Scale-at-N = C6 partial. |
| Owner detail | `(dashboard)/owners/[id]/page.tsx` | Owner dossier (horizontal axis) | **COVERED** | The "everything about this owner across projects" dossier (`00 §2.1`). Notes→owner dossier (`00 §2.2`). |
| Owner new | `(dashboard)/owners/new/page.tsx` | Create owner (national_id PII) | **GAP** | `*/new` input form; PII entry; unaddressed. |

### Signatures / Documents (demoted to project tabs)

| Item | file:line | Purpose | Plan status | Note |
|---|---|---|---|---|
| Signature-requests list | `(dashboard)/signature-requests/page.tsx` | Global request list / chase queue | **CHANGED** | Demoted to project tab; global library survives (`00 §2.2`). Chase queue list-level triage = C6/P-SCALE-3 (parked P1, not core). |
| Signature-request detail | `(dashboard)/signature-requests/[id]/page.tsx` | One request status | **GAP** | Unmentioned. The chase loop wraps `resend` but this detail screen is un-audited. |
| Signature-request new | `(dashboard)/signature-requests/new/page.tsx:13` | Manual single send (doc+owner) | **GAP** | The manual counterpart to the campaign send; unaddressed input form. |
| Documents list | `(dashboard)/documents/page.tsx` | Global doc library | **CHANGED** | Demoted to project Documents tab; global survives (`00 §2.2`). |
| Document detail | `(dashboard)/documents/[id]/page.tsx` | One doc + StepUp reveal + download | **GAP** | Unmentioned except M6 (StepUpDialog a11y retrofit) which lives here; PII-in-motion signed-doc download (C9/P-PII-2) parked P1. |
| Document new | `(dashboard)/documents/new/page.tsx` | Upload (envelope-encrypt path) | **GAP** | `*/new` form; unaddressed. |

### Imports (live SSE flow — disproves "no real-time")

| Item | file:line | Purpose | Plan status | Note |
|---|---|---|---|---|
| Imports list | `(dashboard)/imports/page.tsx` | Import jobs; nav spine item | **COVERED (nav)** | Kept as spine item (`00 §2.2`). List screen itself not deeply redesigned. |
| Import new | `(dashboard)/imports/new/page.tsx` | Upload Excel | **GAP/CHANGED** | Part of C8 import-flow analysis (parked P1). Re-skin sweep names it (`00 §3.5 re-measure`). |
| Import detail | `(dashboard)/imports/[id]/page.tsx` | Live SSE progress + preview/confirm pause | **CHANGED (C8/P1)** | The "approve-don't-construct" precedent; M1/G6 must reconcile (`00 §C8`). Re-skin sweep. Parked P1, not core triad. |
| Import mapping | `(dashboard)/imports/[id]/mapping/page.tsx` | Column→field mapping wizard | **GAP (C8)** | Named in re-skin sweep (`00 §3.5`); flow analysis parked P1. |
| Import errors | `(dashboard)/imports/[id]/errors/page.tsx` | Row-error triage | **GAP (C8)** | Same as mapping. |

### Tasks / Notes / Messages / Notifications (demoted / topbar)

| Item | file:line | Purpose | Plan status | Note |
|---|---|---|---|---|
| Tasks list | `(dashboard)/tasks/page.tsx:28` | Tasks (RSC-prefetch); nav spine item | **COVERED (nav)** | Kept as spine item (`00 §2.2`). Tasks-5-vs-4 = low-stakes OD. List not redesigned. Populated calendar = G-CALENDAR (P2). |
| Task detail | `(dashboard)/tasks/[id]/page.tsx` | One task | **GAP** | Unmentioned. |
| Task new | `(dashboard)/tasks/new/page.tsx` | Create task | **GAP** | `*/new` form; unaddressed. |
| Notes list | `(dashboard)/notes/page.tsx:9` | Notes (RSC-prefetch) | **CHANGED** | Demoted to per-project Activity tab + owner dossier (`00 §2.2`). Screen kept. |
| Note detail | `(dashboard)/notes/[id]/page.tsx` | One note | **GAP** | Unmentioned. |
| Note new | `(dashboard)/notes/new/page.tsx` | Create note | **GAP** | `*/new` form; unaddressed. |
| Messages | `(dashboard)/messages/page.tsx:22` | Team chat (two-pane, polling) | **CHANGED** | Demoted to topbar utility cluster (`00 §2.2`). The SCREEN itself never redesigned (G-MESSAGES). |
| Notifications | `(dashboard)/notifications/page.tsx` | Notification feed (RSC) | **CHANGED** | Nav line dropped (bell already in topbar, `00 §2.2`). Full page kept. Momentum-feed redesign = G-NOTIF-DESIGN (P2). |

### Org Admin (members / audit / settings) — collapsed "ניהול" group

| Item | file:line | Purpose | Plan status | Note |
|---|---|---|---|---|
| Members list | `(dashboard)/members/page.tsx` | Org members; gate `members.read` | **CHANGED** | Into Admin group (`00 §2.2`, gates carry over). Not redesigned. Scale-at-N C6. |
| Member detail | `(dashboard)/members/[userId]/page.tsx:34` | Role change/revoke + overrides | **GAP** | Unmentioned. Carries per-member permission-override panel (a real write surface). |
| Member new | `(dashboard)/members/new/page.tsx` | Invite member | **GAP** | `*/new` form; the invite issuance surface. |
| Audit | `(dashboard)/audit/page.tsx` | Org audit log | **CHANGED** | Admin group (`00 §2.2`). Not redesigned. |
| Settings | `(dashboard)/settings/page.tsx` | Org settings | **CHANGED** | Admin group (`00 §2.2`). Brand fork (OD-6) = one-token edit, but settings SCREEN not redesigned. |
| Settings/roles | `(dashboard)/settings/roles/page.tsx:14` | Role/permission management (`roles.manage`) | **GAP** | Unmentioned. A dense permission matrix — the kind of "depth-3 power surface" Tension 6 allows dense, but no slice scopes it. |

### Provider tier — ENTIRELY UNADDRESSED by the plan (G-PROVIDER-TIER)

| Item | file:line | Purpose | Plan status | Note |
|---|---|---|---|---|
| Provider layout | `(dashboard)/provider/layout.tsx` | Provider chrome + AccessReasonGate | **GAP** | Plan's "Admin group" is ORG admin, not this tier. Token re-skin reaches it only if it consumes Tier-2. |
| Provider dashboard | `(dashboard)/provider/page.tsx` | Provider home + health summary | **GAP** | Uses `bg-card` (on the dead-class fix path) — yet unopened by §3.5. |
| Provider audit | `(dashboard)/provider/audit/page.tsx` | Cross-tenant audit log | **GAP** | Unmentioned. The only surface using `formatJerusalem` (the tz-correct helper P-TZ-1 wants to generalize) — relevant precedent the plan misses. |
| Provider audit self | `(dashboard)/provider/audit/self/page.tsx` | Operator's own audit trail | **GAP** | Unmentioned. |
| Provider backups | `(dashboard)/provider/backups/page.tsx` | DR posture (honest no-fabrication read) | **GAP** | Unmentioned. Ironically already embodies the doctrine's "never fabricate a signal" — a model the plan should cite, not miss. |
| Provider onboard | `(dashboard)/provider/onboard/page.tsx:18` | Create Org + invite first Manager | **GAP** | Unmentioned. Provider WRITE (audited). |
| Provider system-health | `(dashboard)/provider/system-health/page.tsx:30` | Queue/pool/R2 gauges | **GAP (leak)** | Hard-codes `bg-emerald-500/bg-amber-500/bg-red-500` + `bg-emerald-50…` — direct default-palette leak the guard must catch; never opened by §3.5. |
| Provider tenants | `(dashboard)/provider/tenants/page.tsx` | Cross-tenant org list | **GAP** | Unmentioned. |
| Provider tenant detail | `(dashboard)/provider/tenants/[id]/page.tsx` | One org (masked PII) | **GAP** | Unmentioned. |
| Provider tenant users | `(dashboard)/provider/tenants/[id]/users/page.tsx:14` | Org members (masked) | **GAP** | Unmentioned. |

### External / counterparty surfaces (outside `[locale]` or in their own group)

| Item | file:line | Purpose | Plan status | Note |
|---|---|---|---|---|
| Contractor layout | `(contractor)/layout.tsx` | External contractor chrome | **GAP** | C7 covers the share VIEW; the chrome/layout token wiring is unaddressed. |
| Contractor share | `(contractor)/contractor/share/page.tsx:102` | Read-only project share for contractors | **COVERED (C7/P1)** | Named (`00 §C7`): badge leak + `var(--navy-*)` + dropped lifecycle status. Parked P1, not core triad. |
| Contractors list | `(dashboard)/contractors/page.tsx` | Org-side contractor address book | **CHANGED** | "Address book reached from Access tab" (`00 §2.2`). Screen not redesigned. |
| Contractor detail | `(dashboard)/contractors/[id]/page.tsx:14` | One contractor (read=ALL) | **GAP** | Unmentioned. |
| Contractor new | `(dashboard)/contractors/new/page.tsx` | Create contractor | **GAP** | `*/new` form; unaddressed. |
| Tenant layout | `(tenant)/layout.tsx` | Resident portal chrome | **GAP** | Token wiring unverified; not in org-tier IA. |
| Tenant portal | `(tenant)/portal/page.tsx:5` | Resident's read-only home (me/apartment/docs/signatures) | **GAP (data CHANGED)** | `portal.ts`/`portal-progress.spec.ts` ARE on the rename list (`00 §3.5`) so the leak fix touches its data, but the SCREEN's calm pass is unscoped. Counterparty home. |
| **Public signer** | `sign/[token]/page.tsx:1` | **The owner actually signs the document here** | **GAP (P0)** | THE conversion moment. Outside `[locale]` (own `sign/layout.tsx`). Master plan never names it. Token re-skin reaches it only if `sign/layout` pulls the stylesheet — UNVERIFIED. See G-SIGN. |
| Sign layout | `sign/layout.tsx` | Public signer chrome (no app nav) | **GAP** | Determines whether the signer page gets tokens at all. Unaddressed. |

### Framework surfaces (boundaries / chrome)

| Item | file:line | Purpose | Plan status | Note |
|---|---|---|---|---|
| Root layout | `layout.tsx` | App root (html/body) | **AS-IS-OK** | Minimal; token CSS imported here. Correctly untouched (the re-skin edits `globals.css`, not this). |
| Locale layout | `[locale]/layout.tsx` | next-intl provider + dir=rtl | **AS-IS-OK** | RTL/i18n shell; plan relies on it (logical props). Correctly untouched. |
| Locale error | `[locale]/error.tsx` | Token-themed error boundary (digest-only) | **CHANGED** | C2/`<DataState>` notes it catches THROWS but not silent-null returns (`00 §Wave 0 C2`, critique §7). Generalized, not replaced. |
| Locale not-found | `[locale]/not-found.tsx` | 404 page | **AS-IS-OK** | Exists; critique §7 confirms boundaries are fine. |
| Root not-found | `not-found.tsx` | Top-level 404 | **AS-IS-OK** | Same. |
| Provider/Tenant/Contractor `layout.tsx` | (counted above) | Tier chromes | **GAP** | See respective rows — token wiring unverified for non-org tiers. |

---

## COVERAGE TALLY

- **Total routable `page.tsx`:** 48 (plan's "55" is stale — G-COUNT-MISMATCH).
- **COVERED (plan explicitly redesigns):** ~10 — home, projects list, project detail,
  owners list, owner detail, imports list (nav), tasks list (nav), contractor-share (C7),
  + the board sub-surfaces. The redesign's true committed core is the **happy-path triad**.
- **CHANGED (re-homed/demoted, screen kept but not redesigned):** ~13 — sidebar, the
  project drill-downs (buildings/assignments/shares), documents/signature-requests/notes
  (→tabs), messages/notifications (→topbar), members/audit/settings (→Admin group),
  import detail.
- **AS-IS-OK (correctly untouched):** ~5 — root/locale layouts, not-found pages.
- **GAP (missed or only "kept responding" without a redesign slice):** **~25**, dominated
  by: the **10 Provider screens**, the **7 auth/onboarding screens**, the public
  **`/sign/[token]`** signer, the tenant portal, ~15 `*/new`+detail input forms (several
  fold into critique C-buckets that are P1/P2/scope-decision, i.e. NOT in the one-shot core).

The plan's *routing*-safety claim holds; its *redesign-coverage* claim does not. Roughly
half the surfaces are GAP/parked, and the parked set includes P0-ranked items (sign page,
auth/onboarding, provider-tier leak floor) that the master-plan roadmap leaves unscheduled.
