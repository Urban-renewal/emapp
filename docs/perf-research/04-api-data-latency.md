# 04 — API Data-Latency Research (read-only)

**Scope:** NestJS 11 + Fastify (Railway) → Drizzle → PostgreSQL 16 + RLS +
pgcrypto (Neon, transaction-pooled). Goal: find the realistic API latency
**floor** and the highest-ROI backend wins. This is research only — no code
was changed. Every claim cites a real file.

Prior work this builds on: `#401` (seed session cache → kill redundant `/me`),
`#402` (collapse signature-progress double-tx), `#403` (`DB_TARGET` flag →
local DB for dev), and `docs/PERF-AUDIT-REPORT.md` (the dev-vs-prod
measurement pass: on local DB the API is ~240 ms/call median and the remaining
"wait" is Next.js **dev-mode** compile/hydration, not the DB).

---

## TL;DR — the floor

```
API floor  ≈  app→Neon RTT  +  (4–5 serial DB round-trips × RTT)  +  query exec
```

The dominant, IRREDUCIBLE term is **serial round-trips to Neon**, because
`withTenant` (the wrapper EVERY customer read goes through) is a **multi-statement
transaction**: it spends **3 round-trips on fixed ceremony** (BEGIN+SET ROLE →
set_config GUCs → … → COMMIT) *before and after* the actual query.

| Path | app↔Neon RTT (same region) | RTT (cross-region, today's dev) |
| ---- | -------------------------- | ------------------------------- |
| Per round-trip | ~1–3 ms intra-AZ, ~1 ms same-region | ~50–165 ms (dev→us-east-1) |
| `withTenant` fixed ceremony (3 RT) | ~3–9 ms | ~150–500 ms |
| + 1 query RT | +1–3 ms | +50–165 ms |

**Realistic same-region prod floor for a single-query read endpoint:
~5–15 ms of DB time** (4 serial RT + light query), on top of Fastify +
guard + JSON overhead (~2–5 ms). **Call it ~10–25 ms warm.** The measured
~200 ms "warm" is NOT the same-region floor — it is dominated by either
(a) cross-region RTT in dev, or (b) Next.js dev-mode FE render (per the audit).
**Below ~10 ms you cannot go without caching the read out of Postgres entirely.**

The single highest-leverage backend lever is **collapsing the `withTenant`
round-trip ceremony from 3 fixed RT to 1**, because it multiplies on every
endpoint and every nested `withTenant` (e.g. `/me` pays it twice).

---

## 1. `withTenant` / RLS overhead — the per-request fixed cost

`packages/db/src/wrappers/with-tenant.ts` does, per call:

| Step | Statement | Protocol | Round-trip? |
| ---- | --------- | -------- | ----------- |
| checkout | `pool.connect()` | — | 0 (warm pool) / 1 (cold) |
| RT 1 | `BEGIN; SET LOCAL ROLE app_user` | simple, multi-stmt | **1** |
| RT 2 | `SELECT set_config(...) ×2–3` (org_id, encryption_key, [user_id]) | extended, param-bound | **1** |
| RT 3 | the actual `fn(tx)` query (often 1, sometimes N) | extended | **≥1** |
| RT 4 | `COMMIT` | simple | **1** |

So **even a trivial single-row read is a 4-round-trip transaction.** Three of
those four are pure RLS/PII ceremony. `with-provider.ts` is *worse*: it opens
**two separate connections** (autonomous audit-INSERT tx on one, then the work
tx on another) — that path is ~7 round-trips before the query even runs
(audit: BEGIN → set_config → INSERT → COMMIT; work: BEGIN → set_config →
query → COMMIT). Justified for audit-integrity (SA-7), but it means every
Provider read is ~2× the org-read floor.

**Is the RLS context set in one round-trip or several?** Today it's **two**
(BEGIN/SET-ROLE is deliberately separate from the set_config so the role is
dropped before any GUC is set). The GUCs themselves are already coalesced into
ONE `set_config(...)` call — good. But the `BEGIN; SET LOCAL ROLE` is a
separate network round-trip from the GUC set.

**Cost on a pooled Neon connection (cross-region dev):** at ~50–165 ms/RT the
ceremony alone is ~150–500 ms — this is *exactly* the "nerve-wracking wait"
the memory attributes to dev→Neon distance. Same-region prod: ~3–9 ms.

**Could a pipelined/prepared approach cut it?** Yes — three levers, ranked:

- **(a) Fold the whole prologue into ONE round-trip.** A single multi-statement
  simple-query string —
  `BEGIN; SET LOCAL ROLE app_user; SELECT set_config('app.organization_id',$1,true), set_config('app.encryption_key',$2,true), set_config('app.user_id',$3,true);` —
  collapses RT1+RT2 into one. The blocker is parameter binding: the current code
  keeps org_id / keys **parameter-bound** so they never appear in query logs
  (with-tenant.ts:53 comment, spec §5/§10.3). A combined simple-query would
  inline them. **Mitigation:** keep `BEGIN; SET LOCAL ROLE app_user` as a static
  string and *pipeline* it with the param-bound set_config using the pg driver's
  pipelining, OR move org_id into a `SET LOCAL` that reads a session var. Net
  win: **4 RT → 3 RT** (or 2 with COMMIT pipelined). At cross-region RTT that's
  ~33% of the DB wait; at same-region it's marginal.

- **(b) Pipeline COMMIT with the last query** (send query + COMMIT back-to-back
  without waiting). `pg` supports this via the pipelining/batch path. Saves 1 RT.

- **(c) Drop `SET LOCAL ROLE` where the connecting role already lacks
  BYPASSRLS.** The role-drop exists because the connecting role
  (neondb_owner) has BYPASSRLS. If the app pool connected as `app_user`
  *directly* (a non-BYPASSRLS login role), the `SET LOCAL ROLE` round-trip
  disappears entirely and RLS still applies. This is the cleanest 1-RT
  removal — **but** it's a security-surface change (the pool's base role)
  and must be Gate-reviewed (D.21 owns the role model). Worth a spike.

**Verdict:** the RLS *policy evaluation* itself is cheap for flat tables
(`org_id = current_setting(...)::uuid` is a sargable equality —
`migrations/0004_rls_policies.sql`). The cost is the **round-trip ceremony**,
not the policy. Nested-subquery policies are a separate, smaller cost (§4).

---

## 2. Connection pooling & geography

`packages/db/src/client.ts` + `db-target.ts`:

- **App pool** (`pool`): `connectionString = dbTarget.appUrl`, `max=20`
  (`DB_POOL_MAX`), `idleTimeoutMillis=30s`, `connectionTimeoutMillis=5s`,
  `statement_timeout=30s`, keepAlive on (10s probe).
- **Provider pool**: `max=5`, `statement_timeout=60s`.
- For `DB_TARGET=neon`, `appUrl = DATABASE_URL` and `pooled: true` — the
  comment in `db-target.ts:91` confirms `DATABASE_URL` is **the
  transaction-pooled `-pooler` endpoint** (Neon's pgBouncer in
  transaction mode). So **yes, the API uses the pooled URL.** The migrator
  uses the direct endpoint (`DATABASE_MIGRATE_URL`) because session GUCs
  must survive `BEGIN` — runtime does not.

**Transaction-pooler interaction with `withTenant`:** this is fine *and*
important. `withTenant` wraps everything in an explicit `BEGIN…COMMIT`, so
pgBouncer transaction-mode pins the same backend for the whole transaction —
`SET LOCAL` GUCs and `SET LOCAL ROLE` stay correct for the duration and are
auto-reset at COMMIT. No GUC leakage across pooled clients. The cost is that
each `withTenant` **holds a pooler server-connection for its full duration**
(4 RT), so at cross-region RTT a single slow read ties up a pooled backend for
~200–500 ms → fewer effective concurrent slots. Same-region this is a
non-issue.

- **Cold connection cost:** `pool.connect()` on an empty/idle pool opens a new
  TCP+TLS+startup handshake to the pooler — at cross-region that's a multi-RT
  (~hundreds of ms) one-time tax. `keepAlive:true` + `idleTimeoutMillis:30s`
  keep warm connections alive between requests, so steady-state checkout is ~0.
  `DB_POOL_MAX=20` per pod: the client.ts comment (line ~18) correctly warns to
  set this **lower** per pod behind the pooler (many pods × 20 exhausts
  Postgres). This is a scale knob, not a latency knob.

- **Geography — the load-bearing unknown.** Memory + `db-target.ts:109` note
  **~165 ms dev→us-east-1** vs ~1 ms local. The PROD question is unanswered in
  the repo: **is Railway's region co-located with the Neon region?** Nothing in
  `docs/` pins the Railway region or the Neon region. **This is the #1 thing to
  verify**, because it decides whether the floor is ~10 ms (same region) or
  ~200 ms+ (cross-region — every one of the 4 serial `withTenant` RT pays the
  full inter-region RTT). **Action: confirm Railway BE region == Neon project
  region (both us-east-1 / iad, or both eu).** If they differ, co-locating them
  is a *zero-code* win that dwarfs every other item in this doc — it divides the
  whole API latency by the RTT ratio.

---

## 3. pgcrypto decrypt cost on list endpoints

Key finding: **the owners list does NOT do N+1 decrypt round-trips.** Decryption
happens **inside the SELECT**, server-side, in the *same* single query
round-trip (`apps/api/src/modules/owners/owners.service.ts:67-110`):

```sql
-- NID_MASK / PHONE_MASK / NAME_DECRYPTED are SQL fragments:
pgp_sym_decrypt(owners.name_encrypted, current_setting('app.encryption_key'))::text
```

So for an N-row owners page it is **O(N) symmetric-crypto CPU inside Postgres,
1 network round-trip** — not N round-trips. The N+1 *round-trip* anti-pattern
that the batch helpers in `packages/db/src/helpers/owners.ts`
(`decryptOwnerPiiBatch`, `decryptOwnerNamesBatch`) exist to fix is for
*userland* decrypt sites (export composer, calendar-email ICS) — and those are
already batched to 1–3 round-trips total (helper docstrings cite ~5 s → ~150 ms
for 1000 owners at Neon RTT).

**Is the per-row crypto a measurable cost?** `pgp_sym_encrypt/decrypt` is PGP
symmetric (CAST5/AES + an **expensive default S2K key-derivation per call**).
On a list page each masked field is a separate `pgp_sym_decrypt` invocation:
owners list decrypts **3 fields/row** (name + national_id-suffix +
phone-suffix). At, say, a 50-row page that's **150 pgp_sym_decrypt calls
server-side per request** — each re-deriving the session key from the passphrase.
That is real CPU on the Neon compute (typically single-digit-to-low-tens of µs
each for the cipher, but the S2K derivation can dominate). It does **not**
add network latency, but it **adds Neon CPU** and scales with page size — a
500-row page is 1500 derivations.

**Optimizations (ranked):**
- **(a) Lazy / projection-only decrypt.** The list shows only a **masked
  suffix** of national_id/phone (`'•••••••' || right(decrypt,2)`). It still
  decrypts the WHOLE value to take the last 2/4 chars. The masked suffix is the
  *only* part shown, yet the full plaintext is materialized in-DB to compute it.
  You cannot avoid decrypting to mask with pgcrypto — but you **can avoid
  decrypting fields the row doesn't render**. The list already does the right
  thing for `name` (needed) and masks for id/phone (needed). The real lazy-win
  is **don't compute the id/phone mask at all unless the column is rendered** —
  if a future list variant hides national_id, drop `NID_MASK` from the
  projection. Low effort, situational.
- **(b) Switch PII at-rest from `pgp_sym_*` to raw `pgcrypto encrypt()/decrypt()`
  (AES, no per-call S2K) or to an app-layer envelope** like the documents path
  (`EMAPPENC` AES-GCM, `DOC_ENCRYPTION_KEY`, see memory note
  `project_doc_envelope_encryption`). AES-GCM with a cached key kills the S2K
  derivation cost. **High effort, migration of every encrypted column, Gate-2
  (schema/crypto) — not MVP.** Flag as a post-prod scaling lever.
- **(c) Precompute + store the masked suffix** as a cheap non-PII column
  (e.g. `national_id_last2`, `phone_last4`) at write time. Then the list never
  decrypts for the masked surface at all — it reads plain columns. Detail/reveal
  still decrypt on demand. **Medium effort, additive columns, removes ~2/3 of
  the per-row decrypt on the hottest list.** Best ROI of the three if owners
  lists get large.

---

## 4. Query patterns — indexes, N+1, over-fetch, keyset

### 4a. The keyset sort is NOT index-backed (highest-confidence finding)
`apps/api/src/common/keyset-cursor.ts` orders and filters by a **functional
expression**:
```sql
ORDER BY date_trunc('milliseconds', created_at) DESC, id DESC
WHERE date_trunc('milliseconds', created_at) < $cursor ...
```
`date_trunc('milliseconds', created_at)` is **not** the bare `created_at`
column, so a plain btree index on `created_at` (or `(org_id, created_at, id)`)
**cannot be used** for either the sort or the range predicate. Postgres falls
back to a **filter + sort** of the RLS-scoped rows. The D.58 microsecond fix
(memory: `project_keyset_cursor_microsecond_bug`) traded index-usability for
correctness. Impact scales with table size: small tables (today) are fine;
a 50k-row owners/notifications/audit table will **sort every scan**.

Two compounding problems on the **owners** table specifically:
- The `owners` schema (`packages/db/src/schema/projects.ts:256-272`) has indexes
  on `(org_id, national_id_hash)`, `(org_id, phone_hash)`, `(org_id, name_hash)`,
  and a partial `(org_id) WHERE erased_at IS NULL` — but **NO index on
  `created_at`** at all, and none usable by the keyset sort. The owners list
  (the heaviest PII list) sorts unindexed.
- **Fix:** add an **expression index** matching the keyset exactly:
  `CREATE INDEX ON owners (org_id, date_trunc('milliseconds', created_at) DESC, id DESC) WHERE archived_at IS NULL AND erased_at IS NULL;`
  (and the same on `notifications`, `audit_log`, and the other ~18 keyset
  sites). This makes the keyset an index-only range scan again. **Low effort,
  pure migration, low risk** — and it's the single biggest query-shape win.
  (`memberships` already got a non-expression `(org_id, created_at DESC, id DESC)`
  index in migration 0037, but note it does **not** match the `date_trunc`
  expression either — worth re-checking whether even that one is actually used
  by the keyset.)

### 4b. Notifications fires on EVERY page (already flagged by the audit)
`docs/PERF-AUDIT-REPORT.md` measured `/notifications` as a ~240 ms tax on every
navigation. `notifications.service.ts` `list` + `unreadCount` are **two
separate `withTenant` transactions** (lines 56 and 77) when a page needs both —
that's **2× the 4-RT ceremony**. The FE bell-island fix (shared long-staleTime
query) is the right lever; on the BE side, the unread count is already a partial
index (`idx_notifications_user_unread`), good.

### 4c. Over-fetch
- `notifications.service.ts:84` does `select()` (all columns) for the list —
  pulls every column over the wire even if the bell only renders a few. Minor.
- Owners list correctly projects only needed columns and decrypts in-SQL — good.

### 4d. N+1 round-trips
The owners list **avoids** N+1 by using **correlated scalar subqueries** for
`apartmentCount` / `pendingSignatureCount`
(`owners.service.ts:249-291`) — one round-trip for the whole page. (The
`${owners.id}` bare-id gotcha is documented inline and in memory.) No N+1 on the
hot read paths reviewed. The `with-provider` double-connection is the one
structural multi-round-trip, justified by audit integrity.

### 4e. Hebrew COLLATE he_il_icu
`migrations/0013_hebrew_collation.sql` exists; the owners list currently sorts
by `created_at`/`id` (not name), so the ICU collation cost is **not** on the
owners list hot path today. It bites only on name-sorted lists; if/when a
name-sorted surface appears, an index with the matching collation is required or
every sort re-collates.

---

## 5. cache_kv for the hottest reads

`packages/db/src/providers/cache/postgres.provider.ts` (`PostgresCacheProvider`)
reads/writes `cache_kv` using the **raw `db` pool directly — NOT `withTenant`**.
So a cache read is a **single-round-trip indexed PK lookup with NO transaction
ceremony** — i.e. it already costs ~1 RT, roughly **1/4 of a `withTenant`
read**. That makes it a genuine latency win for the right reads, even though
it's still Postgres (same Neon RTT). It is *not* a Redis-class win (still a
network hop), but it removes 3 of the 4 round-trips.

**Best cache candidates (read-mostly, small, hot):**
- **Effective permission set / role matrix.** `/me`'s
  `resolveEffectivePermissions` (`auth.service.ts:836`) runs a **whole extra
  `withTenant`** (≥3 RT) per `/me` to resolve `role_assignments ⋈
  role_permissions` closure. This is read-mostly and identical across a user's
  requests in a session → ideal cache_kv entry keyed by `(userId, orgId,
  role-version)`. **High ROI** — kills a full nested transaction on the hottest
  authenticated endpoint. Invalidate on role/membership/capability change.
- **Org settings / branding** (`organizations.settings` jsonb) — read on many
  surfaces, changes rarely.
- **`/me` profile** — `#401` already seeds the *client* session cache from the
  server profile; a server-side cache_kv of `loadProfile` output would also help
  SSR/refresh paths. Note `loadProfile` itself uses the raw `db` pool (no
  withTenant) so it's already a single multi-join round-trip — caching it saves
  that one RT + the join.

**Caveat:** cache_kv lives in the same Neon DB, so it does **not** beat the
RTT floor — it beats the *round-trip-count* floor (1 RT vs 4) and the query/
join cost. For PII it must NOT be used (the cache stores plaintext jsonb;
permissions/settings are non-PII — safe). A future Redis (explicitly out of MVP
scope per CLAUDE.md) would beat the RTT too, but cache_kv is the sanctioned MVP
tool and still a 4×-round-trip reduction on the cached reads.

---

## 6. pg-boss / worker coupling on the request path

`apps/api/src/queue/pg-boss-producer.ts`:
- **Pre-connects on `onModuleInit`** (fire-and-forget) so the first enqueue
  doesn't pay ~200–400 ms pg-boss cold-start on the request path (line 40
  comment, the v8 §v7-D Perf-HIGH fix). Good — cold-start is amortized.
- `migrate: false` on the producer (the worker owns the schema) — no DDL race,
  faster connect.
- Producer uses `PROVIDER_DATABASE_URL` (BYPASSRLS), separate from the app pool.

**Is there synchronous coupling on hot reads?** **No.** `boss.send()` is only
called from **write/dispatch** endpoints (imports start, signature-request
delivery, member invite, calendar-email, otp) — never from the hot read paths
(lists/detail/`/me`). A `send()` is one INSERT round-trip into the pgboss
schema on those write endpoints; it adds ~1 RT to those specific writes but is
irrelevant to read latency. **No request-path worker coupling to fix.**

---

## Ranked findings

| # | Area | Current cost | Optimization | Expected gain | Effort | Risk |
|---|------|--------------|--------------|---------------|--------|------|
| 1 | **App↔Neon co-location** (§2) | If cross-region: **every** of 4 serial `withTenant` RT pays full inter-region RTT (~50–165 ms each) | Verify + ensure Railway BE region == Neon region | **Potentially divides total API latency by the RTT ratio** (largest single win) | None (config) | Low |
| 2 | **`withTenant` round-trip ceremony** (§1) | 4 RT/read (3 are pure RLS/PII ceremony); multiplies per nested call | Pipeline BEGIN/SET-ROLE + set_config into 1 RT; pipeline COMMIT; or connect pool as non-BYPASSRLS `app_user` to drop `SET LOCAL ROLE` | 4 RT → 2–3 RT, i.e. ~25–50% of DB wait on every endpoint | Med (driver pipelining) / Med-High (role change = Gate) | Med — role change is security-surface; pipelining must preserve param-bound keys (no PII in logs) |
| 3 | **Keyset sort not index-backed** (§4a) | `date_trunc('ms', created_at)` sort/filter ignores plain `created_at` index; owners has NO created_at index → unindexed sort, scales with row count | Add expression indexes `(org_id, date_trunc('milliseconds', created_at) DESC, id DESC)` (partial) on owners/notifications/audit + ~18 keyset tables | Index-only range scan; removes per-scan sort at scale | Low (migration) | Low |
| 4 | **Cache permission/role matrix in cache_kv** (§5) | `/me` runs an extra full `withTenant` (≥3 RT) to resolve effective permissions every call | cache_kv keyed by (userId, orgId, role-version); invalidate on change | Removes a whole nested transaction from the hottest authed endpoint (~3 RT) | Med | Med — invalidation correctness on role change |
| 5 | **Owners list per-row pgcrypto** (§3) | O(N) `pgp_sym_decrypt` (3 fields/row, S2K per call) of Neon CPU per list page | Precompute masked suffix as non-PII columns (last2/last4) at write time; OR migrate PII to AES-GCM envelope (no S2K) | Removes ~2/3 of per-row decrypt on the hot list; AES kills S2K cost | Med (suffix cols) / High (envelope = Gate-2) | Low / High |
| 6 | **Notifications: 2 txns + select(\*)** (§4b/c) | list + unreadCount = 2× `withTenant`; list pulls all columns; fires every page | Shared FE staleTime query (already planned); BE: project only rendered columns | ~240 ms/nav tax (mostly FE-cached away) | Low | Low |
| 7 | **`withProvider` double-connection** (§1) | ~7 RT/read (autonomous audit tx + work tx on 2 connections) | Leave as-is unless Provider read latency matters — the design is an intentional audit-integrity (SA-7) tradeoff | n/a (do not regress audit guarantee) | — | Do-not-touch without security review |

---

## The realistic floor, stated plainly

- **Same-region prod, single-query read endpoint:**
  **~10–25 ms warm** = (4 serial `withTenant` round-trips × ~1–3 ms RTT) +
  light query exec + Fastify/guard/JSON (~2–5 ms). The measured ~200 ms is
  **not** this floor; per `docs/PERF-AUDIT-REPORT.md` it is dev-mode FE render
  and/or cross-region RTT.
- **The floor is round-trip-count × RTT, not query speed.** The SQL is already
  well-shaped (in-SQL decrypt, correlated-subquery counts, no N+1, sargable RLS
  equality). What inflates latency is **4 serial network hops per read** and
  **the RTT of each hop**.
- **To go below ~10 ms you must stop hitting Postgres for that read** — i.e.
  cache (cache_kv removes 3 of 4 RT but not the RTT; Redis would remove the RTT
  too but is out of MVP scope).
- **Biggest, cheapest wins, in order:** (1) confirm/ensure app↔Neon
  co-location, (2) cut the `withTenant` ceremony from 4 RT toward 2,
  (3) add the expression keyset indexes before any list table grows,
  (4) cache the `/me` permission resolution in cache_kv.

---

## Open questions to confirm (not answerable from the repo)
1. **Railway BE region vs Neon project region** — same AZ/region? (§2, finding #1)
2. Measured **prod** app→Neon RTT (single SELECT 1 round-trip) — pins the floor.
3. Row counts on owners / notifications / audit_log per active org — decides
   when the unindexed keyset sort (§4a) starts to bite.
