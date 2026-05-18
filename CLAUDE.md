\# EMAPP — Claude Code Instructions

\## What this is

B2B SaaS for Israeli urban renewal (תמ"א 38, פינוי-בינוי). Manages

apartment-owner signature collection. 2-developer team.

\## Stack (final — never suggest alternatives)

\- Backend: NestJS 11 + Fastify

\- ORM: Drizzle (NOT Prisma)

\- Validation: Zod everywhere

\- DB: PostgreSQL 16 + RLS + pgcrypto (Neon)

\- Auth: OWNED stack (D.21 — supersedes "Better Auth"). argon2id hashing,

&#x20; domain-DB sessions (auth_sessions, SHA-256-hashed refresh, rotation +

&#x20; reuse-detection), atomic signup via withBootstrap. MFA mandatory for

&#x20; Provider Admin. Better Auth is NOT in the auth path. See docs/DECISIONS D.21.

\- Cache: PostgresCacheProvider (cache_kv) in MVP — no Redis

\- Storage: Cloudflare R2 (S3-compatible)

\- Frontend: Next.js 15 App Router + shadcn/ui + TanStack Query

\- Hosting: Railway (BE+Worker) + Cloudflare Pages (FE)

\- Email: Resend (via IEmailProvider)

\- SMS: Israeli provider 019/Inforu (via ISMSProvider) — MVP, Tenant OTP

\- Monitoring: Sentry

\- Monorepo: Turborepo + pnpm

\## The 6 MVP roles (3 tiers) — locked, decisions D.17 + D.20

\- Tier 1 Org users: Manager (full) / Agent (assigned projects) / Viewer (read-only)

\- Tier 2 External: Contractor (share-based, JSONB perms) /

&#x20; Tenant (resident, SMS OTP, own record only)

\- Tier 3 Provider: Provider Admin (cross-tenant, MFA, audited)

\## Hard rules (non-negotiable)

\- Every DB read goes through withTenant(orgId, fn) or

&#x20; withProvider(providerUserId, reason, fn). Direct db.query is FORBIDDEN.

\- No `any`. No `unknown` without z.parse().

\- Every endpoint receives a Zod-validated DTO. No raw body.x access.

\- API paths are prefixed /api/v1/ — always. (Decision D.10)

\- API responses wrapped in { data }. Lists add

&#x20; { page: { limit, cursor, has_more } }.

&#x20; Errors: { error: { code, message, details? } }. (Decision D.16)

\- Soft delete = archivedAt (NOT deletedAt). UI verb = "ארכוב".

\- Entity is "apartment" (NEVER "unit"). Hebrew UI: "דירה".

\- National ID field = national_id (NOT tz). PII. (Decision D.19)

\- Project status enum: planning | gathering_signatures | approved |

&#x20; in_construction | completed | cancelled. (Decision D.18)

\- PII (national_id, phone, signatures) encrypted via pgcrypto.

&#x20; Never logged, never in error messages.

\- Hebrew names sort with COLLATE he_il_icu.

\- Dates: store UTC, display Asia/Jerusalem.

\- Tenant auth = SMS OTP via Israeli provider behind ISMSProvider.

&#x20; NoopSMSProvider is dev/test only. (Decision D.20)

\## When unsure

Read the relevant doc in docs/ before guessing.

Phase tasks: docs/03-mvp-roadmap.html. DB: docs/04c-phase-1-database.html.

Security: docs/07-security-playbook.html. Auth/API flows: docs/08-auth-api-flows.html. API reference (generate from schema, see Doc 09 §0.4): docs/09-api-reference.html. FE security DoD: docs/10-frontend-security.html. Sync mechanism (shared-types + CI enforcement): docs/11-sync-mechanism.html. Decisions: docs/DECISIONS.html.

\## Definition of Done for any task

TypeScript passes, lint passes, tests green, no console.log,

diff reviewed, CLAUDE.md updated if a new pattern emerged.

\## ===== AUTOPILOT PROTOCOL =====

\### On every session start

1\. Read PROGRESS.md → identify Current Position + Next task.

2\. Read GATES.md → know if the next task is a critical gate.

3\. State to the user: "אני ב-Phase X, משימה הבאה PX.Y. ממשיך."

&#x20; Then proceed WITHOUT waiting (unless it's a gate — see below).

\### The task loop (repeat automatically per task)

For the Next task (e.g., P0.4):

1\. Read docs/DECISIONS.html (D.01-D.20 are law — national_id not tz, {data} envelope, status enum, 6 roles, /api/v1/). Then read the task from its source doc:

&#x20; - Phase 0 → docs/04b-phase-0-foundation.html, find PX.Y

&#x20; - Phase 1 → docs/04c-phase-1-database.html, find PX.Y

&#x20; - Phase 2+ → docs/03-mvp-roadmap.html, the matching phase section

2\. Extract: goal, files, dependencies, required tests (TX.Y),

&#x20; Definition of Done.

3\. Verify dependencies are done (check PROGRESS.md). If a dependency

&#x20; is missing → STOP, write Blocked in PROGRESS.md, tell the user.

4\. Implement the task.

5\. Run the task's tests: pnpm test (+ the specific TX.Y).

&#x20; - Fail → fix → re-run. Loop until green. Max 5 attempts, then

&#x20; STOP, mark Blocked, explain.

6\. Run: pnpm lint \&\& pnpm typecheck. Must pass.

7\. Commit (semantic message): git add . \&\& git commit

8\. Push: git push

9\. Update PROGRESS.md: Next task, Task Log line, checkbox.

10\. Move to the next task automatically. Do NOT ask permission

&#x20; between tasks within a phase.

\### When to STOP and wait for the user (the ONLY stop conditions)

\- End of a Phase: all tasks done →

&#x20; a) ensure all phase tests green + Definition of Done met

&#x20; b) open a PR (see PR protocol below)

&#x20; c) update PROGRESS.md (phase checkbox, status: awaiting_approval)

&#x20; d) tell the user: "Phase X הושלם. PR פתוח: <url>. ממתין לאישור."

&#x20; e) STOP. Do not start the next phase until the user says continue.

\- A critical gate (GATES.md): stop even mid-phase, per GATES.md.

\- Blocked: dependency missing, test fails 5x, doc unclear, or a

&#x20; decision needed that isn't in DECISIONS.md → STOP, write Blocked

&#x20; + question in PROGRESS.md, ask the user.

\- Security-sensitive task (PII/auth/RLS): after implementing, BEFORE

&#x20; commit, run "@security-reviewer review the diff". Fix CRITICAL

&#x20; before commit. (Internal — does not stop for the user.)

\### PR protocol (end of each phase)

1\. Branch at phase start: git checkout -b phase-X

2\. At phase end: git push -u origin phase-X

3\. gh pr create --title "Phase X — <name>" --body "<summary>"

&#x20; Body lists: tasks completed, tests passing, Definition of Done

&#x20; checklist, what the reviewer should focus on.

4\. Tell the user the PR URL. STOP.

5\. User merges = approval. User comments = fix and update the PR.

6\. After merge: git checkout main \&\& git pull, next phase = new branch.

\### Never

\- Never skip a test to "make progress".

\- Never start the next phase before PR merge.

\- Never proceed past a Blocked state silently.

\- Never modify GATES.md or this protocol without the user.
