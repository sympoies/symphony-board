// Build a Source from its config entry. Adding a provider is a case here plus a
// class implementing the Source interface — the DB and contract are untouched.

import type { Source, SourceDescriptor } from "./types.ts";
import type { AuthToken } from "./http.ts";
import { type SourceConfig, projectPaths } from "../config.ts";
import { makeGqlClient } from "./graphql.ts";
import { defaultRestUrl, makeRestClient } from "./rest.ts";
import { GitHubSource } from "./github.ts";
import { GitLabSource } from "./gitlab.ts";

export function buildSource(cfg: SourceConfig, tokens: string | AuthToken[]): Source {
  const descriptor: SourceDescriptor = {
    sourceId: cfg.source_id,
    kind: cfg.kind,
    host: cfg.host,
    displayName: cfg.display_name ?? null,
  };
  const gql = makeGqlClient(cfg.graphql_url, tokens, { provider: cfg.kind });
  const paths = projectPaths(cfg);
  switch (cfg.kind) {
    case "github": {
      const rest = makeRestClient(cfg.rest_url ?? defaultRestUrl(cfg.kind, cfg.host), tokens, "github");
      return new GitHubSource(descriptor, gql, paths, rest, { commitBranches: cfg.commit_branches });
    }
    case "gitlab": {
      const rest = makeRestClient(cfg.rest_url ?? defaultRestUrl(cfg.kind, cfg.host), tokens, "gitlab");
      return new GitLabSource(descriptor, gql, paths, rest, { commitBranches: cfg.commit_branches });
    }
    default:
      throw new Error(`unknown source kind "${cfg.kind}" for ${cfg.source_id}`);
  }
}
