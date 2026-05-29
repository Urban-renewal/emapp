# EMAPP — Performance & Coverage Follow-up Audit

> Follow-up to `STATE-OF-PRODUCT.md`, closing the 4 gaps it skipped — chiefly
> **the owner's #1 pain: slowness.** Every number here is a mechanical artifact
> (curl timing, `pg` round-trip measurement, Playwright trace, EXPLAIN). Read-only
> on product code (seed + audit scripts under `packages/db/scripts/` and
> `apps/web/e2e/audit/` are audit tools). Real stack: web:3001 + api:3000 + Neon.
>
> **Headline:** the slowness is real and I found exactly where it goes. It is **not**
> the FE and **not** query execution (sub-ms). It is **DB round-trip COUNT × DB round-trip
> LATENCY**. Two architectural multipliers turn one logical read into 4–6 network
> round-trips; in this dev/demo setup each round-trip to Neon is **138 ms**, so a single
> list call costs ~560–920 ms. Co-locating the app with the DB shrinks the latency, but
> the round-trip _count_ is the lever that matters everywhere.

---

## The one-paragraph answer: where do the seconds go?

A logged-in manager who clicks "owners" waits ~**1.5 s** (dev) before the list paints. That
splits into: **~460 ms** server-side `getMe()` that blocks the HTML of _every_ authenticated
page (a browser→Next→API→Neon round-trip just to render the chrome), then **~920 ms** for the
list itself — of which **~0 ms is the query** and **~900 ms is six sequential Neon round-trips**
that `withTenant` performs around it (`BEGIN`+`SET ROLE`, `set_config×3`, the query, `COMMIT`,
plus PII-decryption). At 138 ms/round-trip that arithmetic is exact. **Remove the round-trips
and the seconds disappear.**

---

## A — Where the time goes (measured, wall-clock)

### A0. Foundational measurement — the per-request cost is round-trips, not work

| Probe                                                    | Time        | Note / artifact                                                                                                                                                          |
| -------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Raw Neon round-trip (`SELECT 1`, warmed)                 | **138 ms**  | `pg` client from dev machine; 6 samples 137–149 ms                                                                                                                       |
| 4-round-trip tx (`BEGIN`/`set_config`/`SELECT`/`COMMIT`) | **556 ms**  | matches list timings exactly → the cost IS the round-trips                                                                                                               |
| API `/health` (no DB, no auth)                           | **3–5 ms**  | API itself is fast — the "~210 ms fixed cost" the team documented in `app.controller.ts` is a **`localhost`-IPv6 measurement artifact**, not framework overhead (see A4) |
| API `/me` (auth + 1 session round-trip)                  | **~155 ms** | ~1 Neon round-trip                                                                                                                                                       |
| `projects?limit=25` (30 rows)                            | **~580 ms** | = 4 `withTenant` round-trips; query is sub-ms                                                                                                                            |
| `signature-requests?limit=25` (of 500)                   | **~580 ms** | same envelope                                                                                                                                                            |
| `owners?limit=25` (of 800)                               | **~920 ms** | + ~2 extra round-trips (count + PII decryption)                                                                                                                          |

### A1. Volume seed (the step the prior audit skipped) — done

`packages/db/scripts/seed-volume.ts` created org `perf-load-dev` in **12.2 s**: **30 projects,
60 buildings, 3014 apartments** (one heavy building = 300), **800 owners, 100 documents,
500 signature requests**, ownerships on the heavy building. Scale verdict: **list query
execution stays sub-ms even at 3000 rows** (indexes hold; confirms STATE-OF-PRODUCT Layer 4).
The bottleneck is **not** row count — it is the round-trip envelope, which is constant per
request regardless of data size. _(Seed bug noted: generated phones use invalid `051` prefix
→ unusable for OTP; cosmetic for the audit.)_

### A2. Real workflow, wall-clock per navigation (warmed; dev mode)

SSR time-to-first-byte (curl, warmed, via 127.0.0.1 to remove the localhost tax):
| Navigation | SSR TTFB | Breakdown |
|---|---|---|
| `/he/login` (unauthenticated) | **~18 ms** | pure render, no `getMe` |
| `/he/projects` (authenticated) | **~460 ms** | render + **`getMe` SSR self-fetch** |
| `/he` dashboard (authenticated) | **~560 ms** | render + `getMe` |
→ **`getMe` adds ~440 ms to every authenticated page's HTML**, before the browser can even start hydrating or fetching the page's real data. TanStack client cache works: repeat navigation within 30 s `staleTime` fires **0** API calls (a genuine positive).

### A3. Component breakdown of a slow step (owners list, dev)

```
click "owners"
├─ SSR getMe (layout, BLOCKS html)         ~460 ms   ← browser→Next proxy→API→Neon
├─ html transfer + hydrate (dev)            (dev-inflated)
└─ client TanStack fetch /api/v1/owners     ~920 ms   ← 6× Neon round-trip @138ms
                                                          (query itself <1 ms)
   ≈ 1.4–1.5 s to usable data (dev/local)
```

**Round-trip inventory per tenant-scoped API call (`withTenant`, `with-tenant.ts`):**

1. `BEGIN; SET LOCAL ROLE app_user` — round-trip 1
2. `SELECT set_config(org_id), set_config(enc_key), set_config(hash_key)` — round-trip 2
3. the actual query — round-trip 3
4. `COMMIT` — round-trip 4
   (+ owners adds a count + decryption ≈ 2 more). **None of these are pipelined.**

### A4. The `localhost` IPv6 tax (dev/measurement; proven)

`localhost:3000` connect = **214 ms**; `127.0.0.1:3000` = **3 ms**; `[::1]` = **2030 ms**.
Windows `localhost` resolves IPv6-first; the IPv4 fallback costs ~200 ms (curl Happy-Eyeballs).
The product's `API_BACKEND_URL=http://localhost:3000`, so the Next server's `getMe`/proxy hops
pay a smaller version of this (~60 ms via Node/undici, which prefers IPv4 faster than curl).
**Prod uses a real hostname → this specific tax vanishes**, but it inflates all local dev/demo
"feel". The team's documented "~210 ms framework fixed cost" is this artifact, not Nest/Fastify.

### A — Bottlenecks → fix → expected saving (sorted by impact)

| #   | Bottleneck (artifact)                                                                  | Root cause                                                                                           | Fix                                                                                                                                                                        | Saving                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Every tenant-scoped API call = 4–6 sequential Neon round-trips (556 ms measured for 4) | `withTenant` issues `BEGIN`/`set_config`/query/`COMMIT` un-pipelined                                 | Collapse session setup into **one** round-trip (multi-statement `BEGIN; SET ROLE; SELECT set_config(...)`), drop the separate `COMMIT` round-trip for reads                | **−3 round-trips ≈ −410 ms/call @138ms RTT** (dev); −6–9 ms/call in colocated prod but on **every** request + frees pooled connections sooner |
| 2   | `getMe` SSR blocks every authenticated page HTML (~460 ms dev)                         | layout `getMe()` does a browser→Next→API→Neon round-trip per render; re-validates session every time | Cache session-validity (short TTL) **and/or** render the shell and load user client-side; or bypass the proxy self-hop (server→API direct, §v9-M-9 "trivially reversible") | **−155 to −460 ms per navigation**                                                                                                            |
| 3   | `projects`/`documents` list sorts the whole org set at scale                           | missing `(org_id, created_at DESC, id DESC)` index (STATE-OF-PRODUCT PERF-1)                         | add the composite index (mirror owners/tasks)                                                                                                                              | O(n) sort → O(limit) index scan as orgs grow                                                                                                  |
| 4   | Error feedback takes **7–9 s**                                                         | TanStack `retry:3` + exponential backoff; even retries 4xx                                           | don't retry 4xx; cap backoff; show error after 1 attempt for non-network                                                                                                   | **−5 to −7 s to error feedback**                                                                                                              |
| 5   | Dev/demo `localhost` IPv6 tax (~60–200 ms/hop)                                         | IPv6-first resolution                                                                                | set `API_BACKEND_URL=http://127.0.0.1:3000` in dev, or `node --dns-result-order=ipv4first`                                                                                 | **−60 ms per proxied hop** in dev                                                                                                             |

**Conclusion:** the seconds a manager feels (~1.5 s/screen in dev) are **~460 ms `getMe` + ~920 ms list round-trips + dev/localhost overhead**. Fixes #1+#2 alone cut the **architectural** round-trip count from ~10 to ~3 per screen — the single biggest lever, and it helps prod (round-trip count) as much as dev (round-trip count × high RTT).

---

## B — Tier / role coverage (the 2 of 3 tiers the prior audit skipped)

| Role / tier                  | Verdict                            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Resident (OTP → portal)**  | **WORKS — own-data-only enforced** | Forged a valid OTP (dev code unrecoverable), `verify`→200 + `tenant_access_token` (HttpOnly, 10-min, `aud=emapp-tenant`, **no refresh** per D.21). `/portal/me` → own owner record; `/portal/apartment` → only the owner's apartment; `/portal/documents`/`/portal/signatures` scoped to it; **`?ownerId=<other>` ignored** (token-derived, no param injection). `docs/audit/artifacts/coverage/portal-me.json` |
| **Agent (assigned-only)**    | **WORKS**                          | Manager sees 9 projects, **agent sees 0** (none assigned); agent by-id read of a manager project → **404** (no-oracle). Scoping enforced server-side.                                                                                                                                                                                                                                                           |
| **Provider (login + MFA)**   | **BLOCKED (MFA-gated)**            | `POST /provider/auth/login` → **400 `mfa_code: Required`** — MFA mandatory at the DTO (positive). Cannot complete black-box without a TOTP secret. Console remains a shell per prior audit.                                                                                                                                                                                                                     |
| **Contractor (share-scope)** | **NOT EXERCISED**                  | Needs a generated share-link token; not created this pass.                                                                                                                                                                                                                                                                                                                                                      |

### B — CRITICAL-adjacent finding (PII)

**`PII-PORTAL` (MEDIUM — review):** `/portal/me` returns the resident's **`nationalId` and `phone` in CLEARTEXT** (`"nationalId":"200000008"`), whereas every org-side endpoint **masks** them (`•••••••53`, D.19). It is the resident's _own_ data (not a cross-tenant leak), so it may be intentional — but it is **inconsistent with D.19 masking** and puts raw national-ID on the wire. Needs an explicit product decision: may an owner see their own un-masked national-ID? If not, mask it here too.

### B — Operational finding

The shared dev DB has accumulated **46,282 owners** and **167 provider_users** from prior test runs (no cleanup). Not a product bug, but it (a) made black-box OTP phone-matching ambiguous and (b) suggests test-data hygiene / a reset routine is missing for the dev environment.

---

## C — Error handling (systematic)

Intercepted client `/api/v1` calls (Playwright route abort / forced 500 / bogus-id 404).
Evidence: `docs/audit/artifacts/coverage/error-handling.json`.

| Scenario                        | What the user sees                                                                   | Verdict                    |
| ------------------------------- | ------------------------------------------------------------------------------------ | -------------------------- |
| List page, **BE down (abort)**  | `טוען...` for ~7 s → then **`טעינת הרשימה נכשלה / נסה שוב`** (Hebrew + retry button) | **Graceful but SLOW**      |
| List page, **HTTP 500**         | same — generic Hebrew error + retry; **no raw stack / no English leak**              | **Graceful but slow**      |
| Detail page, **bogus id (404)** | loading → error state (no crash, no blank)                                           | OK                         |
| All scenarios                   | **no blank screen, no uncaught exception, no raw error envelope shown**              | Envelope handling **good** |

**Finding `ERR-1` (MEDIUM):** failure feedback takes **7–9 s** because TanStack retries 3× with
exponential backoff (and retries non-retryable 4xx). The user stares at a spinner long enough to
assume the app froze. Fix = don't retry 4xx + cap the backoff (same as A-fix #4).
**Positive:** errors are localized Hebrew, never leak stacks/codes, never blank the screen.

---

## D — Jank / feel (during real interaction)

| Observation                              | ms / evidence                       | Note                                                                                       |
| ---------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------ |
| Per-navigation server delay before paint | **~460 ms** (`getMe` SSR)           | every authenticated click waits ~½ s before the new page's HTML arrives (dev)              |
| List "loading" dwell on cache-miss       | **~580–920 ms** of `טוען...`        | owners worst; driven by round-trip count                                                   |
| Failure feedback dwell                   | **7–9 s** of `טוען...` before error | `ERR-1` — the worst "feels broken" moment                                                  |
| Repeat navigation (cached)               | **instant, 0 API calls**            | TanStack `staleTime:30s` — genuinely snappy                                                |
| Loading states exist                     | `טוען...` text on every list        | no blank flashes; but text-only (no skeleton) → mild layout shift when content replaces it |

The dominant "feel" problems share the **same roots as section A** (round-trip count + retry
backoff) — fixing A-#1/#2/#4 removes the spinner dwell _and_ the slow-failure feel.

---

## TOP-5 PERF WINS (ordered by impact)

1. **Pipeline `withTenant` session setup** (4–6 round-trips → 1–2). Touches **every** tenant-scoped API call. Dev: ~−410 ms/call; prod: fewer round-trips + faster connection release. _Biggest lever._
2. **Stop blocking page SSR on `getMe`** (cache session validity / client-load the user / bypass the proxy self-hop). ~−155–460 ms **per navigation**.
3. **Add the `projects`/`documents` cursor composite index.** Removes the at-scale Sort/Seq-scan (STATE-OF-PRODUCT PERF-1).
4. **Fix TanStack retry** (no 4xx retries, cap backoff). ~−5–7 s to error feedback (`ERR-1`).
5. **Dev: `API_BACKEND_URL=127.0.0.1` / IPv4-first** to kill the ~60–200 ms localhost-IPv6 tax in dev/demo; **prod: co-locate app + Neon** so the round-trip latency (138 ms here) drops to single-digit ms.

### Still BLOCKED / not covered

- **Provider console** — MFA-gated black-box (could forge a TOTP session as a follow-up, as done for OTP); known shell.
- **Contractor share-scope** — needs a generated share token.
- **Production-representative absolute ms** — all numbers are **dev mode** (`next dev`, remote Neon). Dev inflates absolutes; the **relative breakdown and round-trip counts are the durable signal**. A `next build && next start` + colocated DB pass would give final production numbers.
