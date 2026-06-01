# Portable runner. Node 24 strips TypeScript at runtime and ships node:sqlite
# built in, so there is NO build step and ZERO runtime dependencies — the image
# only needs the source, schema, and Node itself.
#
# Build context is the REPO ROOT (compose sets context: ..), so the COPY paths
# below are relative to the repo root, not to this docker/ directory.
FROM node:24-alpine

WORKDIR /app

# Source + the normative SQL schema (read at runtime by the migrator) + the
# entrypoint. Config and the DB are provided at runtime as mounted volumes.
COPY package.json tsconfig.json ./
COPY schema ./schema
COPY src ./src
COPY docker/docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Silence the type-stripping / node:sqlite experimental warnings globally.
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
ENV SYNC_MODE=once

ENTRYPOINT ["./docker-entrypoint.sh"]
