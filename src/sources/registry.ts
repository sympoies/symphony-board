// Build a Source from its config entry. Adding a provider is a case here plus a
// class implementing the Source interface — the DB and contract are untouched.

import type { Source, SourceDescriptor, SourceRunTelemetry } from "./types.ts";
import type { AuthToken } from "./http.ts";
import { type SourceConfig, projectPaths } from "../config.ts";
import { makeGqlClient } from "./graphql.ts";
import { defaultRestUrl, makeRestClient } from "./rest.ts";
import { GitHubSource } from "./github.ts";
import { GitLabSource } from "./gitlab.ts";

export type ProjectTokenMap = ReadonlyMap<string, AuthToken[]>;

function tokenKey(tokens: AuthToken[]): string {
  return tokens.map((token) => token.env).join("\0");
}

function gqlOptions(
  kind: string,
  telemetry: SourceRunTelemetry | null | undefined,
): { provider: string; onRequest?: () => void; onRateLimitCost?: (cost: number | null) => void } {
  return {
    provider: kind,
    ...(telemetry ? { onRequest: () => { telemetry.graphqlRequests++; } } : {}),
    ...(kind === "github" && telemetry
      ? {
          onRateLimitCost: (cost: number | null) => {
            if (cost === null) telemetry.graphqlCostUnknown = (telemetry.graphqlCostUnknown ?? 0) + 1;
            else telemetry.graphqlCost = (telemetry.graphqlCost ?? 0) + cost;
          },
        }
      : {}),
  };
}

export function buildSource(
  cfg: SourceConfig,
  tokens: string | AuthToken[],
  projectTokens: ProjectTokenMap = new Map(),
  telemetry?: SourceRunTelemetry | null,
): Source {
  const descriptor: SourceDescriptor = {
    sourceId: cfg.source_id,
    kind: cfg.kind,
    host: cfg.host,
    displayName: cfg.display_name ?? null,
  };
  const gql = makeGqlClient(cfg.graphql_url, tokens, gqlOptions(cfg.kind, telemetry));
  const paths = projectPaths(cfg);
  switch (cfg.kind) {
    case "github": {
      const rest = makeRestClient(cfg.rest_url ?? defaultRestUrl(cfg.kind, cfg.host), tokens, "github");
      const defaultTokens = Array.isArray(tokens) ? tokens : [{ env: "token", value: tokens }];
      const defaultKey = tokenKey(defaultTokens);
      const activePaths: string[] = [];
      const missingAuthPaths: string[] = [];
      const clientsByKey = new Map<string, { gql: typeof gql; rest: typeof rest }>();
      const projectClients = new Map<string, { gql: typeof gql; rest: typeof rest }>();
      for (const path of paths) {
        const repoTokens = projectTokens.get(path) ?? defaultTokens;
        if (repoTokens.length === 0) {
          missingAuthPaths.push(path);
          continue;
        }
        activePaths.push(path);
        const key = tokenKey(repoTokens);
        if (key === defaultKey) continue;
        let clients = clientsByKey.get(key);
        if (!clients) {
          clients = {
            gql: makeGqlClient(cfg.graphql_url, repoTokens, gqlOptions(cfg.kind, telemetry)),
            rest: makeRestClient(cfg.rest_url ?? defaultRestUrl(cfg.kind, cfg.host), repoTokens, "github"),
          };
          clientsByKey.set(key, clients);
        }
        projectClients.set(path, clients);
      }
      const partialReason = missingAuthPaths.length > 0 ? `missing token for projects: ${missingAuthPaths.join(", ")}` : null;
      return new GitHubSource(descriptor, gql, activePaths, rest, { commitBranches: cfg.commit_branches, projectClients, partialReason });
    }
    case "gitlab": {
      const rest = makeRestClient(cfg.rest_url ?? defaultRestUrl(cfg.kind, cfg.host), tokens, "gitlab");
      return new GitLabSource(descriptor, gql, paths, rest, { commitBranches: cfg.commit_branches });
    }
    default:
      throw new Error(`unknown source kind "${cfg.kind}" for ${cfg.source_id}`);
  }
}
