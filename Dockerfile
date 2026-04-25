# Trader Service — Docker image
#
# This image is consumed by the agentic-hosting Host Manager when it spawns a
# trader tenant. Default CMD targets dist/acp-adapter/main.js (which is a thin
# shim that delegates to startTrader() in dist/trader/main.js — the trader's
# standalone entry already implements the full ACP-0 handshake).
#
# Build context:
#   - trader-service repo (this directory)
#   - sphere-sdk sibling at ../sphere-sdk (until @unicitylabs/sphere-sdk
#     publishes the swap-module exports to npm)
#
# Build:
#   cd /path/to/parent && \
#   docker build -f trader-service/Dockerfile \
#                -t ghcr.io/vrogojin/agentic-hosting/trader:0.1 \
#                .

# ---------------------------------------------------------------------------
# Stage 1: Build
# ---------------------------------------------------------------------------
FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f AS build

WORKDIR /build

# sphere-sdk is consumed via `file:../sphere-sdk` and must be built (compiled
# to dist/) before npm install can resolve the file: link to its declared
# exports. Both repos must be present in the build context.
COPY sphere-sdk/ ./sphere-sdk/
COPY trader-service/ ./trader-service/

# Build sphere-sdk in-place so its dist/ exists when trader-service does its
# install. (file: dependencies install via symlink — they aren't copied, so we
# need the dist artifacts beside the package.json the link points at.)
RUN cd sphere-sdk && npm ci && npm run build

# Install + build trader-service (compiles src/ + src/acp-adapter/ + src/cli/
# to dist/).
RUN cd trader-service && npm ci && npm run build

# ---------------------------------------------------------------------------
# Stage 2: Runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f

# tini handles PID-1 signal forwarding so SIGTERM from the host manager
# triggers our graceful-shutdown handler instead of being swallowed.
RUN apk add --no-cache tini

WORKDIR /app

# Copy compiled output + package files for production install.
COPY --from=build /build/trader-service/dist ./dist/
COPY --from=build /build/trader-service/package.json /build/trader-service/package-lock.json ./
COPY --from=build /build/sphere-sdk/ ./sphere-sdk/

# Rewrite the file: dependency to the local copy in the image (the original
# `file:../sphere-sdk` would point outside the container). Then install only
# production deps.
RUN sed -i 's|"file:../sphere-sdk"|"file:./sphere-sdk"|' package.json \
 && npm install --omit=dev --ignore-scripts

# Standard host-manager-injected directory layout. Mounted at runtime by the
# manager; created here so the ACP adapter can mkdir under them without
# tripping permission errors on the first boot. The trader-specific
# subdirectory holds intent / deal / strategy state.
RUN mkdir -p /data/wallet /data/tokens /data/trader && chown -R node:node /data

ENV NODE_ENV=production

USER node

ENTRYPOINT ["tini", "--"]

# Default to the ACP-wrapped entrypoint (host-manager tenant mode).
CMD ["node", "/app/dist/acp-adapter/main.js"]
