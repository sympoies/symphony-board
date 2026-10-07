import { EntityLink } from "./ExternalLink.tsx";
import { NavigationLink } from "./ExternalLink.tsx";
import type { ActivityDTO } from "@symphony-board/contract";
import { memo, useMemo } from "react";
import { pluralize, relativeTime, spanLabel, type ChangeRequestView, type ResolvedChangeRequest } from "../model.ts";
import { COMMITS_PANES_RANK_LIMIT } from "../layout-tier.ts";
import { changeRequestGroups, shortRepoLabel, type ChangeRequestGroup } from "../rail-stats.ts";

// The change requests (PRs / MRs) the range's commits belong to, and a way
// into each.
//
// A commit log answers "what changed" one commit at a time, and a reviewed
// change is usually several commits, or one squash that stands for a dozen.
// This pane regroups the same rows by the unit the work was reviewed and
// landed in: how many of the range's commits each change request accounts
// for, how many lines, and -- once it merged -- how long it was open.
//
// It reads `details.change_request` (contract 4.8.2) off the rows the list
// renders, and resolves each ref against the loaded items for a title and a
// state. An item outside the loaded window still gets its row: the number and
// the commit facts are known, and nothing about its state is made up.
//
// Like Largest commits beside it, it is a list that takes spare height as
// more rows and scrolls inside its pane.

export type ResolveChangeRequest = (group: ChangeRequestGroup) => ResolvedChangeRequest;

function stateLine(view: ChangeRequestView): string {
  if (view.state === "merged") {
    const took = spanLabel(view.createdAt, view.mergedAt);
    return `merged ${relativeTime(view.mergedAt)}${took ? ` · open ${took}` : ""}`;
  }
  if (view.state === "open") return view.draft ? "draft" : "open";
  if (view.state === "closed") return "closed";
  return "not in the loaded window";
}

// Memoized for the same reason as the charts beside it: its props are the rows
// and a resolver built from the item index, neither of which changes when a
// commit is selected.
export const ChangeRequests = memo(function ChangeRequests({
  commits,
  resolve,
}: {
  commits: ActivityDTO[];
  resolve: ResolveChangeRequest;
}) {
  const groups = useMemo(() => changeRequestGroups(commits), [commits]);
  const rows = useMemo(() => groups.slice(0, COMMITS_PANES_RANK_LIMIT).map((group) => ({ group, ...resolve(group) })), [groups, resolve]);
  // Counted over every group, not only the rows drawn.
  const merged = useMemo(() => groups.reduce((n, group) => (resolve(group).view.state === "merged" ? n + 1 : n), 0), [groups, resolve]);

  return (
    <div className="rail-block pane-fill change-requests">
      <div className="rail-block-head">
        <span className="rail-block-title">Change requests</span>
        <span className="rail-block-meta">
          {groups.length > 0 ? `${groups.length.toLocaleString("en-US")} with commits in range · ${merged.toLocaleString("en-US")} merged` : "with commits in range"}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="pane-empty">no commit in range names a change request</div>
      ) : (
        <ol className="pane-rows pane-scroll" aria-label="Change requests with commits in the selected range">
          {rows.map(({ group, view, href, external }) => {
            const body = (
              <>
                <span className="pane-row-main">
                  <b><NavigationLink href={href}
                    {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                    <span className="pane-row-cr-number">{view.label}</span>
                    {view.title ? ` ${view.title}` : ""}
                  </NavigationLink><EntityLink sourceId={group.sourceId} entity={{ kind: "change_request", projectPath: group.projectPath, iid: view.iid, url: view.url }} aria-label={`Open ${view.label} on provider`}> ↗</EntityLink></b>
                  <small>
                    {group.projectPath ? <><EntityLink sourceId={group.sourceId} entity={{ kind: "repo", projectPath: group.projectPath }}>{shortRepoLabel(group.projectPath)}</EntityLink> · </> : ""}
                    {`${group.commits.toLocaleString("en-US")} ${pluralize(group.commits, "commit")} · ${stateLine(view)}`}
                  </small>
                </span>
                {group.counted > 0 ? (
                  <span className="commit-diffstat">
                    <span className="commit-diffstat-add">+{group.additions.toLocaleString("en-US")}</span>
                    <span className="commit-diffstat-del">-{group.deletions.toLocaleString("en-US")}</span>
                  </span>
                ) : (
                  <span />
                )}
              </>
            );
            return (
              <li key={group.ref}>
                <div className="pane-row pane-row-cr" data-state={view.state ?? "unknown"}>{body}</div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
});
