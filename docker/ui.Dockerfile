# UI sidecar image. Two stages: build the Vite app (the one package with heavy
# deps + a build step), then serve the static dist/ with nginx. The contract the
# UI fetches is NOT baked in — it is served at runtime from the loop daemon's
# bind-mounted data/contract.json (see docker/ui-nginx.conf), so the deployed UI
# always renders the daemon's latest emit.
#
# Build context is the REPO ROOT (compose sets context: ..), so COPY paths are
# relative to the repo root.
FROM node:24-alpine AS build
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

FROM nginx:alpine
COPY docker/ui-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/ui/dist /usr/share/nginx/html
EXPOSE 80
