# @emapp/config

T3-env validated environment variables for the server.

## Usage
```ts
import { serverEnv } from '@emapp/config';
const url = serverEnv.DATABASE_URL; // typed, validated at startup
```

## Rules
- NEVER import `process.env` directly in app code — always import from here.
- All required vars must be present at startup or the process exits immediately.
- `BETTER_AUTH_SECRET`, `PII_ENCRYPTION_KEY`, `PII_HASH_KEY` are optional in schema
  but enforced as required in production via Railway env var configuration.
- Secrets live in Infisical only. `.env` files contain placeholders only.

## Adding a new var
1. Add to `serverEnv` in `src/env.ts` with a Zod schema.
2. Add placeholder to `/.env.example`.
3. Add real value to Infisical (dev + staging + production environments).
