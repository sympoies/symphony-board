import type { AppConfig, ProjectConfig, SourceConfig, TokenPoolConfig } from "../config.ts";
import { makeGqlClient, type GqlClient } from "../sources/graphql.ts";
import type { AuthToken } from "../sources/http.ts";

const VALIDATION_TIMEOUT_MS = 10_000;

const GITHUB_TOKEN_VALIDATION_QUERY = `
query SymphonyBoardTokenValidation($owner: String!, $name: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) { id nameWithOwner }
}
`;

const GITLAB_TOKEN_VALIDATION_QUERY = `
query SymphonyBoardTokenValidation($fullPath: ID!) {
  currentUser { username }
  project(fullPath: $fullPath) { id fullPath }
}
`;

export interface TokenValidationRequest {
  source_id: string;
  env: string;
  value: string;
}

export interface TokenValidationResult {
  ok: boolean;
  source_id: string;
  env: string;
  provider: string;
  account?: string;
  project_path?: string;
  error?: "bad_request" | "invalid_token" | "unsupported_provider";
  message?: string;
}

export type TokenValidationClientFactory = (url: string, token: AuthToken, provider: "github" | "gitlab") => GqlClient;
export type TokenValidator = (cfg: AppConfig, request: TokenValidationRequest) => Promise<TokenValidationResult>;

const defaultClientFactory: TokenValidationClientFactory = (url, token, provider) =>
  makeGqlClient(url, [token], { provider, timeoutMs: VALIDATION_TIMEOUT_MS });

function tokenEnvNamesFromPool(pool: Pick<TokenPoolConfig, "token_env" | "fallback_token_envs"> | undefined): string[] {
  if (!pool) return [];
  return [pool.token_env, ...(pool.fallback_token_envs ?? [])].filter((env): env is string => typeof env === "string" && env.trim().length > 0);
}

function patEnvNames(source: SourceConfig): string[] {
  const out: string[] = [];
  const push = (env: string): void => {
    const trimmed = env.trim();
    if (trimmed.length > 0 && !out.includes(trimmed)) out.push(trimmed);
  };
  for (const env of tokenEnvNamesFromPool(source)) push(env);
  for (const pool of Object.values(source.token_pools ?? {})) {
    for (const env of tokenEnvNamesFromPool(pool)) push(env);
  }
  for (const pool of Object.values(source.auth_pools ?? {})) {
    if (pool.kind !== "pat") continue;
    for (const env of tokenEnvNamesFromPool(pool)) push(env);
  }
  return out;
}

function projectPath(entry: ProjectConfig): string {
  return typeof entry === "string" ? entry : entry.path;
}

function firstProject(source: SourceConfig): string | null {
  const first = source.projects[0];
  if (!first) return null;
  const path = projectPath(first).trim();
  return path.length > 0 ? path : null;
}

function bad(sourceId: string, env: string, provider: string, message: string): TokenValidationResult {
  return { ok: false, source_id: sourceId, env, provider, error: "bad_request", message };
}

function invalid(source: SourceConfig, env: string, projectPath: string, message: string): TokenValidationResult {
  return {
    ok: false,
    source_id: source.source_id,
    env,
    provider: source.kind,
    project_path: projectPath,
    error: "invalid_token",
    message,
  };
}

function githubOwnerRepo(projectPath: string): { owner: string; name: string } | null {
  const parts = projectPath.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], name: parts[1] };
}

interface GitHubValidationData {
  viewer?: { login?: string | null } | null;
  repository?: { id?: string | null; nameWithOwner?: string | null } | null;
}

interface GitLabValidationData {
  currentUser?: { username?: string | null } | null;
  project?: { id?: string | null; fullPath?: string | null } | null;
}

export async function validateProviderToken(
  cfg: AppConfig,
  request: TokenValidationRequest,
  opts: { clientFactory?: TokenValidationClientFactory } = {},
): Promise<TokenValidationResult> {
  const sourceId = request.source_id.trim();
  const env = request.env.trim();
  const value = request.value.trim();
  const source = cfg.sources.find((candidate) => candidate.source_id === sourceId);
  if (!source) return bad(sourceId, env, "unknown", `unknown source_id: ${sourceId}`);
  if (env.length === 0) return bad(sourceId, env, source.kind, "env must be a non-empty env-var name");
  if (value.length === 0) return bad(sourceId, env, source.kind, "value must be a non-empty token");
  if (!patEnvNames(source).includes(env)) {
    return bad(sourceId, env, source.kind, `env ${env} is not configured as a PAT env on ${sourceId}`);
  }
  if (source.kind !== "github" && source.kind !== "gitlab") {
    return { ok: false, source_id: sourceId, env, provider: source.kind, error: "unsupported_provider", message: `unsupported provider: ${source.kind}` };
  }
  const project = firstProject(source);
  if (!project) return bad(sourceId, env, source.kind, `source ${sourceId} has no repo/project to validate against`);

  const clientFactory = opts.clientFactory ?? defaultClientFactory;
  const token: AuthToken = { env, value, kind: "pat" };
  const gql = clientFactory(source.graphql_url, token, source.kind);

  try {
    if (source.kind === "github") {
      const ownerRepo = githubOwnerRepo(project);
      if (!ownerRepo) return bad(sourceId, env, source.kind, `GitHub project path must be owner/repo: ${project}`);
      const data = await gql<GitHubValidationData>(GITHUB_TOKEN_VALIDATION_QUERY, ownerRepo);
      if (!data.repository?.id) return invalid(source, env, project, `token could not read ${project}`);
      const account = data.viewer?.login?.trim();
      return {
        ok: true,
        source_id: sourceId,
        env,
        provider: "github",
        ...(account ? { account } : {}),
        project_path: data.repository.nameWithOwner?.trim() || project,
      };
    }

    const data = await gql<GitLabValidationData>(GITLAB_TOKEN_VALIDATION_QUERY, { fullPath: project });
    if (!data.project?.id) return invalid(source, env, project, `token could not read ${project}`);
    const account = data.currentUser?.username?.trim();
    return {
      ok: true,
      source_id: sourceId,
      env,
      provider: "gitlab",
      ...(account ? { account } : {}),
      project_path: data.project.fullPath?.trim() || project,
    };
  } catch (err) {
    return invalid(source, env, project, (err as Error).message);
  }
}
