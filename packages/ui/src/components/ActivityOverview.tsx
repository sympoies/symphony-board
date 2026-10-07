import { EntityLink, SelectableEntityRow } from "./ExternalLink.tsx";
import type { ActivityDTO, ActivityDailyDTO, ItemDTO } from "@symphony-board/contract";
import { memo, useMemo, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { CommitRhythm } from "./CommitsOverview.tsx";
import { StackedDayChart, type StackOption } from "./CommitDayChart.tsx";
import { CommitPunchCard } from "./CommitPunchCard.tsx";
import { share } from "./RankParts.tsx";
import { Badge } from "./Badge.tsx";
import type { HeatmapTip } from "./HeatmapCalendar.tsx";
import {
  EMPTY_ACTOR_INDEX,
  STACK_FOLD_KEY,
  activityTotals,
  busiestItems,
  countsByDay,
  rankReviewVerdicts,
  shortRepoLabel,
  type ActorIndex,
  type BusiestItem,
} from "../rail-stats.ts";
import { itemRowState, workItemLabel } from "../activity-detail.ts";
import { activityKey, displayKind, pluralize, relativeTime, type TimeRange } from "../model.ts";
import { COMMITS_PANES_RANK_LIMIT, type CommitsPanes } from "../layout-tier.ts";

// The Activity overview in the pane tiers: the SHAPE of the selected range, as
// the Commits overview draws it for commits.
//
//   tiles            how much, and of what: events, people, repos, active and
//                    busiest days, comments, reviews, merges, opened items,
//                    pushes;
//   rhythm           the trailing year, every event kind, with its facts;
//   events per day   the range day by day, each bar split by kind, action,
//                    repository or person;
//   when             day (or weekday) by hour;
//   review verdicts  how the range's reviews came out;
//   busiest items    the issues and change requests with the most events, each
//                    a way to open its newest event in the detail pane.
//
// Everything but the rhythm reads the rows the feed renders, so it can never
// disagree with the list. Below the pane tiers the page keeps its plain
// overview (ActivityHeatmap).

function eventCountLabel(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "event" : "events"}`;
}

function stackOptions(actorIndex: ActorIndex): StackOption[] {
  return [
    { id: "kind", keyOf: (a) => ({ key: a.kind, label: displayKind(a.kind) ?? a.kind }) },
    { id: "action", keyOf: (a) => ({ key: a.action, label: a.action.replace(/_/g, " ") }) },
    {
      id: "repo",
      keyOf: (a) => {
        const path = a.project_path?.trim();
        return path ? { key: `${a.source_id}|${path}`, label: shortRepoLabel(path) } : { key: STACK_FOLD_KEY, label: STACK_FOLD_KEY };
      },
    },
    {
      id: "actor",
      keyOf: (a) => {
        const actor = a.actor?.trim();
        if (!actor) return { key: STACK_FOLD_KEY, label: STACK_FOLD_KEY };
        const name = actorIndex.canonical.get(actor) ?? actor;
        return { key: name, label: name };
      },
    },
  ];
}

export function ActivityOverview({
  activities,
  activityDaily,
  timezone,
  range,
  actorIndex = EMPTY_ACTOR_INDEX,
  panes,
  itemsById,
  sourceKind,
  selectedKey = null,
  onSelect,
  selectedActions,
  onAction,
  panelRef,
}: {
  activities: ActivityDTO[];
  activityDaily: ActivityDailyDTO | null;
  timezone: string;
  range: TimeRange;
  actorIndex?: ActorIndex;
  panes: CommitsPanes;
  itemsById?: ReadonlyMap<string, ItemDTO>;
  sourceKind: ReadonlyMap<string, string>;
  // The event in the detail pane, and the way to open one: a busiest item opens
  // its newest event.
  selectedKey?: string | null;
  onSelect: (activity: ActivityDTO) => void;
  // The Activity action facet, which a review-verdict row toggles.
  selectedActions: ReadonlySet<string>;
  onAction?: (action: string) => void;
  panelRef?: Ref<HTMLElement>;
}) {
  const [tip, setTip] = useState<HeatmapTip | null>(null);
  const totals = useMemo(() => activityTotals(activities, actorIndex), [activities, actorIndex]);
  const days = useMemo(() => countsByDay(activities, timezone, range.from, range.to), [activities, timezone, range.from, range.to]);
  const busiest = days.reduce<{ date: string; count: number } | null>(
    (best, day) => (day.count > 0 && (!best || day.count > best.count) ? day : best),
    null,
  );
  const activeDays = days.filter((d) => d.count > 0).length;
  const options = useMemo(() => stackOptions(actorIndex), [actorIndex]);

  const summary: { label: string; value: ReactNode; detail: ReactNode }[] = [
    { label: "events", value: totals.events.toLocaleString("en-US"), detail: "in range" },
    { label: "people", value: totals.people.toLocaleString("en-US"), detail: "active" },
    { label: "repos", value: totals.repos.toLocaleString("en-US"), detail: "with events" },
    ...(days.length > 0 ? [{ label: "active days", value: activeDays.toLocaleString("en-US"), detail: `of ${days.length} days` }] : []),
    ...(busiest ? [{ label: "busiest day", value: busiest.count.toLocaleString("en-US"), detail: busiest.date }] : []),
    { label: "comments", value: totals.comments.toLocaleString("en-US"), detail: "on issues and PRs" },
    {
      label: "reviews",
      value: totals.reviews.toLocaleString("en-US"),
      detail: `${totals.approvals.toLocaleString("en-US")} approved${totals.changesRequested > 0 ? ` · ${totals.changesRequested.toLocaleString("en-US")} changes` : ""}`,
    },
    { label: "merged", value: totals.merged.toLocaleString("en-US"), detail: "change requests" },
    { label: "opened", value: totals.opened.toLocaleString("en-US"), detail: `issues and PRs · ${totals.closed.toLocaleString("en-US")} closed` },
    { label: "pushes", value: totals.pushes.toLocaleString("en-US"), detail: `${totals.commits.toLocaleString("en-US")} ${pluralize(totals.commits, "commit")}` },
  ];

  return (
    <aside ref={panelRef} className="commits-overview pane-scroll activity-overview" data-panes={panes} aria-label="Activity range overview">
      <div className="rail-block pane-span">
        <div className="hm-overview-head">
          <h3>Activity overview</h3>
          <small>{`${range.from} to ${range.to}`}</small>
        </div>
        <dl className="hm-summary">
          {summary.map((item) => (
            <div key={item.label}>
              <dt>{item.label}</dt>
              <dd>
                {item.value}
                <small>{item.detail}</small>
              </dd>
            </div>
          ))}
        </dl>
      </div>
      <CommitRhythm activityDaily={activityDaily} range={range} onTip={setTip} facts kind={null} title="Activity rhythm" noun="event" />
      <StackedDayChart rows={activities} timezone={timezone} range={range} title="Events per day" noun="event" options={options} />
      <CommitPunchCard rows={activities} timezone={timezone} range={range} noun="event" />
      <ReviewVerdicts activities={activities} selectedActions={selectedActions} onAction={onAction} />
      <BusiestItems
        activities={activities}
        itemsById={itemsById}
        sourceKind={sourceKind}
        selectedKey={selectedKey}
        onSelect={onSelect}
      />
      {tip ? (
        <div className="hm-tip" role="status" style={{ left: tip.x, top: tip.y } as CSSProperties}>
          {tip.label}
        </div>
      ) : null}
    </aside>
  );
}

// How the range's reviews came out. A row toggles the action facet, so
// "changes requested" narrows the feed to exactly those reviews.
const ReviewVerdicts = memo(function ReviewVerdicts({
  activities,
  selectedActions,
  onAction,
}: {
  activities: ActivityDTO[];
  selectedActions: ReadonlySet<string>;
  onAction?: (action: string) => void;
}) {
  const ranks = useMemo(() => rankReviewVerdicts(activities, 0), [activities]);
  const total = ranks.reduce((sum, rank) => sum + rank.count, 0);
  return (
    <div className="rail-block activity-verdicts">
      <div className="rail-block-head">
        <span className="rail-block-title">Review verdicts</span>
        <span className="rail-block-meta">{`${total.toLocaleString("en-US")} ${pluralize(total, "review")}`}</span>
      </div>
      {/* Rows, not a RankChart: the overview column has no rail relayout, and
          four verdicts read better as a short table than as four bars. */}
      {ranks.length === 0 ? (
        <div className="pane-empty">no reviews in range</div>
      ) : (
        <ol className="activity-verdict-rows" aria-label="Reviews in the selected range by verdict">
          {ranks.map((rank) => (
            <li key={rank.key}>
              <button
                type="button"
                className="activity-verdict-row"
                aria-pressed={selectedActions.has(rank.key)}
                aria-label={`${rank.label}: ${rank.count.toLocaleString("en-US")} ${pluralize(rank.count, "review")}, ${share(rank.count, total)} of the range's reviews`}
                disabled={!onAction}
                onClick={onAction ? () => onAction(rank.key) : undefined}
              >
                <span className="activity-verdict-name">{rank.label}</span>
                <span className="activity-verdict-bar" aria-hidden="true">
                  <i data-verdict={rank.key} style={{ inlineSize: `${Math.max(2, (rank.count / Math.max(1, ranks[0]!.count)) * 100)}%` } as CSSProperties} />
                </span>
                <span className="activity-verdict-count">{rank.count.toLocaleString("en-US")}</span>
                <span className="activity-verdict-share">{share(rank.count, total)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
});

// The issues and change requests the range was busiest about. A row opens the
// item's newest event in the detail pane, where its thread is listed.
const BusiestItems = memo(function BusiestItems({
  activities,
  itemsById,
  sourceKind,
  selectedKey,
  onSelect,
}: {
  activities: ActivityDTO[];
  itemsById?: ReadonlyMap<string, ItemDTO>;
  sourceKind: ReadonlyMap<string, string>;
  selectedKey: string | null;
  onSelect: (activity: ActivityDTO) => void;
}) {
  const all = useMemo(() => busiestItems(activities, 0), [activities]);
  const rows = all.slice(0, COMMITS_PANES_RANK_LIMIT);
  return (
    <div className="rail-block pane-fill pane-span activity-busiest">
      <div className="rail-block-head">
        <span className="rail-block-title">Busiest items</span>
        <span className="rail-block-meta">{`${all.length.toLocaleString("en-US")} ${pluralize(all.length, "item")} with events in range`}</span>
      </div>
      {rows.length === 0 ? (
        <div className="pane-empty">no event in range names an issue or change request</div>
      ) : (
        <ol className="pane-rows pane-scroll" aria-label="Issues and change requests with the most events in the selected range">
          {rows.map((row) => (
            <li key={row.ref}>
              <BusiestRow
                row={row}
                item={itemsById?.get(row.ref)}
                providerKind={sourceKind.get(row.sourceId)}
                selected={selectedKey !== null && selectedKey === activityKey(row.latest)}
                onSelect={onSelect}
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
});

function BusiestRow({
  row,
  item,
  providerKind,
  selected,
  onSelect,
}: {
  row: BusiestItem;
  item: ItemDTO | undefined;
  providerKind: string | undefined;
  selected: boolean;
  onSelect: (activity: ActivityDTO) => void;
}) {
  const kind = item ? (item.kind === "change_request" ? "change_request" : "issue") : row.kind;
  const iid = item?.iid ?? row.iid;
  const label = kind && iid !== null ? workItemLabel(kind, iid, providerKind) : null;
  const state = itemRowState(item);
  const title = item?.title ?? row.latest.title ?? (kind ? displayKind(kind) : null) ?? "item";
  const facts = [
    row.comments > 0 ? `${row.comments} ${pluralize(row.comments, "comment")}` : null,
    row.reviews > 0 ? `${row.reviews} ${pluralize(row.reviews, "review")}` : null,
    row.commits > 0 ? `${row.commits} ${pluralize(row.commits, "commit")}` : null,
    `last ${relativeTime(row.lastAt)}`,
  ].filter(Boolean);
  return (
    <SelectableEntityRow className="pane-row activity-busiest-row" selected={selected}
      label={`Open the newest event on ${label ?? "this item"}`} onSelect={() => onSelect(row.latest)}
    >
      <span className="pane-row-main">
        <b>
          <EntityLink sourceId={row.sourceId} entity={{ kind: kind === "issue" ? "issue" : "change_request", projectPath: row.projectPath, iid, url: item?.url }}>{label ? <span className="pane-row-cr-number">{label}</span> : null}{` ${title}`}</EntityLink>
        </b>
        <small>
          {row.projectPath ? <><EntityLink sourceId={row.sourceId} entity={{ kind: "repo", projectPath: row.projectPath }}>{shortRepoLabel(row.projectPath)}</EntityLink> · </> : ""}
          {facts.join(" · ")}
        </small>
      </span>
      <span className="activity-busiest-side">
        {state ? <Badge text={state} kind={state} /> : null}
        <span className="activity-busiest-count">{eventCountLabel(row.events)}</span>
      </span>
    </SelectableEntityRow>
  );
}
