# UI sidecar image. Two stages: build the Vite app (the one package with heavy
# deps + a build step), then serve the static dist/ with nginx. The contract the
# UI fetches is NOT baked in — it is served at runtime from the loop daemon's
# bind-mounted data/contract.json (see docker/ui-nginx.conf), so the deployed UI
# always renders the daemon's latest emit.
#
# Build context is the REPO ROOT (compose sets context: ..), so COPY paths are
# relative to the repo root. The UI build emits static assets, so keep this
# stage on the native build platform; only the final nginx stage needs target
# platform variants.
FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build
WORKDIR /app
RUN corepack enable

# Install from the lockfile against the full workspace manifest set.
# --ignore-scripts skips the root `prepare` (lefthook install) — the image has no
# .git and the git hooks are irrelevant here — then we build just esbuild (the
# one allowlisted build Vite needs: its transpiler binary). Nothing else runs.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/contract/package.json packages/contract/package.json
COPY packages/ui/package.json packages/ui/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild esbuild

# Build the UI (tsc --noEmit + vite build). It needs the contract package's
# types and the UI source.
COPY packages/contract packages/contract
COPY packages/ui packages/ui
COPY shared shared
ARG SYMPHONY_BOARD_BUILD_COMMIT
RUN SYMPHONY_BOARD_BUILD_COMMIT="$SYMPHONY_BOARD_BUILD_COMMIT" pnpm --filter @symphony-board/ui run build

# Non-root nginx: the unprivileged image runs as uid 101 and listens on 8080
# (see docker/ui-nginx.conf). The build-time COPY/rm step briefly switches to
# root, then the final USER drops back to the nginx user so the running image
# never executes as root.
FROM nginxinc/nginx-unprivileged:alpine-slim@sha256:a8cb0f33d51fa107c96fd2bd3a71aaf564ec131e9d2bdf8700944f0ed8b170d7
LABEL org.opencontainers.image.source="https://github.com/sympoies/symphony-board" \
      org.opencontainers.image.title="symphony-board-web" \
      org.opencontainers.image.description="Read-only symphony-board UI sidecar" \
      org.opencontainers.image.licenses="MIT"
USER root
COPY docker/ui-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/ui/dist /usr/share/nginx/html
# The slim image omits curl and optional nginx modules (including image
# filtering and XSLT). Chromium is not part of the runtime: browser smoke
# tests use a separate Chrome installation. Apply newer Alpine fixes and
# remove the sample contract; nginx serves the live one from /srv/data.
RUN apk upgrade --no-cache \
  && rm -f /usr/share/nginx/html/contract.json \
  && chmod 0644 /etc/nginx/conf.d/default.conf
USER nginx
EXPOSE 8080
