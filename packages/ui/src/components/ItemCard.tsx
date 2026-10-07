import { ActorLink, EntityLink } from "./ExternalLink.tsx";
import { ExternalLink } from "./ExternalLink.tsx";
import type { CSSProperties } from "react";
import type { ItemDTO } from "@symphony-board/contract";
import { Badge } from "./Badge.tsx";
import { ItemMetricStrip } from "./ItemMetricStrip.tsx";
import { ItemKindIcon, itemKindLabel } from "./ItemKindIcon.tsx";
import { LabelChip } from "./LabelChip.tsx";
import { SourceRepo } from "./SourceRepo.tsx";
import { itemMetricEntries, programCardSummary } from "../item-metrics.ts";
import { relativeTime, reviewThreadsLabel, type RelationCount } from "../model.ts";
import type { ProgramRollup } from "../program.ts";
import { graphFocusHref, type ItemRouteFields } from "../nav.ts";

// "Focus this item in the relationship graph" marker — three connected nodes
// (Feather "share-2"). Shown only for items that actually have a graph node.
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

export function ItemCard({
  item,
  anchorId,
  sourceKind,
  accentColor,
  related,
  program,
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
  // Present on a tracker card whose program has children (the board's Trackers
  // lane passes it): renders the progress row — done/total, in-review and
  // blocked counts — and the children that can start next.
  program?: ProgramRollup | null;
  // True to ALSO render the "focus in graph" head link for related items — the
  // board sets it; the graph side list doesn't (you are already on the graph,
  // and the card body itself is the focus target there).
  graphLink?: boolean;
  // The shared item lens (isource/istate/ikind/ireview/irepo) to thread into the
  // graph-focus deep link, so a round-trip back to the board keeps the lens.
  lens?: ItemRouteFields;
}) {
  const hasMetrics = itemMetricEntries(item, related).length > 0;
  const programSummary = program ? programCardSummary(program) : null;
  return (
    <article
      className={`card${accentColor ? " card-accent" : ""}`}
      id={anchorId}
      style={accentColor ? ({ "--repo-color": accentColor } as CSSProperties) : undefined}
    >
      <div className="card-kind" title={itemKindLabel(item.kind)}>
        <ItemKindIcon kind={item.kind} className="card-kind-icon" />
      </div>
      <div className="card-main">
        <div className="card-head">
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
          <span className="card-title-break" aria-hidden="true" />
          {/* stopPropagation so opening the issue from a card that is itself
            clickable (e.g. the graph side list's focus target) doesn't also
            trigger the wrapper's click; harmless on the board where the card has
            no click handler. */}
          <ExternalLink
            className="card-title"
            href={item.url || undefined}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
          >
            {item.title ?? "(untitled)"}
          </ExternalLink>
        </div>

        {/* Two meta rows, mirroring the graph node card: the identity row
          (source · repo · #iid) then the people/metric row. The metric row only renders when it has
          content, so a bare item doesn't leave an empty line. */}
        <div className="card-meta">
          <SourceRepo sourceId={item.source_id} kind={sourceKind} repo={item.project_path} />
          {item.iid != null ? <EntityLink className="card-iid" sourceId={item.source_id} entity={{ kind: item.kind === "issue" ? "issue" : "change_request", url: item.url, projectPath: item.project_path, iid: item.iid }}>#{item.iid}</EntityLink> : null}
        </div>
        {(item.author || hasMetrics) && (
          <div className="card-meta">
            {item.author ? <ActorLink className="muted" sourceId={item.source_id} name={item.author} username>@{item.author}</ActorLink> : null}
            <ItemMetricStrip item={item} related={related} />
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

        {programSummary && (
          <div className="card-signals card-program">
            <Badge
              text={`${programSummary.progress} done`}
              kind={programSummary.complete ? "status-ok" : undefined}
              title={`${programSummary.progress} children closed or merged`}
            />
            {programSummary.inReview > 0 ? (
              <Badge
                text={`in review: ${programSummary.inReview}`}
                kind="lifecycle-declared"
                title={`${programSummary.inReview} with an open change request that closes them`}
              />
            ) : null}
            {programSummary.blocked > 0 ? (
              <Badge
                text={`blocked: ${programSummary.blocked}`}
                kind="status-error"
                title={`${programSummary.blocked} waiting on an item that is not done`}
              />
            ) : null}
          </div>
        )}
        {programSummary && programSummary.ready.length > 0 && (
          <div className="card-program-ready">
            <span className="muted">ready</span>
            {programSummary.ready.map((child) =>
              child.url ? (
                <ExternalLink
                  key={child.id}
                  className="card-program-child"
                  href={child.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={child.name}
                  onClick={(e) => e.stopPropagation()}
                >
                  {child.name}
                </ExternalLink>
              ) : (
                <span key={child.id} className="card-program-child" title={child.name}>
                  {child.name}
                </span>
              ),
            )}
            {programSummary.readyMore > 0 ? <span className="muted">+{programSummary.readyMore}</span> : null}
          </div>
        )}

        {item.labels.length > 0 && (
          <div className="card-labels">
            {item.labels.map((l) => (
              <LabelChip key={l.name} label={l} sourceId={item.source_id} projectPath={item.project_path} />
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
