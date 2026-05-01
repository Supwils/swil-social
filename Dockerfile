# syntax=docker/dockerfile:1.7

# ============================================================
#  Swil Social — production image
#
#  Multi-stage build:
#    1. deps           — install both packages' node_modules (dev + prod)
#    2. build-server   — tsc → server/dist
#    3. build-client   — vite build → client/dist
#    4. runtime        — slim Node image with only prod deps + built output
#
#  The runtime image listens on $PORT (default 7945) and serves both the
#  API and the built client from the same origin (see staticClient.ts).
# ============================================================

# ---------- 1. deps ----------
FROM node:25-alpine AS deps
WORKDIR /app

# Copy lockfiles + .npmrc for both packages first so this layer caches well.
# .npmrc carries `legacy-peer-deps=true` (see comment in those files); without
# it the install fails on eslint-plugin-react's outdated peer range.
COPY server/package.json server/package-lock.json* server/.npmrc* ./server/
COPY client/package.json client/package-lock.json* client/.npmrc* ./client/
COPY package.json package-lock.json* .npmrc* ./

# Install with dev deps (needed for build steps).
RUN --mount=type=cache,target=/root/.npm \
    npm --prefix server ci --no-audit --no-fund && \
    npm --prefix client ci --no-audit --no-fund

# ---------- 2. build-server ----------
FROM node:25-alpine AS build-server
WORKDIR /app
COPY --from=deps /app/server/node_modules ./server/node_modules
COPY server ./server
COPY package.json ./
RUN npm --prefix server run build

# ---------- 3. build-client ----------
FROM node:25-alpine AS build-client
WORKDIR /app
COPY --from=deps /app/client/node_modules ./client/node_modules
COPY client ./client
COPY package.json ./
RUN npm --prefix client run build

# ---------- 4. runtime ----------
FROM node:25-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=7945 \
    SERVE_CLIENT=true

# Non-root user
RUN addgroup -S app && adduser -S -G app app

# Re-install only production deps for the server.
COPY server/package.json server/package-lock.json* server/.npmrc* ./server/
RUN --mount=type=cache,target=/root/.npm \
    npm --prefix server ci --omit=dev --no-audit --no-fund

# Bring in compiled output.
COPY --from=build-server /app/server/dist ./server/dist
COPY --from=build-client /app/client/dist ./client/dist

USER app

EXPOSE 7945

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1

CMD ["node", "server/dist/server.js"]
