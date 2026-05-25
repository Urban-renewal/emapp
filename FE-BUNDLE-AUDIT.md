# FE Bundle Audit — Post-QA follow-up

**Date:** 2026-05-25
**Branch:** `fix/qa-perf-and-session-display`
**Trigger:** QA finding F-PERF-1 (1.7 s `/projects` TTFB) was re-characterized as geographic, not algorithmic — so if a real production user complains about latency, the cause is more likely the FE bundle, hydration, or a specific endpoint, not the DB. This audit covers the FE bundle.

## Outcome

**The FE bundle is healthy. None of the customer-felt latency complaints traceable here.**

## Build summary

```
Route (app)                                     Size  First Load JS
├ ƒ /[locale]                                  136 B         103 kB
├ ƒ /[locale]/projects                       4.19 kB         161 kB
├ ƒ /[locale]/owners                         1.51 kB         161 kB
├ ƒ /[locale]/imports                        1.54 kB         162 kB
├ ƒ /[locale]/documents                      4.66 kB         161 kB
├ ƒ /[locale]/signature-requests             4.34 kB         161 kB
├ ƒ /[locale]/login                          3.83 kB         160 kB
├ ƒ /[locale]/signup                         3.94 kB         160 kB
├ ƒ /sign/[token]                            2.78 kB         145 kB
+ First Load JS shared by all                 103 kB
ƒ Middleware                                 50.8 kB
```

- All dashboard routes: **158–169 KB First Load JS** (gzipped). Within best-practice limits for a React + TanStack Query + shadcn/ui + next-intl + Heebo Hebrew-subset stack.
- Resident signing surface `/sign/[token]`: **145 KB** — lighter because the (auth)/(dashboard) shell + sidebar/topbar is not included.
- Shared base: **103 KB** (two chunks: 54 KB + 46 KB) — React/Next core + TanStack/business shared.
- Middleware: **50.8 KB** — next-intl machinery (locale resolution, alternate links, domain handling). Hard to reduce without losing i18n features.

## Heebo font — already optimal

`apps/web/src/app/[locale]/layout.tsx:11-17` narrows the font load to:

```ts
const heebo = Heebo({
  subsets: ['hebrew', 'latin'],
  weight: ['400', '600', '700'], // 3 weights, not the default 6
  variable: '--font-heebo',
  display: 'swap', // FOUT, not FOIT
});
```

`display: 'swap'` means text renders immediately in fallback font and swaps when Heebo arrives — no invisible-text moment. The §PERF-M1 comment in that file already documents the ~150 KB saving vs the default weights. No further win available without dropping a weight, which would force component-level font-weight changes.

## MSW dead weight — minor cleanup opportunity (not a perf issue)

`apps/web/src/mocks/msw-init.tsx` correctly dead-codes the dynamic `import('./browser')` when `NEXT_PUBLIC_MSW !== '1'` (the constant branch is folded by Terser). The runtime cost is zero — no browser ever fetches the MSW worker in prod.

**However**, webpack still emits the dynamic-import chunks during compilation **before** Terser eliminates the reference. The result is two MSW-specific chunks shipped to CDN but never loaded by any page:

| Chunk       | Size raw | Purpose                                   | Loaded by any page?                             |
| ----------- | -------- | ----------------------------------------- | ----------------------------------------------- |
| `5814-*.js` | 272 KB   | MSW core (interceptors, request matchers) | **No** — verified via `app-build-manifest.json` |
| `5605-*.js` | ~smaller | MSW handler bindings                      | **No** — same                                   |

Chunks `2330-*` (Zod, 56 KB) and `3396-*` (`@emapp/shared-types` enums, 18 KB) are ALSO listed under the MSW dependency tree in `middleware-react-loadable-manifest.js`, but those are **legitimately shared** with the regular app — every dashboard page already loads them for its own runtime needs. Not a leak.

**Action (optional, not urgent):** if we want to drop the dead chunks too, add a webpack alias in `next.config.ts` to replace `msw/browser` with an empty stub when `NEXT_PUBLIC_MSW !== '1'`. The runtime impact is zero either way; this is purely CDN bandwidth hygiene.

## The actual customer-felt latency suspects (not investigated here)

The bundle is clean, so if real production users complain about latency, look at — in rough order of likelihood:

1. **Double-fetch waterfall (§v9-M-1)** — every `(dashboard)/<entity>/page.tsx` is `'use client'`. The flow is SSR shell → JS download → hydrate → TanStack Query fires → fetch → re-render. The first byte arrives fast; **time-to-data-visible** is the painful number. Doc 05 §4.3 + the v9 audit already accept this as a trade-off "pending Phase 8 polish." If the customer's pain matches this, the Phase 8 refactor (Server Component → fetch server-side → hydrate Client islands) is the lever.
2. **Cloudflare Pages Function proxy cold-start (D.35)** — each `/api/v1/*` call from the browser routes through a Pages Function reverse proxy to Railway. CF Pages workers cold-start in 5-50 ms; if the user's region routes to a cold CF POP, that's user-felt latency that doesn't show up in Railway logs.
3. **A specific endpoint with N+1 / heavy join** — list endpoints we measured were all near-empty. A populated `/projects` with many buildings/apartments could trigger N+1 in the relations. Needs `pg_stat_statements` profiling against prod-shaped data.
4. **Hydration cost on the dashboard layout** — Topbar + Sidebar + AuthGuard + QueryProvider are all client components. Heavy interactive pages might be ≥100 ms hydration on slower phones.
5. **Auth-refresh single-flight (D.31 G2)** — if access token expired mid-session, the silent refresh adds one round-trip before retry. Usually OK, but if it races with a navigation, the user can feel a brief stall.

## What this audit doesn't claim

- Did not measure Time-to-Interactive on a real device — just static analysis of build output.
- Did not test against a populated tenant (real data sizes might reveal endpoint-specific slowness).
- Did not profile React render time per component.
- Did not run Lighthouse — the QA pass was 5-axis API/Network/Console/Cookies/Server, not Lighthouse-style FE perf.

If the customer's pain persists after the F-PERF-2 fix lands and the double-fetch waterfall is accepted, the next concrete step is a Lighthouse run against a Railway preview deploy with realistic seed data + a Chrome DevTools Performance recording for one specific slow user action.
