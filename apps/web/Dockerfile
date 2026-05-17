FROM node:20-alpine AS base
RUN corepack enable

# ── deps stage ────────────────────────────────────────────────────────────────
FROM base AS deps
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared-types/package.json ./packages/shared-types/
COPY packages/validators/package.json ./packages/validators/
COPY apps/web/package.json ./apps/web/

RUN pnpm install --frozen-lockfile

# ── builder stage ─────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/shared-types/node_modules ./packages/shared-types/node_modules 2>/dev/null || true
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules 2>/dev/null || true

COPY tsconfig.json ./
COPY packages/ ./packages/
COPY apps/web/ ./apps/web/

ENV NEXT_TELEMETRY_DISABLED=1
# standalone output creates symlinks — only works in Docker (Linux), not Windows dev
ENV NEXT_OUTPUT=standalone
RUN pnpm --filter @emapp/web build

# ── runner stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
ENV PORT=3001
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public 2>/dev/null || true

USER node
EXPOSE 3001
CMD ["node", "apps/web/server.js"]
