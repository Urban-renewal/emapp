# 00 — MASTER PLAN V2 (EMAPP E2 redesign — the integrated, grounded plan)

> **Status:** the council's SECOND-pass synthesis. Supersedes
> `docs/design-research/00-MASTER-PLAN.md` (v1, too fast/shallow). Author: Design Lead,
> 2026-06-18. READ-ONLY research deliverable — no code changed.
>
> **What this is.** One coherent plan that integrates the eight v2 expert docs
> (`01..08`) and the three critiques (`CRITIQUE-{reality,completeness,coherence}`),
> resolves the tensions the critics found, and turns the result into a
> dependency-ordered slice roadmap with green-gates and guardrails. Every
> load-bearing claim is cited to a real file:line and was re-verified by the reality
> critic this pass (verdict: all 8 docs **SOLID**, zero fabricated findings).
>
> **The owner's fear this pass answers:** "they came back too fast and didn't have
> the full picture." They do now. The danger is no longer invention — it is the
> subtler failure of **rounding a flagged decision up to a fact**. This plan keeps
> the three seams the reality critic named explicitly gated: the legal consent rule,
> "derivable ≠ free / never-fabricate," and "contrast/RTL verified in real Chrome,
> not computed."

---

## 1. The one-line vision

**Stop making the technophobic יזם assemble his workflow from 14 CRUD lists and a
buried 4th-tab board. Re-center the whole product on the one spine that IS the
product — project → buildings → apartments → owners → signatures → the consent
threshold — make the already-built signature board the first thing he sees, hand him
the ~5 projects that need him today as plain-Hebrew sentences with one-tap actions,
and deliver it all on a token system a designer can re-skin without touching a single
component — never showing a number, a nudge, or a "why" the backend cannot honestly
back.**

The redesign is **composition + tokens + prefetch-extension, not a rewrite**
(`07` §0): the data path (`wire → lib/api Zod-parse → adapters VM → hooks → island`)
and the RSC prefetch pattern already ship; the hero components map ~1:1 onto real
pieces. The work is re-ordering, re-homing onto tokens, and three small backend
additions — gated behind owner decisions, not assumed.

---

## 2. The grounded information architecture

### 2.1 The spine (the mental model the user already holds)

> *"I run **projects**. Each project is **buildings**; each building has
> **apartments**; each apartment has **owners**; my job is to get those owners to
> **sign** until the project crosses its **consent threshold**."* (`03` §2)

That sentence **is** the IA. The route tree already encodes it; the nav doesn't
reflect it. Two relationship axes the IA must make explicit (`03` §2.1):

| Axis | Question | Primary home |
|---|---|---|
| **Project axis** (vertical) | "Where does *this project* stand?" | inside `/projects/[id]`, board-first |
| **Person axis** (horizontal) | "Everything about *this owner*, across her projects" | `/owners/[id]` dossier |

A signature is the **cell** at (owner × document × project). Critically, a signature
is against a **document**, never directly an apartment/project — consent is
*reconstructed* by the join "this owner holds a `signed` `signature_request` on a
document whose `project_id` = this project" (`projects.service.ts:386–393`, `01` §2).

### 2.2 Primary nav: 14 → 5 (+ Admin group + topbar utility cluster)

Today `sidebar.tsx:113–145` builds a **flat 11 always-on + up to 3 gated = up to 14**
sibling items, one per table — a schema dump (`03` §1.1; reality critic confirms the
count; the doc's stale "16 PCSidebar" is out-of-scope, corrected to 13).

**Keep as primary spine (top-of-funnel + genuinely cross-project):**
Home · **Projects** · **Owners** (gated `owners.read`) · **Imports** · **Tasks**
(`03` §3.1).

**Everything else leaves the spine** (demote ≠ delete — every route still responds):
- `/signature-requests`, `/documents` → **tabs inside the project**; global library survives as secondary.
- `/notes` → per-project **Activity** tab + owner dossier.
- `/contractors` → address book reached from the project **Access** tab.
- `/messages` → **topbar utility cluster** (orthogonal to the signature mission).
- `/notifications` → already a topbar bell (`topbar.tsx:51`); drop the redundant nav line.
- `/members`, `/audit`, `/settings` → collapsed **"ניהול / Admin"** group (the existing `members.read`/`audit.read`/`org.settings.read` gates carry over verbatim).

**Result:** 5 spine items + Admin group + topbar cluster (search · bell · messages).

> **Migration safety guarantee (`03` §8, verified):** this is *re-composition, not
> re-routing.* All **55 `page.tsx` surfaces** keep responding; deep links,
> notification `n.link` targets, and role-gating survive because gating lives in
> `middleware.ts` (tier cookies) + the BE `AuthorizationGuard` + `useHasPermission`
> — **never** in the nav grouping. Promoting a control into a tab does **not** ungate
> it (the board's campaign send keeps `signature_requests.send`; export keeps
> `export.run`; parcel-setup keeps `buildings.create`).

### 2.3 The project page becomes board-first (the headline IA move)

Today the project **opens on an empty `tenants` CTA** (`project-detail.client.tsx:79`
`useState<TabId>('tenants')`) that only links to `…/buildings`; the actual product —
the signature board — is the **4th `dashboard` tab** (`:300–428`). The board
components (`SignatureProgressBoard`, `SignatureProgressApartments`,
`SignatureCampaignAction`) **already render real wire data** — so board-first is a
**re-order + un-bury, not new construction** (`02` §2.3, `03` §1.2, `07` E2.2-S1).

New tab order (`03` §3.2): **1 חתימות/Signatures (default)** · 2 מבנה/Structure ·
3 מסמכים/Documents · 4 פעילות/Activity · 5 גישה/Access · (overflow) הגדרות/Setup.
All deep routes (`…/buildings`, `…/assignments`, `…/shares`, `/apartments/[id]`)
**keep their URLs** — they become drill-downs *from* the tabs.

> **⚠ The collision the coherence critic flagged (Tension 1 — resolved in §6 below):**
> board-first makes the headline consent % the *first* thing the user sees, and that %
> may be **legally wrong** (`01` §3.5). Board-first ships **only** under the binding
> interim rule (§6.1): no slice renders an unqualified % as a legal/threshold claim;
> the basis label is mandatory from day one.

### 2.4 Triage at scale + global search

- **Home = ~5 "needs you now" + one pulse line** (AgentHome's proven shape — already
  triage-by-list, capped `HOME_LIMIT=5`, `agent-home.tsx:43`), NOT the manager's cold
  4-KPI grid + calendar stub (`02` §2.1, `03` §1.4).
- **Projects list = full power, one tap away.** Sort-by-threshold-distance is
  **shippable today, zero BE** (`signaturesSignedCount`/`PendingCount`/`targetSignaturePct`
  already on every row, `shared-types/src/project.ts:218–225`). Sort-by-momentum is
  **genuinely blocked** — there is no `lastSignatureAt` field (`03` §7, `07` §2.4).
- **Global search omnibox** extends the **existing** `POST /api/v1/owners/search`
  (PII-in-body, throttled, `owners.controller.ts:64–79`) — reuse, don't invent
  (`03` §3.3). Honor "no PII in URL query params."
- **Ordering fix (Tension 2):** global search ships **no later than** the sidebar
  collapse, so the six demoted destinations are never left with neither a nav line nor
  search (§6.4).

---

## 3. The design-system foundation (3-tier tokens + the missing scales + heroes + leak fix)

The current token system is a **good skeleton, not yet a theming system** (`04` §0):
color/radius/elevation/motion/Heebo are tokenized; **spacing and type are not** (only
`--pad:16px` / `--row-h:44px` exist, `globals.css:105–106`) — which structurally
blocks the North Star's "generous whitespace / calm," because rhythm cannot be dialed
globally.

### 3.1 The 3-tier layering (`04` §3)

```
TIER 1 — PRIMITIVE TOKENS  (raw scales; the designer's editing surface)
   --navy-900, --success-600, --space-4, --r-lg, --text-title-size, Heebo …
        ▼ referenced by
TIER 2 — SEMANTIC ALIASES  (roles; the stable contract)
   --brand, --surface, --status-success-bg/-fg, --space-card, --focus-ring …
        ▼ consumed by (ONLY this layer)
TIER 3 — COMPONENTS  (StatusPill, ThresholdProgress, ActionCard, StatCard…)
   Consume Tier-2 ONLY. NEVER a Tier-1 ramp step, NEVER raw hex,
   NEVER a Tailwind default-palette class.
```

Re-skin = edit Tier 1 in **one file** (`globals.css :root`), never a `.tsx`. Dark mode
(`.dark` block already exists, `globals.css:114–122`) and per-org branding fall out
for free — they just re-point Tier-2 aliases on a scoped root.

### 3.2 The two missing scales (the #1 structural gap, `04` §2.4/§2.2)

- **Spacing — `--space-1..12`** (4px base): card pad `--space-5`, gap `--space-4/-6`,
  page gutter `--space-6`+, section `--space-8`. `--pad` becomes an alias
  `var(--space-4)` so density modes keep working.
- **Type — `--text-display/title/subtitle/body/label/caption`** (size + line + weight)
  on Heebo @ **400/500/700 only** (do NOT add weights — PR #47 LCP). Hierarchy =
  size + weight + color (Hebrew has no case/italics). Numbers carry `.tabular`
  (`tabular-nums`, already exists `globals.css:470`). Weight 500 = "calm emphasis";
  reserve 700 for the one hero number + titles. This resolves the unresolved
  700-vs-600 question (`globals.css:40–42`).

### 3.3 Three currently-shipping token bugs to fix in E2.0 (`04` §1, reality-confirmed)

1. **`bg-card` is a dead class** — used in **41 files** (incl. `list-skeleton.tsx:29`,
   `confirm-dialog.tsx:208`) but `card` is undefined in `tailwind.config.ts` → those
   surfaces render with **no background**. Fix: define `--card`/`card` → `--surface`.
2. **`--r-lg` contradicts itself** — `12px` (`globals.css:102`) vs `8px`
   (`tailwind.config.ts:139` `lg→--radius`). `.card` and `rounded-lg` render different
   corners. Fix: point `borderRadius.lg → var(--r-lg)`.
3. **Status-color palette leak** — see §3.5.

### 3.4 The hero component set (map onto real pieces, `07` §5, `04` §4)

| Hero | Built from | Notes |
|---|---|---|
| **`StatusPill`** | re-home `status-badge.tsx` onto the token-correct `.badge-*` family (`globals.css:268–306` — already `var(--success-*)`) | the #1 re-skin fix (§3.5) |
| **`ThresholdProgress`** | consolidate `SignatureProgressBar` + `SignatureProgressBoard` + `.progress` | threshold marker at `inset-inline-start`; success-flip on cross; `role=progressbar`+`aria-valuetext` (closes a11y G4); **render whatever weighted % the BE supplies** (§6.1) |
| **`ActionCard`** | the one genuinely-new component; `agent-home.tsx` is already its shape | name → plain-Hebrew situation sentence → StatusPill/compact bar → ONE primary action; start-edge accent is the only colored element |
| **`StatCard`** | `manager-home.tsx` KPI cards + `.card` | sentence-first, number as evidence (never bare metric hero) |
| **`ProjectRow`** | `projects-list.client.tsx` rows | real counts now; momentum chip when B1 lands |
| **Empty/Loading/Error** | `ListSkeleton` + `ListPageShell` (already split 403-vs-retryable) | reuse; fix `ListSkeleton`'s `bg-card`; richer reassuring empty |

Every component: logical props only (`ms/me`, `inset-inline-start`); every wire/user
name inside `<NameDisplay>`; Tier-2 tokens only; WCAG AA + visible `ring-2 ring-focus`;
**text/icon beside every color** (color never the only signal).

### 3.5 The palette-leak fix — adopt the visual doc's scope, overrule "one file" (Tension 4)

The leak is **born in the data layer**, not the component (`04` §1.6, reality-confirmed):
- `models/project.vm.ts:28` types it `statusColor: 'gray'|'amber'|'emerald'|'red'`;
- **6 adapters** hard-code it (`project.ts:48`, `apartment.ts:32`, `signature-request.ts:30`, `task.ts:34`, `import.ts:35`, `portal.ts`);
- **3 specs** assert the literals (`project.spec.ts:69`, `apartment.spec.ts:89,93`, `portal-progress.spec.ts:74`);
- `status-badge.tsx:20–25` maps them to **Tailwind defaults** (`bg-amber-100` etc.), bypassing the `--warning/--success/--danger` ramps.

Measured at **79 occurrences / 35 files** (`04` §1.6) — **not** "one file" as `02`/`07`
framed it. The fix is one coherent slice: **VM type → 6 adapters → 3 specs → component**,
renaming literals to **intent** (`success|warning|danger|info|neutral`). The existing
ratchet (`app-no-new-inline-colors.spec.ts`) is **architecturally blind** to class-name
leaks (it matches only hex/rgb/hsl) — so E2.0 must add a **new static guard** flagging
`(bg|text|border|ring)-(gray|slate|…|rose)-[0-9]` in `components/**`+`app/**`, frozen at
the measured baseline and ratcheted DOWN each slice. **Synthesis overrules the "one
file / keep-contract-identical / guard-as-follow-up" framing** — that path leaves 78/79
leaks alive and re-rots immediately.

> **Re-measure the baseline before freezing it (completeness §10 G-RESKIN-SCOPE):** the
> 79/35 count **excludes three large unopened surfaces** — `projects/new/page.tsx`
> (1468 lines), the import flow (`imports/[id]` + mapping + errors), and the contractor
> share view (verified to carry `StatusBadge` + inline `var(--navy-*)` leaks,
> `(contractor)/contractor/share/page.tsx:102,118,126`). Scan them, then freeze the guard
> at the true count, or it ratchets from a false floor.

### 3.6 Motion tokens + reduced-motion (Tension 5 assignment: owned by interaction M1)

There are **no motion tokens and no `prefers-reduced-motion` guard** today (`06`
Finding C). Add `--motion-duration-{fast,base,slow}` + `--motion-ease-*` to the token
layer; under `reduce`, zero the durations globally. Components consume tokens only —
the designer re-tunes "feel" from `:root`. **No looping/infinite animation** except the
existing `animate-pulse` skeleton. Every animation must answer "what state changed?" —
or be cut (a fearful user reads gratuitous motion as chaos).

---

## 4. Data-feasibility ground-truth (buildable-now vs needs-data + the hard DO-NOT-FABRICATE list)

Of 13 design signals (`05` §1, reality-confirmed): **6 EXIST on the wire**, **5 are
DERIVABLE behind ONE no-migration endpoint**, **1 needs a small PII-authz read**, and
**exactly 1 needs a schema migration.**

| Signal | Verdict | Source |
|---|---|---|
| Distance-to-threshold | **EXISTS** | `GET /projects/:id/signature-progress` → `consentedPct/targetSignaturePct/apartmentsConsented/totalApartments` |
| Past-threshold (`metThreshold`) | **EXISTS** | `projects.service.ts:421` |
| Per-project signed/pending counts | **EXISTS** (label as "חתימות"/requests, NOT "% consent") | `statsSubqueries :97–124` on every list row |
| Calendar deadlines, milestone overlay, field-work freshness | **EXISTS** | `tasks.due_at`, `signatureMilestones`, `apartments.lastContactAt/statusChangedAt` |
| Expiring-soon, momentum (+N השבוע), stalled (N days), org-pulse buckets, forecast | **DERIVABLE, no migration** | all from `signature_requests.{signedAt,expiresAt,status,createdAt}` — but need **B1** to surface honestly at scale |
| Holdout NAME ("אורי") | **DERIVABLE apartment-grained / NEEDS PII-authz endpoint for the name** | `signatureProgressApartments` returns counts, NO owner identity by design (`:451–454`) |
| Owner objection "why" / "3 בעלים מתנגדים" | **NEEDS MIGRATION** | no `decline_reason` anywhere (grep-confirmed) — the ONLY migration |

### 4.1 The four backend slices (cheapest → costliest, `05` §2)

- **B1 — `GET /api/v1/org/signature-pulse`** (NO migration, highest leverage). One call
  → `{ buckets:{active,pastThreshold,inWork,stuck}, attention: ProjectPulseRow[] }`
  (canonical schema = `05` §2.A — declared the single source so the 4 consumer docs
  don't each assume a different wire). Direct copy of the existing `orgStats`
  multi-subquery + **agent-scope CTE** (`projects.service.ts:537–581`) so an agent's
  pulse covers only assigned projects. Needs a `gen-api-docs` ENDPOINTS entry (the
  coverage guard fails CI otherwise).
- **B2 — the "why" layer** (the ONLY migration, Gate-6). `ALTER TABLE
  signature_requests ADD COLUMN decline_reason text` + widen the status CHECK to add
  `'declined'` (mirror migration **0063** which added `'expired'`) + a manager "סמן
  כמתנגד" action. Hand-author `.sql` + `_journal.json` (drizzle-kit generate is unusable
  here). Until it ships, "3 בעלים מתנגדים" is **omitted**; the honest substitute is
  "X דירות סומנו כסירוב" from `apartments.status`/`discovery_records.status`.
- **B3 — the autonomy worker** (NO migration, but NET-NEW infra — the doctrine gate).
  Grep confirms **zero schedulers/cron in the API** (`@Cron|ScheduleModule|setInterval`
  → one unrelated test); the notification producer is `emit`/`emitMany` only (synchronous,
  never clock-driven); **nothing flips a lapsed `pending` → `expired`**. So the owner's
  central "the system already chased" doctrine has **no backend today.** A single
  recurring Railway worker that (i) sweeps lapsed `pending`→`expired`, (ii) emits
  "expiring in N days" / "stalled" notifications via the existing producer, and (iii)
  once B2 lands, drives auto-reminders. **The FE must NOT imply autonomous chasing
  until B3 ships.**
- **B4 — the PII-authz holdout-name read** (small, audited, no migration) — surfaces the
  holdout's NAME for the one-tap chase; owners are PII (reveal-on-demand, gated
  `view_owner_pii`).

### 4.2 The hard DO-NOT-FABRICATE list (binding on every FE slice, `05` §4)

| Copy / signal | Status until its slice ships |
|---|---|
| **"נזכיר שוב בעוד 3 ימים" / any future-nudge promise** | ❌ FORBIDDEN until **B3**. Ship the honest one-tap "נשלחה תזכורת לאורי" (no future tense). |
| **"3 בעלים מתנגדים" / objection count or reason** | ❌ FORBIDDEN until **B2**. Substitute "X דירות סומנו כסירוב" if a "why" is wanted. |
| **"+N השבוע" / "אין תנועה N יום" / pulse buckets / forecast** | ❌ omit until **B1** ships the field. Forecast: even then SUPPRESS at velocity≈0 / tiny N. |
| **The holdout's NAME ("אורי")** | ❌ until **B4**; show "דירה 7 · partial" (apartment-grained) meanwhile. |
| **"שלחנו 3 תזכורות אתמול" / any "the system acted" claim** | ❌ until **B3** — today nothing acts on a clock. |
| **Any unqualified consent % as a legal/threshold claim** | ❌ always until OD-1 — must carry its denominator label (§6.1). |
| **Relative times near a day boundary** | ⚠ buggy today — see §4.3. |

**Rule of thumb:** pulse-sourced signals are dark until B1; signature-progress / list-stats
/ milestones / apartment-timestamps are live now; any copy asserting the system *acted*
is dark until B3.

### 4.3 The cross-cutting correctness bug the panel missed (completeness §A, P0)

`lib/format.ts` `formatRelative` (used by **18 adapters**) pins **no timezone** — it
diffs against the device clock and rounds day-boundaries with
`Math.round(deltaMs/86_400_000)`. The hard rule is "store UTC, **display
Asia/Jerusalem**" (only `formatJerusalem`, used solely in the audit log, honors it).
So the chase loop's "פג מחר/היום" can flip by up to the IDT offset near midnight — a
**confidently-wrong** signal the doctrine forbids. **Fix (P-TZ-1):** anchor both "now"
and the target to `Asia/Jerusalem` before diffing; add a unit test for a UTC instant near
the IDT day boundary. This gates the honesty of the entire expiry-chase.

---

## 5. The prioritized, dependency-ordered slice roadmap

**Universal gate for EVERY slice** (DoD): `pnpm typecheck && pnpm lint && pnpm test`
green (incl. the inline-color ratchet, the new class-name guard, `app-forms-no-get-fallback.spec.ts`,
adapter/sidebar specs) **AND** a real-Chrome **4-axis** verify per affected role
(`docs/DOD-BROWSER-SMOKE.md`) **AND** a North-Star check (does this surface *reduce*
actions, speak plain Hebrew, never fake a signal, stay re-skinnable?). Routes are never
deleted. Guardrails carried per slice below.

> **Sequencing logic:** front-load **zero-BE, high-perceived-value** slices so the app
> *feels* redesigned before any backend lands; run B1/B3 in parallel; gate data-hungry
> surfaces behind B1; defer the migration (B2) and the domain-blocked consent fix to
> the end. P0-cross-cutting (tz, DataState, live-region) lands in the foundation wave.

### Wave 0 — Foundation (zero-BE; no screen yet "redesigned"; everything depends on it)

| Slice | What | Guardrails / gate |
|---|---|---|
| **E2.0 Tokens** | Tier-2 semantic block in `globals.css` + semantic Tailwind mappings + **`--space-*` & `--text-*` scales** + **fix `bg-card` & `--r-lg`** + add the **default-palette class-name guard** (re-measured baseline incl. the 3 unopened surfaces, §3.5). | Additive — existing ratchet + typecheck prove it; no screen changes. Brand fork (OD-6) resolves here as a one-token edit. |
| **E2.0b StatusPill** | Re-home `status-badge.tsx` + `Button.destructive` onto tokens; **rename `statusColor`→intent** across VM + 6 adapters + 3 specs (§3.5). | `adapters/*.spec.ts` guard the rename; re-skins every list/card at once. Adopt the visual doc's full scope, not "one file." |
| **M0 + G6 — the unified announcement primitive** | Build ONE `role="status" aria-live="polite"` (+`assertive` variant) app-root live-region that is **both** `06`'s `ActionToast` (auto-dismiss, pause-on-hover, undo, concurrent-`settle`) **and** `08`'s G6 live-region. Migrate the ~4 bespoke non-dismissing inline "toasts." | **Tension 5 fusion:** these are the SAME DOM surface specced by two seats — building them separately yields a double-SR-announcement bug. Build once. Follow the `ConfirmDialog` a11y contract (ESC/trap/roles), NOT `StepUpDialog`. |
| **M1 Motion tokens** | `--motion-duration-*`/`--motion-ease-*` + `prefers-reduced-motion` guard (§3.6). | Owned here (not "jointly" — Tension 5). |
| **P-TZ-1 Relative-time fix** | `formatRelative` → pin Asia/Jerusalem + day-boundary unit test (§4.3). | Cross-cutting correctness; gates chase-loop honesty. |
| **C2 `<DataState>` contract** | One wrapper (loading skeleton / calm error+retry / **403 access-denied muted, no retry** / guided empty), generalizing the import page's good granular taxonomy; wires the M0/G6 live-region. **Kill "silent null on error"** (`SignatureProgressBoard` returns bare `null` — `signature-progress-board.tsx:36`). | Resolves the panel's self-contradiction (UX "never silent" vs FE "codify silent-null", completeness §7). `error.tsx` boundaries exist but don't catch null-returns. |

### Wave 1 — The structural redesign (zero-BE; the app starts to *feel* redesigned)

| Slice | What | Guardrails / gate |
|---|---|---|
| **E2.2-S1 Board-first tabs** | Flip default `useState('tenants')→'signatures'`, re-order tabs, inline the empty-CTA targets (`03` §3.2). Board content already exists. | **Scope ONLY the tab default + order** (FE-arch's pared-back E2.2). The full project-tab *merger* (docs+sig-requests → one surface; tasks+notes → Activity) is a **separate later slice**, not this one (Tension 2-B2). **Board % must carry its basis label (§6.1) from the first render.** |
| **E2-IA-S2 Sidebar 14→5** | Group Admin, drop redundant notifications line, demote notes/contractors/messages/signature-requests/documents. Keep ALL routes. | Per-role smoke: Agent still scoped, Viewer no create CTAs, demoted routes still deep-link-reachable. **Ship S4 search no later than this slice** (Tension 2-B1 — don't open a no-nav/no-search hole). |
| **S4 Global search omnibox** | Topbar control extending `POST /owners/search` (PII in body, `view_owner_pii`-gated national_id branch); GET for non-PII branches. | Reuse the existing endpoint; no `?q=` PII param. Bidi-strip dropdown `aria-label`s (G2); ephemeral results, no history (completeness §9 PII-in-motion). |

### Wave 2 — Backend-gated surfaces (run B1/B3 in parallel with Wave 1)

| Slice | What | Guardrails / gate |
|---|---|---|
| **B1 Pulse endpoint** | `GET /org/signature-pulse` (§4.1). | No migration; agent-scope CTE reused; canonical schema = `05` §2.A; `gen-api-docs` entry; stub `**/api/v1/org/signature-pulse` in affected Playwright specs. |
| **E2.1 Home mission-control** | Replace KPI grid + **delete the calendar stub** (`manager-home.tsx:115–139`); greeting + one pulse sentence + ~5 ranked `ActionCard`s; converge `AgentHome` onto the same `ActionCard`. **Migrate ManagerHome onto Pattern A** (RSC prefetch + Zod parse + TanStack) — OD: the one place this is "more than a restyle" (`07` §8, recommended converge). | Without B1, ship structure on derivable distance-signals + **omit momentum**. **Design the empty-org/first-run state distinctly** (completeness §4): "ניצור את הפרויקט הראשון", NOT the "הכול זז יפה" reward (that copy is dishonest on a brand-new org). |
| **E2.2-S3 Board-first content** | Lift the board out of tab-4 into the default surface; wire real `ThresholdProgress`; promote "מי תקוע" (the per-apartment drill) to a named list. | Holdout *name* needs B4; until then apartment-grained ("דירה 7 · partial"). Board never `null` (C2). |
| **M2 The one chase loop** | `resendSignatureRequest` wrapper (**`postIdempotent`**) + `useRemindSignatureRequest` (optimistic — extend the twice-shipped `applyApartmentStatus`/`notifications-optimistic` pattern; the `prev` snapshot IS the undo) + ONE shared `<RemindHoldoutButton>` across home card / project "מי תקוע" / owner row. | Endpoint exists (`signature-requests.service.ts:748`, audited, 409-guarded); FE just wraps it. **No future-nudge copy until B3** (§4.2). Treat server `expiresAt` as authoritative (a tenant `resendForOwner` can also rotate the clock). Optimistic flip must distinguish "sent" from "queued/failed offline" (completeness §6). |
| **E2-list Projects-list full-power** | `ProjectRow` enrichment (real counts now), filter-by-status, **sort-by-distance now**, URL-state. Surface גוש/חלקה (on the VM, zero BE). | **Sort-by-momentum gates on B1** — omit until then (the list already models this with `dataPendingHint`). Make search honest (label "סינון בעמוד הזה" until server search). |

### Wave 3 — The "movie" + the honest autonomy (gated on backend + owner)

| Slice | What | Guardrails / gate |
|---|---|---|
| **M3 Wow 1+2** | "כמעט שם" finish-line phrase + threshold-bar fill + on-screen "crossed the line" celebration (client-cache edge-diff of `metThreshold`). | Calm/dignified, never confetti. **Gate the celebration on the same basis-correctness rule as the headline** (Tension 7 — else it celebrates a legally-wrong crossing). On-screen edge only fires while watching; a server "threshold reached" notification is the richer follow-up (OD / B3). |
| **B3 Autonomy worker** | The expiry-sweep + time-based notifications + (post-B2) auto-reminders (§4.1). | **Unlocks the "it'll keep nudging" copy** — and only then. The doctrine's literal truth. |
| **M5 Campaign narration** | Wrap the campaign send in the ONE justified `ConfirmDialog` ("נשלח ל-N בעלים שטרם חתמו"); migrate its lingering success line to M0. | Multi-owner send to real phones is the only routine confirm that survives "undo over confirm." |
| **B2 The "why" layer** | The migration + "סמן כמתנגד" action; then unhide "X בעלים מתנגדים" (§4.1). | Gate-6 schema; until merged, the phrase stays omitted. |
| **P0-FIX Consent correctness** | Share-weighted + per-building consent calc (§6.1). | **Blocked on OD-1.** Until decided, the basis label is the interim safety mechanism. |

### Wave 4 — Completeness surfaces the panel under-scoped (prioritize per persona impact)

These are real, code-grounded gaps the council missed (completeness §0–§11). Slot by
owner priority; **C0–C3 are P0-class** despite landing logically after the core triad:

- **C1 Committee submission / print-of-record (P0, net surface):** there is **no
  print/PDF path anywhere** (grep = one incidental hit). The product's *raison d'être* —
  taking signed consents + the tally to the וועדה/lawyer — has no artifact. At minimum a
  print stylesheet for the board/tally; the artifact MUST carry the **basis-labeled**
  number (§6.1) — a printed legal claim with no denominator is the most dangerous
  fabrication the product could emit.
- **C4 Offline banner + paused mutations (P1):** mutations are `retry:0` (correct — `postIdempotent`
  mints a fresh UUID), but there is **no `navigator.onLine` signal, no offline banner**.
  A flaky field connection silently drops the chase send with a generic error — the exact
  anxiety the redesign exists to remove. Add a connectivity banner + paused-mutation
  handling; the optimistic flip must not show "נשלחה תזכורת" for a send that dropped offline.
- **C5 Project-creation wizard (P1):** the **1468-line** `projects/new/page.tsx` (largest
  client file, opened by no seat) is the יזם's *first deep interaction* — the densest,
  most "appy" surface, guaranteed to set or destroy the emotional tone. Apply the
  "propose, don't ask / smart defaults / one primary action per step" doctrine; include
  it in the re-skin sweep.
- **C7 Contractor share view (P1):** the יזם's primary *external* deliverable; carries the
  `StatusBadge` + `var(--navy-*)` leaks and drops the BE lifecycle status to one opaque
  `invalidLink`. Bring into the calm/token rubric.
- **C8 Import flow (P1, analysis + precedent):** the **live SSE** import flow
  (`use-import-progress.ts`, 11 EventSource/aria-live refs) **disproves the "no real-time"
  premise** and its **preview/confirm pause** is the best "approve, don't construct"
  precedent in the codebase — M1/G6 must reconcile with it (don't ship a second live-update
  idiom). Include its raw `bg-amber-*`/`bg-blue-*` in the sweep.
- **C6 Scale-at-N across all lists (P1):** "triage at scale" was honored for the home,
  abandoned for owners/tasks/notes/signature-requests (all likely page-local client filter).
  The chase queue needs **list-level** triage (sort by expiring-soonest / stalled-longest),
  not just an enriched row.
- **C10 Discovery/field-work FE (P2, scope decision):** `discovery_records` (migration 0066)
  has **no FE at all** — half the workflow ("find the owner") is backend-only. The board's
  SHELL state and the interim "why" substitute are unbuildable until a data-entry surface
  exists. Owner must decide: E2 scope or post-MVP.
- **C11 (P2):** notifications-as-momentum feed (the doctrine's "notify, don't task" — the BE
  doesn't even *emit* a threshold-reached notification today), the *populated* calendar
  (`tasks.due_at` is real), multi-user concurrency (`refetchOnWindowFocus:true`; surface the
  resend 409 calmly to user B as "כבר נשלח על ידי [שם]"), and the tenant-OTP counterparty
  outcome.
- **M6 StepUpDialog a11y retrofit:** it lacks the ESC/focus-trap/`aria-describedby` that
  `ConfirmDialog` has (a11y G1) — schedule it; it's the modal a fearful user hits revealing
  a phone number.

---

## 6. The resolved tensions (what synthesis binds, so the build can't re-open them)

**Tension 1 — board-first vs the legally-wrong % (OWNER on the rule; SYNTHESIS on the
interim).** Resolved by a **binding interim rule (§6.1)** + escalation of the rule to
**OD-1**. Board-first ships, but never as a bare legal claim.

**Tension 2 — nav 14→5 vs migration safety/calm.** Resolved: adopt FE-arch's scoping
(sidebar `items[]` regroup is the cheap slice; the project-tab *merger* is a separate
later slice, NOT part of board-first) **and** ship **global search no later than the
sidebar collapse** so the demoted six are never strand­ed. Tasks-5-vs-4 → low-stakes OD.

**Tension 3 — "calm nudging" copy vs what the backend can deliver.** Resolved by the
**DO-NOT-FABRICATE list (§4.2)** as a binding register, and by **rewriting every
illustrative example** (incl. the North Star's own "3 בעלים מתנגדים" and "נזכיר שוב")
to the honest interim string so a builder copying examples can't ship a lie. The
capabilities themselves are owner decisions (B2/B3); not shipping the copy until they
exist is non-negotiable.

**Tension 4 — StatusBadge leak scope/guard.** Resolved (§3.5): adopt the visual doc's
**35-file / 79-occurrence scope + the new class-name guard now (not follow-up) + the
`tone` rename now**. Overrule the "one file / keep-contract / guard-later" framing.

**Tension 5 — double-owned tokens + duplicated primitives.** Resolved by assignment:
spacing/type → E2.0 (visual owns values, FE wires Tailwind); motion → M1 (interaction);
pulse schema → `05` §2.A canonical. **And fuse `ActionToast` (M0) + the a11y live-region
(G6) into ONE primitive** — they are the same `role=status aria-live=polite` surface;
building separately = a double-announcement bug.

**Tension 6 — calm vs legitimately-dense power surfaces.** Resolved by the depth rule:
**calm/whitespace is a depth-1 (home + card) contract; depth-3 power surfaces (owners
table, full projects list, the lawyer-facing multi-basis consent breakdown) are allowed
— even required — to be dense, reached by a tap.** The domain's three-basis board
resolves as progressive disclosure: headline = one basis-labeled line; heads/per-building
breakdown one tap deeper.

**Tension 7 — celebration honesty / AgentHome-as-precedent.** The threshold celebration
inherits the basis-correctness gate (§6.1). AgentHome is the *structural* precedent but
is the **worst inline-`var(--…)` leak offender (~15 sites)** — **clean its tokens in
E2.0 before promoting its shape**, don't just copy it. ManagerHome's off-seam fetch is
the *data-pipeline* anti-pattern, converged in E2.1.

### 6.1 The binding interim consent rule (the single most important written rule)

Until OD-1 is decided, **no slice may render an unqualified consent % as a legal or
threshold claim.** Every % carries its **denominator label** ("לפי שיעור הבעלות" vs
"לפי ראשי דירות") and the count sentence ("23 מתוך 40 דירות חתמו" — *not* a legal claim)
leads where possible (`01` §3.4 + `03` R5 give the exact copy). The council can assert,
on its own authority, only the **code-provable** framing: *the app today shows a bare %
with no named denominator and gates its green bar on apartment-headcount
(`projects.service.ts:398–421`) while the registered ownership share
(`ownerships.share_numerator/denominator`, stored, DB-guaranteed to sum to 1 per
migration 0065) is never read.* It **cannot** assert which denominator is legally
correct — that is `[LEGAL — CONFIRM]` (OD-1/OD-rule). Board-first **amplifies** this, so
the label is mandatory from the first board-first render, and the print artifact (C1)
and the threshold celebration (M3) inherit the same rule.

---

## 7. What is deferred + still uncertain

**Deferred by sequence (not dropped):**
- The project-tab **merger** (docs+sig-requests → one in-project surface; tasks+notes →
  Activity) — separate later slice after board-first (Tension 2).
- Saved views (S5) — URL-state filters first (E2-list), persistence later.
- Forecast (#11) — derivable but noisy; omit until velocity is meaningful.
- Per-owner deal terms, estate/POA flags, cancellation reason, lifecycle-after-`approved`
  (relocation tracking) — real-workflow gaps (`01` §6 #10–15), likely post-MVP.
- Discovery/field-work FE (C10), populated calendar, notifications-as-momentum (C11) —
  owner-prioritized.

**Genuinely uncertain / un-resolvable by the council:**
- **The legal consent basis and exact statutory %** — domain/lawyer input, NOT a
  code-grounded claim. The reality critic's #1 residual risk: do not let synthesis
  promote the flagged legal claim to a fact.
- **Contrast + RTL claims are computed/static, not rendered** (`08` §9) — `--text-muted`
  sits at ~4.76:1 (fails on tinted surfaces → use `--ink-600`); the wizard `ArrowLeft`
  RTL direction is `[UNVERIFIED]`. Carry the "verify in real Chrome + a Hebrew
  screen-reader pass" gate forward; do not treat computed ratios as a passed audit.
- **Whether `en` is a real shipping locale** — status labels render Hebrew regardless of
  locale today (`adapters/project.ts STATUS_LABELS`); if en is real it ripples into
  domain/visual/IA scope no other doc budgeted (OD-5).
- **Hebrew plural/dual copy** ("שתי חתימות") — needs ICU plurals + a native-Hebrew copy
  review, not dev string concatenation (`08` I3).
- **G-MOTION-PERF** — animating the hero number on every home load risks the LCP budget
  the perf work fought (warm 200ms; Heebo limited to 3 weights for LCP). Reconcile motion
  with the perf baseline before shipping count-up on the home.

---

## 8. Source map (the load-bearing artifacts this plan stands on)

- **Consent calc / spine:** `apps/api/src/modules/projects/projects.service.ts`
  (`signatureProgress` L355–435, `signatureProgressApartments` L456–526, `orgStats`/
  agent-scope CTE L537–581, `statsSubqueries` L97–124); share integrity
  `packages/db/migrations/0065_ownership_share_fraction.sql`; the pixel
  `projects/[id]/_components/signature-progress-board.tsx`.
- **Chase endpoint (FE gap):** backend `signature-requests.service.ts:748` (`resend`,
  audited, 409-guarded) + `:927` (`resendForOwner`); FE `lib/api/signature-requests.ts`
  (no `resend` wrapper); optimistic precedents `use-apartments.ts` + `notifications-optimistic.ts`.
- **No autonomy:** grep `@Cron|ScheduleModule|setInterval` over `apps/api/src` → zero
  production hits; `notifications-producer.service.ts` `emit/emitMany` only.
- **Tokens / leak:** `apps/web/src/app/globals.css`, `apps/web/tailwind.config.ts`,
  `models/project.vm.ts:28`, the 6 adapters + 3 specs (§3.5), `status-badge.tsx`,
  `app-no-new-inline-colors.spec.ts` (hex-only ratchet).
- **IA:** `_components/sidebar.tsx:113–145`, `project-detail.client.tsx:79`,
  `middleware.ts`, `agent-home.tsx`/`manager-home.tsx`.
- **Cross-cutting bugs:** `lib/format.ts` `formatRelative` (no tz, 18 adapters);
  `_components/notifications-bell.tsx:81` (`-right-1`→`-end-1`); no print path; no
  app-root live-region.
- **Unopened surfaces (completeness):** `projects/new/page.tsx` (1468 lines),
  `imports/[id]` + `use-import-progress.ts` (live SSE), `(contractor)/contractor/share/page.tsx`.
- **Council inputs:** `docs/design-research/v2/01..08` + `CRITIQUE-{reality,completeness,coherence}.md`;
  rubric `docs/DESIGN-NORTH-STAR.md`.
