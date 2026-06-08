import type { ActivityDTO } from "@symphony-board/contract";
import { ActivityFeed } from "./ActivityFeed.tsx";
import type { ColorOf, CommitRepoOption, TimeRange } from "../model.ts";

// A cross-repo commit feed. It is a focused projection of the Activity feed
// (commit records only) whose single filter is repo, picked from a typeahead
// over the repos that actually have commits in the loaded window. Each row's
// title links straight to the provider's commit page (the producer fills the
// commit `url`), so this page is read-only UI over the existing contract — no
// new contract surface. Like every page, it is still scoped by the shared date
// range; repo is the only filter the page itself adds.
const REPO_DATALIST_ID = "commit-repo-options";

export function CommitsPage({
  commits,
  windowTotal,
  totalCommits,
  repoOptions,
  selectedRepo,
  onRepo,
  range,
  sourceKind,
  colorOf,
}: {
  commits: ActivityDTO[];
  windowTotal: number;
  totalCommits: number;
  repoOptions: CommitRepoOption[];
  selectedRepo: string | null;
  onRepo: (repo: string | null) => void;
  range: TimeRange;
  sourceKind: ReadonlyMap<string, string>;
  colorOf: ColorOf;
}) {
  const countLabel =
    commits.length === windowTotal ? `${commits.length} in range` : `${commits.length} of ${windowTotal}`;
  const emptyMessage =
    windowTotal === 0
      ? "No commits in this range."
      : `No commits for ${selectedRepo ?? "this repo"} in this range.`;

  return (
    <main className="commits-page">
      <div className="activity-head">
        <h2>Commits</h2>
        <span className="count">{countLabel}</span>
        <span className="muted">
          {windowTotal} window / {totalCommits} total · {range.from} to {range.to}
        </span>
      </div>
      <div className="commits-filter">
        <input
          className="search"
          type="text"
          list={REPO_DATALIST_ID}
          placeholder="Filter by repo…"
          aria-label="Filter commits by repo"
          value={selectedRepo ?? ""}
          onChange={(e) => onRepo(e.target.value.trim() || null)}
        />
        <datalist id={REPO_DATALIST_ID}>
          {repoOptions.map((o) => (
            <option key={o.project_path} value={o.project_path}>
              {`${o.count} commit${o.count === 1 ? "" : "s"} · ${sourceKind.get(o.source_id) ?? o.source_id}`}
            </option>
          ))}
        </datalist>
        {selectedRepo ? (
          <button type="button" className="filter-clear" onClick={() => onRepo(null)}>
            clear
          </button>
        ) : (
          <span className="muted commits-filter-hint">
            {repoOptions.length} repo{repoOptions.length === 1 ? "" : "s"} with commits
          </span>
        )}
      </div>
      <ActivityFeed activities={commits} sourceKind={sourceKind} colorOf={colorOf} emptyMessage={emptyMessage} />
    </main>
  );
}
