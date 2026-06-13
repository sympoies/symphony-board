import type { ChangeEvent } from "react";

// A single facet group the Controls bar renders. `mode` decides which values
// show: "facet" lists every value (the usual multi-select chips, hidden when
// there is nothing to choose between); "pinned" shows ONLY the active values as
// removable chips — used for a drill-down pin (e.g. a repo) where listing the
// whole universe of values would be a wall, but the applied filter must still be
// visible and clearable. The caller builds the groups, so the SAME presentational
// bar serves the route-backed Activity feed and the state-backed board/graph.
export interface ControlGroup {
  dim: string;
  label: string;
  values: string[];
  active: ReadonlySet<string>;
  displayValue?: (v: string) => string;
  mode?: "facet" | "pinned";
}

interface Props {
  search: string;
  groups: ControlGroup[];
  onSearch: (q: string) => void;
  onToggle: (dim: string, value: string) => void;
  onLoadFile: (file: File) => void;
}

function ToggleGroup({ group, onToggle }: { group: ControlGroup; onToggle: (value: string) => void }) {
  const { label, values, active, displayValue, mode = "facet" } = group;
  const shown = mode === "pinned" ? values.filter((v) => active.has(v)) : values;
  // facet: nothing to choose between when <= 1 value. pinned: hide when no
  // active pin (the chip only exists to surface and clear an applied drill-down).
  if (mode === "pinned" ? shown.length === 0 : shown.length <= 1) return null;
  return (
    <div className="toggle-group">
      <span className="toggle-label">{label}</span>
      {shown.map((v) => (
        <button
          key={v}
          type="button"
          className={`toggle${active.has(v) ? " toggle-on" : ""}`}
          onClick={() => onToggle(v)}
          title={mode === "pinned" ? `Clear ${label} filter` : v}
        >
          {displayValue ? displayValue(v) : v}
        </button>
      ))}
    </div>
  );
}

export function Controls({ search, groups, onSearch, onToggle, onLoadFile }: Props) {
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onLoadFile(file);
  };
  return (
    <div className="controls">
      <input
        className="search"
        type="search"
        placeholder="Search title / author / repo / label…"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />
      {groups.map((group) => (
        <ToggleGroup key={group.dim} group={group} onToggle={(value) => onToggle(group.dim, value)} />
      ))}
      <label className="file-load">
        load contract.json
        <input type="file" accept="application/json,.json" onChange={onFile} />
      </label>
    </div>
  );
}
