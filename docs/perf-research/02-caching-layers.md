# Perf Research 02 — Caching Layers

Read-only research. No code changed. Date: 2026-06-17.

Goal: enumerate every caching mechanism that could cut customer-facing latency
across the EMAPP stack (Next.js 15 on Cloudflare Pages → Pages-Function/route-handler
reverse proxy → NestJS 11 + Fastify on Railway → PostgreSQL 16 + RLS + pgcrypto on
Neon), and for each state whether it is **safe** given per-tenant RLS, pgcrypto PII,
and httpOnly-cookie auth.

**The #1 landmine (repeated throughout):** never cache per-tenant PII
(`national_id`, `phone`, signature blobs) or any RLS-scoped row at a *shared* layer
(CDN edge, public proxy cache, anything keyed without the tenant identity). All such
caching must be **client-private** (TanStack in-memory) or **server-side keyed by
tenant** (cache_kv). Auth identity is an httpOnly cookie, so it cannot be read by
client JS — which also means the browser/edge must never key a cache on something it
can't see, i.e. it must treat all `/api/v1/*` responses as `private, no-store`.

---

## 0. Current state (what the codebase does today)

Facts gathered from the tree (cited inline below):

- **Next.js caching is effectively OFF for authed pages.** `apps/web/next.config.ts`
  sets no `revalidate`, no `cacheHandler`, no `force-static`. Every dashboard page is
  `'use client'` (per `apps/web/CLAUDE.md` §v9-M-1), and every server fetch
  (`apps/web/src/lib/auth.ts`, `provider-auth.ts`, `_components/manager-home.tsx`)
  passes `cache: 'no-store'`. No `export const dynamic`, no `unstable_cache`, no
  `<Link prefetch>` props anywhere in `apps/web/src` (grep returned zero hits).
- **TanStack Query is the only live customer-facing data cache.** Defaults in
  `apps/web/src/app/[locale]/(dashboard)/_components/query-provider.tsx`:
  `staleTime: 30_000`, `refetchOnWindowFocus: true`, query `retry` = network-only
  (≤2, capped 2s) — definitive `ApiClientError`s are NOT retried; mutations
  `retry: 0`. The session `/me` cache is **seeded server-side** by `QueryProvider`
  (`setQueryData(SESSION_ME_QUERY_KEY, initialSession)`) and read with
  `staleTime: 5*60_000` (`use-session.ts`). The permission catalog already uses
  `staleTime: 60 * 60 * 1000` (`use-roles.ts` `usePermissionCatalog`).
- **No `persistQueryClient`** anywhere. The cache is pure in-memory and dies on reload.
- **API sets no positive Cache-Control** anywhere. The only `Cache-Control` headers
  are *defensive* `no-store` / `no-cache`: export (`export.controller.ts:197`
  `private, no-store, max-age=0, must-revalidate`), SSE import progress
  (`imports.controller.ts:233` `no-cache, no-transform`), signed-doc download
  (`signature-requests.controller.ts:124` `no-store`). No `ETag`, no
  `stale-while-revalidate`. Helmet (`main.ts:143`) sets CSP/HSTS but no cache policy.
- **The Pages reverse proxy** (`apps/web/src/app/api/[...path]/route.ts`) forwards
  upstream response headers verbatim (except hop-by-hop), including Set-Cookie. It
  adds no caching. Per D.35 the FE strips its own security headers off API responses.
- **`PostgresCacheProvider` / `cache_kv` is NOT on any read path today.** The class
  (`packages/db/src/providers/cache/postgres.provider.ts`) implementing
  `ICacheProvider` (`cache.interface.ts`: `get/set/delete/incrementCounter/healthCheck`)
  is **not instantiated anywhere in `apps/api/src` or `packages/jobs`** (grep for
  `PostgresCacheProvider` / `new PostgresCache` returned no wiring). The `cache_kv`
  table is used **only** for:
  - **Export rate-limit counter** — `export-rate-limit.service.ts` writes `cache_kv`
    rows directly via raw SQL `INSERT ... ON CONFLICT` (hourly throttle), not via the
    provider class.
  - **Reaper** (`packages/jobs/src/reaper-job.ts`) expires stale rows.
  In short: `cache_kv` is an idempotency/rate-limit/OTP-style store, **not a hot-read
  cache**. The in-app caches that DO exist are per-process in-memory:
  `session-validity.ts` (15s `Map` cache of session-active checks, flushed on
  logout/revoke) and `permission.service.ts` `PermissionResolutionCache`
  (per-**request** memoization of the permission resolve — not cross-request).
- **R2 signed-URL TTLs:** document download `120s` (`documents/storage.ts:38`),
  contractor-portal download `300s` (`contractor-read.service.ts:34`). Browser
  PUT/GET direct to R2 is allowed by CSP `connect-src` (`main.ts`).

So the realistic latency levers are: (A) tune/extend the **client** TanStack cache,
(B) add **server-side per-tenant** caching via `cache_kv`/the provider for a few hot
reads, (C) add **private** HTTP validators (ETag) for big rarely-changing payloads,
(D) cache **only truly public/static** things at the edge. Next.js Full-Route/fetch
caching is mostly inapplicable because every page is authed + dynamic.

---

## 1. Next.js 15 caching primitives

Context: Next 15 flipped several defaults vs 14. **`fetch()` is no longer cached by
default** (was `force-cache` in 14, now `no-store`/dynamic unless you opt in). The
**Client Router Cache `staleTime` for dynamic (non-prefetched) pages is now `0`** by
default in 15 (was 30s in 14) — navigations re-render fresh. `<Link prefetch>` default
is `prefetch={null}` (auto): in Next 15 with App Router this prefetches the **route on
viewport** but, for dynamic pages, only the loading boundary / layout, not the full
RSC payload, unless `prefetch={true}`.

| Mechanism | Applies here? | Expected gain | PII/RLS-safe? | Recommendation |
|---|---|---|---|---|
| **Full Route Cache / `force-static`** | No — every dashboard route is authed + per-request dynamic (`cache:'no-store'` self-fetch, cookie-scoped). Static rendering would bake one tenant's HTML for all. | n/a | **DO NOT** — a force-static authed page is a cross-tenant data leak. | Keep all dashboard routes dynamic. Only the truly public surface (login, marketing, `/sign/[token]` shell) could be static — see §5. |
| **`fetch()` cache + `revalidate`** | Marginally. Server fetches are all `no-store` and SHOULD stay so for per-tenant data. Could apply to a *public, non-tenant* fetch (e.g. a static config) — none exists today. | ~0 for authed data | Unsafe if applied to tenant data (shared Data Cache is keyed by URL, not tenant). | Leave `no-store`. Do not introduce `revalidate` on any cookie-scoped fetch. |
| **`unstable_cache`** | Could wrap a *non-tenant, non-PII* server computation (e.g. the i18n message bundle, the permission **catalog**). The catalog is already cached client-side 1h. | Small (saves a server round-trip on SSR of static reference data) | Safe ONLY if the cached fn takes the tenant id as part of the cache key AND returns no PII. Easy to get wrong. | Low priority. If used, restrict to genuinely global reference data (permission catalog, enums) and key explicitly. Not worth the footgun for tenant data. |
| **Client Router Cache `staleTime`** (`next.config.ts` `experimental.staleTimes`) | Yes — Next 15 default is `0` for dynamic pages, so back/forward + tab nav re-render. Setting `staleTimes: { dynamic: 30 }` makes in-session back-nav instant. | **Medium** — instant back/forward and revisits within the window; no network. | **Safe** — the Router Cache is **client-private**, per-browser, lives only in the tab's memory, never shared. It caches the RSC payload the user already received. | **Quick win (needs care).** Set a modest `staleTimes.dynamic` (e.g. 30s) to match TanStack's 30s window. Caveat: a stale RSC payload could briefly show pre-mutation data; since pages are `'use client'` and refetch via TanStack on mount, the risk is low. Validate that mutations still reflect quickly. |
| **`<Link prefetch>`** | Yes. No `<Link>` in `apps/web/src` sets `prefetch` explicitly → Next 15 auto behavior (prefetch route on viewport). For dynamic pages auto-prefetch fetches only layout/loading, not data. | **Small–Medium** — faster shell paint on navigation; does NOT prefetch the per-tenant data (TanStack still fetches on mount). | **Safe with one caveat:** auto/`true` prefetch issues GET requests to the route. For authed dynamic routes that's fine (cookie present, RLS applies). Do NOT `prefetch` a route whose RSC payload embeds another tenant's data — none do today (data is client-fetched). | **Low-effort win:** leave auto on; consider `prefetch={true}` on the 2-3 highest-traffic nav links (sidebar → owners/apartments/projects) to warm the shell. Pair with TanStack `prefetchQuery` on hover (§2) to actually warm the data. |
| **Partial Prerendering (PPR)** | Experimental in 15; could prerender the static shell and stream the dynamic per-tenant island. | Medium (faster first paint) | Safe if the dynamic hole is correctly marked; risky if a tenant value leaks into the static shell. | Defer — experimental, and the app is fully `'use client'` so there's no static/dynamic split to exploit yet. Revisit after the §v9-M-1 Server-Component refactor. |

**Net for Next.js:** the one safe quick win is `experimental.staleTimes.dynamic` for
the client Router Cache (per-browser, private). Everything else (Full Route Cache,
fetch cache, PPR) is either inapplicable to authed dynamic pages or a PII-leak risk if
misapplied. `<Link prefetch>` is already implicitly on and safe.

---

## 2. TanStack Query (the real client-side lever)

Current (`query-provider.tsx`, `use-*.ts`): `staleTime: 30_000` global,
`refetchOnWindowFocus: true`, smart network-only retry. `/me` seeded server-side +
5-min staleTime. Permission catalog 1h. Reveal-PII (`use-owners.ts useRevealOwnerPii`)
**deliberately never written to cache** — cleartext PII stays in ephemeral component
state. This is the correct existing guardrail and any change MUST preserve it.

| Mechanism | Expected gain | Effort | PII/RLS-safe? | Recommendation |
|---|---|---|---|---|
| **Per-entity `staleTime` tuning** | Medium — fewer refetches on slow-changing entities (org-settings, roles, members, buildings, parcel reference). Today most are a flat 30s. | Low | **Safe** — purely controls refetch frequency of in-memory, per-tab, cookie-authed data. No new exposure. | **Quick win.** Raise `staleTime` for slow-changing reads: org-settings → 5min, roles/members → 2-5min, buildings/projects lists → 60s. Keep owners/PII-bearing lists at 30s (or lower) so reveals/edits surface fast. The catalog (1h) is the template. |
| **`placeholderData: keepPreviousData`** (pagination) | Medium — keyset-paginated lists (owners, apartments, audit) won't flash empty/loading between pages; perceived-instant paging. | Low | **Safe** — reuses data already in this tab's cache; no cross-tenant or PII concern. | **Quick win.** Add `placeholderData: keepPreviousData` to the cursor-paginated list hooks (`use-owners`, `use-apartments`, `use-audit`, etc.). Pure UX latency win. |
| **`prefetchQuery` on link/row hover** | Medium — clicking a list row → detail feels instant because the detail query was warmed on hover. | Low–Med | **Safe** — same cookie-authed GET the click would issue; RLS applies; data lands in the private in-memory cache. | **Win (needs light care):** prefetch detail (`useOwner`/`useApartment`) on row hover/focus. Don't prefetch reveal-PII (it's a mutation and must stay un-cached). Debounce to avoid hammering on fast mouse-overs. |
| **`refetchOnWindowFocus` tuning** | Small — currently `true` (deliberate, §v9-M-8: two-tab write visibility). Turning it off cuts request volume but loses cross-tab freshness. | Low | Safe either way (in-memory). | **Keep `true`** per the documented v9 decision; `staleTime` already bounds the rate. Not a recommended change. |
| **`persistQueryClient`** (localStorage/IndexedDB) — reload/return is instant | **High** *perceived* (instant warm paint after reload / browser-back-from-external) | Med | **DO NOT for PII / per-tenant rows — PII LEAK RISK.** Persisting the cache writes tenant data (owner lists, names, possibly PII-adjacent fields, signature metadata) to disk in localStorage/IndexedDB, which: (a) survives logout unless explicitly purged, (b) is readable by any same-origin script/XSS, (c) directly violates `apps/web/CLAUDE.md` Doc-10 §1 ("tokens are httpOnly cookies only" — the whole point is keeping sensitive state out of JS-readable storage), and (d) on a shared machine exposes one user's tenant data to the next. | **DO NOT** persist the default cache. IF a persisted cache is ever wanted, it must be **scoped to non-PII, non-tenant reference data only** (permission catalog, enums, i18n) via a `dehydrate` filter allowlist, encrypted-at-rest is not feasible client-side, and it MUST be wiped on logout and on user switch. Given the bans, treat persistence as **out of scope for MVP.** The server-side `/me` seed (already shipped) delivers most of the "instant first paint" benefit without touching disk. |
| **`gcTime` tuning** | Small | Low | Safe | Optional: lengthen `gcTime` so back-nav within a session reuses cache. Low impact vs staleTime. |

**Net for TanStack:** the biggest *safe* client wins are per-entity `staleTime`,
`keepPreviousData` for pagination, and hover `prefetchQuery`. `persistQueryClient` is
the one to **avoid** — it's the localStorage-PII landmine the CLAUDE.md security
checklist already forbids in spirit.

---

## 3. HTTP caching on the API (NestJS + Fastify)

Today the API emits **only defensive** `no-store`/`no-cache` and no validators. The
reverse proxy + Cloudflare sit in front, so **any positive shared cache directive is
dangerous** unless explicitly `private`. Cloudflare "Cache Everything" page rules can
override `no-store` (the export controller comment at `export.controller.ts:190`
already calls this out and adds belt-and-braces `private`).

| Mechanism | Applies to | Expected gain | PII/RLS-safe? | Recommendation |
|---|---|---|---|---|
| **`Cache-Control: private, max-age=N`** on per-tenant reads | owner/apartment/project lists, `/me` | Medium (browser memory/disk cache serves repeat GETs without hitting Railway) | **Borderline — needs care.** `private` keeps it out of the shared CDN, but it still lands in the browser's HTTP cache (disk). For PII-bearing responses that's the same disk-leak concern as persistQueryClient. Acceptable only for **non-PII** per-tenant payloads, and only `private`. NEVER `public`. | **Needs care / mostly skip.** TanStack already caches these in memory; adding `private, max-age` mostly duplicates that and risks writing PII to the browser disk cache. Prefer keeping API responses `no-store` for PII lists and let TanStack handle in-memory caching. |
| **`Cache-Control: public, max-age=...`** on per-tenant data | — | — | **DO NOT — cross-tenant CDN leak.** A `public` directive lets Cloudflare cache one tenant's response and serve it to another (the cache key is the URL, not the cookie). | **DO NOT.** Forbidden for anything under `/api/v1/*` that is RLS-scoped. |
| **`ETag` + `If-None-Match` (304)** | Big, slow-changing per-tenant payloads: org-settings, roles list, permission catalog, building/project lists | Medium — turns a repeat fetch into a tiny `304` (no body re-serialized, no re-encrypt, less egress). Latency win is mainly payload+egress, not the DB round-trip (the BE still validates the ETag, often by recomputing). | **Safe IF paired with `Cache-Control: private` (or `no-cache` which forces revalidation).** ETag itself leaks nothing; the validation request carries the cookie so RLS still applies. Must NOT be `public` (shared CDN could serve a 304 to compute a hit across tenants — avoid by `private`/`no-cache`). | **Win (needs care).** Add weak ETags on the heaviest slow-changing reads (org-settings, roles, catalog). Pair with `Cache-Control: private, no-cache` so the browser always revalidates but skips the body on match. Most valuable for the permission catalog (large, near-static) and org-settings. |
| **`stale-while-revalidate`** | per-tenant reads | Small | Only safe as `private, stale-while-revalidate` (browser-local). `public` SWR = shared CDN serving stale tenant data to others → **leak**. | **Skip for MVP.** TanStack's `staleTime` already gives SWR-style behavior in-memory, more controllably and without touching the HTTP cache. |
| **Reference-data endpoints cached** (enums, role definitions, permission catalog) | `/roles/catalog`, status enums, system role list | Medium | **Safe** — these are global, non-tenant, non-PII. Can even be `public, max-age` (CDN-cacheable) because they're identical for every caller. | **Quick win.** Mark genuinely global reference endpoints `Cache-Control: public, max-age=3600` (or `private` if any are auth-gated). The permission catalog is the prime candidate — it's already treated as 1h-static client-side. This is the ONE class of `/api` response that's safe to share-cache. Verify the endpoint returns NO tenant-specific fields first. |

**Net for HTTP:** the safe wins are (a) **ETag + `private, no-cache`** on a few heavy
slow-changing per-tenant reads (org-settings, roles), and (b) **`public, max-age`** on
the handful of truly global reference endpoints (permission catalog/enums). Everything
per-tenant must stay `private` at most, never `public`; PII lists should stay
`no-store` and rely on in-memory TanStack caching.

---

## 4. PostgresCacheProvider / cache_kv (server-side, per-tenant)

Today `cache_kv` is **not a read cache** — it backs the export rate-limit counter and
is reaped; the `PostgresCacheProvider` class is implemented but **unwired**. This is
the highest-leverage *server-side* opportunity, and the safest place to cache tenant
data **because the key includes the tenant id and the store lives inside our own RLS
boundary** (it never reaches a shared edge).

Candidates to serve from `cache_kv` (or the provider) on the read path:

| Hot read | Why cache | Suggested TTL | PII/RLS-safe? | Recommendation |
|---|---|---|---|---|
| **`/me` profile** | Hit on every dashboard load; today ~4 DB round-trips (per `query-provider.tsx` comment). Already seeded client-side, but the server seed still computes it each SSR. | 30–60s, keyed `me:{userId}:{sessionId}`, flushed on role/permission change + logout | **Safe** — key includes user id; value is the user's OWN profile (role + identity), not other tenants'. Must NOT include reveal-PII fields. Invalidate on any role/permission mutation (the same events that already `flushSessionCache`). | **Top server-side win (needs care).** Cache the resolved profile keyed by user+session. Biggest single per-request saving. Wire `PostgresCacheProvider` (or reuse the in-memory `session-validity` pattern) for it. Ensure invalidation on role grant/revoke. |
| **Org settings** | Read on many pages; changes rarely. | 5min, keyed `org-settings:{orgId}` | **Safe** — keyed by org; settings are config, not PII. Invalidate in `useUpdateOrgSettings`'s BE handler. | **Win.** Cache per-org; cheap, low-churn, no PII. |
| **Permission resolution / effective role** | `permission.service.ts` resolves per request (memoized only per-request). Cross-request cache would cut the resolve round-trip on every authz check. | 30–60s, keyed `perm:{userId}:{scope}` | **Safe** but **correctness-critical** — a stale grant means a user keeps/loses access late. Must flush on every role/override mutation. | **Needs care.** High value (authz is on the hot path) but the invalidation surface is large and security-sensitive (a stale *grant* is a privilege bug). Only do this with airtight flush-on-mutation, behind a flag, with tests. Treat as a deliberate slice, not a quick win. |
| **Reference data** (permission catalog, enums, system roles) | Global, near-static. | 1h+, global key (no tenant) | **Safe** — non-tenant, non-PII. | **Easiest win.** Cache once globally; trivially safe. (Client already does 1h; server can mirror.) |
| **Per-tenant list pages** (owners/apartments) | Heavy, but volatile and PII-bearing. | — | **DO NOT cache raw rows with PII in cache_kv** unless the cached value is the **already-decrypted-then-redacted** view AND keyed by tenant. Even then, decrypted PII sitting in `cache_kv` (a plain table) defeats pgcrypto-at-rest. | **DO NOT** put decrypted PII into `cache_kv`. If list pagination ever caches, cache only non-PII projections (ids, counts, masked fields) keyed by org. |

**Hard rule for cache_kv:** the value stored is plaintext JSONB in a regular table.
**Never store decrypted `national_id`/`phone`/signature blobs there** — that would
park cleartext PII outside the pgcrypto boundary, undoing the encryption-at-rest
guarantee and breaking the "PII never logged/never in plain stores" rule. Cache
**resolved config, identity-of-self, and reference data** — not other people's PII.

**Net for cache_kv:** wire the (already-built) `PostgresCacheProvider` for `/me`,
org-settings, and reference data — all per-tenant-keyed or global, all non-PII. This
is the safest tier to cache tenant-scoped data because it stays inside our RLS/Neon
boundary and never reaches a shared cache. Permission-resolution caching is high-value
but security-sensitive — do it carefully and explicitly, not casually.

---

## 5. Cloudflare edge (Pages + R2)

| Mechanism | Applies? | Expected gain | PII/RLS-safe? | Recommendation |
|---|---|---|---|---|
| **Static asset caching (immutable hashed JS/CSS chunks)** | Yes — Next emits content-hashed `_next/static/*`. Cloudflare Pages already serves these `immutable, max-age=31536000` by default. | Already realized | **Safe** — no tenant data, content-addressed. | **Already optimal.** No action. Just confirm `_next/static` keeps the immutable header (Pages default). The `next.config.ts` security headers explicitly apply to non-`/api` routes including `_next`. |
| **Edge-caching authed API data** | No. The proxy forwards Set-Cookie and per-tenant bodies; Cloudflare would key by URL, not cookie. | n/a | **DO NOT — cross-tenant leak.** This is the central landmine: a `public`/cacheable `/api/v1/*` response could be served to a different tenant. The export controller comment (`export.controller.ts:190`) already defends against CF "Cache Everything" overriding `no-store`. | **DO NOT** edge-cache anything under `/api/v1/*` that is RLS-scoped. Ensure no Cloudflare "Cache Everything" page rule covers `/api/*`. Truly-global reference endpoints (§3) could in principle be edge-cached `public`, but the safer place is the API HTTP header, not a CF page rule. |
| **Edge-caching public FE pages** (login, marketing, `/sign/[token]` shell) | Partially — the login/marketing HTML is non-tenant and could be static/edge-cached. `/sign/[token]` is per-token (no cookie) but the **shell** is static; the data is fetched per-token. | Small | **Safe for the static shell only.** The `/sign` token data and any signer PII must stay `no-store` (the sign layout already sets `robots noindex/nocache`). | **Low priority.** Could make login/marketing static for a faster first paint, but these aren't the latency-sensitive authed surface. Keep `/sign` data dynamic + `no-store`. |
| **R2 signed-URL caching** | Documents/signatures are served via short-lived presigned URLs (download TTL `120s` docs, `300s` contractor). The browser fetches the object **directly from R2** (CSP `connect-src` allows `*.r2.cloudflarestorage.com`). | Medium for repeat views of the same document | **Safe with care.** The signed URL itself is a bearer credential — it must NOT be cached in a shared layer or logged. The R2 *object response* can carry `Cache-Control` (e.g. `private, max-age=...`) so the browser reuses the bytes within the URL's TTL. Two requests to the *same* signed URL can share a browser-cached body. Do NOT set `public` on R2 objects (they're per-tenant documents). | **Win (needs care):** for frequently re-viewed documents, set the R2 object `Cache-Control: private, max-age` ≤ the signed-URL TTL so the browser caches the bytes for the URL's lifetime. Keep TTLs short (current 120/300s are good). Never log or share signed URLs. Consider lengthening the *signed-URL* TTL only if a document is large and re-fetched within a session — but short TTLs are the safer default. |

**Net for edge:** static chunks are already optimal; authed API data must never be
edge-cached (the cardinal leak); R2 object bytes can be browser-cached `private`
within the signed-URL TTL.

---

## Ranked recommendations

### Safe quick wins (low effort, no PII/RLS risk)
1. **TanStack per-entity `staleTime` tuning** — org-settings 5min, roles/members
   2-5min, buildings/projects 60s; keep PII lists ≤30s. (client, in-memory)
2. **TanStack `placeholderData: keepPreviousData`** on all cursor-paginated list hooks
   — instant paging, no flicker.
3. **Next.js `experimental.staleTimes.dynamic: 30`** — instant in-session back/forward
   (client-private Router Cache).
4. **`public, max-age=3600` on truly-global reference endpoints** (permission catalog,
   enums) — the only `/api` responses safe to share-cache. Verify zero tenant fields.
5. **Confirm `_next/static` immutable caching** (already on by default — verify, no
   change).

### Wins that need care (medium effort, must get invalidation/scoping right)
6. **`PostgresCacheProvider` for `/me` + org-settings + reference data** (server-side,
   per-tenant-keyed, non-PII) — wire the already-built unused class; invalidate on
   role/settings mutations. Highest server-side payoff.
7. **TanStack `prefetchQuery` on row/link hover** for detail pages — instant drill-in.
   Never prefetch reveal-PII.
8. **`<Link prefetch={true}>` on top nav links** to warm the route shell.
9. **ETag + `Cache-Control: private, no-cache`** on heavy slow-changing per-tenant
   reads (org-settings, roles) — 304s cut payload/egress.
10. **R2 object `Cache-Control: private, max-age` ≤ signed-URL TTL** for re-viewed
    documents.
11. **Permission-resolution server cache** (`perm:{userId}:{scope}`, short TTL,
    flush-on-mutation) — high value, security-sensitive; do as a deliberate slice with
    tests, behind a flag.

### DO NOT (PII / cross-tenant leak risk)
12. **`persistQueryClient` to localStorage/IndexedDB with the default cache** — writes
    tenant data/PII to JS-readable disk, survives logout, violates the
    httpOnly-only-storage rule (`apps/web/CLAUDE.md` Doc-10 §1). Out of scope for MVP.
13. **`Cache-Control: public` (or CF "Cache Everything") on any `/api/v1/*`
    RLS-scoped response** — serves one tenant's data to another. The cardinal leak.
14. **`force-static` / Full Route Cache on authed dashboard pages** — bakes one
    tenant's HTML for all.
15. **Storing decrypted `national_id`/`phone`/signature blobs in `cache_kv`** —
    parks cleartext PII outside the pgcrypto boundary. Cache only config/self-identity/
    reference data there.
16. **Edge-caching the reverse-proxy `/api/*` responses** — same cross-tenant leak as
    #13.

---

## Key file references
- `apps/web/next.config.ts` — FE config; no caching primitives set today.
- `apps/web/src/app/[locale]/(dashboard)/_components/query-provider.tsx` — TanStack
  defaults (30s/focus-refetch/network-retry) + `/me` server seed.
- `apps/web/src/hooks/use-session.ts` — `/me` 5min staleTime, exported seed key.
- `apps/web/src/hooks/use-roles.ts` — permission catalog 1h staleTime (the template).
- `apps/web/src/hooks/use-owners.ts` — `useRevealOwnerPii` = the never-cache-PII guard.
- `apps/web/src/lib/auth.ts`, `provider-auth.ts`, `_components/manager-home.tsx` —
  server fetches, all `cache: 'no-store'`.
- `apps/web/src/app/api/[...path]/route.ts` — reverse proxy (forwards headers, adds no
  caching).
- `packages/db/src/providers/cache/cache.interface.ts` + `postgres.provider.ts` —
  `ICacheProvider` + `PostgresCacheProvider` (built, **unwired**).
- `apps/api/src/modules/export/export-rate-limit.service.ts` — the only live `cache_kv`
  writer (rate-limit counter, raw SQL).
- `apps/api/src/modules/auth/session-validity.ts` — 15s in-memory session-active cache
  + `flushSessionCache` (invalidation pattern to reuse).
- `apps/api/src/common/authz/permission.service.ts` — per-request
  `PermissionResolutionCache` (memoization, not cross-request).
- `apps/api/src/main.ts` — Helmet (CSP/HSTS, no cache policy).
- `apps/api/src/modules/export/export.controller.ts:190-197` — defensive
  `private, no-store` + the explicit Cloudflare "Cache Everything" warning.
- `apps/api/src/modules/documents/storage.ts:38` (`DOWNLOAD_URL_TTL_SECONDS = 120`),
  `contractor-portal/contractor-read.service.ts:34` (`= 300`) — R2 signed-URL TTLs.
