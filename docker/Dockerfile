# Portable runner. Node 24 strips TypeScript at runtime and ships node:sqlite
# built in, so there is NO build step and ZERO runtime dependencies — the image
# only needs the source, schema, and Node itself.
#
# Build context is the REPO ROOT (compose sets context: ..), so the COPY paths
# below are relative to the repo root, not to this docker/ directory.
FROM node:24-alpine

LABEL org.opencontainers.image.source="https://github.com/sympoies/symphony-board" \
      org.opencontainers.image.title="symphony-board" \
      org.opencontainers.image.description="Provider-agnostic work-item board sync and contract emitter" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Source + the normative SQL schema (read at runtime by the migrator) + the
# contract package (its JSON Schema is read by the emit-time validator) + the
# entrypoint. Config and the DB are provided at runtime as mounted volumes.
# No `pnpm install`: the backend has no third-party runtime deps, and it never
# resolves @symphony-board/contract at runtime (the type imports erase under
# stripping; the schema is read as a file from packages/contract).
COPY package.json tsconfig.json ./
COPY schema ./schema
COPY packages/contract ./packages/contract
COPY src ./src
COPY docker/docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Silence the type-stripping / node:sqlite experimental warnings globally.
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
ENV SYNC_MODE=once

ENTRYPOINT ["./docker-entrypoint.sh"]
