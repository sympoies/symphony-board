// CLI entrypoint for the live receiver service (Docker `SYNC_MODE=live`). Reads
// config from the environment BY NAME only — the webhook secret(s), the live DB
// path, the bind host, the reads + webhook ports, and the optional project
// allowlist — and wires the GitHub provider. It opens ONLY the live store; it
// never touches the canonical store, a provider token, or config. Binds loopback
// by default; the Docker entrypoint sets LIVE_BIND_HOST so the separate nginx
// container can proxy /api/live* and the host Funnel can reach /webhooks. The
// two listeners (reads vs webhooks) are bound on separate ports so the public
// Funnel surface carries no read routes (see src/live/receiver.ts).
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

export interface LiveConfig {
  dbPath: string;
  host: string;
  // Reads listener (/api/live*), proxied by the web sidecar.
  port: number;
  // Webhook listener (/webhooks/*), the Funnel-facing surface.
  webhookPort: number;
  // Current + previous secret, merged for zero-downtime rotation.
  githubSecrets: string[];
  allowlist: string[];
  warnings: string[];
}

// Pure environment -> config resolution (no IO), so the env wiring — secret
// rotation merge, allowlist parsing, port fallback, and the empty-secret
// warning — is unit-testable without binding a socket.
export function resolveLiveConfig(
  env: Record<string, string | undefined> = process.env,
): LiveConfig {
  const warnings: string[] = [];
  const githubSecrets = nonEmpty(
    env.WEBHOOK_GITHUB_SECRET,
    env.WEBHOOK_GITHUB_SECRET_PREVIOUS,
  );
  if (githubSecrets.length === 0) {
    warnings.push(
      "WEBHOOK_GITHUB_SECRET is unset; every GitHub delivery will be rejected",
    );
  }
  const allowlist = (env.LIVE_PROJECT_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    dbPath: env.LIVE_DB_PATH ?? "data/live.db",
    host: env.LIVE_BIND_HOST ?? "127.0.0.1",
    port: Number(env.LIVE_PORT ?? "8090") || 8090,
    webhookPort: Number(env.LIVE_WEBHOOK_PORT ?? "8091") || 8091,
    githubSecrets,
    allowlist,
    warnings,
  };
}

export function main(): void {
  const cfg = resolveLiveConfig();
  for (const w of cfg.warnings) log.warn(`[live] ${w}`);

  const store = openLiveStore(cfg.dbPath);
  const routes: ProviderRoute[] = [
    {
      pathSegment: "github",
      provider: new GithubWebhookProvider(),
      sourceId: GITHUB_SOURCE_ID,
      secrets: cfg.githubSecrets,
    },
  ];
  const { webhookServer, readServer, broadcaster } = createLiveReceiver({
    store,
    routes,
    projectAllowlist: cfg.allowlist,
  });

  const pruneConfig = resolvePruneConfig();
  const stopPrune = startPruneTimer(store, pruneConfig);

  readServer.listen(cfg.port, cfg.host, () => {
    log.info(`[live] reads (/api/live*) on ${cfg.host}:${cfg.port}`);
  });
  webhookServer.listen(cfg.webhookPort, cfg.host, () => {
    log.info(
      `[live] webhooks (/webhooks/*) on ${cfg.host}:${cfg.webhookPort}, ` +
        `db ${cfg.dbPath} (allowlist: ` +
        `${cfg.allowlist.length ? cfg.allowlist.join(",") : "all"}, ` +
        `ttl ${pruneConfig.ttlDays}d, cap ${pruneConfig.maxRows})`,
    );
  });

  const shutdown = (sig: string): void => {
    log.info(`[live] ${sig} received; shutting down`);
    stopPrune();
    broadcaster.closeAll();
    webhookServer.close();
    readServer.close();
    store.close();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
