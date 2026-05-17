# EMAPP — Urban Renewal SaaS

Multi-tenant platform for managing urban renewal projects in Israel
(תמ"א 38, פינוי-בינוי). Handles apartment-owner signature collection for Managers, Agents, and Contractors, with a self-service Tenant portal.

## Quick Start (Target: 15 minutes)

### Prerequisites

- Node.js 20 LTS (`nvm use` — see `.nvmrc`)
- pnpm 9+ (`npm i -g pnpm`)
- Docker Desktop (optional — for local postgres/redis/minio/mailhog)

### Setup

```bash
# 1. Clone
git clone https://github.com/Urban-renewal/emapp.git
cd emapp

# 2. Install dependencies
pnpm install

# 3. Copy env file and fill in credentials
cp .env.example .env.local
# Fill in DATABASE_URL from Neon, BETTER_AUTH_SECRET, etc.
# Or skip validation for a quick start:
# SKIP_ENV_VALIDATION=true pnpm dev

# 4. Start dev servers
pnpm dev
```

API: http://localhost:3000/api/v1/health
Web: http://localhost:3001

### Local infrastructure (optional)

```bash
docker compose up -d   # starts postgres, redis, minio, mailhog
```

MinIO console: http://localhost:9001 (minioadmin / minioadmin)
MailHog UI: http://localhost:8025

## Repository Structure

```
apps/
  api/          NestJS 11 + Fastify backend
  web/          Next.js 15 App Router frontend (RTL, Hebrew-first)
packages/
  config/       T3-env validated environment variables
  db/           Drizzle ORM schema + connection
  shared-types/ TypeScript types shared between BE and FE
  validators/   Israeli ID + phone validators (pure functions)
```

## Common Commands

| Command              | Purpose                           |
| -------------------- | --------------------------------- |
| `pnpm dev`           | Start all dev servers             |
| `pnpm build`         | Build all packages                |
| `pnpm test`          | Run all tests                     |
| `pnpm test:coverage` | Run tests with V8 coverage report |
| `pnpm typecheck`     | Typecheck all packages            |
| `pnpm lint`          | Lint all packages                 |
| `pnpm format`        | Format all files with Prettier    |
| `pnpm db:generate`   | Generate Drizzle migration SQL    |
| `pnpm db:migrate`    | Apply pending migrations          |

## Roles (6 MVP roles, 3 tiers)

- **Tier 1 (Org)**: Manager (full access) / Agent (assigned projects) / Viewer (read-only)
- **Tier 2 (External)**: Contractor (share link, JSONB perms) / Tenant (SMS OTP, own record)
- **Tier 3 (Provider)**: Provider Admin (cross-tenant, MFA required)

## Documentation

- [Doc 01 — Vision & Market](./docs/01-vision-market.html)
- [Doc 02 — Architecture](./docs/02-architecture-production.html)
- [Doc 03 — MVP Roadmap](./docs/03-mvp-roadmap.html)
- [Doc 04a — Claude Code Setup](./docs/04a-claude-environment.html)
- [Doc 04b — Phase 0 Foundation](./docs/04b-phase-0-foundation.html)
- [Doc 04c — Phase 1 Database](./docs/04c-phase-1-database.html)
- [DECISIONS.md](./docs/DECISIONS.html) — Locked architectural decisions

## Security Notes

- All secrets via Infisical only. Never commit `.env` with real values.
- PII (national_id, phone, signatures) is pgcrypto-encrypted in the DB.
- Every DB read must go through `withTenant(orgId, fn)` or `withProvider(...)`.

## License

Proprietary. Internal use only.
