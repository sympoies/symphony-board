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
export function StatsBar({
  scoped,
  totalLabel = "items",
  edgeLabel = "edges",
}: {
  scoped: ScopedStats;
  totalLabel?: string;
  edgeLabel?: string;
}) {
  const { scope, stats } = scoped;
  return (
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
  );
}
