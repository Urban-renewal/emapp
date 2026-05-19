\# EMAPP — Critical Gates (Claude stops here even mid-phase)

Points where a mistake is expensive/irreversible. Claude MUST stop,

present what it's about to do, and wait for "כן".

\## Gate 1 — Before the first migration touches the schema

Task: P1.1 (first Drizzle migration)

Show: the full migration SQL + the rollback plan.

\## Gate 2 — Before enabling RLS FORCE on tables

Task: P1.11 (RLS policies)

Show: every RLS policy + the T1.5 isolation test result.

\## Gate 3 — Before PII encryption goes live

Task: P1.5 (owners + pgcrypto)

Show: key sourcing (env, never hardcoded) + round-trip test.

\## Gate 4 — Before Tenant SMS auth goes live

Task: Phase 2 (Tenant SMS OTP — D.20)

Show: rate-limit config + OTP expiry + Israeli SMS provider config

(019/Inforu, no secrets in code. SECRETS LAW (permanent, every task): All secrets/keys/connection-strings live ONLY in Infisical (environments: dev/staging/production). Claude Code MUST: (1) NEVER write a secret to .env, code, or git — .env files contain only placeholders; (2) read secrets at runtime via `infisical run -- `; (3) in CI, use Infisical's GitHub integration; (4) when a Phase needs a service not yet set up (Neon@P1, Railway@P0-2, SMS@P2, R2@P4, Resend@P7, Sentry+domain@P9), STOP and tell the user: "open account X for environment Y, add key Z to Infisical, then say המשך". Never invent or hardcode a credential. ).

\## Gate 5 — Before first production deploy

Task: Phase 9 (Launch)

Show: the full pre-launch checklist (docs/07 §15).

\## Gate 6 — Any time a new DECISIONS.md entry would be needed

An architectural decision is being made. The user decides, not Claude.

Show: the decision, options, Claude's recommendation.

\## ===== GATE STATUS LOG (formal record for ISO 27001 audit trail) =====

Maintained per product-owner instruction (2026-05-18). "Cleared" = the

control was implemented and the evidence exists in code/tests.

\- \*\*Gate 1 (first migration):\*\* CLEARED — migrations 0000+ applied;

&#x20; rollback via Drizzle journal. Evidence: packages/db/migrations + T1.9.

\- \*\*Gate 2 (RLS FORCE):\*\* CLEARED — migrations 0004/0008/0009 (policies,

&#x20; app_user grants, FORCE); evidence: T1.5 RLS-isolation spec.

\- \*\*Gate 3 (PII encryption):\*\* CLEARED — pgcrypto helpers

&#x20; (encryptField/decryptField, key from env via Infisical, never hardcoded);

&#x20; verifyEncryptionStartup() boot check (P1.10); round-trip in encryption spec.

\- \*\*Gate 4 (Tenant SMS auth):\*\* CONFIG APPROVED 2026-05-18 — product owner

&#x20; approved building the OTP infrastructure now behind ISMSProvider with

&#x20; NoopSMSProvider; the real Israeli provider (019/Inforu) is a later

&#x20; Infisical config swap and remains a STOP before it goes live in prod.

&#x20; Config: 6-digit CSPRNG, HMAC-hashed, 5-min TTL, single-use, 3/15min/phone

&#x20; + per-IP throttle, max 5 attempts, anti-enumeration. No secrets in code.

\- \*\*Gate 5 (production deploy):\*\* PENDING — Phase 9 (docs/07 §15 checklist).

&#x20; PRE-GATE-5 OBLIGATIONS (recorded so the chain is not lost): (1) \*\*D.27\*\*

&#x20; — CODE REMEDIATION LANDED 2026-05-19 (branch d27-invite-email): invite

&#x20; token delivered via IEmailProvider, NOT returned in prod responses;

&#x20; security-review HIGH/MEDIUM fixed at root; prod now FAILS FAST at boot

&#x20; if no real email provider (no silent hole). RESIDUAL (still hard

&#x20; pre-Gate-5): provision `resend` + `RESEND_API_KEY` in Infisical and

&#x20; wire ResendEmailProvider at the single factory point — Gate-4 SECRETS

&#x20; LAW (account + key = user action); until then prod refuses to boot

&#x20; (safe). (2) Gate-4 real SMS provider swap. (3) D.22 items pre-prod.

\- \*\*Gate 6 (architecture decisions):\*\* exercised — D.21 (auth ownership),

&#x20; D.22 (security-design backlog), \*\*D.24\*\* (high-scale data-path stance),

&#x20; \*\*D.25\*\* (ownership atomic set-replace, mandated by the locked sum

&#x20; trigger), \*\*D.26\*\* (centralized declarative D.17 authorization, ISO

&#x20; A.9.4), \*\*D.27\*\* (member-invite consent: token-in-response governed

&#x20; interim, hard remediation = email before Gate 5) — all recorded in

&#x20; docs/DECISIONS.html with the user's approval. (NOTE: only

&#x20; docs/DECISIONS.html exists; CLAUDE.md's "docs/DECISIONS.md" path is

&#x20; doc-drift — the .html is authoritative.)

\- \*\*Note:\*\* Gates 1–3 were functionally satisfied during Phase 1 but not

&#x20; formally logged at the time; this entry records them retroactively for

&#x20; the audit trail (the controls themselves are verifiable in code/tests).
