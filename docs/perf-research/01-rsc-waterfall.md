# Perf Research 01 — Killing the RSC Post-Hydration Fetch Waterfall

> **Status:** RESEARCH ONLY (no code changed). Author: Claude Code (Opus 4.8, 1M).
> Date: 2026-06-17. Scope: `apps/web` Next.js 15 App Router dashboard list/detail pages.
> Companion to `apps/web/CLAUDE.md` §v9-M-1 and `OPEN-ITEMS-v9-PHASE4A-AUDIT.md`
> (§v9-M-1, PERF-M2). This doc designs the fix that has been "tracked for Phase 8 polish"
> since the v9 audit and never executed.

---

## 0. TL;DR

- **The waterfall is real and confirmed per-page.** Every `(dashboard)/<entity>/page.tsx`
  starts with `'use client'` and fetches its initial data via a TanStack `useQuery` hook
  that only fires **after** the JS bundle downloads, parses, and hydrates. Server renders
  an empty shell + a `loading` string; the data request does not even *start* until
  hydration completes.
- **The proven fix already lives in this codebase.** PR #401 (commit `7255be6`) resolved
  the *exact same problem* for the session/`/me` profile: the dashboard layout resolves
  the profile server-side and seeds it into the TanStack cache via
  `queryClient.setQueryData(SESSION_ME_QUERY_KEY, initialSession)` before first paint, so
  `useSessionProfile` reads it with **zero** client round-trips. We generalize that exact
  technique to list/detail page data.
- **Recommended approach: TanStack `HydrationBoundary` + `dehydrate()` with a server-side
  `prefetchQuery`**, NOT `initialData`. Reason: the hooks already key their queries by
  `[entity, 'list', query, locale]` and run a heavy `select` adapter; `HydrationBoundary`
  feeds the cache by *exact query key* so the existing hook hydrates transparently with no
  signature change, no `initialData` prop threading, and correct `staleTime`/refetch
  semantics. `initialData` would force every hook to grow an optional param and would
  mis-handle the `dataUpdatedAt` freshness clock.
- **Expected gain (cold first visit):** removes the **fetch start-delay** =
  *hydration time + 1 proxy-RTT*. On a cold visit that is realistically **~500ms–1.4s**
  of dead time before the list request even begins, replaced by the data arriving *inside*
  the initial HTML stream. What does NOT change: the JS bundle still downloads/parses, and
  first paint still needs the shell. This attacks **time-to-data**, not time-to-first-byte.
- **Cost:** ~20 list/detail pages. With one reusable helper (`prefetchToDehydratedState`)
  the per-page change is ~6 lines of boilerplate + splitting the interactive body into a
  client child. Mechanical and repeatable, **not** bespoke per page.
- **Biggest risk:** cookie forwarding + the §v9-M-9 double-hop. The server prefetch must
  reuse the same `selfOrigin()` + `Cookie: access_token=…` posture `auth.ts:getMe()` uses,
  which means the prefetch inherits the **same** double-hop cost (Server Component → Pages
  Function → Railway). That is acceptable (and identical to what `getMe` already pays), but
  it must be a *deliberate* reuse, not a new direct-to-Railway path.

---

## 1. The current pattern, mapped precisely

### 1.1 The data path (Projects list, the canonical example)

```
Browser navigates to /he/projects
  │
  ▼  (1) SERVER: app/[locale]/(dashboard)/layout.tsx  (RSC, async)
  │      getCurrentSessionUser() → getMe()  [server /me, double-hop]
  │      renders <QueryProvider initialSession={profile}> + <Sidebar/> + <Topbar/>
  │      renders {children} = projects/page.tsx
  │
  ▼  (2) SERVER: projects/page.tsx  — BUT it is 'use client'
  │      So the server only emits its STATIC shell + the loading string:
  │      isLoading === true → <p>{t('loading')}</p>   (projects/page.tsx:72-78)
  │      NO data fetch happens on the server. The useProjectList hook is inert
  │      until the client runtime mounts.
  │
  ▼  (3) BROWSER: download bundle → parse → hydrate  [the dead window]
  │
  ▼  (4) BROWSER: useProjectList({limit:25}) mounts (use-projects.ts:44)
  │      → queryFn: listProjects(query)              (lib/api/projects.ts:51)
  │      → apiClient.getList('/projects?limit=25')   (lib/api-client.ts:371)
  │      → fetch('/api/v1/projects?limit=25')        same-origin
  │      → Pages Function proxy route.ts             (app/api/[...path]/route.ts)
  │      → Railway @emapp/api → Postgres (withTenant RLS)
  │
  ▼  (5) BROWSER: response → Zod parse (ProjectListItemSchema) → select adapter
  │      → toProjectViewModels(items, locale)        (adapters/project.ts:116)
  │      → React re-render with real rows
```

**The cost we are killing is the gap between (2) and (4).** The browser cannot start step
(4)'s fetch until step (3) finishes. On a cold visit, (3) is the dominant latency. The
network request in (4) is itself cheap-ish, but its *start* is gated behind a full
hydration cycle that the user stares at as a spinner / `טוען...`.

### 1.2 Per-page confirmation of the `'use client'` + post-hydration-fetch claim

| Page | First line | Initial-data hook | API wrapper | Adapter (in `select`) | Loading UI |
|---|---|---|---|---|---|
| `projects/page.tsx` | `'use client'` | `useProjectList` (use-projects.ts:44) | `listProjects` (lib/api/projects.ts:51) | `toProjectViewModels` (adapters/project.ts:116) | `<p>{t('loading')}</p>` (L72) |
| `owners/page.tsx` | `'use client'` | `useOwnerList` (use-owners.ts:24) | `listOwners` (lib/api/owners.ts) | `toOwnerListItemViewModels` (adapters/owner.ts) | `ListPageShell` (`isLoading`) |
| `apartments/page.tsx` | `redirect('/projects')` | — (no list; redirect stub) | — | — | — |
| `signature-requests/page.tsx` | `'use client'` | `useSignatureRequestList` | `listSignatureRequests` | sig-request adapter | `<ListSkeleton rows={6}/>` (L34) |
| `tasks/page.tsx` | `'use client'` | `useTaskList` (use-tasks.ts) | `listTasks` | task adapter | `ListPageShell` |

The hooks are uniform: `useQuery({ queryKey: [ENTITY, 'list', query, locale], queryFn,
staleTime: 30_000, select })`. The `select` runs the Wire→VM adapter on every settle
(adapters are pure; memoized via `useCallback` keyed on `locale` per §PERF-H3). The
loading branch is a string or skeleton — there is genuinely no server data.

### 1.3 Full dashboard page inventory (54 `page.tsx` under `(dashboard)`)

Legend: **CL** = `'use client'` page that does a post-hydration initial fetch (TARGET).
**RSC** = already a Server Component (no client waterfall). **FORM** = create/edit form
page (input-only; little or no initial *list* fetch — lower priority). **STUB** = redirect.

**Already Server Components (no change needed — the model to copy):**

- `(dashboard)/page.tsx` — **RSC**. `getMe()` server-side, branches to `ManagerHome` /
  `AgentHome` client islands. This is the existing "server resolves, client island renders"
  shape we are generalizing.
- `apartments/page.tsx` — **STUB** `redirect('/projects')`.
- `buildings/page.tsx` — **STUB** `redirect(...)`.
- `settings/page.tsx` — **RSC** (`redirect`/server gate).

**List / detail pages that DO the post-hydration waterfall (the TARGET set):**

| # | Page | Kind | Initial hook(s) |
|---|---|---|---|
| 1 | `projects/page.tsx` | list | `useProjectList` |
| 2 | `projects/[id]/page.tsx` | detail | `useProject` (+ progress board hooks) |
| 3 | `projects/[id]/buildings/page.tsx` | list | buildings-by-project |
| 4 | `projects/[id]/assignments/page.tsx` | list | assignments |
| 5 | `projects/[id]/shares/page.tsx` | list | shares |
| 6 | `owners/page.tsx` | list | `useOwnerList` |
| 7 | `owners/[id]/page.tsx` | detail | `useOwner` (+ `useOwnerProjects`) |
| 8 | `apartments/[id]/page.tsx` | detail | apartment-by-id |
| 9 | `apartments/[id]/ownerships/page.tsx` | list | `useApartmentOwners` |
| 10 | `buildings/[id]/page.tsx` | detail | building-by-id |
| 11 | `buildings/[id]/apartments/page.tsx` | list | apartments-by-building |
| 12 | `signature-requests/page.tsx` | list | `useSignatureRequestList` |
| 13 | `signature-requests/[id]/page.tsx` | detail | sig-request-by-id |
| 14 | `tasks/page.tsx` | list | `useTaskList` |
| 15 | `tasks/[id]/page.tsx` | detail | task-by-id |
| 16 | `documents/page.tsx` | list | documents list |
| 17 | `documents/[id]/page.tsx` | detail | document-by-id |
| 18 | `contractors/page.tsx` | list | contractors list |
| 19 | `contractors/[id]/page.tsx` | detail | contractor-by-id |
| 20 | `members/page.tsx` | list | members list |
| 21 | `members/[userId]/page.tsx` | detail | member-by-id |
| 22 | `notes/page.tsx` | list | notes list |
| 23 | `notes/[id]/page.tsx` | detail | note-by-id |
| 24 | `imports/page.tsx` | list | imports list |
| 25 | `imports/[id]/page.tsx` | detail | import-by-id (+ SSE) |
| 26 | `imports/[id]/errors/page.tsx` | list | import errors |
| 27 | `imports/[id]/mapping/page.tsx` | data | import mapping |
| 28 | `audit/page.tsx` | list | audit list |
| 29 | `notifications/page.tsx` | list | notifications |
| 30 | `messages/page.tsx` | list/realtime | messages (team chat epic) |
| 31 | `settings/roles/page.tsx` | list | roles |
| 32 | `provider/page.tsx` | detail | provider console home |
| 33 | `provider/tenants/page.tsx` | list | tenants |
| 34 | `provider/tenants/[id]/page.tsx` | detail | tenant-by-id |
| 35 | `provider/tenants/[id]/users/page.tsx` | list | tenant users |
| 36 | `provider/audit/page.tsx` | list | provider audit |
| 37 | `provider/audit/self/page.tsx` | list | self audit |
| 38 | `provider/backups/page.tsx` | list | backups |
| 39 | `provider/system-health/page.tsx` | data | system health |
| 40 | `provider/onboard/page.tsx` | form/data | onboard |

**Create/edit FORM pages (lower priority — no initial *list* fetch to prefetch, though
some load a picker list):** `projects/new`, `projects/[id]/buildings/new`,
`buildings/[id]/apartments/new`, `owners/new`, `contractors/new`, `documents/new`,
`imports/new`, `members/new`, `notes/new`, `signature-requests/new`, `tasks/new`.

> **Net target count:** ~30 list/detail pages with a meaningful initial GET. The ~12
> form pages are out of scope for the first wave (they're input-bound; their cost is the
> user typing, not a fetch start-delay). Realistic high-ROI pilot + fan-out set = the
> ~15 most-visited org-tier list/detail pages (rows 1–17, 28–29 above).

---

## 2. Designing the fix

### 2.1 The proven precedent — PR #401 session seed

PR #401 (`7255be6 perf(web): seed session cache from server profile — kill redundant
client /me`) is the template. The dashboard layout already resolves the profile
server-side, then seeds it:

```ts
// app/[locale]/(dashboard)/_components/query-provider.tsx:49-74
const [client] = useState(() => {
  const queryClient = new QueryClient({ defaultOptions: { /* ... */ } });
  // §PERF — hydrate the session cache from the server-resolved profile.
  if (initialSession) queryClient.setQueryData(SESSION_ME_QUERY_KEY, initialSession);
  return queryClient;
});
```

```ts
// app/[locale]/(dashboard)/layout.tsx:45
<QueryProvider initialSession={session.tier === 'org' ? session.profile : undefined}>
```

```ts
// hooks/use-session.ts:26-36 — the hook just reads the seeded cache, no fetch
export function useSessionProfile() {
  return useQuery({ queryKey: SESSION_ME_QUERY_KEY, queryFn: /* … */, staleTime: 5*60_000 });
}
```

This works because the seed writes the **exact** query key the hook reads
(`SESSION_ME_QUERY_KEY` is exported so they can't drift), and `staleTime` keeps the seeded
value authoritative on first paint. **The list/detail fix is the same idea applied to
per-route, per-query-key data.** The only new wrinkle: page data is keyed by params
(`[ 'projects', 'list', { limit, cursor }, locale ]`), so we can't pre-seed it from the
*layout* (the layout doesn't know which page renders). The seed must happen in the **page**
(a Server Component) and flow through a `HydrationBoundary`.

### 2.2 Option A — `HydrationBoundary` + `dehydrate()` (RECOMMENDED)

The page becomes a thin async Server Component that prefetches the query into a
*request-scoped* `QueryClient`, dehydrates it, and wraps the existing (now-extracted)
client body in `<HydrationBoundary>`:

```tsx
// projects/page.tsx  (NEW: Server Component — no 'use client')
import { dehydrate, HydrationBoundary, QueryClient } from '@tanstack/react-query';
import { listProjects } from '@/lib/api/projects';
import { ProjectsListClient } from './projects-list.client';

export default async function ProjectsPage() {
  const qc = new QueryClient();
  // Same query key shape the hook uses: [ 'projects', 'list', query, locale ]
  await qc.prefetchQuery({
    queryKey: ['projects', 'list', { limit: 25 }, 'he'],
    queryFn: () => listProjects({ limit: 25 }),
  });
  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <ProjectsListClient />
    </HydrationBoundary>
  );
}
```

```tsx
// projects/projects-list.client.tsx  (the OLD page body, verbatim, still 'use client')
'use client';
export function ProjectsListClient() {
  const { data, isLoading /* … */ } = useProjectList({ limit: 25, cursor });
  // ↑ On first render this RESOLVES FROM THE DEHYDRATED CACHE — isLoading is
  //   false immediately, no client round-trip.
}
```

**Why this is the right primitive here:**

1. **Zero hook-signature change.** `useProjectList` is untouched. It looks up
   `['projects','list',{limit:25},locale]` and finds the dehydrated entry. The whole
   `select` adapter, `staleTime`, refetch-on-focus, cursor pagination keep working.
2. **Correct freshness clock.** `dehydrate()` carries `dataUpdatedAt`, so the 30s
   `staleTime` is measured from the *server* fetch time. The hook won't immediately
   refetch (data is fresh), and it WILL refetch correctly after 30s / on focus.
3. **Server-side fetch reuses the existing `lib/api/*` wrapper** — same Zod parse, same
   D.16 envelope handling. The adapter runs client-side in `select` exactly as today
   (the dehydrated entry stores the *wire* shape `ProjectListPage`, not the VM — matching
   the hook's `TQueryFnData`).

**One caveat to verify during implementation:** the query key must match *exactly*,
including the `locale` segment and the `query` object. The hook computes
`locale = useDisplayLocale()` and uses the literal `query` object passed in. The Server
Component must compute the identical `locale` (from the `[locale]` route param /
`getLocale()` from next-intl) and pass the identical `query` literal. A mismatch = a cache
miss = the waterfall silently returns (no error, just no benefit). Recommend a tiny shared
`projectsListQueryKey(query, locale)` helper exported next to the hook so the key can never
drift (same discipline as the exported `SESSION_ME_QUERY_KEY`).

### 2.3 Option B — `initialData` on the hook (NOT recommended here)

```tsx
useQuery({ queryKey, queryFn, initialData: serverData, initialDataUpdatedAt: serverTs });
```

Rejected because:

- **Every hook grows an optional `initialData` param** that must be threaded from the
  Server Component page → client body → hook. That's a signature change across ~15 hooks
  vs. zero with Option A.
- **`initialData` is per-`useQuery`-call, not per-cache-key.** If two components read the
  same query (e.g. a list + a count badge), only the one passed `initialData` is seeded;
  `HydrationBoundary` seeds the *cache* so every reader benefits.
- **Freshness:** without also passing `initialDataUpdatedAt`, TanStack treats
  `initialData` as fresh-as-of-now and may skip a needed refetch, or (with default
  `staleTime`) immediately refetch anyway — easy to get subtly wrong. `dehydrate()` carries
  the timestamp for free.

`initialData` is the right tool only for a *one-off* page that doesn't share the
QueryProvider cache. Our dashboard shares one client per provider mount, so Option A wins.

### 2.4 The reusable helper (makes the rollout mechanical)

```ts
// lib/query/prefetch.ts  (NEW)
import { dehydrate, QueryClient, type DehydratedState } from '@tanstack/react-query';

/** Server-only: run N prefetches into a throwaway QueryClient and dehydrate. */
export async function prefetchToDehydratedState(
  prefetches: Array<(qc: QueryClient) => Promise<unknown>>,
): Promise<DehydratedState> {
  const qc = new QueryClient();
  await Promise.all(prefetches.map((p) => p(qc)));   // parallel — detail pages fan out
  return dehydrate(qc);
}
```

A detail page (e.g. `owners/[id]`) that needs two queries (`useOwner` + `useOwnerProjects`)
prefetches both in parallel, so the server pays *one* RTT of wall-clock for both — strictly
better than the client firing them sequentially after hydration.

---

## 3. Quantifying the expected gain

### 3.1 What is removed

The client fetch's **start-delay**, which today = `hydration_time + proxy_RTT_for_the_GET`.
After the fix, the GET happens *on the server during the HTML stream*, in parallel with the
bundle download, and the data arrives embedded in the dehydrated state. The client hook
resolves synchronously on first render.

```
BEFORE (cold):
 |--TTFB--|--bundle dl+parse--|--HYDRATE--|--GET RTT--|--parse+adapt--| rows
                                          └ data fetch only STARTS here ┘

AFTER (cold):
 |--TTFB(now includes server GET)--|--bundle dl+parse--|--hydrate--| rows already present
        server GET runs in parallel with the stream;
        client hook reads dehydrated cache → no client GET
```

### 3.2 Numbers (EMAPP-specific, from documented measurements)

Anchors from the repo's own perf notes:

- **Hydration cold:** ~300–900ms (the prompt's stated band; consistent with a Heebo-font
  RTL app shipping TanStack + adapters). `MswInit`/PERF-H1 notes cite 5–20ms *commit*
  cost, but full hydrate of a list route tree is the larger 300–900ms figure.
- **The GET RTT through the proxy:** dev is dominated by the dev→Neon distance
  (MEMORY: "~70-80% is dev→Neon distance"); warm prod is ~200ms (V12 baseline: "warm
  200ms"). The §v9-M-9 note pins the *extra* proxy double-hop at ~5–15ms.
- **Post-login server render** was measured at ~4.3s pre-#393, dominated by duplicate
  `/me`s — fixed by `cache()` memoization. That tells us the *server* path to the API is
  not the bottleneck once deduped; the remaining customer-facing cold cost is FE fetch
  redundancy + start-delay, which is exactly this waterfall.

**Estimated removed dead-time on a cold first list view:**

| Component | Cold estimate | Removed by fix? |
|---|---|---|
| Hydration before fetch can start | 300–900ms | **Yes** (fetch moves to server, parallel to bundle) |
| GET RTT (warm prod) | ~200ms | **Yes** (folded into the server stream / parallelized) |
| GET RTT (dev→Neon) | dominant, 100s of ms–seconds | **Yes** for the start-delay portion |
| **Total time-to-data improvement** | **~500ms–1.4s (prod cold)**, larger in dev | |

### 3.3 What REMAINS (be honest)

- **The JS bundle still downloads and parses.** We are not removing client interactivity;
  the list still hydrates for pagination/search/filters. First *paint* of the shell is
  unchanged.
- **TTFB grows slightly.** The server now does the GET before streaming, so
  time-to-first-byte includes one server→API RTT (mitigated: it's the fast deduped server
  path, and with React streaming/Suspense the shell can flush before the data — see §4.6).
- **The §v9-M-9 double-hop is inherited, not removed.** The server prefetch goes Server
  Component → Pages Function → Railway, same as `getMe`. ~5–15ms, accepted.
- **No help for warm/SPA navigations.** Once the app is hydrated and the user clicks
  around, TanStack already serves from cache / prefetches via `<Link>`. This fix targets
  the **cold first visit / hard refresh / deep-link** specifically — which is exactly the
  "customer-facing cold-first-visit" the prompt names.

---

## 4. Cost & risk of applying it

### 4.1 Scope & repeatability

- **~30 list/detail pages**, realistically a **~15-page** high-value first wave (org-tier
  list + detail).
- **Mechanical, not bespoke.** Each page: (a) rename current `page.tsx` body to
  `<entity>-list.client.tsx` (cut/paste, add nothing), (b) new server `page.tsx` that calls
  `prefetchToDehydratedState([...])` + wraps in `HydrationBoundary`. The only per-page
  thought is "which query key(s) does this page's hook(s) use" — solved by exporting a
  `xxxQueryKey()` helper alongside each hook.
- **Net new shared code:** `lib/query/prefetch.ts` (the helper) + per-hook exported
  key-builders. ~1 day for the helper + pilot, ~2–3 days to fan out the 15 pages with
  smoke tests.

### 4.2 RISK — cookie forwarding into the server-side fetch (the big one)

The server prefetch calls `listProjects()` → `apiClient.getList('/projects')` →
`fetch('/api/v1/projects')`. **Problem:** `apiClient` uses `credentials: 'same-origin'`,
which works in the browser but is meaningless on the server — a server-side `fetch` to a
*relative* path has no origin and won't attach the httpOnly cookies.

`auth.ts:getMe()` already solved this for `/me`:

```ts
// lib/auth.ts:37-47
const origin = await selfOrigin();                    // host-allowlisted absolute origin
const res = await fetch(`${origin}/api/v1/me`, {
  headers: { Cookie: `access_token=${accessToken}` },  // explicit cookie forward
  cache: 'no-store',
  signal: AbortSignal.timeout(15_000),
});
```

**The prefetch MUST use this same posture.** Options:

1. **Server-flavored API wrappers.** Add a server variant of `apiClient.getList` that takes
   an absolute origin + forwards the `access_token` cookie explicitly (reusing
   `selfOrigin()` and `cookies()` from `next/headers`). The existing `lib/api/projects.ts`
   `listProjects` would need a server entry point, OR a `fetcher` injection so the same
   parse logic runs server-side.
2. **Thin per-page server fetch** that mirrors `getMe`'s body and then `setQueryData`/
   prefetch the *parsed wire shape*. Less DRY but isolates the cookie handling.

**Recommendation:** factor a `serverApiGet(path)` in `lib/auth.ts`'s neighborhood that does
the `selfOrigin()` + `Cookie:` + timeout dance once, and have the server prefetch call the
*same* `lib/api/*` Zod parse on its result. This keeps the §v9-H-1 host-allowlist defense
(SSRF/token-exfil) and the 15s timeout on the server path. **Do not** introduce a direct
`process.env['API_BACKEND_URL']` server→Railway path in this slice — that's the §v9-M-9
"reversibility" lever and a separate decision (it would bypass the proxy's header-strip /
Set-Cookie uniformity; out of scope here).

### 4.3 RISK — RLS / tenant scoping on the server fetch

Low, *if* the cookie is forwarded correctly. The API derives `orgId` from the validated
session JWT in the forwarded `access_token` and runs every read through `withTenant`. The
server prefetch is indistinguishable from the client GET at the API layer — same cookie,
same RLS scope. **The failure mode to avoid:** forgetting the cookie → the API returns 401
→ `prefetchQuery` swallows it (prefetch doesn't throw by default) → the dehydrated state is
empty → the client hook silently re-fetches → you've added a server round-trip for nothing
and kept the waterfall. **Mitigation:** in dev, assert the prefetch populated the cache
(e.g. a `getQueryData` check behind a dev flag), and smoke each piloted page logged-in.

### 4.4 RISK — the §v9-M-9 double-hop multiplies

Today only `getMe` pays the Server Component → Pages Function → Railway hop (once per
request, `cache()`-deduped). After this fix, *each piloted page* adds its own server GET
through the proxy. That's intended (it replaces a client GET), but note:

- A **detail page that fans out N queries** now does N server fetches. Use
  `Promise.all` (the helper does) so it's one RTT of wall-clock, not N.
- The layout's `getMe` + the page's prefetch are **sequential** (layout RSC resolves before
  the page RSC streams). That's already true today and unchanged; just be aware TTFB =
  `getMe (deduped) + page prefetch`. Both are the fast server path.

### 4.5 RISK — error / loading UI shape divergence

Today each page renders its own `isLoading` (string / `ListSkeleton` / `ListPageShell`) and
`isError` branch. After the fix, on a *successful* prefetch the client hook starts with
`isLoading: false, data: <rows>` — the loading branch never shows on cold load (good). But:

- **Prefetch failure** (API 5xx/timeout) leaves an empty cache; the client hook then
  fetches and shows the *existing* loading→error UI. So the error path is preserved, just
  deferred to the client — no UI shape change needed.
- **Hydration mismatch:** none expected, because the server renders the *client child's*
  output? No — the client child is `'use client'`, so on the server it renders its *initial*
  state. With a populated `HydrationBoundary`, the hook's initial state already has data, so
  the server-rendered HTML shows rows and the client hydrates to the same rows. This is the
  intended TanStack SSR contract; verify with the §S1-VG1 browser smoke (view-source should
  now show **real rows in the SSR HTML**, not the loading string — a nice positive signal).

### 4.6 OPPORTUNITY — streaming / Suspense

Optional enhancement, not required for v1: wrap `<ProjectsListClient/>` in `<Suspense>` and
use `prefetchQuery` without `await` (let it stream). Then the shell (sidebar/topbar/filters)
flushes immediately and the list streams in. This recovers the small TTFB cost from §3.3.
Recommend deferring to a second pass — the `await`ed version is simpler and already wins.

### 4.7 INTERACTION — the just-merged Turbopack change (`254fa7e`)

The Turbopack dev-server enablement is **orthogonal but adjacent**, with one real gotcha:

- Turbopack's Server-Actions transform **registers every export of a `'use server'` module
  as a runtime action** and 500s on non-function exports. The commit already scrubbed
  `auth.ts` / `provider-auth.ts` / `session.ts` to export *only* async actions.
- **Implication for this fix:** the new server-side fetch helper (§4.2) must live in a
  module whose exports are *not* accidentally `'use server'`-tagged, OR if it must be a
  Server Action, it can export only async functions. Put `prefetchToDehydratedState` and the
  `serverApiGet` helper in **plain server modules** (no `'use server'` directive — they're
  called from Server Components, not as form actions), so Turbopack's transform doesn't try
  to register them. The page `page.tsx` files are RSC (also not `'use server'`), so they're
  fine.
- No conflict otherwise: Turbopack changes the dev *bundler*, not the RSC/hydration
  semantics this fix relies on.

---

## 5. Recommendation

### 5.1 Is this the highest-ROI fix for cold-first-visit?

**Yes, for the customer-facing cold/deep-link visit — with a caveat about dev vs prod.**
Per MEMORY, the bulk of the *dev* "nerve-wracking wait" is dev→Neon distance (addressed by
the local-pg kit #363), not this waterfall. But for **production cold visits** — a customer
hard-refreshing or deep-linking a list — the post-hydration fetch start-delay
(~500ms–1.4s) is the single largest *removable* chunk of time-to-data that doesn't require
re-architecting auth or the proxy. PR #401 already proved the technique on `/me` with no
regressions. This is the natural, low-risk continuation of that line of work, and it's the
exact item the v9 audit deferred (§v9-M-1 / PERF-M2).

It is **higher ROI than** further micro-optimizing the API SQL (already "fine" per MEMORY)
and **complementary to** local-pg (#363, dev-only) and the optimistic-mutation slices
(#388/#389, which help *writes*, not cold *reads*).

### 5.2 Concrete step-by-step rollout

1. **Build the shared helper.** Add `lib/query/prefetch.ts`
   (`prefetchToDehydratedState`) and a `serverApiGet(path)` that reuses `selfOrigin()` +
   `Cookie: access_token=…` + 15s timeout (factored from `auth.ts:getMe`). Keep both in
   plain (non-`'use server'`) server modules (Turbopack §4.7).
2. **Export query-key builders** next to each target hook (e.g.
   `export const projectsListQueryKey = (q, locale) => ['projects','list',q,locale]`), and
   have the hook *use* the builder — so server and client can never drift (the
   `SESSION_ME_QUERY_KEY` discipline).
3. **Pilot on `projects/page.tsx`** (highest-traffic org list, already bespoke so no
   `ListPageShell` coupling):
   - Cut the current body into `projects/projects-list.client.tsx` (`'use client'`,
     verbatim).
   - New server `projects/page.tsx`: compute `locale`, `prefetchToDehydratedState([qc =>
     qc.prefetchQuery({ queryKey: projectsListQueryKey({limit:25}, locale), queryFn: () =>
     listProjects({limit:25}) })])`, wrap client child in `<HydrationBoundary>`.
4. **Smoke the pilot per §S1-VG1 / DOD-BROWSER-SMOKE.md** logged in:
   - `view-source:` on `/he/projects` now shows **real project rows in SSR HTML** (not
     `טוען...`). This is the proof the prefetch worked.
   - Network tab: **no** client `GET /api/v1/projects` fires on cold load (only on
     pagination/refetch/focus).
   - Cookies/Redirect/URL axes unchanged.
   - 4 roles (Manager/Agent/Viewer + a logged-out → redirect) render correctly; Agent sees
     only scoped rows (RLS preserved through the forwarded cookie).
5. **Measure** before/after time-to-data on a cold prod-like profile (the
   `apps/web/perf-audit/browser-flows.mjs` harness already exists — extend it to assert
   "rows present without a client list GET").
6. **Fan out** to the remaining org-tier list/detail pages (rows 1–17, 28–29 in §1.3) in
   batches of ~5, smoking each batch. Defer provider-tier pages (rows 32–40) and form
   pages to a later wave.
7. **Update docs:** flip §v9-M-1 / PERF-M2 from "deferred" to "closed (this slice)" in
   `OPEN-ITEMS-v9-PHASE4A-AUDIT.md` and add the pattern to `apps/web/CLAUDE.md`
   Architecture section (so new pages are born server-prefetched).

### 5.3 Guardrails to add (so it doesn't regress)

- A lint/test that **fails if a new `(dashboard)/<entity>/page.tsx` is `'use client'`** with
  a top-level list/detail `useQuery` (push new pages onto the prefetch pattern by default),
  mirroring the existing `app-forms-no-get-fallback.spec.ts` static-check style.
- A dev-only assertion in the helper that warns when a `prefetchQuery` produced an empty
  cache entry (catches the silent cookie-not-forwarded failure from §4.3).

---

## Appendix A — key file references

| Concern | File |
|---|---|
| Canonical waterfall page | `apps/web/src/app/[locale]/(dashboard)/projects/page.tsx:1,47,55,72` |
| List hook (queryKey + select) | `apps/web/src/hooks/use-projects.ts:42-63` |
| API wrapper (Zod parse) | `apps/web/src/lib/api/projects.ts:51-64` |
| Adapter (runs in select) | `apps/web/src/adapters/project.ts:116-121` |
| Browser api-client (same-origin) | `apps/web/src/lib/api-client.ts:171-177,371` |
| **Seed precedent (PR #401)** | `apps/web/src/app/[locale]/(dashboard)/_components/query-provider.tsx:49-74` |
| Layout seeds session | `apps/web/src/app/[locale]/(dashboard)/layout.tsx:45` |
| Session hook reads seed | `apps/web/src/hooks/use-session.ts:24-36` |
| **Server cookie-forward precedent** | `apps/web/src/lib/auth.ts:32-55` (getMe), `:128-137` (selfOrigin) |
| §v9-M-9 double-hop note | `apps/web/CLAUDE.md:53-59`; `OPEN-ITEMS-v9-PHASE4A-AUDIT.md` §v9-M-9 |
| §v9-M-1 deferral | `apps/web/CLAUDE.md:61-65`; `OPEN-ITEMS-v9-PHASE4A-AUDIT.md` §v9-M-1, PERF-M2 |
| Already-RSC model page | `apps/web/src/app/[locale]/(dashboard)/page.tsx:30-38` |
| Proxy route handler | `apps/web/src/app/api/[...path]/route.ts` |
| Turbopack change | commit `254fa7e`; `apps/web/package.json` dev script; `next.config.ts` |
| Smoke standard | `docs/DOD-BROWSER-SMOKE.md`; `apps/web/src/app-forms-no-get-fallback.spec.ts` |
