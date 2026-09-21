// On-demand per-file diffstat for ONE commit (GET /api/commit-files), served by
// the writer daemon (src/cli/sync-daemon.ts) and the standalone app server —
// never the read-only `api` sidecar, because like /api/token-rate-limits it
// needs config + token resolution + outbound provider access.
//
// WHY THIS IS A READ-THROUGH AND NOT A SYNC FIELD. The sweep can afford the
// commit TOTALS it already stores: GitHub answers 100 commits in one GraphQL
// document and GitLab inlines them on the list feed. Per-FILE counts have no
// such batch on either provider — GitHub's GraphQL commit exposes no file list
// at all, so it is one REST call per commit, and GitLab only serves a raw
// unified diff per commit. At ~700 commits a week across 25 repos, with a full
// sweep every ~30 iterations, that is a different cost class; and because an
// activity upsert replaces `details` wholesale, any sweep that skipped the
// enrichment would also ERASE what an earlier one stored. Fetching the one
// commit the viewer opened costs exactly one provider call and cannot rot.
//
// The result is therefore NOT contract data: it never enters raw, the canonical
// store, or contract.json, so no contract_version bump — the same boundary
// /api/stats and /api/token-rate-limits sit behind.
//
// Provider reads stay read-only (GET), and a request may only name a project
// this deployment already tracks: the configured project list is the allowlist,
// so the endpoint can never be pointed at an arbitrary repository with the
// deployment's own token.

import type { ServerResponse } from "node:http";
import type { AppConfig, SourceConfig } from "../config.ts";
import { projectPaths, sourceEnabled } from "../config.ts";
import { createAuthTokenResolver, type AuthTokenResolver } from "../auth.ts";
import { defaultRestUrl, makeRestClient, type RestClient } from "../sources/rest.ts";
import type { AuthToken } from "../sources/http.ts";

// A viewer is waiting on this, so fail faster than a sweep would.
const REQUEST_TIMEOUT_MS = 15_000;
// GitHub serves at most 300 files on the single-commit response; GitLab's diff
// endpoint is paged. Both are reported as `truncated` rather than silently
// short, so the UI can say the list is partial instead of implying a small
// commit.
const GITHUB_FILE_LIMIT = 300;
const GITLAB_DIFF_PAGE = 100;
// A commit's diff is immutable, so the cache needs no TTL — only a bound. One
// viewer walking a day of commits stays well inside it, and an eviction costs
// one provider call the next time that commit is opened.
const CACHE_LIMIT = 200;

export type CommitFileStatus = "added" | "modified" | "removed" | "renamed";

export interface CommitFileStat {
  path: string;
  status: CommitFileStatus;
  additions: number;
  deletions: number;
}

export interface CommitFilesResult {
  source_id: string;
  project_path: string;
  sha: string;
  files: CommitFileStat[];
  total: { additions: number; deletions: number };
  // The provider capped the file list (GitHub's 300-file response, a full
  // GitLab diff page). `files` is a prefix of the real change, and `total` then
  // describes only what is listed unless the provider reported its own totals.
  truncated: boolean;
}

export type CommitFilesErrorCode = "bad_request" | "unknown_source" | "unknown_project" | "no_token" | "unsupported_provider" | "provider_error";

export interface CommitFilesError {
  error: CommitFilesErrorCode;
  message: string;
}

export interface CommitFilesRequest {
  source_id: string;
  project_path: string;
  sha: string;
}

interface CommitFilesPayload {
  files: CommitFileStat[];
  total: { additions: number; deletions: number };
  truncated: boolean;
}

export type RestClientFactory = (source: SourceConfig, tokens: AuthToken[]) => RestClient;

export interface CommitFilesDeps {
  restClientFactory?: RestClientFactory;
  authTokenResolver?: AuthTokenResolver;
  cache?: Map<string, CommitFilesResult>;
}

// A sha reaches the provider inside a URL path, so only a plain hex abbreviation
// or full oid is accepted — nothing a caller sends can steer the request
// elsewhere. The lower bound matches git's shortest useful abbreviation.
const SHA = /^[0-9a-f]{7,64}$/i;

const defaultRestClientFactory: RestClientFactory = (source, tokens) =>
  makeRestClient(
    source.rest_url ?? defaultRestUrl(source.kind, source.host),
    tokens,
    source.kind === "github" ? "github" : "gitlab",
    REQUEST_TIMEOUT_MS,
  );

const defaultCache = new Map<string, CommitFilesResult>();

function cacheKey(req: CommitFilesRequest): string {
  return `${req.source_id}\u0000${req.project_path}\u0000${req.sha.toLowerCase()}`;
}

function remember(cache: Map<string, CommitFilesResult>, key: string, result: CommitFilesResult): CommitFilesResult {
  cache.set(key, result);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  return result;
}

function fail(error: CommitFilesErrorCode, message: string): CommitFilesError {
  return { error, message };
}

export function parseCommitFilesRequest(url: URL): CommitFilesRequest | CommitFilesError {
  const sourceId = (url.searchParams.get("source_id") ?? "").trim();
  const projectPath = (url.searchParams.get("project_path") ?? "").trim();
  const sha = (url.searchParams.get("sha") ?? "").trim();
  if (!sourceId) return fail("bad_request", "source_id is required");
  if (!projectPath) return fail("bad_request", "project_path is required");
  if (!SHA.test(sha)) return fail("bad_request", "sha must be a hex commit id (7-64 chars)");
  return { source_id: sourceId, project_path: projectPath, sha };
}

export function isCommitFilesError(value: CommitFilesResult | CommitFilesError): value is CommitFilesError {
  return (value as CommitFilesError).error !== undefined;
}

function githubOwnerRepo(projectPath: string): { owner: string; name: string } | null {
  const parts = projectPath.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  return { owner: parts[0]!, name: parts[1]! };
}

function githubStatus(raw: unknown): CommitFileStatus {
  switch (String(raw ?? "")) {
    case "added":
    case "copied":
      return "added";
    case "removed":
      return "removed";
    case "renamed":
      return "renamed";
    default:
      return "modified";
  }
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function sumFiles(files: CommitFileStat[]): { additions: number; deletions: number } {
  return files.reduce(
    (acc, file) => ({ additions: acc.additions + file.additions, deletions: acc.deletions + file.deletions }),
    { additions: 0, deletions: 0 },
  );
}

async function githubCommitFiles(rest: RestClient, projectPath: string, sha: string): Promise<CommitFilesPayload | CommitFilesError> {
  const repo = githubOwnerRepo(projectPath);
  if (!repo) return fail("bad_request", `project_path "${projectPath}" is not an owner/name repository`);
  const commit = await rest<any>(`repos/${repo.owner}/${repo.name}/commits/${sha}`);
  const raw: any[] = Array.isArray(commit?.files) ? commit.files : [];
  const files = raw.map((file): CommitFileStat => ({
    // A rename reports both paths; the new one is what the viewer is looking at.
    path: String(file?.filename ?? file?.previous_filename ?? ""),
    status: githubStatus(file?.status),
    additions: count(file?.additions),
    deletions: count(file?.deletions),
  })).filter((file) => file.path.length > 0);
  // `stats` covers the WHOLE commit even when the file list was capped, so it is
  // the honest total to show above a truncated list.
  const stats = commit?.stats;
  const total = typeof stats?.additions === "number" && typeof stats?.deletions === "number"
    ? { additions: count(stats.additions), deletions: count(stats.deletions) }
    : sumFiles(files);
  return { files, total, truncated: raw.length >= GITHUB_FILE_LIMIT };
}

// GitLab returns a raw unified diff per file and no per-file counts, so the
// counts come from the hunk lines. `+++`/`---` are the file headers, not content,
// and a `\ No newline at end of file` marker is neither.
export function countDiffLines(diff: unknown): { additions: number; deletions: number } {
  if (typeof diff !== "string" || diff.length === 0) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

function gitlabStatus(entry: any): CommitFileStatus {
  if (entry?.new_file === true) return "added";
  if (entry?.deleted_file === true) return "removed";
  if (entry?.renamed_file === true) return "renamed";
  return "modified";
}

async function gitlabCommitFiles(rest: RestClient, projectPath: string, sha: string): Promise<CommitFilesPayload> {
  // GitLab accepts a URL-encoded full path as the project :id, so this needs no
  // extra lookup call for the numeric id.
  const entries = await rest<any[]>(`projects/${encodeURIComponent(projectPath)}/repository/commits/${sha}/diff`, {
    per_page: GITLAB_DIFF_PAGE,
  });
  const raw = Array.isArray(entries) ? entries : [];
  const files = raw.map((entry): CommitFileStat => {
    const counts = countDiffLines(entry?.diff);
    return {
      path: String(entry?.new_path ?? entry?.old_path ?? ""),
      status: gitlabStatus(entry),
      additions: counts.additions,
      deletions: counts.deletions,
    };
  }).filter((file) => file.path.length > 0);
  return { files, total: sumFiles(files), truncated: raw.length >= GITLAB_DIFF_PAGE };
}

// Resolve one commit's per-file diffstat. Best effort by design: a provider
// failure is reported as an error row the UI renders in place, never an
// exception that takes down the route.
export async function fetchCommitFiles(
  cfg: AppConfig,
  req: CommitFilesRequest,
  deps: CommitFilesDeps = {},
): Promise<CommitFilesResult | CommitFilesError> {
  const cache = deps.cache ?? defaultCache;
  const key = cacheKey(req);
  const cached = cache.get(key);
  if (cached) return cached;

  const source = cfg.sources.find((s) => s.source_id === req.source_id);
  if (!source) return fail("unknown_source", `no configured source "${req.source_id}"`);
  if (!sourceEnabled(source)) return fail("unknown_source", `source "${req.source_id}" is disabled`);
  // The configured project list is the allowlist: without this the endpoint
  // would read any repository the deployment's token can reach.
  if (!projectPaths(source).includes(req.project_path)) {
    return fail("unknown_project", `project "${req.project_path}" is not configured for source "${req.source_id}"`);
  }
  if (source.kind !== "github" && source.kind !== "gitlab") {
    return fail("unsupported_provider", `source kind "${source.kind}" has no per-file diffstat`);
  }

  const authTokenResolver = deps.authTokenResolver ?? createAuthTokenResolver();
  const tokens = source.kind === "github"
    ? await authTokenResolver.tokensForProject(source, req.project_path)
    : await authTokenResolver.tokensForSource(source);
  if (tokens.length === 0) return fail("no_token", `no token is set for source "${req.source_id}"`);

  const rest = (deps.restClientFactory ?? defaultRestClientFactory)(source, tokens);
  try {
    const resolved = source.kind === "github"
      ? await githubCommitFiles(rest, req.project_path, req.sha)
      : await gitlabCommitFiles(rest, req.project_path, req.sha);
    if ("error" in resolved) return resolved;
    const { files, total, truncated } = resolved;
    return remember(cache, key, {
      source_id: req.source_id,
      project_path: req.project_path,
      sha: req.sha,
      files,
      total,
      truncated,
    });
  } catch (err) {
    return fail("provider_error", (err as Error).message);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body) + "\n");
}

// Route handler. Every failure answers with its code and message so the detail
// pane can say WHY the breakdown is missing; only a malformed request is a 400.
export async function handleCommitFilesRequest(
  cfg: AppConfig,
  url: URL,
  res: ServerResponse,
  deps: CommitFilesDeps = {},
): Promise<void> {
  const parsed = parseCommitFilesRequest(url);
  if ("error" in parsed) {
    json(res, 400, parsed);
    return;
  }
  const result = await fetchCommitFiles(cfg, parsed, deps);
  if (isCommitFilesError(result)) {
    json(res, result.error === "bad_request" ? 400 : 200, result);
    return;
  }
  json(res, 200, result);
}
