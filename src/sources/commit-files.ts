// Per-commit changed files: the provider reads, and what a sync stores of them.
//
// Two callers share the readers. GET /api/commit-files (src/server/
// commit-files.ts) reads ONE commit a viewer opened and caches the answer in
// memory. The sync engine's file pass reads a bounded batch of commits the
// store has no answer for and keeps the answers, so a range of commits can be
// aggregated. Both need the same two provider calls, and neither provider has
// a batch form of them: GitHub's GraphQL commit exposes no file list, and
// GitLab serves a raw unified diff per commit.
//
// Only path, status and line counts leave this module. The patch text both
// providers return is counted (GitLab) or ignored (GitHub) here and never
// reaches a raw payload, the store, or the contract.

import { createHash } from "node:crypto";
import type { CanonicalCommitFile, CanonicalCommitFiles, CommitFileStatus, CommitFilesState, NormalizedBundle } from "../model/types.ts";
import { mapWithConcurrency } from "../lib/concurrency.ts";
import { log } from "../log.ts";
import type { RestClient } from "./rest.ts";
import type { CommitFilesCandidate, CommitFilesFetchResult, RawRecord } from "./types.ts";

// GitHub serves at most 300 files on the single-commit response; GitLab's diff
// endpoint is paged. Both are reported as `truncated` rather than silently
// short, so a consumer can say the list is partial instead of implying a small
// commit.
const GITHUB_FILE_LIMIT = 300;
const GITLAB_DIFF_PAGE = 100;

export const COMMIT_FILES_ENTITY = "commit_files";

export interface CommitFilesRead {
  files: CanonicalCommitFile[];
  total: { additions: number; deletions: number };
  // What `total` covers. GitHub reports the whole commit even when its file
  // list is capped; GitLab has no commit-level total, so the sum of the listed
  // files is all there is.
  total_scope: "commit" | "listed";
  // The provider capped the file list, so `files` is a prefix of the real change.
  truncated: boolean;
  // More than one parent, when the response says (GitHub). A merge's diff is
  // against its first parent, so its files are the merged branch's work again.
  // Null where the response cannot say (GitLab's diff endpoint).
  merge: boolean | null;
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

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function count(value: unknown): number {
  return isCount(value) ? value : 0;
}

function sumFiles(files: CanonicalCommitFile[]): { additions: number; deletions: number } {
  return files.reduce(
    (acc, file) => ({ additions: acc.additions + file.additions, deletions: acc.deletions + file.deletions }),
    { additions: 0, deletions: 0 },
  );
}

// Null when `projectPath` is not an owner/name repository: there is no request
// to send, and the caller decides what that means to its own consumer.
export async function githubCommitFiles(rest: RestClient, projectPath: string, sha: string): Promise<CommitFilesRead | null> {
  const repo = githubOwnerRepo(projectPath);
  if (!repo) return null;
  const commit = await rest<any>(`repos/${repo.owner}/${repo.name}/commits/${sha}`);
  const raw: any[] = Array.isArray(commit?.files) ? commit.files : [];
  const files = raw.map((file): CanonicalCommitFile => ({
    // A rename reports both paths; the new one is what the viewer is looking at.
    path: String(file?.filename ?? file?.previous_filename ?? ""),
    status: githubStatus(file?.status),
    additions: count(file?.additions),
    deletions: count(file?.deletions),
  })).filter((file) => file.path.length > 0);
  // `stats` covers the WHOLE commit even when the file list was capped, which
  // is why `total_scope` has to travel with it.
  const stats = commit?.stats;
  const hasCommitTotal = typeof stats?.additions === "number" && typeof stats?.deletions === "number";
  return {
    files,
    total: hasCommitTotal ? { additions: count(stats.additions), deletions: count(stats.deletions) } : sumFiles(files),
    total_scope: hasCommitTotal ? "commit" : "listed",
    truncated: raw.length >= GITHUB_FILE_LIMIT,
    merge: Array.isArray(commit?.parents) ? commit.parents.length > 1 : null,
  };
}

// GitLab returns a raw unified diff per file and no per-file counts, so the
// counts come from the hunk lines.
//
// Counting is HUNK-SCOPED, not prefix-scoped. Skipping every line that starts
// with `---`/`+++` would also drop content: a removed markdown rule (`---`)
// arrives as `----` and an added one as `+---`, both of which start with a file
// header's prefix. Only lines after a `@@` hunk header are content, so that is
// what the state below tracks.
//
// It also walks the string by newline INDEX rather than `split("\n")`: this is
// the one place the writer daemon handles a raw patch, which can be megabytes
// for a vendored or generated file, and the split form allocates an array of
// every line in it just to throw them away.
export function countDiffLines(diff: unknown): { additions: number; deletions: number } {
  if (typeof diff !== "string" || diff.length === 0) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  let start = 0;
  while (start <= diff.length) {
    const nl = diff.indexOf("\n", start);
    const end = nl === -1 ? diff.length : nl;
    if (end > start) {
      const head = diff.charCodeAt(start);
      if (!inHunk) {
        // 0x40 === "@": the hunk header is the only thing that opens content.
        if (head === 0x40 && diff.startsWith("@@", start)) inHunk = true;
      } else if (head === 0x40 && diff.startsWith("@@", start)) {
        // The next hunk of the same file.
      } else if (head === 0x2b) {
        additions++; // "+"
      } else if (head === 0x2d) {
        deletions++; // "-"
      }
    }
    if (nl === -1) break;
    start = nl + 1;
  }
  return { additions, deletions };
}

function gitlabStatus(entry: any): CommitFileStatus {
  if (entry?.new_file === true) return "added";
  if (entry?.deleted_file === true) return "removed";
  if (entry?.renamed_file === true) return "renamed";
  return "modified";
}

export async function gitlabCommitFiles(rest: RestClient, projectPath: string, sha: string): Promise<CommitFilesRead> {
  // GitLab accepts a URL-encoded full path as the project :id, so this needs no
  // extra lookup call for the numeric id.
  const entries = await rest<any[]>(`projects/${encodeURIComponent(projectPath)}/repository/commits/${sha}/diff`, {
    per_page: GITLAB_DIFF_PAGE,
  });
  const raw = Array.isArray(entries) ? entries : [];
  const files = raw.map((entry): CanonicalCommitFile => {
    const counts = countDiffLines(entry?.diff);
    return {
      path: String(entry?.new_path ?? entry?.old_path ?? ""),
      status: gitlabStatus(entry),
      additions: counts.additions,
      deletions: counts.deletions,
    };
  }).filter((file) => file.path.length > 0);
  // This feed carries no commit-level total, so the sum of what is listed is
  // all there is — and under `truncated` that is exactly what `listed` says.
  return { files, total: sumFiles(files), total_scope: "listed", truncated: raw.length >= GITLAB_DIFF_PAGE, merge: null };
}

// ---- the sync side ----------------------------------------------------------

// The sha reaches the provider inside a URL path, so only a FULL plain-hex oid
// is sent (SHA-1 or SHA-256). Both callers of the readers check it.
export const FULL_COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

// A provider answer that says the commit is not there to read: gone from the
// repository (404, GitLab), unresolvable (422, GitHub's "No commit found"), or
// removed (410). It is an ANSWER — the commit leaves the queue.
const GONE_STATUSES = new Set([404, 410, 422]);

// A failure that is about the token, not about the commit asked for: it is
// rejected (401) or rate limited (429, or GitHub's 403 with rate-limit
// headers, which the REST client reports as `rateLimit`). Every further
// request would fail the same way, so the pass stops at once.
function sourceWideFailure(err: unknown): boolean {
  const e = err as { status?: unknown; rateLimit?: unknown } | null;
  return e?.status === 401 || e?.status === 429 || (e?.rateLimit !== null && e?.rateLimit !== undefined);
}

// How many commits may fail, with no commit answered yet, before the pass
// concludes the provider or the network is down and stops asking.
const UNANSWERED_FAILURE_LIMIT = 8;

interface StoredCommitFiles {
  __kind: typeof COMMIT_FILES_ENTITY;
  // The commit ACTIVITY's external id — the canonical row's key. It travels in
  // the payload because the raw record has an id of its own (see `record`).
  activity: string;
  project: string;
  sha: string;
  state: CommitFilesState;
  truncated: boolean;
  files: CanonicalCommitFile[];
}

function record(candidate: CommitFilesCandidate, apiVersion: string, now: string, state: CommitFilesState, read: CommitFilesRead | null): RawRecord {
  const payload: StoredCommitFiles = {
    __kind: COMMIT_FILES_ENTITY,
    activity: candidate.externalId,
    project: candidate.projectPath,
    sha: candidate.sha,
    state,
    truncated: state === "ok" && read ? read.truncated : false,
    files: state === "ok" && read ? read.files : [],
  };
  return {
    entityKind: COMMIT_FILES_ENTITY,
    // NOT the commit activity's external id: the raw store keeps one payload
    // per (source, external id) whatever the entity kind, so sharing the id
    // would replace the commit's own raw record with this one.
    externalId: `${COMMIT_FILES_ENTITY}:${candidate.externalId}`,
    apiVersion,
    fetchedAt: now,
    payload,
    contentHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
  };
}

// Read the file lists of `candidates`, one provider call each, and return one
// raw record per commit that got an ANSWER.
//
// `allowed` is the source's configured project list. The token usually reads
// more than the board tracks, so a commit of any other project is answered as
// unavailable without a request — as is one whose sha is not a full oid.
//
// A failed request is one of three things, and the pass cannot tell the last
// two apart from one response:
//   - about the token (rejected or rate limited): the pass stops at once;
//   - about the commit (a diff the provider cannot render, a repository this
//     token may not read): set aside, and the pass goes on;
//   - about the provider or the network being down: same response, but then
//     nothing else is answered either.
// So the commits set aside are answered `unavailable` only when the provider
// answered some OTHER commit in the same pass — otherwise they stay in the
// queue, and the pass gives up after a few of them. Without that, one commit
// that always fails would sit at the head of a newest-first queue and keep
// every older commit of the source from ever being read.
//
// What was read before a stop is kept.
export async function fetchCommitFileRecords(opts: {
  candidates: readonly CommitFilesCandidate[];
  allowed: (projectPath: string) => boolean;
  read: (candidate: CommitFilesCandidate) => Promise<CommitFilesRead | null>;
  apiVersion: string;
  concurrency: number;
  now?: string;
}): Promise<CommitFilesFetchResult> {
  const now = opts.now ?? new Date().toISOString();
  let stopped: string | null = null;
  let answered = 0;
  const failed: Array<{ candidate: CommitFilesCandidate; message: string }> = [];
  const unavailable = (candidate: CommitFilesCandidate): RawRecord => record(candidate, opts.apiVersion, now, "unavailable", null);
  const results = await mapWithConcurrency(opts.candidates, opts.concurrency, async (candidate): Promise<RawRecord | null> => {
    if (!opts.allowed(candidate.projectPath) || !FULL_COMMIT_SHA.test(candidate.sha)) return unavailable(candidate);
    if (stopped !== null) return null;
    try {
      const read = await opts.read(candidate);
      if (read === null) return unavailable(candidate);
      answered++;
      return record(candidate, opts.apiVersion, now, read.merge === true ? "merge" : "ok", read);
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      if (typeof status === "number" && GONE_STATUSES.has(status)) {
        answered++;
        return unavailable(candidate);
      }
      const message = (err as Error).message;
      if (sourceWideFailure(err)) {
        stopped ??= message;
        return null;
      }
      failed.push({ candidate, message });
      if (answered === 0 && failed.length >= UNANSWERED_FAILURE_LIMIT) stopped ??= message;
      return null;
    }
  });
  const records = results.filter((r): r is RawRecord => r !== null);
  if (answered > 0) {
    records.push(...failed.map((f) => unavailable(f.candidate)));
    // An answer is final, so an operator should be able to see when it was
    // reached this way rather than from the provider saying the commit is gone.
    if (failed.length > 0) {
      log.warn(`[source] commit files: ${failed.length} commit(s) failed on their own and are recorded unavailable; first: ${failed[0]!.message}`);
    }
  } else {
    stopped ??= failed[0]?.message ?? null;
  }
  return { records, stopped };
}

const STATES: ReadonlySet<string> = new Set<CommitFilesState>(["ok", "unavailable", "merge"]);
const STATUSES: ReadonlySet<string> = new Set<CommitFileStatus>(["added", "modified", "removed", "renamed"]);

function storedFile(entry: unknown): CanonicalCommitFile | null {
  const file = entry as { path?: unknown; status?: unknown; additions?: unknown; deletions?: unknown } | null;
  if (!file || typeof file !== "object" || typeof file.path !== "string" || file.path.length === 0) return null;
  if (!isCount(file.additions) || !isCount(file.deletions)) return null;
  return {
    path: file.path,
    // An unknown status is a modification: the path and the counts are real.
    status: typeof file.status === "string" && STATUSES.has(file.status) ? (file.status as CommitFileStatus) : "modified",
    additions: file.additions,
    deletions: file.deletions,
  };
}

// Pure: a stored commit-files record -> its canonical row, or null for a
// record that names no commit activity, has no sha, or has an unknown state.
// Shared by every source's normalize.
export function normalizeCommitFiles(sourceId: string, raw: RawRecord): CanonicalCommitFiles | null {
  const p = raw.payload as Partial<StoredCommitFiles> | null;
  if (!p || typeof p !== "object") return null;
  const sha = typeof p.sha === "string" ? p.sha.trim() : "";
  const activity = typeof p.activity === "string" ? p.activity : "";
  if (!activity || !sha || typeof p.state !== "string" || !STATES.has(p.state)) return null;
  const state = p.state as CommitFilesState;
  const files = state === "ok" && Array.isArray(p.files) ? p.files.map(storedFile).filter((f): f is CanonicalCommitFile => f !== null) : [];
  return {
    sourceId,
    externalId: activity,
    projectPath: typeof p.project === "string" && p.project.length > 0 ? p.project : null,
    sha,
    state,
    truncated: state === "ok" && p.truncated === true,
    files,
  };
}

// What a source's normalize returns for a commit-files record: a bundle that
// carries nothing but the file list.
export function commitFilesBundle(sourceId: string, raw: RawRecord): NormalizedBundle | null {
  const files = normalizeCommitFiles(sourceId, raw);
  return files ? { item: null, labels: [], edges: [], activities: [], commitFiles: [files] } : null;
}
