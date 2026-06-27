# Portable runner. Node 24 strips TypeScript at runtime and ships node:sqlite
# built in, so there is NO backend build step. The image installs the root
# production runtime dependencies so opt-in Postgres deployments can resolve the
# lazy-loaded postgres.js driver; SQLite deployments still never import it.
#
# Build context is the REPO ROOT (compose sets context: ..), so the COPY paths
# below are relative to the repo root, not to this docker/ directory.
FROM node:24-alpine

LABEL org.opencontainers.image.source="https://github.com/sympoies/symphony-board" \
      org.opencontainers.image.title="symphony-board" \
      org.opencontainers.image.description="Provider-agnostic work-item board sync and contract emitter" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Production deps first for Docker layer caching. `--ignore-scripts` deliberately
# skips the root prepare hook (lefthook is dev-only) and dependency postinstalls;
# postgres.js has no build step or transitive deps.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/contract/package.json ./packages/contract/package.json
RUN corepack enable \
  && corepack prepare pnpm@11.7.0 --activate \
  && pnpm install --prod --frozen-lockfile --ignore-scripts

# Source + the normative SQL schema (read at runtime by each migrator) + the
# contract package (its JSON Schema is read by the emit-time validator) + the
# entrypoint. Config, SQLite files, and/or Postgres credentials are provided at
# runtime by compose/env.
COPY schema ./schema
COPY packages/contract ./packages/contract
COPY src ./src
COPY docker/docker-entrypoint.sh ./
RUN chmod -R a+rX package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json schema packages/contract src \
  && chmod 0755 docker-entrypoint.sh

# Silence the type-stripping / node:sqlite experimental warnings globally.
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
ENV SYNC_MODE=once

# Run as the built-in non-root `node` user (uid 1000). /app/data — the only
# path written at runtime (the emitted contract and any SQLite store) — is
# created owned by node so a FRESH named volume inherits that ownership.
# EXISTING named volumes from a root-era deploy must be chowned to uid 1000 once
# during migration; a host bind-mounted data dir likewise needs uid-1000 write.
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

ENTRYPOINT ["./docker-entrypoint.sh"]
