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



