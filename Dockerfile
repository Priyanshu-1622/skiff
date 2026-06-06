# =====================================================
# Skiff — multi-stage Dockerfile
#
# Stage 1: base  — Node 20 + pnpm + build tools
# Stage 2: deps  — install all workspace deps
# Stage 3: build-shared — compile @skiff/shared to dist/
# Stage 4: build-web    — compile React frontend
# Stage 5: build-api    — compile Fastify API
# Stage 6: runtime      — minimal image, no build tools
#
# FIX: @skiff/shared was previously copied as raw .ts source into
# the runtime image. Plain `node` can't load .ts files, causing:
#   ERR_UNKNOWN_FILE_EXTENSION: Unknown file extension ".ts"
# We now compile shared to JS first and copy only dist/.
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
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json ./apps/web/
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile

# ─── 3. build shared ────────────────────────────────────────
# Compile @skiff/shared to plain JS so the runtime stage has
# no .ts files to trip over. Both build-web and build-api
# inherit from this stage so they see the compiled shared dist.
FROM deps AS build-shared
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
RUN pnpm --filter @skiff/shared build

# ─── 4. build web ───────────────────────────────────────────
FROM build-shared AS build-web
COPY apps/web ./apps/web
RUN pnpm --filter @skiff/web build

# ─── 5. build api ───────────────────────────────────────────
FROM build-shared AS build-api
COPY apps/api ./apps/api
RUN pnpm --filter @skiff/api build

# ─── 6. runtime ─────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    SKIFF_DATA_DIR=/app/data \
    SKIFF_HOST=0.0.0.0 \
    SKIFF_PORT=8080
WORKDIR /app

# better-sqlite3 needs libstdc++6 at runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@9 --activate

# Install prod-only deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile --prod --filter @skiff/api...

# Copy compiled artifacts
COPY --from=build-api /app/apps/api/dist ./apps/api/dist
COPY --from=build-api /app/apps/api/src/db/schema.sql ./apps/api/dist/db/schema.sql
COPY --from=build-web /app/apps/web/dist ./apps/web/dist
# Copy compiled shared JS (not raw .ts source)
COPY --from=build-shared /app/packages/shared/dist ./packages/shared/dist

# Data volume — pre-create with correct ownership so non-root user can write
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/server.js"]
