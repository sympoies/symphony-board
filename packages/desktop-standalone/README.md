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
   (`secrets.env` token file, `data/`, `logs/`; `config/sources.json` is
   created by the in-app Settings -> Sources editor, not seeded);
2. spawns the bundled Node runtime running `src/cli/app-server.ts` — one
   process that owns the sync + emit loop, the manual-sync and config control
   surfaces, `/contract.json`, and `/api/range` on `127.0.0.1:8787` (loopback
   only);
3. opens the UI pointed at that local server. Quitting the app stops the
   daemon. If port 8787 is already serving (an earlier instance's daemon), the
   app adopts it instead of starting a second SQLite writer.

The cadence matches the Docker loop defaults: incremental sync every 2
minutes, full sweep hourly (`INTERVAL` / `FULL_EVERY` in the app-server
environment).

## Setup

Everything happens in-app:

1. Build and open the app (below). With no config yet, it opens straight into
   onboarding.
2. Add a source (provider + host; sensible defaults are suggested), add its
   repos, and paste the provider token — tokens land in `secrets.env` through
   a write-only surface and are never displayed back.
3. Save, then run the first sync from the same screen. The board renders once
   the first contract is emitted. `.../logs/app-server.log` carries the daemon
   log.

Sources, repos, display names, and tokens remain editable later under
Settings -> Sources; changes apply on the next sync run without restarting
the app. Hand-editing
`~/Library/Application Support/com.sympoies.symphony-board.standalone/config/sources.json`
(same format as `config/sources.example.json`) and `.../secrets.env` still
works as a fallback — the daemon re-reads both per run.

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
is not notarized; a local build usually opens directly, while a downloaded
release zip can be unblocked and installed with `scripts/install-release-app.sh`
(see the root README's "Build The macOS App" section).
