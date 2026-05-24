# ONBOARDING — pick up Phase 4 FE as if you'd been on the team

> You are a new Claude-Code agent joining mid-stride. The backend is
> complete through Phase 6 (Excel import wizard) + Phase 7 S1 (L2
> TemplateResolver) + Cloudflare R2 + 8 independent audit passes.
> Your assignment is **Phase 4 — Frontend**. Read this file from
> top to bottom **once**; everything else is referenced inline.
>
> This is NOT another set of rules. The rules are in `CLAUDE.md` and
> `docs/DECISIONS.html` and they are LAW. This document is the
> "tribal knowledge" a teammate carries in their head — the things
> nobody bothered to write down because everyone on the team already
> knew. You won't.

---

## 0. Read these in this order, NO exceptions

1. **`CLAUDE.md`** (5 min) — root project instructions. The hard rules
   are non-negotiable. Memorize: `withTenant`-only DB reads, `{data}`
   envelope, `/api/v1/` prefix, no `any`, PII never logged. Also: the
   autopilot protocol (you self-drive between tasks within a phase;
   stop ONLY at phase end / gate / blocked / security-sensitive).
2. **`PROGRESS.md`** heartbeat (3 min) — current state. The first
   section ("Heartbeat — latest") is the only thing always-fresh.
   Everything below is history.
3. **This file's §3 below** — the 8-audit-pass operating model. If
   you don't understand WHY we do independent fresh-eyes audits,
   you'll skip them and ship enterprise-grade-looking code that
   doesn't pass enterprise review.
4. **`OPEN-ITEMS-v8.md`** (5 min) — 23 deferred items with concrete
   plans. **NONE are FE-blockers.** You need to know they exist so
   you don't accidentally re-discover and re-fix them. Some are
   scale-prep (close in a Phase 7+ slice); some are operational.
5. **`docs/03-mvp-roadmap.html` §11** — Phase 4 spec. The product
   requirements (which screens, what behavior, what permissions).
6. **`docs/10-frontend-security.html`** — FE security DoD. CSP,
   XSS, CSRF posture, what NEVER appears in URLs.
7. **`docs/11-sync-mechanism.html`** — the FE↔BE contract pattern.
   The contract IS `@emapp/shared-types`; Zod schemas are the
   single source of truth on both sides.
8. **`docs/09-api-reference.generated.md`** — every API endpoint with
   request/response shapes. Auto-generated from the Zod schemas;
   re-run via `pnpm --filter @emapp/api gen:api-docs` if you change
   the BE.

Don't read the other `docs/*.html` upfront — pull them in only when
you hit a specific question. They're reference, not flow.

---

## 1. What's actually built (so you don't re-implement it)

**Backend — DONE on `main`:**

- All 8 phases of MVP roadmap through Phase 6
- 6 user roles + 3 tiers (Manager / Agent / Viewer / Contractor /
  Tenant / Provider Admin)
- Auth: OWNED stack per D.21 (argon2id, domain-DB sessions, MFA
  for Provider Admin, tenant OTP via Israeli SMS provider seam)
- DB: Postgres 16 + RLS + pgcrypto. 33 migrations on Neon.
- Excel import wizard (Phase 6): full pipeline — presigned upload →
  worker parses → ExcelJS → mapping (3 layers) → validation →
  encrypted persist → SSE progress stream
- D.34 manual mapping wizard for ambiguous header rows
- Cloudflare R2 storage (PR #34)
- All PII (national_id, phone, signatures, **name** per v8-S3) is
  pgcrypto-encrypted at rest with per-tenant key context
- ISO 27001-aligned audit_log on every state transition
- pg-boss for async (no Redis in MVP — D.04)

**Frontend — Phase 0 scaffold only.** `apps/web/` exists but is
minimal. Your job starts here.

**What I deliberately did NOT do:**

- Items in `OPEN-ITEMS-v8.md` §v8-H* and §v8-M* — they are
  scale-prep / next-audit-pass work. Don't pre-emptively address
  them; they'll surface in v9 audit when the time comes.

---

## 2. The 6 most important architectural decisions (you'll touch these)

| Decision                                                                                                                                          | Why it matters for FE                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **D.16** `{ data: T }` envelope on every endpoint; lists add `page: { limit, cursor, has_more }`; errors `{ error: { code, message, details? } }` | Your fetch wrapper unwraps `data`; your error handler switches on `error.code` (never `.message`)                                    |
| **D.17** 6 MVP roles, 3 tiers                                                                                                                     | Different UIs per tier. Manager dashboard ≠ Tenant OTP-only flow ≠ Provider Admin cross-tenant view                                  |
| **D.19** `national_id` (NOT `tz`); Hebrew UI label "ת.ז."                                                                                         | API field is `national_id`; UI label is the Hebrew form. Mismatch = code review reject                                               |
| **D.20** Tenant tier = SMS OTP via Israeli provider                                                                                               | Tenant UI is OTP-only (no password). `NoopSMSProvider` is dev-only                                                                   |
| **D.21** Better Auth REMOVED from the auth path                                                                                                   | Don't accidentally pull `better-auth/*` from package suggestions; the `ba_*` tables in DB are DEAD                                   |
| **D.28** R2 storage live, with retention via §v8-S1 worker purge                                                                                  | FE uploads via presigned PUT (5-min TTL); downloads via presigned GET (2-min TTL); object key is server-generated, NEVER on the wire |

The full list is in `docs/DECISIONS.html` — 34 decisions, all
binding. Read D.01–D.34 the first time you touch a related area.

---

## 3. The audit-pass operating model (READ THIS)

This is the most important section. It's how the codebase reaches
enterprise grade.

**The pattern:** after every meaningful slice, we run an
**INDEPENDENT** fresh-eyes audit using 3 parallel agents (SOLID +
security/ISO + perf/runtime). Each agent gets:

- The CURRENT code
- NO prior audit history
- A specific lens (one agent's scope ≠ another's)

Then we **cross-confirm**: a finding only escalates to P0 if ≥2
agents independently surface it. Single-agent findings are HIGH
or MEDIUM.

**Why this works:** prior agents become scar-tissue. Their later
audits miss what their earlier code introduced. Fresh-eyes
catches it every time. 8 passes done; every pass found bugs
prior passes missed.

**The pattern for YOU:**

When you finish your Phase 4 FE slice, before opening the PR:

1. Spawn 3 independent general-purpose agents (one per lens).
2. Give them ONLY the FE code paths + docs/10 (FE security DoD).
3. Their findings appear in `PROGRESS.md` as v9 audit + (likely) a
   new `OPEN-ITEMS-v9.md`.

If you skip this you'll ship FE code that re-discovers issues a
fresh-eyes pass would have caught in 5 minutes. Don't.

**Critical addendum (user mandate, locked in v8):** **NO "deferred
with no plan."** Every deferred item gets severity + agent ref +
concrete plan + acceptance criteria. See `OPEN-ITEMS-v8.md` for the
shape. Hand-wave deferrals get rejected on review.

---

## 4. Hidden context the docs don't tell you

Things only a teammate carries. They cost an outsider hours.

### 4.1 The dev environment

- **Always run via Infisical, never `.env`.** `infisical run --env=dev
-- pnpm <cmd>`. The user enforces this; an inline-secret commit will
  be reverted.
- **Dev R2 credentials are in Infisical-dev already**, bucket
  `emapp-dev`. The user pasted them in chat earlier in v7 — they
  should be considered compromised and rotated; that's an open ops
  item, not your concern.
- **Neon Developer plan** with ~100 connection cap. `DB_POOL_MAX`
  defaults are conservative. Don't bump without checking
  `OPEN-ITEMS-v8.md §v8-H1`.
- **API runs on :3000, FE will run on :3001.** CORS already
  allow-listed (`apps/api/src/main.ts`).

### 4.2 Testing

- **`pnpm test` runs `vitest run` across the workspace via Turbo.**
  Always via Infisical.
- **199 API contract specs SKIP when no API is running.** They're
  Node-fetch tests. To run them: in one terminal `infisical run --
pnpm --filter @emapp/api dev`, in another `pnpm test`.
- **Worker tests touch real Neon DB.** Local + CI both go to the
  same Neon database. No mocking — vitest's `global-setup.ts` runs
  migrations once before all workers.
- **Some tests are >30s.** Bump the vitest timeout per-test with
  `it('...', { timeout: 120_000 }, async () => {...})`. Don't change
  the global default.
- **Pre-commit runs lint-staged → prettier + ESLint.** You don't
  need to format manually before committing.

### 4.3 Migrations + the encryption-key GUC trick

The migrator (`packages/db/scripts/migrate.ts`) sets
`app.encryption_key` + `app.pii_hash_key` GUCs on a pg-pool client
**before** drizzle's migrator runs. Drizzle uses LIFO checkout, so
the migrator inherits them. This lets migrations like
`0033_owners_name_encryption.sql` do `pgp_sym_encrypt(name,
current_setting('app.encryption_key'))` inline.

**If you ever write a migration that needs the encryption key,
this pattern is the contract.** It is fragile (depends on drizzle's
LIFO checkout); doc'd in the migrate.ts file.

### 4.4 The payload-trust pattern (worker)

The worker's `import-job.handler.ts` mutates `payload` in-place via
`Object.assign(payload, verified)` after `verifyJobPayload()`. From
that point forward, every `payload.orgId` / `payload.createdBy`
read is the DB-verified value, not the queue-claimed one. **Don't
remove the Object.assign;** all ~40 downstream call sites depend
on it.

This is `§v7-A` defense-in-depth. Same pattern works for any
future worker handler.

### 4.5 The wire contract is in `@emapp/shared-types`

For the FE: import every request/response schema from
`@emapp/shared-types`. **Never redefine a Zod schema in the FE.**

The SSE stream is `ImportSseEventSchema` — a discriminated union
on `event ∈ progress | end | gone`. The FE should defensively
`ImportSseEventSchema.parse(JSON.parse(line))` on every frame.
Adding a 4th variant is a contract change that breaks both sides
at compile time (intentional).

### 4.6 The `cachedProvider` singleton

`storageProviderFactory()` is memoized at module scope. **Don't
construct an `S3Client` directly anywhere.** If you need to reset
in a test, call `resetStorageProvider()` (exported from the same
module). SIGHUP reloads via this path on credential rotation
(§v7-C closure).

### 4.7 The buffered-not-streaming ExcelJS choice

The worker uses `xlsx.load(buffer)` not streaming. This is
INTENTIONAL — ExcelJS has a documented bug with R2-body streams
("Cannot read properties of undefined ('sheets')"). The 50MB cap

- concurrency=2 keeps RAM bounded. Don't "fix" this; see
  `OPEN-ITEMS-v8.md §v8-M2`.

### 4.8 Where the deferred items live

`OPEN-ITEMS-v8.md` has 23 items, every one with:

- Severity (P0 / HIGH / MEDIUM / LOW)
- Audit agent reference
- Concrete plan
- Acceptance criteria

The 3 P0s are CLOSED (banner at top of the file). The HIGH+MEDIUM
items are tracked for next slices — `§v8-H1` through `§v8-M5`. You
don't fix them as part of Phase 4. You DO know they exist so you
don't accidentally re-invent solutions.

### 4.9 Audit-pass numbering

We're at **v8 done**. Your next slice ends with **v9 audit**. The
PROGRESS.md "Audit-pass ledger" tracks the chain. v9 = your
3-independent-agent audit of YOUR FE code.

### 4.10 Commit style

End every commit message with:

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

End every PR body with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Semantic commits (`feat:` / `fix:` / `chore:` / `test:` / `docs:`).
PR title: `Phase 4 — <subject>` or `<scope>: <thing>` for sub-PRs.

---

## 5. Phase 4 — your task

### 5.1 The brief (from `docs/03-mvp-roadmap.html §11`)

Build the customer-facing web app:

- Hebrew (RTL) UI
- 6 roles, 3 tiers — different shells per tier
- Manager dashboard: projects → buildings → apartments → owners
- The import wizard (Phase 6 BE is ready — this is the highest-value
  first feature)
- Signature flows (Phase 5 BE is ready)
- Tenant OTP-only flow (Phase 5 BE)
- Provider Admin cross-tenant view (Phase 5 BE)

### 5.2 Stack (locked — don't suggest alternatives)

- **Next.js 15** App Router (`apps/web/` already scaffolded)
- **shadcn/ui** for components (Radix primitives + Tailwind)
- **TanStack Query** for server state
- **`@emapp/shared-types`** for every wire shape
- **Hosting**: Cloudflare Pages

### 5.3 Where to start (the EXACT entry point)

1. `cd apps/web && cat package.json` — confirm scaffold state.
   Phase 0 set this up; check what's installed.
2. Read `apps/web/CLAUDE.md` if it exists (per-package overrides).
3. Read `docs/05-frontend-sync.html` + `docs/06-fe-be-integration-contract.html`
   for the patterns the BE expects.
4. **Highest-value first feature: the imports wizard.** It's the
   most contract-stable BE surface (typed SSE in shared-types, full
   audit, R2 verified end-to-end).
5. The flow: `POST /imports` → upload Excel to `uploadUrl` (XHR
   directly, NOT through API) → `POST /imports/:id/start` → open
   `EventSource('/imports/:id/stream')` → render `ImportSseEvent`
   frames live → terminal frame closes the stream and shows results.

### 5.4 What NOT to touch in this slice

- The 23 `OPEN-ITEMS-v8` items. They're tracked for future slices.
- The worker, the migrations, the storage factory. BE is feature-
  complete for Phase 4's needs.
- The audit-log writes on the BE. Don't add audit from FE — it goes
  through the API.

### 5.5 Definition of Done for Phase 4

Per `CLAUDE.md`:

- TypeScript passes, lint passes, tests green, no console.log
- Diff reviewed
- **`CLAUDE.md` updated if a new pattern emerged** (e.g. if you
  invent a Hebrew-RTL-form pattern, document it)
- **`PROGRESS.md` heartbeat updated**
- **v9 audit pass** (3 independent agents, FE lens)
- Open PR `Phase 4 — Frontend` against `main`

Stop and wait for user after opening the PR. Don't merge yourself.

---

## 6. Quick command reference

```bash
# Setup (one-time per machine)
pnpm install

# Run API + worker for local dev
infisical run --env=dev -- pnpm --filter @emapp/api dev
infisical run --env=dev -- pnpm --filter @emapp/worker dev

# Run FE (you'll wire this in your slice)
pnpm --filter @emapp/web dev

# Tests
infisical run --env=dev -- pnpm test                    # full
infisical run --env=dev -- pnpm --filter @emapp/api test  # one package
infisical run --env=dev -- pnpm --filter @emapp/web exec vitest run <pattern>

# Quality gates
pnpm lint && pnpm typecheck

# DB
infisical run --env=dev -- pnpm --filter @emapp/db db:generate  # after schema edit
infisical run --env=dev -- pnpm --filter @emapp/db db:migrate   # apply

# API docs (regen after any endpoint or schema change)
pnpm --filter @emapp/api gen:api-docs

# Git workflow
git checkout -b phase-4-fe
# ... work ...
git add . && git commit -m "feat(web): ..."
git push -u origin phase-4-fe
gh pr create --title "Phase 4 — Frontend" --body "..."
```

---

## 7. When you're stuck or unsure

1. **DECISIONS.html** — search for the topic. If a decision exists,
   it's binding.
2. **PROGRESS.md** — search the history. The team has likely seen
   this before.
3. **Run a Plan agent** (claude-code subagent type `Plan`) for
   architectural choices. Don't guess.
4. **Spawn a fresh-eyes Explore agent** to inventory code you don't
   recognize. Cheaper than reading.
5. **If a decision needs to be made that isn't in DECISIONS.html
   and isn't obvious from CLAUDE.md** → STOP, write Blocked in
   PROGRESS.md, ask the user. Don't pick a direction and pray.

---

## 8. The one thing you must NOT do

**Don't ship work that passes your own review but would fail a
fresh-eyes review.** That's the bar. The audit-pass pattern exists
because the team has been burned by it 8 times. If you skip the
v9 audit at the end of your slice, your PR will be sent back.

Welcome aboard. Your move.
