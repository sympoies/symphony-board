// Read-only, on-demand GitHub GraphQL rate-limit probe for the UI Diagnostics
// page (GET /api/token-rate-limits), served by the writer daemon
// (src/cli/sync-daemon.ts) and the standalone app server (which falls through to
// the same control handler). When the operator opens the Diagnostics "Rate
// limit" tab — or hits Refresh — this fires ONE lightweight GraphQL query per
// distinct configured GitHub credential and reports each token's remaining
// budget and reset time.
//
// This is operational telemetry, NOT work-item data: it touches no store, no
// canonical DB, and no contract (so no contract_version bump, like /api/stats
// and /api/logs). Each probe is a lone `{ rateLimit { ... } }` query, the
// cheapest call GitHub offers — it reports the token's budget without meaningful
// spend against it.
//
// Boundary: credentials are identified by env-var NAME or a synthetic GitHub App
// label only. The resolved token VALUES never leave this module — they
// authenticate the probe and are dropped; they are never placed on the response,
// mirroring the "credential status renders as set/missing, never values" rule
// the Settings surface already follows.

import type { AppConfig, SourceConfig } from "../config.ts";
import { sourceEnabled } from "../config.ts";
import { createAuthTokenResolver, type AuthTokenResolver } from "../auth.ts";
import { makeGqlClient, type GqlClient } from "../sources/graphql.ts";
import type { AuthToken } from "../sources/http.ts";

// A lone rateLimit query: the cheapest probe GitHub offers (it reports the
// current budget without counting meaningfully against it). `cost` is included
// so the caller can confirm the probe stays ~free.
const RATE_LIMIT_QUERY = "query SymphonyBoardRateLimitProbe { rateLimit { limit cost remaining used resetAt } }";

// PATs have no configured display name, so the diagnostics probe asks GitHub for
// the authenticated account login in the same lightweight call.
const PAT_RATE_LIMIT_QUERY = "query SymphonyBoardRateLimitProbe { viewer { login } rateLimit { limit cost remaining used resetAt } }";

// A diagnostics probe should fail fast rather than hang the page on a stalled
// token; shorter than the sync fetch default.
const PROBE_TIMEOUT_MS = 10_000;

interface RateLimitField {
  limit: number;
  cost: number;
  remaining: number;
  used: number;
  resetAt: string;
}

interface ViewerField {
  login?: string | null;
}

interface RateLimitProbeResult {
  viewer?: ViewerField | null;
  rateLimit: RateLimitField | null;
}

export interface TokenRateLimit {
  source_id: string;
  source_display: string;
  env: string; // env-var NAME or github_app:<installation_id_env>, never the token value
  kind?: "pat" | "github_app";
  name?: string;
  strategy?: "failover" | "round_robin";
  ok: boolean;
  limit?: number;
  remaining?: number;
  used?: number;
  reset_at?: string; // ISO 8601, straight from GitHub's resetAt
  error?: string;
}

export interface TokenRateLimitsResult {
  // null only on the config-error response below; a successful probe always
  // stamps an ISO instant.
  generated_at: string | null;
  tokens: TokenRateLimit[];
  // Present only when the server could not load config to enumerate tokens; the
  // probe itself never sets it (a per-token failure is an ok:false row instead).
  error?: string;
}

// The response when the server cannot even load config to enumerate tokens — a
// 200 with no tokens and the reason, so the tab degrades to a message rather
// than erroring. Owned here so the route's success and error shapes share one
// compile-checked type instead of drifting as inline literals.
export function tokenRateLimitsConfigError(message: string): TokenRateLimitsResult {
  return { generated_at: null, tokens: [], error: message };
}

// Inject-able so tests exercise the enumeration + shaping without a network call.
export type ProbeClientFactory = (url: string, token: AuthToken) => GqlClient;

const defaultClientFactory: ProbeClientFactory = (url, token) =>
  makeGqlClient(url, [token], { provider: "github", timeoutMs: PROBE_TIMEOUT_MS });

function gitHubSources(cfg: AppConfig): SourceConfig[] {
  return cfg.sources.filter((s) => s.kind === "github" && sourceEnabled(s));
}

function tokenKind(token: AuthToken): NonNullable<TokenRateLimit["kind"]> {
  return token.kind ?? (token.env.startsWith("github_app:") ? "github_app" : "pat");
}

function tokenName(token: AuthToken, kind: NonNullable<TokenRateLimit["kind"]>, viewer: ViewerField | null | undefined): string | undefined {
  const configured = token.name?.trim();
  if (configured) return configured;
  if (kind !== "pat") return undefined;
  const login = viewer?.login?.trim();
  return login ? login : undefined;
}

// Probe every distinct configured GitHub token's GraphQL budget, concurrently.
// One entry per (source, distinct credential label); a credential that fails to
// resolve to a token is skipped, and a probe that errors becomes an
// `ok: false` row carrying the message so the operator sees WHY rather than a
// silently missing token.
export async function probeTokenRateLimits(
  cfg: AppConfig,
  opts: { clientFactory?: ProbeClientFactory; authTokenResolver?: AuthTokenResolver; now?: () => string } = {},
): Promise<TokenRateLimitsResult> {
  const clientFactory = opts.clientFactory ?? defaultClientFactory;
  const authTokenResolver = opts.authTokenResolver ?? createAuthTokenResolver();
  const now = opts.now ?? (() => new Date().toISOString());

  const jobs: Array<Promise<TokenRateLimit>> = [];
  for (const s of gitHubSources(cfg)) {
    const base = { source_id: s.source_id, source_display: s.display_name ?? s.source_id };
    for (const token of await authTokenResolver.resolveSourceTokens(s)) {
      const kind = tokenKind(token);
      const tokenMeta = {
        env: token.env,
        kind,
        ...(token.name?.trim() ? { name: token.name.trim() } : {}),
        strategy: token.strategy ?? "failover" as const,
      };
      jobs.push(
        (async (): Promise<TokenRateLimit> => {
          try {
            const gql = clientFactory(s.graphql_url, token);
            const data = await gql<RateLimitProbeResult>(kind === "pat" ? PAT_RATE_LIMIT_QUERY : RATE_LIMIT_QUERY);
            const rl = data?.rateLimit;
            const name = tokenName(token, kind, data?.viewer);
            const probedMeta = { ...tokenMeta, ...(name ? { name } : {}) };
            if (!rl) return { ...base, ...probedMeta, ok: false, error: "no rateLimit in GraphQL response" };
            return {
              ...base,
              ...probedMeta,
              ok: true,
              limit: rl.limit,
              remaining: rl.remaining,
              used: rl.used,
              reset_at: rl.resetAt,
            };
          } catch (err) {
            return { ...base, ...tokenMeta, ok: false, error: (err as Error).message };
          }
        })(),
      );
    }
  }

  const tokens = (await Promise.all(jobs)).sort((a, b) => {
    const kindRank = (kind: TokenRateLimit["kind"]): number => (kind === "github_app" ? 0 : 1);
    const byKind = kindRank(a.kind) - kindRank(b.kind);
    if (byKind !== 0) return byKind;
    return (
      a.source_display.localeCompare(b.source_display) ||
      a.source_id.localeCompare(b.source_id) ||
      (a.name ?? "").localeCompare(b.name ?? "") ||
      a.env.localeCompare(b.env)
    );
  });
  return { generated_at: now(), tokens };
}
