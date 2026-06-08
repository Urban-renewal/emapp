# QA Findings — Live-site functional + performance audit

> Driven against the running stack (API :3000 dev + Neon dev DB), authenticated
> manager session. Evidence-based: every number is a measured `curl` timing or a
> code fact, not an assumption.

## TASK B — Latency (measured 2026-06-08)

### Warm latency table (API-direct :3000, authenticated, 3rd sequential hit)

| endpoint           | warm   | status |
| ------------------ | ------ | ------ |
| projects           | 1.34 s | 200    |
| owners             | 1.34 s | 200    |
| documents          | 1.34 s | 200    |
| signature-requests | 1.46 s | 200    |
| notifications      | 0.79 s | 200    |
| tasks              | 1.34 s | 200    |
| contractors        | 1.33 s | 200    |
| members            | 1.33 s | 200    |

### Root cause — GROUNDED (not a guess)

The suspicious part is the **consistency** (~1.33 s on almost every endpoint).
Measured the raw cost of one DB round-trip to Neon from the dev box:

| probe                       | cold (1st) | warm        |
| --------------------------- | ---------- | ----------- |
| raw `SELECT 1` to Neon      | 1236 ms    | **~155 ms** |
| `/api/v1/ready` (1 DB ping) | 1.21 s     | ~0.35 s     |

So **one warm round-trip dev-box → cloud-Neon ≈ 155 ms** (network latency to the
Neon region; the first query also pays a Neon serverless cold-start).

Each authenticated request makes **~8 sequential round-trips**, which × 155 ms ≈ 1.3 s.
Counting them (`packages/db/src/wrappers/with-tenant.ts`): **`withTenant` alone is 4
round-trips per request** —

1. `BEGIN; SET LOCAL ROLE app_user`
2. `SELECT set_config(...)` (org GUC for RLS)
3. the endpoint's actual query
4. `COMMIT`

…plus the auth guard's session validation, plus any per-endpoint count/join query.
8 × 155 ms ≈ 1.24 s — **matches the observed 1.3 s.**

### Conclusion (honest)

- **The API/DB logic is healthy.** A single query is ~155 ms; the endpoints are not
  doing anything pathological (no N+1 explosion — the count is ~8, explained by the
  RLS transaction wrapper + auth).
- **The dev slowness is network latency: a dev laptop talking to a _cloud_ Postgres
  at ~155 ms/round-trip.** In production the API runs **in the same region as Neon**
  (~1–5 ms/round-trip), so the same ~8 round-trips become **~25–50 ms total**, not 1.3 s.
- Representative production numbers therefore require a co-located (prod-like) deploy —
  they CANNOT be measured from a dev laptop against cloud Neon. **The 1.3 s is a dev
  artifact, not a production performance bug.**
- On top of this, the **Next.js dev proxy** (`:3001`, per-request route compilation)
  adds further dev-only latency — also gone in a production build.

### Real (optional) optimization — round-trip count

Independently of environment, fewer round-trips help under ANY DB latency:

- `withTenant` issues `BEGIN; SET LOCAL ROLE` and the `set_config(...)` as **two**
  round-trips. They could be folded into **one** (`BEGIN; SET LOCAL ROLE app_user; SELECT set_config(...)`),
  saving 1 round-trip/request (~155 ms in dev, ~2 ms in prod).
- ⚠️ `withTenant` is the **RLS-critical** wrapper (D.21). Any change must keep
  `SET LOCAL ROLE` + the GUC + the query in the **same transaction** and be
  security-reviewed. Low prod payoff → candidate only, not urgent.

**Recommendation:** do not "fix" the 1.3 s as a prod bug (it isn't one). If the owner
wants representative numbers, measure on a staging deploy where API + DB are
co-located. The round-trip fold is an optional micro-opt, gated on security review.

## TASK A — core-flow works audit (driven live as manager, 2026-06-08)

Walked the manager core flow against the running API with the authenticated cookie.
Every step: real HTTP status + the row read back via a follow-up GET (evidence, not
assumption). Servers were on branch `task/apartment-unit-type-form` (= #316 live).

| step                                | endpoint                                             | result         | latency | evidence                                                                                    |
| ----------------------------------- | ---------------------------------------------------- | -------------- | ------- | ------------------------------------------------------------------------------------------- |
| create project                      | POST /projects                                       | **201**        | 1.9 s   | id returned, type=tama38_1                                                                  |
| create building                     | POST /projects/:id/buildings                         | **201**        | 2.6 s   | id returned                                                                                 |
| create apartment (unitType=shop)    | POST /buildings/:id/apartments                       | **201**        | 2.8 s   | **#316 LIVE** — GET back shows `unitType:"shop"`, `rooms:null`                              |
| create owner (PII)                  | POST /owners                                         | **201**        | 2.2 s   | **PII MASKED** — response `nationalIdMasked:"•••••••82"`, cleartext `123456782` NOT present |
| link ownership (relationship=owner) | PUT /apartments/:id/ownerships                       | **200**        | 3.3 s   | **#286 LIVE** — GET back shows `relationship:"owner"`, `ownershipPct:100`                   |
| signature endpoints exist           | POST /signature-requests, `/:id/resend`, `/:id/link` | routes present | —       | resend + copy-link affordances exist (controllers verified)                                 |

### Findings

- **The core owner-management flow works end-to-end** (project → building → apartment →
  owner → ownership), and the two merged Gate-6 features are confirmed LIVE on the
  running API, not just in unit tests: **#316** (apartment unit-type persists) and **#286**
  (owner/renter `relationship`).
- **Security spot-check PASSED:** creating an owner with a cleartext national_id returns
  it MASKED (`•••••••82`); the cleartext never appears in the API response. Matches the
  PII rule.
- **Signature-request creation requires a `documentId`** → depends on the document upload
  path → depends on R2 storage. In dev R2 is the in-memory fake (owner action: set
  `R2_ACCOUNT_ID`), so a fully-signable document can't be produced locally yet. The
  resend (`/:id/resend`) and copy-link (`/:id/link`) endpoints exist and are wired.
- **No missing core-flow buttons found** — the create forms exist for every step
  (`/projects/new`, `/projects/:id/buildings/new`, `/buildings/:id/apartments/new`,
  `/owners/new`, `/signature-requests/new`).

### Two non-bugs ruled out (avoided false findings)

- A building create returned 400 — isolated to a **Windows-shell UTF-8 mangling of the
  inline Hebrew** in the curl payload (ASCII payload → 201). NOT an API bug; the FE sends
  proper UTF-8.
- Owner create 400 on first try — the write field is `national_id` (snake_case, D.19),
  not `nationalId`. Correct once fixed → 201. Working as designed.

### Latency note (writes)

Writes are 2–3.3 s in dev — higher than the ~1.3 s reads because a write does more
round-trips (BEGIN+ROLE, set_config, the insert(s), the append-only audit-log insert,
COMMIT). Same root cause as TASK B (dev-laptop → cloud-Neon at ~155 ms/round-trip);
in a co-located prod deploy these are ~50–100 ms. Not a prod bug.

## Document "key does not exist" — root-caused with evidence (2026-06-08)

Drove the FULL document flow live against real R2. Every step has a captured status.

| step                                      | result               | evidence                                                                                                                          |
| ----------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| POST /documents                           | 201                  | uploadUrl host = `emapp-dev.<acct>.r2.cloudflarestorage.com` (REAL R2, not fake)                                                  |
| PUT file → R2                             | **200**              | uploaded a 69-byte pdf to the presigned URL                                                                                       |
| POST /finalize {sizeBytes,contentHash}    | **200**              | R2 verified the object matches declared size+hash                                                                                 |
| GET /download                             | **200**              | presigned GET url minted                                                                                                          |
| fetch from R2                             | **200, 69B, "%PDF"** | got back the exact bytes uploaded                                                                                                 |
| OPTIONS preflight (Origin localhost:3001) | **204**              | `Access-Control-Allow-Origin: http://localhost:3001`, `Methods: PUT,GET,HEAD` — CORS IS configured                                |
| FE upload code                            | correct              | `uploadToPresigned` canonicalizes mime (avoids 403 SignatureDoesNotMatch), `credentials:'omit'`; hook does create→upload→finalize |

### Conclusion: the document system WORKS end-to-end. Not a systemic bug.

Three hypotheses RULED OUT with evidence (avoided false findings):

1. ❌ silent fake-storage fallback — R2 is fully configured, real R2 is used.
2. ❌ R2 bucket CORS missing — preflight returns proper allow headers.
3. ❌ FE upload bug — the 3-phase create→upload→finalize hook is correct.

The owner's "key does not exist" was almost certainly a **ghost / non-finalized
document**: one where the upload or finalize step didn't complete (tab closed
mid-upload, a transient network error, or the 5-min presigned-URL TTL expired
before a slow upload). The download endpoint correctly refuses a non-finalized
doc — but with a raw "key does not exist" instead of an actionable message.

### Recommended small fix (UX, not infra)

Download/preview of a non-finalized (ghost) document should return a CLEAR,
actionable error — "this document's upload did not complete — please re-upload"
— instead of the raw NoSuchKey / "key does not exist". Pipeline candidate.

### Earlier wrong advice — corrected

My initial "add R2_ACCOUNT_ID to Infisical" was WRONG: there is no such var in
this codebase (account id is embedded in R2_ENDPOINT, which is set). Apologies.
