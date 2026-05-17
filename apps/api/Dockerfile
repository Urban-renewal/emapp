FROM node:20-alpine AS base
RUN corepack enable

# ── deps stage ────────────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/config/package.json ./packages/config/
COPY packages/db/package.json ./packages/db/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/validators/package.json ./packages/validators/
COPY apps/api/package.json ./apps/api/

RUN pnpm install --frozen-lockfile

# ── builder stage ─────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/config/node_modules ./packages/config/node_modules 2>/dev/null || true
COPY --from=deps /app/packages/db/node_modules ./packages/db/node_modules 2>/dev/null || true
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules 2>/dev/null || true

COPY tsconfig.json ./
COPY packages/ ./packages/
COPY apps/api/ ./apps/api/

ENV SKIP_ENV_VALIDATION=true
RUN pnpm --filter @emapp/api build

# ── runner stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

# Copy workspace manifests + lockfile for production install
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/config/package.json ./packages/config/
COPY packages/db/package.json ./packages/db/
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/validators/package.json ./packages/validators/
COPY apps/api/package.json ./apps/api/

RUN corepack enable && pnpm install --frozen-lockfile --prod

COPY --from=builder /app/apps/api/dist ./apps/api/dist

EXPOSE 3000
USER node

CMD ["node", "apps/api/dist/main.js"]
