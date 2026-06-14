import type { ReactNode } from "react";

// A labeled value tile — an uppercase muted label over a single accented value.
// Shared by the Repo Analytics totals grid and the Diagnostics DB-stats grid;
// the value is `children` so callers can pass a raw number, a formatted string,
// or richer markup. The parent grid owns layout; the tile owns its own chrome.
export function StatTile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="stat-tile">
      <span className="stat-label">{label}</span>
      <b>{children}</b>
    </div>
  );
}
