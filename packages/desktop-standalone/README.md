# @symphony-board/desktop-standalone

Fully self-contained macOS app for `symphony-board`: the read-only UI **plus**
the whole backend — the Node 24 runtime, the sync loop daemon, the SQLite
store, and the contract/range HTTP surface — bundled into one `.app`. No
Docker, no external server.

This is the second desktop option, beside the thin client:

| | `packages/desktop` (thin) | `packages/desktop-standalone` (this) |
| --- | --- | --- |
| UI | bundled | bundled |
| Sync daemon, SQLite, tokens | on a server / Docker host | inside the app's data dir |
| Needs Docker or a server | yes | no |

## How it works

On launch the app:

1. prepares `~/Library/Application Support/com.sympoies.symphony-board.standalone/`
   (`config/sources.json` seeded from the bundled template on first run,
   `secrets.env` token template, `data/`, `logs/`);
2. spawns the bundled Node runtime running `src/cli/app-server.ts` — one
   process that owns the sync + emit loop, the manual-sync control surface,
   `/contract.json`, and `/api/range` on `127.0.0.1:8787` (loopback only);
3. opens the UI pointed at that local server. Quitting the app stops the
   daemon. If port 8787 is already serving (an earlier instance's daemon), the
   app adopts it instead of starting a second SQLite writer.

The cadence matches the Docker loop defaults: incremental sync every 2
minutes, full sweep hourly (`INTERVAL` / `FULL_EVERY` in the app-server
environment).

## Setup

1. Build and open the app (below), then quit it once — the first launch seeds
   the data directory.
2. Edit `~/Library/Application Support/com.sympoies.symphony-board.standalone/config/sources.json`
   with your sources (same format as `config/sources.example.json`).
3. Put tokens in `.../secrets.env` (`GITHUB_TOKEN=...`, one per line; names
   must match each source's `token_env`).
4. Relaunch the app. The first full sync runs immediately; the board renders
   once the first contract is emitted. `.../logs/app-server.log` carries the
   daemon log.

## Develop

```sh
fnm use
pnpm install
pnpm desktop-standalone:dev
```

## Build A Local macOS App

```sh
fnm use
pnpm install
pnpm desktop-standalone:build
```

The bundle is emitted under:

```text
packages/desktop-standalone/src-tauri/target/release/bundle/macos/Symphony Board Standalone.app
```

`scripts/prepare-node-sidecar.sh` (run automatically by the build) copies the
active Node 24 binary into `src-tauri/binaries/` so Tauri bundles it as the
sidecar runtime; build with the repo's `.node-version` toolchain active.

For self-use, no paid Apple Developer Program membership is required. The app
is not notarized, so macOS may require right-click -> Open the first time.
