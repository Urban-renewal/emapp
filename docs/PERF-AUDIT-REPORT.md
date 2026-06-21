# EMAPP Performance Audit — Report (Phase 1: measure)

**Environment:** real Chromium (Playwright) → web `:3001` → API `:3000` on
`DB_TARGET=local` (native Postgres, the client-faithful path).
**Harness:** `apps/web/perf-audit/run.mjs` (reusable — re-run anytime).
**Coverage:** the full action inventory (`docs/PERF-AUDIT-INVENTORY.md`), 21
page-load actions measured this pass (lists + details + login). Per action:
COLD (first hit) + WARM (median of 3, time-to-content) + the `/api/v1` waterfall.

## The headline (measured, not asserted)

| Layer | Measured | Verdict |
| ----- | -------- | ------- |
| **Database / API call (local)** | **median 240 ms** / call (range 98–481 ms) | **Fast — solved.** The Neon-distance 1–2 s/call is gone. |
| **API total per list page** | ~500 ms (2 calls: `/notifications` + the entity list) | acceptable on local; ~10–40 ms each in same-region prod |
| **Warm time-to-content (dev)** | **~2.0–2.8 s** | the FE render, NOT the DB |
| **⇒ Non-API portion** | **~1.5–1.7 s / page** | **Next.js DEV-MODE** (RSC on-demand + unminified chunks + hydration) |
| **COLD first hit (dev)** | 5–65 s | pure dev **compile-on-demand** — a dev artifact, prod has none |

**The conclusion the numbers force:** on the local DB the database is no longer
the bottleneck (~240 ms/call). What's left of the "wait" on the dev server is
**Next.js development-mode overhead** — on-demand compilation, unminified code,
no production caching. **A production build (what the client actually runs)
eliminates that layer entirely.** Measuring "sub-second" against the dev server
is measuring the dev toolchain, not the product.

## Per-action (warm time-to-content, dev)

| Action | cold (compile) | warm (content) | API calls (each) | verdict |
| ------ | -------------- | -------------- | ---------------- | ------- |
| login → dashboard | 5.1 s | — | server-side | — |
| dashboard home | 1.9 s | 1.39 s | server-rendered (`/me`+`/org/stats` SSR) | SLOW(dev) |
| projects list | 8.1 s | 2.18 s | notifications 232 / projects 276 | SLOW(dev) |
| owners list | 14 s | 2.78 s | notifications 297 / owners 481 | SLOW(dev) |
| documents list | 12 s | 3.17 s | notifications 289 / documents 355 | SLOW(dev) |
| buildings list | 8.2 s | 2.79 s | notifications 162 / projects 220 | SLOW(dev) |
| apartments list | 4.6 s | 2.66 s | notifications 240 / projects 286 | SLOW(dev) |
| signature-requests | 14 s | 2.25 s | notifications 219 / sig-req 303 | SLOW(dev) |
| members list | 15 s | 2.77 s | notifications 229 / members 301 | SLOW(dev) |
| tasks list | 10 s | 1.99 s | notifications 246 / tasks 300 | SLOW(dev) |
| notes list | 6.1 s | 2.20 s | notifications/members/notes ~300 ea | SLOW(dev) |
| notifications | 7.9 s | 2.00 s | notifications ×2 ~185 | SLOW(dev) |
| audit log | 3.0 s | **0.81 s** | server-rendered | **PASS** |
| contractors | 5.2 s | 2.22 s | notifications 181 / contractors 236 | SLOW(dev) |
| settings | 4.8 s | **0.91 s** | server-rendered | **PASS** |
| settings/roles | 7.1 s | 2.06 s | notifications 203 / roles 306 / catalog 290 | SLOW(dev) |
| project detail | 15 s | 1.97 s | notifications 202 / project 277 | SLOW(dev) |
| owner detail | 8.5 s | 2.01 s | notifications 129 / owner 185 ×2 | SLOW(dev) |
| imports list | 65 s | **60 s ⚠** | API fast (imports 285) but content never rendered | INVESTIGATE |
| document detail | 64 s | **60 s ⚠** | API fast (document 130) but content never rendered | INVESTIGATE |

## Findings → Phase-2 targets

1. **The client/prod verdict is unmeasured** — the dev numbers are dev-mode.
   **Action:** run this same harness against an isolated PRODUCTION build
   (`next build` in a worktree, served on :3002 → local API), to get the real
   client numbers. Projection: API ~500 ms (local) or ~50–100 ms (same-region
   prod) + prebuilt FE render ~200–400 ms ⇒ **sub-second**. Must confirm, not assume.
2. **`/notifications` fires on EVERY page** (~240 ms tax on each navigation — the
   bell island). Prod-relevant. **Lever:** one shared long-`staleTime` query so
   it's fetched once per session, not per page.
3. **Dashboard SSR runs `/me` then `/org/stats` back-to-back** (server-side,
   sequential across the layout→page boundary). **Lever:** parallelize / stream
   (Suspense) so the shell paints before stats resolve.
4. **Dev-experience (separate from the client):** the 5–65 s cold compiles + the
   ~1.7 s warm dev overhead are the developer's daily pain. **Lever:** Turbopack
   (`next dev --turbo`) — typically 5–10× faster dev compiles. Doesn't affect
   prod, but directly fixes the "every click waits" feel while developing.
5. **2 pages didn't render content within 60 s** (imports list, document detail)
   despite their APIs returning fast. Likely a real render issue or a harness
   content-selector miss — **investigate** (could be a genuine bug).

Already shipped (prod-relevant, this session): `/me` client double-fetch killed
(#401), `/members` eager dashboard fetch gated, signature-progress double-tx
collapsed (#402), `DB_TARGET` flag for the local DB (#403).
