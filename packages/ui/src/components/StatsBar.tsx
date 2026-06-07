import type { Stats } from "../model.ts";

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

// Small at-a-glance counts: items by state/kind and edges by lifecycle. Reflects
// the CURRENT filter (App passes filtered items/edges).
export function StatsBar({ stats }: { stats: Stats }) {
  return (
    <div className="stats">
      <div className="stat">
        <span className="stat-label">items</span>
        <span className="stat-pill">
          total <b>{stats.items}</b>
        </span>
      </div>
      <Pills label="state" counts={stats.byState} />
      <Pills label="kind" counts={stats.byKind} />
      <Pills label="edges" counts={stats.byLifecycle} />
    </div>
  );
}
