// On-demand per-file diffstat for ONE commit (GET /api/commit-files), served by
// the writer daemon (src/cli/sync-daemon.ts) and the standalone app server —
// never the read-only `api` sidecar, because like /api/token-rate-limits it
// needs config + token resolution + outbound provider access.
//
// WHY THE SWEEP DOES NOT CARRY FILES. The sweep can afford the commit TOTALS
// it already stores: GitHub answers 100 commits in one GraphQL document and
// GitLab inlines them on the list feed. Per-FILE counts have no such batch on
// either provider — GitHub's GraphQL commit exposes no file list at all, so it
// is one REST call per commit, and GitLab only serves a raw unified diff per
// commit. And because an activity upsert replaces `details` wholesale, a sweep
// that skipped the enrichment would also ERASE what an earlier one stored.
//
// So files reach a consumer two other ways. This route reads the ONE commit a
// viewer opened, now, whether or not a sync has reached it; its response is not
// contract data and is cached only in memory. The sync engine's file pass
// (src/sync-engine.ts, readers in src/sources/commit-files.ts) reads a bounded
// batch per sweep into a table of its own, and the contract aggregates those
// rows as `commit_file_stats`. The two share the provider readers and nothing
// else: this route neither reads nor writes what the pass stored.
//
// Provider reads stay read-only (GET), and a request may only name a project
// this deployment already tracks: the configured project list is the allowlist,
// checked on EVERY request before the cache is consulted, so removing a project
// (or disabling a source) takes effect immediately. The one honest limit on
// that guarantee: GitHub resolves a commit within the repository's whole fork
// network, so a caller who already knows such a sha can read paths and counts
// for a commit the tracked repo itself never contained.

import type { ServerResponse } from "node:http";
import type { AppConfig, SourceConfig } from "../config.ts";
import { projectPaths, sourceEnabled } from "../config.ts";
import { createAuthTokenResolver, type AuthTokenResolver } from "../auth.ts";
import { defaultRestUrl, makeRestClient, type RestClient } from "../sources/rest.ts";
import type { AuthToken } from "../sources/http.ts";
import { FULL_COMMIT_SHA, githubCommitFiles, gitlabCommitFiles } from "../sources/commit-files.ts";
import type { CanonicalCommitFile, CommitFileStatus } from "../model/types.ts";

// A viewer is waiting on this, so fail faster than a sweep would.
const REQUEST_TIMEOUT_MS = 15_000;
// A commit's diff is immutable, so a SUCCESS needs no TTL — only a bound.
const CACHE_LIMIT = 200;
// A FAILURE is cached too, briefly, so a scripted caller cannot turn one
// request per distinct sha into one provider call per request. It must expire,
// because the reasons are transient (a cooled-down token, a 502): pinning them
// for the process lifetime would leave the pane stuck on "No file breakdown"
// long after the cause was fixed. Config-derived refusals are never cached at
// all — they are recomputed from config on every request by construction.
const FAILURE_CACHE_MS = 60_000;

// The provider readers are shared with the sync engine's file pass
// (src/sources/commit-files.ts); this module owns the route around them.
export { countDiffLines } from "../sources/commit-files.ts";
export type { CommitFileStatus };
export type CommitFileStat = CanonicalCommitFile;

export interface CommitFilesResult {
  source_id: string;
  project_path: string;
  sha: string;
  files: CommitFileStat[];
  total: { additions: number; deletions: number };
  // What `total` covers. GitHub reports the whole commit even when its file
  // list is capped; GitLab has no commit-level total, so the sum of the listed
  // files is all there is. Without this the same number means two things under
  // `truncated` and no consumer can label it honestly.
  total_scope: "commit" | "listed";
  // The provider capped the file list (GitHub's 300-file response, a full
  // GitLab diff page), so `files` is a prefix of the real change.
  truncated: boolean;
}

export type CommitFilesErrorCode =
  | "bad_request"
  | "unknown_source"
  | "unknown_project"
  | "no_token"
  | "unsupported_provider"
  | "provider_error"
  // The route could not load config at all, so it cannot even say whether the
  // source exists. Emitted by the route, not by resolution — but it is part of
  // this contract, because it reaches the same consumer through the same field.
  | "config_error";

export interface CommitFilesError {
  error: CommitFilesErrorCode;
  message: string;
}

export interface CommitFilesRequest {
  source_id: string;
  project_path: string;
  sha: string;
}

interface CacheEntry {
  value: CommitFilesResult | CommitFilesError;
  // Absent for a success (immutable); set for a cached provider failure.
  expiresAt?: number;
}

export type RestClientFactory = (source: SourceConfig, tokens: AuthToken[]) => RestClient;

export interface CommitFilesDeps {
  restClientFactory?: RestClientFactory;
  authTokenResolver?: AuthTokenResolver;
  cache?: Map<string, CacheEntry>;
  inFlight?: Map<string, Promise<CommitFilesResult | CommitFilesError>>;
  now?: () => number;
}

// The sha reaches the provider inside a URL path, so only plain hex is
// accepted. FULL length only (SHA-1 or SHA-256): an abbreviation would give one
// commit 30-odd distinct cache keys, each a miss and each a real provider call,
// which is both an amplification lever and a way to evict everything real
// viewers warmed. The UI always sends the full oid (`details.sha`), so nothing
// legitimate asks for less.
const SHA = FULL_COMMIT_SHA;

const defaultRestClientFactory: RestClientFactory = (source, tokens) =>
  makeRestClient(
    source.rest_url ?? defaultRestUrl(source.kind, source.host),
    tokens,
    source.kind === "github" ? "github" : "gitlab",
    REQUEST_TIMEOUT_MS,
  );

const defaultCache = new Map<string, CacheEntry>();
const defaultInFlight = new Map<string, Promise<CommitFilesResult | CommitFilesError>>();

function cacheKey(req: CommitFilesRequest): string {
  return `${req.source_id}\u0000${req.project_path}\u0000${req.sha.toLowerCase()}`;
}

function remember(cache: Map<string, CacheEntry>, key: string, entry: CacheEntry): void {
  cache.set(key, entry);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function fail(error: CommitFilesErrorCode, message: string): CommitFilesError {
  return { error, message };
}

// The route's config-load failure, owned here so the error union stays the one
// source of truth for what a caller can receive (the /api/token-rate-limits
// pattern).
export function commitFilesConfigError(message: string): CommitFilesError {
  return fail("config_error", message);
}

export function parseCommitFilesRequest(url: URL): CommitFilesRequest | CommitFilesError {
  const sourceId = (url.searchParams.get("source_id") ?? "").trim();
  const projectPath = (url.searchParams.get("project_path") ?? "").trim();
  const sha = (url.searchParams.get("sha") ?? "").trim();
  if (!sourceId) return fail("bad_request", "source_id is required");
  if (!projectPath) return fail("bad_request", "project_path is required");
  if (!SHA.test(sha)) return fail("bad_request", "sha must be a full hex commit id (40 or 64 chars)");
  return { source_id: sourceId, project_path: projectPath, sha };
}

export function isCommitFilesError(value: CommitFilesResult | CommitFilesError): value is CommitFilesError {
  return (value as CommitFilesError).error !== undefined;
}

// Config-derived refusals are recomputed per request and must never be cached;
// a provider failure is cached briefly so a loop cannot spend quota 1:1.
function cacheable(result: CommitFilesResult | CommitFilesError): boolean {
  return !isCommitFilesError(result) || result.error === "provider_error";
}

async function resolveCommitFiles(
  source: SourceConfig,
  req: CommitFilesRequest,
  deps: CommitFilesDeps,
): Promise<CommitFilesResult | CommitFilesError> {
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
    if (resolved === null) return fail("bad_request", `project_path "${req.project_path}" is not an owner/name repository`);
    return {
      source_id: req.source_id,
      project_path: req.project_path,
      sha: req.sha,
      files: resolved.files,
      total: resolved.total,
      total_scope: resolved.total_scope,
      truncated: resolved.truncated,
    };
  } catch (err) {
    return fail("provider_error", (err as Error).message);
  }
}

// Resolve one commit's per-file diffstat. Best effort by design: a provider
// failure is reported as an error row the UI renders in place, never an
// exception that takes down the route.
export async function fetchCommitFiles(
  cfg: AppConfig,
  req: CommitFilesRequest,
  deps: CommitFilesDeps = {},
): Promise<CommitFilesResult | CommitFilesError> {
  // Authorization FIRST, cache second. Config is reloaded per request so a
  // removed project or a disabled source stops answering immediately; a cache
  // read above this line would keep serving both until eviction.
  const source = cfg.sources.find((s) => s.source_id === req.source_id);
  if (!source) return fail("unknown_source", `no configured source "${req.source_id}"`);
  if (!sourceEnabled(source)) return fail("unknown_source", `source "${req.source_id}" is disabled`);
  if (!projectPaths(source).includes(req.project_path)) {
    return fail("unknown_project", `project "${req.project_path}" is not configured for source "${req.source_id}"`);
  }
  if (source.kind !== "github" && source.kind !== "gitlab") {
    return fail("unsupported_provider", `source kind "${source.kind}" has no per-file diffstat`);
  }

  const cache = deps.cache ?? defaultCache;
  const inFlight = deps.inFlight ?? defaultInFlight;
  const now = deps.now ?? Date.now;
  const key = cacheKey(req);

  const cached = cache.get(key);
  if (cached && (cached.expiresAt === undefined || cached.expiresAt > now())) return cached.value;
  if (cached) cache.delete(key);

  // Single-flight: two tabs (or a re-open before the first answer lands) share
  // one provider call instead of racing to spend two.
  const pending = inFlight.get(key);
  if (pending) return pending;

  const work = resolveCommitFiles(source, req, deps)
    .then((result) => {
      if (cacheable(result)) {
        remember(cache, key, isCommitFilesError(result) ? { value: result, expiresAt: now() + FAILURE_CACHE_MS } : { value: result });
      }
      return result;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, work);
  return work;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body) + "\n");
}

// Route handler. Every failure answers with its code and message so the detail
// pane can say WHY the breakdown is missing; only a malformed request is a 400.
export async function handleCommitFilesRequest(cfg: AppConfig, url: URL, res: ServerResponse): Promise<void> {
  const parsed = parseCommitFilesRequest(url);
  if (isCommitFilesError(parsed as CommitFilesResult | CommitFilesError)) {
    json(res, 400, parsed);
    return;
  }
  const result = await fetchCommitFiles(cfg, parsed as CommitFilesRequest);
  json(res, isCommitFilesError(result) && result.error === "bad_request" ? 400 : 200, result);
}
