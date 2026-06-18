import { useState, type ReactNode } from "react";
import { VIEW_SCOPE_LABEL, type ScopedStats } from "../model.ts";

function Pills({ label, counts }: { label: string; counts: Record<string, number> }) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      {entries.map(([k, n]) => (
        <span key={k} className="stat-pill">
          {k} <b>{n}</b>
        </span>
      ))}
    </div>
  );
}

// Small at-a-glance counts: items/nodes by state/kind and edges/links by
// lifecycle. The scope label makes the page/window boundary explicit.
//
// This summary is read-only context, not the page's data — so on narrow/portrait
// it collapses behind a "stats · <headline>" disclosure (same chrome as the
// filters/range) and the actual board/graph shows first. `footer` rides inside
// the collapsible region (the Graph page passes its legend + hint there). Desktop
// always shows the full bar inline.
export function StatsBar({
  scoped,
  totalLabel = "items",
  edgeLabel = "edges",
  footer,
}: {
  scoped: ScopedStats;
  totalLabel?: string;
  edgeLabel?: string;
  footer?: ReactNode;
}) {
  const { scope, stats } = scoped;
  const [open, setOpen] = useState(false);
  const edgeTotal = Object.values(stats.byLifecycle).reduce((sum, n) => sum + n, 0);
  const headline = edgeTotal > 0 ? `${stats.items} ${totalLabel} · ${edgeTotal} ${edgeLabel}` : `${stats.items} ${totalLabel}`;
  return (
    <div className="stats-block">
      <button
        type="button"
        className="filter-summary-disclosure stats-disclosure"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="filter-summary-disclosure-label">stats</span>
        <span className="filter-summary-disclosure-summary">{headline}</span>
        <span className="filter-summary-disclosure-caret" aria-hidden="true" />
      </button>
      <div className="stats-body" data-stats-collapsed={open ? undefined : "true"}>
        <div className="stats">
          <div className="stat">
            <span className="stat-label">scope</span>
            <span className="stat-pill">{VIEW_SCOPE_LABEL[scope]}</span>
          </div>
          <div className="stat">
            <span className="stat-label">{totalLabel}</span>
            <span className="stat-pill">
              total <b>{stats.items}</b>
            </span>
          </div>
          <Pills label="state" counts={stats.byState} />
          <Pills label="kind" counts={stats.byKind} />
          <Pills label={edgeLabel} counts={stats.byLifecycle} />
        </div>
        {footer}
      </div>
    </div>
  );
}
