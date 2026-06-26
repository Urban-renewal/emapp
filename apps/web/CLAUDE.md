# @emapp/web — Next.js 15 Frontend

App Router, RTL (Hebrew default), Heebo font, shadcn/ui, next-intl.

## Critical rules

- Never import from `@emapp/config` (serverEnv) in client components — server-side only.
- All user-facing strings go through next-intl (`useTranslations` / `getTranslations`).
- RTL-first: use `ms-*` / `me-*` (margin-start/end) not `ml-*` / `mr-*`.
- shadcn components live in `src/components/ui/`. Add via `npx shadcn@latest add <component>`.
- No `console.log` in production code.
- Wrap user-supplied / wire-supplied names in `<NameDisplay>` (which `<bdi>`s the text). Prevents RTL spoofing via embedded U+202E / U+2067 marks. See `src/components/ui/name-display.tsx` (§v9-H-3).

## Starting the server

```
pnpm --filter @emapp/web dev   # runs on port 3001
```

### Offline mode (MSW + SAMPLE\_\*)

For UI development without a live API (closes §v9-P0-1):

```
NEXT_PUBLIC_MSW=1 pnpm --filter @emapp/web dev
```

MSW intercepts every `/api/v1/*` call and returns the SAMPLE\_\* fixtures in `src/mocks/samples/`. Schema-parsed at CI time (`src/mocks/samples/samples.spec.ts`) — drift fails the build. Don't set `NEXT_PUBLIC_MSW=1` in production.

## Adding a locale string

1. Add to `src/messages/he.json` (Hebrew first — default locale).
2. Add matching key to `src/messages/en.json`.
3. Use in component: `const t = useTranslations('namespace')`.

## Architecture

- `src/app/layout.tsx` — minimal root (Next.js requirement)
- `src/app/[locale]/layout.tsx` — Heebo + RTL + NextIntlClientProvider
- `src/middleware.ts` — next-intl locale routing + auth gate (strict-regex public surface per §v9-H-2)
- `src/i18n/routing.ts` — locale config (he | en)
- `src/components/ui/` — shadcn components + `<NameDisplay>` (bdi wrapper)
- `src/lib/utils.ts` — cn() utility
- `src/lib/api-client.ts` — fetch wrapper with envelope guard, 15s timeout, Idempotency-Key auto-mint for `postIdempotent`, single-flight refresh on token_expired (§v9-P0-3/P0-4/H-6/H-7)
- `src/lib/api/*.ts` — per-entity wrappers (defensive Zod parse on every response per ARCHITECTURE-MAP §1)
- `src/adapters/*.ts` — Wire → ViewModel (Doc 05 §9.8); pure functions; run in TanStack `select`
- `src/models/*.vm.ts` — ViewModel type definitions
- `src/hooks/use-*.ts` — TanStack Query wrappers; staleTime 30s; refetchOnWindowFocus true; retry 3 with exponential backoff (queries only; mutations 0 retries)
- `src/mocks/` — MSW handlers + SAMPLE\_\* fixtures (offline dev surface)

## Trade-offs (documented per v9 audit closures)

### Server-side `getMe()` double-hop (§v9-M-9 — REVERSED 2026-06-26, latency)

**Now: direct server→API hop.** `apps/web/src/lib/auth.ts:getMe()` fetches `${API_BACKEND_URL}/api/v1/me` DIRECTLY on the server, skipping the self-hop through the `/api/[...path]` Pages-Function proxy. The old path went SERVER → its own proxy route → Railway — a redundant round-trip back through the web server on every authenticated SSR render (~0.39s measured warm). Warm authed pages must be <1s (hard latency budget), so the self-hop was removed.

**What's preserved:** cookie forwarding (the `access_token` is still sent as an explicit `Cookie` header — a server `fetch` attaches no browser cookies), 401→null (unauthenticated) handling, the `AbortSignal.timeout(15_000)` hung-backend defense, `cache: 'no-store'`, and the exact return shape. `API_BACKEND_URL` is the SAME single env var the proxy reads (`route.ts:getBackendBase()`); the upstream path (`/api/v1/me`) is byte-for-byte what the proxy emits — the backend contract is unchanged, and `API_URL`/`NEXT_PUBLIC_API_URL` are still banned by `auth.spec.ts`.

**Fallback:** if `API_BACKEND_URL` is unset (bare unit env), `getMe` falls back to the §v9-H-1-allowlisted self-origin proxy path so behaviour is never silently broken. `logout()` still routes through the proxy (one-shot action, not per-render — not a latency hotspot).

### Server Components vs `'use client'` pages (§v9-M-1 — pending refactor)

Every `(dashboard)/<entity>/page.tsx` is `'use client'` today. Per Doc 05 §4.3 + Agent C, Server Components should be the default — list + detail pages COULD do their initial fetch server-side then hydrate Client islands.

**Why we accept it for now:** uniformity. Every page uses the same TanStack Query hook pattern with the same loading / error UI shape. A Server Component refactor would split the data path in two (server fetch for first paint, client refetch for invalidation). Tracked for the Phase 8 polish slice.

### TanStack `refetchOnWindowFocus: true` (§v9-M-8 — re-enabled in v9)

Earlier we set this `false` to reduce request volume. v9 reverted to `true` per Agent C: users with two tabs SHOULD see the other tab's writes on focus return. `staleTime: 30_000` bounds the actual refetch rate.

## Security checklist (mandatory per task)

- No `localStorage.setItem('token')` — tokens are httpOnly cookies only (Doc 10 §1)
- No PII in URL query params — search via POST body (Doc 07 §7.10)
- No `dangerouslySetInnerHTML` with user/API content (Doc 10 §5)
- Idempotency-Key on create POSTs (Doc 06 §5.7) — use `apiClient.postIdempotent`
- 401 with `code === 'token_expired'` triggers silent refresh, NOT a logout (D.31 G2)
- 401 with `code === 'invalid_credentials' | 'invalid_otp' | 'not_member'` does NOT fire the global unauthenticated event (form-level concerns)
- All user-supplied name display wrapped in `<NameDisplay>` (§v9-H-3 / bidi spoofing defense)
- CSP headers in `next.config.ts` apply to all non-`/api` routes (§v9-P0-5)
- Server-Action self-fetch goes through `selfOrigin()` allowlist (§v9-H-1)

## v9 audit closures status

See `OPEN-ITEMS-v9-PHASE4A-AUDIT.md` for the full ledger and closure status.
