import type { CSSProperties } from "react";
import type { ItemDTO } from "@symphony-board/contract";
import { Badge } from "./Badge.tsx";
import { ItemKindIcon } from "./ItemKindIcon.tsx";
import { LabelChip } from "./LabelChip.tsx";
import { SourceRepo } from "./SourceRepo.tsx";
import { relativeTime, reviewThreadsLabel, type RelationCount } from "../model.ts";
import { graphFocusHref, type ItemRouteFields } from "../nav.ts";

// "Focus this item in the relationship graph" marker — three connected nodes
// (Feather "share-2"), the same stroked-SVG idiom as DemandIcon. Shown only for
// items that actually have a graph node (see `linked`).
function GraphIcon() {
  return (
    <svg
      className="icon-graph"
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  );
}

// Relation-count marker: how many items this one is related to. A chain link —
// the universal "linked items" glyph — in the same stroked-SVG idiom as
// DemandIcon. (Feather "link".)
function LinkIcon() {
  return (
    <svg
      className="icon-related"
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
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

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

export function ItemCard({
  item,
  anchorId,
  sourceKind,
  accentColor,
  related,
  graphLink,
  lens,
}: {
  item: ItemDTO;
  anchorId?: string;
  sourceKind?: string;
  // Repo/source highlight color (resolved by the caller). When set, the card
  // gets a colored left bar (a ::before, so it survives hover/active/:target,
  // which take the border-color channel). null/undefined -> no bar.
  accentColor?: string | null;
  // Present when this item is an endpoint of at least one edge (derived from
  // the caller's edge set via relationCounts / relationCountOf). Renders the
  // meta row's link-icon count with a per-type tooltip; the board AND the graph
  // side list both pass it, so the two surfaces always show the same number.
  related?: RelationCount | null;
  // True to ALSO render the "focus in graph" head link for related items — the
  // board sets it; the graph side list doesn't (you are already on the graph,
  // and the card body itself is the focus target there).
  graphLink?: boolean;
  // The shared item lens (isource/istate/ikind/ireview/irepo) to thread into the
  // graph-focus deep link, so a round-trip back to the board keeps the lens.
  lens?: ItemRouteFields;
}) {
  return (
    <article
      className={`card${accentColor ? " card-accent" : ""}`}
      id={anchorId}
      style={accentColor ? ({ "--repo-color": accentColor } as CSSProperties) : undefined}
    >
      <div className="card-head">
        <ItemKindIcon kind={item.kind} className="card-kind-icon" />
        <Badge text={item.state} kind={item.state} />
        {item.is_draft ? <Badge text="draft" kind="draft" /> : null}
        {/* Focus-in-graph link: edge-endpoint items on surfaces that opted in
            via `graphLink` (the board). stopPropagation so that if the card is
            ever wrapped in a click target it opens the graph without also
            triggering the wrapper, matching the card title below. */}
        {related && graphLink ? (
          <a
            className="card-graph"
            href={graphFocusHref(item, lens)}
            title="focus this item in the relationship graph"
            aria-label="focus in graph"
            onClick={(e) => e.stopPropagation()}
          >
            <GraphIcon />
          </a>
        ) : null}
        {/* stopPropagation so opening the issue from a card that is itself
            clickable (e.g. the graph side list's focus target) doesn't also
            trigger the wrapper's click; harmless on the board where the card has
            no click handler. */}
        <a
          className="card-title"
          href={item.url || undefined}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          {item.title ?? "(untitled)"}
        </a>
      </div>

      {/* Two meta rows, mirroring the graph node card: the identity row
          (source · repo · #iid) then the people/engagement row (@author ·
          demand · related). The engagement row only renders when it has
          content, so a bare item doesn't leave an empty line. */}
      <div className="card-meta">
        <SourceRepo kind={sourceKind} repo={item.project_path} />
        {item.iid != null ? <span className="card-iid">#{item.iid}</span> : null}
      </div>
      {(item.author || item.demand != null || (related && related.total > 0)) && (
        <div className="card-meta">
          {item.author ? <span className="muted">@{item.author}</span> : null}
          {item.demand != null ? (
            <span className="muted demand" title="comments + reactions">
              <DemandIcon /> {item.demand}
            </span>
          ) : null}
          {/* Distinct related items, tooltip broken down by strongest edge type
              ("closes 2 · mentions 3"). Same data that gates the graph link above,
              so the count and the focus affordance can never disagree. */}
          {related && related.total > 0 ? (
            <span className="muted related" title={related.byType.map((t) => `${t.type} ${t.count}`).join(" · ")}>
              <LinkIcon /> {related.total}
            </span>
          ) : null}
        </div>
      )}

      {/* updated · created, on their own line beneath the meta row */}
      {(item.created_at || item.updated_at) && (
        <div className="card-times muted">
          {item.updated_at ? (
            <time title={item.updated_at}>updated {relativeTime(item.updated_at)}</time>
          ) : null}
          {item.created_at && item.updated_at ? <span className="sep">·</span> : null}
          {item.created_at ? (
            <time title={item.created_at}>created {relativeTime(item.created_at)}</time>
          ) : null}
        </div>
      )}

      {(item.review_state || item.ci_state || item.merge_state || reviewThreadsLabel(item.review_threads)) && (
        <div className="card-signals">
          {item.review_state ? <Badge text={`review: ${item.review_state}`} kind={`review-${item.review_state}`} /> : null}
          {item.ci_state ? <Badge text={`ci: ${item.ci_state}`} kind={`ci-${item.ci_state}`} /> : null}
          {item.merge_state ? <Badge text={`merge: ${item.merge_state}`} kind={`merge-${item.merge_state}`} /> : null}
          {/* Open review threads: red while any remain, neutral once resolved.
              A point-in-time signal (last sync), like the others on this row. */}
          {reviewThreadsLabel(item.review_threads) ? (
            <Badge
              text={`threads: ${item.review_threads!.open > 0 ? `${item.review_threads!.open} open` : "resolved"}`}
              kind={item.review_threads!.open > 0 ? "status-error" : "status-ok"}
            />
          ) : null}
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
