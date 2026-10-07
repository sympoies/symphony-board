import { SelectableEntityRow } from "./ExternalLink.tsx";
import { ActorLink, EntityLink } from "./ExternalLink.tsx";
import { ExternalLink, NavigationLink } from "./ExternalLink.tsx";
import type { ActivityDTO, ItemDTO } from "@symphony-board/contract";
import type { CSSProperties } from "react";
import { Badge } from "./Badge.tsx";
import { SourceRepo } from "./SourceRepo.tsx";
import { DiffStat } from "./DiffStat.tsx";
import { LabelChip } from "./LabelChip.tsx";
import { ActorAvatar } from "./ActorAvatar.tsx";
import { MarkdownBody } from "./MarkdownBody.tsx";
import { ACTION_KIND } from "../activity-action-style.ts";
import { safeHref } from "../url.ts";
import {
  activityRowView,
  detailLine,
  detailText,
  itemRowState,
  realSha,
  textExcerpt,
  workItemLabel,
  type CommentExcerpt,
} from "../activity-detail.ts";
import {
  commitBody,
  commitRefs,
  displayKind,
  pluralize,
  relativeTime,
  reviewThreadsLabel,
  spanLabel,
  type ColorOf,
  type ResolvedChangeRequest,
} from "../model.ts";

// The selected activity event, inserted at the head of the overview column the
// way the Commits page inserts its commit. It says everything the contract
// knows about the one event:
//
//   what happened  -- the action and kind, who, where, and exactly when;
//   to what        -- the issue or change request it is about, as it is now:
//                     number, title, state, review and CI, labels, comment and
//                     review-thread counts, and the start of its description;
//   its own facts  -- a review's verdict, a review comment's file and line and
//                     (where the board already shows it) its words, a commit's
//                     sha, branches, line counts and message, a push's ref and
//                     from -> to;
//   around it      -- the other events in the range on the same item, each
//                     one a way to move the pane to it.
//
// Comment text: the contract carries none on activity rows, by design. The
// excerpt here is a review-thread comment the contract already carries for
// the Reviews page; an issue comment shows no text, because the board shows
// it nowhere else (activity-detail.ts).

export const ITEM_BODY_EXCERPT_CHARS = 900;

function absoluteTime(iso: string, timezone: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  }).format(ms);
}

// One short phrase for a related row: a review's verdict, a comment's file and
// line, a commit's subject, else its kind.
function relatedWhat(row: ActivityDTO, item: ItemDTO | undefined, providerKind: string | undefined): string {
  const view = activityRowView(row, item, providerKind);
  if (row.kind === "commit" || row.target_kind === "commit") return view.title;
  return view.verdict ?? view.chips[0] ?? displayKind(row.kind) ?? row.kind;
}

export function ActivityDetail({
  activity,
  item,
  providerKind,
  sourceKind,
  colorOf,
  timezone,
  excerpt,
  related,
  headCommit,
  changeRequest,
  itemDestination,
  avatarUrl,
  following,
  onFollowLatest,
  onClose,
  onSelect,
}: {
  activity: ActivityDTO;
  // The item the event is about, when it is loaded.
  item: ItemDTO | undefined;
  providerKind: string | undefined;
  sourceKind: ReadonlyMap<string, string>;
  colorOf: ColorOf;
  timezone: string;
  // A review comment's words, when the contract already carries them.
  excerpt: CommentExcerpt | null;
  // The other loaded rows about the same item.
  related: { rows: ActivityDTO[]; total: number };
  // A push's head commit, when that commit is loaded.
  headCommit: ActivityDTO | undefined;
  // A commit's change request (contract 4.8.2), resolved like the Commits page.
  changeRequest?: ResolvedChangeRequest | null;
  // Where the target item leads: the Items page or its provider page.
  itemDestination?: (item: ItemDTO) => { href: string | null; external: boolean };
  avatarUrl?: string;
  following: boolean;
  onFollowLatest: () => void;
  onClose: () => void;
  onSelect: (activity: ActivityDTO) => void;
}) {
  const view = activityRowView(activity, item, providerKind);
  const href = safeHref(activity.url);
  const accentColor = colorOf(activity.source_id, activity.project_path);
  const isCommit = activity.kind === "commit" || activity.target_kind === "commit";
  const destination = item && itemDestination ? itemDestination(item) : null;
  const itemState = itemRowState(item);
  const threads = reviewThreadsLabel(item?.review_threads);
  const bodyExcerpt = item && !isCommit ? textExcerpt(item.body ?? null, ITEM_BODY_EXCERPT_CHARS) : null;
  const sha = isCommit ? detailText(activity, "sha") : null;
  const refs = isCommit ? commitRefs(activity) : [];
  const commitText = isCommit ? commitBody(activity) : null;
  const rawRef = !isCommit ? detailText(activity, "ref") : null;
  const pushType = detailText(activity, "push_type") ?? detailText(activity, "action_name");
  const before = realSha(detailText(activity, "before") ?? detailText(activity, "commit_from"));
  const after = realSha(detailText(activity, "after") ?? detailText(activity, "commit_to"));
  const commentPath = detailText(activity, "path");
  const commentLine = detailLine(activity);
  const reply = activity.details != null && activity.details.in_reply_to_id != null;
  const association = detailText(activity, "author_association");
  const itemLabel =
    item && item.iid !== null ? workItemLabel(item.kind === "change_request" ? "change_request" : "issue", item.iid, providerKind) : view.label;

  return (
    <aside className="commit-detail activity-detail" aria-label="Selected activity">
      <div
        className={`commit-detail-card${accentColor ? " commit-row-accent" : ""}`}
        style={{ "--repo-color": accentColor ?? undefined } as CSSProperties}
      >
        <div className="commit-detail-toolbar">
          <button type="button" className="commit-detail-back" onClick={onClose}>
            <span className="commit-detail-back-desktop">← back to overview</span>
            <span className="commit-detail-back-mobile">← back to activity</span>
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

        <div className="activity-detail-kicker">
          <Badge text={activity.action.replace(/_/g, " ")} kind={ACTION_KIND[activity.action] ?? "status-unknown"} />
          <span>{displayKind(activity.kind)}</span>
          {view.verdict && view.verdict !== activity.action.replace(/_/g, " ") ? (
            <span className="muted">{`verdict: ${view.verdict}`}</span>
          ) : null}
        </div>

        <h3 className="commit-detail-title activity-detail-title">
          {view.label ? <span className="activity-ref">{view.label}</span> : null}
          {href ? (
            <ExternalLink className="commit-detail-title-link" href={href} target="_blank" rel="noreferrer noopener">
              {view.title}
            </ExternalLink>
          ) : (
            view.title
          )}
        </h3>

        <dl className="commit-detail-meta">
          <div className="commit-detail-row">
            <dt>Repo</dt>
            <dd>
              {activity.project_path ? (
                <SourceRepo sourceId={activity.source_id} kind={sourceKind.get(activity.source_id)} repo={activity.project_path} />
              ) : (
                <span className="muted">unknown</span>
              )}
            </dd>
          </div>
          <div className="commit-detail-row">
            <dt>Actor</dt>
            <dd>
              {activity.actor ? (
                <span className="activity-detail-actor">
                  <ActorLink sourceId={activity.source_id} name={activity.actor} username={activity.kind !== "commit"} url={typeof activity.details?.actor_profile_url === "string" ? activity.details.actor_profile_url : null}><ActorAvatar login={activity.actor} avatarUrl={avatarUrl} titled={false} /></ActorLink>
                  <ActorLink className="commit-detail-actor" sourceId={activity.source_id} name={activity.actor} username={activity.kind !== "commit"} url={typeof activity.details?.actor_profile_url === "string" ? activity.details.actor_profile_url : null}>@{activity.actor}</ActorLink>
                  {association && association !== "NONE" ? <span className="muted">{association.toLowerCase()}</span> : null}
                </span>
              ) : (
                <span className="muted">unattributed</span>
              )}
            </dd>
          </div>
          <div className="commit-detail-row">
            <dt>When</dt>
            <dd>
              <time dateTime={activity.occurred_at}>{absoluteTime(activity.occurred_at, timezone)}</time>
              <span className="muted">{relativeTime(activity.occurred_at)}</span>
            </dd>
          </div>

          {itemLabel && !isCommit ? (
            <div className="commit-detail-row activity-detail-target">
              <dt>{item ? (item.kind === "issue" ? "Issue" : "Change request") : "Target"}</dt>
              <dd>
                {destination?.href ? (
                  <NavigationLink
                    className="commit-cr-chip"
                    href={destination.href}
                    {...(destination.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                  >
                    {itemLabel}
                  </NavigationLink>
                ) : (
                  <span className="commit-cr-chip">{itemLabel}</span>
                )}
                {item ? (
                  <>
                    {itemState ? <Badge text={itemState} kind={itemState} /> : null}
                    {item.review_state ? <span className="muted">{`review ${item.review_state.replace(/_/g, " ")}`}</span> : null}
                    {item.ci_state && item.ci_state !== "none" ? <span className="muted">{`CI ${item.ci_state}`}</span> : null}
                    {item.state === "merged" && spanLabel(item.created_at, item.merged_at) ? (
                      <span className="muted">{`open ${spanLabel(item.created_at, item.merged_at)}`}</span>
                    ) : null}
                  </>
                ) : (
                  <span className="muted">not in the loaded window</span>
                )}
              </dd>
            </div>
          ) : null}
          {item && (item.comments?.total != null || threads || item.author) ? (
            <div className="commit-detail-row">
              <dt>Thread</dt>
              <dd>
                {item.author ? <span className="muted">opened by <ActorLink sourceId={item.source_id} name={item.author} username>@{item.author}</ActorLink></span> : null}
                {item.comments?.total != null ? (
                  <span className="muted">{`${item.comments.total} ${pluralize(item.comments.total, "comment")}`}</span>
                ) : null}
                {threads ? <span className="muted">{threads}</span> : null}
              </dd>
            </div>
          ) : null}
          {item && item.labels.length > 0 ? (
            <div className="commit-detail-row">
              <dt>Labels</dt>
              <dd className="activity-detail-labels">
                {item.labels.map((label) => (
                  <LabelChip key={label.name} label={label} sourceId={item.source_id} projectPath={item.project_path} />
                ))}
              </dd>
            </div>
          ) : null}

          {commentPath ? (
            <div className="commit-detail-row">
              <dt>On</dt>
              <dd>
                <ExternalLink href={activity.url}><code className="activity-detail-path">{commentLine !== null ? `${commentPath}:${commentLine}` : commentPath}</code></ExternalLink>
                {reply ? <span className="muted">reply in a review thread</span> : null}
              </dd>
            </div>
          ) : null}

          {sha ? (
            <div className="commit-detail-row">
              <dt>SHA</dt>
              <dd>
                <EntityLink sourceId={activity.source_id} entity={{ kind: "commit", projectPath: activity.project_path, sha }}><code className="commit-detail-sha">{sha}</code></EntityLink>
              </dd>
            </div>
          ) : null}
          {isCommit && (view.merge || view.diff) ? (
            <div className="commit-detail-row">
              <dt>Lines</dt>
              <dd>{view.merge ? <span className="commit-merge-tag">merge</span> : <DiffStat stats={view.diff} />}</dd>
            </div>
          ) : null}
          {isCommit && changeRequest ? (
            <div className="commit-detail-row commit-detail-cr">
              <dt>Change request</dt>
              <dd>
                {changeRequest.href ? (
                  <NavigationLink
                    className="commit-cr-chip"
                    href={changeRequest.href}
                    {...(changeRequest.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                  >
                    {changeRequest.view.label}
                  </NavigationLink>
                ) : (
                  <span className="commit-cr-chip">{changeRequest.view.label}</span>
                )}
                <EntityLink sourceId={activity.source_id} entity={{ kind: "change_request", projectPath: activity.project_path, iid: changeRequest.view.iid, url: changeRequest.view.url }} aria-label={`Open ${changeRequest.view.label} on provider`}>↗</EntityLink>
                    {changeRequest.view.title ? <EntityLink className="commit-detail-cr-title" sourceId={activity.source_id} entity={{ kind: "change_request", projectPath: activity.project_path, iid: changeRequest.view.iid, url: changeRequest.view.url }}>{changeRequest.view.title}</EntityLink> : null}
                {changeRequest.view.state ? <Badge text={changeRequest.view.state} kind={changeRequest.view.state} /> : null}
              </dd>
            </div>
          ) : null}
          {refs.length > 0 ? (
            <div className="commit-detail-row">
              <dt>{refs.length === 1 ? "Branch" : "Branches"}</dt>
              <dd className="commit-detail-branches">
                {refs.map((ref) => (
                  <span key={ref.name} className="chip commit-branch-chip" data-default={ref.isDefault ? "true" : undefined}>
                    <EntityLink sourceId={activity.source_id} entity={{ kind: "branch", projectPath: activity.project_path, ref: ref.name }}>{ref.name}</EntityLink>
                    {ref.isDefault ? <small>default</small> : null}
                  </span>
                ))}
              </dd>
            </div>
          ) : null}

          {rawRef ? (
            <div className="commit-detail-row">
              <dt>Ref</dt>
              <dd>
                <EntityLink sourceId={activity.source_id} entity={{ kind: "branch", projectPath: activity.project_path, ref: rawRef }}><code className="activity-detail-path">{rawRef}</code></EntityLink>
                {pushType ? <span className="muted">{pushType.replace(/_/g, " ")}</span> : null}
              </dd>
            </div>
          ) : null}
          {before || after ? (
            <div className="commit-detail-row">
              <dt>Commits</dt>
              <dd className="activity-detail-range">
                <EntityLink sourceId={activity.source_id} entity={{ kind: "commit", projectPath: activity.project_path, sha: before }}><code>{before ? before.slice(0, 12) : "new"}</code></EntityLink>
                <span aria-hidden="true">→</span>
                <EntityLink sourceId={activity.source_id} entity={{ kind: "commit", projectPath: activity.project_path, sha: after }}><code>{after ? after.slice(0, 12) : "deleted"}</code></EntityLink>
              </dd>
            </div>
          ) : null}
          {headCommit ? (
            <div className="commit-detail-row">
              <dt>Head</dt>
              <dd>
                <button type="button" className="activity-detail-link" onClick={() => onSelect(headCommit)}>
                  {activityRowView(headCommit, undefined, providerKind).title}
                </button>
                <ExternalLink href={headCommit.url} aria-label="Open head commit on provider">↗</ExternalLink>
              </dd>
            </div>
          ) : null}
        </dl>

        {excerpt ? (
          <figure className="activity-detail-excerpt">
            <blockquote>
              <MarkdownBody text={`${excerpt.body}${excerpt.truncated ? " …" : ""}`} className="live-md activity-detail-md" />
            </blockquote>
            <figcaption className="muted">
              <ExternalLink href={excerpt.threadUrl}>{`from the review thread${excerpt.path ? ` on ${excerpt.path}${excerpt.line !== null ? `:${excerpt.line}` : ""}` : ""}`}</ExternalLink>{` · ${excerpt.resolved ? "resolved" : "open"}`}
            </figcaption>
          </figure>
        ) : null}

        {commitText ? <pre className="commit-detail-body">{commitText}</pre> : null}

        {bodyExcerpt ? (
          <div className="activity-detail-body">
            <div className="activity-detail-section-head">Description</div>
            <MarkdownBody text={`${bodyExcerpt.text}${bodyExcerpt.truncated ? " …" : ""}`} className="live-md activity-detail-md" />
          </div>
        ) : null}

        {related.total > 0 ? (
          <div className="activity-detail-related">
            <div className="activity-detail-section-head">
              {`On this ${item?.kind === "issue" ? "issue" : isCommit ? "change request" : "item"}`}
              <span className="muted">{`${related.total} more in range`}</span>
            </div>
            <ol>
              {related.rows.map((row) => (
                <li key={`${row.source_id}|${row.external_id}`}>
                  <SelectableEntityRow className="activity-detail-related-row" label={`Select ${relatedWhat(row, item, providerKind)}`} selected={false} onSelect={() => onSelect(row)}>
                    <Badge text={row.action.replace(/_/g, " ")} kind={ACTION_KIND[row.action] ?? "status-unknown"} />
                    <ActorLink className="activity-detail-related-who" sourceId={row.source_id} name={row.actor} username={row.kind !== "commit"} url={typeof row.details?.actor_profile_url === "string" ? row.details.actor_profile_url : null}>{row.actor ? `@${row.actor}` : displayKind(row.kind)}</ActorLink>
                    <ExternalLink className="activity-detail-related-what" href={row.url}>{relatedWhat(row, item, providerKind)}</ExternalLink>
                    <time dateTime={row.occurred_at}>{relativeTime(row.occurred_at)}</time>
                  </SelectableEntityRow>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
