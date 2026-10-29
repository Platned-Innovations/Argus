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

# ---------- gitleaks (secret scanner), pinned and checksum-verified ----------
FROM debian:bookworm-slim AS gitleaks
ARG TARGETARCH
ARG GITLEAKS_VERSION=8.30.1
ARG GITLEAKS_SHA256_AMD64=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
ARG GITLEAKS_SHA256_ARM64=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && case "${TARGETARCH:-amd64}" in \
      amd64) asset=x64;   sha="${GITLEAKS_SHA256_AMD64}" ;; \
      arm64) asset=arm64; sha="${GITLEAKS_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/gitleaks.tar.gz "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${asset}.tar.gz" \
 && echo "${sha}  /tmp/gitleaks.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/gitleaks.tar.gz -C /usr/local/bin gitleaks \
 && /usr/local/bin/gitleaks version

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

COPY --from=gitleaks /usr/local/bin/gitleaks /usr/local/bin/gitleaks

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
