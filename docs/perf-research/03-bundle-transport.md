# Perf Research 03 — JS Bundle Delivery + Network Transport

> **Scope:** every JS-delivery + network-path lever that reduces **cold-first-visit**
> and **TTFB** for the EMAPP web app (Next.js 15 App Router on Cloudflare Pages,
> NestJS API on Railway behind a Pages-Function reverse-proxy).
> **Mode:** read-only research. No code changed. Quantified + EMAPP-specific.
> **Author note:** the RSC / Server-Component refactor (§v9-M-1) is covered by a
> separate research track; this doc only flags where it interacts.

---

## 0. TL;DR — the honest headline

**The JS bundle is already lean and the prod numbers are already good.** Measured
against the *production* build (`docs/.prod-audit.out`, base `:3002` = `next build`),
the steady-state is:

- `GET /me` (prod): **138 ms**
- API interactions (prod, local DB): **26–205 ms**
- Page loads (prod): **431–1567 ms**, most **sub-second**
- Login → dashboard (prod): **1098 ms**

The "nerve-wracking wait" people felt was **dev-mode** (on-demand compile + unminified
chunks, 5–65 s cold, ~1.7 s warm overhead) — a dev artifact, not the product. So the
real remaining cold-first-visit budget is small, and the wins below are *incremental*,
not transformational. Be skeptical of any lever claiming ">200 ms" here — the headroom
isn't that big.

**Where the genuine wins are, ranked:**

1. **`next-intl` ships the FULL message bundle to the client** (he.json = **95 KB**,
   en.json = 78 KB) on every page, un-namespaced — this is the single biggest
   *avoidable* first-load payload. Especially acute on the public `/sign/<token>`
   page (the highest-volume external surface), which statically imports all 95 KB
   for ~a dozen strings.
2. **`experimental.optimizePackageImports` is NOT set** — a one-line config flag
   that tree-shakes `lucide-react` (used in 23 files) and the radix/tanstack barrels.
3. **`next/dynamic` is used ZERO times** — the StepUpDialog modal, the export button,
   document-upload, and other below-fold/rare islands all ship in the route's
   first-load JS.
4. **The proxy double-hop** for server-side `getMe()` (§v9-M-9) is real but the
   prod measurement (`/me` = 138 ms) says it's not the bottleneck people feared.

---

## 1. Bundle analysis

### 1.1 Dependency footprint — what's actually in `apps/web/package.json`

The runtime dep list is **deliberately small** and already audited. The heavy-lib
checklist comes back almost entirely clean:

| Suspected heavy lib | In web bundle? | Notes |
| --- | --- | --- |
| date libs (date-fns / moment / dayjs / luxon) | **NO** | grep across `apps/web/src` = 0 hits. Dates use native `Intl.DateTimeFormat` / `toLocaleDateString` (`src/lib/format.ts`). The only date-lib hits in the repo are **API/worker-side** (export, tabu). ✅ |
| charts (recharts / chart.js) | **NO** | 0 hits in web. ✅ |
| PDF (react-pdf / pdfjs / @react-pdf) | **NO** | PDF generation is API/worker-side (export.service, tabu). The FE never bundles a PDF renderer. ✅ |
| calendar lib (react-day-picker / fullcalendar) | **NO** | The "calendar" grep hits are icon/text only (`manager-home`, `portal`). The V11 "Calendar" track has **not** pulled a calendar lib into web yet. ✅ |
| shadcn/radix | **MINIMAL** | Only **`@radix-ui/react-slot`** is imported (one file: `components/ui/button.tsx`). The `ui/` dir has **7** components, all hand-rolled (`button`, `status-badge`, `name-display`, `list-page-shell`, `list-skeleton`). The StepUpDialog modal is a **hand-rolled `<div role="dialog">`** — NOT `@radix-ui/react-dialog`. So there is no large radix tree to split. ✅ |
| `@sentry/nextjs` | **server-only** | `src/instrumentation.ts` guards on `NEXT_RUNTIME === 'nodejs'` and dynamically `import('@sentry/nextjs')`. There is **no client Sentry SDK import** anywhere in `src` (grep confirms). So Sentry's ~30–50 KB browser SDK is **NOT** in the first-load JS. ✅ This is the right call — don't "add" client Sentry without budgeting it. |
| `msw` | **dev-only, dead-coded** | `MswInit` short-circuits on the build-time-inlined `NEXT_PUBLIC_MSW` constant; Terser dead-codes the `import('./browser')` in prod. ✅ |
| `zod` | shared | Used for the defensive response-parse on every API wrapper. Real cost (~12–14 KB gz) but it's load-bearing for the security model — **not** a candidate to remove. |
| `lucide-react` | **23 files** | See §1.3 — this is the one icon set worth `optimizePackageImports`. |
| `react-hook-form` + `@hookform/resolvers` | forms only | Reasonable; lives on form routes. Could be split per-route but low ROI. |
| `@tanstack/react-query` | core | Needed app-wide; the provider mounts in the dashboard layout. |

**Conclusion:** there is **no heavy-library bloat to excise.** The known prod numbers
(shared First Load JS ~103 KB; chunks 3451 ~46 KB + 862c7446 ~54 KB) are consistent
with: React 19 + react-dom + next runtime + tanstack-query + next-intl runtime +
react-hook-form + zod + the small radix-slot. That ~103 KB shared is close to the
floor for this stack.

### 1.2 Barrel-file tree-shaking misses

Grepped `export * from` and `index.ts` across `apps/web/src`: the **only** barrel
files are under `src/mocks/samples/` (MSW fixtures) and `src/mocks/handlers/`. Those
are **dev/MSW-only and dead-coded in prod** — they do not defeat tree-shaking in the
shipped bundle. There is **no production barrel-file problem.** ✅

### 1.3 `lucide-react` — the one real icon-tree-shaking lever

`lucide-react` is imported in **23 files**. Modern lucide-react + Next's bundler
*should* tree-shake named imports, but `optimizePackageImports` makes it deterministic
(transforms `import { X } from 'lucide-react'` → per-icon deep imports at compile time),
which both shrinks the chunk and **cuts module-count / cold-eval time**. Low risk,
one-line config.

### 1.4 `next.config.ts` — missing optimization flags

`apps/web/next.config.ts` currently sets: `output` (conditional standalone),
`reactStrictMode`, `typedRoutes`, security `headers()`, and wraps with `withNextIntl`.

**Not set (all quick-win candidates):**

- `experimental.optimizePackageImports: ['lucide-react', '@tanstack/react-query', 'next-intl']`
  — tree-shakes the named barrels. **Quick win, low risk.**
- `modularizeImports` — not needed given optimizePackageImports covers lucide;
  listed only for completeness.
- `compiler.removeConsole` (prod) — the codebase already bans `console.log` (lint),
  so marginal, but a cheap belt-and-suspenders to strip any stray `console.*` and a
  few bytes. Low ROI.
- No `webpack`/`turbopack` bundle-analyzer wired — recommend adding
  `@next/bundle-analyzer` behind an env flag to *measure* before/after, since the
  margins here are small and unverified guesses are worse than no change.

### 1.5 `next/dynamic` — zero usage today

Grep for `next/dynamic` across `apps/web/src` = **0 matches.** Every island ships in
its route's first-load JS even when it's below-fold or rarely opened. Candidates,
ranked by (size × how-often-it's-NOT-needed-on-first-paint):

| Component | File | Why split | Caveat |
| --- | --- | --- | --- |
| **StepUpDialog** / `useStepUpUnlock` | `components/step-up-unlock.tsx` | A modal opened ONLY on a `pii_step_up_required` 403 — rare, never on first paint. Pulls `lib/api/step-up` + its own form. | The hook returns `dialog` rendered inline; dynamic-import the `StepUpDialog` body (`dynamic(() => import(...), { ssr:false })`) keeps the hook seam, defers the modal JS. |
| **ExportXlsxButton** | `projects/[id]/_components/export-xlsx-button.tsx` | Below-fold action on project detail; only Managers click it. | Small; low-medium ROI. |
| **ProjectDocumentUpload** | `projects/[id]/_components/project-document-upload.tsx` | Upload widget; not needed for first paint of the detail page. | Has R2/content-path logic. |
| **ParcelSetupSection / TabuReviewSection** | `projects/[id]/_components/parcel-setup-section.tsx`, `apartments/[id]/_components/tabu-review-section.tsx` | Heavy, conditional (parcel auto-setup / tabu review only when relevant). | Good split candidates. |
| **RolesScreen / SettingsTabs** | `settings/roles/_components/roles-screen.tsx`, `settings/_components/settings-tabs.tsx` | Admin-only, infrequent. | Route-level — already isolated by route-splitting; dynamic adds little. |

**Reality check:** Next App Router already route-splits, so each route only ships its
own page + the shared chunk. `next/dynamic` mainly helps for *within-route* islands
that are below-fold or conditional. The biggest single win is **StepUpDialog** because
it's referenced from multiple PII-bearing pages but opened almost never.

---

## 2. The proxy double-hop (§v9-M-9)

### 2.1 Server-side `getMe()` — server → Pages-Function → Railway

`apps/web/src/lib/auth.ts:getMeCached()` fetches `${origin}/api/v1/me` where `origin`
is the app's **own** Pages hostname. So a Server Component render does:

```
RSC render (Pages Function) ──fetch──► app.emapp.io/api/v1/me (SAME Pages Function)
                                             └──proxy──► Railway /api/v1/me ──► DB
```

That's the public proxy route handler invoked from *inside* the server render — an
extra in-edge hop + a second TLS/connection setup vs a direct `fetch(API_BACKEND_URL)`.

**Quantified (measured, not asserted):** prod `GET /me` end-to-end = **138 ms**
(`.prod-audit.out`). The CLAUDE.md trade-off doc estimates the *proxy overhead portion*
at ~5–15 ms. The render-time amplifier is that **`getCurrentSessionUser()` →
`getMe()` runs in the dashboard layout, which is the parent of EVERY authed route**,
and React `cache()` already dedupes it to **one** call per request (the prior bug was
N duplicate `/me`s measuring ~4.3 s — already fixed). So today the per-render cost is
one ~138 ms `/me`, ~5–15 ms of which is the avoidable proxy hop.

**Lever:** let `auth.ts` read `process.env['API_BACKEND_URL']` directly server-side and
skip the public proxy (it would still forward the `access_token` cookie, but bypass the
header-strip/CF-rewrite machinery that's pointless for a server-origin call).

**Trade-offs (why it's not free):**
- Breaks the single-env-var contract (only `API_BACKEND_URL` matters today; the
  guard `auth.spec.ts` would need updating to *allow* a direct `API_BACKEND_URL`
  read — it currently bans `API_URL`).
- The proxy's Set-Cookie passthrough / header-strip would no longer apply to the
  `/me` call, so any future refresh-on-`/me` would need bespoke cookie handling.
- **Expected gain ~5–15 ms.** Real but small. Worth doing as a structural cleanup,
  NOT as a "fix the wait" lever.

### 2.2 Client `/api/v1/*` calls — browser → Pages-Function → Railway

Every browser API call also traverses the Pages Function. The alternative (browser →
Railway directly with CORS) would **remove one hop** but:

- **Loses host-only cookies.** Today FE + API share `app.emapp.io` in the browser's
  eyes (D.35), so the session cookies are `hostOnly`, no `Domain=` leak, `SameSite=Lax`,
  no CORS preflight. A direct `api.emapp.io` call needs `SameSite=None; Secure` +
  `Domain=` cookies (subdomain-takeover surface) + CORS preflight (`OPTIONS` round-trip
  *adds* latency for non-simple requests — net-negative for the very calls we'd hope to
  speed up).
- **Loses the free Cloudflare WAF / Bot-Management / Argo** that the same-origin proxy
  buys, and re-exposes Railway to the public internet.

**Quantified:** the Pages Function is at the CDN edge and the measured client
interactions are **26–205 ms** in prod — the proxy hop is NOT a measurable tax at that
scale. **Recommendation: do NOT bypass the client proxy.** The CORS path trades a
~single-digit-ms hop for a preflight round-trip + a worse security posture. Keep it.

---

## 3. Middleware cost (`src/middleware.ts`, ~51 KB)

The middleware runs on every non-asset request and does two things:

1. **Per-request CSP nonce** (`btoa(crypto.randomUUID())`) + `buildCspHeader` — cheap,
   and **mandatory** (§MQA-1: a static CSP renders the whole App Router blank because
   Next emits inline RSC-flight scripts that need a nonce). Cannot be removed.
2. **Tier-aware auth gate** — a handful of pre-compiled regex `.test()` calls
   (`PUBLIC_ROUTE_REGEX`, `AUTH_ROUTE_REGEX`, provider/tenant tier regexes) + `next-intl`
   locale routing (`intlMiddleware`). All regexes are module-scoped (compiled once),
   so per-request cost is a few `.test()` + one `intlMiddleware()` call — **microseconds
   of CPU**, not a TTFB driver.

**The 51 KB is the bundled middleware *artifact* size (code shipped to the edge once),
NOT a per-request transfer.** It does not touch the browser and does not inflate
first-load JS. So "trim the 51 KB" is largely a non-lever for cold-first-visit.

**The one real lever here — the matcher:**

```ts
matcher: ['/((?!api|_next|_vercel|.*\\..*).*)', '/sign/:path*'],
```

This already excludes `/api`, `/_next`, `/_vercel`, and **any path with a `.`**
(static assets: `favicon.ico`, images, `.js`/`.css`). So static assets already
**skip** the middleware. ✅ The `/sign/:path*` second entry deliberately re-includes
the dotted JWT path (defense-in-depth) — correct and necessary.

**Possible micro-trim:** the matcher could additionally exclude well-known
public files (`robots.txt`, `sitemap.xml`, `manifest.webmanifest`, `monitoring`) if
any get added, but today there's nothing measurable to skip. **No meaningful
middleware TTFB win available** — the design is already tight. Treat this section as
"verified not a problem" rather than an opportunity.

---

## 4. Transport

### 4.1 Compression (brotli/gzip)

Cloudflare Pages **auto-compresses** responses (brotli for modern browsers, gzip
fallback) at the edge for compressible content-types (HTML, JS, CSS, JSON). No app
config needed and **none is present** — which is correct. The 95 KB he.json
serialized into the RSC payload compresses to roughly ~20–25 KB on the wire, which
softens (but does not eliminate) the §5.1 message-bundle cost. **No action** beyond
confirming CF Auto-Minify/Brotli is enabled in the CF dashboard (ops check, not code).

### 4.2 HTTP/2 / HTTP/3

Cloudflare serves HTTP/2 + HTTP/3 (QUIC) by default to the browser. Multiplexing means
the ~103 KB shared chunk + route chunk + font woff2 + the RSC stream all share one
connection — no head-of-line blocking. **Already optimal; no code lever.**

### 4.3 Font loading (Heebo) — already well tuned

`src/app/[locale]/layout.tsx` (and `src/app/sign/layout.tsx`):

```ts
const heebo = Heebo({ subsets: ['hebrew','latin'], weight: ['400','600','700'],
                      variable: '--font-heebo', display: 'swap' });
```

- `next/font/google` → **self-hosted at build**, no runtime Google fetch, `preload`
  automatic, woff2. ✅
- **Subset to `hebrew` + `latin`** only. ✅
- **`display: 'swap'`** — text paints immediately in fallback, no FOIT. ✅
- **Already narrowed from 6 weights × 2 subsets (12 woff2, ~250–400 KB) to 3 weights**
  (§PERF-M1) — ~150 KB already saved.

**Remaining micro-lever:** if a real-browser audit shows `latin` is only used for a
handful of glyphs (digits/punctuation), dropping to `['hebrew']` + `adjustFontFallback`
would shave one woff2. Low ROI; verify with coverage data first. The font path is
**not** a cold-first-visit problem.

### 4.4 Render-blocking CSS

Tailwind (`globals.css`) is compiled to a single purged stylesheet, inlined/linked by
Next with automatic critical-CSS handling. shadcn is hand-rolled (no extra CSS-in-JS
runtime). **No render-blocking CSS lever** beyond what Next already does.

### 4.5 `<Link>` prefetching

App Router `<Link>` prefetches route RSC payloads on viewport/hover by default. The
sidebar nav links benefit automatically — **already on**. (Watch: prefetch
multiplies the §5.1 message-bundle cost across prefetched routes if messages are in the
per-route payload; another reason to narrow §5.1.)

---

## 5. First paint + static shell

### 5.1 ⭐ The `next-intl` full-message-bundle payload — the top avoidable cost

**`src/app/[locale]/layout.tsx`** does:

```tsx
const messages = await getMessages();          // ALL of he.json (95 KB) / en.json (78 KB)
<NextIntlClientProvider messages={messages}>   // → serialized into the client RSC payload
```

`NextIntlClientProvider` is given the **entire** message catalog, un-namespaced, so
every client component tree gets all ~95 KB of Hebrew strings serialized into the
flight payload on first load (and again, prefetched, for `<Link>`-prefetched routes).
On the wire it's ~20–25 KB brotli, but it's pure first-load weight + parse on **every**
cold visit.

**Worse on the public signing page:** `src/app/sign/layout.tsx` does a **static**
`import heMessages from '@/messages/he.json'` — pulling all **95 KB** into the bundle
for the `/sign/<token>` route, which needs maybe a dozen `sign.*` keys. This is the
**highest-volume external surface** (every apartment owner clicks an SMS link, cold,
often on mobile), i.e. exactly the cold-first-visit + conversion-critical page where
payload matters most.

**Levers (ranked):**

1. **`/sign` page: pass only the `sign` (+ shared) namespace** instead of the full
   import. Replace the static full-catalog import with a narrowed object
   (`{ sign: heMessages.sign, common: heMessages.common }`). **Biggest single
   first-load KB win on the most cold-sensitive page.** Low risk (the page only uses
   `sign.*` keys).
2. **Dashboard: narrow `NextIntlClientProvider messages`** to the namespaces the
   client islands actually use (next-intl supports passing a subset; server components
   keep using `getTranslations` with the full catalog). Higher effort (must enumerate
   which namespaces each client tree needs), medium risk (a missed key throws at
   runtime) — but the structural win is real and recurring.
3. If full narrowing is too invasive, at minimum **lazy-load rarely-used namespaces**
   (provider audit, imports mapping) so the common dashboard payload shrinks.

### 5.2 Static shell / skeleton before data

The app already has `list-skeleton.tsx` + `list-page-shell.tsx`, and several pages
(`audit`, `settings`) are **server-rendered and already PASS sub-second** in prod
(431–467 ms). The remaining slower pages (dashboard home 1567 ms, projects 1226 ms,
buildings 1205 ms) are `'use client'` pages doing client fetch after hydration
(§v9-M-1, the pending RSC refactor). **Interaction with the RSC track:** moving those
list/detail pages to Server Components for the initial fetch (+ a Suspense skeleton
shell that streams instantly) is the single biggest *first-paint* win — but that's the
**other research track's** call. From a *bundle/transport* view, the relevant note is:
**the skeleton shell should render from the static/server layer BEFORE the message
bundle + data resolve**, and §5.1's payload narrowing makes that shell-to-content gap
smaller. The two tracks compound.

### 5.3 Dashboard SSR sequential `/me` → stats

`docs/PERF-AUDIT-REPORT.md` finding #3: the dashboard layout resolves `/me`
server-side, then the page resolves `/org/stats` — sequential across the layout→page
boundary. **Lever:** stream with Suspense so the shell (sidebar + topbar, which only
need `/me`) paints before stats resolve. Again primarily an RSC-track concern; flagged
here because it's part of the first-paint critical path and the proxy-hop (§2) sits
inside it.

---

## 6. Ranked optimization table

Gains are **cold-first-visit / first-load** oriented and deliberately conservative —
prod steady-state is already good (§0), so the headroom is modest. KB figures are
uncompressed source weight; on-wire is ~4–5× smaller after brotli.

| # | Optimization | Expected gain | Effort | Risk | Recommendation |
| --- | --- | --- | --- | --- | --- |
| 1 | **`/sign` page: import only the `sign` namespace, not all of `he.json`** | **−~90 KB** source (~−20 KB wire) on the highest-volume cold page | **S** | Low | **Do it.** Best ROI; the signing page is the most cold/mobile-sensitive surface. |
| 2 | **`experimental.optimizePackageImports: ['lucide-react', '@tanstack/react-query', 'next-intl']`** | −few KB + fewer modules → faster cold eval | **XS** (1 line) | Low | **Do it.** Cheapest config-flag win; verify with bundle-analyzer. |
| 3 | **Narrow `NextIntlClientProvider messages` in the dashboard layout to used namespaces** | −tens of KB serialized into every cold RSC payload (× prefetched links) | **M** | Med (missed key → runtime throw) | **Do it, carefully.** Enumerate per-tree namespaces; add a test that every used key resolves. Recurring win. |
| 4 | **`next/dynamic` the StepUpDialog** (then Export/Upload/Parcel/Tabu islands) | −the modal/island JS off first-load of PII/detail pages | **S–M** | Low | **Do it for StepUpDialog first** (multi-page, rarely opened); others lower priority. |
| 5 | **Add `@next/bundle-analyzer` behind an env flag** | 0 ms direct; *enables measuring* 1–4 | **XS** | None | **Do it first** — margins are small; measure before/after so changes are evidence-based. |
| 6 | **Direct `process.env['API_BACKEND_URL']` for server-side `getMe()`** (bypass proxy hop) | **−~5–15 ms** per dashboard render | **S** | Med (env-contract + `auth.spec.ts` guard update; lose proxy header/cookie machinery) | **Optional / structural.** Real but small; don't sell it as fixing "the wait." |
| 7 | **Drop Heebo `latin` subset → `['hebrew']`** (if coverage data justifies) | −1 woff2 file | **XS** | Med (Latin glyphs in mixed content fall back) | **Verify-first.** Only if a real-browser audit shows Latin is near-unused. |
| 8 | **`compiler.removeConsole` in prod** | −negligible KB | **XS** | Low | **Skip / nice-to-have.** Lint already bans console; marginal. |
| — | Bypass the **client** API proxy for direct-Railway+CORS | NEGATIVE (adds preflight, worsens cookie/security) | — | High | **Do NOT.** Documented anti-pattern; keep the same-origin proxy. |
| — | Trim the 51 KB middleware | ~0 (it's edge code, not browser JS; matcher already skips assets) | — | — | **No lever.** Verified already tight. |
| — | Remove charts/PDF/date/radix bloat | 0 (none present) | — | — | **N/A.** Bundle is already lean. |
| — | Add client-side Sentry | NEGATIVE (+30–50 KB) | — | — | **Keep Sentry server-only** as today. |

### Quick-wins (config / small, ship this week)
- #5 bundle-analyzer (measure first), #2 `optimizePackageImports`, #1 `/sign` namespace
  narrowing, #4 StepUpDialog dynamic-import.

### Structural (own slices, coordinate with RSC track)
- #3 dashboard message-namespace narrowing, #6 proxy-hop bypass, and the RSC
  Server-Component-first-fetch + Suspense-shell refactor (§5.2/§5.3 — other track).

---

## 7. What this research deliberately does NOT claim

- It does **not** claim a >200 ms cold win is available from bundle work. The prod
  build already lands most pages sub-second; the dev-mode wait was the real felt pain.
- It does **not** recommend swapping the proxy topology, the auth stack, or the font.
- Every KB number here is **source weight from grepped/read files** (he.json 95 KB,
  en.json 78 KB, ui/ = 7 components, lucide in 23 files, radix-slot = 1 import); every
  ms number is from the **measured** `docs/.prod-audit.out` (prod build) or
  `docs/PERF-AUDIT-REPORT.md`. Anything I couldn't measure (exact post-`optimizePackageImports`
  delta) is flagged "verify with bundle-analyzer" rather than asserted.

---

### Source files read for this research
- `apps/web/next.config.ts`, `apps/web/package.json`
- `apps/web/src/app/api/[...path]/route.ts` (the proxy)
- `apps/web/src/lib/auth.ts`, `apps/web/src/lib/session.ts`
- `apps/web/src/middleware.ts`
- `apps/web/src/app/[locale]/layout.tsx`, `apps/web/src/app/sign/layout.tsx`
- `apps/web/src/app/[locale]/(dashboard)/layout.tsx`
- `apps/web/src/app/[locale]/(dashboard)/_components/query-provider.tsx`
- `apps/web/src/components/step-up-unlock.tsx`
- `apps/web/src/i18n/request.ts`, `apps/web/src/instrumentation.ts`
- `apps/web/src/mocks/msw-init.tsx`
- Measured data: `docs/.prod-audit.out`, `docs/PERF-AUDIT-REPORT.md`,
  `docs/PERF-AUDIT-BROWSER-dev.json`, `docs/PERF-AUDIT-INVENTORY.md`
