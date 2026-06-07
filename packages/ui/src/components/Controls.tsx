import type { ChangeEvent } from "react";
import type { Filters, GroupBy, View } from "../model.ts";

export interface Facets {
  sources: string[];
  states: string[];
  kinds: string[];
}

interface Props {
  filters: Filters;
  facets: Facets;
  groupBy: GroupBy;
  view: View;
  onSearch: (q: string) => void;
  onToggle: (dim: "sources" | "states" | "kinds", value: string) => void;
  onGroupBy: (g: GroupBy) => void;
  onView: (v: View) => void;
  onLoadFile: (file: File) => void;
}

function ToggleGroup({
  label,
  values,
  active,
  onToggle,
}: {
  label: string;
  values: string[];
  active: ReadonlySet<string>;
  onToggle: (v: string) => void;
}) {
  if (values.length <= 1) return null; // nothing to filter on
  return (
    <div className="toggle-group">
      <span className="toggle-label">{label}</span>
      {values.map((v) => (
        <button
          key={v}
          type="button"
          className={`toggle${active.has(v) ? " toggle-on" : ""}`}
          onClick={() => onToggle(v)}
        >
          {v}
        </button>
      ))}
    </div>
  );
}

const GROUP_OPTIONS: GroupBy[] = ["source", "repo", "state", "kind", "none"];

export function Controls({ filters, facets, groupBy, view, onSearch, onToggle, onGroupBy, onView, onLoadFile }: Props) {
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onLoadFile(file);
  };
  return (
    <div className="controls">
      <div className="view-toggle">
        <button type="button" className={`toggle${view === "board" ? " toggle-on" : ""}`} onClick={() => onView("board")}>
          Board
        </button>
        <button type="button" className={`toggle${view === "list" ? " toggle-on" : ""}`} onClick={() => onView("list")}>
          List
        </button>
      </div>
      <input
        className="search"
        type="search"
        placeholder="Search title / author / repo / label…"
        value={filters.search}
        onChange={(e) => onSearch(e.target.value)}
      />
      <ToggleGroup label="source" values={facets.sources} active={filters.sources} onToggle={(v) => onToggle("sources", v)} />
      <ToggleGroup label="state" values={facets.states} active={filters.states} onToggle={(v) => onToggle("states", v)} />
      <ToggleGroup label="kind" values={facets.kinds} active={filters.kinds} onToggle={(v) => onToggle("kinds", v)} />
      {view === "list" && (
        <label className="groupby">
          group by{" "}
          <select value={groupBy} onChange={(e) => onGroupBy(e.target.value as GroupBy)}>
            {GROUP_OPTIONS.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="file-load">
        load contract.json
        <input type="file" accept="application/json,.json" onChange={onFile} />
      </label>
    </div>
  );
}
