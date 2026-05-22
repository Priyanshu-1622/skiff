# =====================================================
# Skiff — multi-stage Dockerfile
#
# Stage 1: install pnpm, fetch all workspace deps
# Stage 2: build the web frontend to static files
# Stage 3: build the api typescript to plain js
# Stage 4: tiny runtime image with just node + the built artifacts
#
# Final image ships:
#   /app/apps/api/dist     — compiled API
#   /app/apps/web/dist     — built frontend (served as static by api on Day 13+)
#   /app/data              — SQLite database lives here (volume mount this)
# =====================================================

# ─── 1. base ────────────────────────────────────────────────
FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@9 --activate
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ─── 2. deps ────────────────────────────────────────────────
FROM base AS deps
COPY pnpm-workspace.yaml package.json ./
COPY apps/web/package.json ./apps/web/
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile=false

# ─── 3. build web ───────────────────────────────────────────
FROM deps AS build-web
COPY tsconfig.base.json ./
COPY apps/web ./apps/web
COPY packages/shared ./packages/shared
RUN pnpm --filter @skiff/web build

# ─── 4. build api ───────────────────────────────────────────
FROM deps AS build-api
COPY tsconfig.base.json ./
COPY apps/api ./apps/api
COPY packages/shared ./packages/shared
RUN pnpm --filter @skiff/api build

# ─── 5. runtime ─────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    SKIFF_DATA_DIR=/app/data \
    SKIFF_HOST=0.0.0.0 \
    SKIFF_PORT=8080
WORKDIR /app

# Better-sqlite3 needs a few runtime libraries
RUN apt-get update && apt-get install -y --no-install-recommends \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

# pnpm — needed only because we'll use it to install prod deps below
RUN corepack enable && corepack prepare pnpm@9 --activate

# Copy package manifests and install prod-only deps
COPY pnpm-workspace.yaml package.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile=false --prod --filter @skiff/api...

# Copy built artifacts
COPY --from=build-api /app/apps/api/dist ./apps/api/dist
COPY --from=build-api /app/apps/api/src/db/schema.sql ./apps/api/dist/db/schema.sql
COPY --from=build-web /app/apps/web/dist ./apps/web/dist
COPY --from=build-api /app/packages/shared ./packages/shared

# Data volume
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/server.js"]
