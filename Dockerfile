# =============================================================================
# Craftad API — production Docker image (multi-stage)
#
# Stage 1 (builder): install ALL deps, run nest build → dist/
# Stage 2 (runtime): copy dist/ + production deps only, run node dist/main.js
#
# Built for Cloud Run: listens on $PORT (Cloud Run sets it), runs as non-root,
# no shell entry. Image is ~150MB on alpine.
# =============================================================================

# ---------- Stage 1: build ----------
FROM node:20-alpine AS builder

WORKDIR /app

# Copy manifests first so docker can cache the install layer when only
# source changes
COPY package*.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig*.json nest-cli.json ./
COPY src ./src

RUN npm run build && npm prune --omit=dev

# ---------- Stage 2: runtime ----------
FROM node:20-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Pull only what runtime needs from the builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# Non-root for defense in depth — Cloud Run runs containers as root by
# default; an attacker who finds an RCE in our deps gets fewer
# capabilities to abuse.
USER node

# Cloud Run sets PORT; we don't EXPOSE here because Cloud Run ignores it.
CMD ["node", "dist/main.js"]
