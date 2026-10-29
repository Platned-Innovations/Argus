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

# ---------- gitleaks (secret scanner), built from pinned source ----------
# Upstream release binaries are built with an older Go and older modules that carry known CVEs, so Gitleaks is
# compiled here from the release's exact commit with a current Go toolchain and patched modules. Everything is
# pinned: the image by digest, the source by commit, the modules by version (verified against sum.golang.org).
FROM golang:1.27.3-bookworm@sha256:d9b6a1beb9474adc2a1ce842573639b44b2a0dd49b6669f51d3821baf9ec37c9 AS gitleaks
ARG GITLEAKS_VERSION=8.30.1
ARG GITLEAKS_COMMIT=83d9cd684c87d95d656c1458ef04895a7f1cbd8e
ENV CGO_ENABLED=0 GOTOOLCHAIN=local GOFLAGS=-mod=mod
RUN git clone --depth 1 --branch "v${GITLEAKS_VERSION}" https://github.com/gitleaks/gitleaks.git /src/gitleaks \
 && cd /src/gitleaks \
 && test "$(git rev-parse HEAD)" = "${GITLEAKS_COMMIT}" \
 && go get golang.org/x/crypto@v0.58.0 golang.org/x/text@v0.43.0 github.com/klauspost/compress@v1.20.3 \
 && go mod tidy \
 && go build -trimpath -ldflags "-s -w -X=github.com/zricethezav/gitleaks/v8/version.Version=${GITLEAKS_VERSION}" -o /usr/local/bin/gitleaks . \
 && /usr/local/bin/gitleaks version

# ---------- runtime ----------
FROM ${NODE_IMAGE} AS runtime

# git is used by the scanners to clone repositories; tini reaps child processes and forwards signals.
# npm, npx, corepack and yarn come with the Node image but are never used at runtime; removing them also removes
# their bundled dependencies (and the CVEs those accumulate) from the image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && rm -rf /opt/yarn-v* /usr/local/bin/yarn /usr/local/bin/yarnpkg

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
