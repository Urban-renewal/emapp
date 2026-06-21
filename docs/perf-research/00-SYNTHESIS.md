# Perf Research — Synthesis & Ranked Execution Plan

> Date: 2026-06-17. Synthesizes `01-rsc-waterfall.md`, `02-caching-layers.md`,
> `03-bundle-transport.md`, `04-api-data-latency.md`. Author: Claude Code (Opus 4.8).
> Anchored to a **measured** prod waterfall (real Chrome, local stack).

## The measured customer waterfall (prod build, warm-cached)

```
0  ──► 148ms   server sends HTML shell      (TTFB 137ms — FAST)
148 ─► 261ms   parse + hydrate
261 ┈► 511ms   ⚠️ 250ms dead gap — React mounts, then the hook fires
511 ─► 609ms   GET /owners (98ms)           ← data only STARTS here
609+ ─► render rows
```

**The single controllable customer cost is the `'use client'` fetch-after-hydration
waterfall (§v9-M-1): ~500ms on cold prod, more on deep-links.** Everything else (TTFB,
DB, API) is already fast. The dev "10s/3s" is dev-mode compile and does NOT reach customers.

## Ranked plan (by ROI for the **production** customer)

| # | Item | Gain (customer) | Effort | Risk | Gate |
|---|---|---|---|---|---|
| **T0** | **Verify Railway BE region == Neon region** | up to ~165ms/hop × 4 RT if currently cross-region | zero-code | none | **owner-owned (infra)** |
| **T1** | **RSC server-prefetch + `HydrationBoundary`** (the keystone) | **~500ms–1.4s** cold time-to-data | 1d helper+pilot, 2–3d fan-out (~15 pages, mechanical) | cookie-forward; Turbopack-safe modules | green-gate + browser smoke |
| T2a | `experimental.optimizePackageImports` (next.config) | small bundle | 1 line | low | green-gate |
| T2b | TanStack per-entity `staleTime` + `keepPreviousData` | smoother pagination, fewer refetches | low | low | green-gate |
| T2c | `experimental.staleTimes.dynamic` + `<Link prefetch>` hover | instant warm nav | low | low | green-gate |
| T2d | `next/dynamic` StepUpDialog + heavy islands | small first-load | low-med | low | green-gate |
| T3a | **owners `created_at` index + keyset expression indexes** (~18 sites) | API list sort cost | low | low | **migration = Gate-6** |
| T3b | Wire `PostgresCacheProvider` (cache_kv) for `/me` + org-settings | 4RT→1RT on `/me` | med | per-tenant-keyed; non-PII only | security-review |
| T3c | `next-intl` 95KB catalog narrowing (esp. public `/sign`) | bundle on external surface | med | low | green-gate |
| T4 | Cut `withTenant` 4RT→2RT (pipeline / role drop) | API fixed cost | med | **security surface** | Gate-2/6 |

## DO NOT (confirmed PII/cross-tenant landmines)

- ❌ `persistQueryClient` → localStorage/IndexedDB (writes tenant PII to JS-readable disk,
  survives logout; violates httpOnly-only-storage rule).
- ❌ `Cache-Control: public` / Cloudflare edge-cache on any `/api/v1/*` RLS-scoped response
  (serves one tenant's data to another — the cardinal leak).
- ❌ `force-static` on authed pages; decrypted `national_id`/`phone`/signatures in `cache_kv`.

## Recommended sequence

1. **Owner:** confirm prod Railway region == Neon region (T0 — biggest free win, infra-only).
2. **Now:** RSC keystone — build the reusable `prefetchToDehydratedState` helper +
   `serverApiGet` (reusing `getMe`'s `selfOrigin()` + cookie-forward posture, in plain
   non-`'use server'` modules), pilot on `projects/page.tsx`, prove via view-source (real
   rows in SSR HTML, no client list GET), measure in Chrome.
3. Fan out RSC to the ~15 org-tier list/detail pages, batch-smoked.
4. Cheap config wins (T2a–T2d) — one slice.
5. Index migration (T3a, Gate-6) + cache_kv wiring (T3b, security-review).
6. Defer T4 (withTenant RT reduction) — security-surface change, separate Gate.
