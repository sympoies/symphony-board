import type { ItemDTO } from "@symphony-board/contract";
import { Badge } from "./Badge.tsx";
import { LabelChip } from "./LabelChip.tsx";
import { relativeTime } from "../model.ts";

const KIND_ICON: Record<string, string> = { issue: "◇", change_request: "⇄" };

export function ItemCard({ item, anchorId }: { item: ItemDTO; anchorId?: string }) {
  const icon = KIND_ICON[item.kind] ?? "•";
  return (
    <article className="card" id={anchorId}>
      <div className="card-head">
        <span className="kind" title={item.kind}>
          {icon}
        </span>
        <Badge text={item.state} kind={item.state} />
        {item.is_draft ? <Badge text="draft" kind="draft" /> : null}
        <a className="card-title" href={item.url || undefined} target="_blank" rel="noreferrer">
          {item.title ?? "(untitled)"}
        </a>
      </div>

      <div className="card-meta">
        {item.project_path ? <span className="muted">{item.project_path}</span> : null}
        {item.iid != null ? <span className="muted">#{item.iid}</span> : null}
        {item.author ? <span className="muted">@{item.author}</span> : null}
        {item.demand != null ? (
          <span className="muted" title="comments + reactions">
            ▲ {item.demand}
          </span>
        ) : null}
        <span className="muted" title={item.updated_at ?? undefined}>
          updated {relativeTime(item.updated_at)}
        </span>
      </div>

      {(item.review_state || item.ci_state || item.merge_state) && (
        <div className="card-signals">
          {item.review_state ? <Badge text={`review: ${item.review_state}`} kind={`review-${item.review_state}`} /> : null}
          {item.ci_state ? <Badge text={`ci: ${item.ci_state}`} kind={`ci-${item.ci_state}`} /> : null}
          {item.merge_state ? <Badge text={`merge: ${item.merge_state}`} kind={`merge-${item.merge_state}`} /> : null}
        </div>
      )}

      {item.labels.length > 0 && (
        <div className="card-labels">
          {item.labels.map((l) => (
            <LabelChip key={l.name} label={l} />
          ))}
        </div>
      )}
    </article>
  );
}
