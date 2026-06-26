// Runtime auth resolution for provider clients. Config declares credential
// env-var names only; this module reads their current values and, for GitHub App
// auth, mints a short-lived installation token before a sync/probe builds its
// HTTP clients.

import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";
import type { AuthToken } from "./sources/http.ts";
import { DEFAULT_FETCH_TIMEOUT_MS, fetchWithTimeout } from "./sources/http.ts";
import { defaultRestUrl } from "./sources/rest.ts";
import { log } from "./log.ts";
import {
  readSecretsOverlay,
  resolveSecretsPath,
  secretValueForEnv,
  type AuthPoolConfig,
  type AuthPolicyConfig,
  type AuthTokenStrategy,
  type GitHubAppAuthConfig,
  type SourceConfig,
  type TokenPoolConfig,
} from "./config.ts";

export interface GitHubAppTokenRequest {
  appId: string;
  installationId: string;
  privateKey: string;
  restUrl: string;
  label: string;
  name?: string;
  strategy?: AuthTokenStrategy;
}

export type MintGitHubAppInstallationToken = (request: GitHubAppTokenRequest) => Promise<AuthToken>;

export interface AuthTokenResolver {
  tokensForSource(source: SourceConfig): Promise<AuthToken[]>;
  tokensForProject(source: SourceConfig, projectPath: string): Promise<AuthToken[]>;
  resolveSourceTokens(source: SourceConfig): Promise<AuthToken[]>;
  // After resolving a source's tokens, the message of a *hard* GitHub App mint
  // failure for that source — a configured bot whose installation-token mint
  // threw and that left its routed pool with no usable token (no PAT failover,
  // no sibling bot). Returns null when every mint succeeded, or when a mint
  // failure was absorbed by an available failover token (benign). The caller
  // uses this to surface an actionable error instead of silently skipping the
  // source or falling back to credentials outside its selected pool. Optional so
  // lightweight resolver fakes need not implement it.
  hardMintFailure?(source: SourceConfig): string | null;
}

export interface AuthTokenResolverDeps {
  mintGitHubAppInstallationToken?: MintGitHubAppInstallationToken;
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function githubAppJwt(appId: string, privateKey: string, nowMs: number = Date.now()): string {
  const issuer = Number(appId);
  if (!Number.isSafeInteger(issuer) || issuer <= 0) {
    throw new Error(`GitHub App app_id_env must resolve to a positive integer, got ${JSON.stringify(appId)}`);
  }
  const nowSec = Math.floor(nowMs / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 9 * 60, iss: issuer }));
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(privateKey);
  return `${signingInput}.${base64Url(signature)}`;
}

export async function mintGitHubAppInstallationToken(request: GitHubAppTokenRequest): Promise<AuthToken> {
  const base = request.restUrl.replace(/\/+$/, "");
  const url = `${base}/app/installations/${encodeURIComponent(request.installationId)}/access_tokens`;
  const jwt = githubAppJwt(request.appId, request.privateKey);
  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "symphony-board",
      },
    },
    DEFAULT_FETCH_TIMEOUT_MS,
  );
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`GitHub App token HTTP ${res.status}: non-JSON response from ${url}`);
  }
  if (!res.ok) {
    throw new Error(`GitHub App token HTTP ${res.status}: ${json?.message ?? text}`);
  }
  if (typeof json?.token !== "string" || json.token.trim().length === 0) {
    throw new Error("GitHub App token response did not include a token");
  }
  return {
    env: request.label,
    value: json.token.trim(),
    kind: "github_app",
    ...(request.name ? { name: request.name } : {}),
    strategy: request.strategy ?? "failover",
  };
}

function tokenEnvNamesFromPool(pool: TokenPoolConfig): string[] {
  return [pool.token_env, ...(pool.fallback_token_envs ?? [])].filter((env): env is string => typeof env === "string" && env.trim().length > 0);
}

function projectEntryForPath(source: SourceConfig, projectPath: string) {
  return source.projects.find((p) => (typeof p === "string" ? p : p.path) === projectPath);
}

function escapedPem(value: string): string {
  return value.replace(/\\n/g, "\n");
}

function githubAppTokenRequest(
  source: SourceConfig,
  app: GitHubAppAuthConfig,
  overlay: Map<string, string>,
): GitHubAppTokenRequest | null {
  const appId = secretValueForEnv(app.app_id_env, overlay);
  const installationId = secretValueForEnv(app.installation_id_env, overlay);
  if (!appId || !installationId) return null;

  let privateKey: string | null = null;
  if (app.private_key_env) {
    const raw = secretValueForEnv(app.private_key_env, overlay);
    privateKey = raw ? escapedPem(raw) : null;
  } else if (app.private_key_base64_env) {
    const raw = secretValueForEnv(app.private_key_base64_env, overlay);
    privateKey = raw ? Buffer.from(raw, "base64").toString("utf8") : null;
  } else if (app.private_key_path_env) {
    const path = secretValueForEnv(app.private_key_path_env, overlay);
    privateKey = path ? readFileSync(path, "utf8") : null;
  }
  if (!privateKey || privateKey.trim().length === 0) return null;

  return {
    appId,
    installationId,
    privateKey,
    restUrl: source.rest_url ?? defaultRestUrl(source.kind, source.host),
    label: `github_app:${app.installation_id_env.trim()}`,
    ...(app.name?.trim() ? { name: app.name.trim() } : {}),
  };
}

function patToken(env: string, value: string): AuthToken {
  return { env, value, kind: "pat", strategy: "failover" };
}

// A single GitHub App installation-token mint can fail (revoked installation,
// bad app key, transient token-endpoint 5xx). Skip that bot and keep resolving
// the rest of the pool — including a `bot_then_pat` PAT failover — instead of
// rejecting the whole source. Never logs the private key, only the pool label.
// Returns the failure reason so a pool that ends up with no usable token can
// report it as a hard mint failure (see PoolResolution / hardMintFailure).
function warnMintFailure(label: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  log.warn(`GitHub App token mint failed for ${label}; skipping this bot and continuing: ${reason}`);
  return reason;
}

// A pool's resolved tokens plus whether a configured GitHub App mint threw while
// resolving it. `failureMessage` carries the reason only when a mint failed; a
// pool is a *hard* mint failure (surfaced via hardMintFailure) only when it
// failed AND produced no usable token, which the public methods decide — a
// failure absorbed by an available failover token is benign.
interface PoolResolution {
  tokens: AuthToken[];
  failureMessage: string | null;
}

const EMPTY_RESOLUTION: PoolResolution = { tokens: [], failureMessage: null };

function appToken(token: AuthToken, app: GitHubAppAuthConfig, strategy: AuthTokenStrategy): AuthToken {
  return {
    ...token,
    kind: "github_app",
    ...(app.name?.trim() ? { name: app.name.trim() } : {}),
    strategy,
  };
}

function canonicalPoolStrategy(strategy: AuthTokenStrategy | undefined): AuthTokenStrategy {
  if (strategy === "round_robin") return "budget_aware";
  return strategy ?? "budget_aware";
}

class DefaultAuthTokenResolver implements AuthTokenResolver {
  private readonly mint: MintGitHubAppInstallationToken;
  private readonly poolCache = new WeakMap<object, Promise<PoolResolution>>();
  // source_id -> reason of a hard mint failure recorded while resolving that
  // source's tokens (see hardMintFailure). Populated by the public methods, not
  // the cached pool resolutions, so it is not poisoned by the WeakMap cache.
  private readonly hardMintFailures = new Map<string, string>();

  constructor(deps: AuthTokenResolverDeps) {
    this.mint = deps.mintGitHubAppInstallationToken ?? mintGitHubAppInstallationToken;
  }

  async tokensForSource(source: SourceConfig): Promise<AuthToken[]> {
    if (source.auth_policy) return this.recordHardFailure(source, await this.tokensForPolicy(source, source.auth_policy));
    return this.recordHardFailure(source, await this.tokensForPool(source, source));
  }

  async tokensForProject(source: SourceConfig, projectPath: string): Promise<AuthToken[]> {
    const entry = projectEntryForPath(source, projectPath);
    const policy = typeof entry === "string" ? undefined : entry?.auth_policy;
    if (policy) {
      if (policy.mode === "inherit") return this.tokensForSource(source);
      return this.recordHardFailure(source, await this.tokensForPolicy(source, policy));
    }
    const poolName = typeof entry === "string" ? undefined : entry?.token_pool;
    if (!poolName) return this.tokensForSource(source);
    const pool = source.token_pools?.[poolName];
    if (!pool) return this.tokensForSource(source);
    const resolution = await this.tokensForPool(source, pool);
    if (resolution.tokens.length > 0) return resolution.tokens;
    // The repo is routed through this pool but it yielded no token. If a
    // configured GitHub App mint hard-failed, do NOT silently fall back to the
    // source PAT — that would fetch the repo with credentials outside its
    // selected pool. Record the hard failure so the caller surfaces an error.
    // A pool that is merely empty (unset env, no mint attempted) keeps the
    // existing source fallback.
    if (resolution.failureMessage) return this.recordHardFailure(source, resolution);
    return this.tokensForSource(source);
  }

  async resolveSourceTokens(source: SourceConfig): Promise<AuthToken[]> {
    const seen = new Set<string>();
    const out: AuthToken[] = [];
    const add = (tokens: AuthToken[]): void => {
      for (const token of tokens) {
        const key = token.env;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(token);
      }
    };
    add(await this.tokensForSource(source));
    for (const pool of Object.values(source.token_pools ?? {})) {
      add((await this.tokensForPool(source, pool)).tokens);
    }
    for (const pool of Object.values(source.auth_pools ?? {})) {
      add((await this.tokensForAuthPool(source, pool)).tokens);
    }
    return out;
  }

  hardMintFailure(source: SourceConfig): string | null {
    return this.hardMintFailures.get(source.source_id) ?? null;
  }

  // A pool/source resolution is a *hard* mint failure only when a mint threw and
  // nothing usable was produced (no failover token absorbed it). Records it for
  // hardMintFailure and returns the (empty) token list either way.
  private recordHardFailure(source: SourceConfig, resolution: PoolResolution): AuthToken[] {
    if (resolution.tokens.length === 0 && resolution.failureMessage) {
      this.hardMintFailures.set(source.source_id, resolution.failureMessage);
    }
    return resolution.tokens;
  }

  private async tokensForPolicy(source: SourceConfig, policy: AuthPolicyConfig): Promise<PoolResolution> {
    if (policy.mode === "inherit") return { tokens: await this.tokensForSource(source), failureMessage: null };
    const out: AuthToken[] = [];
    let failureMessage: string | null = null;
    if (policy.mode === "bot" || policy.mode === "bot_then_pat") {
      const bot = await this.tokensForNamedAuthPool(source, policy.bot_pool, "github_app");
      out.push(...bot.tokens);
      failureMessage ??= bot.failureMessage;
    }
    if (policy.mode === "pat" || policy.mode === "bot_then_pat") {
      const pat = await this.tokensForNamedAuthPool(source, policy.pat_pool, "pat");
      out.push(...pat.tokens);
      failureMessage ??= pat.failureMessage;
    }
    return { tokens: out, failureMessage };
  }

  private async tokensForNamedAuthPool(source: SourceConfig, poolName: string | undefined, kind: AuthPoolConfig["kind"]): Promise<PoolResolution> {
    if (!poolName) return EMPTY_RESOLUTION;
    const pool = source.auth_pools?.[poolName];
    if (!pool || pool.kind !== kind) return EMPTY_RESOLUTION;
    return this.tokensForAuthPool(source, pool);
  }

  private tokensForPool(source: SourceConfig, pool: TokenPoolConfig): Promise<PoolResolution> {
    const cached = this.poolCache.get(pool);
    if (cached) return cached;
    const promise = this.resolvePool(source, pool);
    this.poolCache.set(pool, promise);
    return promise;
  }

  private tokensForAuthPool(source: SourceConfig, pool: AuthPoolConfig): Promise<PoolResolution> {
    const cached = this.poolCache.get(pool);
    if (cached) return cached;
    const promise = this.resolveAuthPool(source, pool);
    this.poolCache.set(pool, promise);
    return promise;
  }

  private async resolvePool(source: SourceConfig, pool: TokenPoolConfig): Promise<PoolResolution> {
    const overlay = readSecretsOverlay(resolveSecretsPath());
    const out: AuthToken[] = [];
    let failureMessage: string | null = null;

    if (source.kind === "github" && pool.github_app) {
      const request = githubAppTokenRequest(source, pool.github_app, overlay);
      if (request) {
        try {
          out.push(appToken(await this.mint({ ...request, strategy: "failover" }), pool.github_app, "failover"));
        } catch (err) {
          failureMessage = warnMintFailure(request.label, err);
        }
      }
    }

    for (const rawEnvName of tokenEnvNamesFromPool(pool)) {
      const env = rawEnvName.trim();
      const value = secretValueForEnv(env, overlay);
      if (value) out.push(patToken(env, value));
    }
    return { tokens: out, failureMessage };
  }

  private async resolveAuthPool(source: SourceConfig, pool: AuthPoolConfig): Promise<PoolResolution> {
    const overlay = readSecretsOverlay(resolveSecretsPath());
    const out: AuthToken[] = [];
    if (pool.kind === "pat") {
      for (const rawEnvName of tokenEnvNamesFromPool(pool)) {
        const env = rawEnvName.trim();
        const value = secretValueForEnv(env, overlay);
        if (value) out.push(patToken(env, value));
      }
      return { tokens: out, failureMessage: null };
    }

    if (source.kind !== "github") return { tokens: out, failureMessage: null };
    const strategy = canonicalPoolStrategy(pool.strategy);
    let failureMessage: string | null = null;
    for (const app of pool.apps) {
      const request = githubAppTokenRequest(source, app, overlay);
      if (!request) continue;
      try {
        out.push(appToken(await this.mint({ ...request, strategy }), app, strategy));
      } catch (err) {
        failureMessage = warnMintFailure(request.label, err);
      }
    }
    return { tokens: out, failureMessage };
  }
}

export function createAuthTokenResolver(deps: AuthTokenResolverDeps = {}): AuthTokenResolver {
  return new DefaultAuthTokenResolver(deps);
}
