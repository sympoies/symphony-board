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
function warnMintFailure(label: string, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  log.warn(`GitHub App token mint failed for ${label}; skipping this bot and continuing: ${reason}`);
}

function appToken(token: AuthToken, app: GitHubAppAuthConfig, strategy: AuthTokenStrategy): AuthToken {
  return {
    ...token,
    kind: "github_app",
    ...(app.name?.trim() ? { name: app.name.trim() } : {}),
    strategy,
  };
}

class DefaultAuthTokenResolver implements AuthTokenResolver {
  private readonly mint: MintGitHubAppInstallationToken;
  private readonly poolCache = new WeakMap<object, Promise<AuthToken[]>>();

  constructor(deps: AuthTokenResolverDeps) {
    this.mint = deps.mintGitHubAppInstallationToken ?? mintGitHubAppInstallationToken;
  }

  tokensForSource(source: SourceConfig): Promise<AuthToken[]> {
    if (source.auth_policy) return this.tokensForPolicy(source, source.auth_policy);
    return this.tokensForPool(source, source);
  }

  async tokensForProject(source: SourceConfig, projectPath: string): Promise<AuthToken[]> {
    const entry = projectEntryForPath(source, projectPath);
    const policy = typeof entry === "string" ? undefined : entry?.auth_policy;
    if (policy) {
      if (policy.mode === "inherit") return this.tokensForSource(source);
      return this.tokensForPolicy(source, policy);
    }
    const poolName = typeof entry === "string" ? undefined : entry?.token_pool;
    if (!poolName) return this.tokensForSource(source);
    const pool = source.token_pools?.[poolName];
    const poolTokens = pool ? await this.tokensForPool(source, pool) : [];
    return poolTokens.length > 0 ? poolTokens : this.tokensForSource(source);
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
      add(await this.tokensForPool(source, pool));
    }
    for (const pool of Object.values(source.auth_pools ?? {})) {
      add(await this.tokensForAuthPool(source, pool));
    }
    return out;
  }

  private async tokensForPolicy(source: SourceConfig, policy: AuthPolicyConfig): Promise<AuthToken[]> {
    if (policy.mode === "inherit") return this.tokensForSource(source);
    const out: AuthToken[] = [];
    if (policy.mode === "bot" || policy.mode === "bot_then_pat") {
      out.push(...await this.tokensForNamedAuthPool(source, policy.bot_pool, "github_app"));
    }
    if (policy.mode === "pat" || policy.mode === "bot_then_pat") {
      out.push(...await this.tokensForNamedAuthPool(source, policy.pat_pool, "pat"));
    }
    return out;
  }

  private async tokensForNamedAuthPool(source: SourceConfig, poolName: string | undefined, kind: AuthPoolConfig["kind"]): Promise<AuthToken[]> {
    if (!poolName) return [];
    const pool = source.auth_pools?.[poolName];
    if (!pool || pool.kind !== kind) return [];
    return this.tokensForAuthPool(source, pool);
  }

  private tokensForPool(source: SourceConfig, pool: TokenPoolConfig): Promise<AuthToken[]> {
    const cached = this.poolCache.get(pool);
    if (cached) return cached;
    const promise = this.resolvePool(source, pool);
    this.poolCache.set(pool, promise);
    return promise;
  }

  private tokensForAuthPool(source: SourceConfig, pool: AuthPoolConfig): Promise<AuthToken[]> {
    const cached = this.poolCache.get(pool);
    if (cached) return cached;
    const promise = this.resolveAuthPool(source, pool);
    this.poolCache.set(pool, promise);
    return promise;
  }

  private async resolvePool(source: SourceConfig, pool: TokenPoolConfig): Promise<AuthToken[]> {
    const overlay = readSecretsOverlay(resolveSecretsPath());
    const out: AuthToken[] = [];

    if (source.kind === "github" && pool.github_app) {
      const request = githubAppTokenRequest(source, pool.github_app, overlay);
      if (request) {
        try {
          out.push(appToken(await this.mint({ ...request, strategy: "failover" }), pool.github_app, "failover"));
        } catch (err) {
          warnMintFailure(request.label, err);
        }
      }
    }

    for (const rawEnvName of tokenEnvNamesFromPool(pool)) {
      const env = rawEnvName.trim();
      const value = secretValueForEnv(env, overlay);
      if (value) out.push(patToken(env, value));
    }
    return out;
  }

  private async resolveAuthPool(source: SourceConfig, pool: AuthPoolConfig): Promise<AuthToken[]> {
    const overlay = readSecretsOverlay(resolveSecretsPath());
    const out: AuthToken[] = [];
    if (pool.kind === "pat") {
      for (const rawEnvName of tokenEnvNamesFromPool(pool)) {
        const env = rawEnvName.trim();
        const value = secretValueForEnv(env, overlay);
        if (value) out.push(patToken(env, value));
      }
      return out;
    }

    if (source.kind !== "github") return out;
    const strategy = pool.strategy ?? "round_robin";
    for (const app of pool.apps) {
      const request = githubAppTokenRequest(source, app, overlay);
      if (!request) continue;
      try {
        out.push(appToken(await this.mint({ ...request, strategy }), app, strategy));
      } catch (err) {
        warnMintFailure(request.label, err);
      }
    }
    return out;
  }
}

export function createAuthTokenResolver(deps: AuthTokenResolverDeps = {}): AuthTokenResolver {
  return new DefaultAuthTokenResolver(deps);
}
