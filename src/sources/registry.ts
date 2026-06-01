// Build a Source from its config entry. Adding a provider is a case here plus a
// class implementing the Source interface — the DB and contract are untouched.

import type { Source, SourceDescriptor } from "./types.ts";
import type { SourceConfig } from "../config.ts";
import { makeGqlClient } from "./graphql.ts";
import { GitHubSource } from "./github.ts";
import { GitLabSource } from "./gitlab.ts";

export function buildSource(cfg: SourceConfig, token: string): Source {
  const descriptor: SourceDescriptor = {
    sourceId: cfg.source_id,
    kind: cfg.kind,
    host: cfg.host,
    displayName: cfg.display_name ?? null,
  };
  const gql = makeGqlClient(cfg.graphql_url, token);
  switch (cfg.kind) {
    case "github":
      return new GitHubSource(descriptor, gql, cfg.projects);
    case "gitlab":
      return new GitLabSource(descriptor, gql, cfg.projects);
    default:
      throw new Error(`unknown source kind "${cfg.kind}" for ${cfg.source_id}`);
  }
}
