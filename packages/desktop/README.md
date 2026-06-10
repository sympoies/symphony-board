# @symphony-board/desktop

macOS desktop shell for the existing `@symphony-board/ui` package.

This is the thin-client app: it bundles the React UI and connects to a running
`symphony-board` server over HTTP(S). It does not bundle SQLite, provider
tokens, the sync daemon, or the read-only API sidecar.

## Develop

```sh
fnm use
pnpm install
pnpm desktop:dev
```

In Tauri, the UI defaults to `http://localhost:8080/`, matching the Docker
stack. Change the server from Settings -> Server when the board is hosted on a
long-running server.

## Build A Local macOS App

```sh
fnm use
pnpm install
pnpm desktop:build
```

The local `.app` bundle is emitted under:

```text
packages/desktop/src-tauri/target/release/bundle/macos/Symphony Board.app
```

For self-use, no paid Apple Developer Program membership is required. The app is
not notarized; a local build usually opens directly, while a downloaded release
zip can be unblocked and installed with `scripts/install-release-app.sh` (see
the root README's "Build The macOS App" section).
