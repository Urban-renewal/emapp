# @emapp/api — NestJS Backend

NestJS 11 + Fastify. All endpoints under `/api/v1/` (D.10).

## Critical rules (from root CLAUDE.md)
- Every DB read through `withTenant(orgId, fn)` or `withProvider(providerUserId, reason, fn)` — never raw `getDb()` in controllers.
- Response envelope: `{ data: T }` for all domain endpoints (D.16). `/health` is exempt.
- PII (`national_id`, `phone`, signatures) never logged, never in error messages.
- `Zod`-validated DTO on every endpoint via `class-validator` pipes.

## Starting the server
```
# Requires env vars — run via Infisical:
infisical run -- pnpm --filter @emapp/api dev

# Without accounts (P0.2 not set up):
SKIP_ENV_VALIDATION=true pnpm --filter @emapp/api dev
```

## Architecture
- `src/main.ts` — bootstrap: Fastify, Helmet, CORS, throttler, global prefix
- `src/app.module.ts` — root module
- `src/app.controller.ts` — `/api/v1/health` endpoint
- `src/instrument.ts` — Sentry init (must be imported first in main.ts)
- `src/common/filters/` — global exception filter (D.16 error envelope)

## Security checklist (mandatory per task)
- Helmet CSP headers ✓ | CORS strict allow-list ✓ | Rate limit 100/min ✓
- pino redacts auth headers, cookies, passwords ✓
- Error messages generic (no stack traces to client) ✓
