# EMAPP worker — Railway service.
#
# Multi-stage build for a small final image. The worker shares packages
# with @emapp/api via the pnpm workspace, so we install at the repo root
# and copy only the built worker dist + node_modules subtree the worker
# needs.

# ── 1. install + build ──────────────────────────────────────────────
FROM node:20-alpine AS builder

# pnpm via corepack — Node 20 ships corepack but it's disabled by default.
RUN corepack enable pnpm

WORKDIR /repo

# Copy workspace manifests first (better layer cache).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.json ./
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/shared-types/package.json packages/shared-types/
COPY apps/worker/package.json apps/worker/

# Install workspace deps. --frozen-lockfile pins exactly what CI tests.
RUN pnpm install --frozen-lockfile --filter=@emapp/worker...

# Copy sources for the worker + its workspace deps.
COPY packages/config packages/config
COPY packages/db packages/db
COPY packages/shared-types packages/shared-types
COPY apps/worker apps/worker

# Build the worker (tsc → dist/).
RUN pnpm --filter=@emapp/worker build

# ── 2. runtime image ────────────────────────────────────────────────
FROM node:20-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

# Copy only what the worker needs at runtime.
COPY --from=builder /repo/apps/worker/dist ./dist
COPY --from=builder /repo/apps/worker/package.json ./
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages ../packages

# Drop privileges — Railway honours USER. The node base image already
# has a non-root `node` user.
USER node

# Worker runs in the foreground; Railway captures stdout/stderr.
CMD ["node", "dist/main.js"]
