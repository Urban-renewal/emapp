# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.0.1] - 2026-05-17

### Added

- Initial monorepo structure with Turborepo + pnpm workspaces
- Backend scaffold: NestJS 11 + Fastify with `/api/v1/health` endpoint
- Frontend scaffold: Next.js 15 App Router with RTL support and Heebo font (Hebrew-first)
- Four shared packages: `shared-types`, `db` (Drizzle), `config` (T3-env), `validators`
- Israeli ID Luhn validator — 7 tests covering valid 9-digit, 8-digit padded, invalid checksum, non-numeric, etc.
- Israeli phone E.164 normalizer — 14 tests covering mobile hyphens, landlines, 972-prefix, invalid prefixes
- ESLint (typescript-eslint, import-order, security, unicorn) + Prettier configured across all packages
- Conventional commits enforcement via commitlint + Husky
- lint-staged: ESLint + Prettier run on staged files before commit
- Pre-commit hook: optional gitleaks secret scan
- Vitest v2 with V8 coverage (70% threshold) — 23 tests passing
- GitHub Actions CI: parallel jobs for typecheck, lint, test (postgres service), build, secrets-scan (gitleaks), pnpm audit
- Dependabot: weekly npm and GitHub Actions security updates
- Docker setup: `docker-compose.yml` with postgres 16 (postgis), redis 7, minio, mailhog; production Dockerfiles for api and web
- T3-env validation for all environment variables at startup
- Sentry integration for both API and Web error tracking
- Helmet middleware (CSP, HSTS) and strict CORS allow-list on the API
- pino structured logging with PII redaction (auth headers, cookies, passwords)
- Rate limiting: 100 requests/minute per IP via `@nestjs/throttler`

### Security

- gitleaks scanner in pre-commit hook and CI
- Helmet CSP + HSTS headers on all API responses
- Strict CORS: `production`, `preview`, and `development` origin lists, no wildcard
- pino redacts `authorization`, `cookie`, `password`, and `token` from logs
- `.env.example` with placeholders; no real secrets ever committed

[Unreleased]: https://github.com/Urban-renewal/emapp/compare/v0.0.1-phase0...HEAD
[0.0.1]: https://github.com/Urban-renewal/emapp/releases/tag/v0.0.1-phase0
