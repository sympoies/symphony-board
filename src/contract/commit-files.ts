// The per-repository file aggregate (`commit_file_stats`, contract 4.9.0):
// which files and directories the emitted commits changed most.
//
// It is an AGGREGATE on purpose. A commit's file list on every activity row
// would multiply the payload, and the only question a consumer asks of it is
// "what changed most in this window". So the contract carries, per repository,
// the top files and directories with their counts, and — for each — the commits
// that touched it, as short sha prefixes a consumer can match against
// `activities[].details.sha` to narrow a commit list to one path.
//
// Pure: it reads the commit rows a projection emits and the file rows the store
// holds for them. It never sees patch text; the store does not have any.
//
// Coverage is part of the result, not a footnote. File data arrives from a
// bounded pass that catches up over sweeps (src/sync-engine.ts), so at any
// moment some commits have none. `commits` and `scanned` say how much of the
// window the rankings describe.

import type { ActivityDTO, CommitFileStatEntryDTO, CommitFileStatsDTO, RepoCommitFileStatsDTO } from "@symphony-board/contract";
import type { CommitFilesRow } from "../db/store.ts";
import { refOf } from "../model/ref.ts";

// Enough rows for a pane that shows a dozen and lets a consumer re-rank across
// repositories: the top N of a union of per-repository top-N lists is exact.
export const COMMIT_FILE_TOP_FILES = 20;
export const COMMIT_FILE_TOP_DIRS = 12;
// The commits listed per entry, newest first. `commits` is always the full
// count; this only bounds how many of them a consumer can match by sha, which
// is what keeps one hot file in a year-long range from carrying every commit of
// the year.
export const COMMIT_FILE_SHA_LIMIT = 100;
// Long enough to be unambiguous within a repository, short enough to list a
// hundred of per entry.
const SHA_PREFIX = 12;

// The directory a path rolls up to: its first two segments, or fewer when the
// path is shallower, always with a trailing slash so a directory can never be
// mistaken for a file of the same name. A file in the repository root rolls up
// to "./".
export function commitFileDirectory(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const dirs = parts.slice(0, Math.min(2, parts.length - 1));
  return dirs.length > 0 ? `${dirs.join("/")}/` : "./";
}

interface Tally {
  commits: number;
  additions: number;
  deletions: number;
  authors: Set<string>;
  shas: string[];
}

interface RepoTally {
  source_id: string;
  project_path: string;
  commits: number;
  scanned: number;
  truncated: number;
  files: Map<string, Tally>;
  dirs: Map<string, Tally>;
}

interface StoredFile {
  path: string;
  additions: number;
  deletions: number;
}

function storedFiles(json: string): StoredFile[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
  const out: StoredFile[] = [];
  for (const entry of parsed as Array<Partial<StoredFile> | null>) {
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string" || entry.path.length === 0) continue;
    if (!isCount(entry.additions) || !isCount(entry.deletions)) continue;
    out.push({ path: entry.path, additions: entry.additions, deletions: entry.deletions });
  }
  return out;
}

function tallyOf(map: Map<string, Tally>, key: string): Tally {
  let tally = map.get(key);
  if (!tally) {
    tally = { commits: 0, additions: 0, deletions: 0, authors: new Set(), shas: [] };
    map.set(key, tally);
  }
  return tally;
}

function addCommit(tally: Tally, additions: number, deletions: number, author: string | null, sha: string | null): void {
  tally.commits += 1;
  tally.additions += additions;
  tally.deletions += deletions;
  if (author) tally.authors.add(author);
  if (sha && tally.shas.length < COMMIT_FILE_SHA_LIMIT) tally.shas.push(sha);
}

// Most commits first, then most lines changed, then path: a stable order, so
// the emitted list does not reshuffle between two builds of the same data.
function top(map: Map<string, Tally>, limit: number): CommitFileStatEntryDTO[] {
  return [...map.entries()]
    .sort(([pathA, a], [pathB, b]) => b.commits - a.commits || b.additions + b.deletions - (a.additions + a.deletions) || (pathA < pathB ? -1 : pathA > pathB ? 1 : 0))
    .slice(0, limit)
    .map(([path, tally]) => ({
      path,
      commits: tally.commits,
      additions: tally.additions,
      deletions: tally.deletions,
      authors: tally.authors.size,
      shas: tally.shas,
    }));
}

// `activities` is the projection's emitted feed, newest first, which is the
// order each entry's `shas` come out in. `actorKeys` maps an activity ref to
// its persisted actor identity, so two spellings of one person count once.
//
// A merge commit is left out entirely, whatever the store holds for it: its
// diff is against the first parent, so its files are the merged branch's work a
// second time. File rows whose commit is not in `activities` are ignored.
export function buildCommitFileStats(
  activities: readonly ActivityDTO[],
  actorKeys: ReadonlyMap<string, string | null>,
  rows: readonly CommitFilesRow[],
): CommitFileStatsDTO {
  const rowsByRef = new Map<string, CommitFilesRow>();
  for (const row of rows) if (row.state === "ok") rowsByRef.set(refOf(row.source_id, row.external_id), row);

  // One path recurs across many commits, and splitting it is the hot step of a
  // year-long range, so each distinct path is rolled up once.
  const dirByPath = new Map<string, string>();
  const directoryOf = (path: string): string => {
    let dir = dirByPath.get(path);
    if (dir === undefined) {
      dir = commitFileDirectory(path);
      dirByPath.set(path, dir);
    }
    return dir;
  };

  const repos = new Map<string, RepoTally>();
  for (const activity of activities) {
    if (activity.kind !== "commit" || !activity.project_path || activity.details?.merge === true) continue;
    const repoKey = refOf(activity.source_id, activity.project_path);
    let repo = repos.get(repoKey);
    if (!repo) {
      repo = { source_id: activity.source_id, project_path: activity.project_path, commits: 0, scanned: 0, truncated: 0, files: new Map(), dirs: new Map() };
      repos.set(repoKey, repo);
    }
    repo.commits += 1;

    const ref = refOf(activity.source_id, activity.external_id);
    const row = rowsByRef.get(ref);
    if (!row) continue;
    repo.scanned += 1;
    if (row.truncated) repo.truncated += 1;

    const author = actorKeys.get(ref) ?? (activity.actor?.trim() || null);
    const fullSha = typeof activity.details?.sha === "string" ? activity.details.sha : row.sha;
    const sha = fullSha ? fullSha.slice(0, SHA_PREFIX) : null;
    // A directory counts a commit once, however many of its files it touched.
    const dirTotals = new Map<string, { additions: number; deletions: number }>();
    const seen = new Set<string>();
    for (const file of storedFiles(row.files)) {
      // A path listed twice in one commit is one touch of that file.
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      addCommit(tallyOf(repo.files, file.path), file.additions, file.deletions, author, sha);
      const dir = directoryOf(file.path);
      const totals = dirTotals.get(dir) ?? { additions: 0, deletions: 0 };
      totals.additions += file.additions;
      totals.deletions += file.deletions;
      dirTotals.set(dir, totals);
    }
    for (const [dir, totals] of dirTotals) addCommit(tallyOf(repo.dirs, dir), totals.additions, totals.deletions, author, sha);
  }

  const out: RepoCommitFileStatsDTO[] = [...repos.values()]
    .sort((a, b) => a.source_id.localeCompare(b.source_id) || a.project_path.localeCompare(b.project_path))
    .map((repo) => ({
      source_id: repo.source_id,
      project_path: repo.project_path,
      commits: repo.commits,
      scanned: repo.scanned,
      truncated: repo.truncated,
      files: repo.files.size,
      top_files: top(repo.files, COMMIT_FILE_TOP_FILES),
      top_dirs: top(repo.dirs, COMMIT_FILE_TOP_DIRS),
    }));
  return { repos: out };
}
