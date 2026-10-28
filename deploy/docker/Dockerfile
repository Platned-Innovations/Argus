# syntax=docker/dockerfile:1.7
# Argus — single image that runs the API, web UI and background worker (ARGUS_ROLE=all|api|worker).
# Build from the repository root:  docker build -f deploy/docker/Dockerfile -t argus .

ARG NODE_IMAGE=node:24-bookworm-slim

# ---------- build ----------
FROM ${NODE_IMAGE} AS build
WORKDIR /src

# Install dependencies first so this layer is cached until a manifest changes.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/data/package.json packages/data/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund

COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN npm run build \
 && npm prune --omit=dev --no-audit --no-fund

# ---------- runtime ----------
FROM ${NODE_IMAGE} AS runtime

# git is used by the scanners to clone repositories; tini reaps child processes and forwards signals.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=8080 \
    ARGUS_ROLE=all \
    ARGUS_WEB_DIR=/app/apps/web/dist

WORKDIR /app
COPY --from=build --chown=node:node /src/package.json ./
COPY --from=build --chown=node:node /src/node_modules ./node_modules
COPY --from=build --chown=node:node /src/packages/shared/package.json packages/shared/
COPY --from=build --chown=node:node /src/packages/shared/dist packages/shared/dist
COPY --from=build --chown=node:node /src/packages/data/package.json packages/data/
COPY --from=build --chown=node:node /src/packages/data/dist packages/data/dist
COPY --from=build --chown=node:node /src/apps/server/package.json apps/server/
COPY --from=build --chown=node:node /src/apps/server/dist apps/server/dist
COPY --from=build --chown=node:node /src/apps/web/dist apps/web/dist

# Never run as root. Scan workspaces live under /tmp and are always deleted after use.
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEBSITES_PORT||process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "apps/server/dist/main.js"]
