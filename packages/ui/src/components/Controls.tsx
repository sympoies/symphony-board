import { useEffect, useRef, type ChangeEvent, type KeyboardEvent } from "react";

// A single facet group the Controls bar renders. `mode` decides which values
// show: "facet" lists every value (the usual multi-select chips, hidden when
// there is nothing to choose between); "pinned" shows ONLY the active values as
// removable chips — used for a drill-down pin (e.g. a repo) where listing the
// whole universe of values would be a wall, but the applied filter must still be
// visible and clearable; "toggle" shows every value even when there is only one
// (a deliberate boolean switch, e.g. "unresolved only"), hidden only when empty.
// The caller builds the groups, so the SAME presentational bar serves the
// route-backed Activity feed and the state-backed board/graph.
export interface ControlGroup {
  dim: string;
  label: string;
  values: string[];
  active: ReadonlySet<string>;
  displayValue?: (v: string) => string;
  mode?: "facet" | "pinned" | "toggle";
}

interface Props {
  search: string;
  groups: ControlGroup[];
  mobilePanel?: "search" | "filters" | "range" | null;
  onSearch: (q: string) => void;
  onToggle: (dim: string, value: string) => void;
  onClearFilters?: () => void;
  onLoadFile: (file: File) => void;
  onMobilePanel?: (panel: "search" | "filters" | "range" | null) => void;
}

function ToggleGroup({ group, onToggle }: { group: ControlGroup; onToggle: (value: string) => void }) {
  const { label, values, active, displayValue, mode = "facet" } = group;
  // facet: union the active values into the visible set so an active value with
  // no rows in the current range (e.g. a drill-down to a source/kind/action that
  // the selected window has none of) still renders as a removable chip — without
  // this it applies invisibly and can only be cleared by editing the URL.
  const shown = mode === "pinned"
    ? values.filter((v) => active.has(v))
    : mode === "facet"
      ? [...new Set([...values, ...active])]
      : values;
  // facet: nothing to choose between when <= 1 value AND nothing active to clear.
  // pinned/toggle: hide only when empty — pinned has no active drill-down to
  // surface; toggle has no applicable rows (e.g. no review activity in the window).
  const hide = mode === "facet" ? (shown.length <= 1 && active.size === 0) : shown.length === 0;
  if (hide) return null;
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

export function Controls({ search, groups, mobilePanel = null, onSearch, onToggle, onClearFilters, onLoadFile, onMobilePanel }: Props) {
  const mobileSearchRef = useRef<HTMLInputElement | null>(null);
  const filtersOpen = mobilePanel === "filters";
  const searchOpen = mobilePanel === "search";
  const activeFilterCount = groups.reduce((count, group) => count + group.active.size, 0);
  const clearable = search.trim() !== "" || activeFilterCount > 0;
  // Collapsed-state summary for the narrow disclosure: "all" when nothing narrows
  // the view, else the active facet count. Mirrors the range / commits filter
  // disclosures so every page's filter chrome reads the same on a phone.
  const filtersSummary = activeFilterCount === 0 ? "all" : `${activeFilterCount} active`;
  const searchSummary = search.trim() === "" ? "search" : "search active";
  useEffect(() => {
    if (searchOpen) mobileSearchRef.current?.focus();
  }, [searchOpen]);
  const setMobilePanel = (panel: "search" | "filters" | "range" | null) => {
    onMobilePanel?.(panel);
  };
  const clearFilters = () => {
    onClearFilters?.();
    setMobilePanel(null);
  };
  const closeOnEscape = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") setMobilePanel(null);
  };
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onLoadFile(file);
  };
  return (
    <div className="controls" data-search-open={searchOpen}>
      <button
        type="button"
        className="filter-summary-disclosure search-disclosure"
        aria-expanded={searchOpen}
        aria-controls="mobile-search-panel"
        aria-label={`${searchOpen ? "Hide" : "Show"} search`}
        onClick={() => setMobilePanel(searchOpen ? null : "search")}
      >
        <span className="filter-summary-disclosure-summary">{searchSummary}</span>
      </button>
      <input
        id="global-search"
        className="search"
        type="search"
        placeholder="Search title / author / repo / label…"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />
      <button
        type="button"
        className="filter-summary-disclosure filter-disclosure"
        aria-expanded={filtersOpen}
        aria-controls="mobile-filter-panel"
        aria-label={`${filtersOpen ? "Hide" : "Show"} filters${activeFilterCount > 0 ? `, ${activeFilterCount} active` : ""}`}
        onClick={() => setMobilePanel(filtersOpen ? null : "filters")}
      >
        <span className="filter-summary-disclosure-label">filters</span>
        <span className="filter-summary-disclosure-summary">{filtersSummary}</span>
        <span className="filter-summary-disclosure-caret" aria-hidden="true" />
      </button>
      <div id="facet-filter-groups" className="filter-groups" data-open={filtersOpen}>
        {groups.map((group) => (
          <ToggleGroup key={group.dim} group={group} onToggle={(value) => onToggle(group.dim, value)} />
        ))}
      </div>
      {clearable && onClearFilters ? (
        <button
          type="button"
          className="toggle controls-clear"
          title="Clear search and filters; keeps range"
          aria-label="Clear search and filters; keeps range"
          onClick={clearFilters}
        >
          Clear filters
        </button>
      ) : null}
      {searchOpen || filtersOpen ? (
        <>
          <button type="button" className="mobile-control-backdrop" aria-label="Close controls" onClick={() => setMobilePanel(null)} />
          <div
            id={searchOpen ? "mobile-search-panel" : "mobile-filter-panel"}
            className="mobile-control-sheet"
            data-panel={searchOpen ? "search" : "filters"}
            role="dialog"
            aria-modal="false"
            aria-labelledby={searchOpen ? "mobile-search-title" : "mobile-filter-title"}
            onKeyDown={closeOnEscape}
          >
            <div className="mobile-control-sheet-head">
              <strong id={searchOpen ? "mobile-search-title" : "mobile-filter-title"} className="mobile-control-sheet-title">
                {searchOpen ? "Search" : "Filters"}
              </strong>
              {clearable && onClearFilters ? (
                <button type="button" className="mobile-control-sheet-clear" onClick={clearFilters}>
                  Clear
                </button>
              ) : null}
              <button type="button" className="mobile-control-sheet-close" aria-label="Close controls" onClick={() => setMobilePanel(null)}>
                ×
              </button>
            </div>
            {searchOpen ? (
              <input
                ref={mobileSearchRef}
                id="global-search-mobile"
                className="search mobile-control-search"
                type="search"
                placeholder="Search title / author / repo / label…"
                value={search}
                onChange={(e) => onSearch(e.target.value)}
              />
            ) : (
              <div className="filter-groups mobile-filter-groups">
                {groups.map((group) => (
                  <ToggleGroup key={group.dim} group={group} onToggle={(value) => onToggle(group.dim, value)} />
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}
      <details className="file-load">
        <summary className="toggle file-load-summary">Local file</summary>
        <label className="file-load-picker">
          contract.json
          <input type="file" accept="application/json,.json" onChange={onFile} />
        </label>
      </details>
    </div>
  );
}
