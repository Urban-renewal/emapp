# 07 — Frontend Architecture (EMAPP E2 redesign, second pass)

> **Role:** Frontend-architecture expert — *how* to build the redesign on the
> REAL stack, safely and incrementally. This is the second-pass doc; it
> supersedes the shallow first pass by grounding every claim in real files,
> real wire fields, and the real RSC/TanStack/adapter layering that already
> ships.
>
> **Companions (read these for the *what*):** `docs/DESIGN-NORTH-STAR.md` (rubric),
> `docs/design-research/v2/00-MASTER-PLAN.md` + `01..06`, the IA proposal
> (`docs/design-research/03-information-architecture.md` and its v2 sibling),
> the visual-system proposal (`docs/design-research/05-visual-system.md` /
> v2 `04-visual-design-system.md`), `apps/web/CLAUDE.md` (RTL / Heebo /
> NameDisplay / security rules), and the perf-research RSC notes referenced
> throughout the codebase (`perf-research/01-rsc-waterfall.md`).
>
> **Scope:** the org tier (`(dashboard)` route group). Tenant portal
> (`(tenant)/portal`), contractor share-view (`(contractor)`), public signer
> (`/sign/[token]`), and the provider console (`PCSidebar`) are separate IAs and
> are touched here only at the seams.

---

## 0. TL;DR

The EMAPP frontend is **already well-architected for this redesign**. It has a
clean, enforced 4-layer data path (wire → `lib/api/*` Zod-parse →
`adapters/*` pure VM → `hooks/use-*` TanStack → `'use client'` component) and a
**mature RSC server-prefetch pattern** (`prefetchToDehydratedState` +
`*.server.ts` + plain `*.keys.ts`) that kills the post-hydration fetch waterfall
on the list/detail pages. The redesign is therefore a **composition + token +
prefetch-extension** job, **not** a data-layer rewrite. Key grounded findings:

1. **The hero components map almost 1:1 onto existing pieces.** `StatusPill` ←
   `components/ui/status-badge.tsx`; `ThresholdProgress` ← the existing
   `SignatureProgressBar`/`SignatureProgressBoard` + the `.progress` class;
   `ProjectRow` ← `projects-list.client.tsx` rows; `StatCard` ← the `ManagerHome`
   KPI cards; and `ActionCard` is the one genuinely-new component — `AgentHome`
   (`_components/agent-home.tsx`) is already the correct *shape* for it.

2. **There are TWO server-fetch patterns in the tree, and they must converge.**
   The list/detail pages use the **good** pattern (`prefetchToDehydratedState`
   → `HydrationBoundary` → the client hook hydrates synchronously). But
   `ManagerHome` (`_components/manager-home.tsx`) uses a **second, ad-hoc**
   pattern: a raw `fetch(`${base}/api/v1/org/stats`)` against
   `NEXT_INTERNAL_API_URL` with hand-rolled cookie forwarding, no Zod parse on
   the happy path (just a cast), and no TanStack seeding. The home redesign
   should **migrate the home onto the prefetch pattern**, not extend the ad-hoc
   one. (§3, §5.5.)

3. **The "list rows show `—`" claim in the IA/master docs is partly STALE.**
   The project list **already carries** `signaturesSignedCount`,
   `signaturesPendingCount`, `buildingsCount`, `unitsCount`, `agentsCount` per
   row (`projects.service.ts` `statsSubqueries`, parsed by
   `ProjectListItemSchema`, mapped by `adapters/project.ts`). What is genuinely
   missing for triage is **momentum (days-since-last-signature)**,
   **threshold-distance ordering**, and the **org-level pulse** (the home's
   `orgStats` is only 4 scalar counts). So a lot of the redesign can ship on data
   **already on the wire** — and the new BE work is smaller than the master plan
   implies. (§2, §7-B1.)

4. **Tokens flow cleanly only if components stop reaching past the semantic
   layer.** Today components mix `var(--text)` (semantic, good), `var(--navy-900)`
   (primitive), `bg-amber-100` (Tailwind default — invisible to re-skin), and
   inline `style={{...}}`. The redesign's Tier-2 token discipline is a
   **prerequisite** for the hero components; it ships first as additive
   `globals.css` + `tailwind.config.ts` changes that break nothing. (§4.)

5. **Slice-by-slice is safe because the architecture isolates risk by file.**
   Every page is `(server page.tsx) + (client *.client.tsx)`; the data path is
   pure and tested per-layer; routes are never deleted (the IA migration is
   re-composition). The dependency-ordered sequence (§6) front-loads zero-BE wins
   (token foundation, project-tab reorder, sidebar collapse) and gates the
   data-hungry surfaces (home mission-control, sort-by-momentum) behind one new
   BE endpoint. (§6, §7.)

**The one owner-decision this doc surfaces** (beyond the domain/consent decision
other docs raise): **do we converge `ManagerHome` onto the RSC-prefetch pattern
as part of E2.1, or leave the ad-hoc `fetch` and just restyle?** Converging is
the architecturally correct call and removes a real second-pattern liability, but
it is slightly more than a pure restyle. See §8.

---

## 1. The real architecture (grounded)

### 1.1 The 4-layer data path (enforced, reuse as-is)

Every org-tier entity follows the same vertical, documented in `apps/web/CLAUDE.md`
§Architecture and visible across `hooks/`, `adapters/`, `models/`, `lib/api/`:

```
wire (NestJS { data } envelope)
  → lib/api/<entity>.ts        defensive Zod parse on EVERY response
  → adapters/<entity>.ts       pure wire→ViewModel fn (no hooks, no I/O)
  → models/<entity>.vm.ts      the ViewModel type the component consumes
  → hooks/use-<entity>.ts      TanStack useQuery/useMutation; select=adapter
  → <screen>.client.tsx        'use client'; consumes ONLY the VM
```

Grounded example — projects: `lib/api/projects.ts` (`listProjects`/`getProject`),
`adapters/project.ts` (`toProjectViewModel` — owns the Hebrew status/type label
maps + `statusColor` + bidi-strip), `models/project.vm.ts` (`ProjectViewModel`),
`hooks/use-projects.ts` (`useProjectList`/`useProject` with a memoised `select`
keyed on locale — §PERF-H3), and `projects/[id]/project-detail.client.tsx` (the
screen).

**Why this matters for the redesign:** the design layer (tokens, components,
copy) lives **entirely in Tier 3** (`*.client.tsx` + `components/`). The redesign
can rebuild every screen's *presentation* without touching the parse, adapter,
VM, or hook. The Hebrew labels and `statusColor` semantics are already in the
adapter (`adapters/project.ts:39-55`) — the redesign **consumes** them, it does
not re-derive them. This is the single biggest safety property of the effort.

> **Note on `statusColor` values.** The adapter today emits literal color names
> (`'gray' | 'amber' | 'emerald' | 'red'` — `adapters/project.ts:48-55`) which
> the visual-system doc correctly flags as a re-skin leak. When `StatusPill` is
> built, the *semantic* rename (`neutral|warning|success|danger`) happens in the
> adapter + VM, NOT in the component. That is a one-file change in the pure layer
> with a unit-test (`adapters/project.spec.ts` already exists) — low risk, no
> screen touched.

### 1.2 The RSC server-prefetch pattern (the good pattern — extend it)

This is the load-bearing architectural asset. The pattern
(from `perf-research/01-rsc-waterfall.md`, implemented in `lib/query/prefetch.ts`):

- **`lib/query/prefetch.ts`** — `prefetchToDehydratedState(prefetches[])`: runs
  N prefetches **in parallel** into a throwaway request-scoped `QueryClient`,
  swallows any rejection (a failed prefetch → empty cache → client refetches),
  and returns `dehydrate(qc)`. **PLAIN server module, NO `'use server'`**
  (Turbopack would register every export as a runtime action and 500 on
  non-async/non-function exports — `prefetch.ts:11-18`).

- **`lib/api/<entity>.server.ts`** — the server twin of `lib/api/<entity>.ts`.
  Lives in a separate module on purpose so `next/headers` never enters the client
  bundle graph (`projects.server.ts:1-16` documents exactly this — `projects.ts`
  is imported by `'use client'` pages, so pulling `next/headers` into that graph
  breaks the client build). It runs the **identical Zod parse** as the client
  queryFn, so the dehydrated cache entry is byte-identical to what the client
  would produce.

- **`hooks/use-<entity>.keys.ts`** — a PLAIN module (NO `'use client'`) holding
  the query-key builders, so **both** the server page and the client hook import
  the SAME builder. Key parity is load-bearing: `projectsListQueryKey({limit:25}, locale)`
  must hash byte-for-byte identically on server and client, or the prefetch is a
  silent cache miss (`use-projects.keys.ts:1-11` documents the boundary crash
  that forced this split).

- **`<entity>/page.tsx`** — async Server Component: narrows the locale
  (`getLocale()` → `'he'|'en'`), calls
  `prefetchToDehydratedState([qc => qc.prefetchQuery({queryKey, queryFn: serverFetch})])`,
  wraps the client island in `<HydrationBoundary state={dehydratedState}>`.
  Failure posture: the server fetch throws on any failure → swallowed → empty
  dehydrated state → the client hook transparently runs its own loading/error UI.
  **The page never throws** (`projects/page.tsx:30-54`).

Ten `*.server.ts` files already exist (audit, contractors, documents, members,
notes, notifications, owners, projects, signature-requests, tasks). The list
pages (`projects`, `owners`, `tasks`, `notifications`, `members`, `audit`,
`contractors`, `documents`, `signature-requests`, `notes`) and the detail pages
(`projects/[id]`, `owners/[id]`, `tasks/[id]`) already use it. **The redesign
extends this pattern to any new surface; it never invents a new fetch path.**

### 1.3 The session seed (the third prefetch idiom — already correct)

`QueryProvider` (`_components/query-provider.tsx:73`) seeds the TanStack cache
with the server-resolved profile under `SESSION_ME_QUERY_KEY` (`['session','me']`),
so `useSessionProfile()` resolves the role **synchronously on first paint with
zero `/me` fetch** (`use-session.ts:18-26`). This is the mechanism
`useHasPermission` (the FE gating used by the sidebar and every permission-gated
CTA) reads from. **The redesign's gating is free** — new components just call
`useHasPermission(cap)`; the seeded session already backs it.

### 1.4 The page/island split (the safety boundary)

Every `(dashboard)/<entity>/page.tsx` is the (now async) Server Component that
prefetches; the actual UI is a sibling `*.client.tsx`. This split is *the*
property that makes slice-by-slice safe: a redesign slice touches the
`*.client.tsx` (presentation) and optionally the `page.tsx` (add a prefetch), but
the data path (parse/adapter/VM/hook) is shared and tested. A broken slice is
contained to one screen's island.

> **Documented debt (`apps/web/CLAUDE.md` §v9-M-1):** the *islands themselves* are
> still `'use client'` — the server page only prefetches, it doesn't render
> server HTML for the list body. That is an accepted trade for uniformity. The
> redesign should **not** try to convert islands to pure Server Components as part
> of E2 — that is an orthogonal perf refactor and would double the surface area of
> every slice. Keep the island pattern; restyle inside it.

---

## 2. What the wire already gives us (grounding "omit, never fake")

The North Star forbids fabricated signals. So the architecture question for each
redesign signal is: **already on the wire, one adapter away, or genuinely a new
BE slice?** Grounded answers (read from the real service + schema):

### 2.1 Per-project signature counts — ALREADY ON THE WIRE ✅

`projects.service.ts` `statsSubqueries` (`:97-124`) attaches to **every project
list row AND the single-record get**: `buildingsCount`, `unitsCount`,
`signaturesPendingCount`, `signaturesSignedCount`, `agentsCount`. Parsed by
`ProjectListItemSchema`, mapped by `toProjectViewModel` (`adapters/project.ts:104-112`).
`project-detail.client.tsx:201-216` already renders `signed/(signed+pending)` and
`agentsCount`.

> **Correction to the IA/master docs:** the claim that project-list rows show `—`
> for חתימות/threshold (cited as `AUDIT-CHECKLIST.md:850`) is **stale for the
> count**. The counts are present. What *is* `—` on the project *detail* header is
> **contractor name** (genuinely unwired — `project-detail.client.tsx:191`). The
> redesign's `ProjectRow` can show real "X/Y signed" today.

### 2.2 Threshold (target consent %) — ALREADY ON THE WIRE ✅

`targetSignaturePct` rides on every project (`adapters/project.ts:76` →
`targetConsentPct`), defaulted per renewal-track on create
(`projects.service.ts:600-603`, `PROJECT_TYPE_DEFAULT_CONSENT_PCT`). The
`ThresholdProgress` marker position is computable **today**. The dedicated
`signatureProgress(projectId)` endpoint (`projects.service.ts:355`) additionally
returns `consentedPct` + `metThreshold` (the `SignatureProgressBoard` already
consumes it — `adapters/project.ts:129-141`).

### 2.3 Distance-to-threshold — DERIVABLE, no BE ✅

`signed`, `signed+pending`, and `targetSignaturePct` are all present →
"one signature from crossing" is a **pure adapter computation**. No new endpoint.
This is the highest-value triage signal and it costs zero BE.

### 2.4 Momentum (days-since-last-signature) + org pulse — NEW BE ❗

The home's `orgStats` (`projects.service.ts:537-581`) returns ONLY four scalars:
`activeProjects`, `residents`, `signaturesReceived`, `signaturesPending`. There is
**no per-project last-signature timestamp**, **no velocity/stalled bucket**, and
**no expiring-soon count** on any current endpoint. So:

- **"זז יפה, +2 השבוע" / "אין תנועה 18 יום"** → needs a new aggregate (B1,
  `GET /org/signature-pulse`). The data exists in `signature_requests` (signed
  timestamps; migration 0063 added `'expired'`), it just isn't aggregated. Until
  B1 ships → **omit the momentum line, never fake it.**
- **The home's "needs you now ~5"** → approximable *client-side today* from the
  project list (distance-to-threshold, §2.3) but **without momentum** the triage
  is incomplete. Ship the home structure on the derivable signals first; add
  momentum when B1 lands.

### 2.5 The human "why" (objection reason) — NEW BE + migration ❗

No `decline_reason` / objection field exists on `signature_requests` (the status
enum is the only signal). This is the **only genuine new-data migration** (B2 in
the master plan). Until it ships → **omit "3 בעלים מתנגדים", never fake it.**

**Net:** ~3 headline signals are buildable with **zero BE** (counts, threshold,
distance), one needs an aggregate endpoint (momentum/pulse), one needs a
migration (the "why"). The redesign's *structure* can land entirely on the
zero-BE signals and reveal the rest as they arrive — "omit, don't fake" expressed
as a build sequence.

---

## 3. The two server-fetch patterns (a real liability to resolve)

The most important architectural finding for the **home** slice.

**Pattern A (good, dominant):** `prefetchToDehydratedState` → `HydrationBoundary`
→ client hook hydrates. Used by 13 pages. Zod-parsed, key-parity-guarded,
failure-degrades-to-client-refetch, TanStack-cached (so invalidation /
refetch-on-focus works). §1.2.

**Pattern B (ad-hoc, isolated to the home):** `ManagerHome`
(`_components/manager-home.tsx:31-45`) does a raw
`fetch(`${base}/api/v1/org/stats`, { headers: { cookie }, cache: 'no-store' })`
against `process.env['NEXT_INTERNAL_API_URL'] ?? 'http://localhost:3001'`, casts
the JSON (`json.data as OrgStats`, no Zod parse), and renders. It is **not**
seeded into TanStack, so:

- it has **no client-side cache, no refetch-on-focus, no invalidation** — the
  numbers are frozen until a full navigation;
- it uses a **different env var** (`NEXT_INTERNAL_API_URL`) and **hand-rolled
  cookie forwarding** instead of `serverApiGet`'s host-allowlist + 15s-timeout
  posture (documented in `projects.server.ts`);
- it **skips the defensive Zod parse** every other wire read enforces
  (`apps/web/CLAUDE.md` "defensive Zod parse on every response").

**Recommendation:** when the home is redesigned (E2.1), **migrate it onto Pattern
A**: create `lib/api/org-stats.server.ts` (`serverGetOrgStats` with the real
`OrgStats` Zod parse), an `org-stats.keys.ts`, a `use-org-stats.ts` hook, and have
`(dashboard)/page.tsx` prefetch it. This removes the second pattern, restores
caching/invalidation, and brings the home up to the same parse/security posture as
every other surface — **before** layering the richer pulse data on top. It is a
small, contained refactor, but **more than a pure restyle** → the owner-decision
in §8.

---

## 4. How design tokens flow through the layers

### 4.1 Where tokens live today

- `globals.css :root` — shadcn HSL vars (`--primary 172 83% 26%` teal) **+**
  partner hex aliases (`--bg-app`, `--text`, `--navy-*`, `--success-*`, …). This
  file is declared the **canonical color source** (its own "CANONICAL COLOR
  SOURCE (P1-2)" header block).
- `tailwind.config.ts` — **duplicates** the partner ramps as raw hex under
  `theme.extend.colors` (flagged "KNOWN DUPLICATION … keep in lock-step").
- Components consume a **mix**: `var(--text)` (semantic, good), `var(--navy-900)`
  (primitive — leaks), `bg-amber-100` (Tailwind default — invisible to re-skin),
  and inline `style={{ color: 'var(--text)' }}` (works but verbose). Visible in
  every screen I read (`manager-home.tsx`, `project-detail.client.tsx`,
  `agent-home.tsx`, `sidebar.tsx`).

The ratchet `src/app-no-new-inline-colors.spec.ts` blocks **new inline
hex/rgb/hsl** but (by its own admission) does **not** catch Tailwind
default-palette class names. So `bg-amber-100` in `status-badge.tsx` is a silent
re-skin hole.

### 4.2 The token-flow the redesign establishes (additive, breaks nothing)

1. **Add a Tier-2 semantic block to `globals.css`**: `--brand`, `--brand-fg`,
   `--surface*`, `--status-{success,warning,danger,info,neutral}-{bg,fg}`, the new
   `--space-*` scale, the new `--text-*` size/line tokens, `--radius-*` aliases.
   **Additive** — the existing shadcn HSL + partner hex become Tier-1 sources;
   nothing is removed; every current screen keeps rendering.
2. **Add semantic Tailwind mappings** (`tailwind.config.ts`): `brand`, `surface`,
   `status-*-bg/fg`, the `space`/`fontSize`/`borderRadius` aliases → so components
   author in Tailwind (`bg-surface p-card rounded-card text-body`) and every
   utility resolves to a Tier-2 var.
3. **Hero components consume Tier-2 ONLY** — never `bg-navy-900`, never
   `bg-amber-100`, never inline hex. The status pill re-homes onto the existing
   token-correct `.badge-success/-warning/...` classes in `globals.css` (those
   already use `var(--success-*)` — only `status-badge.tsx` leaks).
4. **The ratchet baseline DROPS each slice.** Every component re-homed onto tokens
   removes inline-color debt → lower `BASELINE_OCCURRENCES`. Treat a lowered
   baseline as a deliverable.
5. **Add the default-palette guard** the ratchet can't see: a small static spec
   flagging `(bg|text|border|ring)-(gray|slate|amber|emerald|red|…)-[0-9]` in
   `components/ui/*` and pages. The one new guardrail.

**Why this is safe:** all of (1)–(2) are additive and verified by the existing
ratchet + typecheck. Components migrate **opportunistically as each screen is
touched** — no big-bang. A re-skin then = edit `globals.css` Tier-1; no `.tsx`
touched. Per-org branding + dark mode fall out for free (both just re-point Tier-2
aliases on a scoped root — `.dark` already exists). The redesign does NOT fork
components for either; if it's tempted to, the layering is being violated.

---

## 5. Component mapping — existing piece → hero component

### 5.1 `ActionCard` (the home triage card) — NEW, modeled on `AgentHome`

- **The genuinely-new component.** No existing single-project "needs you now"
  card. But `AgentHome` (`_components/agent-home.tsx`) is **already the right
  shape**: per-section cards, a list of project rows each linking to
  `/projects/[id]`, `<NameDisplay>` on every name, `<StatusBadge>` per row, and
  per-section empty/loading/error (`agent-home.tsx:91-122`). **Build `ActionCard`
  by extracting that project-row block and enriching it** with the plain-Hebrew
  situation sentence (§2.3 distance now; §2.4 momentum when B1) + one primary
  action.
- **Boundary:** the home is a Server Component (`(dashboard)/page.tsx`) that
  prefetches and branches role (it already does — `page.tsx:30-38`). The triage
  list is a **client island** (needs `useHasPermission` for the action gate +
  TanStack for invalidation after a chase action). So: server page prefetches the
  pulse/list → `<HydrationBoundary>` → `<ManagerHome>`/`<AgentHome>` island
  renders `ActionCard[]` hydrated from the seeded cache.
- **Data:** distance-to-threshold from the existing project-list wire (§2.3)
  **now**; momentum/why from B1/B2 **when they land** (omit until then).

### 5.2 `ThresholdProgress` ← `SignatureProgressBar` + `SignatureProgressBoard`

- **Exists in two forms already.** `SignatureProgressBoard`
  (`projects/[id]/_components/signature-progress-board.tsx`, fed by
  `useSignatureProgress` → `toSignatureProgressViewModel`) shows "X מתוך Y · Z% ·
  יעד W%" with a threshold-colored bar (`barColor`: green if `metThreshold`, amber
  otherwise — `adapters/project.ts:139`). `SignatureProgressBar`
  (`_components/signature-progress-bar.tsx`) adds milestone ticks + the legal
  target marker over the raw signed/pending stats.
- **Consolidate into one token-driven `ThresholdProgress`**: the `.progress` class
  in `globals.css` is the base; add the threshold marker at the
  `targetSignaturePct` position with `inset-inline-start` (RTL-correct), the
  `aria-valuetext` words, and the success-flip on cross. **The color logic already
  lives in the adapter** — the component stays presentational.
- **Boundary:** pure presentational (no hooks); usable server- or client-side. It
  receives numbers as props.

### 5.3 `StatusPill` ← `components/ui/status-badge.tsx` (the #1 re-skin fix)

- **Re-home, don't rebuild.** `status-badge.tsx` hardcodes Tailwind defaults
  (`bg-amber-100 text-amber-800` etc.) that don't theme. Re-point it onto the
  token-correct `.badge-*` family in `globals.css` (or the §4.2 Tailwind
  `bg-status-*-bg` classes). Rename the prop union from literal colors
  (`amber|emerald|red|gray`) to intent (`warning|success|danger|neutral|info`)
  **in the adapter + VM** (`adapters/project.ts:48-55`) — one pure-layer change,
  `adapters/project.spec.ts` covers it.
- **Boundary:** pure presentational. Used by `AgentHome`, `project-detail`, every
  list — one swap re-skins them all.

### 5.4 `ProjectRow` ← `projects-list.client.tsx`

- **The full-power list row.** `projects-list.client.tsx` already renders rows with
  name + `StatusBadge` and a card/table toggle. Enrich to spec: name
  (`<NameDisplay>`) · `StatusPill` · compact `ThresholdProgress` (real counts,
  §2.1) · momentum chip (when B1) · updated-at (`tabular-nums`, Asia/Jerusalem).
  The sort-by (urgency/momentum/threshold-distance) needs B1 for momentum;
  **distance-sort works today** (§2.3).
- **Boundary:** client island (search/filter/sort interactivity); server page
  already prefetches the first page (`projects/page.tsx`).

### 5.5 `StatCard` ← the `ManagerHome` KPI cards + `.card`

- The 4 KPI cards (`manager-home.tsx:94-105`) become `StatCard`s: eyebrow label,
  hero number (`tabular-nums`), and — for the redesign — a plain-Hebrew sentence as
  the primary with the number as evidence (North Star principle 2). Built on the
  existing `.card`/`.card-pad` classes.
- **Boundary:** can be server-rendered (pure props) once the home is on Pattern A
  (§3); today it's inside the `ManagerHome` Server Component.

### 5.6 Empty / loading / error ← `ListSkeleton` + `ListPageShell`

- **Already token-correct and reusable.** `components/ui/list-skeleton.tsx`
  (shimmer, `aria-busy/aria-live`) and `ListPageShell` (which already distinguishes
  a **terminal 403** access-denied state — neutral, no retry — from a
  **retryable** error with a retry button) are exactly the calm empty/loading/error
  the North Star wants. Reuse them; upgrade the bare empty `<p>` to a richer
  reassuring empty state ("הכול זז יפה").

### 5.7 Global search omnibox — NEW (topbar), needs a BE search endpoint

- The IA's scale escape hatch. New `Topbar` control + a new **POST-body** search
  endpoint (national_id is PII — never a query param; `apps/web/CLAUDE.md` security
  checklist; results gated on `view_owner_pii`). New `lib/api/search.ts` +
  `use-search.ts` + a typed-results dropdown. A later slice (§6 S4); it does NOT
  block the structural redesign.

---

## 6. The dependency-ordered build sequence (slice-by-slice, green-gate + real-Chrome)

Every slice: `pnpm typecheck && pnpm lint && pnpm test` green (the ratchet, the
`app-forms-no-get-fallback.spec.ts`, the adapter specs, the sidebar spec) **and** a
real-Chrome 4-axis verify per affected role (`docs/DOD-BROWSER-SMOKE.md`). Routes
are never deleted (the IA migration is re-composition), so deep links +
role-gating survive every slice.

| # | Slice | Touches | BE? | Risk | Notes |
|---|---|---|---|---|---|
| **E2.0** | **Token foundation** — Tier-2 semantic block in `globals.css` + semantic Tailwind mappings + `--space-*`/`--text-*` scales + the default-palette guard spec. | `globals.css`, `tailwind.config.ts`, one new spec | none | **low** | Purely additive; existing ratchet + typecheck prove it. No screen changes yet. Foundation for all hero components. |
| **E2.0b** | **Re-home `StatusPill` + `Button.destructive`** onto tokens; rename `statusColor` to intent in the adapter/VM. | `status-badge.tsx`, `button.tsx`, `adapters/project.ts`, `*.vm.ts`, specs | none | **low** | Pure-layer + presentational; `adapters/project.spec.ts` guards the rename. Re-skins every list/card at once. |
| **E2.2-S1** | **Project tabs reorder** — the board (today tab 4 `dashboard`) becomes default tab 1; structure/docs/activity follow. NO data change. | `project-detail.client.tsx` only | none | **low** | Biggest perceived win for least risk. The board content already exists; reorder the `TabId` union + default `useState('dashboard'→'signatures')`. |
| **E2-IA-S2** | **Sidebar collapse 14→~5** — group Admin (members/audit/settings under one gated group), drop redundant notifications line, demote notes/contractors/messages/signature-requests/documents. Keep ALL routes. | `sidebar.tsx`, `sidebar.spec.ts` | none | **medium** | Role-gating preserved (it lives in `useHasPermission` + middleware + BE guard, NOT the nav grouping). Re-run per-role smoke: Agent still scoped, Viewer no create CTAs, demoted routes still deep-link-reachable. |
| **B1** | **`GET /org/signature-pulse`** — one aggregate: per-project last-signature timestamp + velocity/stalled/expiring buckets + the ~5 triage rows. Copy the `orgStats` multi-subquery + agent-scope CTE (`projects.service.ts:537`). | `apps/api` projects module + `org-stats.server.ts`/hook/keys on FE | **yes (no migration)** | **medium** | Parallel-able with E2.0–S2. Unblocks momentum/stalled/expiring honestly. Add a `gen-api-docs` ENDPOINTS entry (the coverage guard fails CI otherwise — MEMORY). |
| **E2.1** | **Home mission-control** — migrate `ManagerHome` onto Pattern A (§3: `org-stats.server.ts` + hook + prefetch), build `ActionCard[]` (distance-sort §2.3 now; momentum from B1), `StatCard` pulse, calm empty. Converge `AgentHome` toward the same `ActionCard`. | `(dashboard)/page.tsx`, `manager-home.tsx`, `agent-home.tsx`, new `org-stats.*` | depends on B1 for momentum | **medium** | The §8 owner-decision lands here. Without B1, ship structure on derivable signals + omit momentum. |
| **E2.2-S3** | **Project page board-first content** — lift the board out of tab-4 into the default surface; wire the real `ThresholdProgress` (§5.2); "who's stuck" (holdouts) via the existing per-apartment drill-down. | `project-detail.client.tsx` + `_components/signature-*` | none (existing endpoints) | **medium** | `useSignatureProgressApartments` already exists; lift it to the default view. |
| **E2-list** | **Projects list full-power** — `ProjectRow` enrichment (real counts §2.1 + compact `ThresholdProgress`), filter-by-status, sort-by-distance (now) / sort-by-momentum (after B1), URL-state (no persistence yet). | `projects-list.client.tsx` | none for distance; B1 for momentum | **medium** | Distance-sort ships without BE; momentum-sort gates on B1. |
| **S4** | **Global search omnibox** — topbar control + POST-body PII-gated search endpoint + typed results. | `Topbar`, new `lib/api/search.ts`/hook, BE search | **yes** | **medium** | The scale escape hatch; independent of the structural slices. |
| **B2** | **The "why" layer** — `ALTER TABLE signature_requests ADD COLUMN decline_reason` + widen status CHECK + a manager "mark objection" action (mirror migration 0063 'expired'). Then unhide "3 בעלים מתנגדים". | migration + `apps/api` + FE action | **yes (migration, Gate-6)** | **higher** | Until it lands, the "why" line is OMITTED, not faked. Hand-author the `.sql` + `_journal.json` (drizzle-kit generate is unusable here — MEMORY). |
| **S5** | **Saved views** — named filter presets. | projects list + small BE store | **yes** | **higher** | Only if the many-projects pain warrants it. Ship URL-state filters (E2-list) first. |
| **P0-FIX** | **Consent-correctness** — ownership-share-weighted + per-building consent (`ownerships.share_numerator/denominator`, stored, unused). | `signatureProgress` service | **yes** | **higher** | **Blocked on the owner's domain decision** on the exact legal rule per project type. Surfaced by 01-domain + 00-master; not an FE-architecture call. |

**Sequencing logic:** front-load the **zero-BE, high-perceived-value** slices
(E2.0 token foundation → E2.0b pill → E2.2-S1 tab reorder → IA sidebar) so the app
*feels* redesigned before any BE lands. Run **B1 in parallel**. Gate the
data-hungry surfaces (home momentum, list momentum-sort) behind B1. Defer the
migration (B2) and the domain-blocked correctness fix (P0-FIX) to the end.

---

## 7. Per-slice risk notes (FE-architecture specifics)

- **Key-parity is the silent failure mode.** Any new prefetch surface MUST put its
  key builder in a PLAIN `*.keys.ts` and call the SAME builder from server and
  client, with the locale narrowed identically (`'he'|'en'`). A drift = silent
  cache miss = the waterfall returns with no error. **Test:** assert server key ===
  client key in a unit spec for each new prefetch (the projects pages model this).

- **`'use server'` poisoning.** New server modules (`*.server.ts`,
  `lib/query/prefetch.ts`) must NOT carry a `'use server'` directive — Turbopack
  registers every export as a runtime action and 500s on non-async/non-function
  exports (`prefetch.ts:11-18`). New `*.server.ts` files inherit this rule.

- **`next/headers` in the client graph.** Keep the server fetch in a SEPARATE
  module from the client-imported `lib/api/<entity>.ts` (the `.server.ts` split
  exists precisely so `next/headers` never enters a `'use client'` import graph —
  `projects.server.ts:1-16`). When adding `org-stats.server.ts`, do NOT merge it
  into a client-imported module.

- **The home's `cache: 'no-store'` semantics.** Migrating `ManagerHome` to Pattern
  A changes freshness from "no-store, refetch on full nav" to "TanStack staleTime +
  refetchOnWindowFocus". That is *better* (live invalidation after a chase action)
  but it is a behavior change — verify in real-Chrome that the home numbers update
  after a mutation (the whole point).

- **e2e stubs for new fetch paths.** A new endpoint a page fetches will 404 in
  Playwright specs that stub APIs → the §P0-3 console guardrail fails. Stub
  `**/api/v1/org/signature-pulse` (and any new search path) in the affected specs
  (MEMORY: "New FE fetch breaks page.route e2e").

- **Status-color rename ripples.** Renaming `statusColor` from literal colors to
  intent touches the adapter, the VM, and every reader of `.statusColor`. Grep
  `statusColor` first; `StatusBadge`/`StatusPill` is the only consumer of the
  literal values, so the blast radius is small and spec-guarded.

- **Sidebar collapse must not ungate.** Promoting controls into project tabs or
  grouping Admin must inherit the EXISTING `useHasPermission` gates
  (`sidebar.tsx:94-104,137-145`) — the gate moves with the item, it is not dropped.
  Re-run the per-role smoke after the IA slice (Agent/Viewer must not gain a
  newly-exposed control; demoted routes must stay deep-link-reachable).

- **RTL + NameDisplay are non-negotiable per component.** Every new component:
  logical props only (`ms/me`, `inset-inline-start`), and every wire/user name
  inside `<NameDisplay>` (bidi-spoofing defense, §v9-H-3). Enforce in review.

- **Don't convert islands to Server Components in E2.** The `'use client'` island
  pattern is accepted debt (`apps/web/CLAUDE.md` §v9-M-1); converting it is an
  orthogonal perf refactor that would double each slice's surface. Restyle *inside*
  the island.

---

## 8. The owner-decision this doc surfaces

**Decision (FE-architecture): converge `ManagerHome` onto the RSC-prefetch pattern
(Pattern A) as part of E2.1, or leave the ad-hoc `fetch` and only restyle?**

- **Converge (recommended).** Removes the second, undocumented fetch pattern;
  restores TanStack caching + refetch-on-focus + post-mutation invalidation on the
  home (so a chase action updates the numbers without a full nav); brings the home
  up to the same defensive-Zod-parse + host-allowlist security posture as every
  other surface. Cost: ~one extra contained slice (new `org-stats.server.ts` + hook
  + keys + prefetch wiring) on top of the restyle — **not** a pure restyle.
- **Leave it.** Cheaper for E2.1, but keeps a real liability (no caching, no parse,
  a divergent env var + hand-rolled cookie forwarding) and means the home will
  *look* redesigned while still using the inferior data path — and when B1 (the
  pulse) lands, we'd be bolting it onto the ad-hoc pattern anyway.

This doc recommends **converge**, folded into E2.1. It is the one place the
redesign is "more than a restyle," so the owner should explicitly bless the extra
scope.

> Decisions that belong to OTHER docs (restated so they aren't lost, not owned
> here): the **consent-counting legal rule** (P0-FIX, blocking — 01-domain /
> 00-master), the **navy-vs-teal brand fork** (resolve to one `--brand`), and
> **whether visual direction v4 is locked**.

---

## 9. One-line summary

The frontend is **already built for this redesign**: a clean, enforced
wire→parse→adapter→VM→hook→island data path and a mature RSC server-prefetch
pattern mean the redesign is **composition + tokens + prefetch-extension**, not a
rewrite — ship it slice-by-slice (token foundation → pill → tab-reorder → sidebar
→ B1 pulse → home → board-first → list → search), front-loading the zero-BE wins,
converging the home's one ad-hoc `fetch` onto the good pattern, and omitting
(never faking) the momentum/why signals until B1/B2 land.
