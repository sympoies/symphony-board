import type { ItemDTO } from "@symphony-board/contract";
import { Badge } from "./Badge.tsx";
import { LabelChip } from "./LabelChip.tsx";
import { SourceIcon } from "./SourceIcon.tsx";
import { relativeTime } from "../model.ts";

const KIND_ICON: Record<string, string> = { issue: "◇", change_request: "⇄" };

// Engagement (comments + reactions) marker. A line-style speech bubble drawn in
// currentColor — deliberately a stroked SVG, not an emoji, to match the card's
// minimal monochrome look. (Feather "message-square".)
function DemandIcon() {
  return (
    <svg
      className="icon-demand"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function ItemCard({ item, anchorId, sourceKind }: { item: ItemDTO; anchorId?: string; sourceKind?: string }) {
  const icon = KIND_ICON[item.kind] ?? "•";
  return (
    <article className="card" id={anchorId}>
      <div className="card-head">
        <span className="kind" title={item.kind}>
          {icon}
        </span>
        <Badge text={item.state} kind={item.state} />
        {item.is_draft ? <Badge text="draft" kind="draft" /> : null}
        <a className="card-title" href={item.url || undefined} target="_blank" rel="noopener noreferrer">
          {item.title ?? "(untitled)"}
        </a>
      </div>

      <div className="card-meta">
        <SourceIcon kind={sourceKind} />
        {item.project_path ? <span className="muted">{item.project_path}</span> : null}
        {item.iid != null ? <span className="muted">#{item.iid}</span> : null}
        {item.author ? <span className="muted">@{item.author}</span> : null}
        {item.demand != null ? (
          <span className="muted demand" title="comments + reactions">
            <DemandIcon /> {item.demand}
          </span>
        ) : null}
      </div>

      {/* created · updated, on their own line beneath the meta row */}
      {(item.created_at || item.updated_at) && (
        <div className="card-times muted">
          {item.created_at ? (
            <time title={item.created_at}>created {relativeTime(item.created_at)}</time>
          ) : null}
          {item.created_at && item.updated_at ? <span className="sep">·</span> : null}
          {item.updated_at ? (
            <time title={item.updated_at}>updated {relativeTime(item.updated_at)}</time>
          ) : null}
        </div>
      )}

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
