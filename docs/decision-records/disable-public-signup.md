# Disable public self-service signup (owner-approved; refines D.21)

**Decision.** Public self-service signup (`POST /auth/signup` + the `/signup` FE
page + the signup entry link on `/login`) is **DISABLED by default**. This is the
correct B2B posture: organizations are provisioned by a **Provider Admin** via
`POST /provider/tenants`, the first **Manager** sets their own password through
the invite flow (`/auth/accept-invite`), and from there the org self-manages
members via `/members`. There is no self-service "create your own org" path in
the default product.

**Reversible, non-destructive — NO code deleted.** Everything the original
self-service flow needed is RETAINED, just gated behind a feature flag that is
OFF by default:

- `POST /auth/signup` route, `@Public()`, the per-route throttle, the
  `SignupSchema` DTO, and `AuthService.signup` — all intact.
- The D.21 `withBootstrap` atomic-signup helper — **UNTOUCHED**.
- The `/signup` FE page (`apps/web/src/app/[locale]/(auth)/signup/page.tsx`) and
  its form code — intact.

Flipping the flag to `'1'` fully restores today's original behavior.

## Flags

| Scope            | Flag                         | Default     | Effect when ≠ `'1'`                                                                                                                                                         |
| ---------------- | ---------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server           | `PUBLIC_SIGNUP_ENABLED`      | `'0'` (OFF) | `POST /auth/signup` throws `NotFoundException` **before any work** (no argon2 hash, no DB, no privileged BYPASSRLS connection) — the route behaves as if it does not exist. |
| Web (build-time) | `NEXT_PUBLIC_SIGNUP_ENABLED` | `'0'` (OFF) | The signup entry link on `/login` is hidden, and the `/signup` page redirects to `/login`.                                                                                  |

- Server flag defined in `packages/config/src/env.ts` (`serverEnv`,
  `z.string().default('0')`) — follows the exact existing optional-flag pattern
  (`DEV_AUTH_BYPASS`). Read in `apps/api/src/modules/auth/auth.controller.ts`.
- Web flag is inlined at build time via `process.env['NEXT_PUBLIC_SIGNUP_ENABLED']`
  — same pattern as `NEXT_PUBLIC_MSW`. Read in `login/page.tsx` and `signup/page.tsx`.
- Both documented in `/.env.example`; both added to `turbo.json` `globalEnv`.

## Relationship to D.21 (owner-approved refinement)

D.21 ("OWNED auth stack") established atomic signup via `withBootstrap`. This
decision **REFINES** D.21: the signup path is now **flag-gated and inactive by
default**, NOT removed. `withBootstrap` and the signup service remain part of the
codebase and become reachable again the moment `PUBLIC_SIGNUP_ENABLED='1'`. The
owner explicitly approved retaining the code for possible future reuse.

## Verification focus

- Flag OFF (default): `POST /auth/signup` → **404** with no side effects
  (no hashing, no DB write); `/signup` page → redirect to `/login`; no signup
  link on `/login`.
- Flag ON (`'1'`): original signup behavior restored end-to-end.
- The provider-led onboarding path (`POST /provider/tenants` → `/auth/accept-invite`)
  is **unaffected** by either flag.
- Any existing signup test must now set `PUBLIC_SIGNUP_ENABLED='1'` (e.g. in env
  setup / `process.env`) to exercise the original behavior; the default-off state
  is itself a new test surface (expect 404).
