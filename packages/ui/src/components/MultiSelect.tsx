// A compact multi-select dropdown: a button that opens a checkbox list. Options
// are supplied (the Live tab derives them from the current buffer), so there is
// no free-text input — you pick from what is actually present. Selection is a
// Set the parent owns; closing on outside-click / Escape keeps it keyboard- and
// pointer-dismissable.
import { useEffect, useRef, useState } from "react";

export function MultiSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: string[];
  selected: ReadonlySet<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggle = (value: string) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };

  const count = selected.size;
  const available = options.length;
  const disabled = available === 0 && count === 0;

  return (
    <div className="ms" ref={rootRef}>
      <button
        type="button"
        className={`ms-button${count ? " ms-button-on" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={count ? `${label}: ${count} selected` : `${label}: ${available} available`}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        {count ? (
          <span className="ms-count">{count}</span>
        ) : available ? (
          // Nothing selected: show how many options are available (muted), so the
          // control reads "N to filter by" — distinct from the accent selected-count.
          <span className="ms-count ms-count-avail">{available}</span>
        ) : null}
        <span className="ms-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open ? (
        <div className="ms-menu" role="listbox" aria-multiselectable="true">
          {count ? (
            <button type="button" className="ms-clear" onClick={() => onChange(new Set())}>
              Clear {label.toLowerCase()}
            </button>
          ) : null}
          {options.map((opt) => {
            const on = selected.has(opt);
            return (
              <label key={opt} className={`ms-option${on ? " ms-option-on" : ""}`}>
                <input type="checkbox" checked={on} onChange={() => toggle(opt)} />
                <span className="ms-option-label">{opt}</span>
              </label>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
