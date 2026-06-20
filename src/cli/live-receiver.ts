// CLI entrypoint for the live receiver service (Docker `SYNC_MODE=live`). Reads
// config from the environment BY NAME only — the webhook secret(s), the live DB
// path, the bind host/port, and the optional project allowlist — and wires the
// GitHub provider. It opens ONLY the live store; it never touches the canonical
// store, a provider token, or config. Binds loopback by default; the Docker
// entrypoint sets LIVE_BIND_HOST so the separate nginx container can proxy
// /api/live* (host exposure is constrained at the publish/funnel layer).
import { pathToFileURL } from "node:url";
import { log } from "../log.ts";
import { openLiveStore } from "../live/store.ts";
import { GithubWebhookProvider, GITHUB_SOURCE_ID } from "../live/github.ts";
import { createLiveReceiver, type ProviderRoute } from "../live/receiver.ts";
import { resolvePruneConfig, startPruneTimer } from "../live/prune.ts";

function nonEmpty(...values: (string | undefined)[]): string[] {
  return values.filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
}

export function main(): void {
  const dbPath = process.env.LIVE_DB_PATH ?? "data/live.db";
  const host = process.env.LIVE_BIND_HOST ?? "127.0.0.1";
  const port = Number(process.env.LIVE_PORT ?? "8090") || 8090;

  // Current + previous secret support zero-downtime rotation.
  const githubSecrets = nonEmpty(
    process.env.WEBHOOK_GITHUB_SECRET,
    process.env.WEBHOOK_GITHUB_SECRET_PREVIOUS,
  );
  if (githubSecrets.length === 0) {
    log.warn(
      "[live] WEBHOOK_GITHUB_SECRET is unset; every GitHub delivery will be rejected",
    );
  }
  const allowlist = (process.env.LIVE_PROJECT_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const store = openLiveStore(dbPath);
  const routes: ProviderRoute[] = [
    {
      pathSegment: "github",
      provider: new GithubWebhookProvider(),
      sourceId: GITHUB_SOURCE_ID,
      secrets: githubSecrets,
    },
  ];
  const { server, broadcaster } = createLiveReceiver({
    store,
    routes,
    projectAllowlist: allowlist,
  });

  const pruneConfig = resolvePruneConfig();
  const stopPrune = startPruneTimer(store, pruneConfig);

  server.listen(port, host, () => {
    log.info(
      `[live] receiver on ${host}:${port}, db ${dbPath} ` +
        `(allowlist: ${allowlist.length ? allowlist.join(",") : "all"}, ` +
        `ttl ${pruneConfig.ttlDays}d, cap ${pruneConfig.maxRows})`,
    );
  });

  const shutdown = (sig: string): void => {
    log.info(`[live] ${sig} received; shutting down`);
    stopPrune();
    broadcaster.closeAll();
    server.close();
    store.close();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
