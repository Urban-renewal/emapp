# @emapp/shared-types

The single FE/BE contract source of truth (Doc 11 §2 — "the heart" of the
sync mechanism). Imported by both `@emapp/api` and `@emapp/web`.

## Reconciled 2026-05-18

The earlier rule "no runtime code, only type/interface/enum" is SUPERSEDED
by Doc 11: the contract is defined as **Zod schemas** (runtime) so a single
definition yields both the BE DTO validation and the FE-checkable types.
Zod is FE-safe and already used in both apps. (Same supersession pattern as
D.21 over "Better Auth"; recorded here to keep docs↔code in sync.)

## Contents

- `envelope.ts` — D.16 response envelope: `{ data }`, `{ error }`,
  list `{ data, page }`, plus Zod validators (`apiData`, `apiErrorSchema`)
  so tests/FE can `.parse()` responses.
- `auth.schemas.ts` — canonical Zod request schemas (signup, login,
  org-switch, provider login, OTP request/verify) + inferred DTO types.
- `index.ts` — re-exports.

## Rules

- The schemas here are the source of truth. BE DTOs RE-EXPORT from here
  (thin files); never redefine a schema in the app.
- No imports from other `@emapp/*` packages (avoid circular deps).
  - DOCUMENTED EXCEPTION (1, narrow): `project-perception.ts` imports
    `AutonomyActionKind` from `@emapp/jobs` for the typed
    `attentionReasonToActionKind` map. `@emapp/jobs` is a LEAF (zod-only, no
    `@emapp/*` deps), so `jobs → shared-types` does not exist and there is NO
    import cycle — the rule's intent (cycle-avoidance) is preserved. This keeps
    the DECIDE→ACT map SINGLE-SOURCE against the real kind taxonomy instead of a
    string mirror that would drift. Do not add further `@emapp/*` deps without
    confirming the target is also a leaf.
- A change here is a breaking change for BOTH apps — coordinate; the
  `gen-api-docs` §1.4 gate + the CI conformance job will catch drift.
- Keep schemas pure (no Nest/env/Node-only imports) so FE can import them.
