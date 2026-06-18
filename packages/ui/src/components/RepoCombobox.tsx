import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { pluralize, type CommitRepoOption } from "../model.ts";

// A repository glyph for the repo filter, mirroring the branch icon on the
// adjacent branch picker so the two SCM filters read as a matched pair.
function RepoFilterIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M3 2.4h7.5a1.5 1.5 0 0 1 1.5 1.5v9.7H4.5A1.5 1.5 0 0 1 3 12.1Z" />
      <path d="M4.5 13.6H12" />
      <path d="M3 2.4v9.7" />
    </svg>
  );
}

// A small, dependency-free typeahead combobox for the Commits repo filter.
//
// It replaces a native <datalist>, whose popup the browser renders with its own
// OS chrome that CSS cannot reach — so it could never match the app theme. Here
// the suggestion list is our own DOM, fully styled with the app's tokens. The
// filter set is closed and known (the repos that have commits in the window), so
// selection is suggest-and-pick: typing filters by substring, and committing a
// value pins the feed to exactly that repo (the parent matches it exactly).
export function RepoCombobox({
  options,
  selectedSource,
  value,
  onChange,
  sourceKind,
}: {
  options: CommitRepoOption[];
  selectedSource: string | null;
  value: string | null;
  onChange: (repo: CommitRepoOption | null) => void;
  sourceKind: ReadonlyMap<string, string>;
}) {
  const [query, setQuery] = useState(value ?? "");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // The applied value is the source of truth; mirror it into the input text when
  // it changes from outside (URL navigation, clear) and the list is closed, so we
  // never clobber what the user is actively typing.
  useEffect(() => {
    if (!open) setQuery(value ?? "");
  }, [value, open]);

  const q = query.trim().toLowerCase();
  const selectedKey = value ? `${selectedSource ?? ""}|${value}` : null;
  // When the query still equals the applied value, show every option (so opening
  // a pinned combobox lists all repos, not just the current one); otherwise filter
  // by substring on the repo path.
  const filtered = useMemo(() => {
    if (!q || q === (value ?? "").toLowerCase()) return options;
    return options.filter((o) => o.project_path.toLowerCase().includes(q));
  }, [options, q, value]);

  const activeIndex = filtered.length === 0 ? -1 : Math.min(highlight, filtered.length - 1);

  const commit = (repo: CommitRepoOption | null) => {
    onChange(repo);
    setQuery(repo?.project_path ?? "");
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      const chosen = activeIndex >= 0 ? filtered[activeIndex] : undefined;
      if (open && chosen) {
        e.preventDefault();
        commit(chosen);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    }
  };

  return (
    <div className="repo-combobox" ref={rootRef}>
      <div className="repo-combobox-field">
        <RepoFilterIcon />
        <input
          className="search"
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls="repo-combobox-list"
          aria-autocomplete="list"
          aria-label="Filter commits by repo"
          // "All repos" is the empty/default scope, styled like a value to mirror
          // the branch picker's "All branches" default; typing still filters.
          placeholder="All repos"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setHighlight(0);
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          // Mouse-down on an option commits before this blur fires (it prevents
          // default), so blur only closes a genuine focus-out (outside click, tab).
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        {value ? (
          <button type="button" className="repo-combobox-clear" aria-label="Clear repo filter" onMouseDown={(e) => { e.preventDefault(); commit(null); }}>
            ×
          </button>
        ) : (
          <span className="repo-combobox-caret" aria-hidden="true">
            ▾
          </span>
        )}
      </div>
      {open && filtered.length > 0 ? (
        <ul className="repo-combobox-list" id="repo-combobox-list" role="listbox">
          {filtered.map((o, i) => (
            <li
              key={`${o.source_id}|${o.project_path}`}
              role="option"
              aria-selected={`${o.source_id}|${o.project_path}` === selectedKey}
              className={`repo-combobox-option${i === activeIndex ? " is-active" : ""}${`${o.source_id}|${o.project_path}` === selectedKey ? " is-selected" : ""}`}
              // Mouse-down (not click) so the commit lands before the input's blur,
              // and preventDefault keeps focus on the input so blur never fires here.
              onMouseDown={(e) => {
                e.preventDefault();
                commit(o);
              }}
              onMouseEnter={() => setHighlight(i)}
            >
              <span className="repo-combobox-name">{o.project_path}</span>
              <span className="repo-combobox-meta">
                {o.count} {pluralize(o.count, "commit")} · {sourceKind.get(o.source_id) ?? o.source_id}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
