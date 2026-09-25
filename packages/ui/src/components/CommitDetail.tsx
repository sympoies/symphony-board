import type { ActivityDTO } from "@symphony-board/contract";
import type { CSSProperties } from "react";
import { SourceRepo } from "./SourceRepo.tsx";
import { DiffStat } from "./DiffStat.tsx";
import { safeHref } from "../url.ts";
import { commitBody, commitBranches, commitMessage, commitSha, commitStats, relativeTime, type ColorOf } from "../model.ts";

// The selected commit, inserted before the overview so the original pane moves
// down intact. This is what lets the full commit message be read at all: the
// list row clamps to its title and the `…` expander only ever revealed a
// preview.
//
// Reading order follows `git-scope commit`: what the commit IS (title, then the
// facts — repo, author, time, sha, lines, branch), then the message body. The
// facts sit above the body on purpose; the body is the one part that can run to
// dozens of lines, and burying repo/author under it meant scrolling past a wall
// of text to answer "whose commit, in what repo".
//
// Provider-neutral by the same rule as the list (CommitsPage's header comment):
// message, sha, branches, repo, author, time, line counts and the provider link
// are the whole surface. The test is whether the contract carries the field for
// every provider, not whether one provider has something interesting — so a
// GitHub-only Verified badge or check count still has no place here, while
// `additions`/`deletions` (both providers, absent when unknown) does.
//
// The per-file breakdown is NOT here: it is fetched per shown commit from the
// server's /api/commit-files route and rendered in the rail (see CommitFileList).
// On a phone, the rail becomes a separate file pane with a jump control, so a
// long commit message cannot hide the path to the changed-file list.
export function CommitDetail({
  commit,
  timezone,
  sourceKind,
  colorOf,
  following,
  onFollowLatest,
  onClose,
}: {
  commit: ActivityDTO;
  timezone: string;
  sourceKind: ReadonlyMap<string, string>;
  colorOf: ColorOf;
  following: boolean;
  onFollowLatest: () => void;
  onClose: () => void;
}) {
  const sha = commitSha(commit);
  const branches = commitBranches(commit);
  const body = commitBody(commit);
  const stats = commitStats(commit);
  const href = safeHref(commit.url);
  // Same per-repo accent the list row carries, so the detail reads as the
  // selected row enlarged rather than as an unrelated panel.
  const accentColor = colorOf(commit.source_id, commit.project_path);

  return (
    <aside className="commits-rail commit-detail" aria-label="Selected commit">
      <div
        className={`commit-detail-card${accentColor ? " commit-row-accent" : ""}`}
        style={{ "--repo-color": accentColor ?? undefined } as CSSProperties}
      >
        <div className="commit-detail-toolbar">
          <button type="button" className="commit-detail-back" onClick={onClose}>
            <span className="commit-detail-back-desktop">← back to digest</span>
            <span className="commit-detail-back-mobile">← back to commits</span>
          </button>

          <div className="live-mode">
            {following ? (
              <span className="live-mode-following">
                <span className="live-mode-dot" aria-hidden="true" /> Following latest
              </span>
            ) : (
              <button type="button" className="live-mode-release" onClick={onFollowLatest}>
                Pinned · follow latest
              </button>
            )}
          </div>
        </div>

        {/* The title carries the provider link, the way the list row does
            (CommitsPage `.commit-message-link`): the commit subject IS the
            handle for "this commit over there", so a separate trailing
            "Open on provider" line was a second control for the same target. */}
        <h3 className="commit-detail-title">
          {href ? (
            <a className="commit-detail-title-link" href={href} target="_blank" rel="noreferrer noopener">
              {commitMessage(commit)}
            </a>
          ) : (
            commitMessage(commit)
          )}
        </h3>

        <dl className="commit-detail-meta">
          <div className="commit-detail-row">
            <dt>Repo</dt>
            <dd>
              {commit.project_path ? (
                <SourceRepo kind={sourceKind.get(commit.source_id)} repo={commit.project_path} />
              ) : (
                <span className="muted">unknown</span>
              )}
            </dd>
          </div>
          <div className="commit-detail-row">
            <dt>Author</dt>
            <dd>{commit.actor ? <span className="commit-detail-actor">@{commit.actor}</span> : <span className="muted">unattributed</span>}</dd>
          </div>
          <div className="commit-detail-row">
            <dt>Committed</dt>
            <dd>
              <span title={new Date(commit.occurred_at).toLocaleString("en-US", { timeZone: timezone })}>
                {relativeTime(commit.occurred_at)}
              </span>
            </dd>
          </div>
          {sha ? (
            <div className="commit-detail-row">
              <dt>SHA</dt>
              <dd>
                {/* The FULL hash, not the abbreviation. The list row already
                    shows the short form; this pane is where the complete
                    identifier has to be readable and selectable, so rendering
                    `shortSha ?? sha` here would leave it nowhere on screen. */}
                <code className="commit-detail-sha">{sha}</code>
              </dd>
            </div>
          ) : null}
          {stats ? (
            <div className="commit-detail-row">
              <dt>Lines</dt>
              <dd>
                <DiffStat stats={stats} />
              </dd>
            </div>
          ) : null}
          {branches.length > 0 ? (
            <div className="commit-detail-row">
              <dt>{branches.length === 1 ? "Branch" : "Branches"}</dt>
              <dd className="commit-detail-branches">
                {branches.map((branch) => (
                  <span key={branch} className="chip commit-branch-chip">
                    {branch}
                  </span>
                ))}
              </dd>
            </div>
          ) : null}
        </dl>

        {/* The body is plain commit text, not markdown: rendering it as markdown
            would reflow trailers and wrapped prose that authors aligned by hand. */}
        {body ? <pre className="commit-detail-body">{body}</pre> : null}
      </div>
    </aside>
  );
}
