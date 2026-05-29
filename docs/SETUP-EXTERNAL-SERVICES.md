# EMAPP — External Services Setup Runbook

> Complete provisioning guide for every external service the system depends on,
> across **dev / staging / production**. Set it all up now so production is just
> "flip the env" — no scramble.
>
> **You (the operator) perform every step here** — account creation, credential
> generation, DNS. Agents never create accounts or enter credentials (Gate-4
> SECRETS LAW + safety).

## Iron rules (Gate-4 SECRETS LAW)

1. **Every secret lives in Infisical only.** `.env` files contain placeholders
   only. Never commit a real value, never paste one into code.
2. **Per-environment isolation.** Each service gets _separate_ resources per
   env (separate Neon project/branch, R2 bucket, Resend domain, Sentry env,
   SMS sender). A dev leak must never touch prod data.
3. **Generate, don't reuse.** Each env gets its own freshly-generated app
   secrets (JWT, PII keys, etc.) — never copy a dev secret to prod.
4. **Verify after each.** Every service has a one-line "does it work" check
   below — run it before moving on.

## Order (dependency-respecting)

Infisical → app-generated secrets → Neon → R2 → Resend → SMS → Sentry →
Railway → Cloudflare Pages. (Hosting last — it consumes everything above.)

---

## 0. Infisical (secrets manager — the foundation)

**For:** the single home for all secrets, injected at runtime via `infisical run`.

1. Create account + a project (e.g. `emapp`).
2. Create 3 environments: **dev**, **staging**, **production**.
3. `infisical login` on each machine that runs the stack.
4. In the repo root: `infisical init` → produces `.infisical.json` (workspaceId +
   default env). **Each git worktree needs its own copy:**
   `cp /c/emapp/.infisical.json <worktree>/`.
5. Verify: `infisical run --env=dev -- printenv | grep -c .` returns a count > 0.

> Everything below = "create the resource → put these vars in Infisical (dev +
> staging + prod) → verify".

---

## 1. App-generated secrets (no external account — you generate them)

These aren't services; they're random secrets the app needs. Generate a
**fresh set per environment** and store in Infisical.

| Var                      | Min length | Generate                                                                         |
| ------------------------ | ---------- | -------------------------------------------------------------------------------- |
| `JWT_SECRET`             | 44         | `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `SIGNATURE_TOKEN_SECRET` | 44         | same as above (separate value — D.21/Phase 5)                                    |
| `PII_ENCRYPTION_KEY`     | 32         | `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `PII_HASH_KEY`           | 32         | same (separate value — must differ from encryption key)                          |
| `BETTER_AUTH_SECRET`     | 32         | same (legacy/dead path but schema requires it)                                   |

**Critical:** `PII_ENCRYPTION_KEY` must be **identical across the lifetime of an
environment** — rotating it makes existing encrypted PII unreadable. Generate
once per env, never change without a re-encryption migration.

Verify: `infisical run --env=dev -- node -e "console.log(process.env.JWT_SECRET?.length)"` → ≥44.

---

## 2. Neon (PostgreSQL 16 — the database)

**For:** primary DB, RLS multi-tenancy, pgcrypto PII encryption, pg-boss queue,
cache_kv (no Redis in MVP).

1. Create a Neon project **per environment** (or branch — separate data).
   Region: **EU** (Frankfurt/eu-central — IL latency + GDPR).
2. Enable extension: `CREATE EXTENSION IF NOT EXISTS pgcrypto;`
3. Two roles (Doc 04c P1.3): the app role (RLS-enforced `app_user`) and a
   provider role with `BYPASSRLS` for Tier-3.
4. Grab two connection strings:
   - **pooled** (PgBouncer) → `DATABASE_URL` (app runtime)
   - **direct** (non-pooled) → `DATABASE_MIGRATE_URL` (migrations need direct)
   - provider-role pooled → `DATABASE_URL_PROVIDER`

| Var                     | Value                                     |
| ----------------------- | ----------------------------------------- |
| `DATABASE_URL`          | pooled, app_user role, `?sslmode=require` |
| `DATABASE_MIGRATE_URL`  | direct (non-pooled), for `db:migrate`     |
| `DATABASE_URL_PROVIDER` | pooled, provider role (BYPASSRLS)         |

Verify: `infisical run --env=dev -- pnpm --filter @emapp/db db:migrate` → "applied".
Then `pnpm --filter @emapp/db seed:dev`.

> **Perf note (PERF-1/colocation):** in prod, host the app **in the same region
> as Neon** — the audit measured 138ms/round-trip from a remote machine; colocated
> drops it to single-digit ms.

---

## 3. Cloudflare R2 (S3-compatible object storage)

**For:** document/file storage (presigned upload/download via `IStorageProvider`).

1. Cloudflare → R2 → create a **bucket per env** (`emapp-dev`, `emapp-staging`,
   `emapp-prod`).
2. Create an R2 API token (S3 auth): gives Access Key ID + Secret.
3. **Custom domain on the bucket** (§v7-B): R2 presigned URLs otherwise embed
   the account-id in the host (`<account>.r2.cloudflarestorage.com`) which leaks
   to browser/network logs. Bind a custom domain to avoid it.

| Var                    | Value                                                           |
| ---------------------- | --------------------------------------------------------------- |
| `S3_ENDPOINT`          | `https://<account>.r2.cloudflarestorage.com` (or custom domain) |
| `S3_REGION`            | `auto`                                                          |
| `S3_ACCESS_KEY_ID`     | from the R2 token                                               |
| `S3_SECRET_ACCESS_KEY` | from the R2 token                                               |
| `S3_BUCKET`            | per-env bucket name                                             |

Dev note: `FakeStorageProvider` is in-memory; R2 is only needed once you test
real upload/download. Prod **fails fast** without it (D.28 governed pattern).
Verify: upload a doc through the app → object appears in the R2 bucket.

---

## 4. Resend (transactional email)

**For:** member invites, signature-link delivery, password reset, calendar ICS.

1. Create account.
2. Add a **sending domain per env** — recommended subdomain
   `notifications.emapp.io` (isolates deliverability). Add the DNS records
   Resend gives (SPF TXT, DKIM TXT, optional MX, DMARC TXT) in Cloudflare DNS —
   **Proxy = OFF (DNS only)** on all of them. Wait for "Verified".
3. Create an API key (Sending access only), one per env.

| Var              | Value                                                                    |
| ---------------- | ------------------------------------------------------------------------ |
| `RESEND_API_KEY` | per-env key                                                              |
| `RESEND_FROM`    | e.g. `EMAPP <notifications@notifications.emapp.io>` — **see drift note** |

Dev note: `FakeEmailProvider` captures mail in-memory (no real send); prod
fails fast without a real provider (D.27). DNS propagation can take hours —
set the domain up early. No production domain yet? Use Resend's shared
`onboarding@resend.dev` for early testing.
Verify: trigger an invite → email arrives (or appears in Fake capture in dev).

---

## 5. SMS provider — 019 / Inforu (Tenant OTP)

**For:** resident (דייר) login via SMS OTP — periphery audience, D.20. Behind
`ISMSProvider`; `NoopSMSProvider` is dev/test only.

1. Open an account with an Israeli provider (019 SMS or Inforu).
2. Register a **sender ID** (alphanumeric sender name — requires approval in IL).
3. Get API credentials (user/token).

| Var (proposed — **see drift note**) | Value                     |
| ----------------------------------- | ------------------------- |
| `SMS_PROVIDER`                      | `inforu` / `019` / `noop` |
| `SMS_API_USER` / `SMS_API_TOKEN`    | provider credentials      |
| `SMS_SENDER`                        | approved sender ID        |

Dev note: keep `SMS_PROVIDER=noop` in dev/test (OTP printed to logs, not sent).
Staging/prod need the real account. Verify: request OTP as a resident → SMS
arrives on a real phone.

---

## 6. Sentry (error monitoring)

**For:** runtime error capture (api + web + worker). ISO A.12 logging support.

1. Create a Sentry org + a **project per app** (emapp-api, emapp-web,
   emapp-worker), per env (use Sentry "environments").
2. Grab each DSN.

| Var                 | Value                    |
| ------------------- | ------------------------ |
| `SENTRY_DSN_API`    | api project DSN          |
| `SENTRY_DSN_WEB`    | web project DSN          |
| `SENTRY_DSN_WORKER` | worker DSN (if separate) |

Verify: throw a test error → it appears in Sentry under the right env.

---

## 7. Railway (host the API + Worker)

**For:** NestJS API + pg-boss worker process.

1. Create a project; two services: **api** and **worker** (same repo, different
   start commands).
2. Wire env vars: either Infisical's Railway integration, or set them in
   Railway's env per service (pull from Infisical staging/prod).
3. **Pro plan** if you want preview environments per PR (optional but useful).
4. Set the region to match Neon (colocation — PERF).
5. Add the non-secret app vars too: `NODE_ENV=production`, `PORT_API`,
   `API_BACKEND_URL` (**see drift note**), `LOG_LEVEL`.

Verify: deploy → `GET /api/v1/health` → 200; worker logs "worker ready".

---

## 8. Cloudflare Pages (host the FE)

**For:** Next.js 15 frontend (D.35 topology — same-origin proxy to the API).

1. Connect the repo; framework preset Next.js; build `apps/web`.
2. Env vars: `API_BACKEND_URL` (points at the Railway API), any
   `NEXT_PUBLIC_*`, Sentry web DSN.
3. Custom domain `app.emapp.io` (customer app) + the `/api/v1/*` proxy/route to
   Railway (same-origin so cookies work — D.21/D.35).
4. **Second Pages app for the Provider console (D.45):** a _separate_ Pages
   deployment on `admin.emapp.io`, its own `/api/v1/provider/*` proxy, its own
   cookie scope (`provider_access_token` scoped to the admin subdomain — never
   shared with the customer app). Provider login + MFA gate the whole subdomain.
5. Free plan covers ≤500 builds/mo (per app).

Verify: `app.` → login → authenticated page renders, cookies HttpOnly +
SameSite=Lax. `admin.` → provider login + MFA → console; confirm the provider
cookie is NOT present on `app.` and vice-versa.

---

## Config drift found (fix these — they're used but undeclared)

Reading `packages/config/src/env.ts` + `.env.example` + `packages/db/src/env.ts`,
these are **used in code but missing from the schema and/or `.env.example`** —
add them so a fresh setup is complete (folds into ENV-1 / a config-hygiene slice):

| Var                           | Status                                                        | Action                       |
| ----------------------------- | ------------------------------------------------------------- | ---------------------------- |
| `JWT_SECRET`                  | in schema (required), **missing from `.env.example`**         | add placeholder              |
| `API_BACKEND_URL`             | used by web proxy (audit ENV-1), **not in schema or example** | declare + document           |
| `DATABASE_MIGRATE_URL`        | used by migrator (db package), **not in `.env.example`**      | add placeholder              |
| `RESEND_FROM`                 | needed for real sends, **not in schema**                      | add to schema + example      |
| `SMS_*` (provider/sender/key) | `ISMSProvider` exists, **no env declared**                    | define names + add to schema |
| `SENTRY_DSN_WORKER`           | worker monitoring, **not in schema**                          | add if worker uses Sentry    |

---

## Final checklist — set per environment

| Var                                       | dev         | staging | prod |
| ----------------------------------------- | ----------- | ------- | ---- |
| JWT_SECRET / SIGNATURE_TOKEN_SECRET       | ☐           | ☐       | ☐    |
| PII_ENCRYPTION_KEY / PII_HASH_KEY         | ☐           | ☐       | ☐    |
| BETTER_AUTH_SECRET                        | ☐           | ☐       | ☐    |
| DATABASE_URL / \_MIGRATE_URL / \_PROVIDER | ☐           | ☐       | ☐    |
| S3\_\* (R2)                               | ☐ (Fake ok) | ☐       | ☐    |
| RESEND_API_KEY / RESEND_FROM              | ☐ (Fake ok) | ☐       | ☐    |
| SMS\_\*                                   | ☐ (noop)    | ☐       | ☐    |
| SENTRY*DSN*\*                             | ☐           | ☐       | ☐    |
| API_BACKEND_URL                           | ☐           | ☐       | ☐    |
| NODE*ENV / LOG_LEVEL / PORT*\*            | ☐           | ☐       | ☐    |

When every box for an environment is checked + each "verify" passed, that
environment is fully provisioned.
