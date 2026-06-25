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
FROM --platform=$BUILDPLATFORM node:26-alpine AS build
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
RUN pnpm --filter @symphony-board/ui run build

# Non-root nginx: the unprivileged image runs as uid 101 and listens on 8080
# (see docker/ui-nginx.conf). The build-time COPY/rm step briefly switches to
# root, then the final USER drops back to the nginx user so the running image
# never executes as root.
FROM nginxinc/nginx-unprivileged:alpine
LABEL org.opencontainers.image.source="https://github.com/sympoies/symphony-board" \
      org.opencontainers.image.title="symphony-board-web" \
      org.opencontainers.image.description="Read-only symphony-board UI sidecar" \
      org.opencontainers.image.licenses="MIT"
USER root
COPY docker/ui-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/ui/dist /usr/share/nginx/html
# The public UI image must not bake a sample or runtime-emitted contract. The
# nginx config serves /contract.json from the operator-mounted /srv/data path.
RUN rm -f /usr/share/nginx/html/contract.json
USER nginx
EXPOSE 8080
