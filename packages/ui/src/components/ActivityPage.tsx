import type { CSSProperties } from "react";
import type { ActivityDTO } from "@symphony-board/contract";
import { Badge } from "./Badge.tsx";
import { SourceIcon } from "./SourceIcon.tsx";
import { relativeTime, type ColorOf } from "../model.ts";

const ACTION_KIND: Record<string, string> = {
  opened: "open",
  closed: "closed",
  merged: "merged",
  committed: "status-ok",
  pushed: "lifecycle-declared",
  force_pushed: "lifecycle-broken",
  created: "status-ok",
  deleted: "status-error",
  commented: "status-partial",
  reopened: "open",
};

function activityTitle(a: ActivityDTO): string {
  return a.summary ?? a.title ?? `${a.action} ${a.kind}`;
}

export function ActivityPage({
  activities,
  sourceKind,
  colorOf,
}: {
  activities: ActivityDTO[];
  sourceKind: ReadonlyMap<string, string>;
  colorOf: ColorOf;
}) {
  return (
    <main className="activity-page">
      <div className="activity-head">
        <h2>Activity</h2>
        <span className="count">{activities.length}</span>
      </div>
      {activities.length === 0 ? (
        <p className="empty">No activity.</p>
      ) : (
        <div className="activity-list">
          {activities.map((a) => {
            const accentColor = colorOf(a.source_id, a.project_path);
            const title = activityTitle(a);
            return (
              <article
                key={a.id}
                className={`activity-row${accentColor ? " card-accent" : ""}`}
                style={accentColor ? ({ "--repo-color": accentColor } as CSSProperties) : undefined}
              >
                <div className="activity-main">
                  <div className="activity-title-row">
                    <Badge text={a.action} kind={ACTION_KIND[a.action] ?? "status-unknown"} />
                    {a.url ? (
                      <a className="activity-title" href={a.url} target="_blank" rel="noopener noreferrer">
                        {title}
                      </a>
                    ) : (
                      <span className="activity-title">{title}</span>
                    )}
                  </div>
                  <div className="activity-meta">
                    <SourceIcon kind={sourceKind.get(a.source_id)} />
                    {a.project_path ? <span>{a.project_path}</span> : null}
                    <span>{a.kind}</span>
                    {a.target_iid != null ? <span>#{a.target_iid}</span> : null}
                    {a.actor ? <span>@{a.actor}</span> : null}
                  </div>
                </div>
                <time className="activity-time" title={a.occurred_at}>
                  {relativeTime(a.occurred_at)}
                </time>
              </article>
            );
          })}
        </div>
      )}
    </main>
  );
}
